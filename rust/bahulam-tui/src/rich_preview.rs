//! Cell-based previews: all rows belong to the normal transcript and terminal diff.
use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};
use std::{path::Path, sync::Arc};

#[derive(Debug, Clone, Hash)]
pub enum Preview {
    Pending(String),
    Dormant(String),
    Loading,
    Ready(Arc<Thumbnail>),
    Unavailable(String),
}
#[derive(Debug, Hash)]
pub struct Thumbnail {
    pub source: std::path::PathBuf,
    pub native: Option<Arc<crate::native_graphics::NativeImage>>,
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

pub fn load(path: &Path) -> Result<Arc<Thumbnail>, String> {
    load_with_graphics(path, None)
}

pub fn load_with_graphics(
    path: &Path,
    graphics: Option<crate::native_graphics::Graphics>,
) -> Result<Arc<Thumbnail>, String> {
    let meta = std::fs::metadata(path).map_err(|_| "Image file unavailable".to_owned())?;
    if !meta.is_file() || meta.len() > 16 * 1024 * 1024 {
        return Err("Preview limit: regular image up to 16 MiB".into());
    }
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Preview limit: image exceeds 16 MiB".into());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(80 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|_| "Preview unavailable: unsupported, damaged or oversized image".to_owned())?;
    let small = if decoded.width() > 768 || decoded.height() > 384 {
        decoded.thumbnail(768, 384)
    } else {
        decoded
    }
    .to_rgba8();
    let native = graphics.and_then(|g| g.encode(&small)).map(Arc::new);
    Ok(Arc::new(Thumbnail {
        source: path.to_owned(),
        native,
        width: small.width(),
        height: small.height(),
        pixels: small.into_raw(),
    }))
}

pub fn image_rows(preview: &Preview, width: usize, background: Color) -> Vec<Line<'static>> {
    let Preview::Ready(image) = preview else {
        let mut rows = vec![Line::from(match preview {
            Preview::Unavailable(reason) => format!("   {reason} · Open to view original"),
            _ => "   Loading image preview…".into(),
        })];
        rows.resize(8, Line::default());
        return rows;
    };
    let cols = width
        .saturating_sub(4)
        .clamp(1, 48)
        .min(image.width as usize);
    // A terminal cell is approximately twice as high as it is wide; two pixels per cell.
    let pixel_height = (image.height as usize * cols / image.width as usize).clamp(1, 16);
    let cols = cols.min((image.width as usize * pixel_height / image.height as usize).max(1));
    let bg = match background {
        Color::Rgb(r, g, b) => [r, g, b],
        Color::Indexed(index) if index >= 232 => [8 + (index - 232) * 10; 3],
        Color::Indexed(index) if index >= 16 => {
            let cube = [0, 95, 135, 175, 215, 255];
            let n = (index - 16) as usize;
            [cube[n / 36], cube[n / 6 % 6], cube[n % 6]]
        }
        Color::White | Color::Gray => [240, 240, 240],
        _ => [20, 20, 24],
    };
    let pixel = |x: usize, y: usize| {
        let sx = x * image.width as usize / cols;
        let sy = y.min(pixel_height - 1) * image.height as usize / pixel_height;
        let i = (sy * image.width as usize + sx) * 4;
        let alpha = image.pixels[i + 3] as u16;
        let blend = |c: usize| {
            ((image.pixels[i + c] as u16 * alpha + bg[c] as u16 * (255 - alpha)) / 255) as u8
        };
        Color::Rgb(blend(0), blend(1), blend(2))
    };
    let mut rows: Vec<_> = (0..pixel_height.div_ceil(2))
        .map(|row| {
            let mut spans = vec![Span::raw("   ")];
            spans.extend((0..cols).map(|x| {
                Span::styled(
                    "▀",
                    Style::default()
                        .fg(pixel(x, row * 2))
                        .bg(pixel(x, row * 2 + 1)),
                )
            }));
            Line::from(spans)
        })
        .collect();
    rows.resize(8, Line::default());
    rows
}

/// Conservative flowchart subset. Unrecognized syntax keeps its original source.
type DiagramCache = std::collections::HashMap<(String, usize), Option<Vec<String>>>;
thread_local! { static DIAGRAMS: std::cell::RefCell<DiagramCache> = std::cell::RefCell::new(DiagramCache::new()); }
pub fn diagram(source: &str, width: usize) -> Option<Vec<String>> {
    if source.len() > 16_384 {
        return None;
    }
    let key = (source.to_owned(), width);
    DIAGRAMS.with(|cache| {
        if let Some(rows) = cache.borrow().get(&key) {
            return rows.clone();
        }
        let rows = if source.trim_start().starts_with("sequenceDiagram") {
            parse_sequence(source, width)
        } else {
            parse_flowchart(source, width)
        };
        let mut cache = cache.borrow_mut();
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, rows.clone());
        rows
    })
}
fn parse_flowchart(source: &str, width: usize) -> Option<Vec<String>> {
    if source.len() > 16_384 || width < 16 {
        return None;
    }
    let mut statements = source
        .split(['\n', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let header = statements.next()?;
    if !matches!(
        header,
        "flowchart TD"
            | "flowchart TB"
            | "flowchart LR"
            | "flowchart RL"
            | "graph TD"
            | "graph LR"
            | "graph TB"
    ) {
        return None;
    }
    let mut labels = std::collections::HashMap::new();
    let mut edges = Vec::new();
    fn node(s: &str, labels: &mut std::collections::HashMap<String, String>) -> Option<String> {
        let s = s.trim();
        let split = s.find(['[', '(', '{']);
        let id = split.map(|i| &s[..i]).unwrap_or(s).trim();
        if id.is_empty() || !id.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return None;
        }
        if let Some(i) = split {
            let end = match s.as_bytes()[i] {
                b'[' => ']',
                b'(' => ')',
                _ => '}',
            };
            if !s.ends_with(end) {
                return None;
            }
            let label = s[i + 1..s.len() - 1].trim_matches('"');
            if label.contains(['[', ']', '{', '}', '<', '>']) {
                return None;
            }
            labels.insert(id.into(), crate::model::safe_text(label));
        }
        Some(id.into())
    }
    for statement in statements {
        if statement.starts_with("%%") {
            continue;
        }
        let parts: Vec<_> = statement.split("-->").collect();
        if parts.len() < 2 {
            node(statement, &mut labels)?;
            continue;
        }
        let mut from = node(parts[0], &mut labels)?;
        for part in parts.iter().skip(1) {
            let (label, target) = if let Some(rest) = part.trim().strip_prefix('|') {
                let (label, target) = rest.split_once('|')?;
                (label, target)
            } else {
                ("", *part)
            };
            let to = node(target, &mut labels)?;
            edges.push((from, to.clone(), label.to_owned()));
            from = to;
            if edges.len() > 64 {
                return None;
            }
        }
    }
    if edges.is_empty() {
        return None;
    }
    let mut rows = vec!["Flowchart preview · source above".to_owned()];
    for (from, to, label) in edges {
        let a = labels.get(&from).unwrap_or(&from);
        let b = labels.get(&to).unwrap_or(&to);
        let arrow = if label.is_empty() {
            " → ".into()
        } else {
            format!(" ─{label}→ ")
        };
        let wa = unicode_width::UnicodeWidthStr::width(a.as_str());
        let wb = unicode_width::UnicodeWidthStr::width(b.as_str());
        let gap = " ".repeat(unicode_width::UnicodeWidthStr::width(arrow.as_str()));
        let row = format!("│{a}│{arrow}│{b}│");
        if unicode_width::UnicodeWidthStr::width(row.as_str()) > width {
            return None;
        }
        rows.push(format!("┌{}┐{gap}┌{}┐", "─".repeat(wa), "─".repeat(wb)));
        rows.push(row);
        rows.push(format!("└{}┘{gap}└{}┘", "─".repeat(wa), "─".repeat(wb)));
    }
    Some(rows)
}

fn parse_sequence(source: &str, width: usize) -> Option<Vec<String>> {
    let mut lines = source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("%%"));
    if lines.next()? != "sequenceDiagram" {
        return None;
    }
    let mut actors: Vec<(String, String)> = Vec::new();
    enum Step {
        Message(usize, usize, bool, String),
        Activation(usize, bool),
        Note(String, Vec<usize>, String),
        Open(String, String),
        Branch(String),
        Close,
    }
    let mut messages = Vec::new();
    let mut numbered = false;
    fn actor(actors: &mut Vec<(String, String)>, id: &str) -> Option<usize> {
        if id.is_empty() || !id.chars().all(|c| c.is_alphanumeric() || c == '_') {
            return None;
        }
        if let Some(index) = actors.iter().position(|(key, _)| key == id) {
            return Some(index);
        }
        if actors.len() >= 6 {
            return None;
        }
        actors.push((id.into(), id.into()));
        Some(actors.len() - 1)
    }
    for line in lines {
        if messages.len() >= 128 {
            return None;
        }
        if line == "end" {
            messages.push(Step::Close);
            continue;
        }
        if ["else", "and", "option"]
            .iter()
            .any(|word| line == *word || line.starts_with(&format!("{word} ")))
        {
            messages.push(Step::Branch(crate::model::safe_text(line)));
            continue;
        }
        if let Some((kind, label)) = ["alt", "opt", "loop", "par", "critical", "break"]
            .into_iter()
            .find_map(|kind| {
                if line == kind {
                    Some((kind, ""))
                } else {
                    line.strip_prefix(&format!("{kind} "))
                        .map(|label| (kind, label))
                }
            })
        {
            messages.push(Step::Open(kind.into(), crate::model::safe_text(label)));
            continue;
        }
        if let Some(id) = line.strip_prefix("activate ") {
            let index = actor(&mut actors, id.trim())?;
            messages.push(Step::Activation(index, true));
            continue;
        }
        if let Some(id) = line.strip_prefix("deactivate ") {
            let index = actor(&mut actors, id.trim())?;
            messages.push(Step::Activation(index, false));
            continue;
        }
        if let Some(note) = line
            .strip_prefix("Note ")
            .or_else(|| line.strip_prefix("note "))
        {
            let (where_, text) = note.split_once(':')?;
            let (placement, ids) =
                ["right of ", "left of ", "over "]
                    .into_iter()
                    .find_map(|prefix| {
                        where_
                            .strip_prefix(prefix)
                            .map(|ids| (prefix.trim().to_owned(), ids))
                    })?;
            let mut targets = Vec::new();
            for id in ids.split(',') {
                targets.push(actor(&mut actors, id.trim())?);
            }
            if targets.len() > 2 || (placement != "over" && targets.len() != 1) {
                return None;
            }
            messages.push(Step::Note(
                placement,
                targets,
                crate::model::safe_text(text.trim()),
            ));
            continue;
        }
        if line == "autonumber" {
            numbered = true;
            continue;
        }
        if let Some(declaration) = line
            .strip_prefix("participant ")
            .or_else(|| line.strip_prefix("actor "))
        {
            let (id, label) = declaration
                .split_once(" as ")
                .unwrap_or((declaration, declaration));
            if label.contains(['<', '>', '{', '}']) {
                return None;
            }
            let index = actor(&mut actors, id.trim())?;
            actors[index].1 = crate::model::safe_text(label.trim());
            continue;
        }
        let (route, message) = line.split_once(':')?;
        let (from, to, dashed) = if let Some((from, to)) = route.split_once("-->>") {
            (from, to, true)
        } else {
            let (from, to) = route.split_once("->>")?;
            (from, to, false)
        };
        let from = actor(&mut actors, from.trim())?;
        let to = to.trim();
        let change = if to.starts_with('+') {
            Some(true)
        } else if to.starts_with('-') {
            Some(false)
        } else {
            None
        };
        let to = actor(
            &mut actors,
            if change.is_some() { to[1..].trim() } else { to },
        )?;
        messages.push(Step::Message(
            from,
            to,
            dashed,
            crate::model::safe_text(message.trim()),
        ));
        if let Some(active) = change {
            messages.push(Step::Activation(if active { to } else { from }, active));
        }
    }
    if messages.is_empty() {
        return None;
    }
    let cell = actors
        .iter()
        .map(|(_, label)| unicode_width::UnicodeWidthStr::width(label.as_str()) + 4)
        .max()?
        .max(12);
    let mut depth = 0usize;
    let mut max_depth = 0usize;
    for step in &messages {
        match step {
            Step::Open(_, _) => {
                depth += 1;
                max_depth = max_depth.max(depth);
                if max_depth > 8 {
                    return None;
                }
            }
            Step::Close => depth = depth.checked_sub(1)?,
            _ => {}
        }
    }
    if depth != 0 {
        return None;
    }
    let gutter = max_depth * 2;
    let total = cell * actors.len();
    if total + gutter > width {
        return None;
    }
    let positions: Vec<_> = (0..actors.len())
        .map(|index| index * cell + cell / 2)
        .collect();
    let mut header = String::new();
    for (_, label) in &actors {
        let len = unicode_width::UnicodeWidthStr::width(label.as_str());
        let left = (cell - len) / 2;
        header.push_str(&" ".repeat(left));
        header.push_str(label);
        header.push_str(&" ".repeat(cell - len - left));
    }
    let baseline = |active: &[u8]| {
        let mut row = vec![' '; total];
        for (index, position) in positions.iter().enumerate() {
            row[*position] = if active[index] > 0 { '┃' } else { '│' };
        }
        row
    };
    let mut active = vec![0u8; actors.len()];
    let mut number = 0;
    let mut rows = vec![
        "Sequence preview · source above".into(),
        header,
        baseline(&active).iter().collect(),
    ];
    for row in rows.iter_mut().skip(1) {
        *row = format!("{}{row}", " ".repeat(gutter));
    }
    let mut groups: Vec<(String, Vec<u8>)> = Vec::new();
    fn decorate(rows: &mut [String], depth: usize, gutter: usize, width: usize) -> Option<()> {
        let prefix = format!("{}{}", "│ ".repeat(depth), " ".repeat(gutter - depth * 2));
        for row in rows {
            if unicode_width::UnicodeWidthStr::width(row.as_str()) + gutter > width {
                return None;
            }
            *row = format!("{prefix}{row}");
        }
        Some(())
    }
    for step in &messages {
        let begin = rows.len();
        let (from, to, dashed, message) = match step {
            Step::Open(kind, label) => {
                let row = format!("{}┌─ {kind} {label}", "│ ".repeat(groups.len()));
                if unicode_width::UnicodeWidthStr::width(row.as_str()) > width {
                    return None;
                }
                rows.push(row);
                groups.push((kind.clone(), active.clone()));
                continue;
            }
            Step::Branch(label) => {
                let (kind, entry) = groups.last()?;
                let keyword = label.split_whitespace().next().unwrap_or("");
                let allowed = matches!(
                    (kind.as_str(), keyword),
                    ("alt", "else") | ("par", "and") | ("critical", "option")
                );
                if !allowed || entry != &active {
                    return None;
                }
                let row = format!("{}├─ {label}", "│ ".repeat(groups.len() - 1));
                if unicode_width::UnicodeWidthStr::width(row.as_str()) > width {
                    return None;
                }
                rows.push(row);
                continue;
            }
            Step::Close => {
                let (_, entry) = groups.pop()?;
                if entry != active {
                    return None;
                }
                rows.push(format!("{}└─ end", "│ ".repeat(groups.len())));
                continue;
            }
            Step::Activation(index, enabled) => {
                if *enabled {
                    active[*index] = active[*index].checked_add(1)?;
                    if active[*index] > 8 {
                        return None;
                    }
                } else {
                    active[*index] = active[*index].checked_sub(1)?;
                }
                rows.push(baseline(&active).iter().collect());
                decorate(&mut rows[begin..], groups.len(), gutter, width)?;
                continue;
            }
            Step::Note(placement, targets, message) => {
                let names = targets
                    .iter()
                    .map(|index| actors[*index].1.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let text = format!("Note {placement} {names}: {message}");
                let size = unicode_width::UnicodeWidthStr::width(text.as_str());
                if size + 4 > width {
                    return None;
                }
                rows.push(format!("┌{}┐", "─".repeat(size + 2)));
                rows.push(format!("│ {text} │"));
                rows.push(format!("└{}┘", "─".repeat(size + 2)));
                rows.push(baseline(&active).iter().collect());
                decorate(&mut rows[begin..], groups.len(), gutter, width)?;
                continue;
            }
            Step::Message(from, to, dashed, message) => (from, to, dashed, message),
        };
        number += 1;
        if number > 64 {
            return None;
        }
        let label = if numbered {
            format!("{number}. {message}")
        } else {
            message.clone()
        };
        if unicode_width::UnicodeWidthStr::width(label.as_str()) > width {
            return None;
        }
        rows.push(label);
        let a = positions[*from];
        let b = positions[*to];
        let mut row = baseline(&active);
        let stroke = if *dashed { '┄' } else { '─' };
        if a == b {
            row[a] = '├';
            row[a + 1] = stroke;
            row[a + 2] = stroke;
            row[a + 3] = '┐';
            rows.push(row.iter().collect());
            row = baseline(&active);
            row[a] = '←';
            row[a + 1] = stroke;
            row[a + 2] = stroke;
            row[a + 3] = '┘';
        } else {
            for c in row.iter_mut().take(a.max(b)).skip(a.min(b) + 1) {
                *c = if matches!(*c, '│' | '┃') {
                    '┼'
                } else {
                    stroke
                };
            }
            row[a] = if a < b { '├' } else { '┤' };
            row[b] = if a < b { '→' } else { '←' };
        }
        rows.push(row.iter().collect());
        rows.push(baseline(&active).iter().collect());
        decorate(&mut rows[begin..], groups.len(), gutter, width)?;
    }
    if !groups.is_empty() {
        return None;
    }
    Some(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sequence_groups_preserve_nesting_numbering_and_activation_boundaries() {
        let source="sequenceDiagram\nautonumber\nalt Cached\nA->>A: Use cache\nelse Fetch\nloop Retry\nA->>+B: Request\nNote over A,B: Checked\nB-->>-A: Result\nend\nopt Log\nA->>A: Log result\nend\nend";
        let rows = diagram(source, 80).unwrap();
        let text = rows.join("\n");
        for expected in [
            "┌─ alt Cached",
            "├─ else Fetch",
            "│ ┌─ loop Retry",
            "│ ┌─ opt Log",
            "1. Use cache",
            "4. Log result",
            "┃",
        ] {
            assert!(text.contains(expected), "{text}");
        }
        assert_eq!(text.matches("└─ end").count(), 3);
        assert!(rows
            .iter()
            .all(|row| unicode_width::UnicodeWidthStr::width(row.as_str()) <= 80));
        // Branches cannot borrow activations from one another, or silently imply a valid loop.
        for bad in [
            "sequenceDiagram\nelse orphan\nA->>B: Hi",
            "sequenceDiagram\nloop Repeat\nA->>B: Hi",
            "sequenceDiagram\nA->>B: Hi\nend",
            "sequenceDiagram\nopt Maybe\nA->>B: Hi\nelse Wrong\nend",
            "sequenceDiagram\nalt One\nA->>+B: Hi\nelse Two\nB-->>-A: Bye\nend",
        ] {
            assert!(diagram(bad, 100).is_none());
        }
        assert!(diagram(source, 24).is_none());
    }
    #[test]
    fn sequence_activations_notes_and_numbering_follow_message_order() {
        let source = "sequenceDiagram\nparticipant A as Agent\nparticipant T as Tool\nautonumber\nA->>+T: Read\nNote over A,T: Checked\nactivate T\nT-->>-A: First reply\nNote right of T: Still active\nT-->>-A: Final reply";
        let rows = diagram(source, 100).unwrap();
        let text = rows.join("\n");
        for expected in [
            "1. Read",
            "2. First reply",
            "3. Final reply",
            "Note over Agent, Tool: Checked",
            "Note right of Tool: Still active",
            "┃",
        ] {
            assert!(text.contains(expected), "{text}");
        }
        assert!(!rows.last().unwrap().contains('┃'));
        let between = text
            .split("Still active")
            .nth(1)
            .unwrap()
            .split("Final reply")
            .next()
            .unwrap();
        assert!(
            between.contains('┃'),
            "nested activation must survive the first return"
        );
        assert!(diagram("sequenceDiagram\nA-->>-B: Invalid deactivate", 80).is_none());
        assert!(diagram("sequenceDiagram\ndeactivate A", 80).is_none());
        assert!(diagram("sequenceDiagram\nNote left of A,B: invalid placement", 80).is_none());
        assert!(diagram(
            "sequenceDiagram\nA->>B: Hi\nNote over A,B: excessively long note for this width",
            24
        )
        .is_none());
    }
    #[test]
    fn sequence_columns_preserve_order_aliases_replies_and_self_calls() {
        let source = "sequenceDiagram\nparticipant U as User\nparticipant A as Agent\nautonumber\nU->>A: Ask\nA->>A: Think\nA-->>U: Reply";
        let rows = diagram(source, 60).unwrap();
        let text = rows.join("\n");
        assert!(rows[1].find("User").unwrap() < rows[1].find("Agent").unwrap());
        for expected in ["1. Ask", "2. Think", "3. Reply", "┄", "←", "→", "┐", "┘"] {
            assert!(text.contains(expected), "{text}");
        }
        assert!(rows
            .iter()
            .all(|row| unicode_width::UnicodeWidthStr::width(row.as_str()) <= 60));
        assert_eq!(diagram(source, 60), Some(rows));
        assert!(diagram(source, 16).is_none());
        let unicode =
            diagram("sequenceDiagram\nparticipant A as 使用者\nA->>B: Hello", 60).unwrap();
        assert!(unicode
            .iter()
            .all(|row| unicode_width::UnicodeWidthStr::width(row.as_str()) <= 60));
    }
    #[test]
    fn sequence_unsupported_blocks_do_not_produce_misleading_partial_previews() {
        for source in [
            "sequenceDiagram\nA->>B: Start\nrect rgb(0,0,0)\nB-->>A: Result\nend",
            "sequenceDiagram\nA->B: unsupported arrow",
        ] {
            assert!(diagram(source, 120).is_none());
        }
        let many = format!(
            "sequenceDiagram\n{}",
            (0..7)
                .map(|n| format!("A{n}->>A{n}: Work"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        assert!(diagram(&many, 200).is_none());
    }
    #[test]
    fn decoding_and_cell_previews_are_bounded_and_keep_reserved_rows() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/rich-preview/gradient.png");
        let thumb = load(&path).unwrap();
        assert!(thumb.pixels.len() <= 768 * 384 * 4);
        for width in [8, 40, 120] {
            let rows = image_rows(&Preview::Ready(thumb.clone()), width, Color::Black);
            assert_eq!(rows.len(), 8);
            assert!(rows.iter().all(|row| row.width() <= width));
        }
        assert_eq!(image_rows(&Preview::Loading, 80, Color::Black).len(), 8);
        assert!(load(&path.with_extension("pdf")).is_err());
    }
    #[test]
    fn image_limits_reject_large_inputs_dimensions_and_corruption() {
        let path =
            std::env::temp_dir().join(format!("bahulam-image-limit-{}.png", std::process::id()));
        image::RgbaImage::new(4097, 1).save(&path).unwrap();
        assert!(load(&path).is_err());
        std::fs::write(&path, b"not an image").unwrap();
        assert!(load(&path).is_err());
        std::fs::File::create(&path)
            .unwrap()
            .set_len(16 * 1024 * 1024 + 1)
            .unwrap();
        assert!(load(&path).unwrap_err().contains("16 MiB"));
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn flowcharts_preserve_labels_branches_and_reject_unsupported_constructs() {
        let rows = diagram(
            "flowchart TD\nA[Request] --> B{Approved?}\nB -->|Yes| C[Run]\nB -->|No| D[Stop]",
            80,
        )
        .unwrap()
        .join("\n");
        for label in ["Request", "Approved?", "Yes", "No", "Run", "Stop"] {
            assert!(rows.contains(label));
        }
        assert!(diagram("sequenceDiagram\nA->>B: Hi", 80).is_some());
        assert!(diagram("flowchart TD\nA --> B\nclick A evil", 80).is_none());
        assert!(diagram("flowchart TD\nA[long label] --> B[another long label]", 16).is_none());
    }
}

#[cfg(test)]
mod parallel_sequence_tests {
    #[test]
    fn parallel_workers_and_critical_options_keep_explicit_boundaries() {
        let source="sequenceDiagram\npar Search\nA->>B: Inspect\nand Verify\nA->>C: Check\nend\ncritical Save\nA->>B: Write\noption Failed\nB-->>A: Error\nend\nbreak Cancelled\nA->>A: Stop\nend";
        let text = super::diagram(source, 100).unwrap().join("\n");
        for label in [
            "par Search",
            "and Verify",
            "critical Save",
            "option Failed",
            "break Cancelled",
        ] {
            assert!(text.contains(label));
        }
        assert!(super::diagram(
            "sequenceDiagram\npar Work\nA->>B: Go\nelse wrong\nB-->>A: Done\nend",
            100
        )
        .is_none());
    }
}
