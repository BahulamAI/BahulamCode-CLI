use bahulam_tui::{
    model::{safe_text, Model},
    protocol::{EventEnvelope, EVENT_TYPES},
    render::draw,
    replay,
};
use ratatui::{backend::TestBackend, Terminal};
use serde_json::json;
use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/protocol")
        .join(name)
}
fn event(seq: i64, kind: &str, agent: &str, data: serde_json::Value) -> EventEnvelope {
    serde_json::from_value(json!({"v":2,"seq":seq,"ts":"2026-11-14T00:00:00Z","type":kind,"session_id":"sess_test","turn_id":"t1","agent_id":agent,"id":format!("sess_test:{seq}"),"data":data})).unwrap()
}

#[test]
fn v2_reconstructs_messages_tools_agents_plan_and_usage() {
    let model = replay(&fixture("replay-v2.jsonl")).unwrap();
    assert_eq!(model.last_seq, 14);
    assert_eq!(
        model
            .agents
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>(),
        vec!["main", "reviewer"]
    );
    assert_eq!(model.agents[1].status, "done");
    let tools: Vec<_> = model
        .cards
        .iter()
        .filter(|c| c.title == "read_file")
        .collect();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].status, "done");
    assert_eq!(tools[0].body, "Read app.js");
    assert_eq!(
        model
            .cards
            .iter()
            .filter(|c| c.title == "Assistant")
            .count(),
        1
    );
    assert!(model
        .transcript()
        .join("\n")
        .contains("I will inspect the project."));
    assert_eq!(model.plan.len(), 2);
    assert_eq!(model.input_tokens, 120);
    assert_eq!(model.output_tokens, 35);
}

#[test]
fn legacy_logs_and_future_events() {
    let mut model = replay(&fixture("replay-v1.jsonl")).unwrap();
    assert_eq!(model.input_tokens, 12);
    assert!(model.transcript().join("\n").contains("legacy result"));
    let before = model.cards.len();
    let mut unknown = event(6, "future_type", "main", json!({}));
    unknown.session_id = "sess_legacy".into();
    model.apply(&unknown).unwrap();
    assert_eq!(model.cards.len(), before);
    assert_eq!(model.last_seq, 6);
}

#[test]
fn parallel_agents_do_not_overwrite_each_others_tools() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "tool_requested",
            "a",
            json!({"name":"read", "tool_id":"same"}),
        ))
        .unwrap();
    model
        .apply(&event(
            2,
            "tool_requested",
            "b",
            json!({"name":"read", "tool_id":"same"}),
        ))
        .unwrap();
    model
        .apply(&event(
            3,
            "tool_finished",
            "a",
            json!({"tool_id":"same", "ok":false,"summary":"failure"}),
        ))
        .unwrap();
    assert_eq!(model.cards[0].status, "failed");
    assert_eq!(model.cards[1].status, "requested");
    // Duplicate/resumed events must not produce duplicate cards.
    model
        .apply(&event(
            2,
            "tool_requested",
            "b",
            json!({"name":"read", "tool_id":"same"}),
        ))
        .unwrap();
    assert_eq!(model.cards.len(), 2);
}

#[test]
fn cell_buffers_reflow_at_narrow_wide_and_tiny_sizes() {
    let model = replay(&fixture("replay-v2.jsonl")).unwrap();
    for (width, height) in [(120, 36), (80, 24), (40, 16), (1, 1)] {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, &model, 0)).unwrap();
        if width >= 80 {
            let text = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            for expected in [
                "Bahulam",
                "Agents",
                "Plan",
                "read_file",
                "Read source",
                "120 in / 35 out",
            ] {
                assert!(
                    text.contains(expected),
                    "missing {expected} at {width}x{height}"
                );
            }
        }
    }
}

#[test]
fn golden_envelopes_deserialize_and_controls_are_inert() {
    let text = std::fs::read_to_string(fixture("events-v2.jsonl")).unwrap();
    let events: Vec<EventEnvelope> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), EVENT_TYPES.len());
    for event in events {
        assert!(EVENT_TYPES.contains(&event.r#type.as_str()));
    }
    assert_eq!(
        safe_text("ok\x1b]52;c;secret\x07\x1b[2J\x1b[31mred\x1b[0m\n界"),
        "okred\n界"
    );
    assert_eq!(safe_text("a\u{9d}0;title\u{9c}b"), "ab");
}

#[test]
fn generated_binary_prints_plain_replay_without_a_model() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_bahulam-tui"))
        .args([
            "--replay",
            fixture("replay-v2.jsonl").to_str().unwrap(),
            "--plain",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(!output.stdout.contains(&0x1b));
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("Inspection complete"));
}

#[test]
fn payload_paths_future_events_and_torn_tail() {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("bahulam-replay-{}-{nonce}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(dir.clone());
    let log = dir.join("events.jsonl");
    let mut referenced = serde_json::to_value(event(1, "message_end", "main", json!({}))).unwrap();
    referenced["payload_ref"] = json!("payload.json");
    std::fs::write(
        dir.join("payload.json"),
        r#"{"text":"Restored payload","final_text_hash":"example"}"#,
    )
    .unwrap();
    let mut unknown = serde_json::to_value(event(2, "future_event", "main", json!({}))).unwrap();
    unknown["payload_ref"] = json!("does-not-exist.json");
    std::fs::write(&log, format!("{referenced}\n{unknown}\n{{\"v\":")).unwrap();
    let model = replay(&log).unwrap();
    assert!(model.transcript().join("\n").contains("Restored payload"));
    assert_eq!(model.warnings.len(), 1);
    assert_eq!(model.last_seq, 2);
    referenced["payload_ref"] = json!("../outside.json");
    std::fs::write(&log, format!("{referenced}\n")).unwrap();
    assert!(replay(&log)
        .unwrap_err()
        .to_string()
        .contains("Unsafe payload path"));
    referenced.as_object_mut().unwrap().remove("turn_id");
    std::fs::write(&log, format!("{referenced}\n")).unwrap();
    assert!(replay(&log).unwrap_err().to_string().contains("turn_id"));
}
