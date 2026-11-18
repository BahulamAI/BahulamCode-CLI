//! Presentation-only OS integrations adapted from the original terminal client.
//! Profiles are hints, not active probe results. All integrations have overrides.
use crate::{
    capabilities::TerminalCapabilities,
    model::{safe_text, Model},
};
use crossterm::{
    event::{
        DisableFocusChange, EnableFocusChange, KeyboardEnhancementFlags,
        PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
};
use std::{
    io::{self, Read, Write},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, AtomicU8, Ordering},
    thread,
    time::Duration,
};

static KEYBOARD: AtomicBool = AtomicBool::new(false);
static MARKED: AtomicBool = AtomicBool::new(false);
static PROGRESS: AtomicBool = AtomicBool::new(false);
static POINTER: AtomicU8 = AtomicU8::new(0);

pub fn link_pointer(profile: &str, hovered: bool) -> io::Result<()> {
    // OSC22 names differ: CSS for Kitty/Ghostty, X11 names for iTerm2.
    // Other terminals retain their own pointer; link emphasis is the fallback.
    let requested = if !hovered {
        0
    } else {
        match profile {
            "Kitty" | "Ghostty" => 1,
            "iTerm2" => 2,
            _ => 0,
        }
    };
    let previous = POINTER.swap(requested, Ordering::AcqRel);
    if requested == previous {
        return Ok(());
    }
    let shape = match requested {
        1 => "pointer",
        2 => "hand2",
        _ if previous == 2 => "xterm",
        _ => "default",
    };
    osc("22", shape)
}

#[derive(Debug, Clone)]
pub struct Config {
    pub paste: bool,
    pub focus: bool,
    pub sync: bool,
    pub links: bool,
    pub keyboard: bool,
    pub cwd: bool,
    pub shell_marks: bool,
    pub progress: bool,
    pub notifications: String,
}
impl Config {
    pub fn from_caps(caps: &TerminalCapabilities) -> Self {
        let overrides = &caps.overrides;
        let known = matches!(
            caps.profile.as_str(),
            "Kitty" | "Ghostty" | "WezTerm" | "iTerm2" | "VS Code" | "Windows Terminal"
        );
        let direct = caps.interactive && !caps.tmux && !caps.screen;
        // Silence after an active query is not evidence for enabling these modes.
        let queried = caps.probe.status.starts_with("active") || caps.probe.complete;
        let enabled = |key: &str, default: bool| caps.resolve(key, default);
        let native = direct
            && !caps.ssh
            && (cfg!(any(target_os = "macos", target_os = "windows"))
                || std::env::var_os("DISPLAY").is_some()
                || std::env::var_os("WAYLAND_DISPLAY").is_some());
        let notifications = match overrides.get("notifications") {
            Some(serde_json::Value::Bool(false)) => "off",
            Some(serde_json::Value::String(value))
                if ["off", "native", "osc9", "osc99"].contains(&value.as_str()) =>
            {
                value
            }
            _ if direct && caps.profile == "Kitty" => "osc99",
            _ if direct && matches!(caps.profile.as_str(), "Ghostty" | "iTerm2") => "osc9",
            _ if native => "native",
            _ => "off",
        }
        .to_owned();
        Self {
            paste: enabled("bracketed_paste", !caps.dumb),
            focus: enabled("focus_reporting", direct && known),
            sync: enabled(
                "synchronized_output",
                !queried
                    && direct
                    && matches!(
                        caps.profile.as_str(),
                        "Kitty" | "Ghostty" | "WezTerm" | "iTerm2" | "Windows Terminal"
                    ),
            ),
            links: enabled("osc8_links", caps.interactive && known),
            keyboard: enabled(
                "keyboard_protocol",
                !queried
                    && direct
                    && matches!(caps.profile.as_str(), "Kitty" | "Ghostty" | "WezTerm"),
            ),
            cwd: enabled("osc7_cwd", direct && known),
            shell_marks: enabled("osc133_shell_marks", direct && known),
            progress: enabled(
                "osc9_4_progress",
                direct && caps.profile == "Windows Terminal",
            ),
            notifications,
        }
    }
    pub fn report(&self) -> String {
        format!("Resolved integrations: focus={} sync={} links={} keyboard={} cwd={} shell-marks={} notifications={}", self.focus, self.sync, self.links, self.keyboard, self.cwd, self.shell_marks, self.notifications)
    }
}
fn osc(code: &str, value: &str) -> io::Result<()> {
    let value = safe_text(value).replace(['\n', '\r', '\t'], " ");
    write!(io::stdout(), "\x1b]{code};{value}\x1b\\")?;
    io::stdout().flush()
}
pub fn percent_encode_path(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'_' | b'.' | b'~') {
            result.push(byte as char);
        } else {
            result.push_str(&format!("%{byte:02X}"));
        }
    }
    result
}
pub fn enter(config: &Config) -> io::Result<()> {
    if config.focus {
        execute!(io::stdout(), EnableFocusChange)?;
    }
    if config.keyboard {
        execute!(
            io::stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
        KEYBOARD.store(true, Ordering::Release);
    }
    if config.shell_marks {
        osc("133", "A")?;
    }
    Ok(())
}
pub fn restore() {
    let _ = link_pointer("", false);
    let _ = write!(io::stdout(), "\x1b[?2026l");
    if KEYBOARD.swap(false, Ordering::AcqRel) {
        let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
    }
    if MARKED.swap(false, Ordering::AcqRel) {
        let _ = osc("133", "D");
    }
    if PROGRESS.swap(false, Ordering::AcqRel) {
        let _ = osc("9", "4;0;0");
    }
    let _ = execute!(io::stdout(), DisableFocusChange);
}
pub fn terminal_state() -> (bool, bool) {
    (
        KEYBOARD.load(Ordering::Acquire),
        MARKED.load(Ordering::Acquire),
    )
}

pub fn notify_approval(protocol: &str, tool: &str) -> io::Result<()> {
    let body = safe_text(&format!(
        "A {tool} action needs your approval. Return to Bahulam to review it."
    ));
    match protocol {
        "native" => {
            thread::spawn(move || {
                let _ = notify_rust::Notification::new()
                    .summary("Bahulam approval needed")
                    .body(&body)
                    .appname("Bahulam")
                    .show();
            });
            Ok(())
        }
        "osc9" => osc("9", &format!("Bahulam approval: {body}")),
        "osc99" => {
            osc("99", "p=title;Bahulam approval")?;
            osc("99", &format!("p=body;{body}"))
        }
        _ => Ok(()),
    }
}
#[derive(Default)]
pub struct SessionState {
    cwd: String,
    title: String,
    active: bool,
    notified: Option<String>,
}
impl SessionState {
    pub fn update(&mut self, model: &Model, config: &Config, focused: bool) -> io::Result<()> {
        let active = model.agents.iter().any(|a| a.started_at.is_some());
        if config.progress && active != self.active {
            osc("9", if active { "4;3;0" } else { "4;0;0" })?;
            PROGRESS.store(active, Ordering::Release);
        }
        if config.shell_marks && active != self.active {
            if active {
                osc("133", "B")?;
                osc("133", "C")?;
            } else {
                osc("133", "D")?;
                osc("133", "A")?;
            }
            MARKED.store(active, Ordering::Release);
        }
        self.active = active;
        if config.cwd && !model.cwd.is_empty() && self.cwd != model.cwd {
            osc(
                "7",
                &format!("file://localhost{}", percent_encode_path(&model.cwd)),
            )?;
            self.cwd = model.cwd.clone();
        }
        let title = format!(
            "Bahulam · {} · {}",
            std::path::Path::new(&model.cwd)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            if model.approval.is_some() {
                "approval needed"
            } else if active {
                "working"
            } else {
                "ready"
            }
        );
        if config.cwd && self.title != title {
            osc("2", &title)?;
            self.title = title;
        }
        if let Some(approval) = &model.approval {
            if !focused && self.notified.as_deref() != Some(&approval.id) {
                notify_approval(&config.notifications, &approval.tool)?;
                self.notified = Some(approval.id.clone());
            }
        } else {
            self.notified = None;
        }
        Ok(())
    }
}

pub fn run_status_command(command: &str, cwd: &str) -> String {
    const OUTPUT_LIMIT: u64 = 4096;
    const TIMEOUT: Duration = Duration::from_millis(500);
    let parts = crate::open_target::split_command(command);
    let Some((program, args)) = parts.split_first() else {
        return String::new();
    };
    let mut child_command = Command::new(program);
    child_command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear();
    if !cwd.is_empty() {
        child_command.current_dir(cwd);
    }
    // Status scripts are explicitly configured user code. Give them the
    // environment needed to locate tools and format output, without handing
    // provider/API credentials from the core process to the script.
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
    ] {
        if let Some(value) = std::env::var_os(key) {
            child_command.env(key, value);
        }
    }
    let Ok(mut child) = child_command.spawn() else {
        return String::new();
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return String::new();
    };
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = (&mut stdout).take(OUTPUT_LIMIT).read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < TIMEOUT => thread::sleep(Duration::from_millis(15)),
            Ok(None) => {
                let _ = child.kill();
                break child.wait().ok();
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = rx
        .recv_timeout(Duration::from_millis(100))
        .unwrap_or_default();
    if !status.is_some_and(|status| status.success()) {
        return String::new();
    }
    let output = String::from_utf8_lossy(&bytes);
    let normalized = safe_text(&output)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    normalized.chars().take(120).collect()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn status_commands_are_bounded_and_return_inert_text() {
        assert_eq!(
            run_status_command(r#"/bin/sh -c 'printf "a\nb"'"#, "/tmp"),
            "a b"
        );
        let start = std::time::Instant::now();
        assert_eq!(run_status_command("/bin/sh -c 'sleep 2'", "/tmp"), "");
        assert!(start.elapsed() < Duration::from_millis(1500));
        assert_eq!(percent_encode_path("/tmp/a b#界"), "/tmp/a%20b%23%E7%95%8C");
    }
}
