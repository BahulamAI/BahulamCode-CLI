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
        Position::new(90, 23),
    ] {
        assert_eq!(mouse_panel_at(area, &model, "", point), None);
    }
    assert_eq!(
        mouse_panel_at(area, &model, "", Position::new(90, 20)),
        Some(MousePanel::Composer)
    );
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
    assert_eq!(
        mouse_panel_at(area, &model, "", Position::new(90, 20)),
        None
    );
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
            for expected in ["Agents", "Plan", "Read source", "120 in · 35 out"] {
                assert!(
                    text.contains(expected),
                    "missing {expected} at {width}x{height}"
                );
            }
            let mut tail = Terminal::new(TestBackend::new(width, height)).unwrap();
            tail.draw(|frame| draw(frame, &model, u16::MAX)).unwrap();
            let tail_text = tail
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            assert!(
                tail_text.contains("Agent report"),
                "agent report must remain reachable by scrolling"
            );
            // Sub-agent internals stay out of the main conversation; the
            // reviewer's own transcript is where its tool card appears.
            assert!(
                !text.contains("Read app.js"),
                "sub-agent tool result leaked into the main view at {width}x{height}"
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
fn tool_results_restore_compact_previews_and_grey_details_actions() {
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

    if std::env::var_os("NO_COLOR").is_none() {
        let action = buffer
            .content
            .chunks(buffer.area.width as usize)
            .find(|row| {
                row.iter()
                    .map(|c| c.symbol())
                    .collect::<String>()
                    .contains("Show details")
            })
            .unwrap();
        let cell = action.iter().position(|c| c.symbol() == "S").unwrap();
        assert_eq!(action[cell].fg, ratatui::style::Color::Rgb(206, 214, 224));
        assert!(!action[cell]
            .modifier
            .contains(ratatui::style::Modifier::BOLD));
    }
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
    assert!(
        !row_text.contains("done"),
        "success checkmark should not have a redundant done badge"
    );
    let done_status = tool_row
        .iter()
        .position(|cell| cell.symbol() == "✓")
        .unwrap();
    assert_eq!(
        tool_row[done_status].bg,
        ratatui::style::Color::Reset,
        "success glyph must not have a box"
    );
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
            Some(ratatui::style::Color::Rgb(148, 175, 255))
        );
        assert_eq!(
            tool_row[done_status].style().fg,
            Some(ratatui::style::Color::Rgb(112, 255, 173))
        );
    }
}

#[test]
fn input_panel_is_distinct_and_footer_has_separate_status_and_hints() {
    let mut model = Model::default();
    model.status = "Ready".into();
    model.input_tokens = 100;
    model.usage_known = true;
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
    assert!(all_text.contains("Enter send · Drag to copy"));

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
fn usage_state_is_absolute_and_historical_or_agent_usage_cannot_replace_it() {
    let mut model = Model::default();
    let usage = event(
        1,
        "session_state",
        "main",
        json!({"usage":{
            "input_tokens":1234,"output_tokens":56,"cost_usd":0.2345,
            "context_used_pct":23.4,"context_estimated":true,"cost_estimated":true
        }}),
    );
    model.apply(&usage).unwrap();
    model.apply(&usage).unwrap();
    assert_eq!(model.input_tokens, 1234);
    assert_eq!(model.output_tokens, 56);
    assert_eq!(model.cost, 0.2345);
    assert!(
        model.usage_known && model.context_known && model.cost_known && model.context_estimated
    );
    model
        .apply(&event(
            2,
            "usage_update",
            "child",
            json!({"input_tokens":9}),
        ))
        .unwrap();
    assert_eq!(model.input_tokens, 1234);
    model
        .apply(&event(
            1,
            "transcript_snapshot",
            "main",
            json!({"replace":true,"items":[
                {"kind":"event","event":{"type":"usage_update","data":{"input_tokens":999999}}}
            ]}),
        ))
        .unwrap();
    assert!(!model.usage_known);
    model.apply(&usage).unwrap();
    assert_eq!(model.input_tokens, 1234);
    let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
    terminal.draw(|frame| draw(frame, &model, 0)).unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(text.contains("1.2K in · 56 out · ctx ~23.4% · ~$0.2345"));
}

#[test]
fn details_click_targets_the_painted_card_after_scroll_resize_and_approval() {
    use bahulam_tui::render::{details_at, draw_with_view};
    let mut model = Model::default();
    for i in 0..20 {
        model
            .apply(&event(
                i + 1,
                "tool_finished",
                "main",
                json!({
                    "tool_id": format!("tool-{i}"), "output": "result\n".repeat(20)
                }),
            ))
            .unwrap();
    }
    let expanded = HashSet::new();
    for approval in [false, true] {
        if approval {
            model.apply(&event(21, "approval_required", "main", json!({
                "apr_id":"a", "name":"shell", "args":{"command":"inspect"}, "reason":"review"
            }))).unwrap();
        }
        for inline in [true, false] {
            for (width, height) in [(120, 36), (60, 28)] {
                for scroll in [0, u16::MAX] {
                    let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                    terminal
                        .draw(|frame| {
                            draw_with_view(
                                frame, &model, scroll, true, "dark", "draft", 5, &expanded, None,
                                true, None, None, 0, None, 0, inline,
                            )
                        })
                        .unwrap();
                    let buffer = terminal.backend().buffer();
                    let mut hits = 0;
                    for (y, row) in buffer.content.chunks(width as usize).enumerate() {
                        // Cells, rather than UTF-8 byte offsets, determine mouse coordinates.
                        let symbols: Vec<_> = row.iter().map(|cell| cell.symbol()).collect();
                        for x in 0..symbols.len().saturating_sub(12) {
                            if symbols[x..x + 12].concat() != "Show details" {
                                continue;
                            }
                            let hit = details_at(
                                &model,
                                buffer.area,
                                "draft",
                                inline,
                                &expanded,
                                "dark",
                                None,
                                scroll,
                                Position::new(x as u16 + 1, y as u16),
                            );
                            let card = &model.cards[hit.expect("painted action must be clickable")];
                            assert!(!card.is_message());
                            hits += 1;
                        }
                    }
                    assert!(hits > 0, "fixture must expose a details action: approval={approval} inline={inline} width={width} height={height} scroll={scroll}");
                    assert!(details_at(
                        &model,
                        buffer.area,
                        "draft",
                        inline,
                        &expanded,
                        "dark",
                        None,
                        scroll,
                        Position::new(0, height - 1)
                    )
                    .is_none());
                }
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
fn thinking_phases_follow_tools_and_replace_iteration_status_without_losing_reasoning() {
    let mut model = Model::default();
    let steps = [
        (
            "thinking_delta",
            "main",
            json!({"chunk":"Processing (iteration 1)..."}),
        ),
        (
            "thinking_delta",
            "main",
            json!({"chunk":"Processing (iteration 2)..."}),
        ),
        (
            "tool_requested",
            "main",
            json!({"tool_id":"read", "name":"read_file"}),
        ),
        (
            "tool_finished",
            "main",
            json!({"tool_id":"read", "ok":true}),
        ),
        (
            "thinking_delta",
            "main",
            json!({"chunk":"Processing (iteration 3)..."}),
        ),
        (
            "tool_finished",
            "worker",
            json!({"tool_id":"other", "name":"shell", "ok":true}),
        ),
        (
            "thinking_delta",
            "main",
            json!({"chunk":"Processing (iteration 4)..."}),
        ),
        (
            "thinking_delta",
            "main",
            json!({"chunk":"Actual reasoning "}),
        ),
        ("thinking_delta", "main", json!({"chunk":"continues."})),
        ("message_end", "main", json!({"text":"Final answer"})),
    ];
    for (index, (kind, agent, data)) in steps.into_iter().enumerate() {
        model
            .apply(&event(index as i64 + 1, kind, agent, data))
            .unwrap();
    }
    let main: Vec<_> = model
        .cards
        .iter()
        .filter(|card| card.agent == "main")
        .collect();
    assert_eq!(
        main.iter()
            .map(|card| card.title.as_str())
            .collect::<Vec<_>>(),
        ["Thinking", "read_file", "Thinking", "Thinking", "Assistant"]
    );
    assert_eq!(main[0].body, "Processing (iteration 2)...");
    assert_eq!(main[2].body, "Processing (iteration 4)...");
    assert_eq!(main[3].body, "Actual reasoning continues.");
    assert!(main.iter().all(|card| card.status == "done"));
    for inline in [true, false] {
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        terminal
            .draw(|frame| {
                bahulam_tui::render::draw_with_view(
                    frame,
                    &model,
                    0,
                    true,
                    "dark",
                    "",
                    0,
                    &HashSet::new(),
                    None,
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
        let text = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>();
        assert!(text.find("iteration 2").unwrap() < text.find("read_file").unwrap());
        assert!(text.find("read_file").unwrap() < text.find("iteration 4").unwrap());
        assert!(text.find("iteration 4").unwrap() < text.find("Final answer").unwrap());
    }
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
            "thinking_delta",
            "main",
            json!({"chunk":"Processing (iteration 9)..."}),
        ))
        .unwrap();
    model
        .apply(&event(
            115,
            "turn_ended",
            "main",
            json!({"ok":false, "outcome":"cancelled"}),
        ))
        .unwrap();
    assert_eq!(model.status, "cancelled");
    assert_eq!(model.cards[3].status, "cancelled");
    assert_eq!(model.cards[1].status, "done"); // earlier phase finished before the check
    assert_eq!(model.cards[4].status, "cancelled"); // only the active phase is cancelled
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

#[test]
fn composer_cursor_matches_painted_graphemes_spaces_and_wrap_after_resize() {
    use bahulam_tui::render::draw_with_view;
    let model = Model::default();
    // Put a visible marker at the caret, including after preserved indentation,
    // tabs, multi-cell characters and long lines that wrap in a narrow terminal.
    let large = "line 界\n".repeat(1000);
    for prefix in [
        "",
        "    ",
        "hello ",
        "a\tb ",
        "界👩‍💻é ",
        "first\n    ",
        "a very long line with spaces that must wrap many times in a narrow composer ",
        large.as_str(),
    ] {
        let input = format!("{prefix}X");
        for inline in [true, false] {
            let mut terminal = Terminal::new(TestBackend::new(100, 36)).unwrap();
            for width in [100, 28, 60] {
                terminal.backend_mut().resize(width, 36);
                terminal.autoresize().unwrap();
                terminal
                    .draw(|frame| {
                        draw_with_view(
                            frame,
                            &model,
                            0,
                            true,
                            "dark",
                            &input,
                            prefix.len(),
                            &HashSet::new(),
                            None,
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
                let cursor = terminal.get_cursor_position().unwrap();
                assert_eq!(terminal.backend().buffer()[cursor].symbol(), "X",
                    "caret must cover next typed character: {prefix:?}, inline={inline}, width={width}, cursor={cursor:?}");
                let buffer = terminal.backend().buffer();
                let text: String = buffer.content.iter().map(|cell| cell.symbol()).collect();
                assert!(text.contains("Message"));
            }
        }
    }
}

#[test]
fn expanded_tool_json_is_readable_and_keeps_neighbor_messages_and_raw_copy() {
    use bahulam_tui::render::{details_at, draw_with_view};
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "message_end",
            "main",
            json!({"text":"BEFORE_TOOL"}),
        ))
        .unwrap();
    model
        .apply(&event(
            2,
            "tool_requested",
            "main",
            json!({"tool_id":"tool", "name":"shell", "args":{"command":"inspect"}}),
        ))
        .unwrap();
    model
        .apply(&event(
            3,
            "tool_finished",
            "main",
            json!({"tool_id":"tool", "name":"shell", "result":"preview", "ok":true}),
        ))
        .unwrap();
    model
        .apply(&event(
            4,
            "message_end",
            "main",
            json!({"text":"AFTER_TOOL"}),
        ))
        .unwrap();
    let index = model.cards.iter().position(|c| c.title == "shell").unwrap();
    let raw =
        json!({"exit_code":0, "stdout":"FIRST_LINE\nFINAL_LINE", "files":["one.rs","two.rs"]})
            .to_string();
    model.cards[index].detail = Some(raw.clone());
    for inline in [true, false] {
        for expanded in [HashSet::from([index]), HashSet::new()] {
            let mut terminal = Terminal::new(TestBackend::new(120, 44)).unwrap();
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
                        &expanded,
                        Some(index),
                        false,
                        None,
                        None,
                        0,
                        None,
                        1,
                        inline,
                    )
                })
                .unwrap();
            let buffer = terminal.backend().buffer();
            let text = buffer
                .content
                .chunks(120)
                .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                text.contains("BEFORE_TOOL")
                    && text.contains("AFTER_TOOL")
                    && text.contains("draft")
            );
            if expanded.contains(&index) {
                assert!(
                    text.contains("FIRST_LINE")
                        && text.contains("FINAL_LINE")
                        && text.contains("two.rs")
                );
                assert!(!text.contains("\\n") && !text.contains("Details ·"));
                for (y, row) in buffer.content.chunks(120).enumerate() {
                    let cells: Vec<_> = row.iter().map(|cell| cell.symbol()).collect();
                    if let Some(x) = cells
                        .windows(9)
                        .position(|slice| slice.concat() == "Show less")
                    {
                        assert_eq!(
                            details_at(
                                &model,
                                buffer.area,
                                "draft",
                                inline,
                                &expanded,
                                "dark",
                                None,
                                0,
                                Position::new(x as u16, y as u16)
                            ),
                            Some(index)
                        );
                    }
                }
                assert!(text.contains("Show less") && text.contains("Esc to collapse"));
            } else {
                assert!(text.contains("Show details") && !text.contains("FINAL_LINE"));
            }
            assert_eq!(
                model.cards[index].detail.as_deref(),
                Some(raw.as_str()),
                "presentation must not rewrite stored/copyable tool data"
            );
        }
    }
}

#[test]
fn interleaved_reply_segments_keep_event_order_live_and_on_resume() {
    use bahulam_tui::render::draw_with_view;
    for cumulative in [false, true] {
        for streamed_final in [false, true] {
            for stored_final in [false, true] {
                let final_text = if cumulative {
                    "BEFORE_TOOLBETWEEN_TOOLSFINAL_ANSWER"
                } else {
                    "FINAL_ANSWER"
                };
                let mut events = vec![
                    event(1, "text_delta", "main", json!({"chunk":"BEFORE_TOOL"})),
                    event(
                        2,
                        "tool_requested",
                        "main",
                        json!({"tool_id":"a", "name":"shell", "args":{"command":"inspect"}}),
                    ),
                    event(
                        3,
                        "tool_finished",
                        "main",
                        json!({"tool_id":"a", "ok":true, "summary":"TOOL_ONE"}),
                    ),
                    event(4, "text_delta", "main", json!({"chunk":"BETWEEN_TOOLS"})),
                    event(
                        5,
                        "tool_requested",
                        "main",
                        json!({"tool_id":"b", "name":"read_file", "args":{"path":"file"}}),
                    ),
                    event(
                        6,
                        "tool_finished",
                        "main",
                        json!({"tool_id":"b", "ok":true, "summary":"TOOL_TWO"}),
                    ),
                ];
                if streamed_final {
                    events.push(event(7, "text_delta", "main", json!({"chunk":"FINAL_"})));
                }
                let mut final_event = event(
                    8,
                    "message_end",
                    "main",
                    if stored_final {
                        json!({})
                    } else {
                        json!({"text":final_text})
                    },
                );
                if stored_final {
                    final_event.payload_ref = Some("memory:final".into());
                }
                events.push(final_event);
                events.push(event(9, "turn_ended", "main", json!({"ok":true})));
                for resume in [false, true] {
                    let mut model = Model::default();
                    if resume {
                        let items: Vec<_> = events
                            .iter()
                            .map(|event| json!({"kind":"event", "event":event}))
                            .collect();
                        model
                            .apply(&event(
                                1,
                                "transcript_snapshot",
                                "main",
                                json!({"replace":true,"mode":"full","items":items}),
                            ))
                            .unwrap();
                    } else {
                        for item in &events {
                            model.apply(item).unwrap();
                        }
                    }
                    if stored_final {
                        model
                            .apply(&event(
                                10,
                                "detail_loaded",
                                "main",
                                json!({"payload_ref":"memory:final","detail":final_text}),
                            ))
                            .unwrap();
                    }
                    // A late tool completion updates its original card, never moves below the final.
                    if !resume {
                        model
                            .apply(&event(
                                11,
                                "tool_finished",
                                "main",
                                json!({"tool_id":"b","ok":true,"summary":"TOOL_TWO"}),
                            ))
                            .unwrap();
                    }
                    let content: Vec<_> = model
                        .cards
                        .iter()
                        .filter(|card| !matches!(card.title.as_str(), "Session" | "Turn"))
                        .map(|card| (card.title.as_str(), card.body.as_str()))
                        .collect();
                    assert_eq!(content, vec![("Assistant","BEFORE_TOOL"),("shell","TOOL_ONE"),("Assistant","BETWEEN_TOOLS"),("read_file","TOOL_TWO"),("Assistant","FINAL_ANSWER")],
                        "cumulative={cumulative}, streamed={streamed_final}, stored={stored_final}, resume={resume}");
                    assert!(model
                        .cards
                        .iter()
                        .filter(|card| card.title == "Assistant")
                        .all(|card| card.status == "done"));
                    for inline in [true, false] {
                        let mut terminal = Terminal::new(TestBackend::new(120, 44)).unwrap();
                        terminal
                            .draw(|frame| {
                                draw_with_view(
                                    frame,
                                    &model,
                                    0,
                                    true,
                                    "dark",
                                    "",
                                    0,
                                    &HashSet::new(),
                                    None,
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
                        let screen: String = terminal
                            .backend()
                            .buffer()
                            .content
                            .iter()
                            .map(|cell| cell.symbol())
                            .collect();
                        let positions: Vec<_> = [
                            "BEFORE_TOOL",
                            "TOOL_ONE",
                            "BETWEEN_TOOLS",
                            "TOOL_TWO",
                            "FINAL_ANSWER",
                        ]
                        .iter()
                        .map(|text| screen.find(text).expect(text))
                        .collect();
                        assert!(positions.windows(2).all(|p| p[0] < p[1]));
                        assert_eq!(screen.matches("FINAL_ANSWER").count(), 1);
                    }
                }
            }
        }
    }
}

#[test]
fn concurrent_agents_do_not_close_each_others_message_segments() {
    let mut model = Model::default();
    for item in [
        event(1, "text_delta", "main", json!({"chunk":"MAIN "})),
        event(2, "text_delta", "worker", json!({"chunk":"WORKER_NOTE"})),
        event(
            3,
            "tool_requested",
            "worker",
            json!({"tool_id":"x","name":"shell","args":{}}),
        ),
        event(4, "text_delta", "main", json!({"chunk":"ANSWER"})),
        event(5, "message_end", "worker", json!({"text":"WORKER_FINAL"})),
        event(6, "message_end", "main", json!({"text":"MAIN ANSWER"})),
    ] {
        model.apply(&item).unwrap();
    }
    let main: Vec<_> = model.cards.iter().filter(|c| c.agent == "main").collect();
    assert_eq!(main.len(), 1);
    assert_eq!(main[0].body, "MAIN ANSWER");
    let worker: Vec<_> = model
        .cards
        .iter()
        .filter(|c| c.agent == "worker")
        .map(|c| c.body.as_str())
        .collect();
    assert_eq!(worker, vec!["WORKER_NOTE", "{}", "WORKER_FINAL"]);
}

#[test]
fn resumed_tool_status_matches_live_for_null_errors_and_real_failures() {
    let cases = [
        (json!({"success":true,"error":null}), "done"),
        (json!({"success":true,"error":false}), "done"),
        (json!({"success":true,"error":""}), "done"),
        (
            json!({"success":true,"is_error":false,"exit_code":0}),
            "done",
        ),
        (json!({"success":true,"exit_code":"0"}), "done"),
        (json!({"success":false,"error":null}), "failed"),
        (json!({"ok":false}), "failed"),
        (
            json!({"success":true,"error":"permission denied"}),
            "failed",
        ),
        (
            json!({"success":true,"error":{"message":"denied"}}),
            "failed",
        ),
        (json!({"is_error":true}), "failed"),
        (json!({"success":true,"exit_code":1}), "failed"),
        (json!({"success":true,"exit_code":"2"}), "failed"),
    ];
    for (flags, expected) in cases {
        for resume in [false, true] {
            let mut model = Model::default();
            let mut result = flags.clone();
            result["tool_id"] = json!("tool");
            result["call_id"] = json!("tool");
            result["output"] = json!("saved output");
            let requested = event(
                1,
                "tool_requested",
                "main",
                json!({"tool_id":"tool","name":"read_file","args":{"path":"file"}}),
            );
            if resume {
                // Real logs contain tool_result followed by tool_done with error:null.
                model.apply(&event(1,"transcript_snapshot","main",json!({"replace":true,"mode":"full","items":[
                    {"kind":"event","event":requested},
                    {"kind":"event","event":{"type":"tool_result","data":result,"turn_id":"t1","agent_id":"main"}},
                    {"kind":"event","event":{"type":"tool_done","data":result,"turn_id":"t1","agent_id":"main"}}
                ]}))).unwrap();
            } else {
                model.apply(&requested).unwrap();
                model
                    .apply(&event(2, "tool_finished", "main", result))
                    .unwrap();
            }
            let tools: Vec<_> = model
                .cards
                .iter()
                .filter(|card| card.title == "read_file")
                .collect();
            assert_eq!(tools.len(), 1);
            assert_eq!(tools[0].status, expected, "resume={resume}, flags={flags}");
            assert_eq!(tools[0].detail.as_deref(), Some("saved output"));
        }
    }
}

#[test]
fn job_state_and_tool_timers_are_live_only_and_stop_with_the_turn() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "session_state",
            "main",
            json!({"active_background_jobs":2}),
        ))
        .unwrap();
    assert_eq!(model.active_background_jobs, 2);
    let request = event(
        1,
        "tool_requested",
        "main",
        json!({"tool_id":"shell-1", "name":"shell", "args":{"command":"sleep 5"}}),
    );
    let start = event(2, "tool_started", "main", json!({"tool_id":"shell-1"}));
    model.apply(&event(1,"transcript_snapshot","main",json!({"replace":true,"items":[{"kind":"event","event":request},{"kind":"event","event":start}]}))).unwrap();
    assert!(model
        .cards
        .iter()
        .all(|card| card.started_at.is_none() && card.tool_id.is_empty()));
    model.apply(&request).unwrap();
    model.apply(&start).unwrap();
    let running = model.cards.last().unwrap();
    assert!(running.started_at.is_some());
    assert_eq!(running.tool_id, "shell-1");
    model
        .apply(&event(3, "turn_ended", "main", json!({"ok":false})))
        .unwrap();
    assert!(model
        .cards
        .iter()
        .all(|card| card.started_at.is_none() && card.tool_id.is_empty()));
}

#[test]
fn queued_followups_do_not_reorder_history_or_acknowledge_historical_turns() {
    let mut model = Model::default();
    model
        .apply(&event(1, "turn_started", "main", json!({"text":"first"})))
        .unwrap();
    model.queue_prompt("next");
    model.queue_prompt("next");
    model.queue_prompt("/help");
    assert_eq!(model.pending_prompt_count(), 2);
    assert!(!model.cards.iter().any(|card| card.body == "next"));
    model
        .apply(&event(
            2,
            "message_end",
            "main",
            json!({"text":"first final"}),
        ))
        .unwrap();
    model
        .apply(&event(3, "turn_started", "worker", json!({"text":"next"})))
        .unwrap();
    assert_eq!(model.pending_prompt_count(), 2);
    model
        .apply(&event(
            4,
            "turn_started",
            "main",
            json!({"text":"next (host-normalized)"}),
        ))
        .unwrap();
    assert_eq!(model.pending_prompt_count(), 1);
    let final_pos = model
        .cards
        .iter()
        .position(|card| card.body == "first final")
        .unwrap();
    let prompt_pos = model
        .cards
        .iter()
        .position(|card| card.body == "next (host-normalized)")
        .unwrap();
    assert!(final_pos < prompt_pos);
    model.apply(&event(0, "transcript_snapshot", "main", json!({"replace":true,"mode":"full","items":[
        {"kind":"event","event":{"type":"turn_started","turn_id":"old","data":{"text":"next"}}}
    ]}))).unwrap();
    assert_eq!(model.pending_prompt_count(), 1);
    model
        .apply(&event(5, "turn_started", "main", json!({"text":"next"})))
        .unwrap();
    assert_eq!(model.pending_prompt_count(), 0);
    model.queue_prompt("not in another session");
    let mut replacement = event(
        0,
        "transcript_snapshot",
        "main",
        json!({"replace":true,"mode":"full","items":[]}),
    );
    replacement.session_id = "another-session".into();
    model.apply(&replacement).unwrap();
    assert_eq!(model.pending_prompt_count(), 0);
}

#[test]
fn running_tool_preview_is_bounded_but_final_output_is_complete() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "tool_requested",
            "main",
            json!({"tool_id":"tail","name":"shell","args":{}}),
        ))
        .unwrap();
    let output = (0..500)
        .map(|n| format!("line {n} 界\n"))
        .collect::<String>();
    model
        .apply(&event(
            2,
            "tool_output_delta",
            "main",
            json!({"tool_id":"tail","chunk":output}),
        ))
        .unwrap();
    let preview = &model.cards.last().unwrap().body;
    assert!(preview.starts_with("[earlier tool output omitted]"));
    assert!(preview.lines().count() <= 21);
    assert!(preview.ends_with("line 499 界\n"));
    model
        .apply(&event(
            3,
            "tool_output_delta",
            "main",
            json!({"tool_id":"tail","chunk":"界".repeat(10000)}),
        ))
        .unwrap();
    let preview = &model.cards.last().unwrap().body;
    assert!(preview.len() <= 12 * 1024 + 40);
    assert!(preview.ends_with('界'));
    model
        .apply(&event(
            4,
            "tool_finished",
            "main",
            json!({"tool_id":"tail","ok":true,"output":output}),
        ))
        .unwrap();
    assert_eq!(
        model.cards.last().unwrap().detail.as_deref(),
        Some(output.as_str())
    );
    assert_eq!(model.cards.last().unwrap().status, "done");
}

#[test]
fn artifacts_show_metadata_and_open_valid_urls_without_claiming_image_rendering() {
    let mut model = Model::default();
    model.apply(&event(1,"artifact_created","main",json!({"title":"Report","kind":"document","mime":"application/pdf","pages":2,"bytes":2500,"path":"reports/output.pdf","open_url":"https://example.test/report"}))).unwrap();
    let card = model.cards.last().unwrap();
    assert_eq!(card.title, "Report");
    assert_eq!(card.status, "done");
    assert_eq!(card.metadata, "application/pdf · 2 pages · 2.5 KB");
    assert_eq!(card.body, "reports/output.pdf");
    assert_eq!(
        card.open_url.as_deref(),
        Some("https://example.test/report")
    );
    model
        .apply(&event(
            2,
            "artifact_created",
            "main",
            json!({"url":"javascript:bad()"}),
        ))
        .unwrap();
    assert!(model.cards.last().unwrap().open_url.is_none());
    assert_eq!(model.cards.last().unwrap().title, "Artifact");
}

#[test]
fn session_state_retains_model_mode_and_route_for_display() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "session_state",
            "main",
            json!({"model":"provider/model","model_mode":"thinking","model_route":"byok"}),
        ))
        .unwrap();
    assert_eq!(model.model_mode, "thinking");
    assert_eq!(model.model_route, "byok");
    let mut terminal = Terminal::new(TestBackend::new(120, 30)).unwrap();
    terminal.draw(|frame| draw(frame, &model, 0)).unwrap();
    let text = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(text.contains("thinking · BYOK"));
}

#[test]
fn browser_targets_match_painted_rows_after_wrap_scroll_resize_and_replacement() {
    use bahulam_tui::render::{browser_link_at, draw_with_view, painted_browser_links};
    let mut model = Model::default();
    for n in 1..=15 {
        model.apply(&event(n,"message_end","main",json!({"text":format!("Card {n}\n[Docs 界](https://example.test/{n}) and https://other.test/{n}?x=1&y=2\n{}\n", "prose ".repeat(40))}))).unwrap();
    }
    let before = model.transcript();
    for inline in [true, false] {
        for (width, height) in [(120, 36), (60, 24), (40, 20)] {
            for scroll in [0, 12, u16::MAX] {
                let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
                terminal
                    .draw(|f| {
                        draw_with_view(
                            f,
                            &model,
                            scroll,
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
                            inline,
                        )
                    })
                    .unwrap();
                let hits = painted_browser_links();
                let visible = terminal
                    .backend()
                    .buffer()
                    .content
                    .chunks(width as usize)
                    .filter(|row| {
                        row.iter()
                            .map(|cell| cell.symbol())
                            .collect::<String>()
                            .contains("↗ Open ")
                    })
                    .count();
                assert_eq!(
                    hits.iter()
                        .filter(|hit| hit.text.starts_with("↗ Open "))
                        .count(),
                    visible,
                    "{inline} {width} {scroll}"
                );
                if scroll == 0 {
                    assert!(
                        hits.iter().any(|hit| hit.text.starts_with("Docs 界")),
                        "inline Markdown label must be clickable"
                    );
                }
                if scroll == u16::MAX {
                    assert!(!hits.is_empty());
                }
                for hit in hits {
                    let buffer = terminal.backend().buffer();
                    let mut x = hit.area.x;
                    for grapheme in unicode_segmentation::UnicodeSegmentation::graphemes(
                        hit.text.as_str(),
                        true,
                    ) {
                        assert_eq!(buffer[(x, hit.area.y)].symbol(), grapheme);
                        x += unicode_width::UnicodeWidthStr::width(grapheme) as u16;
                    }
                    assert_eq!(x, hit.area.right());
                    assert_eq!(
                        browser_link_at(Position::new(hit.area.x, hit.area.y)),
                        Some(hit.clone())
                    );
                    assert!(browser_link_at(Position::new(hit.area.right(), hit.area.y)).is_none());
                    assert!(
                        hit.target.uri.starts_with("https://example.test/")
                            || hit.target.uri.starts_with("https://other.test/")
                    );
                }
            }
        }
    }
    assert_eq!(
        model.transcript(),
        before,
        "presentation must not rewrite messages or copied text"
    );
    model
        .apply(&event(
            0,
            "transcript_snapshot",
            "main",
            json!({"replace":true,"mode":"full","items":[]}),
        ))
        .unwrap();
    let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
    terminal.draw(|f| draw(f, &model, 0)).unwrap();
    assert!(painted_browser_links().is_empty());
}

#[test]
fn browser_actions_respect_tool_folding_and_modal_ownership() {
    use bahulam_tui::render::{draw_with_view, painted_browser_links};
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "tool_finished",
            "main",
            json!({"tool_id":"fixture","output":"one\ntwo\nhttps://example.test/full-details"}),
        ))
        .unwrap();
    let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
    let mut expanded = HashSet::new();
    terminal
        .draw(|f| {
            draw_with_view(
                f, &model, 0, true, "dark", "draft", 5, &expanded, None, true, None, None, 0, None,
                0, true,
            )
        })
        .unwrap();
    assert!(painted_browser_links().is_empty());
    expanded.insert(0);
    terminal
        .draw(|f| {
            draw_with_view(
                f, &model, 0, true, "dark", "draft", 5, &expanded, None, true, None, None, 0, None,
                0, true,
            )
        })
        .unwrap();
    assert_eq!(painted_browser_links().len(), 2); // visible URL and its Open action
    model
        .apply(&event(
            2,
            "approval_required",
            "main",
            json!({"apr_id":"a","name":"shell","args":{},"reason":"review"}),
        ))
        .unwrap();
    terminal
        .draw(|f| {
            draw_with_view(
                f, &model, 0, true, "dark", "draft", 5, &expanded, None, true, None, None, 0, None,
                0, true,
            )
        })
        .unwrap();
    assert!(painted_browser_links().is_empty());
    model.approval = None;
    model.interaction = Some(bahulam_tui::browser_links::picker(
        bahulam_tui::browser_links::extract("https://example.test/"),
    ));
    terminal
        .draw(|f| {
            draw_with_view(
                f, &model, 0, true, "dark", "draft", 5, &expanded, None, true, None, None, 0, None,
                0, true,
            )
        })
        .unwrap();
    assert!(painted_browser_links().is_empty());
}

#[test]
fn tools_restore_details_for_separate_results_and_commands_never_fold() {
    use bahulam_tui::render::draw_with_view;
    for inline in [true, false] {
        for (kind, data, visible, hidden, folds) in [
            (
                "tool_finished",
                json!({"tool_id":"short","preview":"FIRST\nSECOND","output":"FIRST\nSECOND"}),
                "SECOND",
                "THIRD",
                false,
            ),
            (
                "tool_finished",
                json!({"tool_id":"long","preview":"FIRST\nSECOND","output":"FIRST\nSECOND\nTHIRD"}),
                "SECOND",
                "THIRD",
                true,
            ),
            (
                "tool_finished",
                json!({"tool_id":"failed","ok":false,"preview":"FIRST\nSECOND","output":"FIRST\nSECOND\nTHIRD"}),
                "SECOND",
                "THIRD",
                true,
            ),
            (
                "diff",
                json!({"path":"src/main.rs","hunks":[{"text":"--- a/main.rs\n+++ b/main.rs\n@@ -1 +1,2 @@\n-old\n+new\n+THIRD"}]}),
                "src/main.rs",
                "+THIRD",
                true,
            ),
            (
                "diff",
                json!({"path":"src/main.rs","hunks":[{"text":"@@ -1 +1,3 @@\n-old\n+new\n+THIRD\n+FOURTH"}]}),
                "-old",
                "+FOURTH",
                true,
            ),
            (
                "command_result",
                json!({"name":"/status","result":"short preview","output":"FIRST\nSECOND\nTHIRD\nFOURTH\nSTATUS_FINAL"}),
                "STATUS_FINAL",
                "short preview",
                false,
            ),
            (
                "tool_finished",
                json!({"tool_id":"wrapped","preview":"summary only","output":{"stdout":"FIRST\nSECOND","exit_code":0,"success":true}}),
                "summary only",
                "SECOND",
                true,
            ),
        ] {
            let mut model = Model::default();
            model.apply(&event(1, kind, "main", data)).unwrap();
            let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
            terminal
                .draw(|f| {
                    draw_with_view(
                        f,
                        &model,
                        0,
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
                        inline,
                    )
                })
                .unwrap();
            let text: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(text.contains(visible), "{kind}, inline={inline}: {text}");
            assert!(!text.contains(hidden), "{kind}, inline={inline}: {text}");
            assert_eq!(text.contains("Show details"), folds, "{kind}: {text}");
        }
    }
}

#[test]
fn completed_tool_payload_replaces_arguments_before_hydration() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "tool_requested",
            "main",
            json!({"tool_id":"read","name":"read_file","args":{"path":"demo.rs"}}),
        ))
        .unwrap();
    let mut completed = event(
        2,
        "tool_finished",
        "main",
        json!({"tool_id":"read","preview":"short"}),
    );
    completed.payload_ref = Some("memory:result".into());
    model.apply(&completed).unwrap();
    assert!(
        model.cards[0].detail.is_none(),
        "request arguments must not masquerade as a loaded result"
    );
    assert_eq!(model.request_details(0).as_deref(), Some("memory:result"));
    model
        .apply(&event(
            3,
            "detail_loaded",
            "main",
            json!({"payload_ref":"memory:result","detail":"actual result"}),
        ))
        .unwrap();
    assert_eq!(model.cards[0].detail.as_deref(), Some("actual result"));
}

#[test]
fn resumed_legacy_results_keep_previews_details_and_success_checkmark() {
    use bahulam_tui::render::draw_with_view;
    for inline in [true, false] {
        for result in [
            json!("FIRST\nSECOND\nTHIRD\nLAST"),
            json!({"stdout":"FIRST\nSECOND\nTHIRD\nLAST","exit_code":0}),
        ] {
            for output_key in ["result", "output"] {
                let mut data = json!({"call_id":"saved-read","success":true});
                data[output_key] = result.clone();
                let snapshot = event(
                    1,
                    "transcript_snapshot",
                    "main",
                    json!({
                        "replace":true,"mode":"full","items":[
                            {"kind":"event","event":{"type":"tool_call","data":{
                                "call_id":"saved-read","tool":"read_file","args":{"path":"saved.rs"}}}},
                            {"kind":"event","event":{"type":"tool_done","data":data}}
                        ]
                    }),
                );
                let mut model = Model::default();
                // Repeated resume must reconstruct the same result and controls.
                for _ in 0..2 {
                    model.apply(&snapshot).unwrap();
                    let index = model
                        .cards
                        .iter()
                        .position(|card| card.title == "read_file")
                        .unwrap();
                    assert!(model.cards[index].tool_id.is_empty());
                    assert!(model.cards[index].started_at.is_none());
                    assert_eq!(model.cards[index].status, "done");
                    assert!(model.cards[index]
                        .detail
                        .as_deref()
                        .unwrap()
                        .contains("LAST"));
                    for expanded in [HashSet::new(), HashSet::from([index])] {
                        let mut terminal = Terminal::new(TestBackend::new(120, 36)).unwrap();
                        terminal
                            .draw(|f| {
                                draw_with_view(
                                    f,
                                    &model,
                                    0,
                                    true,
                                    "dark",
                                    "draft",
                                    5,
                                    &expanded,
                                    Some(index),
                                    true,
                                    None,
                                    None,
                                    0,
                                    None,
                                    1,
                                    inline,
                                )
                            })
                            .unwrap();
                        let text: String = terminal
                            .backend()
                            .buffer()
                            .content
                            .iter()
                            .map(|c| c.symbol())
                            .collect();
                        assert!(!text.contains("done"), "{text}");
                        if expanded.is_empty() {
                            assert!(
                                text.contains("Show details") && !text.contains("LAST"),
                                "{text}"
                            );
                        } else {
                            assert!(
                                text.contains("FIRST")
                                    && text.contains("LAST")
                                    && text.contains("Show less"),
                                "{text}"
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn five_workers_preserve_identity_usage_reports_and_replay_isolation() {
    let mut model = Model::default();
    let mut events = Vec::new();
    let mut push = |kind: &str, agent: &str, data: serde_json::Value| {
        let mut e = event(events.len() as i64 + 1, kind, agent, data);
        if agent != "main" {
            e.parent_agent_id = Some(
                if agent == "worker5" {
                    "worker2"
                } else {
                    "main"
                }
                .into(),
            );
        }
        model.apply(&e).unwrap();
        events.push(e);
    };
    push(
        "turn_started",
        "main",
        json!({"text":"Coordinate five workers"}),
    );
    for n in 1..=5 {
        let id = format!("worker{n}");
        push(
            "agent_spawned",
            &id,
            json!({"type":id,"task":format!("Task {n}")}),
        );
        push(
            "tool_requested",
            &id,
            json!({"tool_id":"shared","name":"read_file","args":{"path":"app.rs"}}),
        );
        push("tool_started", &id, json!({"tool_id":"shared"}));
        push(
            "agent_status",
            &id,
            json!({"status":"working","tokens":{"total":n*1200},"cost_usd":0.01,"elapsed_ms":2000}),
        );
        push("agent_status", &id, json!({"status":"working"}));
    }
    push(
        "tool_requested",
        "worker1",
        json!({"tool_id":"second","name":"grep"}),
    );
    push(
        "tool_finished",
        "worker1",
        json!({"tool_id":"shared","ok":true,"output":"first result"}),
    );
    push(
        "approval_required",
        "worker3",
        json!({"apr_id":"apr-worker3","name":"shell","command":"npm test","scopes":["once","deny"]}),
    );
    assert_eq!(
        model.agents[1].current_tool, "grep",
        "older result must not clear the newer call"
    );
    assert_eq!(model.agents[2].current_tool, "read_file");
    assert_eq!(model.agents[2].tokens, Some(2400));
    assert_eq!(model.agents[2].cost, Some(0.01));
    assert_eq!(model.agents[2].task, "Task 2");
    assert!(model.agents[2].elapsed().unwrap() >= 2000.0);
    assert_eq!(model.approval.as_ref().unwrap().agent, "worker3");
    assert_eq!(model.approval.as_ref().unwrap().id, "apr-worker3");
    let ids: Vec<_> = model.agents.iter().map(|a| a.id.clone()).collect();
    for n in [4, 2, 5, 1, 3] {
        let id = format!("worker{n}");
        let e = event(
            events.len() as i64 + 1,
            "agent_finished",
            &id,
            json!({"ok":n!=4,"report":format!("Full report {n}\n{}END-{n}", "Report line\n".repeat(30)),
                "error":if n==4 {"permission denied"} else {""},"tokens":{"total":n*2000},"elapsed_ms":4500}),
        );
        model.apply(&e).unwrap();
        events.push(e);
    }
    assert_eq!(
        ids,
        model
            .agents
            .iter()
            .map(|a| a.id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(model.agents[4].status, "failed");
    assert!(model
        .cards
        .iter()
        .filter(|c| c.agent != "main")
        .all(|c| c.started_at.is_none()));
    assert!(model
        .cards
        .iter()
        .filter(|c| !c.tool_name.is_empty())
        .all(|c| c.status != "running" && c.status != "requested"));
    let report = model
        .cards
        .iter()
        .find(|c| c.title == "Agent report" && c.primary == "worker4")
        .unwrap();
    assert!(
        report.body.contains("permission denied") && report.body.contains("Last tool: read_file")
    );
    assert!(report.body.contains("END-4"));
    assert!(
        report.belongs_to("main") && report.belongs_to("worker4") && !report.belongs_to("worker3")
    );
    assert!(!report.is_foldable());
    assert!(model
        .agents
        .iter()
        .skip(1)
        .all(|a| !a.active() && a.started_at.is_none()));
    // The same historical pending approval is informational only, and clocks stay frozen.
    let mut resumed = Model::default();
    resumed
        .apply(&event(
            1,
            "transcript_snapshot",
            "main",
            json!({"replace":true,"mode":"full",
        "items":events.iter().map(|e| json!({"kind":"event","event":e})).collect::<Vec<_>>() }),
        ))
        .unwrap();
    assert!(resumed.approval.is_none());
    assert_eq!(
        resumed
            .agents
            .iter()
            .map(|a| a.id.clone())
            .collect::<Vec<_>>(),
        ids
    );
    assert!(resumed
        .agents
        .iter()
        .all(|a| a.historical && a.started_at.is_none() && !a.active()));
    assert_eq!(resumed.agents[2].tokens, Some(4000));
    assert_eq!(resumed.agents[5].parent.as_deref(), Some("worker2"));
    assert_eq!(
        resumed
            .cards
            .iter()
            .filter(|c| c.title == "Agent report")
            .count(),
        5
    );
    assert_eq!(
        resumed
            .cards
            .iter()
            .filter(|c| c.title == "Agent report")
            .map(|c| &c.body)
            .collect::<Vec<_>>(),
        model
            .cards
            .iter()
            .filter(|c| c.title == "Agent report")
            .map(|c| &c.body)
            .collect::<Vec<_>>()
    );
}

#[test]
fn agent_report_preview_hydrates_and_duplicate_completion_updates_one_card() {
    let mut model = Model::default();
    let mut e = event(
        1,
        "agent_finished",
        "worker",
        json!({"ok":true,"report":"preview"}),
    );
    e.payload_ref = Some("reports/full.json".into());
    model.apply(&e).unwrap();
    assert_eq!(
        model.request_details(0).as_deref(),
        Some("reports/full.json")
    );
    model
        .apply(&event(
            2,
            "detail_loaded",
            "main",
            json!({"payload_ref":"reports/full.json","detail":"Full report\nFinal line"}),
        ))
        .unwrap();
    assert_eq!(model.cards[0].body, "Full report\nFinal line");
    model
        .apply(&event(
            3,
            "agent_finished",
            "worker",
            json!({"ok":true,"report":"Full report\nFinal line"}),
        ))
        .unwrap();
    assert_eq!(model.cards.len(), 1);
}

#[test]
fn worker_rows_are_clickable_in_both_views_and_resize_without_misattribution() {
    use bahulam_tui::render::{agent_at, draw_with_view, mouse_panel_at_view};
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "turn_started",
            "main",
            json!({"text":"Main question"}),
        ))
        .unwrap();
    for n in 1..=5 {
        model
            .apply(&event(
                n + 1,
                "agent_spawned",
                &format!("worker{n}"),
                json!({"type":format!("worker{n}"),"task":format!("Task {n}")}),
            ))
            .unwrap();
    }
    for inline in [true, false] {
        for (width, height) in [(120, 40), (60, 24)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
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
                        Some(5),
                        2,
                        None,
                        0,
                        inline,
                    )
                })
                .unwrap();
            let mut ids = HashSet::new();
            for y in 0..height {
                for x in 0..width {
                    let position = Position::new(x, y);
                    if let Some(hit) = agent_at(position) {
                        assert_eq!(model.agents[hit.index].id, hit.id);
                        assert_eq!(
                            mouse_panel_at_view(
                                Rect::new(0, 0, width, height),
                                &model,
                                "draft",
                                position,
                                inline
                            ),
                            Some(MousePanel::Agents)
                        );
                        ids.insert(hit.id);
                    }
                }
            }
            assert!(ids.contains("worker5"));
            if width == 120 {
                assert_eq!(ids.len(), 6);
            }
        }
    }
}

#[test]
fn agent_usage_from_bounded_metadata_and_per_agent_totals_survives_status_only_updates() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "agent_spawned",
            "worker",
            json!({"type":"review","task":"Review"}),
        ))
        .unwrap();
    model.apply(&event(2,"usage_update","main",json!({"input_tokens":100,"output_tokens":20,"per_agent":{"worker":{"input_tokens":2000,"output_tokens":500,"cost_usd":0.02}}}))).unwrap();
    let worker = model.agents.iter().find(|a| a.id == "worker").unwrap();
    assert_eq!(worker.tokens, Some(2500));
    assert_eq!(worker.cost, Some(0.02));
    assert_eq!(model.input_tokens, 100);
    model
        .apply(&event(
            3,
            "agent_status",
            "worker",
            json!({"status":"working"}),
        ))
        .unwrap();
    assert_eq!(model.agents[0].tokens, Some(2500));
    model
        .apply(&event(
            4,
            "agent_finished",
            "worker",
            json!({"ok":true,"total_tokens":16000,"cost_usd":0.15,"elapsed_ms":4200}),
        ))
        .unwrap();
    assert_eq!(model.agents[0].tokens, Some(16000));
    assert_eq!(model.agents[0].elapsed(), Some(4200.0));
    assert_eq!(
        model.input_tokens, 100,
        "worker totals must not replace session accounting"
    );
}

#[test]
fn metadata_only_worker_tool_progress_updates_the_row_without_control_handles() {
    let mut model = Model::default();
    model
        .apply(&event(
            1,
            "agent_spawned",
            "worker",
            json!({"type":"review","task":"Check code"}),
        ))
        .unwrap();
    model.apply(&event(2,"notice","worker",json!({"current_tool":"grep","tool_active":true,"progress_key":"agent-tool","cause":"grep"}))).unwrap();
    assert_eq!(model.agents[0].current_tool, "grep");
    assert!(model.cards.iter().all(|c| c.tool_id.is_empty()));
    model.apply(&event(3,"notice","worker",json!({"current_tool":"grep","tool_active":false,"progress_key":"agent-tool","cause":"Found results"}))).unwrap();
    assert!(model.agents[0].current_tool.is_empty());
    assert_eq!(model.agents[0].last_tool, "grep");
}
