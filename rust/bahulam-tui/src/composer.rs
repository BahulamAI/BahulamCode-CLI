//! Input-only pieces adapted from the preserved Rust client; commands stay in Node.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use std::{
    env,
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    process::{Command, Stdio},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const MAX_INPUT_BYTES: usize = 5 * 1024 * 1024;

pub fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|ch| *ch == '\n' || *ch == '\t' || !ch.is_control())
        .collect()
}

#[derive(Default)]
pub struct History {
    pub entries: Vec<String>,
    position: Option<usize>,
    draft: (String, usize),
}
impl History {
    pub fn load() -> Self {
        let home = env::var_os("BAHULAM_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".bahulam")));
        let entries = home
            .and_then(|home| File::open(home.join("history.jsonl")).ok())
            .and_then(|mut file| {
                // Only read a bounded tail, even after years of prompt history.
                let size = file.metadata().ok()?.len();
                let start = size.saturating_sub(MAX_INPUT_BYTES as u64);
                file.seek(SeekFrom::Start(start)).ok()?;
                let mut bytes = Vec::new();
                file.take(MAX_INPUT_BYTES as u64)
                    .read_to_end(&mut bytes)
                    .ok()?;
                let text = String::from_utf8_lossy(&bytes);
                Some(
                    text.lines()
                        .skip(usize::from(start > 0))
                        .filter_map(|line| {
                            let entry: serde_json::Value = serde_json::from_str(line).ok()?;
                            let prompt = normalize(entry.get("display")?.as_str()?);
                            (!prompt.trim().is_empty()).then_some(prompt)
                        })
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .take(100)
                        .collect(),
                )
            })
            .unwrap_or_default();
        Self {
            entries,
            ..Self::default()
        }
    }
    pub fn remember(&mut self, input: &str) {
        if !input.trim().is_empty() && self.entries.first().map(String::as_str) != Some(input) {
            self.entries.insert(0, input.to_owned());
            self.entries.truncate(100);
        }
        self.reset();
    }
    pub fn reset(&mut self) {
        self.position = None;
        self.draft = Default::default();
    }
    pub fn navigate(&mut self, down: bool, input: &mut String, cursor: &mut usize) {
        if self.entries.is_empty() {
            return;
        }
        let next = match (self.position, down) {
            (None, true) => return,
            (None, false) => {
                self.draft = (input.clone(), *cursor);
                0
            }
            (Some(0), true) => {
                (*input, *cursor) = self.draft.clone();
                self.reset();
                return;
            }
            (Some(index), true) => index - 1,
            (Some(index), false) => (index + 1).min(self.entries.len() - 1),
        };
        self.position = Some(next);
        input.clone_from(&self.entries[next]);
        *cursor = input.len();
    }
}

pub struct Search {
    pub query: String,
    pub draft: (String, usize),
    selected: usize,
}
impl Search {
    pub fn new(input: &str, cursor: usize) -> Self {
        Self {
            query: String::new(),
            draft: (input.into(), cursor),
            selected: 0,
        }
    }
    pub fn preview(
        &mut self,
        history: &History,
        input: &mut String,
        cursor: &mut usize,
        cycle: bool,
    ) -> String {
        let query = self.query.to_lowercase();
        let matches: Vec<_> = history
            .entries
            .iter()
            .filter(|entry| entry.to_lowercase().contains(&query))
            .collect();
        self.selected = if cycle && !matches.is_empty() {
            (self.selected + 1) % matches.len()
        } else {
            0
        };
        if let Some(prompt) = matches.get(self.selected) {
            input.clone_from(prompt);
            *cursor = input.len();
        } else {
            input.clear();
            *cursor = 0;
        }
        format!(
            "History: {} · {} matches · Ctrl+R next · Enter select · Esc cancel",
            self.query,
            matches.len()
        )
    }
}

/// Parse editor arguments without evaluating shell syntax or substitutions.
pub fn split_command(command: &str) -> io::Result<Vec<String>> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut chars = command.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\'
            && quote != Some('\'')
            && chars
                .peek()
                .is_some_and(|next| matches!(next, '"' | '\'' | '\\' | ' '))
        {
            current.push(chars.next().unwrap());
        } else if quote == Some(ch) {
            quote = None;
        } else if quote.is_none() && matches!(ch, '\'' | '"') {
            quote = Some(ch);
        } else if quote.is_none() && ch.is_whitespace() {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
        } else {
            current.push(ch);
        }
    }
    if quote.is_some() {
        return Err(io::Error::other("Unclosed quote in VISUAL/EDITOR"));
    }
    if !current.is_empty() {
        parts.push(current);
    }
    if parts.is_empty() {
        return Err(io::Error::other("VISUAL/EDITOR did not name an editor"));
    }
    Ok(parts)
}

pub fn edit_in_editor(prompt: &str) -> io::Result<Option<String>> {
    let editor = env::var("VISUAL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| env::var("EDITOR").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| if cfg!(windows) { "notepad.exe" } else { "vi" }.into());
    let parts = split_command(&editor)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = env::temp_dir().join(format!("bahulam-prompt-{}-{stamp}.md", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(path.clone());
    file.write_all(prompt.as_bytes())?;
    drop(file);
    let status = Command::new(&parts[0])
        .args(&parts[1..])
        .arg(&path)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    if !status.success() {
        return Ok(None);
    }
    let mut content = String::new();
    File::open(&path)?
        .take(MAX_INPUT_BYTES as u64 + 1)
        .read_to_string(&mut content)?;
    if content.len() > MAX_INPUT_BYTES {
        return Err(io::Error::other("Edited prompt exceeds 5 MiB"));
    }
    Ok(Some(normalize(&content)))
}

pub fn is_edit_key(key: KeyEvent) -> bool {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    match key.code {
        KeyCode::Char('a' | 'e' | 'u' | 'k' | 'w' | 'd') => ctrl,
        KeyCode::Char('b' | 'f') => alt,
        KeyCode::Backspace | KeyCode::Left | KeyCode::Right => ctrl || alt,
        KeyCode::Delete => true,
        _ => false,
    }
}

pub fn edit(input: &mut String, cursor: &mut usize, key: KeyEvent) -> bool {
    let at = *cursor;
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let word_left = || {
        let prefix = input[..at].trim_end();
        prefix
            .rfind(char::is_whitespace)
            .map(|i| i + prefix[i..].chars().next().unwrap().len_utf8())
            .unwrap_or(0)
    };
    let word_right = || {
        let rest = &input[at..];
        let trimmed = rest.trim_start();
        at + rest.len() - trimmed.len() + trimmed.find(char::is_whitespace).unwrap_or(trimmed.len())
    };
    match key.code {
        KeyCode::Char('a') if ctrl => *cursor = input[..at].rfind('\n').map(|i| i + 1).unwrap_or(0),
        KeyCode::Char('e') if ctrl => {
            *cursor = input[at..]
                .find('\n')
                .map(|i| at + i)
                .unwrap_or(input.len())
        }
        KeyCode::Char('u') if ctrl => {
            input.replace_range(..at, "");
            *cursor = 0;
        }
        KeyCode::Char('k') if ctrl => {
            input.truncate(at);
        }
        KeyCode::Char('w') if ctrl => {
            let start = word_left();
            input.replace_range(start..at, "");
            *cursor = start;
        }
        KeyCode::Backspace if alt || ctrl => {
            let start = word_left();
            input.replace_range(start..at, "");
            *cursor = start;
        }
        KeyCode::Left if ctrl || alt => *cursor = word_left(),
        KeyCode::Right if ctrl || alt => *cursor = word_right(),
        KeyCode::Char('b') if alt => *cursor = word_left(),
        KeyCode::Char('f') if alt => *cursor = word_right(),
        KeyCode::Delete | KeyCode::Char('d') if key.code == KeyCode::Delete || ctrl => {
            if let Some(g) = input[at..].graphemes(true).next() {
                input.replace_range(at..at + g.len(), "");
            }
        }
        _ => return false,
    }
    true
}

/// A single geometry for painting, cursor placement and mouse hit testing.
pub struct PromptLayout {
    pub lines: Vec<String>,
    positions: Vec<(usize, usize, usize)>,
}

impl PromptLayout {
    pub fn new(input: &str, width: usize) -> Self {
        let width = width.max(1);
        let mut result = Self {
            lines: vec!["› ".chars().take(width.saturating_sub(1)).collect()],
            positions: Vec::new(),
        };
        let mut column = UnicodeWidthStr::width(result.lines[0].as_str());
        for (offset, grapheme) in input.grapheme_indices(true) {
            let display = if grapheme == "\t" { "    " } else { grapheme };
            let cells = UnicodeWidthStr::width(display).min(width);
            if grapheme != "\n" && column + cells > width {
                result.lines.push(String::new());
                column = 0;
            }
            result
                .positions
                .push((offset, result.lines.len() - 1, column));
            if grapheme == "\n" {
                let gutter: String = "  │ ".chars().take(width.saturating_sub(1)).collect();
                column = UnicodeWidthStr::width(gutter.as_str());
                result.lines.push(gutter);
            } else {
                result.lines.last_mut().unwrap().push_str(display);
                column += cells;
                if column >= width {
                    result.lines.push(String::new());
                    column = 0;
                }
            }
        }
        result
            .positions
            .push((input.len(), result.lines.len() - 1, column));
        result
    }

    pub fn cursor(&self, offset: usize) -> (usize, usize) {
        self.positions
            .iter()
            .rev()
            .find(|(byte, _, _)| *byte <= offset)
            .map(|(_, row, column)| (*row, *column))
            .unwrap_or_default()
    }

    pub fn offset_at(&self, row: usize, column: usize) -> usize {
        self.positions
            .iter()
            .rev()
            .find(|(_, r, c)| *r < row || (*r == row && *c <= column))
            .or_else(|| self.positions.first())
            .map(|(byte, _, _)| *byte)
            .unwrap_or(0)
    }
}

/// Local completion state. The host supplies the command catalog used by both clients.
#[derive(Debug, Default)]
pub struct SlashMenu {
    query: String,
    pub selected: usize,
    dismissed: bool,
}

impl SlashMenu {
    pub fn sync(&mut self, input: &str) {
        if self.query != input {
            self.query = input.to_owned();
            self.selected = 0;
            self.dismissed = false;
        }
    }

    pub fn matches<'a>(
        &self,
        input: &str,
        catalog: &'a [(String, String)],
    ) -> Vec<&'a (String, String)> {
        let prefix = input.trim_start();
        if !(prefix.starts_with('/') || prefix.starts_with('$'))
            || prefix.contains('\n')
            || (self.query == input && self.dismissed)
        {
            return Vec::new();
        }
        let subcommand = prefix.contains(' ');
        catalog
            .iter()
            .filter(|(name, _)| {
                name.to_ascii_lowercase()
                    .starts_with(&prefix.to_ascii_lowercase())
                    && (subcommand || !name.contains(' '))
                    && !name.contains(['<', '[', '|'])
            })
            .collect()
    }

    pub fn move_selection(&mut self, down: bool, count: usize) {
        if count > 0 {
            self.selected = (self.selected + if down { 1 } else { count - 1 }) % count;
        }
    }

    pub fn dismiss(&mut self) {
        self.dismissed = true;
    }

    pub fn completion(&self, input: &str, catalog: &[(String, String)]) -> Option<String> {
        let matches = self.matches(input, catalog);
        matches
            .get(self.selected.min(matches.len().saturating_sub(1)))
            .map(|row| row.0.clone())
    }

    pub fn submission(&self, input: &str, catalog: &[(String, String)]) -> String {
        // Explicit commands and arguments must never be replaced by a suggestion.
        if input.trim().contains(char::is_whitespace)
            || catalog
                .iter()
                .any(|(name, _)| name.eq_ignore_ascii_case(input.trim()))
        {
            return input.to_owned();
        }
        self.completion(input, catalog)
            .unwrap_or_else(|| input.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slash_selection_preserves_explicit_commands_and_arguments() {
        let catalog = vec![
            ("/resume".into(), "history".into()),
            ("/report".into(), "report".into()),
            ("/resume <id>".into(), "argument".into()),
        ];
        let mut menu = SlashMenu::default();
        menu.sync("/re");
        assert_eq!(menu.matches("/re", &catalog).len(), 2);
        menu.move_selection(true, 2);
        assert_eq!(menu.submission("/re", &catalog), "/report");
        assert_eq!(
            menu.submission("/resume saved-id", &catalog),
            "/resume saved-id"
        );
        menu.dismiss();
        assert!(menu.matches("/re", &catalog).is_empty());
        menu.sync("/res");
        assert_eq!(
            menu.completion("/res", &catalog).as_deref(),
            Some("/resume")
        );
    }
    #[test]
    fn history_recalls_prompts_and_restores_exact_draft_cursor() {
        let mut history = History {
            entries: vec!["newer".into(), "older\nmultiline".into()],
            ..History::default()
        };
        let mut input = "draft 界".to_owned();
        let mut cursor = 5;
        history.navigate(false, &mut input, &mut cursor);
        assert_eq!(input, "newer");
        history.navigate(false, &mut input, &mut cursor);
        assert_eq!(input, "older\nmultiline");
        history.navigate(true, &mut input, &mut cursor);
        assert_eq!(input, "newer");
        history.navigate(true, &mut input, &mut cursor);
        assert_eq!((input.as_str(), cursor), ("draft 界", 5));
        let mut search = Search::new(&input, cursor);
        search.query = "older".into();
        search.preview(&history, &mut input, &mut cursor, false);
        assert_eq!(input, "older\nmultiline");
        assert_eq!(search.draft, ("draft 界".into(), 5));
    }
    #[test]
    fn editor_arguments_are_literal_and_readline_edits_preserve_unicode() {
        assert_eq!(
            split_command("\"/tmp/editor with spaces\" --wait 'literal $(id)' C:\\work\\file")
                .unwrap(),
            vec![
                "/tmp/editor with spaces",
                "--wait",
                "literal $(id)",
                "C:\\work\\file"
            ]
        );
        assert!(split_command("'broken").is_err());
        let mut input = "hello 👨‍👩‍👧 界".to_owned();
        let mut cursor = 6;
        edit(
            &mut input,
            &mut cursor,
            KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE),
        );
        assert_eq!(input, "hello  界");
        cursor = input.len();
        edit(
            &mut input,
            &mut cursor,
            KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL),
        );
        assert_eq!(input, "hello  ");
        edit(
            &mut input,
            &mut cursor,
            KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL),
        );
        assert_eq!(cursor, 0);
    }
}
