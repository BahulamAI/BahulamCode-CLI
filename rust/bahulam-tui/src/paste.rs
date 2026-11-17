use crate::composer::normalize as normalize_paste;
use std::path::PathBuf;
use unicode_segmentation::UnicodeSegmentation;

pub fn pasted_attachment_references(text: &str, cwd: &str) -> Option<String> {
    let supported = [
        "png", "jpg", "jpeg", "webp", "gif", "pdf", "txt", "md", "mdx", "rst", "csv", "tsv", "log",
        "json", "ipynb", "yaml", "yml", "toml", "ini", "env", "html", "htm", "xml",
    ];
    let mut references = Vec::new();

    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let candidate = if line.len() >= 2
            && ((line.starts_with('\'') && line.ends_with('\''))
                || (line.starts_with('"') && line.ends_with('"')))
        {
            &line[1..line.len() - 1]
        } else {
            line
        };
        if candidate.starts_with('@') {
            return None;
        }

        // Terminal drag-and-drop implementations vary: some quote paths,
        // others backslash-escape spaces. Decode those path-level escapes.
        let mut decoded = String::with_capacity(candidate.len());
        let mut chars = candidate.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\\'
                && chars.peek().is_some_and(|next| {
                    next.is_whitespace() || *next == '\\' || *next == '\'' || *next == '"'
                })
            {
                decoded.push(chars.next().expect("peeked character exists"));
            } else {
                decoded.push(ch);
            }
        }
        let expanded = if decoded == "~" {
            std::env::var_os("HOME").map(PathBuf::from)?
        } else if let Some(rest) = decoded.strip_prefix("~/") {
            std::env::var_os("HOME").map(PathBuf::from)?.join(rest)
        } else {
            PathBuf::from(decoded)
        };
        let base = if cwd.is_empty() {
            std::env::current_dir().ok()?
        } else {
            PathBuf::from(cwd)
        };
        let path = if expanded.is_absolute() {
            expanded
        } else {
            base.join(expanded)
        };
        if !path.is_file()
            || !path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    supported.contains(&extension.to_ascii_lowercase().as_str())
                })
        {
            return None;
        }

        let path = path.to_string_lossy();
        let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
        references.push(format!("@\"{escaped}\""));
    }

    (!references.is_empty()).then(|| references.join(" "))
}

#[derive(Debug)]
pub struct PasteChip {
    marker: String,
    label: String,
    content: String,
}

pub fn insert_paste_chip(
    input: &mut String,
    cursor: &mut usize,
    text: &str,
    chips: &mut Vec<PasteChip>,
    sequence: &mut u64,
) {
    let pasted = normalize_paste(text);
    if pasted.is_empty() {
        return;
    }
    let lines = pasted.split('\n').count();
    if lines <= 20 {
        insert_paste(input, cursor, &pasted);
        return;
    }
    insert_named_paste_chip(
        input,
        cursor,
        &pasted,
        &format!("[Pasted {lines} lines · Ctrl+O to expand]"),
        chips,
        sequence,
    );
}

fn insert_named_paste_chip(
    input: &mut String,
    cursor: &mut usize,
    content: &str,
    label: &str,
    chips: &mut Vec<PasteChip>,
    sequence: &mut u64,
) {
    if content.is_empty() {
        return;
    }
    *sequence = (*sequence).wrapping_add(1);
    let scalar = if *sequence <= 0x1900 {
        0xe000 + *sequence as u32 - 1
    } else {
        0xf0000 + ((*sequence - 0x1900 - 1) % 0xfffe) as u32
    };
    let marker = char::from_u32(scalar)
        .expect("private-use paste marker is a valid Unicode scalar")
        .to_string();
    let chip = PasteChip {
        marker: marker.clone(),
        label: label.to_owned(),
        content: content.to_owned(),
    };
    let at = (*cursor).min(input.len());
    input.insert_str(at, &marker);
    *cursor = at + marker.len();
    chips.push(chip);
}

pub fn insert_clipboard_image_reference(
    input: &mut String,
    cursor: &mut usize,
    chips: &mut Vec<PasteChip>,
    sequence: &mut u64,
) {
    let at = (*cursor).min(input.len());
    let needs_leading_space = at > 0
        && !input[..at]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
    let needs_trailing_space =
        at == input.len() || !input[at..].chars().next().is_some_and(char::is_whitespace);
    let reference = format!(
        "{}@clipboard{}",
        if needs_leading_space { " " } else { "" },
        if needs_trailing_space { " " } else { "" }
    );
    insert_named_paste_chip(
        input,
        cursor,
        &reference,
        "[clipboard image · Ctrl+O to expand]",
        chips,
        sequence,
    );
}

pub fn display_paste_chips(input: &str, chips: &[PasteChip]) -> String {
    chips.iter().fold(input.to_owned(), |display, chip| {
        display.replace(&chip.marker, &chip.label)
    })
}

pub fn raw_cursor_from_display(input: &str, chips: &[PasteChip], display_cursor: usize) -> usize {
    let mut raw_offset = 0usize;
    let mut display_offset = 0usize;
    while raw_offset < input.len() {
        if let Some(chip) = chips
            .iter()
            .find(|chip| input[raw_offset..].starts_with(&chip.marker))
        {
            let shown_len = chip.label.len();
            if display_cursor < display_offset + shown_len {
                return if display_cursor.saturating_sub(display_offset) < shown_len / 2 {
                    raw_offset
                } else {
                    raw_offset + chip.marker.len()
                };
            }
            raw_offset += chip.marker.len();
            display_offset += shown_len;
        } else if let Some(grapheme) = input[raw_offset..].graphemes(true).next() {
            if display_cursor <= display_offset {
                return raw_offset;
            }
            raw_offset += grapheme.len();
            display_offset += grapheme.len();
        } else {
            break;
        }
    }
    input.len()
}

pub fn expand_paste_chips(input: &str, chips: &[PasteChip]) -> String {
    chips.iter().fold(input.to_owned(), |expanded, chip| {
        expanded.replace(&chip.marker, &chip.content)
    })
}

pub fn expand_last_paste_chip(input: &mut String, cursor: &mut usize, chips: &mut Vec<PasteChip>) {
    let Some(index) = chips.iter().rposition(|chip| input.contains(&chip.marker)) else {
        return;
    };
    let chip = chips.remove(index);
    if let Some(at) = input.find(&chip.marker) {
        input.replace_range(at..at + chip.marker.len(), &chip.content);
        if *cursor > at {
            *cursor = at + chip.content.len();
        }
    }
}

fn insert_paste(input: &mut String, cursor: &mut usize, text: &str) {
    let at = (*cursor).min(input.len());
    input.insert_str(at, text);
    *cursor = at + text.len();
}
pub fn materialize(input: &mut String, cursor: &mut usize, chips: &mut Vec<PasteChip>) {
    *cursor = expand_paste_chips(&input[..*cursor], chips).len();
    *input = expand_paste_chips(input, chips);
    chips.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chips_restore_exact_content_and_cursor_without_changing_small_pastes() {
        let mut input = "before after".to_owned();
        let mut cursor = 7;
        let mut chips = Vec::new();
        let mut sequence = 0;
        let content = "界 line\n".repeat(21);
        insert_paste_chip(&mut input, &mut cursor, &content, &mut chips, &mut sequence);
        assert!(display_paste_chips(&input, &chips).contains("Pasted 22 lines"));
        assert_eq!(
            expand_paste_chips(&input, &chips),
            format!("before {content}after")
        );
        materialize(&mut input, &mut cursor, &mut chips);
        assert_eq!(cursor, 7 + content.len());
        insert_paste_chip(&mut input, &mut cursor, "a\r\nb", &mut chips, &mut sequence);
        assert!(chips.is_empty());
        assert_eq!(input, format!("before {content}a\nbafter"));
    }
    #[test]
    fn expand_keeps_surrounding_text_and_image_reference_is_explicit() {
        let (mut input, mut cursor, mut chips, mut sequence) = (String::new(), 0, Vec::new(), 0);
        insert_paste_chip(
            &mut input,
            &mut cursor,
            &"x\n".repeat(21),
            &mut chips,
            &mut sequence,
        );
        input.push_str("tail");
        expand_last_paste_chip(&mut input, &mut cursor, &mut chips);
        assert_eq!(input, format!("{}tail", "x\n".repeat(21)));
        insert_clipboard_image_reference(&mut input, &mut cursor, &mut chips, &mut sequence);
        assert!(expand_paste_chips(&input, &chips).contains("@clipboard "));
    }
}
