//! One bounded query batch, sharing crossterm's input reader with the composer.
//! Never use crossterm's separate two-second keyboard query here.
use crossterm::event::{self, Event};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    io::{self, Write},
    time::{Duration, Instant},
};

pub const BUDGET: Duration = Duration::from_millis(200);
// DA1 is last: terminals process these queries in order. No clipboard reads
// or graphics payloads. OSC11 replies share the input reader's bounded decoder.
const QUERIES: &str = "\x1b[?2026$p\x1b[?1004$p\x1b[?1006$p\x1b[?2004$p\x1b[?u\x1b[16t\x1b[14t";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Probe {
    pub status: String,
    pub elapsed_ms: u64,
    pub complete: bool,
    pub synchronized_output: Option<bool>,
    pub focus_reporting: Option<bool>,
    pub mouse_sgr: Option<bool>,
    pub bracketed_paste: Option<bool>,
    pub keyboard_protocol: Option<bool>,
    pub sixel: Option<bool>,
    pub background_requested: bool,
    pub background_rgb: Option<[u8; 3]>,
    /// [width, height]. Informational only: re-query after resize before images.
    pub cell_pixels: Option<[u16; 2]>,
    pub window_pixels: Option<[u16; 2]>,
}

impl Probe {
    pub fn skipped(reason: &str) -> Self {
        Self {
            status: reason.into(),
            ..Self::default()
        }
    }

    /// Parse only numeric replies to our query set, not arbitrary terminal output.
    pub fn accept(&mut self, reply: &str) {
        if reply.len() > 128 {
            return;
        }
        if let Some(body) = reply.strip_prefix("\x1b]11;") {
            if let Some(rgb) = body
                .strip_suffix('\x07')
                .or_else(|| body.strip_suffix("\x1b\\"))
                .and_then(parse_rgb)
            {
                self.background_rgb = Some(rgb);
            }
            return;
        }
        let Some(csi) = reply.strip_prefix("\x1b[") else {
            return;
        };
        let numbers = |s: &str| -> Option<Vec<u16>> {
            if s.is_empty() {
                return None;
            }
            s.split(';')
                .map(|part| {
                    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
                        None
                    } else {
                        part.parse().ok()
                    }
                })
                .collect()
        };
        if let Some(private) = csi.strip_prefix('?') {
            if let Some(body) = private.strip_suffix("$y") {
                if let Some(v) = numbers(body).filter(|v| v.len() == 2 && v[1] <= 4) {
                    // 0 is unrecognized; 4 permanently reset cannot be enabled.
                    let supported = Some(matches!(v[1], 1..=3));
                    match v[0] {
                        2026 => self.synchronized_output = supported,
                        1004 => self.focus_reporting = supported,
                        1006 => self.mouse_sgr = supported,
                        2004 => self.bracketed_paste = supported,
                        _ => {}
                    }
                }
            } else if let Some(body) = private.strip_suffix('u') {
                if numbers(body).is_some_and(|v| v.len() == 1) {
                    self.keyboard_protocol = Some(true);
                }
            } else if let Some(body) = private.strip_suffix('c') {
                if let Some(v) = numbers(body).filter(|v| !v.is_empty()) {
                    self.sixel = Some(v.iter().skip(1).any(|v| *v == 4));
                    // DA1 confirms the preceding keyboard query was processed.
                    self.keyboard_protocol.get_or_insert(false);
                    self.complete = true;
                }
            }
        } else if let Some(body) = csi.strip_suffix('t') {
            if let Some(v) = numbers(body).filter(|v| v.len() == 3 && v[1] > 0 && v[2] > 0) {
                match v[0] {
                    4 => self.window_pixels = Some([v[2], v[1]]),
                    6 => self.cell_pixels = Some([v[2], v[1]]),
                    _ => {}
                }
            }
        }
    }

    /// Cache only a completed batch. Dimensions can change between attachments.
    pub fn cached(value: &str) -> Option<Self> {
        if value.len() > 4096 {
            return None;
        }
        let mut probe: Self = serde_json::from_str(value).ok()?;
        if !probe.complete {
            return None;
        }
        probe.status = "cached (same host terminal identity/version)".into();
        probe.elapsed_ms = 0;
        probe.cell_pixels = None;
        probe.window_pixels = None;
        probe.background_rgb = None;
        probe.background_requested = false;
        Some(probe)
    }

    /// Call only in raw mode and on the main input thread. Timeout does not spawn
    /// a reader; late replies remain typed events, ignored by the main UI loop.
    pub fn run(
        &mut self,
        pending: &mut VecDeque<Event>,
        background: bool,
        cached_modes: bool,
    ) -> io::Result<()> {
        let start = Instant::now();
        let deadline = start + BUDGET;
        self.complete = false;
        self.background_rgb = None;
        self.background_requested = background;
        let queries = format!(
            "{}{}\x1b[c",
            if background { "\x1b]11;?\x1b\\" } else { "" },
            if cached_modes { "" } else { QUERIES }
        );
        io::stdout().write_all(queries.as_bytes())?;
        io::stdout().flush()?;
        self.status = if cached_modes {
            "active (cached modes; background deadline reached)"
        } else {
            "active (deadline reached; missing replies unknown)"
        }
        .into();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            if pending.len() >= 4096 {
                self.status = "active (input queue limit; missing replies unknown)".into();
                break;
            }
            if !event::poll(left)? {
                break;
            }
            match event::read()? {
                Event::TerminalResponse(reply) => self.accept(&reply),
                input => pending.push_back(input),
            }
            if self.complete {
                self.status = if cached_modes {
                    "active (cached modes; background refreshed)"
                } else {
                    "active (DA1 received)"
                }
                .into();
                break;
            }
        }
        self.elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(())
    }
}

fn parse_rgb(text: &str) -> Option<[u8; 3]> {
    let mut parts = text.strip_prefix("rgb:")?.split('/');
    let mut rgb = [0; 3];
    for component in &mut rgb {
        let text = parts.next()?;
        if text.is_empty() || text.len() > 4 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let value = u32::from_str_radix(text, 16).ok()?;
        let max = (1u32 << (text.len() * 4)) - 1;
        *component = ((value * 255 + max / 2) / max) as u8;
    }
    if parts.next().is_some() {
        None
    } else {
        Some(rgb)
    }
}

pub fn background_theme(rgb: [u8; 3]) -> &'static str {
    let linear = rgb.map(|v| {
        let v = f64::from(v) / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    });
    // Choose dark text (light theme) when it has higher background contrast.
    if linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 > 0.179 {
        "light"
    } else {
        "dark"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_background_accepts_hex_precision_and_both_terminators() {
        let mut p = Probe::default();
        for (reply, expected) in [
            ("\x1b]11;rgb:f/f/f\x07", [255, 255, 255]),
            ("\x1b]11;rgb:00/00/00\x1b\\", [0, 0, 0]),
            ("\x1b]11;rgb:1234/abcd/ffff\x07", [18, 171, 255]),
            ("\x1b]11;rgb:800/800/800\x1b\\", [128, 128, 128]),
        ] {
            p.accept(reply);
            assert_eq!(p.background_rgb, Some(expected));
        }
        for reply in [
            "\x1b]11;rgb:ff/ff/xx\x07",
            "\x1b]11;rgb:fffff/0/0\x07",
            "\x1b]11;rgb:f/f/f/f\x07",
            "\x1b]11;rgb:f/f/f",
            "\x1b]11;rgb:/f/f\x07",
        ] {
            p.background_rgb = None;
            p.accept(reply);
            assert!(p.background_rgb.is_none());
        }
        assert_eq!(background_theme([255, 255, 255]), "light");
        assert_eq!(background_theme([20, 30, 40]), "dark");
        assert_eq!(background_theme([128, 128, 128]), "light");
    }

    #[test]
    fn replies_distinguish_negative_from_unknown_and_do_not_trust_malformed_values() {
        let mut p = Probe::default();
        for s in [
            "\x1b[?2026;2$y",
            "\x1b[?1004;0$y",
            "\x1b[?2004;4$y",
            "\x1b[?0u",
            "\x1b[6;20;10t",
            "\x1b[4;800;1200t",
            "\x1b[?64;1;4c",
        ] {
            p.accept(s);
        }
        assert!(p.complete);
        assert_eq!(p.synchronized_output, Some(true));
        assert_eq!(p.focus_reporting, Some(false));
        assert_eq!(p.bracketed_paste, Some(false));
        assert_eq!(p.mouse_sgr, None);
        assert_eq!(p.keyboard_protocol, Some(true));
        assert_eq!(p.sixel, Some(true));
        assert_eq!(p.cell_pixels, Some([10, 20]));
        assert_eq!(p.window_pixels, Some([1200, 800]));
        for s in [
            "\x1b[?2026;5$y",
            "\x1b[?1006;2;3$y",
            "\x1b[6;0;10t",
            "\x1b[?1006;+1$y",
        ] {
            p.accept(s);
        }
        assert_eq!(p.mouse_sgr, None);
        assert_eq!(p.cell_pixels, Some([10, 20]));
        let cached = Probe::cached(&serde_json::to_string(&p).unwrap()).unwrap();
        assert!(cached.complete && cached.cell_pixels.is_none() && cached.window_pixels.is_none());
        assert_eq!(cached.synchronized_output, Some(true));
        assert!(Probe::cached("{\"complete\":false}").is_none());
    }
}
