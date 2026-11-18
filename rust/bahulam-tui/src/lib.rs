pub mod browser_links;
pub mod capabilities;
pub mod capability_probe;
pub mod clipboard;
pub mod composer;
pub mod copy_menu;
pub mod integrations;
pub mod model;
pub mod open_target;
pub mod paste;
#[rustfmt::skip]
pub mod protocol;
pub mod render;
pub mod text_selection;

use model::Model;
use protocol::EventEnvelope;
use std::{
    fs::File,
    io::{self, BufRead, BufReader},
    path::Path,
};

/// Replay exactly one session. Payload paths are local to that session directory.
pub fn replay(path: &Path) -> Result<Model, Box<dyn std::error::Error>> {
    let mut model = Model::default();
    let root = path.parent().unwrap_or(Path::new(".")).canonicalize()?;
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = String::new();
    let mut number = 0;
    loop {
        line.clear();
        // Bound even a malformed v1 record before allocating an unbounded line.
        let count = std::io::Read::take(&mut reader, 16 * 1024 * 1024).read_line(&mut line)?;
        if count == 0 {
            break;
        }
        number += 1;
        if count >= 16 * 1024 * 1024 {
            return Err(format!("Record {number} exceeds 16 MiB").into());
        }
        if line.trim().is_empty() {
            continue;
        }
        let raw: serde_json::Value = match serde_json::from_str(&line) {
            Ok(event) => event,
            Err(_) if !line.ends_with('\n') => {
                model
                    .warnings
                    .push(format!("Skipped torn final record {number}"));
                break;
            }
            Err(error) => return Err(format!("Invalid record {number}: {error}").into()),
        };
        // Ignore future schemas before trying to deserialize their envelopes.
        if !matches!(
            raw.get("v").and_then(serde_json::Value::as_i64),
            Some(1 | 2)
        ) {
            continue;
        }
        if raw["v"] == 2
            && !raw
                .as_object()
                .is_some_and(|obj| obj.contains_key("turn_id"))
        {
            return Err(format!("Missing v2 turn_id on record {number}").into());
        }
        let mut event: EventEnvelope = serde_json::from_value(raw)?;
        if event.seq < 1
            || (event.v == 2
                && (event.id.as_deref().unwrap_or("").is_empty()
                    || event.agent_id.as_deref().unwrap_or("").is_empty()))
        {
            return Err(format!("Missing v2 identity on record {number}").into());
        }
        if !model::known_event(&event.r#type) {
            model.apply(&event).map_err(io::Error::other)?;
            continue;
        }
        if let Some(reference) = &event.payload_ref {
            let relative = Path::new(reference);
            if relative.is_absolute()
                || relative
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(format!("Unsafe payload path on record {number}").into());
            }
            let payload = root.join(relative).canonicalize()?;
            if !payload.starts_with(&root) {
                return Err("Payload resolves outside the session directory".into());
            }
            let bytes = std::fs::metadata(&payload)?.len();
            if bytes > 64 * 1024 * 1024 {
                return Err("Payload exceeds 64 MiB".into());
            }
            event.data = serde_json::from_reader(BufReader::new(File::open(payload)?))?;
        }
        if !event.data.is_object() {
            return Err(format!("Event data must be an object on record {number}").into());
        }
        model.apply(&event).map_err(io::Error::other)?;
    }
    Ok(model)
}
