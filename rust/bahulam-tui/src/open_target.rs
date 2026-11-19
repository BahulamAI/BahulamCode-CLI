use crate::model::Card;
use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug)]
pub enum OpenError {
    NoTarget,
    NotFound(String),
    Unsupported,
    LaunchFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkTarget {
    pub label: String,
    pub uri: String,
}

#[derive(Debug, Clone)]
struct FileReference {
    path: PathBuf,
    line: Option<u32>,
    column: Option<u32>,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoTarget => write!(f, "No URL or file path found in this item."),
            Self::NotFound(path) => write!(f, "File does not exist: {path}"),
            Self::Unsupported => write!(f, "No supported URL or file opener is available."),
            Self::LaunchFailed(status) => write!(f, "Browser opener failed ({status}). Check your default browser; Alt+L lists the URL."),
        }
    }
}

fn candidate_text(card: &Card) -> String {
    let card = card.materialized();
    let primary = card.primary.chars().take(8 * 1024).collect::<String>();
    let body = card.body.chars().take(8 * 1024).collect::<String>();
    format!("{primary}\n{body}")
}

fn trim_candidate(value: &str) -> &str {
    value.trim_matches(|ch: char| {
        matches!(
            ch,
            '`' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '.'
        )
    })
}

fn clean_path_candidate(value: &str) -> String {
    let value = value
        .rsplit_once("](")
        .map(|(_, target)| target)
        .unwrap_or(value)
        .trim_start_matches('(');
    let value = trim_candidate(value);
    value.strip_prefix("file://").unwrap_or(value).to_owned()
}

fn first_url(text: &str) -> Option<String> {
    crate::browser_links::extract(text)
        .into_iter()
        .next()
        .map(|link| link.uri)
}

pub fn open_browser_url(url: &str) -> Result<String, OpenError> {
    if !crate::browser_links::valid_url(url) {
        return Err(OpenError::NoTarget);
    }
    open_url(url)?;
    Ok(format!("Opened {url}"))
}

fn split_location(candidate: &str) -> (&str, Option<u32>, Option<u32>) {
    let Some((before_column, last)) = candidate.rsplit_once(':') else {
        return (candidate, None, None);
    };
    let Ok(last) = last.parse::<u32>() else {
        return (candidate, None, None);
    };
    if let Some((path, line)) = before_column.rsplit_once(':') {
        if let Ok(line) = line.parse::<u32>() {
            return (path, Some(line), Some(last));
        }
    }
    (before_column, Some(last), None)
}

fn existing_path(text: &str, cwd: &Path) -> Result<Option<FileReference>, OpenError> {
    let mut missing = None;
    for line in text.lines() {
        let words = line.split_whitespace().take(128).collect::<Vec<_>>();
        for start in 0..words.len() {
            let marker = trim_candidate(words[start]);
            if !marker.contains('/') && !marker.contains('\\') && !marker.contains('.') {
                continue;
            }
            if marker.starts_with("http://") || marker.starts_with("https://") {
                continue;
            }
            for end in (start + 1..=words.len().min(start + 16)).rev() {
                let joined = words[start..end].join(" ");
                let candidate = clean_path_candidate(&joined);
                let (candidate, line_number, column) = split_location(&candidate);
                if candidate.is_empty() || candidate.starts_with('-') || candidate.contains('\0') {
                    continue;
                }
                let path = Path::new(candidate);
                let resolved = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    cwd.join(path)
                };
                if resolved.is_file() {
                    return Ok(Some(FileReference {
                        path: resolved,
                        line: line_number,
                        column,
                    }));
                }
                if missing.is_none()
                    && (path.is_absolute()
                        || candidate.starts_with("./")
                        || candidate.starts_with("../"))
                {
                    missing = Some(candidate.to_owned());
                }
            }
        }
    }
    if let Some(path) = missing {
        Err(OpenError::NotFound(path))
    } else {
        Ok(None)
    }
}

fn file_uri(path: &Path) -> String {
    let mut encoded = String::new();
    let raw = path.to_string_lossy().replace('\\', "/");
    let raw = if cfg!(windows)
        && raw
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
    {
        format!("/{raw}")
    } else {
        raw
    };
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("file://{encoded}")
}

fn uses_system_viewer(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "html"
            | "htm"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "pdf"
            | "doc"
            | "docx"
            | "odt"
            | "ppt"
            | "pptx"
            | "odp"
            | "xls"
            | "xlsx"
            | "ods"
            | "csv"
    )
}

fn configured_editor() -> Option<String> {
    if let Ok(value) = env::var("BAHULAM_TUI_FILE_OPENER") {
        let value = value.trim();
        if value.eq_ignore_ascii_case("system") {
            return None;
        }
        if !value.is_empty() && !value.eq_ignore_ascii_case("auto") {
            return Some(value.to_owned());
        }
    }
    env::var("VISUAL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            env::var("EDITOR")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
}

fn command_basename(value: &str) -> String {
    value
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase()
}

fn editor_uri(reference: &FileReference) -> String {
    let path = &reference.path;
    if uses_system_viewer(path) {
        return file_uri(path);
    }
    let configured = configured_editor().unwrap_or_default();
    let command = split_command(&configured)
        .first()
        .map(|value| command_basename(value))
        .unwrap_or_default();
    let scheme = match command.as_str() {
        "code" => "vscode",
        "code-insiders" => "vscode-insiders",
        "cursor" => "cursor",
        "zed" => "zed",
        _ => return file_uri(path),
    };
    let file_uri = file_uri(path);
    let file = file_uri.trim_start_matches("file://");
    let location = match (reference.line, reference.column) {
        (Some(line), Some(column)) => format!(":{line}:{column}"),
        (Some(line), None) => format!(":{line}"),
        _ => String::new(),
    };
    if matches!(scheme, "vscode" | "vscode-insiders") {
        if let Some(distro) = env::var("WSL_DISTRO_NAME")
            .ok()
            .filter(|distro| !distro.trim().is_empty())
        {
            return format!("vscode://vscode-remote/wsl+{distro}{file}{location}");
        }
    }
    format!("{scheme}://file/{file}{location}")
}

pub fn card_link_target(card: &Card, cwd: &str) -> Option<LinkTarget> {
    if let Some(url) = card.open_url.as_deref().and_then(first_url) {
        return Some(LinkTarget {
            label: url.clone(),
            uri: url,
        });
    }
    let text = candidate_text(card);
    if let Some(url) = first_url(&text) {
        return Some(LinkTarget {
            label: url.clone(),
            uri: url,
        });
    }
    let reference = existing_path(&text, Path::new(cwd)).ok().flatten()?;
    Some(LinkTarget {
        label: format!(
            "{}{}",
            reference.path.display(),
            match (reference.line, reference.column) {
                (Some(line), Some(column)) => format!(":{line}:{column}"),
                (Some(line), None) => format!(":{line}"),
                _ => String::new(),
            }
        ),
        uri: editor_uri(&reference),
    })
}

pub fn split_command(command: &str) -> Vec<String> {
    crate::composer::split_command(command).unwrap_or_default()
}

fn spawn_detached(command: &str, args: &[String]) -> Result<(), OpenError> {
    Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|mut child| {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
        .map_err(|_| OpenError::Unsupported)
}

fn open_url(url: &str) -> Result<(), OpenError> {
    #[cfg(target_os = "macos")]
    let command = "open";
    #[cfg(target_os = "windows")]
    let command = "rundll32";
    #[cfg(all(unix, not(target_os = "macos")))]
    let command = "xdg-open";

    #[cfg(target_os = "windows")]
    let args = vec!["url.dll,FileProtocolHandler".to_owned(), url.to_owned()];
    #[cfg(not(target_os = "windows"))]
    let args = vec![url.to_owned()];
    // Report immediate launcher errors instead of claiming success on spawn.
    // This runs on the browser worker; an opener that stays running is reaped
    // in the background after a bounded observation period.
    let mut child = Command::new(command)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| OpenError::Unsupported)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait().map_err(|_| OpenError::Unsupported)? {
            return if status.success() {
                Ok(())
            } else {
                Err(OpenError::LaunchFailed(status.to_string()))
            };
        }
        if std::time::Instant::now() >= deadline {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn open_file(reference: &FileReference) -> Result<(), OpenError> {
    let path = &reference.path;
    if uses_system_viewer(path) {
        return open_default(path);
    }
    let configured = configured_editor();
    let parts = configured.as_deref().map(split_command).unwrap_or_default();
    if let Some((command, args)) = parts.split_first() {
        let mut args = args.to_vec();
        if matches!(
            command_basename(command).as_str(),
            "code" | "code-insiders" | "cursor" | "zed"
        ) {
            args.push("-g".into());
            args.push(format_location(reference));
        } else {
            args.push(path.display().to_string());
        }
        return spawn_detached(command, &args);
    }

    open_default(path)
}

fn open_default(path: &Path) -> Result<(), OpenError> {
    #[cfg(target_os = "macos")]
    let command = "open";
    #[cfg(target_os = "windows")]
    let command = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if env::var_os("WSL_DISTRO_NAME").is_some() {
            if spawn_detached("wslview", &[path.display().to_string()]).is_ok() {
                return Ok(());
            }
            if let Some(windows_path) = windows_path_from_wsl(path) {
                if spawn_detached("explorer.exe", &[windows_path]).is_ok() {
                    return Ok(());
                }
            }
        }
        spawn_detached("xdg-open", &[path.display().to_string()])
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    spawn_detached(command, &[path.display().to_string()])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn windows_path_from_wsl(path: &Path) -> Option<String> {
    let output = Command::new("wslpath").arg("-w").arg(path).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn format_location(reference: &FileReference) -> String {
    match (reference.line, reference.column) {
        (Some(line), Some(column)) => format!("{}:{line}:{column}", reference.path.display()),
        (Some(line), None) => format!("{}:{line}", reference.path.display()),
        _ => reference.path.display().to_string(),
    }
}

pub fn open_card_target(card: &Card, cwd: &str) -> Result<String, OpenError> {
    let text = card
        .open_url
        .clone()
        .unwrap_or_else(|| candidate_text(card));
    if let Some(url) = first_url(&text) {
        open_url(&url)?;
        return Ok(format!("Opened {url}"));
    }
    let reference = existing_path(&text, Path::new(cwd))?.ok_or(OpenError::NoTarget)?;
    open_file(&reference)?;
    Ok(format!("Opened {}", format_location(&reference)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn link_detection_preserves_location_and_escapes_paths() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
        let reference = existing_path(&format!("{}:12:4", path.display()), Path::new("/"))
            .unwrap()
            .unwrap();
        assert_eq!((reference.line, reference.column), (Some(12), Some(4)));
        assert!(file_uri(Path::new("/tmp/a b#界.rs")).contains("a%20b%23%E7%95%8C.rs"));
        assert_eq!(
            first_url("[docs](https://example.com/docs)"),
            Some("https://example.com/docs".into())
        );
        assert_eq!(first_url("javascript:alert(1)"), None);
        assert!(split_command("'unterminated").is_empty());
    }
}
