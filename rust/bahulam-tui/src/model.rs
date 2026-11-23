use crate::protocol::{EventEnvelope, EVENT_TYPES};
use serde_json::Value;
use std::{collections::HashMap, time::Instant};

#[derive(Debug, Clone, Hash)]
pub struct Card {
    pub final_reply: bool,
    pub has_tool_output: bool,
    pub has_edit_diff: bool,
    pub archived: Option<crate::transcript_archive::Record>,
    pub preview: Option<crate::rich_preview::Preview>,
    pub agent: String,
    pub title: String,
    pub primary: String,
    pub display_path: Option<String>,
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
    pub fn has_detail(&self) -> bool {
        self.detail.is_some() || self.archived.as_ref().is_some_and(|r| r.has_detail)
    }
    pub fn materialized(&self) -> std::borrow::Cow<'_, Self> {
        let Some(record) = &self.archived else {
            return std::borrow::Cow::Borrowed(self);
        };
        let mut card = self.clone();
        match record.read() {
            Ok(text) => {
                card.body = text.body;
                card.detail = text.detail;
            }
            Err(error) => {
                card.body = format!("Archived text unavailable: {error}. Reopen the saved session to reload its canonical history.");
            }
        }
        card.archived = None;
        std::borrow::Cow::Owned(card)
    }

    // Request arguments and result payloads can arrive independently. When output
    // starts, an outstanding argument lookup must not block fetching the result.
    fn begin_tool_output(&mut self) {
        if !self.has_tool_output {
            self.has_tool_output = true;
            self.body.clear();
            self.detail = None;
            self.payload_ref = None;
            self.detail_loading = false;
        }
    }

    pub fn is_foldable(&self) -> bool {
        !self.tool_name.is_empty()
            || self.title.starts_with("Tool ")
            || matches!(self.title.as_str(), "Diff" | "Approval")
    }

    pub fn belongs_to(&self, agent: &str) -> bool {
        self.agent == agent || (self.title == "Agent report" && self.primary == agent)
    }

    pub fn visible_in_transcript(&self, agent: &str) -> bool {
        self.title != "Thinking" && self.belongs_to(agent)
    }

    pub fn is_message(&self) -> bool {
        self.title == "Assistant"
            || self.title == "Prompt"
            || self.title == "Agent report"
            || self.title.starts_with("Agent: ")
    }
}
#[derive(Debug, Clone, Default)]
pub struct Agent {
    pub id: String,
    pub parent: Option<String>,
    pub label: String,
    pub task: String,
    pub historical: bool,
    turn_id: Option<String>,
    spawned: bool,
    pub artifact: String,
    pub written_file: String,
    pub status: String,
    pub current_tool: String,
    pub elapsed_ms: Option<f64>,
    pub tokens: Option<u64>,
    pub cost: Option<f64>,
    pub last_tool: String,
    pub current_tool_id: String,
    pub started_at: Option<Instant>,
}
impl Agent {
    pub fn active(&self) -> bool {
        !self.historical
            && !matches!(
                self.status.as_str(),
                "idle"
                    | "done"
                    | "complete"
                    | "completed"
                    | "failed"
                    | "cancelled"
                    | "unconfirmed"
                    | "historical"
            )
    }
    pub fn elapsed(&self) -> Option<f64> {
        self.started_at
            .map(|at| self.elapsed_ms.unwrap_or(0.0) + at.elapsed().as_secs_f64() * 1000.0)
            .or(self.elapsed_ms)
    }
    fn stop_clock(&mut self) {
        self.elapsed_ms = self.elapsed();
        self.started_at = None;
    }
    fn update_usage(&mut self, data: &Value) {
        let usage = data
            .get("tokens")
            .or_else(|| data.get("usage"))
            .unwrap_or(data);
        let count = data
            .get("total_tokens")
            .and_then(Value::as_u64)
            .or_else(|| usage.as_u64())
            .or_else(|| usage.get("total").and_then(Value::as_u64))
            .or_else(|| usage.get("total_tokens").and_then(Value::as_u64))
            .or_else(|| {
                let input = usage
                    .get("input_tokens")
                    .or_else(|| usage.get("input"))
                    .and_then(Value::as_u64);
                let output = usage
                    .get("output_tokens")
                    .or_else(|| usage.get("output"))
                    .and_then(Value::as_u64);
                (input.is_some() || output.is_some())
                    .then(|| input.unwrap_or(0).saturating_add(output.unwrap_or(0)))
            });
        if let Some(count) = count {
            self.tokens = Some(count);
        }
        if let Some(cost) = data
            .get("cost_usd")
            .or_else(|| data.get("cost"))
            .or_else(|| usage.get("cost_usd"))
            .or_else(|| usage.get("cost"))
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
        {
            self.cost = Some(cost);
        }
    }
}
#[derive(Debug, Clone)]
pub struct Approval {
    pub agent: String,
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
    pub view_revision: u64,
    layout_changes: std::collections::VecDeque<(u64, usize)>,
    pub transcript_revision: u64,
    pub session: String,
    session_announced: bool,
    last_mcp_inventory: Option<String>,
    pub cwd: String,
    pub git_branch: String,
    pub permission_mode: String,
    pub custom_status: String,
    pub model: String,
    pub model_mode: String,
    pub model_route: String,
    pub last_seq: i64,
    pub cards: Vec<Card>,
    pub agents: Vec<Agent>,
    pub agents_open: bool,
    pub agents_hidden: bool,
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
    pub turn_recap: Option<String>,
    pub copy_confirmed: bool,
    pub selecting_text: bool,
    queued_prompts: usize,
    pub warnings: Vec<String>,
    pub approval: Option<Approval>,
    pub command_catalog: Vec<(String, String)>,
    pub slash_menu: crate::composer::SlashMenu,
    pub interaction: Option<Interaction>,
    tools: HashMap<String, usize>,
    active_tools: std::collections::BTreeSet<usize>,
    messages: HashMap<String, usize>,
    // Card indices only: keep streamed segments in arrival order without copying text.
    message_segments: HashMap<String, Vec<usize>>,
    progress: HashMap<String, usize>,
    approvals: HashMap<String, usize>,
    agent_reports: HashMap<String, usize>,
    turn_starts: HashMap<String, usize>,
    archive: Option<std::sync::Arc<crate::transcript_archive::Archive>>,
    retention_events: usize,
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

// Keep a bounded running preview; tool_finished/detail_loaded supplies the full result.
fn append_running_tool_output(body: &mut String, chunk: &str) {
    const MAX_BYTES: usize = 12 * 1024;
    const MAX_LINES: usize = 20;
    const MARKER: &str = "[earlier tool output omitted]\n";
    let mut truncated = body.starts_with(MARKER);
    let mut tail = std::mem::take(body);
    if truncated {
        tail.drain(..MARKER.len());
    }
    tail.push_str(chunk);
    let mut cut = tail.len().saturating_sub(MAX_BYTES);
    while !tail.is_char_boundary(cut) {
        cut += 1;
    }
    let extra_lines = tail.lines().count().saturating_sub(MAX_LINES);
    if extra_lines > 0 {
        if let Some((index, _)) = tail.match_indices('\n').nth(extra_lines - 1) {
            cut = cut.max(index + 1);
        }
    }
    if cut > 0 {
        tail.drain(..cut);
        truncated = true;
    }
    *body = if truncated {
        format!("{MARKER}{tail}")
    } else {
        tail
    };
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

    pub fn pending_approval_card(&self) -> Option<usize> {
        self.approvals
            .get(&format!("live/{}", self.approval.as_ref()?.id))
            .copied()
    }

    pub fn request_details(&mut self, index: usize) -> Option<String> {
        if index >= self.cards.len() {
            return None;
        }
        self.restore_card(index);
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
            .map(|card| {
                let card = card.materialized();
                card.detail.as_deref().unwrap_or(&card.body).lines().count()
            })
            .unwrap_or(0)
    }

    fn card(&mut self, agent: &str, title: &str, body: String, status: &str) -> usize {
        let index = self.cards.len();
        self.cards.push(Card {
            final_reply: false,
            has_tool_output: false,
            has_edit_diff: false,
            archived: None,
            preview: None,
            agent: agent.into(),
            title: title.into(),
            primary: String::new(),
            display_path: None,
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

    pub fn set_composer_hint(&mut self, hint: &str) {
        self.composer_hint = safe_text(hint);
        self.copy_confirmed = false;
    }

    pub fn thinking(&self, agent: &str) -> bool {
        self.progress.values().any(|&index| {
            let card = &self.cards[index];
            card.title == "Thinking" && card.agent == agent && card.status == "streaming"
        })
    }

    fn finish_thinking_segment(&mut self, key: &str) {
        if let Some(index) = self.progress.remove(&format!("{key}/thinking")) {
            self.cards[index].status = "done".into();
        }
    }

    // Some hosts send a turn-wide aggregate in content/message_end after
    // streaming commentary and tool calls. Only its unseen suffix belongs at
    // the new position; never overwrite the earlier commentary with the final.
    fn message_suffix<'a>(&self, indices: &[usize], before: usize, text: &'a str) -> &'a str {
        let mut remaining = text;
        for &index in indices.iter().take_while(|&&i| i < before) {
            match remaining.strip_prefix(self.cards[index].materialized().body.as_str()) {
                Some(suffix) => remaining = suffix,
                None => return text, // A standalone message, not a cumulative result.
            }
        }
        remaining
    }

    // Presentation acknowledgement only: Node remains the instruction queue owner.
    pub fn queue_prompt(&mut self, prompt: &str) {
        if !prompt.trim().is_empty() && !prompt.trim_start().starts_with('/') {
            self.queued_prompts += 1;
        }
    }

    pub fn pending_prompt_count(&self) -> usize {
        self.queued_prompts
    }

    pub fn enforce_retention(&mut self, budget: usize) -> std::io::Result<()> {
        let mut bytes: usize = self
            .cards
            .iter()
            .map(|c| c.body.len() + c.detail.as_ref().map_or(0, String::len))
            .sum();
        if bytes <= budget {
            return Ok(());
        }
        if self.archive.is_none() {
            self.archive = Some(crate::transcript_archive::Archive::create()?);
        }
        let archive = self.archive.as_ref().unwrap();
        for card in &mut self.cards {
            if bytes <= budget {
                break;
            }
            if card.archived.is_some()
                || card.detail_loading
                || matches!(
                    card.status.as_str(),
                    "running" | "streaming" | "working" | "requested" | "waiting"
                )
            {
                continue;
            }
            let size = card.body.len() + card.detail.as_ref().map_or(0, String::len);
            if size == 0 {
                continue;
            }
            let record = archive.append(&card.body, card.detail.as_deref())?;
            card.archived = Some(record);
            card.body = String::new();
            card.detail = None;
            bytes = bytes.saturating_sub(size);
        }
        Ok(())
    }
    fn restore_card(&mut self, index: usize) {
        if self.cards[index].archived.is_some() {
            self.cards[index] = self.cards[index].materialized().into_owned();
        }
    }
    pub fn touch_view(&mut self) {
        self.touch_view_from(0);
    }
    pub fn touch_view_from(&mut self, index: usize) {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        self.view_revision = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.layout_changes.push_back((self.view_revision, index));
        if self.layout_changes.len() > 256 {
            self.layout_changes.pop_front();
        }
    }
    pub fn changed_since(&self, revision: u64) -> Option<usize> {
        if revision == self.view_revision {
            return Some(self.cards.len());
        }
        if self.layout_changes.len() == 256
            && self
                .layout_changes
                .front()
                .is_some_and(|(r, _)| *r > revision)
        {
            return None;
        }
        self.layout_changes
            .iter()
            .filter(|(r, _)| *r > revision)
            .map(|(_, i)| *i)
            .min()
    }
    fn affected_card(&self, event: &EventEnvelope, agent: &str) -> usize {
        let turn = event.turn_id.as_deref().unwrap_or("legacy");
        let origin = if self.replaying_history {
            "history"
        } else {
            "live"
        };
        let prefix = format!("{origin}/{turn}/{agent}");
        let latest = self.cards.len();
        match event.r#type.as_str() {
            "text_delta" | "message_end" | "thinking_delta" | "notice" => self
                .messages
                .get(&prefix)
                .copied()
                .into_iter()
                .chain(
                    self.progress
                        .iter()
                        .filter(|(key, _)| key.starts_with(&prefix))
                        .map(|(_, i)| *i),
                )
                .min()
                .unwrap_or(latest),
            "tool_requested" | "tool_started" | "tool_finished" | "tool_output_delta"
            | "tool_call" | "tool_result" => {
                let key = format!("{prefix}/{}", text(&event.data, "tool_id"));
                self.tools
                    .get(&key)
                    .copied()
                    .into_iter()
                    .chain(self.messages.get(&prefix).copied())
                    .min()
                    .unwrap_or(latest)
            }
            "detail_loaded" => {
                let reference = text(&event.data, "payload_ref");
                self.cards
                    .iter()
                    .position(|c| c.payload_ref.as_deref() == Some(&reference))
                    .unwrap_or(latest)
            }
            "turn_started" | "artifact_created" | "test_result" | "diff" | "command_result"
            | "usage_update" | "tokens_used" | "session_state" | "command_catalog" => latest,
            _ => 0,
        }
    }
    // Some callback producers identify tool events by worker role. Persisted
    // sessions use the same form, so resolve at the shared live/replay boundary.
    fn worker_tool_owner(&self, event: &EventEnvelope) -> Option<&str> {
        let role = event.agent_id.as_deref()?;
        if role == "main"
            || !matches!(
                event.r#type.as_str(),
                "tool_requested"
                    | "tool_call"
                    | "tool_started"
                    | "tool_result"
                    | "tool_finished"
                    | "tool_output_delta"
                    | "diff"
            )
        {
            return None;
        }
        let turn = event.turn_id.as_deref()?;
        if self.agents.iter().any(|row| row.id == role && row.spawned) {
            return None;
        }
        let origin = if self.replaying_history {
            "history"
        } else {
            "live"
        };
        let call = event.data["tool_id"]
            .as_str()
            .or_else(|| event.data["call_id"].as_str())?;
        let owners = self.agents.iter().filter(|row| {
            row.turn_id.as_deref() == Some(turn)
                && row.historical == self.replaying_history
                && row.parent.as_deref().unwrap_or("main")
                    == event.parent_agent_id.as_deref().unwrap_or("main")
                && (row.label == role || row.id == role)
        });
        let mut matching_call = owners.clone().filter(|row| {
            self.tools
                .contains_key(&format!("{origin}/{turn}/{}/{call}", row.id))
        });
        if let Some(row) = matching_call.next() {
            return (matching_call.next().is_none() && row.id != role).then_some(row.id.as_str());
        }
        let mut running = owners
            .filter(|row| row.spawned && matches!(row.status.as_str(), "working" | "running"));
        let row = running.next()?;
        running.next().is_none().then_some(row.id.as_str())
    }
    pub fn apply(&mut self, event: &EventEnvelope) -> Result<(), String> {
        let owner = self.worker_tool_owner(event).map(str::to_owned);
        let agent = owner
            .as_deref()
            .or(event.agent_id.as_deref())
            .or_else(|| event.data["subagent_id"].as_str())
            .unwrap_or("main");
        let affected = self.affected_card(event, agent);
        let result = self.apply_event(event, agent);
        self.touch_view_from(affected);
        self.retention_events = self.retention_events.wrapping_add(1);
        let large_event = event.data.as_object().is_some_and(|data| {
            data.values()
                .filter_map(Value::as_str)
                .map(str::len)
                .sum::<usize>()
                > 64 * 1024
        });
        if self.retention_events.is_multiple_of(128) || large_event {
            if let Err(error) = self.enforce_retention(16 * 1024 * 1024) {
                let warning = format!("Transcript memory budget unavailable: {error}");
                if !self.warnings.contains(&warning) {
                    self.warnings.push(warning);
                }
            }
        }
        result
    }
    fn apply_event(&mut self, event: &EventEnvelope, agent: &str) -> Result<(), String> {
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
                self.last_mcp_inventory = None;
                self.usage_known = false;
                self.cost_known = false;
                self.context_known = false;
                self.cards.clear();
                self.archive = None;
                self.agents.clear();
                self.agents_open = false;
                self.agents_hidden = false;
                self.agent_reports.clear();
                self.turn_starts.clear();
                self.turn_recap = None;
                self.plan.clear();
                self.tools.clear();
                self.active_tools.clear();
                self.messages.clear();
                self.message_segments.clear();
                self.progress.clear();
                self.approvals.clear();
                if self.session != event.session_id {
                    self.queued_prompts = 0;
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
                self.session_announced = true;
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
                                parent_agent_id: historical
                                    .get("parent_agent_id")
                                    .or_else(|| data.get("parent_agent_id"))
                                    .or_else(|| data.get("parent_run_id"))
                                    .and_then(Value::as_str)
                                    .map(str::to_owned),
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
                        self.cards[index].final_reply = role == "assistant";
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
            self.model_mode = text(&event.data, "model_mode");
            self.model_route = text(&event.data, "model_route");
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
            let indices: Vec<_> = self
                .cards
                .iter()
                .enumerate()
                .filter(|(_, c)| c.payload_ref.as_deref() == Some(reference.as_str()))
                .map(|(i, _)| i)
                .collect();
            for index in indices {
                self.restore_card(index);
            }
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
                } else if card.title == "Approval" {
                    serde_json::from_str::<Value>(&detail)
                        .map(|args| approval_arguments(&card.primary, &args))
                        .unwrap_or_else(|_| detail.clone())
                } else {
                    command_output(&card.title, &detail)
                };
                let mut body = if card.is_message() && event.data.get("error").is_none() {
                    self.message_segments
                        .values()
                        .find(|indices| indices.contains(&index))
                        .map(|indices| self.message_suffix(indices, index, &detail))
                        .unwrap_or(&detail)
                        .to_owned()
                } else {
                    detail.clone()
                };
                if card.title == "Agent report" && card.status == "failed" {
                    if let Some(agent) = self.agents.iter().find(|a| a.id == card.primary) {
                        if !agent.last_tool.is_empty() && !body.contains("Last tool:") {
                            body.push_str(&format!("\nLast tool: {}", agent.last_tool));
                        }
                    }
                }
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
                    if event.data.get("error").is_none() {
                        approval.command = serde_json::from_str::<Value>(&detail)
                            .map(|args| approval_arguments(&approval.tool, &args))
                            .unwrap_or(detail);
                    }
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
        let turn = event.turn_id.as_deref().unwrap_or("legacy");
        if !self.agents.iter().any(|a| a.id == agent) {
            self.agents.push(Agent {
                id: agent.into(),
                parent: event.parent_agent_id.clone(),
                label: safe_text(agent),
                status: "idle".into(),
                current_tool: String::new(),
                elapsed_ms: None,
                historical: self.replaying_history,
                turn_id: event.turn_id.clone(),
                ..Agent::default()
            });
        }
        if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
            row.historical = self.replaying_history;
            if event.parent_agent_id.is_some() {
                row.parent.clone_from(&event.parent_agent_id);
            }
        }
        let tool_id = text(data, "tool_id");
        let origin = if self.replaying_history {
            "history"
        } else {
            "live"
        };
        let key = format!("{origin}/{turn}/{agent}/{tool_id}");
        let message_key = format!("{origin}/{turn}/{agent}");
        if let Some(index) = self.tools.get(&key).copied() {
            self.restore_card(index);
        }
        if let Some(index) = self.messages.get(&message_key).copied() {
            self.restore_card(index);
        }
        let indices: Vec<_> = self
            .progress
            .iter()
            .chain(self.agent_reports.iter())
            .filter(|(k, _)| k.starts_with(&message_key))
            .map(|(_, i)| *i)
            .collect();
        for index in indices {
            self.restore_card(index);
        }
        // Thinking belongs to a chronological phase, not a single card pinned
        // to the start of the turn. Other agents must not end this agent's phase.
        if matches!(
            kind,
            "text_delta"
                | "message_end"
                | "tool_requested"
                | "tool_call"
                | "tool_started"
                | "tool_finished"
                | "tool_result"
                | "tool_output_delta"
                | "test_result"
                | "diff"
                | "artifact_created"
        ) {
            self.finish_thinking_segment(&message_key);
        }
        match kind {
            "session_started" => {
                if let Some(cwd) = data
                    .get("cwd")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.cwd = safe_text(cwd);
                }
                if let Some(model) = data
                    .get("model")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.model = safe_text(model);
                }
                if !self.session_announced {
                    self.session_announced = true;
                    self.card(agent, "Session", self.cwd.clone(), "ready");
                }
            }
            "turn_started" => {
                self.turn_starts
                    .insert(message_key.clone(), self.cards.len());
                if agent == "main" {
                    self.status = "working".into();
                    self.turn_recap = None;
                }
                if let Some(main) = self.agents.iter_mut().find(|row| row.id == agent) {
                    main.turn_id.clone_from(&event.turn_id);
                    main.artifact.clear();
                    main.written_file.clear();
                    main.status = "working".into();
                    main.started_at = (!self.replaying_history).then(Instant::now);
                }
                let prompt = text(data, "text");
                if !self.replaying_history && agent == "main" {
                    // Node drains its serial queue in order. Display text may be
                    // redacted or attachment-expanded, so never match by bytes.
                    self.queued_prompts = self.queued_prompts.saturating_sub(1);
                }
                self.card(agent, "Prompt", prompt, "sent");
            }
            "thinking_delta" => {
                let progress_key = format!("{message_key}/thinking");
                let chunk = text(data, "chunk");
                let is_status = is_iteration_status(&chunk);
                let index = if let Some(index) = self.progress.get(&progress_key) {
                    *index
                } else {
                    self.finish_message_segment(&message_key);
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
                if !is_status {
                    self.cards[index].body.push_str(&chunk);
                    self.cards[index].payload_ref = event.payload_ref.clone();
                }
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
                let args_value = &data["args"];
                let peer_call = matches!(
                    name.to_ascii_lowercase().as_str(),
                    "plan" | "explore" | "verify" | "debug" | "refactor" | "delegate"
                );
                let primary = text(data, "primary");
                let primary = if peer_call && args_value.is_object() {
                    // Older transcripts have the arguments but no display summary.
                    let handoff = &args_value["handoff"];
                    [
                        &handoff["context"],
                        &handoff["objective"],
                        &args_value["task"],
                    ]
                    .into_iter()
                    .filter_map(Value::as_str)
                    .find(|value| !value.trim().is_empty())
                    .map(|value| {
                        safe_text(value)
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .unwrap_or_default()
                } else if peer_call || !primary.is_empty() {
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
                let body = if peer_call {
                    String::new()
                } else if !preview.is_empty() {
                    preview
                } else if let Some(args) = data.get("args") {
                    tool_arguments_preview(&name, args)
                } else {
                    String::new()
                };
                let display_path = data["display_path"].as_str().map(safe_text).or_else(|| {
                    let file = args_value["path"]
                        .as_str()
                        .or(args_value["file_path"].as_str())?;
                    if self.cwd.is_empty() {
                        return None;
                    }
                    let relative = std::path::Path::new(file).strip_prefix(&self.cwd).ok()?;
                    Some(if relative.as_os_str().is_empty() {
                        ".".into()
                    } else {
                        safe_text(&relative.to_string_lossy())
                    })
                });
                let index = self.card(agent, &name, body, "requested");
                self.cards[index].primary = primary;
                self.cards[index].display_path = display_path;
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
                self.active_tools.insert(index);
                if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                    row.current_tool = name.clone();
                    row.last_tool = name;
                    row.current_tool_id = tool_id.clone();
                    if row.status == "idle" && !self.replaying_history {
                        row.status = "working".into();
                        row.started_at = Some(Instant::now());
                    }
                }
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
                    self.active_tools.insert(index);
                    self.cards[index].status = "running".into();
                    self.cards[index].started_at = (!self.replaying_history).then(Instant::now);
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        row.current_tool = self.cards[index].title.clone();
                        row.current_tool_id = tool_id.clone();
                        row.last_tool = row.current_tool.clone();
                    }
                } else if kind == "tool_output_delta" {
                    let chunk = text(data, "chunk");
                    if !chunk.is_empty() {
                        let card = &mut self.cards[index];
                        card.begin_tool_output();
                        append_running_tool_output(&mut card.body, &chunk);
                    }
                } else {
                    self.active_tools.remove(&index);
                    self.cards[index].status = if tool_succeeded(data) {
                        "done"
                    } else {
                        "failed"
                    }
                    .into();
                    let preview = text(data, "preview");
                    let summary = if preview.is_empty() {
                        text(data, "summary")
                    } else {
                        preview
                    };
                    let output = data
                        .get("output")
                        .filter(|value| !value.is_null())
                        .or_else(|| data.get("result").filter(|value| !value.is_null()));
                    let card = &mut self.cards[index];
                    if output.is_some() || event.payload_ref.is_some() || !summary.is_empty() {
                        // A status-only acknowledgement can follow the local result.
                        // The preview format belongs to the event supplying its content.
                        card.has_edit_diff =
                            data.get("has_edit_diff").and_then(Value::as_bool) == Some(true);
                        card.begin_tool_output();
                        if !summary.is_empty() {
                            card.body = summary;
                        }
                        if card.payload_ref != event.payload_ref {
                            card.detail_loading = false;
                        }
                        if let Some(value) = output {
                            let detail = value
                                .as_str()
                                .map(safe_text)
                                .unwrap_or_else(|| pretty_json(value));
                            if card.body.is_empty() {
                                card.body = detail.lines().take(2).collect::<Vec<_>>().join("\n");
                            }
                            card.detail = Some(detail);
                            card.payload_ref = event.payload_ref.clone().filter(|_| {
                                data.get("cached_full_payload").and_then(Value::as_bool)
                                    == Some(true)
                            });
                        } else if let Some(reference) = &event.payload_ref {
                            if card.payload_ref.as_ref() != Some(reference) {
                                card.detail = None;
                            }
                            card.payload_ref = Some(reference.clone());
                        }
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
                    if !metadata.is_empty() {
                        self.cards[index].metadata = metadata.join(" · ");
                    }
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        let card = &self.cards[index];
                        if card.status == "done"
                            && matches!(card.tool_name.as_str(), "write_file" | "create_file")
                            && !card.primary.is_empty()
                            && card.primary != "see details"
                        {
                            row.written_file
                                .clone_from(card.display_path.as_ref().unwrap_or(&card.primary));
                        }
                        if row.current_tool_id == tool_id {
                            let next = self
                                .active_tools
                                .iter()
                                .rev()
                                .map(|&i| &self.cards[i])
                                .find(|card| {
                                    card.agent == agent
                                        && !card.tool_name.is_empty()
                                        && matches!(card.status.as_str(), "requested" | "running")
                                });
                            row.current_tool = next.map(|c| c.title.clone()).unwrap_or_default();
                            row.current_tool_id =
                                next.map(|c| c.tool_id.clone()).unwrap_or_default();
                        }
                    }
                }
            }
            "agent_spawned" | "sub_agent_start" | "agent_status" | "agent_finished"
            | "sub_agent_complete" => {
                let row = self.agents.iter_mut().find(|a| a.id == agent).unwrap();
                if let Some(parent) = &event.parent_agent_id {
                    row.parent = Some(parent.clone());
                }
                row.update_usage(data);
                if kind == "agent_spawned" || kind == "sub_agent_start" {
                    row.spawned = true;
                    row.turn_id.clone_from(&event.turn_id);
                    row.artifact.clear();
                    row.written_file.clear();
                    let label = text(data, "type");
                    if !label.is_empty() {
                        row.label = label;
                    }
                    row.task = text(data, "task");
                    row.status = "working".into();
                    if !self.replaying_history && row.started_at.is_none() {
                        row.started_at = Some(Instant::now());
                    }
                } else if kind == "agent_status" {
                    let status = text(data, "status");
                    if !status.is_empty() {
                        row.status = status;
                    }
                    if let Some(elapsed) = data
                        .get("elapsed_ms")
                        .and_then(Value::as_f64)
                        .filter(|v| v.is_finite() && *v >= 0.0)
                    {
                        row.elapsed_ms = Some(elapsed);
                        row.started_at =
                            (row.active() && !self.replaying_history).then(Instant::now);
                    } else if !row.active() {
                        row.stop_clock();
                    }
                    if !row.active() {
                        row.current_tool.clear();
                        row.current_tool_id.clear();
                    }
                    if let Some(id) = data.get("current_tool_id").and_then(Value::as_str) {
                        row.current_tool_id = id.into();
                        row.current_tool = if id.is_empty() {
                            String::new()
                        } else {
                            self.tools
                                .get(&format!("{origin}/{turn}/{agent}/{id}"))
                                .map(|index| self.cards[*index].title.clone())
                                .unwrap_or_else(|| "tool running".into())
                        };
                    }
                } else {
                    row.stop_clock();
                    if let Some(elapsed) = data
                        .get("elapsed_ms")
                        .or_else(|| data.get("duration_ms"))
                        .and_then(Value::as_f64)
                        .filter(|v| v.is_finite() && *v >= 0.0)
                    {
                        row.elapsed_ms = Some(elapsed);
                    }
                    row.current_tool.clear();
                    row.current_tool_id.clear();
                    let failed = data.get("ok").and_then(Value::as_bool) == Some(false)
                        || !text(data, "error").is_empty();
                    row.status = if failed { "failed" } else { "done" }.into();
                    let mut report = text(data, "report");
                    let error = text(data, "error");
                    if failed && !error.is_empty() && !report.contains(&error) {
                        report.push_str(&format!("\nError: {error}"));
                    }
                    if failed && !row.last_tool.is_empty() {
                        report.push_str(&format!("\nLast tool: {}", row.last_tool));
                    }
                    if report.trim().is_empty() && event.payload_ref.is_none() {
                        report = if failed {
                            "Agent failed; no error details were supplied."
                        } else {
                            "Completed."
                        }
                        .into();
                    }
                    let status = row.status.clone();
                    let label = row.label.clone();
                    // A finished worker cannot keep its old tools or thinking spinning.
                    // Missing tool results are incomplete, never fabricated successes/failures.
                    for card in self.cards.iter_mut().filter(|card| card.agent == agent) {
                        card.started_at = None;
                        if !card.tool_name.is_empty()
                            && matches!(card.status.as_str(), "requested" | "running")
                        {
                            card.status = "incomplete".into();
                            card.metadata = "worker ended before a tool result arrived".into();
                        } else if card.status == "streaming" {
                            card.status = if failed { "failed" } else { "complete" }.into();
                        }
                    }
                    let key = format!("{origin}/{turn}/{agent}");
                    let index = if let Some(index) = self.agent_reports.get(&key) {
                        *index
                    } else {
                        let index = self.card("main", "Agent report", String::new(), &status);
                        self.agent_reports.insert(key, index);
                        index
                    };
                    let card = &mut self.cards[index];
                    card.primary = agent.into();
                    card.metadata = label;
                    card.status = status;
                    card.body = report;
                    card.payload_ref = event.payload_ref.clone();
                    card.detail = card.payload_ref.is_none().then(|| card.body.clone());
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
                let call_id = text(data, "call_id");
                if !call_id.is_empty()
                    && data.get("count").and_then(Value::as_u64).unwrap_or(1) == 1
                {
                    let call_key = format!("{origin}/{turn}/{agent}/{call_id}");
                    if self
                        .tools
                        .get(&call_key)
                        .is_some_and(|i| self.cards[*i].has_edit_diff)
                    {
                        return Ok(());
                    }
                }
                let path = text(data, "path");
                let mut detail = text(data, "unified");
                if detail.is_empty() {
                    detail = data
                        .get("hunks")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|h| string_arg(h, &["text", "content"]))
                        .map(safe_text)
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                let mut preview = text(data, "preview");
                if preview.is_empty() {
                    preview = detail
                        .lines()
                        .filter(|line| {
                            line.starts_with(['+', '-'])
                                && !line.starts_with("--- ")
                                && !line.starts_with("+++ ")
                        })
                        .take(3)
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                let index = self.card(agent, "Diff", preview, "done");
                let card = &mut self.cards[index];
                card.primary = path;
                card.payload_ref = event.payload_ref.clone();
                if !detail.is_empty() {
                    card.detail = Some(detail);
                }
            }
            "usage_update" | "tokens_used" => {
                if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                    row.update_usage(data);
                }
                if let Some(per_agent) = data.get("per_agent").and_then(Value::as_object) {
                    for (id, usage) in per_agent {
                        if !self.agents.iter().any(|row| &row.id == id) {
                            self.agents.push(Agent {
                                id: id.clone(),
                                label: safe_text(id),
                                status: "idle".into(),
                                historical: self.replaying_history,
                                ..Agent::default()
                            });
                        }
                        if let Some(row) = self.agents.iter_mut().find(|row| &row.id == id) {
                            row.update_usage(usage);
                        }
                    }
                }
                if !self.replaying_history && agent == "main" {
                    self.apply_usage(data);
                }
            }
            "notice" if text(data, "source") == "followup_held" => {
                self.queued_prompts = 0;
                self.set_composer_hint("Follow-ups held after interruption · review /history");
            }
            "notice" if text(data, "source") == "followup_save_failed" => {
                self.queued_prompts = self.queued_prompts.saturating_sub(1);
                self.card(
                    agent,
                    "Follow-up could not be saved",
                    format!("{}\n{}", text(data, "cause"), text(data, "next_step")),
                    "error",
                );
            }
            "notice" if text(data, "source") == "followup_applied" => {
                self.finish_message_segment(&message_key);
                self.finish_thinking_segment(&message_key);
                self.queued_prompts = self.queued_prompts.saturating_sub(1);
                let index = self.card(agent, "Prompt", text(data, "cause"), "sent");
                self.cards[index].payload_ref = event.payload_ref.clone();
            }
            "notice"
                if matches!(
                    text(data, "source").as_str(),
                    "user_intervention_accepted"
                        | "user_intervention_delivered"
                        | "user_intervention_queued"
                ) => {}
            "notice" => {
                if agent == "main" && data["source"] == "status" && data["level"] == "info" {
                    if let Some(summary) = data["cause"].as_str().filter(|s| is_mcp_inventory(s)) {
                        if self.last_mcp_inventory.as_deref() != Some(summary) {
                            self.last_mcp_inventory = Some(summary.to_owned());
                            self.card(
                                agent,
                                "MCP",
                                summary.trim_start_matches("MCP: ").to_owned(),
                                "ready",
                            );
                        }
                        return Ok(());
                    }
                }
                // Some producers expose worker tool progress without full tool-call events.
                if let Some(active) = data.get("tool_active").and_then(Value::as_bool) {
                    let name = text(data, "current_tool");
                    if !name.is_empty() {
                        if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                            let id = format!("progress:{name}");
                            if active {
                                row.current_tool = name.clone();
                                row.last_tool = name;
                                row.current_tool_id = id;
                            } else if row.current_tool_id == id {
                                row.current_tool.clear();
                                row.current_tool_id.clear();
                            }
                        }
                    }
                }
                let activity = text(data, "activity");
                if !activity.is_empty() {
                    if agent == "main" {
                        self.status = activity.clone();
                    }
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        row.status = activity;
                    }
                }
                let title = text(data, "title");
                let cause = text(data, "cause");
                let is_stagnation = matches!(
                    data["source"].as_str(),
                    Some("stagnation" | "stagnation_detected")
                );
                let title = if is_stagnation && cause == title && !cause.is_empty() {
                    "Stagnation".to_owned()
                } else {
                    title
                };
                let progress_kind = text(data, "progress_key");
                let cause = if progress_kind == "context-summary" {
                    cause
                        .rsplit_once(" · ")
                        .filter(|(_, suffix)| suffix.ends_with(" tokens") && suffix.contains(" / "))
                        .map_or(cause.as_str(), |(summary, _)| summary)
                } else if is_stagnation {
                    cause.strip_prefix("Stagnation: ").unwrap_or(&cause)
                } else {
                    &cause
                };
                let next_step = text(data, "next_step");
                let body = [cause, &next_step]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let progress_key = format!("{message_key}/{progress_kind}");
                let index = if !progress_kind.is_empty() {
                    if let Some(index) = self.progress.get(&progress_key) {
                        let index = *index;
                        self.cards[index].title = title;
                        self.cards[index].body = body;
                        self.cards[index].status = text(data, "level");
                        self.cards[index].detail = None;
                        self.cards[index].payload_ref = None;
                        index
                    } else {
                        let index = self.card(agent, &title, body, &text(data, "level"));
                        self.progress.insert(progress_key.clone(), index);
                        index
                    }
                } else {
                    self.card(agent, &title, body, &text(data, "level"))
                };
                if event.payload_ref.is_some() {
                    self.cards[index].payload_ref = event.payload_ref.clone();
                } else {
                    self.cards[index].detail = Some(self.cards[index].body.clone());
                }
                if progress_kind == "context-summary" && text(data, "level") != "running" {
                    self.progress.remove(&progress_key);
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
                let command = data
                    .get("args")
                    .map(|args| approval_arguments(&name, args))
                    .unwrap_or_default();
                let mut reason = text(data, "reason");
                if !command.is_empty()
                    && reason
                        .strip_prefix("Shell command requires approval: ")
                        .is_some_and(|quoted| {
                            command
                                .starts_with(quoted.trim_end_matches('…').trim_end_matches("..."))
                        })
                {
                    reason.clear();
                }
                if !self.replaying_history {
                    self.approval = Some(Approval {
                        agent: agent.into(),
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
                        command: command.clone(),
                        cwd: text(data, "cwd"),
                        reason: reason.clone(),
                        payload_ref: event.payload_ref.clone(),
                    });
                }
                let status = if self.replaying_history {
                    "historical"
                } else {
                    "waiting"
                };
                let body = [command, reason]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let index = self.card(agent, "Approval", body, status);
                self.cards[index].primary = name;
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
                let outcome = if text(data, "outcome") == "cancelled" {
                    "cancelled"
                } else if data.get("ok").and_then(Value::as_bool) == Some(false) {
                    "failed"
                } else {
                    "complete"
                };
                if agent == "main" {
                    self.status = outcome.into();
                    // A role-only tool row has no independent worker lifecycle.
                    for row in self.agents.iter_mut().filter(|row| {
                        row.id != "main"
                            && !row.spawned
                            && row.turn_id == event.turn_id
                            && row.historical == self.replaying_history
                            && matches!(row.status.as_str(), "working" | "running")
                    }) {
                        row.stop_clock();
                        row.current_tool.clear();
                        row.current_tool_id.clear();
                        row.status = "unconfirmed".into();
                    }
                }
                if let Some(main) = self.agents.iter_mut().find(|row| row.id == agent) {
                    main.status = outcome.into();
                    if let Some(started) = main.started_at.take() {
                        main.elapsed_ms = Some(started.elapsed().as_secs_f64() * 1000.0);
                    }
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
                        self.cards[*index].status = if outcome == "cancelled" {
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
                        self.cards[*index].status = if outcome == "cancelled" {
                            "cancelled"
                        } else {
                            "done"
                        }
                        .into();
                    }
                }
                for (key, index) in &self.tools {
                    if key.starts_with(&prefix) {
                        self.active_tools.remove(index);
                        self.cards[*index].started_at = None;
                        self.cards[*index].tool_id.clear();
                    }
                }
                if let Some(index) = self
                    .progress
                    .remove(&format!("{message_key}/context-summary"))
                {
                    let card = &mut self.cards[index];
                    card.title = "Summary interrupted".into();
                    card.status = "incomplete".into();
                    card.body = "Turn ended before summary completion was reported.".into();
                    card.detail = None;
                }
                self.messages.remove(&message_key);
                self.progress.retain(|key, _| !key.starts_with(&prefix));
                let start = self.turn_starts.remove(&message_key).unwrap_or_else(|| {
                    self.tools
                        .iter()
                        .filter(|(key, _)| key.starts_with(&prefix))
                        .map(|(_, index)| *index)
                        .min()
                        .unwrap_or(self.cards.len())
                });
                if agent == "main" && outcome == "complete" {
                    if let Some(&index) = self
                        .message_segments
                        .get(&message_key)
                        .and_then(|items| items.last())
                    {
                        // A tool-only ending can have earlier assistant commentary.
                        if !self.cards[index + 1..].iter().any(|card| {
                            card.agent == agent
                                && (!card.tool_name.is_empty() || card.title == "Thinking")
                        }) {
                            self.cards[index].final_reply = true;
                        }
                    }
                }
                if agent == "main" {
                    self.turn_recap = turn_recap(&self.cards[start..], agent, outcome, &self.cwd);
                }
                let summary = text(data, "summary");
                if outcome == "complete" && summary.is_empty() && event.payload_ref.is_none() {
                    return Ok(());
                }
                // Keep a producer-supplied response or failure reason in history.
                let index = self.card(agent, "Turn", summary, outcome);
                if event.payload_ref.is_some() {
                    self.cards[index].payload_ref = event.payload_ref.clone();
                } else if data.get("summary").is_some() {
                    self.cards[index].detail = Some(self.cards[index].body.clone());
                }
                let mut metadata = Vec::new();
                if let Some(ms) = data.get("duration_ms").and_then(Value::as_f64) {
                    metadata.push(format!("{:.1}s", ms / 1000.0));
                }
                // Session cumulative cost is not a turn cost. Only label explicitly scoped data.
                if let Some(cost) = data
                    .get("turn_cost_usd")
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v >= 0.0)
                {
                    metadata.push(format!("${cost:.4}"));
                }
                self.cards[index].metadata = metadata.join(" · ");
            }
            "artifact_created" => {
                let title = text(data, "title");
                let title = if title.is_empty() { "Artifact" } else { &title };
                let kind = text(data, "kind");
                let mime = text(data, "mime");
                let path = text(data, "path");
                if !title.starts_with("Attached ") {
                    if let Some(row) = self.agents.iter_mut().find(|row| row.id == agent) {
                        row.artifact = if title == "Artifact" && !path.is_empty() {
                            path.clone()
                        } else {
                            title.to_owned()
                        };
                    }
                }
                let format = artifact_format(&mime, &path, &kind);
                let pages = data.get("pages").and_then(Value::as_u64);
                let bytes = data.get("bytes").and_then(Value::as_u64);
                let mut metadata = Vec::new();
                if !format.is_empty() {
                    metadata.push(format);
                }
                if let Some(pages) = pages {
                    metadata.push(format!("{pages} page{}", if pages == 1 { "" } else { "s" }));
                }
                if let Some(bytes) = bytes {
                    metadata.push(format_artifact_size(bytes));
                }
                let url = data
                    .get("open_url")
                    .or_else(|| data.get("url"))
                    .and_then(Value::as_str)
                    .filter(|value| crate::browser_links::valid_url(value));
                let mut lines = Vec::new();
                if !path.is_empty() {
                    lines.push(path.clone());
                }
                if let Some(read) = artifact_read_progress(data, pages) {
                    lines.push(read);
                } else if kind == "document" || pages.is_some() {
                    lines.push("Reading progress not reported".into());
                }
                if let (Some(width), Some(height)) = (
                    data.get("width").and_then(Value::as_u64),
                    data.get("height").and_then(Value::as_u64),
                ) {
                    lines.push(format!("{width} × {height} pixels"));
                }
                lines.push(
                    if url.is_some() {
                        "Open in browser below · Alt+O opens"
                    } else if !path.is_empty() {
                        "Alt+O opens · Alt+L shows file link"
                    } else {
                        "No opening target supplied"
                    }
                    .into(),
                );
                let preview = lines.join("\n");
                let index = self.card(agent, title, preview, "done");
                if mime.starts_with("image/")
                    || matches!(
                        std::path::Path::new(&path)
                            .extension()
                            .and_then(|s| s.to_str())
                            .unwrap_or("")
                            .to_ascii_lowercase()
                            .as_str(),
                        "png" | "jpg" | "jpeg" | "webp"
                    )
                {
                    self.cards[index].preview = Some(if path.is_empty() {
                        crate::rich_preview::Preview::Unavailable("No local image supplied".into())
                    } else {
                        crate::rich_preview::Preview::Pending(path.clone())
                    });
                }
                self.cards[index].primary = if kind.is_empty() {
                    "artifact".into()
                } else {
                    kind
                };
                self.cards[index].metadata = metadata.join(" · ");
                self.cards[index].open_url = data
                    .get("open_url")
                    .or_else(|| data.get("url"))
                    .and_then(Value::as_str)
                    .map(safe_text)
                    .filter(|value| value.starts_with("https://") || value.starts_with("http://"));
                if let Some(reference) = &event.payload_ref {
                    self.cards[index].payload_ref = Some(reference.clone());
                }
            }
            _ => {}
        }
        if data.get("cached_full_payload").and_then(Value::as_bool) == Some(true) {
            if let Some(reference) = event.payload_ref.as_deref() {
                for card in self
                    .cards
                    .iter_mut()
                    .filter(|c| c.payload_ref.as_deref() == Some(reference))
                {
                    if card.body.is_empty() {
                        card.body = text(data, "output")
                            .lines()
                            .take(3)
                            .collect::<Vec<_>>()
                            .join("\n");
                    }
                    card.detail = None;
                }
            }
        }
        Ok(())
    }

    pub fn transcript(&self) -> Vec<String> {
        self.cards
            .iter()
            .filter(|card| card.title != "Thinking")
            .flat_map(|card| {
                let card = card.materialized();
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

fn is_mcp_inventory(value: &str) -> bool {
    let mut words = value.split_whitespace();
    words.next() == Some("MCP:")
        && words.next().is_some_and(|n| n.parse::<u32>().is_ok())
        && words.next() == Some("tools")
        && words.next() == Some("from")
        && words.next().is_some_and(|n| n.parse::<u32>().is_ok())
        && words.next() == Some("servers")
        && words.next().is_none()
}

fn is_iteration_status(value: &str) -> bool {
    value
        .trim()
        .strip_prefix("Processing (iteration ")
        .and_then(|tail| {
            tail.strip_suffix(")...")
                .or_else(|| tail.strip_suffix(")…"))
        })
        .is_some_and(|number| !number.is_empty() && number.bytes().all(|ch| ch.is_ascii_digit()))
}

fn turn_recap(cards: &[Card], agent: &str, outcome: &str, cwd: &str) -> Option<String> {
    let mut files = std::collections::BTreeSet::new();
    let mut edits = 0;
    let mut tools = 0;
    let mut checks = 0;
    let mut unresolved = 0;
    for card in cards.iter().filter(|card| card.agent == agent) {
        if !card.tool_name.is_empty() {
            tools += 1;
            if matches!(card.status.as_str(), "failed" | "incomplete" | "cancelled") {
                unresolved += 1;
            }
        }
        if card.title == "Check" {
            checks += 1;
        }
        let single_file_edit = matches!(
            card.tool_name.as_str(),
            "create_file" | "write_file" | "edit_file" | "multi_edit" | "delete_file"
        );
        let edited = card.status == "done"
            && (single_file_edit
                || matches!(card.tool_name.as_str(), "apply_patch" | "write_project"));
        if edited {
            edits += 1;
        }
        if (card.title == "Diff" || (edited && single_file_edit))
            && !card.primary.is_empty()
            && card.primary != "see details"
        {
            files.insert(std::path::Path::new(cwd).join(&card.primary));
        }
    }
    if tools <= 5 && edits == 0 && files.is_empty() {
        return None;
    }
    let count = |n, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    let mut parts = vec![format!("Turn {outcome}")];
    if !files.is_empty() {
        parts.push(format!("{} changed", count(files.len(), "file")));
    } else if edits > 0 {
        parts.push(count(edits, "edit"));
    }
    if tools > 0 {
        parts.push(count(tools, "tool call"));
    }
    if checks > 0 {
        parts.push(count(checks, "check"));
    }
    if unresolved > 0 {
        parts.push(format!("{unresolved} unsuccessful"));
    }
    Some(parts.join(" · "))
}

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

fn artifact_format(mime: &str, path: &str, kind: &str) -> String {
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match (mime, extension.as_str()) {
        ("application/pdf", _) | (_, "pdf") => "PDF".into(),
        (_, "doc" | "docx" | "odt") => "Document".into(),
        (_, "ppt" | "pptx" | "odp") => "Slides".into(),
        (_, "xls" | "xlsx" | "ods" | "csv") => "Spreadsheet".into(),
        (mime, _) if mime.starts_with("image/") => mime.trim_start_matches("image/").to_uppercase(),
        ("", _) => kind.into(),
        _ => mime.into(),
    }
}

fn artifact_read_progress(data: &Value, total: Option<u64>) -> Option<String> {
    let raw = data.get("pages_read")?.as_array()?;
    let mut pages: Vec<_> = raw
        .iter()
        .take(4096)
        .filter_map(Value::as_u64)
        .filter(|page| *page > 0 && total.is_none_or(|total| *page <= total))
        .collect();
    pages.sort_unstable();
    pages.dedup();
    if pages.is_empty() {
        return raw.is_empty().then(|| "No pages read".into());
    }
    let mut ranges = Vec::new();
    let mut start = pages[0];
    let mut end = start;
    for page in pages
        .iter()
        .copied()
        .skip(1)
        .chain(std::iter::once(u64::MAX))
    {
        if end.checked_add(1) == Some(page) && page != u64::MAX {
            end = page;
            continue;
        }
        ranges.push(if start == end {
            start.to_string()
        } else {
            format!("{start}–{end}")
        });
        start = page;
        end = page;
    }
    let omitted = ranges.len().saturating_sub(12);
    let mut label = format!(
        "Read pages {}",
        ranges.into_iter().take(12).collect::<Vec<_>>().join(", ")
    );
    if omitted > 0 || raw.len() > 4096 {
        label.push_str(" … (partial list)");
    }
    if let Some(total) = total {
        label.push_str(&format!(" of {total}"));
    }
    Some(label)
}

fn format_artifact_size(bytes: u64) -> String {
    if bytes < 1_000 {
        format!("{bytes} B")
    } else if bytes < 1_000_000 {
        format!("{:.1} KB", bytes as f64 / 1_000.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    }
}

fn approval_arguments(tool: &str, args: &Value) -> String {
    fn describe(value: &Value) -> String {
        match value {
            Value::String(text) => safe_text(text),
            Value::Object(fields) => fields
                .iter()
                .map(|(key, value)| format!("{}: {}", safe_text(key), describe(value)))
                .collect::<Vec<_>>()
                .join("\n"),
            Value::Array(items) => items.iter().map(describe).collect::<Vec<_>>().join(", "),
            other => other.to_string(),
        }
    }
    if tool.eq_ignore_ascii_case("shell") {
        if let Some(cmd) = args.get("command").and_then(Value::as_str) {
            let mut lines = vec![safe_text(cmd)];
            if let Some(fields) = args.as_object() {
                lines.extend(
                    fields
                        .iter()
                        .filter(|(key, _)| *key != "command")
                        .map(|(key, value)| format!("{}: {}", safe_text(key), describe(value))),
                );
            }
            return lines.join("\n");
        }
    }
    if args.as_object().is_some_and(|fields| fields.is_empty()) {
        return "(no arguments)".into();
    }
    describe(args)
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
        "write_file" | "create_file" => Some(("content", "content")),
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
        .take(3)
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
        "write_file" | "create_file" => {
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
