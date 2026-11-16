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
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    hash::{Hash, Hasher},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy)]
struct Palette {
    accent: Color,
    text: Color,
    muted: Color,
    border: Color,
    selection: Color,
    input_bg: Color,
    info: Color,
    success: Color,
    warning: Color,
    danger: Color,
    code: Color,
    agent_colors: [Color; 5],
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
            info: Color::Cyan,
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
            info: Color::Cyan,
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
            info: Color::Rgb(120, 166, 232),
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
            (&mut p.info, "brand.data"),
            (&mut p.success, "state.success"),
            (&mut p.warning, "state.warn"),
            (&mut p.danger, "state.danger"),
            (&mut p.code, "syntax.string"),
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
    for color in [
        &mut p.accent,
        &mut p.text,
        &mut p.muted,
        &mut p.border,
        &mut p.selection,
        &mut p.input_bg,
        &mut p.info,
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
    } else if input.contains('\n') {
        (input.split('\n').count() as u16 + 3)
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
        (input.lines().count() as u16 + 2).clamp(3, 7)
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
    let action = text.find("Show details")?;
    let left = UnicodeWidthStr::width(&text[..action]);
    let col = (position.x - inner.x) as usize;
    (col >= left && col < left + "Show details".len()).then_some(*index)
}

#[derive(Debug, PartialEq, Eq)]
pub enum MousePanel {
    Transcript,
    Agents,
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
            format!("  {}", middle_ellipsis(&safe_text(&model.model), 28)),
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
        transcript_lines(
            model,
            expanded,
            focused,
            p,
            transcript_rect(columns[0], inline).width as usize,
            agent_filter,
            scroll,
            rows[1].height.saturating_sub(if inline { 0 } else { 2 }) as usize,
        )
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
                    let elapsed = agent.elapsed_ms.map(|ms| format!("{:.0}s", ms / 1000.0));
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

    let mut prompt = if let Some(approval) = &model.approval {
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
            input
                .split('\n')
                .enumerate()
                .map(|(index, line)| {
                    let gutter = if index == 0 { "› " } else { "  │ " };
                    Line::from(vec![
                        Span::styled(
                            gutter,
                            Style::default()
                                .fg(if index == 0 { p.accent } else { p.border })
                                .add_modifier(if index == 0 {
                                    Modifier::BOLD
                                } else {
                                    Modifier::empty()
                                }),
                        ),
                        Span::styled(safe_text(line), Style::default().fg(p.text)),
                    ])
                })
                .collect()
        }
    };
    if model.approval.is_none() && input.trim_start().starts_with('/') {
        let prefix = input.trim();
        let suggestions = model
            .command_catalog
            .iter()
            .filter(|(name, _)| name.starts_with(prefix))
            .take(3)
            .map(|(name, description)| format!("{name}  {description}"))
            .collect::<Vec<_>>();
        if !suggestions.is_empty() {
            prompt.push(Line::from(Span::styled(
                format!("  {}", suggestions.join("   ·   ")),
                Style::default().fg(p.muted),
            )));
        }
    }
    let prompt_inner_height = rows[3]
        .height
        .saturating_sub(if inline { 1 } else { 2 })
        .max(1);
    let input_lines: Vec<&str> = input.split('\n').collect();
    let suggestion_rows = prompt.len().saturating_sub(input_lines.len()) as u16;
    let prompt_visible_rows = prompt_inner_height.saturating_sub(suggestion_rows).max(1);
    let input_width = rows[3]
        .width
        .saturating_sub(if inline { 2 } else { 4 })
        .max(1) as usize;
    let cursor_line_index = input[..cursor.min(input.len())].matches('\n').count();
    let cursor_line = input[..cursor.min(input.len())]
        .rsplit('\n')
        .next()
        .unwrap_or("");
    let cursor_gutter_width = if cursor_line_index == 0 { 2 } else { 4 };
    let cursor_column = cursor_gutter_width + UnicodeWidthStr::width(cursor_line);
    let mut cursor_row = 0usize;
    for (index, line) in input_lines.iter().enumerate().take(cursor_line_index + 1) {
        let gutter = if index == 0 { 2 } else { 4 };
        if index == cursor_line_index {
            cursor_row += (gutter + UnicodeWidthStr::width(cursor_line)) / input_width;
        } else {
            let line_width = gutter + UnicodeWidthStr::width(*line);
            cursor_row += line_width.max(1).div_ceil(input_width);
        }
    }
    let prompt_scroll = cursor_row.saturating_sub(prompt_visible_rows.saturating_sub(1) as usize);
    frame.render_widget(
        Paragraph::new(prompt)
            .style(Style::default().bg(p.input_bg))
            .wrap(Wrap { trim: true })
            .scroll((prompt_scroll.min(u16::MAX as usize) as u16, 0))
            .block(
                Block::default()
                    .padding(Padding::horizontal(1))
                    .borders(if inline { Borders::TOP } else { Borders::ALL })
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

    let shortcuts = if detail_card.is_some() {
        "Esc to return · ↑↓ / PgUp / PgDn scroll".to_owned()
    } else if inline && area.width < 32 {
        "Ctrl+C twice quit".to_owned()
    } else if inline && area.width < 52 {
        "Enter send · Ctrl+C twice quit".to_owned()
    } else if inline && area.width < 78 {
        "Tab history/input · Enter send · Ctrl+C twice quit".to_owned()
    } else if inline {
        "Tab input/history · Enter details/send · /tui fullscreen · Ctrl+C twice quit".to_owned()
    } else if interactive && agent_filter.is_some() {
        "Ctrl+N/P card · Enter details · Esc main · Ctrl+O expand all".to_owned()
    } else if interactive && focus_panel == 2 {
        "↑↓ select agent · Enter transcript · Tab input · Ctrl+C twice quit".to_owned()
    } else if interactive && focus_panel == 1 {
        "↑↓/PgUp history · Enter details · Ctrl+O expand · Tab agents".to_owned()
    } else if interactive {
        "Enter send · Ctrl+J new line · Tab transcript · /tui default · Ctrl+C twice quit"
            .to_owned()
    } else {
        "↑↓ scroll · Enter expand · Ctrl+O expand all · q quit".to_owned()
    };
    let state = safe_text(&model.status);
    let tokens = if model.usage_known {
        format!("{} in · {} out", model.input_tokens, model.output_tokens)
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
    let metrics = format!("{tokens} · {context} · {cost}");
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("● ", Style::default().fg(p.info)),
            Span::styled(state, Style::default().fg(p.text)),
            Span::styled(format!("  ·  {metrics}"), Style::default().fg(p.muted)),
        ])),
        rows[4],
    );
    frame.render_widget(
        Paragraph::new(format!("  {shortcuts}"))
            .style(Style::default().fg(p.muted).add_modifier(Modifier::DIM)),
        rows[5],
    );
    if let Some(interaction) = &model.interaction {
        let width = area.width.saturating_sub(2).min(88).max(1);
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
            Span::styled(format!(" {glyph} "), Style::default().fg(color)),
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
    pub end: u16,
    pub page: u16,
    pub cards: Vec<(usize, u16)>,
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
        end: total
            .saturating_sub(page as usize)
            .min((u16::MAX - 1) as usize) as u16,
        page,
        cards,
    }
}

fn transcript_lines(
    model: &Model,
    expanded: &HashSet<usize>,
    focused: Option<usize>,
    p: Palette,
    width: usize,
    agent_filter: Option<&str>,
    scroll: u16,
    visible_rows: usize,
) -> Vec<Line<'static>> {
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
            let lines = wrap_rows(
                card_lines(card, index, expanded, focused, p, width, usize::MAX),
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
            let rows = wrap_rows(
                card_lines(card, index, expanded, focused, p, width, usize::MAX),
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
        "failed" | "error" => ("✗", p.danger),
        "denied" | "cancelled" => ("⊘", p.muted),
        "done" | "complete" | "ready" => ("✓", p.success),
        _ => ("•", p.accent),
    };
    let focus = if focused == Some(index) { "›" } else { " " };
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
    let display_title = if card.title == "Assistant" {
        ""
    } else if let Some(agent) = agent_message {
        agent
    } else if is_user {
        "You"
    } else {
        &card.title
    };
    let display_status = if is_assistant && card.status == "streaming" {
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
    } else if is_user {
        p.text
    } else {
        p.text
    };
    let metadata_width = UnicodeWidthStr::width(card.metadata.as_str()).min(18);
    let heading_width = if !is_assistant || card.title == "Agent report" {
        3 + UnicodeWidthStr::width(display_title).max(12)
            + 1
            + UnicodeWidthStr::width(display_status).max(9)
            + 1
    } else {
        3
    };
    let fixed_width = heading_width + metadata_width;
    let primary = middle_ellipsis(
        &safe_text(&card.primary),
        width.saturating_sub(fixed_width + 2),
    );
    let metadata = if card.metadata.is_empty() {
        String::new()
    } else {
        middle_ellipsis(
            &safe_text(&card.metadata),
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
        heading.push(Span::styled(
            format!("{:<9} ", safe_text(display_status)),
            Style::default().fg(color),
        ));
    }
    if !primary.is_empty() {
        heading.push(Span::styled(primary, Style::default().fg(p.muted)));
    }
    heading.push(Span::raw(" ".repeat(gap)));
    if !metadata.is_empty() {
        heading.push(Span::styled(metadata, Style::default().fg(p.muted)));
    }
    let mut lines = vec![Line::from(heading)];
    if budget <= 1 {
        return lines;
    }
    let total = card.body.lines().count();
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
    // Conversation messages stay complete; only tool/command/status cards fold.
    let is_message = is_assistant || is_user;
    let limit = if is_message {
        usize::MAX
    } else {
        match card.status.as_str() {
            "running" | "streaming" => 2,
            "failed" | "error" => 4,
            "requested" | "queued" => 1,
            _ => 2,
        }
    };
    let is_expanded = expanded.contains(&index);
    let has_more = if is_message {
        false
    } else {
        card.payload_ref.is_some() || total > limit || details_total > limit || long_line
    };
    let body_room = budget
        .saturating_sub(1)
        .saturating_sub(usize::from(has_more));
    let show = if is_expanded || is_message {
        body_room.min(total)
    } else {
        limit.min(body_room).min(total)
    };
    let failure_tail =
        matches!(card.status.as_str(), "failed" | "error") && !expanded.contains(&index);
    // A reply that is still streaming shows its newest lines, not its first.
    let tail = failure_tail;
    let selected_lines: Vec<&str> = if tail {
        card.body
            .lines()
            .rev()
            .take(show)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect()
    } else {
        card.body.lines().take(show).collect()
    };
    let body_lines: Vec<String> = if is_message {
        // Message lines get a 4-column speaker gutter plus the 3-column
        // markdown indent; wrap to what remains so the paragraph widget
        // never re-wraps and pushes the newest line out of the viewport.
        let wrap_width = content_width.saturating_sub(3).max(8);
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
            line.spans
                .insert(0, Span::styled("  │ ", Style::default().fg(p.muted)));
        }
    }
    lines.extend(rendered_body.into_iter().take(body_room));
    if has_more && lines.len() < budget {
        let hint = if card.payload_ref.is_some() && card.detail.is_none() {
            " · stored full result".to_owned()
        } else if details_total > show {
            format!(" · {} more lines", details_total - show)
        } else {
            " · full line".to_owned()
        };
        lines.push(Line::from(vec![
            Span::styled(
                format!("   ＋ Show details{hint}"),
                Style::default().fg(p.info).add_modifier(Modifier::BOLD),
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

fn format_markdown(lines: &[&str], p: Palette, diff: bool) -> Vec<Line<'static>> {
    let mut code = false;
    let mut language = String::new();
    lines
        .iter()
        .map(|raw| {
            let line = safe_text(raw);
            if line.trim_start().starts_with("```") {
                code = !code;
                let fence_language = line.trim().trim_matches('`');
                if code {
                    language = fence_language.to_owned();
                }
                return Line::from(Span::styled(
                    if code {
                        format!("   {}", language)
                    } else {
                        String::new()
                    },
                    Style::default().fg(p.muted).add_modifier(Modifier::ITALIC),
                ));
            }
            if diff || (code && matches!(language.as_str(), "diff" | "patch")) {
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
            if code {
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
        })
        .collect()
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
        };
        assert!(card_row_count(&card, 0, &HashSet::new(), palette("dark"), 80) > 1);
        ROW_MEASUREMENTS.with(|cache| assert!(cache.borrow().len() <= MAX_ROW_MEASUREMENTS));
    }
}
