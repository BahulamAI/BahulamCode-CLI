use bahulam_tui::{
    model::{safe_text, Model},
    protocol::{EventEnvelope, EVENT_TYPES},
    render::{draw, draw_with_input, mouse_panel_at, MousePanel},
    replay,
};
use ratatui::{
    backend::TestBackend,
    layout::{Position, Rect},
    Terminal,
};
use serde_json::json;
use std::{collections::HashSet, path::PathBuf};

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
fn resumed_history_keeps_every_message_across_chunks_and_scroll_positions() {
    let mut model = Model::default();
    let messages: Vec<_> = (0..80)
        .map(|index| {
            json!({"kind":"history", "role":if index % 2 == 0 { "user" } else { "assistant" },
                "content":format!("SAVED_MESSAGE_{index:03}")})
        })
        .collect();
    for (index, chunk) in messages.chunks(32).enumerate() {
        model
            .apply(&event(
                1,
                "transcript_snapshot",
                "main",
                json!({
                    "replace":index == 0, "mode":"full", "cwd":"/saved", "model":"fixture",
                    "items":chunk
                }),
            ))
            .unwrap();
    }
    let saved: Vec<_> = model
        .cards
        .iter()
        .enumerate()
        .filter(|(_, card)| card.title == "Prompt" || card.title == "Assistant")
        .collect();
    assert_eq!(
        saved.len(),
        80,
        "resume must retain more than a recent preview"
    );
    let before = model.transcript();
    // Exercise the same terminal through resize and every saved card position.
    let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
    for (width, height) in [(120, 36), (80, 24), (40, 24), (120, 36)] {
        terminal.backend_mut().resize(width, height);
        terminal.autoresize().unwrap();
        for (index, (card_index, card)) in saved.iter().enumerate() {
            let expected = format!("SAVED_MESSAGE_{index:03}");
            assert_eq!(card.body, expected);
            assert_eq!(card.detail.as_deref(), Some(expected.as_str()));
            terminal
                .draw(|frame| {
                    let g = bahulam_tui::render::history_geometry(
                        &model,
                        frame.area(),
                        "",
                        false,
                        &HashSet::new(),
                        "dark",
                        None,
                    );
                    let row = g
                        .cards
                        .iter()
                        .find(|(index, _)| index == card_index)
                        .unwrap()
                        .1;
                    draw(frame, &model, row);
                })
                .unwrap();
            let screen: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(
                screen.contains(&expected),
                "missing {expected} at {width}x{height}"
            );
        }
    }
    assert_eq!(
        model.transcript(),
        before,
        "redraw must not mutate saved history"
    );
}

#[test]
fn resume_replacement_preserves_full_reply_and_accepts_next_live_turn() {
    let mut model = Model::default();
    model
        .apply(&event(
            90,
            "message_end",
            "main",
            json!({"text":"STALE_SESSION"}),
        ))
        .unwrap();
    let full_reply = format!("{}\nSAVED_REPLY_END", "saved reply line\n".repeat(200));
    model
        .apply(&event(
            1,
            "transcript_snapshot",
            "main",
            json!({
                "replace":true, "mode":"full", "items":[
                    {"kind":"history", "role":"user", "content":"Saved question"},
                    {"kind":"history", "role":"assistant", "content":full_reply}
                ]
            }),
        ))
        .unwrap();
    assert!(!model.transcript().join("\n").contains("STALE_SESSION"));
    let saved_reply = model
        .cards
        .iter()
        .find(|card| card.title == "Assistant")
        .unwrap();
    assert_eq!(saved_reply.body, full_reply);
    assert_eq!(saved_reply.detail.as_deref(), Some(full_reply.as_str()));
    model
        .apply(&event(
            1,
            "text_delta",
            "main",
            json!({"chunk":"LIVE_REPLY"}),
        ))
        .unwrap();
    model
        .apply(&event(
            2,
            "message_end",
            "main",
            json!({"text":"LIVE_REPLY"}),
        ))
        .unwrap();
    let replies: Vec<_> = model
        .cards
        .iter()
        .filter(|card| card.title == "Assistant")
        .map(|card| card.body.as_str())
        .collect();
    assert_eq!(replies, vec![full_reply.as_str(), "LIVE_REPLY"]);
}

#[test]
fn resume_popup_keeps_selected_session_visible_and_restores_history_on_close() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "message_end",
            "main",
            json!({"text":"ACCEPTED_REPLY"}),
        ))
        .unwrap();
    let history = model.transcript();
    let options: Vec<_> = (0..30).map(|index| json!({
        "label":format!("S{index:02} · project · {}", "a very long saved instruction 界 ".repeat(12)),
        "value":format!("saved-{index}")
    })).collect();
    let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
    for (width, height) in [(120, 36), (80, 24), (40, 16), (120, 36)] {
        terminal.backend_mut().resize(width, height);
        terminal.autoresize().unwrap();
        model.interaction = None;
        terminal.draw(|frame| draw(frame, &model, 0)).unwrap();
        let before_popup = terminal.backend().buffer().clone();
        model
            .apply(&event(
                1,
                "interaction_requested",
                "main",
                json!({
                    "request_id":"resume-picker", "title":"Resume a session",
                    "message":"Choose a saved transcript.", "options":options
                }),
            ))
            .unwrap();
        for selected in [0, 15, 29] {
            model.interaction.as_mut().unwrap().selected = selected;
            terminal.draw(|frame| draw(frame, &model, 0)).unwrap();
            let screen: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(screen.contains("Resume a session"));
            assert!(
                screen.contains(&format!("› S{selected:02}")),
                "selected session {selected} hidden at {width}x{height}"
            );
            assert!(
                screen.contains("Esc cancel"),
                "popup controls hidden at {width}x{height}"
            );
        }
        model.interaction = None;
        terminal.draw(|frame| draw(frame, &model, 0)).unwrap();
        assert_eq!(
            terminal.backend().buffer(),
            &before_popup,
            "closing the popup must redraw the accepted transcript"
        );
        assert_eq!(model.transcript(), history);
    }
}

#[test]
fn mouse_targets_follow_layout_and_do_not_reach_behind_modals() {
    let mut model = Model::default();
    let area = Rect::new(0, 0, 100, 24);
    assert_eq!(
        mouse_panel_at(area, &model, "", Position::new(10, 3)),
        Some(MousePanel::Transcript)
    );
    assert_eq!(
        mouse_panel_at(area, &model, "", Position::new(90, 3)),
        Some(MousePanel::Agents)
    );
    for point in [
        Position::new(0, 3),
        Position::new(10, 1),
        Position::new(10, 14),
        Position::new(90, 20),
        Position::new(90, 23),
    ] {
        assert_eq!(mouse_panel_at(area, &model, "", point), None);
    }
    assert_eq!(
        mouse_panel_at(area, &model, "", Position::new(10, 10)),
        Some(MousePanel::Transcript)
    );
    assert_eq!(
        mouse_panel_at(area, &model, "a\nb\nc\nd\ne", Position::new(10, 10)),
        None
    );
    assert_eq!(
        mouse_panel_at(Rect::new(0, 0, 40, 24), &model, "", Position::new(35, 3)),
        Some(MousePanel::Transcript),
        "compact mode has no invisible sidebar"
    );
    assert_eq!(
        mouse_panel_at(Rect::new(0, 0, 1, 1), &model, "", Position::new(0, 0)),
        None
    );
    model
        .apply(&event(
            1,
            "interaction_requested",
            "main",
            json!({
                "request_id":"resume", "title":"Resume a session", "options":[]
            }),
        ))
        .unwrap();
    assert_eq!(mouse_panel_at(area, &model, "", Position::new(10, 3)), None);
    assert_eq!(mouse_panel_at(area, &model, "", Position::new(90, 3)), None);
    model.interaction = None;
    model
        .apply(&event(
            2,
            "approval_required",
            "main",
            json!({
                "apr_id":"approval", "name":"shell", "args":{"command":"fixture"}
            }),
        ))
        .unwrap();
    assert_eq!(mouse_panel_at(area, &model, "", Position::new(10, 3)), None);
    assert_eq!(mouse_panel_at(area, &model, "", Position::new(90, 3)), None);
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
fn assistant_replies_are_complete_and_scrollable_in_both_views() {
    use bahulam_tui::render::{draw_with_view, history_geometry};
    for inline in [true, false] {
        for kind in ["text_delta", "message_end"] {
            let mut model = Model::default();
            let body = (1..=200)
                .map(|n| format!("Reply line {n:03}"))
                .collect::<Vec<_>>()
                .join("\n");
            model
                .apply(&event(
                    1,
                    kind,
                    "main",
                    if kind == "text_delta" {
                        json!({"chunk":body})
                    } else {
                        json!({"text":body})
                    },
                ))
                .unwrap();
            let render = |offset| {
                let mut terminal = Terminal::new(TestBackend::new(100, 32)).unwrap();
                terminal
                    .draw(|frame| {
                        draw_with_view(
                            frame,
                            &model,
                            offset,
                            true,
                            "dark",
                            "draft",
                            0,
                            &HashSet::new(),
                            Some(0),
                            true,
                            None,
                            None,
                            0,
                            None,
                            0,
                            inline,
                        )
                    })
                    .unwrap();
                terminal
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>()
            };
            let first = render(0);
            assert!(first.contains("Reply line 001") && first.contains("Reply line 007"));
            assert!(!first.contains("Show details"));
            let geometry = history_geometry(
                &model,
                Rect::new(0, 0, 100, 32),
                "draft",
                inline,
                &HashSet::new(),
                "dark",
                None,
            );
            let all = (0..=geometry.end)
                .step_by(geometry.page as usize)
                .chain(std::iter::once(geometry.end))
                .map(render)
                .collect::<String>();
            for n in 1..=200 {
                assert!(
                    all.contains(&format!("Reply line {n:03}")),
                    "missing line {n} in inline={inline}"
                );
            }
            assert!(render(u16::MAX).contains("Reply line 200"));
        }
    }
}

#[test]
fn backend_approval_is_not_an_actionable_local_handle_and_details_hydrate_messages() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "approval_required",
            "main",
            json!({"tool":"bahulam_info","tool_id":"backend-call","args":{}}),
        ))
        .unwrap();
    assert!(model.approval.is_none());
    model.apply(&event(2, "approval_required", "main", json!({"apr_id":"local-id","tool":"bahulam_info","args":{},"risk_tier":"unknown","scopes":["once","type"]}))).unwrap();
    let approval = model.approval.as_ref().unwrap();
    assert_eq!(approval.tool, "bahulam_info");
    assert_eq!(approval.scopes, vec!["once", "type"]);
    let mut reply = event(3, "message_end", "main", json!({}));
    reply.payload_ref = Some("memory:reply".into());
    model.apply(&reply).unwrap();
    model
        .apply(&event(
            1,
            "detail_loaded",
            "main",
            json!({"payload_ref":"memory:reply","detail":"COMPLETE_SAVED_REPLY"}),
        ))
        .unwrap();
    assert!(model
        .cards
        .iter()
        .any(|card| card.title == "Assistant" && card.body == "COMPLETE_SAVED_REPLY"));
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
                "Agents",
                "Plan",
                "Agent report",
                "Read source",
                "120 in · 35 out",
            ] {
                assert!(
                    text.contains(expected),
                    "missing {expected} at {width}x{height}"
                );
            }
            // Sub-agent internals stay out of the main conversation; the
            // reviewer's own transcript is where its tool card appears.
            assert!(
                !text.contains("read_file"),
                "sub-agent tool leaked into the main view at {width}x{height}"
            );
            let mut filtered = Terminal::new(TestBackend::new(width, height)).unwrap();
            filtered
                .draw(|frame| {
                    draw_with_input(
                        frame,
                        &model,
                        u16::MAX,
                        false,
                        "dark",
                        "",
                        0,
                        &HashSet::new(),
                        None,
                        false,
                        Some("reviewer"),
                        None,
                        1,
                        None,
                        0,
                    )
                })
                .unwrap();
            let filtered_text = filtered
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert!(
                filtered_text.contains("read_file"),
                "missing read_file in the reviewer transcript at {width}x{height}"
            );
        }
    }
}

#[test]
fn tool_results_are_compact_and_status_color_does_not_tint_the_tool_name() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "tool_requested",
            "main",
            json!({"name":"Bash", "tool_id":"run-1", "args":{"command":"cargo test"}}),
        ))
        .unwrap();
    model
        .apply(&event(
            2,
            "tool_finished",
            "main",
            json!({
                "tool_id":"run-1",
                "ok":true,
                "preview":"preview line one\npreview line two\npreview line three\npreview line four",
                "output":"full result line one\nfull result line two\nfull result line three\nfull result line four\nfull result line five"
            }),
        ))
        .unwrap();

    let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
    terminal
        .draw(|frame| {
            draw_with_input(
                frame,
                &model,
                u16::MAX,
                false,
                "dark",
                "",
                0,
                &HashSet::new(),
                Some(0),
                false,
                None,
                None,
                0,
                None,
                0,
            )
        })
        .unwrap();
    let buffer = terminal.backend().buffer();
    let all_text = buffer
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(all_text.contains("Bash"));
    assert!(all_text.contains("preview line one"));
    assert!(all_text.contains("preview line two"));
    assert!(!all_text.contains("preview line three"));
    assert!(!all_text.contains("full result line one"));
    assert!(all_text.contains("Show details"));

    let width = buffer.area.width as usize;
    let tool_row = buffer
        .content
        .chunks(width)
        .find(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("Bash")
        })
        .unwrap();
    let row_text = tool_row
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    let tool_name = row_text.find("Bash").unwrap();
    let done_status = row_text.find("done").unwrap();
    if std::env::var_os("NO_COLOR").is_some() {
        assert_eq!(
            tool_row[tool_name].style().fg,
            Some(ratatui::style::Color::Reset)
        );
        assert_eq!(
            tool_row[done_status].style().fg,
            Some(ratatui::style::Color::Reset)
        );
    } else {
        assert_eq!(
            tool_row[tool_name].style().fg,
            Some(ratatui::style::Color::Rgb(215, 222, 232))
        );
        assert_eq!(
            tool_row[done_status].style().fg,
            Some(ratatui::style::Color::Rgb(114, 184, 148))
        );
    }
}

#[test]
fn input_panel_is_distinct_and_footer_has_separate_status_and_hints() {
    let mut model = Model::default();
    model.status = "Ready".into();
    model.input_tokens = 100;
    let mut terminal = Terminal::new(TestBackend::new(100, 24)).unwrap();
    terminal
        .draw(|frame| {
            draw_with_input(
                frame,
                &model,
                u16::MAX,
                true,
                "dark",
                "draft",
                5,
                &HashSet::new(),
                None,
                true,
                None,
                None,
                0,
                None,
                0,
            )
        })
        .unwrap();

    let buffer = terminal.backend().buffer();
    let all_text = buffer
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(all_text.contains("Message"));
    assert!(all_text.contains("Ready"));
    assert!(all_text.contains("100 in · 0 out"));
    assert!(all_text.contains("Enter send · Ctrl+J new line"));

    let width = buffer.area.width as usize;
    let input_row = buffer
        .content
        .chunks(width)
        .find(|row| {
            row.iter()
                .map(|cell| cell.symbol())
                .collect::<String>()
                .contains("draft")
        })
        .unwrap();
    let row_text = input_row
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    let draft_column = row_text.find("draft").unwrap();
    let expected_background = if std::env::var_os("NO_COLOR").is_some() {
        ratatui::style::Color::Reset
    } else {
        ratatui::style::Color::Rgb(28, 38, 51)
    };
    assert_eq!(
        input_row[draft_column].style().bg,
        Some(expected_background)
    );
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

#[test]
fn historical_controls_cannot_activate_or_resolve_live_approval() {
    let mut model = Model::default();
    model
        .apply(&event(
            10,
            "approval_required",
            "main",
            json!({"apr_id":"live", "reason":"live approval"}),
        ))
        .unwrap();
    model
        .apply(&event(
            11,
            "interaction_requested",
            "main",
            json!({"request_id":"live-picker", "title":"Live picker", "options":[]}),
        ))
        .unwrap();
    let historical = vec![
        json!({"kind":"event", "event":{"type":"approval_required", "data":{"apr_id":"live", "reason":"saved approval"}}}),
        json!({"kind":"event", "event":{"type":"approval_decided", "data":{"apr_id":"live", "decision":"allow"}}}),
        json!({"kind":"event", "event":{"type":"interaction_requested", "data":{"request_id":"stale", "title":"Stale picker"}}}),
        json!({"kind":"event", "event":{"type":"command_catalog", "data":{"commands":[{"name":"evil"}]}}}),
        json!({"kind":"event", "event":{"type":"session_state", "data":{"cwd":"stale"}}}),
        json!({"kind":"event", "event":{"type":"transcript_snapshot", "data":{"items":[]}}}),
    ];
    model
        .apply(&event(
            0,
            "transcript_snapshot",
            "main",
            json!({"replace":false,"cwd":"/live", "mode":"full", "items":historical}),
        ))
        .unwrap();
    assert_eq!(model.approval.as_ref().unwrap().reason, "live approval");
    assert_eq!(
        model.interaction.as_ref().unwrap().request_id,
        "live-picker"
    );
    assert!(model.command_catalog.is_empty());
    assert_eq!(model.cwd, "/live");
    assert_eq!(model.last_seq, 10);
    let saved = model
        .cards
        .iter()
        .find(|card| card.body == "saved approval")
        .unwrap();
    assert_eq!(saved.status, "historical");
    assert!(saved.metadata.contains("inactive"));
    model
        .apply(&event(
            12,
            "approval_decided",
            "main",
            json!({"apr_id":"live", "decision":"deny"}),
        ))
        .unwrap();
    assert!(model.approval.is_none());
    // Loading the same history alone must never create an actionable approval.
    let mut replay = Model::default();
    replay
        .apply(&event(
            0,
            "transcript_snapshot",
            "main",
            json!({"items":historical}),
        ))
        .unwrap();
    assert!(replay.approval.is_none());
    assert!(replay.interaction.is_none());
}

#[test]
fn progress_thinking_checks_and_cancelled_tools_keep_full_details() {
    let mut model = Model::default();
    for seq in 1..=100 {
        model.apply(&event(seq, "notice", "main", json!({"title":"status", "cause":format!("progress {seq}"), "level":"info", "progress_key":"status"}))).unwrap();
    }
    assert_eq!(model.cards.len(), 1);
    assert_eq!(model.cards[0].body, "progress 100");
    for seq in 101..=110 {
        model
            .apply(&event(
                seq,
                "thinking_delta",
                "main",
                json!({"chunk":format!("thinking {seq}\n")}),
            ))
            .unwrap();
    }
    assert_eq!(model.cards.len(), 2);
    assert!(model.cards[1].body.contains("thinking 101"));
    assert!(model.cards[1].body.contains("thinking 110"));
    model.apply(&event(111, "test_result", "main", json!({"name":"cargo test", "ok":false, "summary":"1 failed", "output":"full diagnostic"}))).unwrap();
    assert_eq!(model.cards[2].status, "failed");
    assert!(model.cards[2]
        .detail
        .as_ref()
        .unwrap()
        .contains("full diagnostic"));
    model
        .apply(&event(
            112,
            "tool_requested",
            "main",
            json!({"tool_id":"pending", "name":"shell", "args":{}}),
        ))
        .unwrap();
    model
        .apply(&event(
            113,
            "tool_started",
            "main",
            json!({"tool_id":"pending"}),
        ))
        .unwrap();
    model
        .apply(&event(
            114,
            "turn_ended",
            "main",
            json!({"ok":false, "outcome":"cancelled"}),
        ))
        .unwrap();
    assert_eq!(model.status, "cancelled");
    assert_eq!(model.cards[3].status, "cancelled");
    assert_eq!(model.cards[1].status, "cancelled");
    assert!(model.agents[0].current_tool.is_empty());
}

#[test]
fn snapshot_chunks_do_not_duplicate_header_or_merge_live_tool_ids() {
    let mut model = Model::default();
    for replace in [true, false] {
        model.apply(&event(0, "transcript_snapshot", "main", json!({"replace":replace, "mode":"full", "items":[
            {"kind":"event", "event":{"type":"tool_request", "turn_id":"t1", "data":{"call_id":"same", "tool":"shell", "args":{}}}}
        ]}))).unwrap();
    }
    assert_eq!(
        model
            .cards
            .iter()
            .filter(|card| card.title == "Session")
            .count(),
        1
    );
    model
        .apply(&event(
            1,
            "tool_requested",
            "main",
            json!({"tool_id":"same", "name":"shell", "args":{}}),
        ))
        .unwrap();
    model
        .apply(&event(
            2,
            "tool_finished",
            "main",
            json!({"tool_id":"same", "ok":true, "output":"live result"}),
        ))
        .unwrap();
    let tools: Vec<_> = model
        .cards
        .iter()
        .filter(|card| card.title == "shell")
        .collect();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0].status, "requested");
    assert_eq!(tools[1].status, "done");
}

#[test]
fn resume_command_keeps_full_history_but_not_saved_spinner_frames() {
    let mut model = Model::default();
    model.apply(&event(1, "command_result", "main", json!({"name":"/resume", "result":"truncated", "output":"resuming █░ 8%\nreading transcript ██░ 14%\nResumed saved session\nactual history"}))).unwrap();
    assert_eq!(model.cards[0].body, "Resumed saved session\nactual history");
    assert_eq!(
        model.cards[0].detail.as_deref(),
        Some("Resumed saved session\nactual history")
    );
}

#[test]
fn checks_and_thinking_render_and_expand_in_both_rust_views() {
    use bahulam_tui::render::draw_with_view;
    for inline in [true, false] {
        for (kind, data, expected) in [
            (
                "diff",
                json!({"path":"fixture.rs", "hunks":[{"text":"+ CODE_EDIT_VISIBLE"}]}),
                "CODE_EDIT_VISIBLE",
            ),
            (
                "tool_finished",
                json!({"tool_id":"tool", "summary":"TOOL_RESULT_VISIBLE", "output":"TOOL_RESULT_VISIBLE", "ok":true}),
                "TOOL_RESULT_VISIBLE",
            ),
            (
                "test_result",
                json!({"suite":"verification", "passed":2, "failed":1}),
                "verification",
            ),
            (
                "thinking_delta",
                json!({"chunk":"THINKING_FIRST\n".repeat(8) + "THINKING_LAST"}),
                "THINKING_FIRST",
            ),
            (
                "notice",
                json!({"title":"phase update", "cause":"VERIFY_PHASE", "level":"info", "progress_key":"phase"}),
                "VERIFY_PHASE",
            ),
        ] {
            let mut model = Model::default();
            model.apply(&event(1, kind, "main", data)).unwrap();
            for details in [false, true] {
                let mut terminal =
                    Terminal::new(TestBackend::new(110, if inline { 16 } else { 36 })).unwrap();
                terminal
                    .draw(|frame| {
                        draw_with_view(
                            frame,
                            &model,
                            0,
                            true,
                            "dark",
                            "draft",
                            5,
                            &HashSet::new(),
                            Some(0),
                            true,
                            None,
                            None,
                            0,
                            if details { Some(0) } else { None },
                            0,
                            inline,
                        )
                    })
                    .unwrap();
                let text = terminal
                    .backend()
                    .buffer()
                    .content
                    .iter()
                    .map(|cell| cell.symbol())
                    .collect::<String>();
                assert!(
                    text.contains(expected),
                    "missing {expected}, inline={inline}, details={details}"
                );
                if !details {
                    assert!(text.contains("draft"));
                }
            }
        }
    }
}
