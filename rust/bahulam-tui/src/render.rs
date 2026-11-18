use crate::composer::PromptLayout;
use crate::model::{safe_text, Model};
use ratatui::{
    layout::{Constraint, Direction, Layout, Margin, Position, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Padding, Paragraph, Wrap},
    Frame,
};
use std::sync::OnceLock;
use std::{
    cell::RefCell,
    collections::{hash_map::DefaultHasher, HashMap, HashSet, VecDeque},
    hash::{Hash, Hasher},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy, Debug)]
struct Palette {
    accent: Color,
    text: Color,
    muted: Color,
    border: Color,
    selection: Color,
    input_bg: Color,
    info: Color,
    details: Color,
    tool: Color,
    error: Color,
    success: Color,
    warning: Color,
    danger: Color,
    code: Color,
    agent_colors: [Color; 5],
}

fn ascii_glyphs() -> bool {
    static ASCII: OnceLock<bool> = OnceLock::new();
    *ASCII.get_or_init(|| {
        if let Ok(value) = std::env::var("BAHULAM_ASCII") {
            return matches!(value.trim(), "1" | "true" | "yes" | "on");
        }
        let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
            .into_iter()
            .filter_map(|name| std::env::var(name).ok())
            .find(|value| !value.is_empty())
            .unwrap_or_default()
            .to_ascii_lowercase();
        !locale.contains("utf-8") && !locale.contains("utf8")
    })
}

fn status_glyph(unicode: &'static str) -> &'static str {
    if !ascii_glyphs() {
        return unicode;
    }
    match unicode {
        "○" => ".",
        "◐" => "*",
        "✓" => "+",
        "✗" => "x",
        "⊘" => "-",
        "•" => "*",
        "›" => ">",
        _ => unicode,
    }
}

fn model_label_text(model: &Model) -> String {
    let mut label = middle_ellipsis(&safe_text(&model.model), 28);
    if !model.model_mode.is_empty() {
        label.push_str(&format!(" · {}", safe_text(&model.model_mode)));
    }
    if model.model_route.eq_ignore_ascii_case("byok") {
        label.push_str(" · BYOK");
    }
    label
}

fn palette(theme: &str) -> Palette {
    static HOST_TOKENS: OnceLock<serde_json::Value> = OnceLock::new();
    let tokens = HOST_TOKENS.get_or_init(|| {
        std::env::var("BAHULAM_TUI_PALETTE")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    });
    let level = std::env::var("BAHULAM_TUI_COLOR_LEVEL").unwrap_or_else(|_| "truecolor".into());
    let disabled = std::env::var("NO_COLOR").is_ok_and(|value| !value.is_empty())
        || std::env::var("FORCE_COLOR").is_ok_and(|value| matches!(value.trim(), "0" | "false"));
    resolved_palette(theme, if disabled { "none" } else { &level }, tokens)
}

fn resolved_palette(theme: &str, level: &str, tokens: &serde_json::Value) -> Palette {
    if level == "none" {
        return Palette {
            accent: Color::Reset,
            text: Color::Reset,
            muted: Color::Reset,
            border: Color::Reset,
            selection: Color::Reset,
            input_bg: Color::Reset,
            info: Color::Reset,
            details: Color::Reset,
            tool: Color::Reset,
            error: Color::Reset,
            success: Color::Reset,
            warning: Color::Reset,
            danger: Color::Reset,
            code: Color::Reset,
            agent_colors: [Color::Reset; 5],
        };
    }
    let mut p = match theme {
        "light" => Palette {
            accent: Color::Rgb(49, 91, 154),
            text: Color::Rgb(32, 42, 56),
            muted: Color::Rgb(82, 98, 118),
            border: Color::Rgb(195, 205, 217),
            selection: Color::Rgb(226, 235, 246),
            input_bg: Color::Rgb(242, 246, 251),
            info: Color::Rgb(49, 91, 154),
            details: Color::Rgb(92, 101, 114),
            tool: Color::Rgb(48, 59, 160),
            error: Color::Rgb(173, 54, 63),
            success: Color::Rgb(35, 114, 76),
            warning: Color::Rgb(132, 82, 0),
            danger: Color::Rgb(165, 42, 50),
            code: Color::Rgb(98, 79, 136),
            agent_colors: [
                Color::Rgb(49, 91, 154),
                Color::Rgb(113, 80, 155),
                Color::Rgb(144, 85, 44),
                Color::Rgb(35, 108, 104),
                Color::Rgb(150, 61, 87),
            ],
        },
        "high-contrast" => Palette {
            accent: Color::Cyan,
            text: Color::White,
            muted: Color::Rgb(220, 230, 242),
            border: Color::Gray,
            selection: Color::Rgb(0, 54, 112),
            input_bg: Color::Rgb(0, 0, 0),
            info: Color::LightBlue,
            details: Color::Gray,
            tool: Color::LightBlue,
            error: Color::Red,
            success: Color::Green,
            warning: Color::Yellow,
            danger: Color::Red,
            code: Color::Cyan,
            agent_colors: [
                Color::Cyan,
                Color::Magenta,
                Color::Yellow,
                Color::Green,
                Color::White,
            ],
        },
        "ansi" => Palette {
            accent: Color::Cyan,
            text: Color::Reset,
            muted: Color::DarkGray,
            border: Color::DarkGray,
            selection: Color::Blue,
            input_bg: Color::Reset,
            info: Color::LightBlue,
            details: Color::Gray,
            tool: Color::LightBlue,
            error: Color::Red,
            success: Color::Green,
            warning: Color::Yellow,
            danger: Color::Red,
            code: Color::Blue,
            agent_colors: [
                Color::Cyan,
                Color::Magenta,
                Color::Yellow,
                Color::Green,
                Color::Blue,
            ],
        },
        _ => Palette {
            accent: Color::Rgb(120, 166, 232),
            text: Color::Rgb(215, 222, 232),
            muted: Color::Rgb(153, 165, 178),
            border: Color::Rgb(57, 69, 82),
            selection: Color::Rgb(43, 61, 84),
            input_bg: Color::Rgb(28, 38, 51),
            info: Color::Rgb(146, 197, 255),
            details: Color::Rgb(188, 196, 208),
            tool: Color::Rgb(48, 59, 160),
            error: Color::Rgb(173, 54, 63),
            success: Color::Rgb(114, 184, 148),
            warning: Color::Rgb(216, 173, 99),
            danger: Color::Rgb(216, 121, 121),
            code: Color::Rgb(181, 193, 210),
            agent_colors: [
                Color::Rgb(120, 166, 232),
                Color::Rgb(182, 147, 214),
                Color::Rgb(214, 154, 112),
                Color::Rgb(106, 183, 167),
                Color::Rgb(207, 141, 159),
            ],
        },
    };
    let level = if theme == "ansi" { "ansi16" } else { level };
    // The live host supplies the canonical Node tokens at all three depths.
    // Replay without a host retains the standalone palettes above.
    if theme != "high-contrast" {
        let values = &tokens[if theme == "light" { "light" } else { "dark" }];
        for (color, name) in [
            (&mut p.accent, "brand.primary"),
            (&mut p.text, "text.primary"),
            (&mut p.muted, "text.muted"),
            (&mut p.success, "state.success"),
            (&mut p.warning, "state.warn"),
            (&mut p.danger, "state.danger"),
        ] {
            if let Some(value) = token_color(&values[name], level) {
                *color = value;
            }
        }
        for (color, name) in p.agent_colors.iter_mut().zip([
            "brand.primary",
            "brand.accent",
            "brand.data",
            "syntax.literal",
            "state.success",
        ]) {
            if let Some(value) = token_color(&values[name], level) {
                *color = value;
            }
        }
    }
    // Rust actions have their own roles: blue tools/links/code, quieter grey details.
    p.code = p.info;
    if !matches!(theme, "ansi" | "high-contrast") {
        p.danger = Color::Rgb(255, 176, 182);
    }
    for color in [
        &mut p.accent,
        &mut p.text,
        &mut p.muted,
        &mut p.border,
        &mut p.selection,
        &mut p.input_bg,
        &mut p.info,
        &mut p.details,
        &mut p.tool,
        &mut p.error,
        &mut p.success,
        &mut p.warning,
        &mut p.danger,
        &mut p.code,
    ]
    .into_iter()
    .chain(p.agent_colors.iter_mut())
    {
        *color = limit_color(*color, level);
    }
    if level == "ansi16" {
        p.input_bg = Color::Reset;
    }
    p
}

fn token_color(token: &serde_json::Value, level: &str) -> Option<Color> {
    Some(match level {
        "ansi16" => match token["ansi16"].as_str()? {
            "black" => Color::Black,
            "red" => Color::Red,
            "green" => Color::Green,
            "yellow" => Color::Yellow,
            "blue" => Color::Blue,
            "magenta" => Color::Magenta,
            "cyan" => Color::Cyan,
            "white" => Color::Gray,
            "gray" => Color::DarkGray,
            _ => return None,
        },
        "ansi256" => Color::Indexed(u8::try_from(token["ansi256"].as_u64()?).ok()?),
        _ => Color::Rgb(
            u8::try_from(token["rgb"][0].as_u64()?).ok()?,
            u8::try_from(token["rgb"][1].as_u64()?).ok()?,
            u8::try_from(token["rgb"][2].as_u64()?).ok()?,
        ),
    })
}

fn limit_color(color: Color, level: &str) -> Color {
    let Color::Rgb(r, g, b) = color else {
        return color;
    };
    if level == "ansi256" {
        // Find the nearest fixed xterm color, including its grayscale ramp.
        let index = (16u16..=255)
            .min_by_key(|index| {
                let (cr, cg, cb) = if *index >= 232 {
                    let gray = 8 + (*index - 232) as i32 * 10;
                    (gray, gray, gray)
                } else {
                    let cube = [0, 95, 135, 175, 215, 255];
                    let n = (*index - 16) as usize;
                    (cube[n / 36], cube[n / 6 % 6], cube[n % 6])
                };
                (r as i32 - cr).pow(2) + (g as i32 - cg).pow(2) + (b as i32 - cb).pow(2)
            })
            .unwrap_or(16);
        return Color::Indexed(index as u8);
    }
    if level == "ansi16" {
        return if r.max(g).max(b) < 90 {
            Color::DarkGray
        } else if r.abs_diff(g) < 35 && g.abs_diff(b) < 35 {
            Color::Gray
        } else if b >= r && b >= g {
            Color::Blue
        } else if g >= r {
            Color::Green
        } else {
            Color::Red
        };
    }
    color
}

#[cfg(test)]
mod palette_tests {
    use super::*;

    #[test]
    fn host_tokens_select_theme_and_exact_color_depth() {
        let tokens = serde_json::json!({
            "dark": {"brand.primary": {"rgb": [190,198,255], "ansi256":147, "ansi16":"blue"}},
            "light": {"brand.primary": {"rgb": [48,59,160], "ansi256":61, "ansi16":"blue"}}
        });
        assert_eq!(
            resolved_palette("dark", "truecolor", &tokens).accent,
            Color::Rgb(190, 198, 255)
        );
        assert_eq!(
            resolved_palette("light", "truecolor", &tokens).accent,
            Color::Rgb(48, 59, 160)
        );
        assert_eq!(
            resolved_palette("light", "ansi256", &tokens).accent,
            Color::Indexed(61)
        );
        assert_eq!(
            resolved_palette("dark", "ansi16", &tokens).accent,
            Color::Blue
        );
        assert_eq!(
            resolved_palette("ansi", "truecolor", &tokens).accent,
            Color::Blue
        );
    }

    #[test]
    fn limited_terminals_never_receive_rgb_and_no_color_clears_all_styles() {
        for theme in ["dark", "light", "ansi", "high-contrast"] {
            for level in ["none", "ansi16", "ansi256"] {
                let p = resolved_palette(theme, level, &serde_json::Value::Null);
                for color in [
                    p.accent,
                    p.text,
                    p.muted,
                    p.border,
                    p.selection,
                    p.input_bg,
                    p.info,
                    p.details,
                    p.tool,
                    p.error,
                    p.success,
                    p.warning,
                    p.danger,
                    p.code,
                ]
                .into_iter()
                .chain(p.agent_colors)
                {
                    assert!(!matches!(color, Color::Rgb(..)));
                    if level == "none" {
                        assert_eq!(color, Color::Reset);
                    }
                    if level == "ansi16" {
                        assert!(!matches!(color, Color::Indexed(_)));
                    }
                }
            }
        }
    }
}

struct ViewLayout {
    rows: [Rect; 6],
    columns: [Rect; 2],
    compact: bool,
}

fn view_layout(area: Rect, input: &str, approval: bool) -> ViewLayout {
    let compact = area.width < 72 || area.height < 16;
    let prompt_height = if approval {
        7.min(area.height.saturating_sub(12).max(4))
    } else if PromptLayout::new(input, area.width.saturating_sub(4) as usize)
        .lines
        .len()
        > 1
    {
        (PromptLayout::new(input, area.width.saturating_sub(4) as usize)
            .lines
            .len() as u16
            + 3)
        .clamp(5, 8)
        .min(area.height.saturating_sub(12).max(4))
    } else {
        4
    };
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(6),
            Constraint::Length(prompt_height),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .areas(area);
    let columns = if compact {
        [rows[1], Rect::default()]
    } else {
        Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(74), Constraint::Percentage(26)])
            .areas(rows[1])
    };
    ViewLayout {
        rows,
        columns,
        compact,
    }
}

fn inline_layout(area: Rect, input: &str, approval: bool) -> ViewLayout {
    let prompt_height = if approval {
        7
    } else {
        (PromptLayout::new(input, area.width.saturating_sub(2) as usize)
            .lines
            .len() as u16
            + 2
            + u16::from(input.trim_start().starts_with('/')))
        .clamp(3, 7)
    };
    let rows = Layout::vertical([
        Constraint::Length(0),
        Constraint::Min(3),
        Constraint::Length(0),
        Constraint::Length(prompt_height),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area);
    ViewLayout {
        columns: [rows[1], Rect::default()],
        rows,
        compact: true,
    }
}

fn transcript_rect(area: Rect, inline: bool) -> Rect {
    area.inner(Margin {
        horizontal: if inline { 1 } else { 2 },
        vertical: if inline { 0 } else { 1 },
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserLinkHit {
    pub area: Rect,
    pub target: crate::open_target::LinkTarget,
    pub text: String,
    pub style: Style,
}
thread_local! {
    static BROWSER_LINK_HITS: RefCell<Vec<BrowserLinkHit>> = const { RefCell::new(Vec::new()) };
}
/// Targets come from this frame's clipped rows, never from guessed card positions.
pub fn painted_browser_links() -> Vec<BrowserLinkHit> {
    BROWSER_LINK_HITS.with(|hits| hits.borrow().clone())
}
pub fn browser_link_at(position: Position) -> Option<BrowserLinkHit> {
    BROWSER_LINK_HITS.with(|hits| {
        hits.borrow()
            .iter()
            .find(|hit| hit.area.contains(position))
            .cloned()
    })
}

fn browser_actions(card: &crate::model::Card, p: Palette, width: usize) -> Vec<Line<'static>> {
    if width < 16 {
        return Vec::new();
    }
    crate::browser_links::for_card(card)
        .into_iter()
        .enumerate()
        .map(|(i, link)| {
            let prefix = format!("   ↗ Open {} · ", i + 1);
            let remaining = width.saturating_sub(UnicodeWidthStr::width(prefix.as_str()));
            let label = if link.label == link.uri || remaining < 12 {
                String::new()
            } else {
                format!(
                    "{} · ",
                    middle_ellipsis(&safe_text(&link.label), (remaining / 4).min(24))
                )
            };
            let url = middle_ellipsis(
                &link.uri,
                remaining.saturating_sub(UnicodeWidthStr::width(label.as_str())),
            );
            Line::from(Span::styled(
                format!("{prefix}{label}{url}"),
                Style::default()
                    .fg(p.info)
                    .add_modifier(Modifier::UNDERLINED),
            ))
        })
        .collect()
}

/// Locate the actual painted details action, including wrapped rows and tail-follow.
#[allow(clippy::too_many_arguments)]
pub fn details_at(
    model: &Model,
    area: Rect,
    input: &str,
    inline: bool,
    expanded: &HashSet<usize>,
    theme: &str,
    agent_filter: Option<&str>,
    scroll: u16,
    position: Position,
) -> Option<usize> {
    if model.interaction.is_some() {
        return None;
    }
    let layout = if inline {
        inline_layout(area, input, model.approval.is_some())
    } else {
        view_layout(area, input, model.approval.is_some())
    };
    let inner = transcript_rect(layout.columns[0], inline);
    if !inner.contains(position) {
        return None;
    }
    let geometry = history_geometry(model, area, input, inline, expanded, theme, agent_filter);
    let offset = if scroll == u16::MAX {
        geometry.end
    } else {
        scroll
    };
    let row = offset as usize + (position.y - inner.y) as usize;
    let (index, start) = geometry
        .cards
        .iter()
        .rev()
        .find(|(_, start)| *start as usize <= row)?;
    let card = &model.cards[*index];
    if card.is_message() {
        return None;
    }
    let lines = wrap_rows(
        card_lines(
            card,
            *index,
            expanded,
            None,
            palette(theme),
            inner.width as usize,
            usize::MAX,
        ),
        inner.width as usize,
    );
    let line = lines.get(row - *start as usize)?;
    let text: String = line
        .spans
        .iter()
        .map(|span| span.content.as_ref())
        .collect();
    let label = if text.contains("Show less") {
        "Show less"
    } else {
        "Show details"
    };
    let action = text.find(label)?;
    let left = UnicodeWidthStr::width(&text[..action]);
    let col = (position.x - inner.x) as usize;
    (col >= left && col < left + label.len()).then_some(*index)
}

#[derive(Debug, PartialEq, Eq)]
pub enum MousePanel {
    Transcript,
    Agents,
    Composer,
}

/// Use the painted layout; a modal owns input even when the pointer is outside it.
pub fn mouse_panel_at(
    area: Rect,
    model: &Model,
    input: &str,
    position: Position,
) -> Option<MousePanel> {
    if model.interaction.is_some() || model.approval.is_some() {
        return None;
    }
    mouse_panel_at_view(area, model, input, position, false)
}

pub fn prompt_cursor_at(
    area: Rect,
    model: &Model,
    input: &str,
    cursor: usize,
    position: Position,
    inline: bool,
) -> Option<usize> {
    if model.approval.is_some() || model.interaction.is_some() {
        return None;
    }
    let layout = if inline {
        inline_layout(area, input, false)
    } else {
        view_layout(area, input, false)
    };
    let bounds = layout.rows[3];
    if !bounds.contains(position) {
        return None;
    }
    let padding = if inline { 1 } else { 2 };
    let prompt = PromptLayout::new(
        input,
        bounds.width.saturating_sub(padding * 2).max(1) as usize,
    );
    let suggestions = 0;
    let visible = bounds
        .height
        .saturating_sub(2)
        .saturating_sub(suggestions)
        .max(1);
    let scroll = prompt
        .cursor(cursor)
        .0
        .saturating_sub(visible.saturating_sub(1) as usize);
    Some(prompt.offset_at(
        position.y.saturating_sub(bounds.y + 1) as usize + scroll,
        position.x.saturating_sub(bounds.x + padding) as usize,
    ))
}

pub fn mouse_panel_at_view(
    area: Rect,
    model: &Model,
    input: &str,
    position: Position,
    inline: bool,
) -> Option<MousePanel> {
    if model.interaction.is_some() || model.approval.is_some() {
        return None;
    }
    let layout = if inline {
        inline_layout(area, input, false)
    } else {
        view_layout(area, input, false)
    };
    if layout.rows[3].contains(position) {
        return Some(MousePanel::Composer);
    }
    if inline && position.y < layout.rows[3].y {
        return Some(MousePanel::Transcript);
    }
    let inset = Margin {
        horizontal: 1,
        vertical: 1,
    };
    if layout.columns[0].inner(inset).contains(position) {
        Some(MousePanel::Transcript)
    } else if !layout.compact && layout.columns[1].inner(inset).contains(position) {
        Some(MousePanel::Agents)
    } else {
        None
    }
}

pub fn draw(frame: &mut Frame, model: &Model, scroll: u16) {
    draw_with_input(
        frame,
        model,
        scroll,
        false,
        "dark",
        "",
        0,
        &HashSet::new(),
        None,
        false,
        None,
        None,
        0,
        None,
        0,
    );
}

#[allow(clippy::too_many_arguments)]
pub fn draw_with_input(
    frame: &mut Frame,
    model: &Model,
    scroll: u16,
    live: bool,
    theme: &str,
    input: &str,
    cursor: usize,
    expanded: &HashSet<usize>,
    focused: Option<usize>,
    interactive: bool,
    agent_filter: Option<&str>,
    focused_agent: Option<usize>,
    focus_panel: u8,
    detail_card: Option<usize>,
    detail_scroll: u16,
) {
    draw_with_view(
        frame,
        model,
        scroll,
        live,
        theme,
        input,
        cursor,
        expanded,
        focused,
        interactive,
        agent_filter,
        focused_agent,
        focus_panel,
        detail_card,
        detail_scroll,
        false,
    );
}

#[allow(clippy::too_many_arguments)]
pub fn draw_with_view(
    frame: &mut Frame,
    model: &Model,
    scroll: u16,
    live: bool,
    theme: &str,
    input: &str,
    cursor: usize,
    expanded: &HashSet<usize>,
    focused: Option<usize>,
    interactive: bool,
    agent_filter: Option<&str>,
    focused_agent: Option<usize>,
    focus_panel: u8,
    detail_card: Option<usize>,
    detail_scroll: u16,
    inline: bool,
) {
    BROWSER_LINK_HITS.with(|hits| hits.borrow_mut().clear());
    let p = palette(theme);
    let area = frame.area();
    let ViewLayout {
        rows,
        columns,
        compact,
    } = if inline {
        inline_layout(area, input, model.approval.is_some())
    } else {
        view_layout(area, input, model.approval.is_some())
    };
    let header = Line::from(vec![
        Span::styled(
            " BAHULAM ",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            if live { "● LIVE" } else { "◷ REPLAY" },
            Style::default().fg(if live { p.success } else { p.muted }),
        ),
        Span::styled(
            format!("  {}", model_label_text(model)),
            Style::default().fg(p.text),
        ),
        Span::styled(
            format!(
                "  {}",
                middle_ellipsis(
                    &safe_text(&model.cwd),
                    area.width.saturating_sub(42).max(8) as usize
                )
            ),
            Style::default().fg(p.muted),
        ),
    ]);
    frame.render_widget(Paragraph::new(header), rows[0]);

    let transcript = if let Some(index) = detail_card {
        model
            .cards
            .get(index)
            .map(|card| detail_lines(card, p))
            .unwrap_or_default()
    } else {
        let inner = transcript_rect(columns[0], inline);
        let rendered = transcript_lines(
            model,
            expanded,
            focused,
            p,
            inner.width as usize,
            agent_filter,
            scroll,
            inner.height as usize,
        );
        if model.interaction.is_none() && model.approval.is_none() {
            let hits = rendered
                .iter()
                .enumerate()
                .filter_map(|(row, (line, target))| {
                    let target = target.clone()?;
                    let text = line
                        .spans
                        .iter()
                        .map(|span| span.content.as_ref())
                        .collect::<String>();
                    // Leading indentation is not a browser action.
                    let label = text.strip_prefix("   ")?.to_owned();
                    Some(BrowserLinkHit {
                        area: Rect::new(
                            inner.x + 3,
                            inner.y + row as u16,
                            UnicodeWidthStr::width(label.as_str()) as u16,
                            1,
                        ),
                        target,
                        text: label,
                        style: line
                            .spans
                            .first()
                            .map(|span| span.style)
                            .unwrap_or_default(),
                    })
                })
                .collect();
            BROWSER_LINK_HITS.with(|cache| *cache.borrow_mut() = hits);
        }
        rendered.into_iter().map(|(line, _)| line).collect()
    };
    let title = if let Some(index) = detail_card {
        model
            .cards
            .get(index)
            .map(|card| {
                format!(
                    " Details · {} · ↑↓ scroll · Esc return ",
                    safe_text(&card.title)
                )
            })
            .unwrap_or_else(|| " Details ".into())
    } else if let Some(agent) = agent_filter {
        let label = model
            .agents
            .iter()
            .find(|row| row.id == agent)
            .map(|row| row.label.as_str())
            .unwrap_or(agent);
        format!(" Agent detail  ·  {} ", safe_text(label))
    } else if live {
        format!(" Conversation  ·  seq {} ", model.last_seq)
    } else {
        " Conversation  ·  replay ".into()
    };
    frame.render_widget(
        Paragraph::new(transcript)
            .style(Style::default().fg(p.text))
            .wrap(Wrap { trim: false })
            .scroll((
                if detail_card.is_some() {
                    detail_scroll
                } else {
                    0
                },
                0,
            ))
            .block({
                let block = Block::default()
                    .padding(Padding::horizontal(1))
                    .borders(if inline { Borders::NONE } else { Borders::ALL })
                    .border_style(Style::default().fg(if interactive && focus_panel == 1 {
                        p.accent
                    } else {
                        p.border
                    }));
                // Even an empty title reserves a row and would hide the final details action.
                if inline && detail_card.is_none() {
                    block
                } else {
                    block.title(title)
                }
            }),
        columns[0],
    );

    let mut plan_and_agents = Vec::new();
    if compact {
        plan_and_agents.push(Line::from(Span::styled(
            "PLAN",
            Style::default().fg(p.text).add_modifier(Modifier::BOLD),
        )));
        plan_and_agents.extend(model.plan.iter().take(2).map(|item| plan_line(item, p)));
        if let Some(agent) = model
            .agents
            .iter()
            .find(|a| a.status == "working" || a.status == "running")
        {
            plan_and_agents.push(Line::from(Span::styled(
                format!("  ◐ {}", safe_text(&agent.label)),
                Style::default().fg(p.warning),
            )));
        }
    } else {
        let agent_start = if model.agents.len() > 8 {
            focused_agent
                .unwrap_or(0)
                .min(model.agents.len().saturating_sub(1))
                .saturating_sub(7)
        } else {
            0
        };
        let agent_end = (agent_start + 8).min(model.agents.len());
        let mut agents = Vec::new();
        if agent_start > 0 {
            agents.push(Line::from(Span::styled(
                format!("  ↑ {} earlier", agent_start),
                Style::default().fg(p.muted),
            )));
        }
        agents.extend(
            model
                .agents
                .iter()
                .enumerate()
                .skip(agent_start)
                .take(8)
                .map(|(index, agent)| {
                    let (glyph, color) = agent_state(&agent.status, p);
                    let glyph = status_glyph(glyph);
                    let elapsed = agent
                        .started_at
                        .map(|at| format!("{}s", at.elapsed().as_secs()))
                        .or_else(|| agent.elapsed_ms.map(|ms| format!("{:.0}s", ms / 1000.0)));
                    let detail = [
                        (!agent.current_tool.is_empty()).then(|| safe_text(&agent.current_tool)),
                        elapsed,
                        (!agent.tokens.is_empty())
                            .then(|| format!("{} tok", safe_text(&agent.tokens))),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ");
                    let tree = if agent.id == "main" {
                        ""
                    } else if agent.parent.as_deref() == Some("main") {
                        "├ "
                    } else {
                        "└ "
                    };
                    Line::from(vec![
                        Span::styled(format!("{tree}{glyph} "), Style::default().fg(color)),
                        Span::styled(
                            middle_ellipsis(&safe_text(&agent.label), 24),
                            Style::default().fg(agent_identity_color(&agent.id, p)),
                        ),
                        Span::styled(
                            format!("  {}{}", safe_text(&agent.status), detail),
                            Style::default().fg(p.muted),
                        ),
                    ])
                    .style(if focused_agent == Some(index) {
                        Style::default().bg(p.selection)
                    } else {
                        Style::default()
                    })
                }),
        );
        if agent_end < model.agents.len() {
            agents.push(Line::from(Span::styled(
                format!("  +{} more", model.agents.len() - agent_end),
                Style::default().fg(p.muted),
            )));
        }
        frame.render_widget(
            Paragraph::new(agents).wrap(Wrap { trim: true }).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(if interactive && focus_panel == 2 {
                        p.accent
                    } else {
                        p.border
                    }))
                    .title(" Agents "),
            ),
            columns[1],
        );
    }
    let plan: Vec<Line> = model
        .plan
        .iter()
        .take(5)
        .map(|item| plan_line(item, p))
        .collect();
    let plan_lines = if compact { plan_and_agents } else { plan };
    frame.render_widget(
        Paragraph::new(plan_lines).wrap(Wrap { trim: true }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(p.border))
                .title(" Plan · pinned "),
        ),
        rows[2],
    );

    let input_width = rows[3]
        .width
        .saturating_sub(if inline { 2 } else { 4 })
        .max(1) as usize;
    let input_layout = PromptLayout::new(input, input_width);
    let prompt = if let Some(approval) = &model.approval {
        vec![
            Line::from(vec![
                Span::styled(
                    "? ",
                    Style::default().fg(p.warning).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    middle_ellipsis(
                        &[&approval.tool, &approval.risk, &approval.cwd]
                            .into_iter()
                            .filter(|value| !value.is_empty())
                            .map(|value| safe_text(value))
                            .collect::<Vec<_>>()
                            .join(" · "),
                        rows[3].width.saturating_sub(6) as usize,
                    ),
                    Style::default().fg(p.text),
                ),
            ]),
            Line::from(Span::styled(
                if approval.command.is_empty() {
                    if approval.payload_ref.is_some() {
                        "  Command details are stored · open them before approving".to_owned()
                    } else {
                        "  Command details unavailable · approval is blocked".to_owned()
                    }
                } else {
                    format!(
                        "  {}",
                        middle_ellipsis(
                            &safe_text(&approval.command).replace('\n', " "),
                            rows[3].width.saturating_sub(6) as usize
                        )
                    )
                },
                Style::default().fg(p.text),
            )),
            Line::from(Span::styled(
                format!(
                    "  Reason: {}",
                    middle_ellipsis(
                        &safe_text(&approval.reason).replace('\n', " "),
                        rows[3].width.saturating_sub(14) as usize
                    )
                ),
                Style::default().fg(p.muted),
            )),
            Line::from(Span::styled(
                format!(
                    "  [1] allow once    [2] deny{}",
                    approval
                        .scopes
                        .iter()
                        .filter(|scope| scope.as_str() != "once")
                        .enumerate()
                        .map(|(i, scope)| format!(
                            "    [{}] {}",
                            i + 3,
                            match scope.as_str() {
                                "type" => "allow tool this session",
                                "session" => "trust similar this session",
                                "project" => "trust this project",
                                _ => "unavailable",
                            }
                        ))
                        .collect::<String>()
                ),
                Style::default().fg(p.warning),
            )),
        ]
    } else {
        if input.is_empty() {
            vec![Line::from(vec![
                Span::styled(
                    "› ",
                    Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "Ask Bahulam to change or explain your code",
                    Style::default().fg(p.muted),
                ),
            ])]
        } else {
            input_layout
                .lines
                .iter()
                .map(|line| Line::from(Span::styled(line.clone(), Style::default().fg(p.text))))
                .collect()
        }
    };
    let prompt_inner_height = rows[3].height.saturating_sub(2).max(1);
    let suggestion_rows = prompt.len().saturating_sub(input_layout.lines.len()) as u16;
    let prompt_visible_rows = prompt_inner_height.saturating_sub(suggestion_rows).max(1);
    let (cursor_row, cursor_column) = input_layout.cursor(cursor);
    let prompt_scroll = cursor_row.saturating_sub(prompt_visible_rows.saturating_sub(1) as usize);
    frame.render_widget(
        Paragraph::new(prompt)
            .style(Style::default().bg(p.input_bg))
            .scroll((prompt_scroll.min(u16::MAX as usize) as u16, 0))
            .block(
                Block::default()
                    .padding(Padding::horizontal(1))
                    .borders(if inline {
                        Borders::TOP | Borders::BOTTOM
                    } else {
                        Borders::ALL
                    })
                    .border_style(Style::default().fg(if model.approval.is_some() {
                        p.warning
                    } else if interactive && focus_panel == 0 {
                        p.accent
                    } else {
                        p.border
                    }))
                    .title(if model.approval.is_some() {
                        " Permission needed "
                    } else if inline {
                        " Message "
                    } else if interactive {
                        " Message  ·  Enter to send · Ctrl+J for a new line "
                    } else {
                        " Prompt "
                    }),
            ),
        rows[3],
    );
    if interactive
        && focus_panel == 0
        && detail_card.is_none()
        && model.approval.is_none()
        && model.interaction.is_none()
    {
        let row_offset = cursor_row.saturating_sub(prompt_scroll) as u16;
        let col_offset = cursor_column % input_width;
        frame.set_cursor_position(Position::new(
            rows[3]
                .x
                .saturating_add(if inline { 1 } else { 2 })
                .saturating_add(col_offset.min(u16::MAX as usize) as u16)
                .min(rows[3].right().saturating_sub(1)),
            rows[3]
                .y
                .saturating_add(1)
                .saturating_add(row_offset)
                .min(rows[3].bottom().saturating_sub(1)),
        ));
    }

    let shortcuts = if model.selecting_text {
        "Text selection · drag to select/copy · Alt+M restore mouse controls".to_owned()
    } else if detail_card.is_some() {
        format!(
            "Esc return · Ctrl+Y copy · {}",
            if model.composer_hint.is_empty() {
                "↑↓ scroll"
            } else {
                &model.composer_hint
            }
        )
    } else if !model.composer_hint.is_empty() {
        model.composer_hint.clone()
    } else if inline && area.width < 32 {
        "Ctrl+C twice quit".to_owned()
    } else if inline && area.width < 52 {
        "Enter send · Ctrl+C twice quit".to_owned()
    } else if inline && area.width < 78 {
        "Tab history/input · Enter send · Ctrl+C twice quit".to_owned()
    } else if inline {
        "Tab history · Alt+M select text · Ctrl+V paste · Ctrl+G editor · Ctrl+C twice quit"
            .to_owned()
    } else if interactive && agent_filter.is_some() {
        "Ctrl+N/P card · Enter details · Esc main · Ctrl+O expand all".to_owned()
    } else if interactive && focus_panel == 2 {
        "↑↓ select agent · Enter transcript · Tab input · Ctrl+C twice quit".to_owned()
    } else if interactive && focus_panel == 1 {
        "↑↓/PgUp history · Enter details · Ctrl+O expand · Tab agents".to_owned()
    } else if interactive {
        "Enter send · Alt+M select text · Ctrl+V paste · Ctrl+G editor · Ctrl+C twice quit"
            .to_owned()
    } else {
        "↑↓ scroll · Enter expand · Ctrl+O expand all · q quit".to_owned()
    };
    let state = safe_text(&model.status);
    let tokens = if model.usage_known {
        format!(
            "{} in · {} out",
            format_token_count(model.input_tokens),
            format_token_count(model.output_tokens)
        )
    } else {
        "usage —".into()
    };
    let context = if model.context_known {
        format!(
            "ctx {}{:.1}%",
            if model.context_estimated { "~" } else { "" },
            model.context_used_pct
        )
    } else {
        "ctx —".into()
    };
    let cost = if model.cost_known {
        format!(
            "{}${:.4}",
            if model.cost_estimated { "~" } else { "" },
            model.cost
        )
    } else {
        "cost —".into()
    };
    let mut status_parts = Vec::new();
    if model.pending_prompt_count() > 0 {
        status_parts.push(format!("{} queued", model.pending_prompt_count()));
    }
    let configured = std::env::var("BAHULAM_TUI_STATUS_SEGMENTS")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "activity,permission,tokens,context,cost,jobs".into());
    let mut seen = HashSet::new();
    for key in configured
        .split(',')
        .map(str::trim)
        .filter(|key| seen.insert(*key))
    {
        let part = match key {
            "activity" => Some(state.clone()),
            "permission" if !model.permission_mode.is_empty() => {
                Some(format!("perm {}", model.permission_mode))
            }
            "tokens" => Some(tokens.clone()),
            "context" => Some(context.clone()),
            "cost" => Some(cost.clone()),
            "jobs" if model.active_background_jobs > 0 => {
                Some(format!("{} jobs", model.active_background_jobs))
            }
            "model" => Some(model_label_text(model)),
            "directory" => Some(model.cwd.clone()),
            "branch" => Some(model.git_branch.clone()),
            "custom" => Some(model.custom_status.clone()),
            _ => None,
        };
        if let Some(part) = part.filter(|p| !p.is_empty()) {
            status_parts.push(safe_text(&part));
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("● ", Style::default().fg(p.info)),
            Span::styled(status_parts.join(" · "), Style::default().fg(p.muted)),
        ])),
        rows[4],
    );
    frame.render_widget(
        Paragraph::new(format!("  {shortcuts}"))
            .style(Style::default().fg(p.muted).add_modifier(Modifier::DIM)),
        rows[5],
    );
    if interactive && focus_panel == 0 && detail_card.is_none() {
        render_slash_menu(frame, model, input, rows[3], p);
    }
    if let Some(interaction) = &model.interaction {
        let width = area.width.saturating_sub(2).clamp(1, 88);
        let height = (interaction.options.len().min(12) as u16 + 6)
            .min(area.height.saturating_sub(2))
            .max(1);
        let popup = centered_rect(width, height, area);
        frame.render_widget(ratatui::widgets::Clear, popup);
        let mut lines = vec![Line::from(Span::styled(
            safe_text(&interaction.title),
            Style::default().fg(p.text).add_modifier(Modifier::BOLD),
        ))];
        if !interaction.message.is_empty() {
            lines.push(Line::from(Span::styled(
                safe_text(&interaction.message),
                Style::default().fg(p.muted),
            )));
        }
        lines.push(Line::from(""));
        if interaction.editing {
            let layout =
                PromptLayout::new(&interaction.free_text, width.saturating_sub(2) as usize);
            let available = height.saturating_sub(3 + lines.len() as u16).max(1) as usize;
            let skip = layout.lines.len().saturating_sub(available);
            let (row, col) = layout.cursor(interaction.free_text.len());
            let text_y = popup.y.saturating_add(1 + lines.len() as u16);
            lines.extend(layout.lines.iter().skip(skip).map(|line| {
                Line::styled(line.clone(), Style::default().fg(p.text).bg(p.input_bg))
            }));
            lines.push(Line::styled(
                "Enter answer · Esc back",
                Style::default().fg(p.muted),
            ));
            frame.render_widget(
                Paragraph::new(lines).block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(p.accent))
                        .title(" Your answer "),
                ),
                popup,
            );
            frame.set_cursor_position(Position::new(
                (popup.x + 1 + col as u16).min(popup.right().saturating_sub(1)),
                (text_y + row.saturating_sub(skip) as u16).min(popup.bottom().saturating_sub(1)),
            ));
            return;
        }
        // Reserve borders, title/message, spacing, continuation markers and
        // controls before choosing the session window. Labels occupy one row.
        let visible = (height.saturating_sub(8) as usize)
            .max(1)
            .min(interaction.options.len());
        let start = interaction
            .selected
            .saturating_sub(visible.saturating_sub(1))
            .min(interaction.options.len().saturating_sub(visible));
        if start > 0 {
            lines.push(Line::from(Span::styled(
                format!("↑ {} earlier", start),
                Style::default().fg(p.muted),
            )));
        }
        let selected = interaction
            .options
            .iter()
            .enumerate()
            .skip(start)
            .take(visible)
            .map(|(index, option)| {
                Line::from(Span::styled(
                    format!(
                        "{} {}",
                        if index == interaction.selected {
                            "›"
                        } else {
                            " "
                        },
                        middle_ellipsis(
                            &safe_text(&option.label),
                            width.saturating_sub(4) as usize
                        )
                    ),
                    if index == interaction.selected {
                        Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(p.text)
                    },
                ))
            });
        lines.extend(selected);
        if start + visible < interaction.options.len() {
            lines.push(Line::from(Span::styled(
                format!("↓ {} more", interaction.options.len() - start - visible),
                Style::default().fg(p.muted),
            )));
        }
        lines.push(Line::from(Span::styled(
            if width < 42 {
                "↑↓ select · Enter pick · Esc cancel"
            } else {
                "↑↓ select · Enter confirm · Esc cancel"
            },
            Style::default().fg(p.muted),
        )));
        frame.render_widget(
            Paragraph::new(lines).block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(p.accent))
                    .title(" Choose "),
            ),
            popup,
        );
    }
}

/// Render completion above the composer so it cannot be clipped by the one-row input.
fn render_slash_menu(frame: &mut Frame, model: &Model, input: &str, prompt: Rect, p: Palette) {
    if model.approval.is_some() || model.interaction.is_some() {
        return;
    }
    let matches = model.slash_menu.matches(input, &model.command_catalog);
    if matches.is_empty() {
        return;
    }
    let available = prompt.y.saturating_sub(frame.area().y) as usize;
    let visible = matches.len().min(5).min(available.saturating_sub(1));
    if visible == 0 {
        return;
    }
    let selected = model.slash_menu.selected.min(matches.len() - 1);
    let start = selected.saturating_sub(visible - 1);
    let area = Rect::new(
        prompt.x,
        prompt.y - visible as u16 - 1,
        prompt.width,
        visible as u16 + 1,
    );
    frame.render_widget(ratatui::widgets::Clear, area);
    let mut lines: Vec<Line> = matches
        .iter()
        .enumerate()
        .skip(start)
        .take(visible)
        .map(|(index, row)| {
            Line::from(Span::styled(
                format!(
                    "{} {}  {}",
                    if index == selected { "›" } else { " " },
                    safe_text(&row.0),
                    safe_text(&row.1)
                ),
                if index == selected {
                    Style::default()
                        .fg(p.accent)
                        .bg(p.input_bg)
                        .add_modifier(Modifier::BOLD)
                } else {
                    Style::default().fg(p.text)
                },
            ))
        })
        .collect();
    lines.push(Line::from(Span::styled(
        "  ↑↓ select · Tab complete · Enter run · Esc close",
        Style::default().fg(p.muted),
    )));
    // Truncate each option instead of wrapping it over the next selectable row.
    frame.render_widget(Paragraph::new(lines), area);
}

fn centered_rect(width: u16, height: u16, area: ratatui::layout::Rect) -> ratatui::layout::Rect {
    ratatui::layout::Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

fn agent_state(status: &str, p: Palette) -> (&'static str, Color) {
    match status {
        "working" | "running" => ("◐", p.info),
        "failed" => ("✗", p.danger),
        "done" | "complete" => ("✓", p.success),
        _ => ("○", p.muted),
    }
}

fn agent_identity_color(agent: &str, p: Palette) -> Color {
    if agent == "main" {
        return p.accent;
    }
    let hash = agent.bytes().fold(0usize, |value, byte| {
        value.wrapping_mul(31).wrapping_add(byte as usize)
    });
    p.agent_colors[hash % p.agent_colors.len()]
}

fn plan_line(item: &str, p: Palette) -> Line<'static> {
    if let Some((state, text)) = item
        .strip_prefix('[')
        .and_then(|value| value.split_once("] "))
    {
        let (glyph, color) = match state {
            "done" | "completed" => ("✓", p.success),
            "in_progress" | "running" | "current" => ("›", p.accent),
            "blocked" | "failed" => ("!", p.danger),
            _ => ("○", p.muted),
        };
        return Line::from(vec![
            Span::styled(
                format!(" {} ", status_glyph(glyph)),
                Style::default().fg(color),
            ),
            Span::styled(
                safe_text(text),
                Style::default().fg(if glyph == "›" { p.text } else { p.muted }),
            ),
        ]);
    }
    Line::from(vec![
        Span::styled(" ○ ", Style::default().fg(p.muted)),
        Span::raw(safe_text(item)),
    ])
}

// Scroll in painted rows, never in cards: one message may occupy many rows.
fn wrap_rows(lines: Vec<Line<'static>>, width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut rows = Vec::new();
    for line in lines {
        let mut spans = Vec::new();
        let mut used = 0;
        for span in line.spans {
            let mut text = String::new();
            for grapheme in span.content.graphemes(true) {
                let size = UnicodeWidthStr::width(grapheme);
                if used + size > width && used > 0 {
                    if !text.is_empty() {
                        spans.push(Span::styled(std::mem::take(&mut text), span.style));
                    }
                    rows.push(Line::from(std::mem::take(&mut spans)).style(line.style));
                    used = 0;
                }
                text.push_str(grapheme);
                used += size;
            }
            if !text.is_empty() {
                spans.push(Span::styled(text, span.style));
            }
        }
        rows.push(Line::from(spans).style(line.style));
    }
    // Paragraph styles only occupied cells. Fill tinted user rows to the
    // content edge, including wrapped/empty lines, without adding any rows.
    for row in &mut rows {
        if row.style.bg.is_some() {
            row.spans
                .push(Span::raw(" ".repeat(width.saturating_sub(row.width()))));
        }
    }
    rows
}

// Cache measurements, not transcript text or styled rows. Off-screen cards can
// then be skipped without Markdown/grapheme layout on every scroll or keystroke.
// All card fields participate: streaming, details and replacement invalidate
// measurements even when protocol sequence numbers or card indices are reused.
const MAX_ROW_MEASUREMENTS: usize = 65_536;
thread_local! {
    static ROW_MEASUREMENTS: RefCell<HashMap<u64, usize>> = RefCell::new(HashMap::new());
}

fn card_row_count(
    card: &crate::model::Card,
    index: usize,
    expanded: &HashSet<usize>,
    p: Palette,
    width: usize,
) -> usize {
    let mut key = DefaultHasher::new();
    card.hash(&mut key);
    width.hash(&mut key);
    expanded.contains(&index).hash(&mut key);
    let key = key.finish();
    ROW_MEASUREMENTS.with(|cache| {
        if let Some(count) = cache.borrow().get(&key) {
            return *count;
        }
        let count = wrap_rows(
            card_lines(card, index, expanded, None, p, width, usize::MAX),
            width,
        )
        .len();
        let mut cache = cache.borrow_mut();
        if cache.len() >= MAX_ROW_MEASUREMENTS {
            cache.clear();
        }
        cache.insert(key, count);
        count
    })
}

pub struct HistoryGeometry {
    pub total_rows: usize,
    pub end: u16,
    pub page: u16,
    pub cards: Vec<(usize, u16)>,
}

#[derive(Clone, Copy, Debug)]
pub struct HistoryAnchor {
    card: usize,
    offset: usize,
}
impl HistoryGeometry {
    pub fn anchor(&self, scroll: u16, follow: bool) -> Option<HistoryAnchor> {
        let top = if follow { self.end } else { scroll } as usize;
        let (card, row) = self
            .cards
            .iter()
            .rev()
            .find(|(_, row)| *row as usize <= top)?;
        Some(HistoryAnchor {
            card: *card,
            offset: top - *row as usize,
        })
    }
    pub fn anchored_scroll(&self, anchor: HistoryAnchor) -> u16 {
        let Some(index) = self.cards.iter().position(|(card, _)| *card == anchor.card) else {
            return 0;
        };
        let start = self.cards[index].1 as usize;
        let end = self
            .cards
            .get(index + 1)
            .map(|(_, row)| *row as usize)
            .unwrap_or(self.total_rows);
        // If collapse removed the very row being viewed, keep that tool in view.
        let offset = if anchor.offset < end.saturating_sub(start) {
            anchor.offset
        } else {
            0
        };
        (start + offset).min((u16::MAX - 1) as usize) as u16
    }
}

pub fn history_geometry(
    model: &Model,
    area: Rect,
    input: &str,
    inline: bool,
    expanded: &HashSet<usize>,
    theme: &str,
    agent_filter: Option<&str>,
) -> HistoryGeometry {
    let layout = if inline {
        inline_layout(area, input, model.approval.is_some())
    } else {
        view_layout(area, input, model.approval.is_some())
    };
    let inner = transcript_rect(layout.columns[0], inline);
    let width = inner.width as usize;
    let page = inner.height.max(1);
    let p = palette(theme);
    let mut total = 0usize;
    let mut cards = Vec::new();
    for (index, card) in model
        .cards
        .iter()
        .enumerate()
        .filter(|(_, card)| card.agent == agent_filter.unwrap_or("main"))
    {
        cards.push((index, total.min((u16::MAX - 1) as usize) as u16));
        total += card_row_count(card, index, expanded, p, width);
    }
    HistoryGeometry {
        total_rows: total,
        end: total
            .saturating_sub(page as usize)
            .min((u16::MAX - 1) as usize) as u16,
        page,
        cards,
    }
}

type BrowserRow = (Line<'static>, Option<crate::open_target::LinkTarget>);
fn browser_card_rows(
    lines: Vec<Line<'static>>,
    card: &crate::model::Card,
    width: usize,
) -> Vec<BrowserRow> {
    let targets = crate::browser_links::for_card(card);
    wrap_rows(lines, width)
        .into_iter()
        .map(|line| {
            let target = line
                .spans
                .first()
                .filter(|span| span.style.add_modifier.contains(Modifier::UNDERLINED))
                .and_then(|span| span.content.strip_prefix("   ↗ Open "))
                .and_then(|text| text.split_once(" · "))
                .and_then(|(number, _)| number.parse::<usize>().ok())
                .and_then(|index| index.checked_sub(1))
                .and_then(|index| targets.get(index))
                .cloned();
            (line, target)
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn transcript_lines(
    model: &Model,
    expanded: &HashSet<usize>,
    focused: Option<usize>,
    p: Palette,
    width: usize,
    agent_filter: Option<&str>,
    scroll: u16,
    visible_rows: usize,
) -> Vec<BrowserRow> {
    let budget = visible_rows.max(1);
    let mut output = Vec::with_capacity(budget);
    let cards = model
        .cards
        .iter()
        .enumerate()
        .filter(|(_, card)| card.agent == agent_filter.unwrap_or("main"));
    if scroll == u16::MAX {
        // Only render enough cards to fill the tail, even in very long sessions.
        for (index, card) in cards.rev() {
            let lines = browser_card_rows(
                card_lines(card, index, expanded, focused, p, width, usize::MAX),
                card,
                width,
            );
            for line in lines.into_iter().rev() {
                output.push(line);
                if output.len() >= budget {
                    output.reverse();
                    return output;
                }
            }
        }
        output.reverse();
    } else {
        let mut skip = scroll as usize;
        for (index, card) in cards {
            if skip > 0 {
                let height = card_row_count(card, index, expanded, p, width);
                if skip >= height {
                    skip -= height;
                    continue;
                }
            }
            let rows = browser_card_rows(
                card_lines(card, index, expanded, focused, p, width, usize::MAX),
                card,
                width,
            );
            output.extend(rows.into_iter().skip(skip).take(budget - output.len()));
            skip = 0;
            if output.len() >= budget {
                break;
            }
        }
    }
    output
}

// Presentation only: copy and agent history retain the exact stored tool value.
fn readable_detail(text: &str) -> String {
    fn render(value: &serde_json::Value, depth: usize, out: &mut String) {
        let indent = "  ".repeat(depth.min(8));
        match value {
            serde_json::Value::Object(fields) if depth < 32 => {
                if fields.is_empty() {
                    out.push_str("(empty object)\n");
                }
                for (key, value) in fields {
                    let label = safe_text(key).replace('_', " ");
                    if depth == 0 {
                        out.push_str(&format!("## {label}\n"));
                    } else {
                        out.push_str(&format!("{indent}{label}:\n"));
                    }
                    render(value, depth + 1, out);
                    if depth == 0 {
                        out.push('\n');
                    }
                }
            }
            serde_json::Value::Array(items) if depth < 32 => {
                if items.is_empty() {
                    out.push_str("(empty list)\n");
                }
                for (i, value) in items.iter().enumerate() {
                    if value.is_object() || value.is_array() {
                        out.push_str(&format!("{indent}Item {}\n", i + 1));
                        render(value, depth + 1, out);
                    } else {
                        out.push_str(&format!("{indent}• "));
                        render(value, 0, out);
                    }
                }
            }
            serde_json::Value::String(text) => {
                out.push_str(&safe_text(text));
                out.push('\n');
            }
            value => {
                out.push_str(&value.to_string());
                out.push('\n');
            }
        }
    }
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) if value.is_object() || value.is_array() => {
            let mut output = String::new();
            render(&value, 0, &mut output);
            output
        }
        _ => text.to_owned(),
    }
}

fn detail_lines(card: &crate::model::Card, p: Palette) -> Vec<Line<'static>> {
    let detail = card.detail.as_deref().unwrap_or(&card.body);
    let mut lines = if card.detail_loading && card.detail.is_none() {
        vec![Line::from(Span::styled(
            "Loading the complete result from the session log…",
            Style::default().fg(p.muted),
        ))]
    } else if detail.is_empty() {
        vec![Line::from(Span::styled(
            "No detail text is available for this item.",
            Style::default().fg(p.muted),
        ))]
    } else {
        format_markdown(&detail.lines().collect::<Vec<_>>(), p, card.title == "Diff")
    };
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        "   Esc to return to the conversation",
        Style::default().fg(p.info),
    )));
    lines
}

fn card_lines(
    card: &crate::model::Card,
    index: usize,
    expanded: &HashSet<usize>,
    focused: Option<usize>,
    p: Palette,
    width: usize,
    budget: usize,
) -> Vec<Line<'static>> {
    let (glyph, color) = match card.status.as_str() {
        "requested" | "queued" => ("○", p.muted),
        "running" | "streaming" | "working" => ("◐", p.info),
        "waiting" => ("?", p.warning),
        "failed" | "error" => ("✗", p.error),
        "denied" | "rejected" => ("⊘", p.danger),
        "cancelled" => ("⊘", p.muted),
        "done" | "complete" | "ready" => ("✓", p.success),
        _ => ("•", p.accent),
    };
    let focus = if focused == Some(index) {
        status_glyph("›")
    } else {
        " "
    };
    let agent_message = card.title.strip_prefix("Agent: ");
    let is_assistant = card.is_message() && card.title != "Prompt";
    let is_user = card.title == "Prompt";
    let glyph = if is_assistant {
        "•"
    } else if is_user {
        "›"
    } else {
        glyph
    };
    let glyph = status_glyph(glyph);
    let display_title = if card.title == "Assistant" {
        ""
    } else if let Some(agent) = agent_message {
        agent
    } else if is_user {
        "You"
    } else {
        &card.title
    };
    let completed_tool =
        card.is_foldable() && matches!(card.status.as_str(), "done" | "complete" | "ready");
    let display_status = if completed_tool {
        ""
    } else if is_assistant && card.status == "streaming" {
        "responding"
    } else if is_assistant || is_user {
        ""
    } else {
        &card.status
    };
    let identity_color = if card.title == "Assistant" {
        p.accent
    } else if is_assistant {
        agent_identity_color(&card.agent, p)
    } else if !card.tool_name.is_empty() {
        p.tool
    } else {
        p.text
    };
    let metadata_text = card
        .started_at
        .map(|at| format!("{}s", at.elapsed().as_secs()))
        .unwrap_or_else(|| card.metadata.clone());
    let metadata_width = UnicodeWidthStr::width(metadata_text.as_str()).min(18);
    let status_width = if display_status.is_empty() {
        0
    } else {
        UnicodeWidthStr::width(display_status).max(9) + 1
    };
    let heading_width = if !is_assistant || card.title == "Agent report" {
        3 + UnicodeWidthStr::width(display_title).max(12) + 1 + status_width
    } else {
        3
    };
    let fixed_width = heading_width + metadata_width;
    let primary = middle_ellipsis(
        &safe_text(&card.primary),
        width.saturating_sub(fixed_width + 2),
    );
    let metadata = if metadata_text.is_empty() {
        String::new()
    } else {
        middle_ellipsis(
            &safe_text(&metadata_text),
            width.saturating_sub(heading_width).min(18),
        )
    };
    let gap = if metadata.is_empty() {
        0
    } else {
        width.saturating_sub(
            heading_width
                + UnicodeWidthStr::width(metadata.as_str())
                + UnicodeWidthStr::width(primary.as_str()),
        )
    };
    let mut heading = vec![Span::styled(
        format!("{focus}{glyph} "),
        Style::default().fg(color),
    )];
    if !is_assistant || card.title == "Agent report" {
        heading.push(Span::styled(
            format!("{:<12} ", safe_text(display_title)),
            Style::default()
                .fg(identity_color)
                .add_modifier(Modifier::BOLD),
        ));
        if !display_status.is_empty() {
            heading.push(Span::styled(
                format!("{:<9} ", safe_text(display_status)),
                Style::default().fg(color),
            ));
        }
    }
    if !primary.is_empty() {
        heading.push(Span::styled(primary, Style::default().fg(p.muted)));
    }
    heading.push(Span::raw(" ".repeat(gap)));
    if !metadata.is_empty() {
        heading.push(Span::styled(metadata, Style::default().fg(p.muted)));
    }
    let mut heading = Line::from(heading);
    if is_user {
        heading.style = heading.style.bg(p.input_bg);
    }
    let mut lines = vec![heading];
    if budget <= 1 {
        return lines;
    }
    let foldable = card.is_foldable();
    let is_expanded = foldable && expanded.contains(&index);
    let expanded_text = if (is_expanded || !foldable) && !card.is_message() {
        Some(if card.detail_loading && card.detail.is_none() {
            "Loading complete result…".to_owned()
        } else {
            readable_detail(card.detail.as_deref().unwrap_or(&card.body))
        })
    } else {
        None
    };
    let body = expanded_text.as_deref().unwrap_or(&card.body);
    let total = body.lines().count();
    let details_total = card
        .detail
        .as_deref()
        .map(|detail| detail.lines().count())
        .unwrap_or(total);
    let content_width = width.saturating_sub(4);
    let long_line = card
        .body
        .lines()
        .any(|line| UnicodeWidthStr::width(line) > content_width)
        || card.detail.as_deref().is_some_and(|detail| {
            detail
                .lines()
                .any(|line| UnicodeWidthStr::width(line) > content_width)
        });
    // Restore compact previews and access to every separately stored tool result.
    // Commands and conversation messages remain complete.
    let is_message = is_assistant || is_user;
    let limit = if !foldable {
        usize::MAX
    } else {
        match card.status.as_str() {
            "running" | "streaming" => 2,
            "failed" | "error" => 4,
            "requested" | "queued" => 1,
            _ => 2,
        }
    };
    let has_more = if !foldable {
        false
    } else {
        is_expanded
            || card.payload_ref.is_some()
            || card
                .detail
                .as_deref()
                .is_some_and(|detail| detail != card.body)
            || total > limit
            || details_total > limit
            || long_line
    };
    let body_room = budget
        .saturating_sub(1)
        .saturating_sub(usize::from(has_more));
    let show = if is_expanded || !foldable {
        body_room.min(total)
    } else {
        limit.min(body_room).min(total)
    };
    let tail = foldable && matches!(card.status.as_str(), "failed" | "error") && !is_expanded;
    let selected_lines: Vec<&str> = if tail {
        body.lines()
            .rev()
            .take(show)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        body.lines().take(show).collect()
    };
    let body_lines: Vec<String> = if !foldable || is_expanded {
        // Message lines get a 4-column speaker gutter plus the 3-column
        // markdown indent; wrap to what remains so the paragraph widget
        // never re-wraps and pushes the newest line out of the viewport.
        let wrap_width = width.saturating_sub(if is_message { 7 } else { 3 }).max(1);
        let mut wrapped = Vec::new();
        let mut in_code = false;
        for line in &selected_lines {
            if line.trim_start().starts_with("```") {
                in_code = !in_code;
                wrapped.push((*line).to_owned());
                continue;
            }
            wrapped.extend(wrap_text(line, wrap_width, in_code));
        }
        let visible_rows = body_room;
        if tail && wrapped.len() > visible_rows {
            wrapped.drain(..wrapped.len() - visible_rows);
        }
        wrapped.truncate(visible_rows);
        wrapped
    } else {
        selected_lines
            .iter()
            .map(|line| middle_ellipsis(line, content_width))
            .collect()
    };
    let markdown_lines: Vec<&str> = body_lines.iter().map(String::as_str).collect();
    let mut rendered_body = format_markdown(&markdown_lines, p, card.title == "Diff");
    if is_assistant {
        for line in &mut rendered_body {
            line.spans.insert(0, Span::raw("    "));
        }
    } else if is_user {
        for line in &mut rendered_body {
            line.style = line.style.bg(p.input_bg);
            line.spans
                .insert(0, Span::styled("  │ ", Style::default().fg(p.muted)));
        }
    }
    lines.extend(rendered_body.into_iter().take(body_room));
    if has_more && lines.len() < budget {
        let hint = if is_expanded {
            " · Esc to collapse".to_owned()
        } else if card.payload_ref.is_some() && card.detail.is_none() {
            " · stored full result".to_owned()
        } else if details_total > show {
            format!(" · {} more lines", details_total - show)
        } else {
            " · full line".to_owned()
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!(
                    "   {}{hint}",
                    if is_expanded {
                        "− Show less"
                    } else {
                        "＋ Show details"
                    }
                ),
                Style::default().fg(p.details),
            ),
            Span::styled(" · Click / Enter", Style::default().fg(p.muted)),
            if card.detail_loading {
                Span::styled(" · loading…", Style::default().fg(p.warning))
            } else {
                Span::raw("")
            },
        ]));
    } else if total > show && lines.len() < budget && !(is_message && tail) {
        lines.push(
            Line::from(format!("   … {} more lines", total - show))
                .style(Style::default().fg(p.muted)),
        );
    }
    if !foldable || !has_more || is_expanded || card.open_url.is_some() {
        lines.extend(browser_actions(card, p, width));
    }
    lines.push(Line::default());
    lines
}

/// Word-wrap one logical line to `width` display cells. Code lines break at
/// the cell boundary so indentation and alignment survive; prose breaks at
/// whitespace, and a single word wider than the line is split by grapheme.
fn wrap_text(line: &str, width: usize, hard: bool) -> Vec<String> {
    let width = width.max(1);
    if UnicodeWidthStr::width(line) <= width {
        return vec![line.to_owned()];
    }
    let mut rows = Vec::new();
    let mut current = String::new();
    let push_word = |rows: &mut Vec<String>, current: &mut String, word: &str| {
        if UnicodeWidthStr::width(word) <= width {
            if !current.is_empty() {
                rows.push(std::mem::take(current));
            }
            current.push_str(word);
            return;
        }
        for grapheme in word.graphemes(true) {
            let glyph = UnicodeWidthStr::width(grapheme);
            if UnicodeWidthStr::width(current.as_str()) + glyph > width && !current.is_empty() {
                rows.push(std::mem::take(current));
            }
            current.push_str(grapheme);
        }
    };
    if hard {
        push_word(&mut rows, &mut current, line);
    } else {
        for word in line.split(' ') {
            if current.is_empty() {
                push_word(&mut rows, &mut current, word);
                continue;
            }
            let candidate_width =
                UnicodeWidthStr::width(current.as_str()) + 1 + UnicodeWidthStr::width(word);
            if candidate_width <= width {
                current.push(' ');
                current.push_str(word);
            } else {
                push_word(&mut rows, &mut current, word);
            }
        }
    }
    if !current.is_empty() || rows.is_empty() {
        rows.push(current);
    }
    rows
}

fn format_token_count(tokens: u64) -> String {
    let (value, suffix) = if tokens >= 999_950 {
        (tokens as f64 / 1_000_000.0, "M")
    } else if tokens >= 1_000 {
        (tokens as f64 / 1_000.0, "K")
    } else {
        return tokens.to_string();
    };
    let rounded = format!("{value:.1}");
    format!("{}{suffix}", rounded.strip_suffix(".0").unwrap_or(&rounded))
}

fn middle_ellipsis(value: &str, max_width: usize) -> String {
    if UnicodeWidthStr::width(value) <= max_width {
        return value.to_owned();
    }
    if max_width < 2 {
        return "…".chars().take(max_width).collect();
    }
    let left_width = (max_width - 1) / 2;
    let right_width = max_width - 1 - left_width;
    let graphemes: Vec<&str> = value.graphemes(true).collect();
    let mut left = String::new();
    for grapheme in &graphemes {
        if UnicodeWidthStr::width(left.as_str()) + UnicodeWidthStr::width(*grapheme) > left_width {
            break;
        }
        left.push_str(grapheme);
    }
    let mut right = String::new();
    for grapheme in graphemes.iter().rev() {
        if UnicodeWidthStr::width(right.as_str()) + UnicodeWidthStr::width(*grapheme) > right_width
        {
            break;
        }
        right.insert_str(0, grapheme);
    }
    format!("{left}…{right}")
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct MarkdownLineKey {
    text: String,
    code: bool,
    language: String,
    diff: bool,
    palette: String,
}

struct MarkdownLineCache {
    entries: HashMap<MarkdownLineKey, (Line<'static>, bool, String)>,
    insertion_order: VecDeque<MarkdownLineKey>,
}

impl MarkdownLineCache {
    const MAX_ENTRIES: usize = 512;
    const MAX_LINE_BYTES: usize = 2048;

    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
        }
    }

    fn get(&self, key: &MarkdownLineKey) -> Option<(Line<'static>, bool, String)> {
        self.entries.get(key).cloned()
    }

    fn insert(&mut self, key: MarkdownLineKey, value: (Line<'static>, bool, String)) {
        if key.text.len() > Self::MAX_LINE_BYTES
            || key.language.len() > 256
            || self.entries.contains_key(&key)
        {
            return;
        }
        while self.entries.len() >= Self::MAX_ENTRIES {
            if let Some(oldest) = self.insertion_order.pop_front() {
                self.entries.remove(&oldest);
            } else {
                break;
            }
        }
        self.insertion_order.push_back(key.clone());
        self.entries.insert(key, value);
    }
}

thread_local! {
    static MARKDOWN_LINES: RefCell<MarkdownLineCache> = RefCell::new(MarkdownLineCache::new());
}

fn format_markdown(lines: &[&str], p: Palette, diff: bool) -> Vec<Line<'static>> {
    let mut code = false;
    let mut language = String::new();
    let palette = format!("{p:?}");
    MARKDOWN_LINES.with(|cache| {
        let mut cache = cache.borrow_mut();
        lines
            .iter()
            .map(|raw| {
                let key = MarkdownLineKey {
                    text: (*raw).to_owned(),
                    code,
                    language: language.clone(),
                    diff,
                    palette: palette.clone(),
                };
                if let Some((line, next_code, next_language)) = cache.get(&key) {
                    code = next_code;
                    language = next_language;
                    return line;
                }
                let line = format_markdown_line(raw, p, &mut code, &mut language, diff);
                cache.insert(key, (line.clone(), code, language.clone()));
                line
            })
            .collect()
    })
}

fn format_markdown_line(
    raw: &str,
    p: Palette,
    code: &mut bool,
    language: &mut String,
    diff: bool,
) -> Line<'static> {
    let line = safe_text(raw);
    if line.trim_start().starts_with("```") {
        *code = !*code;
        let fence_language = line.trim().trim_matches('`');
        if *code {
            *language = fence_language.to_owned();
        }
        return Line::from(Span::styled(
            if *code {
                format!("   {}", language)
            } else {
                String::new()
            },
            Style::default().fg(p.muted).add_modifier(Modifier::ITALIC),
        ));
    }
    if diff || (*code && matches!(language.as_str(), "diff" | "patch")) {
        let color = if line.starts_with('+') {
            p.success
        } else if line.starts_with('-') {
            p.danger
        } else if line.starts_with("@@") {
            p.info
        } else {
            p.text
        };
        return Line::from(format!("   {line}")).style(Style::default().fg(color));
    }
    if *code {
        return Line::from(code_spans(&line, p));
    }
    let trimmed = line.trim_start();
    if trimmed.starts_with("error:")
        || trimmed.starts_with("fatal:")
        || trimmed.starts_with("exception:")
    {
        return Line::from(format!("   {line}")).style(Style::default().fg(p.danger));
    }
    if let Some(heading) = trimmed
        .strip_prefix("### ")
        .or_else(|| trimmed.strip_prefix("## "))
        .or_else(|| trimmed.strip_prefix("# "))
    {
        return Line::from(Span::styled(
            format!("   {}", heading.trim_matches('#').trim()),
            Style::default().fg(p.text).add_modifier(Modifier::BOLD),
        ));
    }
    if let Some(quote) = trimmed.strip_prefix("> ") {
        return Line::from(format!("   │ {quote}"))
            .style(Style::default().fg(p.muted).add_modifier(Modifier::ITALIC));
    }
    if let Some(item) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
    {
        return Line::from(vec![
            Span::styled("   • ", Style::default().fg(p.muted)),
            Span::styled(item.to_owned(), Style::default().fg(p.text)),
        ]);
    }
    if trimmed.starts_with('|') && trimmed.ends_with('|') {
        let cells: Vec<&str> = trimmed
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect();
        if cells.iter().all(|cell| {
            cell.chars()
                .all(|c| c == '-' || c == ':' || c.is_whitespace())
        }) {
            return Line::from(Span::styled(
                "   ─────────────────────────────────",
                Style::default().fg(p.border),
            ));
        }
        let spans = cells
            .iter()
            .enumerate()
            .flat_map(|(i, cell)| {
                let mut parts = Vec::new();
                if i > 0 {
                    parts.push(Span::styled(" │ ", Style::default().fg(p.border)));
                }
                parts.extend(inline_markdown(cell, p));
                parts
            })
            .collect::<Vec<_>>();
        let mut all = vec![Span::raw("   ")];
        all.extend(spans);
        return Line::from(all);
    }
    let mut spans = vec![Span::raw("   ")];
    spans.extend(inline_markdown(&line, p));
    Line::from(spans)
}

fn code_spans(line: &str, p: Palette) -> Vec<Span<'static>> {
    let mut spans = vec![Span::raw("   ")];
    if line.trim_start().starts_with("//") || line.trim_start().starts_with('#') {
        spans.push(Span::styled(
            line.to_owned(),
            Style::default().fg(p.muted).add_modifier(Modifier::ITALIC),
        ));
        return spans;
    }
    let mut chars = line.char_indices().peekable();
    while let Some((start, ch)) = chars.next() {
        if matches!(ch, '\'' | '"' | '`') {
            let mut end = start + ch.len_utf8();
            for (index, next) in chars.by_ref() {
                end = index + next.len_utf8();
                if next == ch {
                    break;
                }
            }
            spans.push(Span::styled(
                line[start..end].to_owned(),
                Style::default().fg(p.success),
            ));
        } else if ch.is_ascii_alphabetic() || ch == '_' {
            let mut end = start + ch.len_utf8();
            while let Some((index, next)) = chars.peek().copied() {
                if next.is_ascii_alphanumeric() || next == '_' {
                    chars.next();
                    end = index + next.len_utf8();
                } else {
                    break;
                }
            }
            let word = &line[start..end];
            let keyword = [
                "fn", "func", "function", "let", "const", "var", "mut", "pub", "struct", "impl",
                "class", "return", "if", "else", "match", "for", "while", "async", "await", "use",
                "import", "export", "true", "false", "null", "None",
            ]
            .contains(&word);
            spans.push(Span::styled(
                word.to_owned(),
                Style::default()
                    .fg(if keyword { p.info } else { p.text })
                    .add_modifier(if keyword {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ));
        } else if ch.is_ascii_digit() {
            let mut end = start + ch.len_utf8();
            while let Some((index, next)) = chars.peek().copied() {
                if next.is_ascii_alphanumeric() || next == '.' {
                    chars.next();
                    end = index + next.len_utf8();
                } else {
                    break;
                }
            }
            spans.push(Span::styled(
                line[start..end].to_owned(),
                Style::default().fg(p.warning),
            ));
        } else {
            spans.push(Span::styled(ch.to_string(), Style::default().fg(p.muted)));
        }
    }
    spans
}

fn inline_markdown(input: &str, p: Palette) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    let mut rest = input;
    while !rest.is_empty() {
        let candidates = [
            ("**", Modifier::BOLD, p.text),
            ("`", Modifier::empty(), p.code),
            ("*", Modifier::ITALIC, p.text),
        ];
        let next = candidates
            .iter()
            .filter_map(|(mark, modifier, color)| {
                rest.find(mark)
                    .map(|index| (index, *mark, *modifier, *color))
            })
            .min_by_key(|entry| entry.0);
        let Some((index, marker, modifier, color)) = next else {
            out.push(Span::styled(rest.to_owned(), Style::default().fg(p.text)));
            break;
        };
        if index > 0 {
            out.push(Span::styled(
                rest[..index].to_owned(),
                Style::default().fg(p.text),
            ));
        }
        let content_start = index + marker.len();
        if let Some(close) = rest[content_start..].find(marker) {
            let content = &rest[content_start..content_start + close];
            out.push(Span::styled(
                content.to_owned(),
                Style::default().fg(color).add_modifier(modifier),
            ));
            rest = &rest[content_start + close + marker.len()..];
        } else {
            out.push(Span::raw(marker.to_owned()));
            rest = &rest[content_start..];
        }
    }
    out
}

#[cfg(test)]
mod row_measurement_tests {
    use super::*;
    use crate::model::Card;

    #[test]
    fn markdown_cache_preserves_fence_state_diff_mode_and_palette() {
        let lines = [
            "# Heading",
            "```rust",
            "let x = 42;",
            "```",
            "- ordinary bullet",
            "```diff",
            "- removed",
            "@@ context",
            "```",
            "**bold** `code`",
        ];
        for theme in ["dark", "light", "ansi", "high-contrast"] {
            for diff in [false, true] {
                let p = resolved_palette(theme, "truecolor", &serde_json::Value::Null);
                let mut code = false;
                let mut language = String::new();
                let expected: Vec<_> = lines
                    .iter()
                    .map(|raw| format_markdown_line(raw, p, &mut code, &mut language, diff))
                    .collect();
                assert_eq!(format_markdown(&lines, p, diff), expected);
                assert_eq!(format_markdown(&lines, p, diff), expected);
            }
        }
    }

    #[test]
    fn markdown_cache_bounds_lines_and_fence_state() {
        let mut cache = MarkdownLineCache::new();
        let key = |text: String| MarkdownLineKey {
            text,
            code: false,
            language: String::new(),
            diff: false,
            palette: String::new(),
        };
        for n in 0..600 {
            cache.insert(
                key(n.to_string()),
                (Line::from("line"), false, String::new()),
            );
        }
        assert_eq!(cache.entries.len(), MarkdownLineCache::MAX_ENTRIES);
        assert!(cache.get(&key("0".into())).is_none());
        let large = key("x".repeat(MarkdownLineCache::MAX_LINE_BYTES + 1));
        cache.insert(large.clone(), (Line::from("large"), false, String::new()));
        assert!(cache.get(&large).is_none());
        let mut large_fence = key("small".into());
        large_fence.language = "x".repeat(257);
        cache.insert(
            large_fence.clone(),
            (Line::from("fenced"), true, large_fence.language.clone()),
        );
        assert!(cache.get(&large_fence).is_none());
    }

    #[test]
    fn markdown_bullets_use_text_and_diff_rows_use_change_colors() {
        for theme in ["dark", "light", "ansi", "high-contrast"] {
            let p = resolved_palette(theme, "truecolor", &serde_json::Value::Null);
            let prose = format_markdown(&["- completed a task", "ordinary text"], p, false);
            assert_eq!(prose[0].spans[0].content, "   • ");
            assert_eq!(prose[0].spans[1].style.fg, Some(p.text));
            assert_eq!(prose[1].spans[1].style.fg, Some(p.text));
            let diff = format_markdown(&["- removed", "+ added"], p, true);
            assert_eq!(diff[0].style.fg, Some(p.danger));
            assert_eq!(diff[1].style.fg, Some(p.success));
            let fenced = format_markdown(&["```diff", "- old", "+ new", "```"], p, false);
            assert_eq!(fenced[1].style.fg, Some(p.danger));
            assert_eq!(fenced[2].style.fg, Some(p.success));
        }
    }

    #[test]
    fn history_measurements_follow_streams_resize_fold_and_replacement() {
        let mut card = Card {
            agent: "main".into(),
            title: "shell".into(),
            primary: String::new(),
            metadata: String::new(),
            body: "short".into(),
            status: "streaming".into(),
            payload_ref: None,
            detail: None,
            detail_loading: false,
            open_url: None,
            started_at: None,
            tool_id: String::new(),
            tool_name: "shell".into(),
        };
        let mut expanded = HashSet::new();
        let p = palette("dark");
        let short = card_row_count(&card, 0, &expanded, p, 80);
        card.body = (0..20)
            .map(|i| format!("row {i}: a long saved reply with unicode 界界 and **formatting**\n"))
            .collect();
        let folded = card_row_count(&card, 0, &expanded, p, 80);
        assert!(folded > short);
        expanded.insert(0);
        let full = card_row_count(&card, 0, &expanded, p, 80);
        assert!(full > folded);
        assert!(card_row_count(&card, 0, &expanded, p, 25) > full);
        expanded.clear();
        assert_eq!(card_row_count(&card, 0, &expanded, p, 80), folded);
        // Resume can reuse both a card index and event seq for a different body.
        card.body = "replacement".into();
        assert_eq!(card_row_count(&card, 0, &expanded, p, 80), short);
        card.payload_ref = Some("stored-result".into());
        assert!(card_row_count(&card, 0, &expanded, p, 80) > short);
    }

    #[test]
    fn measurement_cache_has_a_fixed_bound_and_retains_no_transcript_text() {
        ROW_MEASUREMENTS.with(|cache| {
            *cache.borrow_mut() = (0..MAX_ROW_MEASUREMENTS as u64).map(|i| (i, 1)).collect();
        });
        let card = Card {
            agent: "main".into(),
            title: "Prompt".into(),
            primary: String::new(),
            metadata: String::new(),
            body: "bounded-cache-fixture".into(),
            status: "done".into(),
            payload_ref: None,
            detail: None,
            detail_loading: false,
            open_url: None,
            started_at: None,
            tool_id: String::new(),
            tool_name: String::new(),
        };
        assert!(card_row_count(&card, 0, &HashSet::new(), palette("dark"), 80) > 1);
        ROW_MEASUREMENTS.with(|cache| assert!(cache.borrow().len() <= MAX_ROW_MEASUREMENTS));
    }
}
