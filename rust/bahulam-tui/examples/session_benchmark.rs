//! Reproducible synthetic rendering benchmark; no models, network or user sessions.
use bahulam_tui::{
    model::Model,
    protocol::EventEnvelope,
    render::{draw_with_view, history_geometry},
};
use ratatui::{backend::TestBackend, layout::Rect, Terminal};
use serde_json::json;
use std::{collections::HashSet, time::Instant};

fn apply(model: &mut Model, seq: &mut i64, kind: &str, data: serde_json::Value) {
    *seq += 1;
    let event: EventEnvelope = serde_json::from_value(json!({
        "v":2,"seq":seq,"ts":"2026-11-18T00:00:00Z","type":kind,
        "session_id":"benchmark","turn_id":"benchmark-turn","agent_id":"main",
        "id":format!("benchmark:{seq}"),"data":data
    }))
    .unwrap();
    model.apply(&event).unwrap();
}
fn main() {
    let count = std::env::args()
        .nth(1)
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1000)
        .clamp(1, 100_000);
    let mut model = Model::default();
    let mut seq = 0;
    let started = Instant::now();
    for n in 0..count {
        let id = format!("tool-{n}");
        apply(
            &mut model,
            &mut seq,
            "tool_requested",
            json!({"tool_id":id,"name":"read_file","args":{"path":format!("src/file-{n}.rs")}}),
        );
        apply(
            &mut model,
            &mut seq,
            "tool_finished",
            json!({"tool_id":id,"ok":true,"output":"recorded result\n".repeat(20)}),
        );
        if n % 5 == 0 {
            apply(
                &mut model,
                &mut seq,
                "message_end",
                json!({"text":format!("## Result {n}\nFull assistant reply with **emphasis**, `code` and [link](https://example.com).\n{}", "Details of the inspected source.\n".repeat(20))}),
            );
        }
    }
    let load_ms = started.elapsed().as_secs_f64() * 1000.0;
    let retained_text_bytes: usize = model
        .cards
        .iter()
        .map(|c| c.body.len() + c.detail.as_ref().map_or(0, String::len))
        .sum();
    let archived_cards = model.cards.iter().filter(|c| c.archived.is_some()).count();
    let expanded = HashSet::new();
    let mut views = Vec::new();
    for inline in [true, false] {
        let start = Instant::now();
        let geometry = history_geometry(
            &model,
            Rect::new(0, 0, 120, 40),
            "draft",
            inline,
            &expanded,
            "dark",
            None,
        );
        let cold_geometry_ms = start.elapsed().as_secs_f64() * 1000.0;
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        let mut timings = Vec::new();
        for i in 0..100 {
            let start = Instant::now();
            // Mix tail-follow, oldest-history and middle-history navigation.
            let offset = match i % 3 {
                0 => usize::MAX,
                1 => 0,
                _ => geometry.end / 2,
            };
            terminal
                .draw(|frame| {
                    draw_with_view(
                        frame, &model, offset, true, "dark", "draft", 5, &expanded, None, true,
                        None, None, 0, None, 0, inline,
                    )
                })
                .unwrap();
            timings.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        timings.sort_by(f64::total_cmp);
        views.push(json!({"view":if inline {"inline"}else{"fullscreen"},"rows":geometry.total_rows,"cold_geometry_ms":cold_geometry_ms,"frame_p50_ms":timings[50],"frame_p95_ms":timings[95],"frame_max_ms":timings[99]}));
    }
    println!(
        "{}",
        json!({"tools":count,"events":seq,"cards":model.cards.len(),"load_ms":load_ms,"retained_text_bytes":retained_text_bytes,"archived_cards":archived_cards,"views":views,"os":std::env::consts::OS,"arch":std::env::consts::ARCH})
    );
}
