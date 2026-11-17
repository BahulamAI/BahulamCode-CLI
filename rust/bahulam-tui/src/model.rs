use crate::protocol::{EventEnvelope, EVENT_TYPES};
use serde_json::Value;
use std::{collections::HashMap, time::Instant};

#[derive(Debug, Clone, Hash)]
pub struct Card {
    pub agent: String,
    pub title: String,
    pub primary: String,
    pub metadata: String,
    pub body: String,
    pub status: String,
    pub payload_ref: Option<String>,
    pub open_url: Option<String>,
    pub detail: Option<String>,
    pub detail_loading: bool,
    pub started_at: Option<Instant>,
    pub tool_id: String,
    pub tool_name: String,
}
impl Card {
    pub fn is_message(&self) -> bool {
        self.title == "Assistant"
            || self.title == "Prompt"
            || self.title == "Agent report"
            || self.title.starts_with("Agent: ")
    }
}
#[derive(Debug, Clone)]
pub struct Agent {
    pub id: String,
    pub parent: Option<String>,
    pub label: String,
    pub status: String,
    pub current_tool: String,
    pub elapsed_ms: Option<f64>,
    pub tokens: String,
    pub started_at: Option<Instant>,
}
#[derive(Debug, Clone)]
pub struct Approval {
    pub scopes: Vec<String>,
    pub risk: String,
    pub id: String,
    pub tool: String,
    pub command: String,
    pub cwd: String,
    pub reason: String,
    pub payload_ref: Option<String>,
}
#[derive(Debug, Default)]
pub struct Model {
    pub transcript_revision: u64,
    pub session: String,
    pub cwd: String,
    pub git_branch: String,
    pub permission_mode: String,
    pub custom_status: String,
    pub model: String,
    pub last_seq: i64,
    pub cards: Vec<Card>,
    pub agents: Vec<Agent>,
    pub plan: Vec<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost: f64,
    pub context_used_pct: f64,
    pub usage_known: bool,
    pub cost_known: bool,
    pub context_known: bool,
    pub context_estimated: bool,
    pub cost_estimated: bool,
    pub active_background_jobs: usize,
    pub status: String,
    pub composer_hint: String,
    pub warnings: Vec<String>,
    pub approval: Option<Approval>,
    pub command_catalog: Vec<(String, String)>,
    pub slash_menu: crate::composer::SlashMenu,
    pub interaction: Option<Interaction>,
    tools: HashMap<String, usize>,
    messages: HashMap<String, usize>,
    // Card indices only: keep streamed segments in arrival order without copying text.
    message_segments: HashMap<String, Vec<usize>>,
    progress: HashMap<String, usize>,
    approvals: HashMap<String, usize>,
    replaying_history: bool,
}
#[derive(Debug, Clone)]
pub struct InteractionOption {
    pub label: String,
    pub value: String,
}
#[derive(Debug, Clone)]
pub struct Interaction {
    pub request_id: String,
    pub title: String,
    pub message: String,
    pub options: Vec<InteractionOption>,
    pub selected: usize,
    pub allow_free_text: bool,
    pub editing: bool,
    pub free_text: String,
}

fn text(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(Value::as_str)
        .map(safe_text)
        .unwrap_or_default()
}

// Match the Node event tap's truth-value check: an optional error:null or
// error:false field is not a failure just because the key was serialized.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn tool_succeeded(data: &Value) -> bool {
    let exit_ok = match data.get("exit_code") {
        None | Some(Value::Null) => true,
        Some(Value::Number(n)) => n.as_f64() == Some(0.0),
        Some(Value::String(s)) => s.trim().is_empty() || s.trim().parse::<f64>() == Ok(0.0),
        Some(Value::Bool(value)) => !value,
        _ => false,
    };
    !data.get("error").is_some_and(truthy)
        && !data.get("is_error").is_some_and(truthy)
        && data.get("ok").and_then(Value::as_bool) != Some(false)
        && data.get("success").and_then(Value::as_bool) != Some(false)
        && exit_ok
}

fn display_message_content(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return safe_text(text);
    }
    if let Some(parts) = value.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .map(safe_text)
                    .or_else(|| part.get("text").and_then(Value::as_str).map(safe_text))
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    safe_text(&value.to_string())
}

pub fn known_event(kind: &str) -> bool {
    EVENT_TYPES.contains(&kind)
        || [
            "tool_call",
            "tool_result",
            "agent_complete",
            "tokens_used",
            "sub_agent_start",
            "sub_agent_complete",
        ]
        .contains(&kind)
}

/// Logs are untrusted display data. Strip terminal controls, including OSC/DCS/CSI.
/// Phase 0 has no SGR rendering; preserving styled output is a later renderer task.
pub fn safe_text(input: &str) -> String {
    enum State {
        Text,
        Escape,
        Csi,
        String,
        StringEscape,
    }
    let mut state = State::Text;
    let mut out = String::new();
    for ch in input.chars() {
        state = match state {
            State::Text => match ch {
                '\u{1b}' => State::Escape,
                '\u{9b}' => State::Csi,
                '\u{9d}' | '\u{90}' | '\u{98}' | '\u{9e}' | '\u{9f}' => State::String,
                '\n' | '\t' => {
                    out.push(ch);
                    State::Text
                }
                c if c.is_control() => State::Text,
                _ => {
                    out.push(ch);
                    State::Text
                }
            },
            State::Escape => match ch {
                '[' => State::Csi,
                ']' | 'P' | 'X' | '^' | '_' => State::String,
                _ => State::Text,
            },
            State::Csi => {
                if ('\u{40}'..='\u{7e}').contains(&ch) {
                    State::Text
                } else {
                    State::Csi
                }
            }
            State::String => match ch {
                '\u{7}' | '\u{9c}' => State::Text,
                '\u{1b}' => State::StringEscape,
                _ => State::String,
            },
            State::StringEscape => {
                if ch == '\\' {
                    State::Text
                } else {
                    State::String
                }
            }
        };
    }
    out
}

impl Model {
    fn message_title(&self, agent: &str) -> String {
        if agent == "main" {
            return "Assistant".into();
        }
        let label = self
            .agents
            .iter()
            .find(|row| row.id == agent)
            .map(|row| row.label.as_str())
            .unwrap_or(agent);
        let name = label
            .split_once(':')
            .map(|(name, _)| name)
            .unwrap_or(label)
            .trim();
        format!("Agent: {}", if name.is_empty() { agent } else { name })
    }

    fn apply_usage(&mut self, data: &Value) {
        if let Some(value) = data
            .get("input_tokens")
            .or_else(|| data.get("prompt"))
            .and_then(Value::as_u64)
        {
            self.input_tokens = value;
            self.usage_known = true;
        }
        if let Some(value) = data
            .get("output_tokens")
            .or_else(|| data.get("completion"))
            .and_then(Value::as_u64)
        {
            self.output_tokens = value;
            self.usage_known = true;
        }
        if let Some(value) = data.get("cost_usd").and_then(Value::as_f64) {
            self.cost = value;
            self.cost_known = true;
        }
        if let Some(value) = data.get("context_used_pct").and_then(Value::as_f64) {
            self.context_used_pct = value;
            self.context_known = true;
        }
        self.context_estimated = data
            .get("context_estimated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.cost_estimated = data
            .get("cost_estimated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }

    pub fn request_details(&mut self, index: usize) -> Option<String> {
        let card = self.cards.get_mut(index)?;
        if card.detail.is_some() {
            return None;
        }
        let reference = card.payload_ref.clone()?;
        if card.detail_loading {
            return None;
        }
        card.detail_loading = true;
        Some(reference)
    }

    pub fn detail_line_count(&self, index: usize) -> usize {
        self.cards
            .get(index)
            .and_then(|card| card.detail.as_deref().or(Some(card.body.as_str())))
            .map(str::lines)
            .map(Iterator::count)
            .unwrap_or(0)
    }

    fn card(&mut self, agent: &str, title: &str, body: String, status: &str) -> usize {
        let index = self.cards.len();
        self.cards.push(Card {
            agent: agent.into(),
            title: title.into(),
            primary: String::new(),
            metadata: String::new(),
            body,
            status: status.into(),
            payload_ref: None,
            detail: None,
            detail_loading: false,
            open_url: None,
            started_at: None,
            tool_id: String::new(),
            tool_name: String::new(),
        });
        index
    }

    fn finish_message_segment(&mut self, key: &str) {
        if let Some(index) = self.messages.remove(key) {
            self.cards[index].status = "done".into();
        }
    }

    // Some hosts send a turn-wide aggregate in content/message_end after
    // streaming commentary and tool calls. Only its unseen suffix belongs at
    // the new position; never overwrite the earlier commentary with the final.
    fn message_suffix<'a>(&self, indices: &[usize], before: usize, text: &'a str) -> &'a str {
        let mut remaining = text;
        for &index in indices.iter().take_while(|&&i| i < before) {
            match remaining.strip_prefix(self.cards[index].body.as_str()) {
                Some(suffix) => remaining = suffix,
                None => return text, // A standalone message, not a cumulative result.
            }
        }
        remaining
    }

    pub fn apply(&mut self, event: &EventEnvelope) -> Result<(), String> {
        if self.replaying_history
            && matches!(
                event.r#type.as_str(),
                "transcript_snapshot"
                    | "interaction_requested"
                    | "command_catalog"
                    | "session_state"
                    | "detail_loaded"
            )
        {
            return Ok(());
        }
        if event.r#type == "transcript_snapshot" {
            let live_seq = self.last_seq;
            self.last_seq = 0;
            let replace = event.data.get("replace").and_then(Value::as_bool) != Some(false);
            if replace {
                self.usage_known = false;
                self.cost_known = false;
                self.context_known = false;
                self.cards.clear();
                self.agents.clear();
                self.plan.clear();
                self.tools.clear();
                self.messages.clear();
                self.message_segments.clear();
                self.progress.clear();
                self.approvals.clear();
                if self.session != event.session_id {
                    self.approval = None;
                    self.interaction = None;
                }
                self.last_seq = 0;
                self.transcript_revision = self.transcript_revision.wrapping_add(1);
            }
            self.session = event.session_id.clone();
            self.cwd = text(&event.data, "cwd");
            self.model = text(&event.data, "model");
            self.status = format!("Resumed · {}", text(&event.data, "mode"));
            if replace || self.cards.is_empty() {
                self.card(
                    "main",
                    "Session",
                    format!("Transcript loaded · mode: {}", text(&event.data, "mode")),
                    "ready",
                );
            }
            if let Some(items) = event.data.get("items").and_then(Value::as_array) {
                let mut seq = 0i64;
                for item in items {
                    if item.get("kind").and_then(Value::as_str) == Some("event") {
                        if let Some(historical) = item.get("event").cloned() {
                            let raw_kind =
                                historical.get("type").and_then(Value::as_str).unwrap_or("");
                            let kind = match raw_kind {
                                "content_partial" => "text_delta",
                                "content" => "message_end",
                                "tool_request" | "tool_call" => "tool_requested",
                                "tool_done" | "tool_result" => "tool_finished",
                                "thinking" => "thinking_delta",
                                "sub_agent_start" | "worker_start" => "agent_spawned",
                                "sub_agent_complete" | "worker_done" => "agent_finished",
                                "plan" | "plan_created" => "plan_updated",
                                "complete" => "turn_ended",
                                other => other,
                            };
                            seq += 1;
                            let mut data = historical
                                .get("data")
                                .cloned()
                                .unwrap_or(Value::Object(Default::default()));
                            if let Some(object) = data.as_object_mut() {
                                for (target, sources) in [
                                    ("tool_id", &["call_id", "tool_call_id", "id"][..]),
                                    ("name", &["tool"][..]),
                                    ("args", &["tool_input", "input"][..]),
                                    ("chunk", &["text", "message"][..]),
                                    ("text", &["content"][..]),
                                    ("summary", &["output", "result"][..]),
                                ] {
                                    if !object.contains_key(target) {
                                        if let Some(value) =
                                            sources.iter().find_map(|key| object.get(*key).cloned())
                                        {
                                            object.insert(target.to_owned(), value);
                                        }
                                    }
                                }
                                if !object.contains_key("ok")
                                    && (object.get("error").is_some_and(truthy)
                                        || object.get("is_error").and_then(Value::as_bool)
                                            == Some(true)
                                        || object.get("success").and_then(Value::as_bool)
                                            == Some(false))
                                {
                                    object.insert("ok".into(), Value::Bool(false));
                                }
                                if kind == "message_end"
                                    && object.get("text").is_some_and(Value::is_array)
                                {
                                    let content = object
                                        .get("text")
                                        .map(display_message_content)
                                        .unwrap_or_default();
                                    object.insert("text".into(), Value::String(content));
                                }
                            }
                            let agent = historical
                                .get("agent_id")
                                .or_else(|| data.get("subagent_id"))
                                .or_else(|| data.get("sub_agent_run_id"))
                                .or_else(|| data.get("run_id"))
                                .or_else(|| data.get("worker"))
                                .and_then(Value::as_str)
                                .unwrap_or("main")
                                .to_owned();
                            let turn = historical
                                .get("turn_id")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .unwrap_or_else(|| "resume-history".into());
                            let envelope = EventEnvelope {
                                v: 2,
                                seq,
                                ts: historical
                                    .get("ts")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_owned(),
                                r#type: kind.to_owned(),
                                session_id: event.session_id.clone(),
                                turn_id: Some(turn),
                                agent_id: Some(agent),
                                parent_agent_id: None,
                                id: Some(format!("{}:resume:{seq}", event.session_id)),
                                data,
                                payload_ref: historical
                                    .get("payload_ref")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
                            };
                            self.replaying_history = true;
                            let applied = self.apply(&envelope);
                            self.replaying_history = false;
                            applied?;
                        }
                    } else {
                        if item.get("kind").and_then(Value::as_str) == Some("notice") {
                            let title = text(item, "title");
                            let content = item
                                .get("content")
                                .map(display_message_content)
                                .unwrap_or_default();
                            let index = self.card("main", &title, content, "info");
                            self.cards[index].detail = Some(self.cards[index].body.clone());
                            continue;
                        }
                        let role = text(item, "role");
                        let content = item
                            .get("content")
                            .map(display_message_content)
                            .unwrap_or_default();
                        if content.trim().is_empty() {
                            continue;
                        }
                        let title = match role.as_str() {
                            "user" => "Prompt",
                            "assistant" => "Assistant",
                            other => other,
                        };
                        let index = self.card("main", title, content, "done");
                        self.cards[index].detail = Some(self.cards[index].body.clone());
                    }
                }
            }
            self.cwd = text(&event.data, "cwd");
            self.model = text(&event.data, "model");
            self.last_seq = if replace { 0 } else { live_seq };
            return Ok(());
        }
        if event.r#type == "command_catalog" {
            self.command_catalog = event
                .data
                .get("commands")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    Some((
                        row.get("name")?.as_str()?.to_owned(),
                        row.get("description")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    ))
                })
                .collect();
            return Ok(());
        }
        if event.r#type == "session_state" {
            self.git_branch = text(&event.data, "git_branch");
            self.permission_mode = text(&event.data, "permission_mode");
            self.active_background_jobs = event
                .data
                .get("active_background_jobs")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            if let Some(usage) = event.data.get("usage") {
                self.apply_usage(usage);
            }
            self.cwd = text(&event.data, "cwd");
            self.model = text(&event.data, "model");
            if !text(&event.data, "status").is_empty() {
                self.status = text(&event.data, "status");
            }
            return Ok(());
        }
        if event.r#type == "interaction_requested" {
            if event.data.get("cancelled").and_then(Value::as_bool) == Some(true) {
                if self
                    .interaction
                    .as_ref()
                    .is_some_and(|menu| menu.request_id == text(&event.data, "request_id"))
                {
                    self.interaction = None;
                }
                return Ok(());
            }
            let mut options: Vec<InteractionOption> = event
                .data
                .get("options")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    Some(InteractionOption {
                        label: safe_text(row.get("label")?.as_str()?),
                        value: row.get("value")?.as_str()?.to_owned(),
                    })
                })
                .collect();
            let allow_free_text =
                event.data.get("allow_free_text").and_then(Value::as_bool) == Some(true);
            if allow_free_text {
                options.push(InteractionOption {
                    label: "Other — type your own answer".into(),
                    value: String::new(),
                });
            }
            self.interaction = Some(Interaction {
                allow_free_text,
                editing: false,
                free_text: String::new(),
                request_id: text(&event.data, "request_id"),
                title: text(&event.data, "title"),
                message: text(&event.data, "message"),
                options,
                selected: 0,
            });
            return Ok(());
        }
        if event.r#type == "detail_loaded" {
            let reference = text(&event.data, "payload_ref");
            let detail = text(&event.data, "detail");
            let indices: Vec<_> = self
                .cards
                .iter()
                .enumerate()
                .filter(|(_, card)| card.payload_ref.as_deref() == Some(reference.as_str()))
                .map(|(index, _)| index)
                .collect();
            for index in indices {
                let card = &self.cards[index];
                let detail = if event.data.get("error").is_some() {
                    format!("Could not load details: {}", text(&event.data, "error"))
                } else {
                    command_output(&card.title, &detail)
                };
                let body = if card.is_message() && event.data.get("error").is_none() {
                    self.message_segments
                        .values()
                        .find(|indices| indices.contains(&index))
                        .map(|indices| self.message_suffix(indices, index, &detail))
                        .unwrap_or(&detail)
                        .to_owned()
                } else {
                    detail.clone()
                };
                let card = &mut self.cards[index];
                if card.is_message() {
                    card.body = body;
                }
                card.detail = Some(detail);
                card.detail_loading = false;
            }
            if self
                .approval
                .as_ref()
                .is_some_and(|approval| approval.payload_ref.as_deref() == Some(reference.as_str()))
            {
                if let Some(approval) = self.approval.as_mut() {
                    approval.command = detail;
                }
            }
            return Ok(());
        }
        if self.session.is_empty() {
            self.session = event.session_id.clone();
        }
        if self.session != event.session_id {
            return Err("Replay contains more than one session".into());
        }
        if event.seq <= self.last_seq {
            return Ok(());
        }
        self.last_seq = event.seq;
        let kind = event.r#type.as_str();
        if !known_event(kind) {
            return Ok(());
        }
        let data = &event.data;
        let agent = event
            .agent_id
            .as_deref()
            .or_else(|| data.get("subagent_id").and_then(Value::as_str))
            .unwrap_or("main");
        let turn = event.turn_id.as_deref().unwrap_or("legacy");
        if !self.agents.iter().any(|a| a.id == agent) {
            self.agents.push(Agent {
                id: agent.into(),
                parent: event.parent_agent_id.clone(),
                label: safe_text(agent),
                status: "idle".into(),
                current_tool: String::new(),
                elapsed_ms: None,
                tokens: String::new(),
                started_at: None,
            });
        }
        let tool_id = text(data, "tool_id");
        let origin = if self.replaying_history {
            "history"
        } else {
            "live"
        };
        let key = format!("{origin}/{turn}/{agent}/{tool_id}");
        let message_key = format!("{origin}/{turn}/{agent}");
        match kind {
            "session_started" => {
                self.cwd = text(data, "cwd");
                self.model = text(data, "model");
                self.status = self.model.clone();
                self.card(agent, "Session", text(data, "cwd"), "ready");
            }
            "turn_started" => {
                self.status = "working".into();
                if let Some(main) = self.agents.iter_mut().find(|row| row.id == "main") {
                    main.status = "working".into();
                    main.started_at = (!self.replaying_history).then(Instant::now);
                }
                self.card(agent, "Prompt", text(data, "text"), "sent");
            }
            "thinking_delta" => {
                let progress_key = format!("{message_key}/thinking");
                let index = if let Some(index) = self.progress.get(&progress_key) {
                    *index
                } else {
                    let index = self.card(
                        agent,
                        "Thinking",
                        String::new(),
                        if self.replaying_history {
                            "done"
                        } else {
                            "streaming"
                        },
                    );
                    self.progress.insert(progress_key, index);
                    index
                };
                self.cards[index].body.push_str(&text(data, "chunk"));
                self.cards[index].payload_ref = event.payload_ref.clone();
            }
            "test_result" => {
                let status = if data.get("ok").and_then(Value::as_bool) == Some(false)
                    || data.get("failed").and_then(Value::as_u64).unwrap_or(0) > 0
                {
                    "failed"
                } else {
                    "done"
                };
                let summary = text(data, "summary");
                let summary = if summary.is_empty() {
                    format!(
                        "{} passed · {} failed",
                        data.get("passed").and_then(Value::as_u64).unwrap_or(0),
                        data.get("failed").and_then(Value::as_u64).unwrap_or(0)
                    )
                } else {
                    summary
                };
                let index = self.card(agent, "Check", summary, status);
                self.cards[index].primary = if text(data, "name").is_empty() {
                    text(data, "suite")
                } else {
                    text(data, "name")
                };
                self.cards[index].detail = if event.payload_ref.is_none() {
                    Some(pretty_json(data))
                } else {
                    None
                };
                self.cards[index].payload_ref = event.payload_ref.clone();
            }
            "text_delta" => {
                let index = if let Some(index) = self.messages.get(&message_key) {
                    *index
                } else {
                    let title = self.message_title(agent);
                    let index = self.card(agent, &title, String::new(), "streaming");
                    self.messages.insert(message_key.clone(), index);
                    self.message_segments
                        .entry(message_key.clone())
                        .or_default()
                        .push(index);
                    index
                };
                self.cards[index].body.push_str(&text(data, "chunk"));
            }
            "message_end" => {
                let final_text = text(data, "text");
                let existing = self.messages.remove(&message_key);
                let final_text = self
                    .message_suffix(
                        self.message_segments
                            .get(&message_key)
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                        existing.unwrap_or(self.cards.len()),
                        &final_text,
                    )
                    .to_owned();
                if let Some(index) = existing {
                    if !final_text.is_empty() {
                        self.cards[index].body = final_text;
                        self.cards[index].detail = Some(self.cards[index].body.clone());
                        self.cards[index].payload_ref = None;
                    } else if let Some(reference) = &event.payload_ref {
                        self.cards[index].payload_ref = Some(reference.clone());
                    }
                    self.cards[index].status = "done".into();
                } else if !final_text.is_empty() {
                    let title = self.message_title(agent);
                    let index = self.card(agent, &title, final_text, "done");
                    self.cards[index].detail = Some(self.cards[index].body.clone());
                    self.message_segments
                        .entry(message_key.clone())
                        .or_default()
                        .push(index);
                } else if let Some(reference) = &event.payload_ref {
                    let title = self.message_title(agent);
                    let index = self.card(agent, &title, String::new(), "done");
                    self.cards[index].payload_ref = Some(reference.clone());
                    self.message_segments
                        .entry(message_key.clone())
                        .or_default()
                        .push(index);
                }
            }
            "tool_requested" | "tool_call" if !self.tools.contains_key(&key) => {
                self.finish_message_segment(&message_key);
                let name = text(data, "name");
                let args_value = data.get("args").cloned().unwrap_or(Value::Null);
                let primary = text(data, "primary");
                let primary = if !primary.is_empty() {
                    primary
                } else {
                    [
                        "path",
                        "file_path",
                        "command",
                        "query",
                        "pattern",
                        "target",
                        "url",
                    ]
                    .iter()
                    .find_map(|key| args_value.get(key).and_then(Value::as_str))
                    .map(safe_text)
                    .or_else(|| {
                        (name != "write_project")
                            .then(|| data.get("args").map(|_| safe_text(&args_value.to_string())))
                            .flatten()
                    })
                    .unwrap_or_default()
                };
                let preview = text(data, "preview");
                let body = if !preview.is_empty() {
                    preview
                } else if let Some(args) = data.get("args") {
                    tool_arguments_preview(&name, args)
                } else {
                    String::new()
                };
                let index = self.card(agent, &name, body, "requested");
                self.cards[index].primary = primary;
                self.cards[index].tool_id = if self.replaying_history {
                    String::new()
                } else {
                    tool_id.clone()
                };
                self.cards[index].tool_name = name.clone();
                if let Some(arguments) = data.get("args") {
                    self.cards[index].detail = Some(tool_arguments_detail(&name, arguments));
                    self.cards[index].payload_ref = None;
                } else {
                    self.cards[index].payload_ref = event.payload_ref.clone();
                    if self.cards[index].primary.is_empty() {
                        self.cards[index].primary = "see details".into();
                    }
                }
                self.tools.insert(key, index);
            }
            "tool_started" | "tool_finished" | "tool_result" | "tool_output_delta" => {
                let index = if let Some(index) = self.tools.get(&key) {
                    *index
                } else {
                    self.finish_message_segment(&message_key);
                    let index =
                        self.card(agent, &format!("Tool {tool_id}"), String::new(), "unknown");
                    self.tools.insert(key, index);
                    index
                };
                if kind == "tool_started" {
                    self.cards[index].status = "running".into();
                    self.cards[index].started_at = (!self.replaying_history).then(Instant::now);
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        row.current_tool = self.cards[index].title.clone();
                    }
                } else if kind == "tool_output_delta" {
                    self.cards[index].body.push_str(&text(data, "chunk"));
                } else {
                    self.cards[index].status = if tool_succeeded(data) {
                        "done"
                    } else {
                        "failed"
                    }
                    .into();
                    let preview = text(data, "preview");
                    self.cards[index].body = if preview.is_empty() {
                        text(data, "summary")
                    } else {
                        preview
                    };
                    if let Some(output) = data.get("output") {
                        let detail = output
                            .as_str()
                            .map(safe_text)
                            .unwrap_or_else(|| pretty_json(output));
                        self.cards[index].detail = Some(detail);
                        self.cards[index].payload_ref = None;
                    } else if let Some(reference) = &event.payload_ref {
                        self.cards[index].payload_ref = Some(reference.clone());
                    }
                    let mut metadata = Vec::new();
                    if let Some(code) = data.get("exit_code").and_then(Value::as_i64) {
                        metadata.push(format!("exit {code}"));
                    }
                    if let Some(ms) = data.get("duration_ms").and_then(Value::as_f64) {
                        metadata.push(format!("{:.1}s", ms / 1000.0));
                    } else if let Some(started) = self.cards[index].started_at {
                        metadata.push(format!("{:.1}s", started.elapsed().as_secs_f64()));
                    }
                    self.cards[index].started_at = None;
                    if let Some(stats) = data.get("diff_stats") {
                        let added = stats.get("added").and_then(Value::as_u64).unwrap_or(0);
                        let removed = stats.get("removed").and_then(Value::as_u64).unwrap_or(0);
                        if added > 0 || removed > 0 {
                            metadata.push(format!("+{added} −{removed}"));
                        }
                    }
                    self.cards[index].metadata = metadata.join(" · ");
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        row.current_tool.clear();
                    }
                }
            }
            "agent_spawned" | "sub_agent_start" | "agent_status" | "agent_finished"
            | "sub_agent_complete" => {
                let mut final_report = None;
                let row = self.agents.iter_mut().find(|a| a.id == agent).unwrap();
                if kind == "agent_spawned" || kind == "sub_agent_start" {
                    row.label = format!("{}: {}", text(data, "type"), text(data, "task"));
                    row.status = "working".into();
                    row.started_at = (!self.replaying_history).then(Instant::now);
                } else if kind == "agent_status" {
                    row.status = text(data, "status");
                    if !matches!(row.status.as_str(), "working" | "running") {
                        row.started_at = None;
                    }
                    let current_tool_id = text(data, "current_tool_id");
                    if !current_tool_id.is_empty() {
                        row.current_tool = self
                            .tools
                            .get(&format!("{origin}/{turn}/{agent}/{current_tool_id}"))
                            .map(|index| self.cards[*index].title.clone())
                            .unwrap_or_else(|| "tool running".into());
                    }
                    row.elapsed_ms = data.get("elapsed_ms").and_then(Value::as_f64);
                    row.tokens = data.get("tokens").map(safe_text_json).unwrap_or_default();
                } else {
                    row.current_tool.clear();
                    if let Some(started) = row.started_at.take() {
                        row.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                    }
                    row.status = if data.get("ok").and_then(Value::as_bool) == Some(false) {
                        "failed"
                    } else {
                        "done"
                    }
                    .into();
                    if kind == "agent_finished" || kind == "sub_agent_complete" {
                        let report = text(data, "report");
                        if !report.is_empty() || event.payload_ref.is_some() {
                            final_report =
                                Some((report, row.status.clone(), event.payload_ref.clone()));
                        }
                    }
                }
                if let Some((report, status, reference)) = final_report {
                    let index = self.card("main", "Agent report", report, &status);
                    self.cards[index].primary = agent.into();
                    if !self.cards[index].body.is_empty() {
                        self.cards[index].detail = Some(self.cards[index].body.clone());
                    } else {
                        self.cards[index].payload_ref = reference;
                    }
                }
            }
            "plan_updated" => {
                self.plan = data
                    .get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|item| {
                        if let Some(line) = item.as_str() {
                            safe_text(line)
                        } else {
                            format!("[{}] {}", text(item, "state"), text(item, "text"))
                        }
                    })
                    .collect();
            }
            "diff" => {
                let path = text(data, "path");
                let body = data
                    .get("hunks")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|hunk| {
                        hunk.get("text")
                            .and_then(Value::as_str)
                            .or_else(|| hunk.get("content").and_then(Value::as_str))
                            .map(safe_text)
                            .unwrap_or_else(|| safe_text(&hunk.to_string()))
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let index = self.card(agent, "Diff", body, "done");
                self.cards[index].primary = path;
                if !self.cards[index].body.is_empty() {
                    self.cards[index].detail = Some(self.cards[index].body.clone());
                } else if let Some(reference) = &event.payload_ref {
                    self.cards[index].payload_ref = Some(reference.clone());
                }
            }
            "usage_update" | "tokens_used" if !self.replaying_history && agent == "main" => {
                self.apply_usage(data);
            }
            "notice" => {
                let activity = text(data, "activity");
                if !activity.is_empty() {
                    if agent == "main" {
                        self.status = activity.clone();
                    }
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        row.status = activity;
                    }
                }
                let cause = text(data, "cause");
                let next_step = text(data, "next_step");
                let body = [cause, next_step]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let progress_kind = text(data, "progress_key");
                let progress_key = format!("{message_key}/{progress_kind}");
                let index = if !progress_kind.is_empty() {
                    if let Some(index) = self.progress.get(&progress_key) {
                        let index = *index;
                        self.cards[index].title = text(data, "title");
                        self.cards[index].body = body;
                        self.cards[index].status = text(data, "level");
                        self.cards[index].detail = None;
                        self.cards[index].payload_ref = None;
                        index
                    } else {
                        let index =
                            self.card(agent, &text(data, "title"), body, &text(data, "level"));
                        self.progress.insert(progress_key, index);
                        index
                    }
                } else {
                    self.card(agent, &text(data, "title"), body, &text(data, "level"))
                };
                if event.payload_ref.is_some() && self.cards[index].body.len() <= 220 {
                    self.cards[index].payload_ref = event.payload_ref.clone();
                } else {
                    self.cards[index].detail = Some(self.cards[index].body.clone());
                }
                if let Some(retry) = data.get("retry") {
                    self.cards[index].metadata = format!("retry {}", safe_text_json(retry));
                }
            }
            "command_result" => {
                let name = text(data, "name");
                let result = data
                    .get(
                        if name.starts_with("/resume") && data.get("output").is_some() {
                            "output"
                        } else {
                            "result"
                        },
                    )
                    .and_then(Value::as_str)
                    .map(safe_text)
                    .filter(|result| !result.is_empty())
                    .unwrap_or_else(|| "(no output)".into());
                let status = if data.get("ok").and_then(Value::as_bool) == Some(false) {
                    "failed"
                } else {
                    "done"
                };
                let result = command_output(&name, &result);
                let index = self.card(agent, &format!("Command {name}"), result, status);
                if let Some(reference) = &event.payload_ref {
                    self.cards[index].payload_ref = Some(reference.clone());
                } else {
                    self.cards[index].detail = Some(
                        data.get("output")
                            .and_then(Value::as_str)
                            .map(safe_text)
                            .map(|output| command_output(&name, &output))
                            .unwrap_or_else(|| self.cards[index].body.clone()),
                    );
                }
                self.cards[index].metadata =
                    if data.get("added_to_context").and_then(Value::as_bool) == Some(true) {
                        "added to context".into()
                    } else {
                        "display only".into()
                    };
            }
            "approval_required" => {
                // Backend tool IDs are not local approval handles. Only Node's
                // policy-approved prompt adapter creates an actionable apr_id.
                if text(data, "apr_id").is_empty() {
                    return Ok(());
                }
                let name = ["name", "tool", "tool_name", "kind"]
                    .iter()
                    .map(|key| text(data, key))
                    .find(|name| !name.is_empty())
                    .unwrap_or_else(|| "tool".into());
                if !self.replaying_history {
                    self.approval = Some(Approval {
                        id: text(data, "apr_id"),
                        tool: name.clone(),
                        scopes: data
                            .get("scopes")
                            .and_then(Value::as_array)
                            .map(|values| {
                                values
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_else(|| vec!["once".into()]),
                        risk: text(data, "risk_tier"),
                        command: data.get("args").map(safe_text_json).unwrap_or_default(),
                        cwd: text(data, "cwd"),
                        reason: text(data, "reason"),
                        payload_ref: event.payload_ref.clone(),
                    });
                }
                let status = if self.replaying_history {
                    "historical"
                } else {
                    "waiting"
                };
                let index = self.card(agent, "Approval", text(data, "reason"), status);
                self.cards[index].primary = name;
                if let Some(args) = data.get("args") {
                    self.cards[index].detail = Some(format!(
                        "{}\n{}",
                        safe_text_json(args),
                        text(data, "reason")
                    ));
                }
                self.approvals
                    .insert(format!("{origin}/{}", text(data, "apr_id")), index);
                if self.replaying_history {
                    self.cards[index].metadata = "saved approval · inactive".into();
                }
                if event.payload_ref.is_some() && data.get("args").is_none() {
                    self.cards[index].payload_ref = event.payload_ref.clone();
                }
            }
            "approval_decided" => {
                if let Some(index) = self
                    .approvals
                    .get(&format!("{origin}/{}", text(data, "apr_id")))
                {
                    self.cards[*index].status = if self.replaying_history {
                        "historical"
                    } else {
                        "decided"
                    }
                    .into();
                    self.cards[*index].metadata = if self.replaying_history {
                        format!("saved approval · inactive · {}", text(data, "decision"))
                    } else {
                        text(data, "decision")
                    };
                }
                if !self.replaying_history
                    && self
                        .approval
                        .as_ref()
                        .is_some_and(|approval| approval.id == text(data, "apr_id"))
                {
                    self.approval = None;
                }
            }
            "turn_ended" | "agent_complete" => {
                self.status = if text(data, "outcome") == "cancelled" {
                    "cancelled"
                } else if data.get("ok").and_then(Value::as_bool) == Some(false) {
                    "failed"
                } else {
                    "complete"
                }
                .into();
                if let Some(main) = self.agents.iter_mut().find(|row| row.id == "main") {
                    main.status = self.status.clone();
                    if let Some(started) = main.started_at.take() {
                        main.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                    }
                    main.current_tool.clear();
                    main.current_tool.clear();
                }
                // A terminal event must not leave tools or streamed text spinning forever.
                let prefix = format!("{origin}/{turn}/{agent}/");
                for (key, index) in &self.tools {
                    if key.starts_with(&prefix)
                        && matches!(
                            self.cards[*index].status.as_str(),
                            "requested" | "running" | "unknown"
                        )
                    {
                        self.cards[*index].status = if self.status == "cancelled" {
                            "cancelled"
                        } else {
                            "incomplete"
                        }
                        .into();
                        self.cards[*index].metadata =
                            "turn ended before a tool result arrived".into();
                    }
                }
                for (key, index) in self.messages.iter().chain(self.progress.iter()) {
                    if (key == &message_key || key.starts_with(&prefix))
                        && self.cards[*index].status == "streaming"
                    {
                        self.cards[*index].status = if self.status == "cancelled" {
                            "cancelled"
                        } else {
                            "done"
                        }
                        .into();
                    }
                }
                for (key, index) in &self.tools {
                    if key.starts_with(&prefix) {
                        self.cards[*index].started_at = None;
                        self.cards[*index].tool_id.clear();
                    }
                }
                self.messages.remove(&message_key);
                self.progress.retain(|key, _| !key.starts_with(&prefix));
                let index = self.card(agent, "Turn", text(data, "summary"), &self.status.clone());
                if event.payload_ref.is_some() && self.cards[index].body.len() <= 220 {
                    self.cards[index].payload_ref = event.payload_ref.clone();
                } else if data.get("summary").is_some() {
                    self.cards[index].detail = Some(self.cards[index].body.clone());
                }
                let mut metadata = Vec::new();
                if let Some(ms) = data.get("duration_ms").and_then(Value::as_f64) {
                    metadata.push(format!("{:.1}s", ms / 1000.0));
                }
                if self.cost > 0.0 {
                    metadata.push(format!("${:.4}", self.cost));
                }
                self.cards[index].metadata = metadata.join(" · ");
            }
            "artifact_created" => {
                let index = self.card(
                    agent,
                    &text(data, "title"),
                    text(data, "path"),
                    &text(data, "kind"),
                );
                self.cards[index].open_url = data.get("url").and_then(Value::as_str).map(safe_text);
                if let Some(reference) = &event.payload_ref {
                    self.cards[index].payload_ref = Some(reference.clone());
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn transcript(&self) -> Vec<String> {
        self.cards
            .iter()
            .flat_map(|card| {
                let mut lines = vec![format!(
                    "[{}] {}{} ({})",
                    card.status,
                    card.title,
                    if card.primary.is_empty() {
                        String::new()
                    } else {
                        format!(" · {}", safe_text(&card.primary))
                    },
                    safe_text(&card.agent)
                )];
                lines.extend(card.body.lines().map(|line| format!("  {line}")));
                lines.push(String::new());
                lines
            })
            .collect()
    }
}

// Saved resume progress is transient UI, never part of the recovered conversation.
fn command_output(name: &str, output: &str) -> String {
    if name != "/resume" && !name.starts_with("/resume ") && !name.starts_with("Command /resume") {
        return safe_text(output);
    }
    safe_text(output)
        .lines()
        .filter(|line| !(line.contains('%') && (line.contains('█') || line.contains('░'))))
        .collect::<Vec<_>>()
        .join("\n")
}

fn safe_text_json(value: &Value) -> String {
    safe_text(&value.to_string())
}

fn pretty_json(value: &Value) -> String {
    safe_text(&serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()))
}

fn string_arg<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
}

fn sensitive_config_path(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name == ".env" || name.starts_with(".env.")
}

fn tool_arguments_preview(name: &str, args: &Value) -> String {
    if string_arg(args, &["file_path", "path"]).is_some_and(sensitive_config_path) {
        return "content redacted · sensitive config file".into();
    }
    if name.eq_ignore_ascii_case("apply_patch")
        && string_arg(args, &["patch", "content"]).is_some_and(|patch| patch.contains(".env"))
    {
        return "patch content redacted · may contain sensitive config".into();
    }
    let key = match name.to_ascii_lowercase().as_str() {
        "write_file" => Some(("content", "content")),
        "edit_file" | "multi_edit" => Some(("replacement", "replace")),
        "apply_patch" => Some(("patch", "patch")),
        _ => None,
    };
    let Some((label, first_key)) = key else {
        if name == "write_project" {
            if let Some(files) = args.get("files").and_then(Value::as_array) {
                let names = files
                    .iter()
                    .take(2)
                    .filter_map(|file| string_arg(file, &["path", "file_path"]))
                    .map(safe_text)
                    .collect::<Vec<_>>()
                    .join(", ");
                return format!(
                    "{} files{}",
                    files.len(),
                    if names.is_empty() {
                        String::new()
                    } else {
                        format!(" · {names}")
                    }
                );
            }
        }
        return args
            .as_object()
            .map(|_| safe_text(&args.to_string()))
            .unwrap_or_default();
    };
    let content =
        if name.eq_ignore_ascii_case("edit_file") || name.eq_ignore_ascii_case("multi_edit") {
            string_arg(args, &["replace", "new_string", "newString"])
        } else {
            string_arg(args, &[first_key, "content"])
        };
    let Some(content) = content else {
        return safe_text(&args.to_string());
    };
    let lines: Vec<&str> = content.lines().collect();
    let sample = lines
        .iter()
        .take(2)
        .map(|line| middle_preview(line, 72))
        .collect::<Vec<_>>()
        .join("\n");
    safe_text(&format!("{label} · {} lines\n{sample}", lines.len().max(1)))
}

fn tool_arguments_detail(name: &str, args: &Value) -> String {
    if string_arg(args, &["file_path", "path"]).is_some_and(sensitive_config_path) {
        let path = string_arg(args, &["file_path", "path"]).unwrap_or("file");
        return format!(
            "{}\n\n[content redacted · sensitive config file]",
            safe_text(path)
        );
    }
    match name.to_ascii_lowercase().as_str() {
        "write_file" => {
            let path = string_arg(args, &["file_path", "path"]).unwrap_or("file");
            let content = string_arg(args, &["content"]).unwrap_or("(no content)");
            format!("{}\n\n{}", safe_text(path), safe_text(content))
        }
        "edit_file" | "multi_edit" => {
            let path = string_arg(args, &["file_path", "path"]).unwrap_or("file");
            let before = string_arg(args, &["search", "old_string", "oldString"]).unwrap_or("");
            let after = string_arg(args, &["replace", "new_string", "newString"]).unwrap_or("");
            format!(
                "{}\n\nOLD\n{}\n\nNEW\n{}",
                safe_text(path),
                safe_text(before),
                safe_text(after)
            )
        }
        "apply_patch" => string_arg(args, &["patch", "content"])
            .map(|patch| {
                if patch.contains(".env") {
                    "[patch content redacted · may contain sensitive config]".into()
                } else {
                    safe_text(patch)
                }
            })
            .unwrap_or_else(|| pretty_json(args)),
        "write_project" => args
            .get("files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .map(|file| {
                        let path = string_arg(file, &["path", "file_path"]).unwrap_or("file");
                        if sensitive_config_path(path) {
                            return format!(
                                "{}\n\n[content redacted · sensitive config file]",
                                safe_text(path)
                            );
                        }
                        let content = string_arg(file, &["content"]).unwrap_or("(no content)");
                        format!("{}\n\n{}", safe_text(path), safe_text(content))
                    })
                    .collect::<Vec<_>>()
                    .join("\n\n---\n\n")
            })
            .unwrap_or_else(|| pretty_json(args)),
        _ => pretty_json(args),
    }
}

fn middle_preview(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return safe_text(value);
    }
    let left = max_chars.saturating_sub(1) / 2;
    let right = max_chars.saturating_sub(1) - left;
    let chars: Vec<char> = value.chars().collect();
    format!(
        "{}…{}",
        chars.iter().take(left).collect::<String>(),
        chars
            .iter()
            .skip(chars.len().saturating_sub(right))
            .collect::<String>()
    )
}
