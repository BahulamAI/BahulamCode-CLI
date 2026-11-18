//! Adapted from the preserved 5c04734 capability report. Profile hints are
//! deliberately separate from features implemented/enabled by this renderer.
use crate::model::safe_text;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    io::{self, IsTerminal},
};

#[derive(Debug, Clone)]
pub struct TerminalCapabilities {
    pub interactive: bool,
    pub probe: crate::capability_probe::Probe,
    pub overrides: Value,
    pub query_safe: bool,
    pub dumb: bool,
    pub theme: String,
    pub theme_source: String,
    explicit_theme: bool,
    pub terminal: String,
    pub version: String,
    pub color_depth: String,
    pub color_source: String,
    pub unicode_locale: bool,
    pub mouse_capture: bool,
    pub scroll_lines: u16,
    pub tmux: bool,
    pub screen: bool,
    pub ssh: bool,
    pub wsl: bool,
    pub profile: String,
    pub clipboard_mode: String,
}

impl TerminalCapabilities {
    pub fn detect() -> Self {
        // Do not capture or report the environment wholesale (it includes secrets).
        let values = [
            "BAHULAM_TUI_CAPABILITIES",
            "BAHULAM_THEME",
            "BAHULAM_TUI_THEME_SOURCE",
            "TERM",
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "COLORTERM",
            "NO_COLOR",
            "FORCE_COLOR",
            "BAHULAM_PLAIN",
            "BAHULAM_TUI_COLOR_LEVEL",
            "BAHULAM_TUI_MOUSE",
            "BAHULAM_TUI_SCROLL_LINES",
            "BAHULAM_CLIPBOARD",
            "LC_ALL",
            "LC_CTYPE",
            "LANG",
            "TMUX",
            "STY",
            "SSH_CONNECTION",
            "SSH_TTY",
            "WSL_DISTRO_NAME",
            "WT_SESSION",
        ]
        .into_iter()
        .filter_map(|key| env::var(key).ok().map(|value| (key.to_owned(), value)))
        .collect();
        Self::from_values(
            &values,
            io::stdin().is_terminal(),
            io::stdout().is_terminal(),
        )
    }

    pub fn from_values(
        values: &HashMap<String, String>,
        stdin_tty: bool,
        stdout_tty: bool,
    ) -> Self {
        let get = |key: &str| values.get(key).map(String::as_str).unwrap_or("");
        let interactive = stdin_tty && stdout_tty;
        let term = get("TERM").to_lowercase();
        let program = get("TERM_PROGRAM");
        let force = get("FORCE_COLOR").trim();
        let host_color = get("BAHULAM_TUI_COLOR_LEVEL");
        let (color_depth, color_source) = if !get("NO_COLOR").is_empty()
            || get("BAHULAM_PLAIN") == "1"
            || matches!(force, "0" | "false")
        {
            ("none", "explicit opt-out")
        } else if ["none", "ansi16", "ansi256", "truecolor"].contains(&host_color) {
            (host_color, "Node host")
        } else if ["1", "2", "3"].contains(&force) {
            (
                match force {
                    "1" => "ansi16",
                    "2" => "ansi256",
                    _ => "truecolor",
                },
                "FORCE_COLOR",
            )
        } else if !interactive && !values.contains_key("FORCE_COLOR")
            || matches!(term.as_str(), "" | "dumb" | "unknown")
        {
            ("none", "environment")
        } else if matches!(
            get("COLORTERM").to_lowercase().as_str(),
            "truecolor" | "24bit" | "24-bit"
        ) || matches!(program, "iTerm.app" | "WezTerm")
        {
            ("truecolor", "environment/profile hint")
        } else if term.contains("256")
            || term.starts_with("xterm")
            || term.starts_with("screen")
            || term.starts_with("tmux")
            || matches!(program, "vscode" | "Apple_Terminal")
        {
            ("ansi256", "environment/profile hint")
        } else {
            ("ansi16", "environment/profile hint")
        };
        let locale = [get("LC_ALL"), get("LC_CTYPE"), get("LANG")]
            .into_iter()
            .find(|value| !value.is_empty())
            .unwrap_or("")
            .to_lowercase();
        let profile = if !get("TMUX").is_empty() || term.starts_with("tmux") {
            "tmux"
        } else if !get("STY").is_empty() || term.starts_with("screen") {
            "screen"
        } else if !get("WT_SESSION").is_empty() {
            "Windows Terminal"
        } else {
            match program.to_lowercase().as_str() {
                "vscode" => "VS Code",
                "iterm.app" => "iTerm2",
                "ghostty" => "Ghostty",
                "wezterm" => "WezTerm",
                "apple_terminal" => "Apple Terminal",
                _ if term.contains("kitty") => "Kitty",
                _ => "unknown",
            }
        };
        let configured_theme = get("BAHULAM_THEME").to_lowercase();
        let valid_theme =
            ["dark", "light", "high-contrast", "ansi"].contains(&configured_theme.as_str());
        let explicit_theme = valid_theme && get("BAHULAM_TUI_THEME_SOURCE") != "inferred";
        Self {
            interactive,
            theme: if valid_theme {
                configured_theme
            } else {
                "dark".into()
            },
            theme_source: if explicit_theme {
                "explicit configuration"
            } else if valid_theme {
                "host appearance hint"
            } else {
                "default dark"
            }
            .into(),
            explicit_theme,
            probe: crate::capability_probe::Probe::skipped("not run (diagnostic only)"),
            overrides: serde_json::from_str(get("BAHULAM_TUI_CAPABILITIES")).unwrap_or_default(),
            dumb: term == "dumb",
            query_safe: interactive && !matches!(term.as_str(), "" | "dumb" | "unknown"),
            terminal: safe_text(if program.is_empty() {
                get("TERM")
            } else {
                program
            }),
            version: safe_text(get("TERM_PROGRAM_VERSION")),
            color_depth: color_depth.into(),
            color_source: color_source.into(),
            unicode_locale: locale.contains("utf-8") || locale.contains("utf8"),
            mouse_capture: interactive
                && term != "dumb"
                && !matches!(get("BAHULAM_TUI_MOUSE"), "0" | "false" | "off"),
            scroll_lines: get("BAHULAM_TUI_SCROLL_LINES")
                .trim()
                .parse::<u16>()
                .ok()
                .filter(|lines| (1..=20).contains(lines))
                .unwrap_or(1),
            tmux: !get("TMUX").is_empty() || term.starts_with("tmux"),
            screen: !get("STY").is_empty() || term.starts_with("screen"),
            ssh: !get("SSH_CONNECTION").is_empty() || !get("SSH_TTY").is_empty(),
            wsl: !get("WSL_DISTRO_NAME").is_empty(),
            profile: profile.into(),
            clipboard_mode: match get("BAHULAM_CLIPBOARD").to_lowercase().as_str() {
                "" | "auto" => "auto",
                "native" => "native",
                "osc52" => "osc52",
                "file" => "file",
                _ => "invalid configuration",
            }
            .into(),
        }
    }

    pub fn override_value(&self, key: &str) -> Option<bool> {
        match self.overrides.get(key) {
            Some(Value::Bool(value)) => Some(*value),
            Some(Value::String(value)) => match value.as_str() {
                "on" | "true" | "enabled" => Some(true),
                "off" | "false" | "disabled" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    pub fn detected(&self, key: &str) -> Option<bool> {
        match key {
            "synchronized_output" => self.probe.synchronized_output,
            "focus_reporting" => self.probe.focus_reporting,
            "keyboard_protocol" => self.probe.keyboard_protocol,
            "mouse_sgr" => self.probe.mouse_sgr,
            "bracketed_paste" => self.probe.bracketed_paste,
            "sixel" => self.probe.sixel,
            "background_color" => self.probe.background_rgb.map(|_| true),
            _ => None,
        }
    }

    pub fn resolve(&self, key: &str, inferred: bool) -> bool {
        self.interactive
            && self
                .override_value(key)
                .or(self.detected(key))
                .unwrap_or(inferred)
    }

    pub fn probe(
        &mut self,
    ) -> std::io::Result<std::collections::VecDeque<crossterm::event::Event>> {
        let mut pending = std::collections::VecDeque::new();
        let background = self.override_value("background_color") != Some(false);
        if !self.query_safe
            || self.tmux
            || self.screen
            || !cfg!(unix)
            || self.override_value("active_probes") == Some(false)
        {
            self.probe = crate::capability_probe::Probe::skipped(
                "skipped (noninteractive, transport, platform or override)",
            );
        } else if let Some(cached) = std::env::var("BAHULAM_TUI_PROBE_CACHE")
            .ok()
            .and_then(|value| crate::capability_probe::Probe::cached(&value))
        {
            self.probe = cached;
            if background {
                self.probe.run(&mut pending, true, true)?;
            }
        } else {
            self.probe.run(&mut pending, background, false)?;
        }
        self.apply_background();
        // The legacy BAHULAM_TUI_MOUSE switch remains an explicit opt-out.
        self.mouse_capture = self.mouse_capture && self.resolve("mouse_sgr", true);
        Ok(pending)
    }

    fn apply_background(&mut self) {
        if !self.explicit_theme && self.override_value("background_color") != Some(false) {
            if let Some(rgb) = self.probe.background_rgb {
                self.theme = crate::capability_probe::background_theme(rgb).into();
                self.theme_source = "OSC11 background reply".into();
            }
        }
    }

    pub fn select_theme(&mut self, theme: &str) {
        self.theme = theme.into();
        self.theme_source = "explicit /theme command".into();
        self.explicit_theme = true;
    }

    fn feature_table(&self, attached: bool) -> Value {
        let config = crate::integrations::Config::from_caps(self);
        [
            ("synchronized_output", config.sync),
            ("focus_reporting", config.focus),
            ("keyboard_protocol", config.keyboard),
            ("osc8_links", config.links),
            ("mouse_sgr", self.mouse_capture),
            ("bracketed_paste", config.paste),
        ]
        .into_iter()
        .map(|(name, requested)| {
            let source = if self.override_value(name).is_some() {
                "override"
            } else if self.detected(name).is_some() {
                "query reply"
            } else {
                "profile/fallback (not queried or no reply)"
            };
            (
                name.to_owned(),
                json!({"detected":self.detected(name), "override":self.override_value(name),
                "source":source, "requested":requested, "enabled":attached && requested}),
            )
        })
        .collect::<serde_json::Map<String, Value>>()
        .into()
    }

    pub fn as_json(&self, view: Option<&str>, size: Option<(u16, u16)>) -> Value {
        json!({
            "detection": self.probe.status, "probe": self.probe, "features": self.feature_table(view.is_some()),
            "theme": self.theme, "theme_source": self.theme_source,
            "background": {"rgb":self.probe.background_rgb, "queried":self.probe.background_requested,
                "override":self.override_value("background_color"), "source":if self.probe.background_rgb.is_some() { "OSC11 reply" } else { "unknown" }},
            "interactive": self.interactive, "terminal": self.terminal, "terminal_version": self.version,
            "profile": self.profile, "color_depth": self.color_depth, "color_source": self.color_source,
            "unicode_locale": self.unicode_locale, "tmux": self.tmux, "screen": self.screen,
            "ssh": self.ssh, "wsl": self.wsl, "view": view, "size": size.map(|(columns, rows)| json!({"columns":columns,"rows":rows})),
            "mouse_capture": view.is_some() && self.mouse_capture,
            "mouse_requested": self.mouse_capture, "bracketed_paste": view.is_some() && crate::integrations::Config::from_caps(self).paste,
            "scroll_lines": self.scroll_lines,
            "integrations": crate::integrations::Config::from_caps(self).report(),
            "synchronized_output": crate::integrations::Config::from_caps(self).sync, "focus_reporting": crate::integrations::Config::from_caps(self).focus,
            "osc8_links": crate::integrations::Config::from_caps(self).links, "clipboard": self.clipboard_mode, "prompt_editor": "Ctrl+G via VISUAL/EDITOR", "prompt_history": "shared JSONL; Up/Down and Ctrl+R", "images": "not restored",
            "notifications": crate::integrations::Config::from_caps(self).notifications, "report": self.report(view, size),
        })
    }

    pub fn report(&self, view: Option<&str>, size: Option<(u16, u16)>) -> String {
        let yes_no = |value| if value { "yes" } else { "no" };
        [
            "Bahulam terminal capabilities".to_owned(),
            format!(
                "Detection            {} · {} ms / 200 ms budget",
                self.probe.status, self.probe.elapsed_ms
            ),
            self.feature_table(view.is_some())
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, feature)| {
                    format!(
                        "  {name:<20} detected={} requested={} enabled={} ({})",
                        feature["detected"]
                            .as_bool()
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| "unknown".into()),
                        feature["requested"],
                        feature["enabled"],
                        feature["source"].as_str().unwrap_or("unknown")
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
            format!(
                "Rust view            {}",
                view.unwrap_or("not attached (diagnostic only)")
            ),
            format!(
                "Viewport             {}",
                size.map(|(w, h)| format!("{w} x {h}"))
                    .unwrap_or_else(|| "not available".into())
            ),
            format!("Terminal             {} {}", self.terminal, self.version),
            format!("Profile hint         {}", self.profile),
            format!(
                "Theme                {} ({})",
                self.theme, self.theme_source
            ),
            format!(
                "Terminal background  {} · queried={} · override={}",
                self.probe
                    .background_rgb
                    .map(|[r, g, b]| format!("#{r:02X}{g:02X}{b:02X}"))
                    .unwrap_or_else(|| "unknown".into()),
                self.probe.background_requested,
                self.override_value("background_color")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "auto".into())
            ),
            format!("Interactive          {}", yes_no(self.interactive)),
            format!(
                "Color depth          {} ({})",
                self.color_depth, self.color_source
            ),
            format!("UTF-8 locale hint    {}", yes_no(self.unicode_locale)),
            format!(
                "Mouse capture        {}",
                if view.is_some() && self.mouse_capture {
                    "enabled"
                } else {
                    "inactive"
                }
            ),
            format!(
                "Bracketed paste      {}",
                if view.is_some() && crate::integrations::Config::from_caps(self).paste {
                    "enabled"
                } else {
                    "inactive"
                }
            ),
            format!(
                "Mouse scroll         {} lines/event (BAHULAM_TUI_SCROLL_LINES)",
                self.scroll_lines
            ),
            format!(
                "tmux / screen        {} / {}",
                yes_no(self.tmux),
                yes_no(self.screen)
            ),
            format!(
                "SSH / WSL            {} / {}",
                yes_no(self.ssh),
                yes_no(self.wsl)
            ),
            crate::integrations::Config::from_caps(self).report(),
            "Links                Click Open · Alt+L choose link · Alt+O open file/URL".to_owned(),
            "Text selection       Alt+M release mouse capture and pause redraws".to_owned(),
            format!(
                "Clipboard text       {} · Ctrl+V paste · Ctrl+Y copy",
                self.clipboard_mode
            ),
            "Prompt editor        Ctrl+G · VISUAL/EDITOR".to_owned(),
            "Prompt history       ↑↓ recall · Ctrl+R search".to_owned(),
            format!(
                "Sixel advertised     {:?} (rendering not implemented)",
                self.probe.sixel
            ),
            format!(
                "Pixel geometry       cell {:?} · window {:?} (at probe time)",
                self.probe.cell_pixels, self.probe.window_pixels
            ),
            "Graphics queries     pending; images not rendered".to_owned(),
        ]
        .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn values(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }
    #[test]
    fn host_palette_and_opt_outs_match_the_actual_renderer() {
        for (level, expected) in [
            ("ansi16", "ansi16"),
            ("ansi256", "ansi256"),
            ("truecolor", "truecolor"),
            ("none", "none"),
        ] {
            let mut env = values(&[
                ("TERM", "xterm-256color"),
                ("COLORTERM", "truecolor"),
                ("BAHULAM_TUI_COLOR_LEVEL", level),
            ]);
            assert_eq!(
                TerminalCapabilities::from_values(&env, true, true).color_depth,
                expected
            );
            env.insert("NO_COLOR".into(), "1".into());
            assert_eq!(
                TerminalCapabilities::from_values(&env, true, true).color_depth,
                "none"
            );
        }
        assert_eq!(
            TerminalCapabilities::from_values(
                &values(&[("TERM", "xterm"), ("FORCE_COLOR", "2")]),
                false,
                false
            )
            .color_depth,
            "ansi256"
        );
        assert_eq!(
            TerminalCapabilities::from_values(&values(&[("TERM", "xterm")]), false, false)
                .color_depth,
            "none"
        );
    }
    #[test]
    fn diagnostics_separate_runtime_state_from_hints_and_never_dump_environment() {
        let env = values(&[
            ("TERM", "xterm-256color"),
            ("TERM_PROGRAM", "vscode"),
            ("TMUX", "SECRET_SOCKET"),
            ("SSH_CONNECTION", "SECRET_ADDRESS"),
            ("API_KEY", "SECRET_TOKEN"),
            ("LANG", "en_US.UTF-8"),
            ("LC_ALL", "C"),
        ]);
        let caps = TerminalCapabilities::from_values(&env, true, true);
        assert!(caps.tmux && caps.ssh && !caps.unicode_locale);
        assert_eq!(caps.profile, "tmux");
        let report = caps.as_json(Some("inline"), Some((120, 40)));
        assert_eq!(report["mouse_capture"], true);
        assert_eq!(report["size"]["rows"], 40);
        assert!(!report.to_string().contains("SECRET"));
        assert_eq!(caps.as_json(None, None)["mouse_capture"], false);
        assert!(caps
            .report(None, None)
            .contains("not run (diagnostic only)"));
    }
    #[test]
    fn mouse_scroll_is_gentle_by_default_and_configurable() {
        for (value, expected) in [
            ("", 1),
            ("1", 1),
            ("3", 3),
            ("20", 20),
            ("0", 1),
            ("21", 1),
            ("-1", 1),
            ("invalid", 1),
        ] {
            let caps = TerminalCapabilities::from_values(
                &values(&[("BAHULAM_TUI_SCROLL_LINES", value)]),
                true,
                true,
            );
            assert_eq!(caps.scroll_lines, expected);
            assert_eq!(caps.as_json(Some("inline"), None)["scroll_lines"], expected);
            assert!(caps
                .report(Some("inline"), None)
                .contains(&format!("{expected} lines/event")));
        }
    }
    #[test]
    fn mouse_opt_out_and_terminal_names_are_safe() {
        let caps = TerminalCapabilities::from_values(
            &values(&[
                ("TERM_PROGRAM", "vscode\x1b[31m"),
                ("BAHULAM_TUI_MOUSE", "0"),
            ]),
            true,
            true,
        );
        assert!(!caps.mouse_capture);
        assert!(!caps.report(Some("inline"), None).contains('\x1b'));
    }

    #[test]
    fn mode_overrides_take_precedence_without_claiming_detection() {
        let mut caps = TerminalCapabilities::from_values(
            &values(&[
                ("TERM", "xterm-256color"),
                ("TERM_PROGRAM", "ghostty"),
                (
                    "BAHULAM_TUI_CAPABILITIES",
                    r#"{"keyboard_protocol":true,"synchronized_output":"auto"}"#,
                ),
            ]),
            true,
            true,
        );
        caps.probe.status = "active (DA1 received)".into();
        caps.probe.complete = true;
        caps.probe.keyboard_protocol = Some(false);
        caps.probe.synchronized_output = Some(false);
        let config = crate::integrations::Config::from_caps(&caps);
        assert!(config.keyboard);
        assert!(!config.sync);
        let table = caps.feature_table(true);
        assert_eq!(table["keyboard_protocol"]["source"], "override");
        assert_eq!(table["keyboard_protocol"]["detected"], false);
        assert_eq!(table["synchronized_output"]["source"], "query reply");
        // Explicit opt-in still cannot emit mode sequences into a pipe.
        caps.interactive = false;
        assert!(!crate::integrations::Config::from_caps(&caps).keyboard);
    }

    #[test]
    fn automatic_background_preserves_explicit_themes_and_capability_opt_out() {
        for (theme, source, override_json, expected) in [
            ("dark", "inferred", "{}", "light"),
            ("dark", "explicit", "{}", "dark"),
            ("ansi", "", "{}", "ansi"),
            ("high-contrast", "explicit", "{}", "high-contrast"),
            ("dark", "inferred", r#"{"background_color":false}"#, "dark"),
        ] {
            let mut caps = TerminalCapabilities::from_values(
                &values(&[
                    ("TERM", "xterm-256color"),
                    ("BAHULAM_THEME", theme),
                    ("BAHULAM_TUI_THEME_SOURCE", source),
                    ("BAHULAM_TUI_CAPABILITIES", override_json),
                    ("NO_COLOR", "1"),
                ]),
                true,
                true,
            );
            caps.probe.background_rgb = Some([255, 255, 255]);
            caps.apply_background();
            assert_eq!(caps.theme, expected);
            assert_eq!(caps.color_depth, "none");
            caps.select_theme("dark");
            caps.apply_background();
            assert_eq!(caps.theme, "dark");
            assert_eq!(
                caps.as_json(Some("inline"), None)["theme_source"],
                "explicit /theme command"
            );
        }
    }
}
