use bahulam_tui::{
    browser_links,
    capabilities::TerminalCapabilities,
    clipboard, composer, copy_menu, integrations,
    model::safe_text,
    open_target,
    paste::{self, display_paste_chips, expand_paste_chips, insert_paste_chip},
    render::{details_at, draw_with_view, history_geometry, mouse_panel_at_view, MousePanel},
    replay,
};
use crossterm::{
    cursor::Show,
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    style::ResetColor,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal, TerminalOptions, Viewport};
use std::{
    collections::HashSet,
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, IsTerminal, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use unicode_segmentation::UnicodeSegmentation;

static ALT_SCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);

fn restore() {
    integrations::restore();
    let _ = disable_raw_mode();
    let _ = execute!(
        io::stdout(),
        DisableBracketedPaste,
        DisableMouseCapture,
        ResetColor,
        Show
    );
    if ALT_SCREEN_ACTIVE.swap(false, Ordering::AcqRel) {
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

fn open_terminal(
    inline: bool,
    config: &integrations::Config,
) -> io::Result<Terminal<CrosstermBackend<io::Stdout>>> {
    if inline {
        // Reserve the normal screen by scrolling startup output into scrollback.
        // Ratatui's Fullscreen viewport describes geometry, not alternate-screen
        // ownership: only the explicit command in the other branch enters it.
        let height = crossterm::terminal::size()?.1;
        write!(io::stdout(), "\r{}", "\n".repeat(height as usize))?;
        execute!(io::stdout(), crossterm::cursor::MoveTo(0, 0))?;
    } else {
        execute!(io::stdout(), EnterAlternateScreen)?;
        ALT_SCREEN_ACTIVE.store(true, Ordering::Release);
    }
    if config.paste {
        execute!(io::stdout(), EnableBracketedPaste)?;
    } else {
        execute!(io::stdout(), DisableBracketedPaste)?;
    }
    integrations::enter(config)?;
    Terminal::with_options(
        CrosstermBackend::new(io::stdout()),
        TerminalOptions {
            viewport: Viewport::Fullscreen,
        },
    )
}

enum ClipboardReply {
    Paste(io::Result<String>),
    Copy(io::Result<clipboard::Copied>),
    Notice(String),
    Link(Option<open_target::LinkTarget>, u64, usize),
}
fn browser_open_job(uri: String) -> std::sync::mpsc::Receiver<ClipboardReply> {
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let result = open_target::open_browser_url(&uri).unwrap_or_else(|error| error.to_string());
        let _ = tx.send(ClipboardReply::Notice(result));
    });
    rx
}

fn paint_browser_hyperlinks(
    osc8: bool,
    hovered: Option<ratatui::layout::Position>,
) -> io::Result<()> {
    use ratatui::backend::IntoCrossterm;
    let hits = bahulam_tui::render::painted_browser_links();
    if hits.is_empty() {
        return Ok(());
    }
    let mut stdout = io::stdout().lock();
    crossterm::queue!(stdout, crossterm::cursor::SavePosition)?;
    for hit in hits {
        if !browser_links::valid_url(&hit.target.uri) {
            continue;
        }
        let mut style: crossterm::style::ContentStyle = hit.style.into_crossterm();
        style
            .attributes
            .unset(crossterm::style::Attribute::Underlined);
        if hovered.is_some_and(|position| hit.area.contains(position)) {
            style.attributes.set(crossterm::style::Attribute::Bold);
        }
        crossterm::queue!(
            stdout,
            crossterm::style::SetAttribute(crossterm::style::Attribute::Reset),
            crossterm::cursor::MoveTo(hit.area.x, hit.area.y),
            crossterm::style::SetStyle(style)
        )?;
        if osc8 {
            write!(stdout, "\x1b]8;;{}\x1b\\", hit.target.uri)?;
        }
        // Prefixes/spacing are clickable but need no decorative rule underneath.
        let start = if hit.text.starts_with("↗ Open ") {
            hit.text.find("http").unwrap_or(0)
        } else {
            0
        };
        write!(stdout, "{}", &hit.text[..start])?;
        crossterm::queue!(
            stdout,
            crossterm::style::SetAttribute(crossterm::style::Attribute::Underdotted)
        )?;
        write!(stdout, "{}", &hit.text[start..])?;
        crossterm::queue!(
            stdout,
            crossterm::style::SetAttribute(crossterm::style::Attribute::NoUnderline)
        )?;
        if osc8 {
            write!(stdout, "\x1b]8;;\x1b\\")?;
        }
    }
    crossterm::queue!(
        stdout,
        crossterm::style::SetAttribute(crossterm::style::Attribute::Reset),
        crossterm::cursor::RestorePosition
    )?;
    stdout.flush()
}

fn toggle_expansion(
    model: &Arc<Mutex<bahulam_tui::model::Model>>,
    index: usize,
    expanded: &mut HashSet<usize>,
    writer: &Option<Arc<Mutex<BufWriter<File>>>>,
) -> io::Result<()> {
    let reference = if let Ok(mut state) = model.lock() {
        if state
            .cards
            .get(index)
            .is_none_or(|card| !card.is_foldable())
        {
            return Ok(());
        }
        if expanded.remove(&index) {
            state.set_composer_hint("");
            None
        } else {
            expanded.insert(index);
            state.set_composer_hint("Expanded result · Esc collapse · type to write · Ctrl+Y copy");
            state.request_details(index)
        }
    } else {
        None
    };
    if let Some(payload_ref) = reference {
        write_command(
            writer,
            serde_json::json!({"type":"show_details","data":{"payload_ref":payload_ref}}),
        )?;
    }
    Ok(())
}
fn input_hint(model: &Arc<Mutex<bahulam_tui::model::Model>>, hint: &str) {
    if let Ok(mut state) = model.lock() {
        state.set_composer_hint(hint);
    }
}
fn editable(
    model: &Arc<Mutex<bahulam_tui::model::Model>>,
    focus: u8,
    details: Option<usize>,
) -> bool {
    focus == 0
        && details.is_none()
        && model
            .lock()
            .is_ok_and(|m| m.interaction.is_none() && m.approval.is_none())
}
struct TerminalGuard;
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

fn scoped_card_indices(
    model: &bahulam_tui::model::Model,
    agent_filter: Option<&str>,
) -> Vec<usize> {
    model
        .cards
        .iter()
        .enumerate()
        .filter(|(_, card)| card.visible_in_transcript(agent_filter.unwrap_or("main")))
        .map(|(index, _)| index)
        .collect()
}

fn scroll_history(scroll: &mut usize, follow: &mut bool, end: usize, down: bool, amount: usize) {
    if *follow {
        *scroll = end;
    }
    *scroll = if down {
        scroll.saturating_add(amount).min(end)
    } else {
        scroll.saturating_sub(amount).min(end)
    };
    *follow = down && *scroll >= end;
}

#[allow(clippy::too_many_arguments)]
fn visible_image_cards(
    model: &bahulam_tui::model::Model,
    area: ratatui::layout::Rect,
    input: &str,
    inline: bool,
    expanded: &std::collections::HashSet<usize>,
    theme: &str,
    agent: Option<&str>,
    scroll: usize,
    follow: bool,
) -> std::collections::HashSet<usize> {
    let g = history_geometry(model, area, input, inline, expanded, theme, agent);
    let top = if follow { g.end } else { scroll };
    let first = g
        .cards
        .partition_point(|(_, row)| *row <= top)
        .saturating_sub(1);
    g.cards[first..]
        .iter()
        .take_while(|(_, start)| *start < top.saturating_add(g.page))
        .map(|(index, _)| *index)
        .collect()
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut file = None;
    let mut plain = false;
    let mut watch = false;
    let mut stdio = false;
    let mut doctor = false;
    let mut json = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--replay" => {
                file = Some(PathBuf::from(
                    args.next().ok_or("--replay requires a path")?,
                ));
            }
            "--plain" => plain = true,
            "--watch" => watch = true,
            "--stdio" => stdio = true,
            "--doctor" => doctor = true,
            "--json" => json = true,
            "--help" | "-h" => {
                println!(
                    "Bahulam Rust terminal client\n\n\
                     USAGE:\n\
                     \x20 bahulam-tui --replay <events.jsonl> [--watch] [--plain]\n\
                     \x20 bahulam-tui --help | --version\n\n\
                     OPTIONS:\n\
                     \x20 --doctor [--json] Report terminal hints and restored features (no active probes)\n\
                     \x20 --replay <path>  Render one recorded session\n\
                     \x20 --watch          Follow an active events.jsonl file (requires --replay)\n\
                     \x20 --plain          Print replay output without taking over the terminal\n\
                     \x20 -h, --help       Show this help\n\
                     \x20 --version        Show the client version\n\n\
                     INTERNAL:\n\
                     \x20 --stdio          Live Node-hosted mode; started by Bahulam Code\n\n\
                     Examples:\n\
                     \x20 bahulam-tui --replay ~/.bahulam/sessions/<id>/events.jsonl\n\
                     \x20 BAHULAM_DAEMON_EVENTLOG=1 bahulam\n\
                     \x20 bahulam-tui --replay ~/.bahulam/sessions/<id>/events.jsonl --watch"
                );
                return Ok(());
            }
            "--version" => {
                println!("bahulam-tui {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => return Err(format!("Unknown option: {arg}. Use --help.").into()),
        }
    }
    if doctor {
        if stdio || file.is_some() || watch || plain {
            return Err("--doctor cannot be combined with replay or live mode".into());
        }
        let caps = TerminalCapabilities::detect();
        let size = if caps.interactive {
            crossterm::terminal::size().ok()
        } else {
            None
        };
        println!(
            "{}",
            if json {
                serde_json::to_string_pretty(&caps.as_json(None, size))?
            } else {
                caps.report(None, size)
            }
        );
        return Ok(());
    }
    if json {
        return Err("--json requires --doctor".into());
    }
    if stdio && (file.is_some() || watch || plain) {
        return Err("--stdio is an internal live mode and cannot be combined with --replay, --watch, or --plain.".into());
    }
    if watch && file.is_none() {
        return Err("--watch requires --replay <events.jsonl>. See --help.".into());
    }
    if plain && file.is_none() {
        return Err("--plain requires --replay <events.jsonl>. See --help.".into());
    }
    if !stdio && file.is_none() {
        return Err(
            "Use --replay <events.jsonl>. Live mode is launched by Bahulam Code. See --help."
                .into(),
        );
    }
    let mut initial = if let Some(file) = &file {
        replay(file)?
    } else {
        Default::default()
    };
    for warning in &initial.warnings {
        eprintln!("{}", safe_text(warning));
    }
    let model = Arc::new(Mutex::new(std::mem::take(&mut initial)));
    // Independent of protocol seq: controls and snapshots may reuse/reset seq.
    let render_revision = Arc::new(AtomicU64::new(0));
    let core_connected = Arc::new(AtomicBool::new(true));
    let command_writer = if stdio {
        let events = child_stdio_file(3)?;
        let shared = Arc::clone(&model);
        let connected = Arc::clone(&core_connected);
        let revision = Arc::clone(&render_revision);
        thread::spawn(move || {
            for line in BufReader::new(events).lines().map_while(Result::ok) {
                if let Ok(event) =
                    serde_json::from_str::<bahulam_tui::protocol::EventEnvelope>(&line)
                {
                    if let Ok(mut model) = shared.lock() {
                        let _ = model.apply(&event);
                        revision.fetch_add(1, Ordering::Release);
                    }
                }
            }
            connected.store(false, Ordering::Release);
        });
        Some(Arc::new(Mutex::new(BufWriter::new(child_stdio_file(4)?))))
    } else {
        None
    };
    if watch && (plain || !io::stdin().is_terminal() || !io::stdout().is_terminal()) {
        return Err("--watch requires an interactive terminal".into());
    }
    if plain || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        let model = model.lock().map_err(|_| "view model lock poisoned")?;
        println!("{}", model.transcript().join("\n"));
        println!("Agents:");
        for agent in &model.agents {
            println!("  {} [{}]", agent.label, agent.status);
        }
        println!("Plan:\n{}", model.plan.join("\n"));
        println!(
            "{} | seq {} | {} in / {} out",
            safe_text(&model.status),
            model.last_seq,
            model.input_tokens,
            model.output_tokens
        );
        return Ok(());
    }
    let mut capabilities = TerminalCapabilities::detect();
    let mut integration_state = integrations::SessionState::default();
    let mut terminal_focused = true;
    let mut reported_integration_state = (false, false);
    let mut visible_link: Option<open_target::LinkTarget> = None;
    let mut pressed_browser_link = None;
    // Use the same resolved color level for standalone replay and diagnostics.
    // Hosted mode keeps Node's canonical palette selection authoritative.
    std::env::set_var("BAHULAM_TUI_COLOR_LEVEL", &capabilities.color_depth);
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        original_hook(info);
    }));
    let termination_requested = install_termination_handler()?;
    enable_raw_mode()?;
    let _guard = TerminalGuard;
    // Protect text pasted during probing; unsupported terminals ignore this mode.
    if capabilities.resolve("bracketed_paste", !capabilities.dumb) {
        execute!(io::stdout(), EnableBracketedPaste)?;
    }
    let mut pending_input = capabilities.probe()?;
    let integration_config = integrations::Config::from_caps(&capabilities);
    let mut inline_mode =
        stdio && std::env::var("BAHULAM_TUI_MODE").map_or(true, |mode| mode == "inline");
    // Wheel navigation belongs to the Rust conversation in both views.
    // Alt+M suspends capture and repainting for native terminal text selection.
    let mut mouse_enabled = capabilities.mouse_capture;
    let mut selecting_text = false;
    let mut selection_frame_pending = false;
    let mut drag_selection: Option<bahulam_tui::text_selection::TextSelection> = None;
    let mut painted_buffer: Option<ratatui::buffer::Buffer> = None;
    let mut mouse_position: Option<ratatui::layout::Position> = None;
    let mut hovered_browser_link = None;
    let mut terminal = open_terminal(inline_mode, &integration_config)?;
    if mouse_enabled {
        execute!(io::stdout(), EnableMouseCapture)?;
    }
    report_capabilities(
        &command_writer,
        &capabilities,
        inline_mode,
        terminal.get_frame().area(),
        &model,
    )?;
    let mut scroll: usize = 0;
    let mut follow = stdio;
    let mut expansion_anchor = None;
    let mut painted_anchor = None;
    let mut seen_transcript_revision = model
        .lock()
        .map(|state| state.transcript_revision)
        .unwrap_or_default();
    let mut last_refresh = std::time::Instant::now();
    let mut input = String::new();
    let mut cursor = 0usize;
    let mut paste_chips = Vec::new();
    let mut paste_sequence = 0u64;
    let mut pending_copy: Option<(String, usize, u64)> = None;
    let status_command = std::env::var("BAHULAM_TUI_STATUS_COMMAND").unwrap_or_default();
    let mut status_worker: Option<std::sync::mpsc::Receiver<(u64, String)>> = None;
    let mut status_checked = std::time::Instant::now() - Duration::from_secs(5);
    let mut prompt_history = composer::History::load();
    let mut history_search: Option<composer::Search> = None;
    let mut clipboard_job: Option<std::sync::mpsc::Receiver<ClipboardReply>> = None;
    let mut paste_origin: Option<(String, usize, u64)> = None;
    let mut theme = capabilities.theme.clone();
    let mut expanded = HashSet::new();
    let mut focused_card = 0usize;
    let mut focused_agent = 0usize;
    let mut focus_panel = 0u8; // prompt, transcript, agents
    let mut agent_filter: Option<String> = None;
    let mut agent_return: Option<(
        usize,
        bool,
        usize,
        Option<bahulam_tui::render::HistoryAnchor>,
    )> = None;
    let mut pressed_agent = None;
    let mut detail_card: Option<usize> = None;
    let mut detail_scroll = 0usize;
    // Live mode: one Ctrl+C interrupts the agent, a second within two
    // seconds quits. One accidental press never ends the session.
    let mut last_ctrl_c: Option<std::time::Instant> = None;
    let mut last_timer_draw = std::time::Instant::now();
    let mut image_job: Option<
        std::sync::mpsc::Receiver<(usize, u64, bahulam_tui::rich_preview::Preview)>,
    > = None;
    let mut dirty = true;
    let mut drawn_revision = 0;
    loop {
        if termination_requested.load(Ordering::Relaxed) {
            break;
        }
        let frame_revision = render_revision.load(Ordering::Acquire);
        dirty |= frame_revision != drawn_revision;
        if last_timer_draw.elapsed() >= Duration::from_secs(1) {
            dirty |= model.lock().is_ok_and(|state| {
                state.cards.iter().any(|card| card.started_at.is_some())
                    || state.agents.iter().any(|agent| agent.started_at.is_some())
            });
            last_timer_draw = std::time::Instant::now();
        }
        if stdio && !core_connected.load(Ordering::Acquire) {
            break;
        }
        if let Ok(state) = model.lock() {
            integration_state.update(&state, &integration_config, terminal_focused)?;
            let terminal_modes = integrations::terminal_state();
            if terminal_modes != reported_integration_state {
                report_terminal_state(&command_writer, true, inline_mode)?;
                reported_integration_state = terminal_modes;
            }
            if (state.interaction.is_some() || state.approval.is_some()) && history_search.is_some()
            {
                if let Some(search) = history_search.take() {
                    (input, cursor) = search.draft;
                }
            }
            if state.approval.is_some() && detail_card.is_none() {
                focus_panel = 0;
            }
            if state.transcript_revision != seen_transcript_revision {
                dirty = true;
                seen_transcript_revision = state.transcript_revision;
                visible_link = None;
                expanded.clear();
                expansion_anchor = None;
                painted_anchor = None;
                scroll = 0;
                follow = true;
                focused_card = state.cards.len().saturating_sub(1);
                agent_filter = None;
                agent_return = None;
                detail_card = None;
                detail_scroll = 0;
                focus_panel = 0;
            }
        }
        if let Some((index, revision, preview)) =
            image_job.as_ref().and_then(|job| job.try_recv().ok())
        {
            image_job = None;
            if let Ok(mut state) = model.lock() {
                if state.transcript_revision == revision {
                    if let Some(card) = state.cards.get_mut(index) {
                        card.preview = Some(preview);
                        dirty = true;
                    }
                    state.touch_view();
                    let visible = visible_image_cards(
                        &state,
                        terminal.get_frame().area(),
                        &input,
                        inline_mode,
                        &expanded,
                        &theme,
                        agent_filter.as_deref(),
                        scroll,
                        follow,
                    );
                    let ready: Vec<_> = state
                        .cards
                        .iter()
                        .enumerate()
                        .filter_map(|(i, c)| {
                            if let Some(bahulam_tui::rich_preview::Preview::Ready(image)) =
                                &c.preview
                            {
                                Some((
                                    i,
                                    image.pixels.len(),
                                    image.source.to_string_lossy().into_owned(),
                                ))
                            } else {
                                None
                            }
                        })
                        .collect();
                    let mut count = ready.len();
                    let mut bytes: usize = ready.iter().map(|(_, size, _)| size).sum();
                    for (index, size, path) in ready {
                        if count <= 64 && bytes <= 16 * 1024 * 1024 {
                            break;
                        }
                        if visible.contains(&index) {
                            continue;
                        }
                        state.cards[index].preview =
                            Some(bahulam_tui::rich_preview::Preview::Dormant(path));
                        count -= 1;
                        bytes = bytes.saturating_sub(size);
                    }
                    state.touch_view();
                }
            }
        }
        if image_job.is_none() {
            let pending = model.lock().ok().and_then(|mut state| {
                if !state.cards.iter().any(|c| {
                    matches!(
                        c.preview,
                        Some(
                            bahulam_tui::rich_preview::Preview::Pending(_)
                                | bahulam_tui::rich_preview::Preview::Dormant(_)
                        )
                    )
                }) {
                    return None;
                }
                let visible = visible_image_cards(
                    &state,
                    terminal.get_frame().area(),
                    &input,
                    inline_mode,
                    &expanded,
                    &theme,
                    agent_filter.as_deref(),
                    scroll,
                    follow,
                );
                let (index, path) = state
                    .cards
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| visible.contains(i))
                    .find_map(|(i, card)| match &card.preview {
                        Some(
                            bahulam_tui::rich_preview::Preview::Pending(path)
                            | bahulam_tui::rich_preview::Preview::Dormant(path),
                        ) => Some((i, path.clone())),
                        _ => None,
                    })?;
                let path = std::path::Path::new(&state.cwd).join(path);
                state.cards[index].preview = Some(bahulam_tui::rich_preview::Preview::Loading);
                Some((index, state.transcript_revision, path))
            });
            if let Some((index, revision, path)) = pending {
                let (tx, rx) = std::sync::mpsc::channel();
                image_job = Some(rx);
                let graphics = bahulam_tui::native_graphics::Graphics::detect(&capabilities);
                thread::spawn(move || {
                    let result =
                        match bahulam_tui::rich_preview::load_with_graphics(&path, graphics) {
                            Ok(image) => bahulam_tui::rich_preview::Preview::Ready(image),
                            Err(error) => bahulam_tui::rich_preview::Preview::Unavailable(error),
                        };
                    let _ = tx.send((index, revision, result));
                });
            }
        }
        if watch && !stdio && last_refresh.elapsed() >= Duration::from_millis(100) {
            if let Some(file) = &file {
                *model.lock().map_err(|_| "view model lock poisoned")? = replay(file)?;
                dirty = true;
            }
            last_refresh = std::time::Instant::now();
        }
        if dirty && stdio {
            let requests = model
                .lock()
                .ok()
                .map(|mut m| {
                    let indices: Vec<_> = m
                        .cards
                        .iter()
                        .enumerate()
                        .filter(|(i, card)| {
                            card.title != "Thinking"
                                && (!card.is_foldable() || expanded.contains(i))
                                && card.payload_ref.is_some()
                                && !card.has_detail()
                                && !card.detail_loading
                        })
                        .take(4)
                        .map(|(i, _)| i)
                        .collect();
                    indices
                        .into_iter()
                        .filter_map(|i| m.request_details(i))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for payload_ref in requests {
                write_command(
                    &command_writer,
                    serde_json::json!({"type":"show_details","data":{"payload_ref":payload_ref}}),
                )?;
            }
        }
        if stdio && !status_command.trim().is_empty() {
            if let Some((revision, text)) = status_worker
                .as_ref()
                .and_then(|worker| worker.try_recv().ok())
            {
                status_worker = None;
                if let Ok(mut state) = model.lock() {
                    if state.transcript_revision == revision && state.custom_status != text {
                        state.custom_status = text;
                        dirty = true;
                    }
                }
            }
            if status_worker.is_none() && status_checked.elapsed() >= Duration::from_secs(5) {
                status_checked = std::time::Instant::now();
                let (tx, rx) = std::sync::mpsc::channel();
                status_worker = Some(rx);
                let (cwd, revision) = model
                    .lock()
                    .map(|state| (state.cwd.clone(), state.transcript_revision))
                    .unwrap_or_default();
                let command = status_command.clone();
                thread::spawn(move || {
                    let _ = tx.send((revision, integrations::run_status_command(&command, &cwd)));
                });
            }
        }
        if let Some((selection, index, revision)) =
            pending_copy.clone().filter(|_| clipboard_job.is_none())
        {
            if revision != seen_transcript_revision {
                pending_copy = None;
            } else {
                let mut request = None;
                let mut waiting = false;
                let content = if let Ok(mut state) = model.lock() {
                    let target_index = if selection == "last" {
                        state.cards.iter().rposition(|c| c.title == "Assistant")
                    } else if selection == "card" || selection == "code" {
                        Some(index)
                    } else {
                        selection.split(':').nth(1).and_then(|v| v.parse().ok())
                    };
                    let needed = state
                        .cards
                        .iter()
                        .enumerate()
                        .find(|(i, c)| {
                            (selection == "transcript" || Some(*i) == target_index)
                                && c.payload_ref.is_some()
                                && !c.has_detail()
                        })
                        .map(|(i, c)| (i, c.detail_loading));
                    if let Some((i, loading)) = needed {
                        waiting = true;
                        if !loading {
                            request = state.request_details(i);
                        }
                        None
                    } else {
                        copy_menu::selection_text(&state, &selection, index)
                    }
                } else {
                    None
                };
                if let Some(payload_ref) = request {
                    write_command(
                        &command_writer,
                        serde_json::json!({"type":"show_details","data":{"payload_ref":payload_ref}}),
                    )?;
                }
                if !waiting {
                    pending_copy = None;
                    if let Some(text) = content.filter(|text| !text.is_empty()) {
                        let (tx, rx) = std::sync::mpsc::channel();
                        clipboard_job = Some(rx);
                        thread::spawn(move || {
                            let _ = tx.send(ClipboardReply::Copy(clipboard::copy_text(&text)));
                        });
                    } else {
                        input_hint(&model, "No content is available for that copy choice");
                    }
                }
            }
        }
        if let Some(reply) = clipboard_job.as_ref().and_then(|job| job.try_recv().ok()) {
            clipboard_job = None;
            dirty = true;
            match reply {
                ClipboardReply::Notice(message) => input_hint(&model, &message),
                ClipboardReply::Link(target, revision, card) => {
                    if revision != seen_transcript_revision || card != focused_card {
                        continue;
                    }
                    visible_link = target;
                    input_hint(
                        &model,
                        "Alt+O opens selected file/URL · terminal link available below",
                    );
                }
                ClipboardReply::Paste(result) => {
                    let unchanged = paste_origin.take().is_some_and(|(draft, at, revision)| {
                        draft == input && at == cursor && revision == seen_transcript_revision
                    });
                    if !unchanged
                        || !editable(&model, focus_panel, detail_card)
                        || history_search.is_some()
                    {
                        input_hint(
                            &model,
                            "Draft changed during clipboard read; press Ctrl+V to retry",
                        );
                    } else {
                        match result {
                            Ok(text)
                                if !text.is_empty()
                                    && expand_paste_chips(&input, &paste_chips)
                                        .len()
                                        .saturating_add(text.len())
                                        <= composer::MAX_INPUT_BYTES =>
                            {
                                insert_paste_chip(
                                    &mut input,
                                    &mut cursor,
                                    &text,
                                    &mut paste_chips,
                                    &mut paste_sequence,
                                );
                                input_hint(&model, "Pasted text · Enter sends · Ctrl+G edits");
                            }
                            Ok(text) if text.is_empty() => input_hint(
                                &model,
                                "No clipboard text · use /attach clipboard for an image",
                            ),
                            Ok(_) => input_hint(&model, "Prompt exceeds the 5 MiB paste limit"),
                            Err(error) => input_hint(&model, &error.to_string()),
                        }
                    }
                }
                ClipboardReply::Copy(result) => match result {
                    Ok(result) => {
                        if let Some(sequence) = result.terminal_sequence {
                            write!(io::stdout(), "{sequence}")?;
                            io::stdout().flush()?;
                        }
                        if let Ok(mut state) = model.lock() {
                            state.set_composer_hint(&result.message);
                            state.copy_confirmed = true;
                        }
                    }
                    Err(error) => input_hint(&model, &error.to_string()),
                },
            }
        }
        if follow && dirty {
            focused_card = model
                .lock()
                .map(|m| {
                    m.cards
                        .iter()
                        .rposition(|card| {
                            card.visible_in_transcript(agent_filter.as_deref().unwrap_or("main"))
                        })
                        .unwrap_or(0)
                })
                .unwrap_or(0);
        }
        if let Ok(mut state) = model.lock() {
            state.slash_menu.sync(&input);
        }
        let display_input = display_paste_chips(&input, &paste_chips);
        let display_cursor = display_paste_chips(&input[..cursor], &paste_chips).len();
        let viewport = terminal.get_frame().area();
        let geometry = || {
            model.lock().ok().map(|m| {
                history_geometry(
                    &m,
                    viewport,
                    &display_input,
                    inline_mode,
                    &expanded,
                    &theme,
                    agent_filter.as_deref(),
                )
            })
        };
        if let Some(anchor) = expansion_anchor.take() {
            painted_anchor = None;
            if let Some(layout) = geometry() {
                scroll = layout.anchored_scroll(anchor);
            }
            follow = false;
        }
        if dirty && (!selecting_text || selection_frame_pending) {
            selection_frame_pending = false;
            if integration_config.sync {
                write!(io::stdout(), "\x1b[?2026h")?;
            }
            let completed = terminal.draw(|frame| {
                if let Some(selection) = drag_selection.as_ref().filter(|s| s.dragging) {
                    selection.paint(frame.buffer_mut());
                    let (hint, confirmed) = if selection.released {
                        model
                            .lock()
                            .ok()
                            .filter(|state| !state.composer_hint.is_empty())
                            .map(|state| (state.composer_hint.clone(), state.copy_confirmed))
                            .unwrap_or_else(|| ("Text selected".into(), false))
                    } else {
                        ("Release mouse to copy".into(), false)
                    };
                    let area = frame.area();
                    let footer = ratatui::layout::Rect::new(
                        area.x,
                        area.bottom().saturating_sub(1),
                        area.width,
                        1,
                    );
                    frame.render_widget(ratatui::widgets::Clear, footer);
                    frame.render_widget(
                        bahulam_tui::render::selection_footer(&hint, confirmed, &theme),
                        footer,
                    );
                    return;
                }
                if let Ok(model) = model.lock() {
                    if !follow && !expanded.is_empty() && detail_card.is_none() {
                        let layout = history_geometry(
                            &model,
                            frame.area(),
                            &display_input,
                            inline_mode,
                            &expanded,
                            &theme,
                            agent_filter.as_deref(),
                        );
                        // Live events may reflow earlier cards between consecutive frames.
                        // An explicit scroll or view switch takes precedence over that anchor.
                        if let Some((revision, old_scroll, anchor)) = painted_anchor {
                            if revision != model.view_revision && old_scroll == scroll {
                                scroll = layout.anchored_scroll(anchor);
                            }
                        }
                        painted_anchor = layout
                            .anchor(scroll, false)
                            .map(|anchor| (model.view_revision, scroll, anchor));
                    } else {
                        painted_anchor = None;
                    }
                    draw_with_view(
                        frame,
                        &model,
                        if follow { usize::MAX } else { scroll },
                        stdio || watch,
                        &theme,
                        &display_input,
                        display_cursor,
                        &expanded,
                        Some(focused_card),
                        stdio,
                        agent_filter.as_deref(),
                        Some(focused_agent),
                        focus_panel,
                        detail_card,
                        detail_scroll,
                        inline_mode,
                    );
                }
            })?;
            if !drag_selection.as_ref().is_some_and(|s| s.dragging) {
                let mut snapshot = completed.buffer.clone();
                for cell in &mut snapshot.content {
                    if cell.symbol().contains('\u{1b}') || cell.symbol().contains('\u{10eeee}') {
                        cell.set_symbol(" ");
                    }
                }
                painted_buffer = Some(snapshot);
            }
            let show_links =
                !selecting_text && !drag_selection.as_ref().is_some_and(|s| s.dragging);
            hovered_browser_link = mouse_position
                .filter(|_| show_links && mouse_enabled)
                .and_then(bahulam_tui::render::browser_link_at);
            integrations::link_pointer(&capabilities.profile, hovered_browser_link.is_some())?;
            if show_links {
                paint_browser_hyperlinks(
                    integration_config.links,
                    mouse_position.filter(|_| mouse_enabled),
                )?;
            }
            if let Some(target) = visible_link.as_ref().filter(|_| {
                integration_config.links && !drag_selection.as_ref().is_some_and(|s| s.dragging)
            }) {
                let area = terminal.get_frame().area();
                let mut cells = 0usize;
                let label: String = safe_text(&target.label)
                    .graphemes(true)
                    .take_while(|g| {
                        cells += unicode_width::UnicodeWidthStr::width(*g);
                        cells <= area.width.saturating_sub(5) as usize
                    })
                    .collect();
                execute!(
                    io::stdout(),
                    crossterm::cursor::SavePosition,
                    crossterm::cursor::MoveTo(1, area.bottom().saturating_sub(1))
                )?;
                write!(
                    io::stdout(),
                    "\x1b]8;;{}\x1b\\↗ {}\x1b]8;;\x1b\\",
                    target.uri,
                    label
                )?;
                execute!(io::stdout(), crossterm::cursor::RestorePosition)?;
            }
            if integration_config.sync {
                write!(io::stdout(), "\x1b[?2026l")?;
                io::stdout().flush()?;
            }
            // A core event arriving during paint remains newer and triggers the next frame.
            drawn_revision = frame_revision;
            dirty = false;
        }
        if !pending_input.is_empty() || event::poll(Duration::from_millis(50))? {
            let event = if let Some(input) = pending_input.pop_front() {
                input
            } else {
                event::read()?
            };
            // A response arriving after the probe deadline is never composer input.
            if let Event::TerminalResponse(reply) = &event {
                let before = capabilities.probe.cell_pixels;
                capabilities.probe.accept(reply);
                if capabilities.probe.cell_pixels != before {
                    if let Ok(mut state) = model.lock() {
                        for card in &mut state.cards {
                            if let Some(bahulam_tui::rich_preview::Preview::Ready(image)) =
                                &card.preview
                            {
                                card.preview = Some(bahulam_tui::rich_preview::Preview::Pending(
                                    image.source.to_string_lossy().into_owned(),
                                ));
                            }
                        }
                    }
                    if let Ok(mut state) = model.lock() {
                        state.touch_view();
                    }
                    dirty = true;
                }
                continue;
            }
            dirty |= match &event {
                Event::Key(key) => key.kind == KeyEventKind::Press,
                Event::Mouse(mouse) => matches!(
                    mouse.kind,
                    MouseEventKind::ScrollUp
                        | MouseEventKind::ScrollDown
                        | MouseEventKind::Down(MouseButton::Left)
                        | MouseEventKind::Drag(MouseButton::Left)
                        | MouseEventKind::Up(MouseButton::Left)
                ),
                Event::Paste(_) | Event::Resize(_, _) | Event::FocusGained => true,
                _ => false,
            };
            if matches!(&event, Event::Key(_) | Event::Resize(..) | Event::Paste(_)) {
                mouse_position = None;
                let had_selection = drag_selection.take().is_some_and(|s| s.dragging);
                if had_selection && matches!(&event, Event::Key(key) if key.code == KeyCode::Esc) {
                    input_hint(&model, "");
                    continue;
                }
            }
            // History inspection must not swallow the first character/paste of
            // a new draft. Questions, approvals and separate details still own input.
            let starts_input = match &event {
                Event::Paste(_) => true,
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && key.code == KeyCode::Char('v')
                        && key.modifiers == KeyModifiers::CONTROL =>
                {
                    true
                }
                Event::Key(key) => {
                    key.kind == KeyEventKind::Press
                        && matches!(key.code, KeyCode::Char(_))
                        && !key
                            .modifiers
                            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                }
                _ => false,
            };
            if stdio
                && focus_panel != 0
                && history_search.is_none()
                && editable(&model, 0, detail_card)
                && starts_input
            {
                focus_panel = 0;
                input_hint(&model, "");
            }
            // Keep streaming data in the model while a native selection is on
            // screen. Any other key returns to live controls before processing it.
            if selecting_text
                && (matches!(&event, Event::Paste(_))
                    || matches!(&event, Event::Key(key)
                if key.kind == KeyEventKind::Press && !(key.code == KeyCode::Char('m')
                    && key.modifiers.contains(KeyModifiers::ALT))))
            {
                selecting_text = false;
                mouse_enabled = capabilities.mouse_capture;
                if mouse_enabled {
                    execute!(io::stdout(), EnableMouseCapture)?;
                }
                if let Ok(mut state) = model.lock() {
                    state.selecting_text = false;
                }
            }
            if selecting_text && matches!(&event, Event::Resize(..)) {
                selection_frame_pending = true;
            }
            match event {
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && key.code == KeyCode::Char('m')
                        && key.modifiers.contains(KeyModifiers::ALT) =>
                {
                    selecting_text = !selecting_text;
                    selection_frame_pending = true;
                    mouse_enabled = !selecting_text && capabilities.mouse_capture;
                    pressed_browser_link = None;
                    if mouse_enabled {
                        execute!(io::stdout(), EnableMouseCapture)?;
                    } else {
                        execute!(io::stdout(), DisableMouseCapture)?;
                    }
                    if let Ok(mut state) = model.lock() {
                        state.selecting_text = selecting_text;
                    }
                }
                Event::FocusGained => {
                    terminal_focused = true;
                }
                Event::FocusLost => {
                    terminal_focused = false;
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && key.modifiers.contains(KeyModifiers::ALT)
                        && matches!(key.code, KeyCode::Char('o' | 'l'))
                        && model
                            .lock()
                            .is_ok_and(|m| m.interaction.is_none() && m.approval.is_none()) =>
                {
                    if clipboard_job.is_some() {
                        input_hint(
                            &model,
                            "Clipboard operation still running; retry the open/link shortcut",
                        );
                        continue;
                    }
                    let target = model.lock().ok().and_then(|state| {
                        state
                            .cards
                            .get(detail_card.unwrap_or(focused_card))
                            .cloned()
                            .map(|card| (card, state.cwd.clone()))
                    });
                    if let Some((card, cwd)) = target {
                        if key.code == KeyCode::Char('l') {
                            let links = browser_links::for_card(&card);
                            if !links.is_empty() {
                                if let Ok(mut state) = model.lock() {
                                    state.interaction = Some(browser_links::picker(links));
                                }
                                continue;
                            }
                        }
                        let (tx, rx) = std::sync::mpsc::channel();
                        clipboard_job = Some(rx);
                        thread::spawn(move || {
                            let reply = if key.code == KeyCode::Char('o') {
                                ClipboardReply::Notice(
                                    open_target::open_card_target(&card, &cwd)
                                        .unwrap_or_else(|e| e.to_string()),
                                )
                            } else {
                                ClipboardReply::Link(
                                    open_target::card_link_target(&card, &cwd),
                                    seen_transcript_revision,
                                    focused_card,
                                )
                            };
                            let _ = tx.send(reply);
                        });
                    }
                }

                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && !(key.code == KeyCode::Char('c')
                            && key.modifiers.contains(KeyModifiers::CONTROL))
                        && model.lock().ok().is_some_and(|m| m.interaction.is_some()) =>
                {
                    let response = {
                        let mut state = model.lock().map_err(|_| "view model lock poisoned")?;
                        let menu = state.interaction.as_mut().unwrap();
                        let mut response = None;
                        if menu.editing {
                            match key.code {
                                KeyCode::Esc => menu.editing = false,
                                KeyCode::Enter if !menu.free_text.trim().is_empty() => {
                                    response = Some((
                                        menu.request_id.clone(),
                                        Some(menu.free_text.trim().to_owned()),
                                        false,
                                    ))
                                }
                                KeyCode::Backspace => {
                                    if let Some((at, _)) =
                                        menu.free_text.grapheme_indices(true).next_back()
                                    {
                                        menu.free_text.truncate(at);
                                    }
                                }
                                KeyCode::Char(ch)
                                    if !key
                                        .modifiers
                                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                                        && menu.free_text.len() + ch.len_utf8()
                                            <= composer::MAX_INPUT_BYTES =>
                                {
                                    menu.free_text.push(ch)
                                }
                                _ => {}
                            }
                        } else {
                            match key.code {
                                KeyCode::Up | KeyCode::BackTab => {
                                    menu.selected = menu.selected.saturating_sub(1)
                                }
                                KeyCode::Down | KeyCode::Tab => {
                                    menu.selected = (menu.selected + 1)
                                        .min(menu.options.len().saturating_sub(1))
                                }
                                KeyCode::Enter
                                    if menu.allow_free_text
                                        && menu.selected + 1 == menu.options.len() =>
                                {
                                    menu.editing = true
                                }
                                KeyCode::Enter => {
                                    response = Some((
                                        menu.request_id.clone(),
                                        menu.options
                                            .get(menu.selected)
                                            .map(|option| option.value.clone()),
                                        false,
                                    ))
                                }
                                KeyCode::Esc => {
                                    response = Some((menu.request_id.clone(), None, true))
                                }
                                _ => {}
                            }
                        }
                        if response.is_some() {
                            state.interaction = None;
                        }
                        response
                    };
                    if let Some((request_id, value, cancelled)) = response {
                        if request_id == "local-browser-links" {
                            if let Some(uri) = value.filter(|_| !cancelled) {
                                clipboard_job = Some(browser_open_job(uri));
                            }
                            continue;
                        }
                        if request_id == "local-copy" {
                            if let Some(value) = value.filter(|_| !cancelled) {
                                pending_copy =
                                    Some((value, focused_card, seen_transcript_revision));
                            }
                            continue;
                        }
                        write_command(
                            &command_writer,
                            serde_json::json!({"type":"interaction_response","data":{"request_id":request_id,"value":value,"cancelled":cancelled}}),
                        )?;
                    }
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && history_search.is_some()
                        && !(key.code == KeyCode::Char('c')
                            && key.modifiers.contains(KeyModifiers::CONTROL)) =>
                {
                    let search = history_search.as_mut().unwrap();
                    match key.code {
                        KeyCode::Esc => {
                            (input, cursor) = search.draft.clone();
                            history_search = None;
                            input_hint(&model, "History search cancelled");
                        }
                        KeyCode::Enter => {
                            history_search = None;
                            prompt_history.reset();
                            input_hint(&model, "History selected · Enter sends · Ctrl+G edits");
                        }
                        KeyCode::Char('r') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                            let hint =
                                search.preview(&prompt_history, &mut input, &mut cursor, true);
                            input_hint(&model, &hint);
                        }
                        KeyCode::Backspace => {
                            search.query.pop();
                            let hint =
                                search.preview(&prompt_history, &mut input, &mut cursor, false);
                            input_hint(&model, &hint);
                        }
                        KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                            search.query.push(ch);
                            let hint =
                                search.preview(&prompt_history, &mut input, &mut cursor, false);
                            input_hint(&model, &hint);
                        }
                        _ => {}
                    }
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && stdio
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('g')
                        && editable(&model, focus_panel, detail_card) =>
                {
                    restore();
                    report_terminal_state(&command_writer, false, inline_mode)?;
                    paste_origin = None;
                    paste::materialize(&mut input, &mut cursor, &mut paste_chips);
                    let edited = composer::edit_in_editor(&input);
                    enable_raw_mode()?;
                    terminal = open_terminal(inline_mode, &integration_config)?;
                    if mouse_enabled {
                        execute!(io::stdout(), EnableMouseCapture)?;
                    }
                    execute!(
                        io::stdout(),
                        crossterm::terminal::Clear(crossterm::terminal::ClearType::All),
                        crossterm::cursor::MoveTo(0, 0)
                    )?;
                    report_capabilities(
                        &command_writer,
                        &capabilities,
                        inline_mode,
                        terminal.get_frame().area(),
                        &model,
                    )?;
                    match edited {
                        Ok(Some(text)) => {
                            input = text;
                            cursor = input.len();
                            prompt_history.reset();
                            input_hint(&model, "Editor draft loaded · Enter sends");
                        }
                        Ok(None) => {
                            input_hint(&model, "Editor cancelled · original draft preserved")
                        }
                        Err(error) => input_hint(
                            &model,
                            &format!("Editor: {error} · original draft preserved"),
                        ),
                    }
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && stdio
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('r')
                        && editable(&model, focus_panel, detail_card) =>
                {
                    paste_origin = None;
                    paste::materialize(&mut input, &mut cursor, &mut paste_chips);
                    let mut search = composer::Search::new(&input, cursor);
                    let hint = search.preview(&prompt_history, &mut input, &mut cursor, false);
                    input_hint(&model, &hint);
                    history_search = Some(search);
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && key.code == KeyCode::Char('v')
                        && key
                            .modifiers
                            .contains(KeyModifiers::CONTROL | KeyModifiers::SHIFT)
                        && editable(&model, focus_panel, detail_card) =>
                {
                    write_command(
                        &command_writer,
                        serde_json::json!({"type":"run_slash","data":{"name":"/attach","args":["clipboard"]}}),
                    )?;
                    input_hint(&model, "Reading clipboard image through /attach · preview appears before sending · /attach clear removes pending attachments");
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && stdio
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('v')
                        && editable(&model, focus_panel, detail_card)
                        && clipboard_job.is_none() =>
                {
                    let (tx, rx) = std::sync::mpsc::channel();
                    paste_origin = Some((input.clone(), cursor, seen_transcript_revision));
                    clipboard_job = Some(rx);
                    input_hint(&model, "Reading clipboard…");
                    thread::spawn(move || {
                        let _ = tx.send(ClipboardReply::Paste(clipboard::read_text()));
                    });
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && stdio
                        && key.modifiers.contains(KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('y')
                        && clipboard_job.is_none() =>
                {
                    let index = detail_card.unwrap_or(focused_card);
                    let mut payload = None;
                    let text = if editable(&model, focus_panel, detail_card) {
                        Some(expand_paste_chips(&input, &paste_chips))
                    } else {
                        model.lock().ok().and_then(|mut state| {
                            let card = state.cards.get(index)?;
                            if card.payload_ref.is_some() && !card.has_detail() {
                                payload = state.request_details(index);
                                None
                            } else {
                                Some({
                                    let card = card.materialized();
                                    card.detail.as_ref().unwrap_or(&card.body).clone()
                                })
                            }
                        })
                    };
                    if let Some(payload_ref) = payload {
                        write_command(
                            &command_writer,
                            serde_json::json!({"type":"show_details","data":{"payload_ref":payload_ref}}),
                        )?;
                    }
                    match text {
                        Some(text) if !text.is_empty() => {
                            let (tx, rx) = std::sync::mpsc::channel();
                            clipboard_job = Some(rx);
                            input_hint(&model, "Copying complete content…");
                            thread::spawn(move || {
                                let _ = tx.send(ClipboardReply::Copy(clipboard::copy_text(&text)));
                            });
                        }
                        Some(_) => input_hint(&model, "Nothing to copy"),
                        None => input_hint(
                            &model,
                            "Loading full result · press Ctrl+Y again when loaded",
                        ),
                    }
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && editable(&model, focus_panel, detail_card)
                        && composer::is_edit_key(key) =>
                {
                    composer::edit(&mut input, &mut cursor, key);
                }
                Event::Key(key)
                    if key.kind == KeyEventKind::Press
                        && focus_panel == 0
                        && model.lock().is_ok_and(|m| m.approval.is_some())
                        && !matches!(
                            key.code,
                            KeyCode::Char('1'..='9') | KeyCode::Esc | KeyCode::Tab
                        )
                        && !(key.code == KeyCode::Char('c')
                            && key.modifiers.contains(KeyModifiers::CONTROL)) => {}
                Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('b')
                        if stdio && key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        let tool_id = model.lock().ok().and_then(|state| {
                            let eligible = |card: &&bahulam_tui::model::Card| {
                                card.tool_name == "shell"
                                    && card.status == "running"
                                    && !card.tool_id.is_empty()
                            };
                            if let Some(card) = state.cards.get(focused_card) {
                                if card.tool_name == "shell"
                                    && card.status == "running"
                                    && !card.tool_id.is_empty()
                                {
                                    return Some(card.tool_id.clone());
                                }
                            }
                            let mut running = state.cards.iter().filter(eligible);
                            let only = running.next()?;
                            running.next().is_none().then(|| only.tool_id.clone())
                        });
                        if let Some(tool_id) = tool_id {
                            write_command(
                                &command_writer,
                                serde_json::json!({"type":"background","data":{"tool_id":tool_id}}),
                            )?;
                        } else {
                            input_hint(
                                    &model,
                                    "Focus a running shell card, or leave only one running shell command, then press Ctrl+B.",
                                );
                        }
                    }
                    KeyCode::Char('c')
                        if key.modifiers.contains(KeyModifiers::CONTROL) && stdio =>
                    {
                        let now = std::time::Instant::now();
                        if last_ctrl_c
                            .is_some_and(|at| now.duration_since(at) < Duration::from_secs(2))
                        {
                            write_command(&command_writer, serde_json::json!({"type":"bye"}))?;
                            break;
                        }
                        last_ctrl_c = Some(now);
                        if let Some(menu) = model
                            .lock()
                            .ok()
                            .and_then(|mut state| state.interaction.take())
                        {
                            write_command(
                                &command_writer,
                                serde_json::json!({"type":"interaction_response","data":{"request_id":menu.request_id,"cancelled":true}}),
                            )?;
                        }
                        input.clear();
                        paste_chips.clear();
                        cursor = 0;
                        history_search = None;
                        paste_origin = None;
                        prompt_history.reset();
                        input_hint(&model, "");
                        write_command(&command_writer, serde_json::json!({"type":"interrupt"}))?;
                    }
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
                    KeyCode::Char('q') if !stdio && input.is_empty() => break,
                    KeyCode::Char('q')
                        if !stdio && key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        break
                    }
                    KeyCode::Up | KeyCode::Down | KeyCode::Esc
                        if focus_panel == 0
                            && detail_card.is_none()
                            && model.lock().is_ok_and(|state| {
                                !state
                                    .slash_menu
                                    .matches(&input, &state.command_catalog)
                                    .is_empty()
                            }) =>
                    {
                        if let Ok(mut state) = model.lock() {
                            if key.code == KeyCode::Esc {
                                state.slash_menu.dismiss();
                            } else {
                                let count = state
                                    .slash_menu
                                    .matches(&input, &state.command_catalog)
                                    .len();
                                state
                                    .slash_menu
                                    .move_selection(key.code == KeyCode::Down, count);
                            }
                        }
                    }
                    KeyCode::Esc if detail_card.is_some() => {
                        detail_card = None;
                        detail_scroll = 0;
                        focus_panel = 0;
                        input_hint(&model, "");
                    }
                    KeyCode::Esc if expanded.contains(&focused_card) => {
                        expansion_anchor = geometry().and_then(|g| g.anchor(scroll, follow));
                        expanded.remove(&focused_card);
                        follow = false;
                        focus_panel = 0;
                        input_hint(&model, "");
                    }
                    KeyCode::Esc if agent_filter.is_some() => {
                        agent_filter = None;
                        focus_panel = 0;
                        if let Some((saved_scroll, saved_follow, saved_card, anchor)) =
                            agent_return.take()
                        {
                            scroll = saved_scroll;
                            follow = saved_follow;
                            focused_card = saved_card;
                            expansion_anchor = if saved_follow { None } else { anchor };
                        }
                        if let Ok(mut state) = model.lock() {
                            state.agents_open = false;
                        }
                    }
                    KeyCode::Esc if focus_panel != 0 => {
                        focus_panel = 0;
                        if let Ok(mut state) = model.lock() {
                            state.agents_open = false;
                        }
                    }
                    KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::ALT) => {
                        if let Ok(mut state) = model.lock() {
                            if bahulam_tui::render::has_subagents(&state) {
                                state.agents_open = true;
                                focus_panel = 2;
                            }
                        }
                    }
                    // Live mode: Esc interrupts the running turn; it never
                    // tears down the screen. Ctrl+C twice exits the CLI.
                    KeyCode::Esc if stdio => {
                        write_command(&command_writer, serde_json::json!({"type":"interrupt"}))?;
                    }
                    KeyCode::Esc => break,
                    KeyCode::Tab
                        if stdio && focus_panel == 0 && input.trim_start().starts_with('/') =>
                    {
                        let completion = model
                            .lock()
                            .ok()
                            .and_then(|m| m.slash_menu.completion(&input, &m.command_catalog));
                        if let Some(completion) = completion {
                            input = completion;
                            cursor = input.len();
                        }
                    }
                    KeyCode::Tab => {
                        let has_agents = model
                            .lock()
                            .is_ok_and(|m| bahulam_tui::render::has_subagents(&m));
                        focus_panel =
                            (focus_panel + 1) % if inline_mode && !has_agents { 2 } else { 3 };
                        if focus_panel == 2 {
                            if let Ok(mut state) = model.lock() {
                                state.agents_open = true;
                            }
                        }
                    }
                    KeyCode::Char('o')
                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && focus_panel == 0
                            && !paste_chips.is_empty() =>
                    {
                        paste::expand_last_paste_chip(&mut input, &mut cursor, &mut paste_chips);
                    }
                    KeyCode::Char('o') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        expansion_anchor = geometry().and_then(|g| g.anchor(scroll, follow));
                        follow = false;
                        let count = model.lock().map(|m| m.cards.len()).unwrap_or(0);
                        if expanded.len() == count {
                            expanded.clear();
                        } else {
                            expanded.extend(0..count);
                        }
                    }
                    KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        expansion_anchor = geometry().and_then(|g| g.anchor(scroll, follow));
                        follow = false;
                        let indices: Vec<usize> = geometry()
                            .map(|g| g.cards.iter().map(|(index, _)| *index).collect())
                            .unwrap_or_default();
                        if !indices.is_empty() {
                            if !indices.contains(&focused_card) {
                                focused_card = *indices.last().unwrap_or(&indices[0]);
                            }
                            if !expanded.remove(&focused_card) {
                                expanded.insert(focused_card);
                            }
                        }
                    }
                    KeyCode::Char('n') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        let indices: Vec<usize> = geometry()
                            .map(|g| g.cards.iter().map(|(index, _)| *index).collect())
                            .unwrap_or_default();
                        if !indices.is_empty() {
                            let position = indices
                                .iter()
                                .position(|index| *index == focused_card)
                                .unwrap_or(0);
                            let next = (position + 1).min(indices.len() - 1);
                            focused_card = indices[next];
                            follow = false;
                            scroll = geometry()
                                .and_then(|g| {
                                    g.cards
                                        .iter()
                                        .copied()
                                        .find(|(index, _)| *index == focused_card)
                                        .map(|(_, row)| row)
                                })
                                .unwrap_or(0);
                            focus_panel = 1;
                        }
                    }
                    KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        let indices: Vec<usize> = geometry()
                            .map(|g| g.cards.iter().map(|(index, _)| *index).collect())
                            .unwrap_or_default();
                        if !indices.is_empty() {
                            let position = indices
                                .iter()
                                .position(|index| *index == focused_card)
                                .unwrap_or(0);
                            let previous = position.saturating_sub(1);
                            focused_card = indices[previous];
                            follow = false;
                            scroll = geometry()
                                .and_then(|g| {
                                    g.cards
                                        .iter()
                                        .copied()
                                        .find(|(index, _)| *index == focused_card)
                                        .map(|(_, row)| row)
                                })
                                .unwrap_or(0);
                            focus_panel = 1;
                        }
                    }
                    KeyCode::Char('1') if stdio && focus_panel == 0 => {
                        let action = model.lock().ok().and_then(|mut model| {
                            model.approval.clone().map(|approval| {
                                if approval.command.trim().is_empty() {
                                    let index = model.cards.iter().rposition(|card| {
                                        card.title == "Approval"
                                            && approval.payload_ref.as_deref()
                                                == card.payload_ref.as_deref()
                                    });
                                    let request = index.and_then(|index| {
                                        model
                                            .request_details(index)
                                            .map(|reference| (index, reference))
                                    });
                                    (approval, request)
                                } else {
                                    (approval, None)
                                }
                            })
                        });
                        match action {
                            Some((_, Some((index, payload_ref)))) => {
                                detail_card = Some(index);
                                detail_scroll = 0;
                                focus_panel = 1;
                                write_command(
                                    &command_writer,
                                    serde_json::json!({"type":"show_details","data":{"payload_ref":payload_ref}}),
                                )?;
                            }
                            Some((approval, None)) => {
                                if !approval.command.trim().is_empty() {
                                    write_command(
                                        &command_writer,
                                        serde_json::json!({"type":"approve","data":{"apr_id":approval.id,"scope":"once"}}),
                                    )?;
                                }
                            }
                            None => {
                                input.insert(cursor, '1');
                                cursor += 1;
                            }
                        }
                    }
                    KeyCode::Char('2') if stdio && focus_panel == 0 => {
                        if let Some(approval) = model.lock().ok().and_then(|m| m.approval.clone()) {
                            write_command(
                                &command_writer,
                                serde_json::json!({"type":"deny","data":{"apr_id":approval.id}}),
                            )?;
                        } else {
                            input.insert(cursor, '2');
                            cursor += 1;
                        }
                    }
                    KeyCode::Char(ch @ '3'..='9')
                        if stdio
                            && focus_panel == 0
                            && model.lock().ok().is_some_and(|m| m.approval.is_some()) =>
                    {
                        if let Some(approval) = model.lock().ok().and_then(|m| m.approval.clone()) {
                            if !approval.command.trim().is_empty() {
                                if let Some(scope) = approval
                                    .scopes
                                    .iter()
                                    .filter(|scope| scope.as_str() != "once")
                                    .nth(ch as usize - '3' as usize)
                                {
                                    write_command(
                                        &command_writer,
                                        serde_json::json!({"type":"approve","data":{"apr_id":approval.id,"scope":scope}}),
                                    )?;
                                }
                            }
                        }
                    }
                    KeyCode::Char(ch)
                        if focus_panel == 0 && !key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        input.insert(cursor, ch);
                        cursor += ch.len_utf8();
                    }
                    KeyCode::Backspace if focus_panel == 0 && cursor > 0 => {
                        if let Some((start, _)) = input[..cursor].grapheme_indices(true).next_back()
                        {
                            input.replace_range(start..cursor, "");
                            cursor = start;
                        }
                    }
                    KeyCode::Left if stdio && focus_panel == 0 => {
                        if let Some((start, _)) = input[..cursor].grapheme_indices(true).next_back()
                        {
                            cursor = start;
                        }
                    }
                    KeyCode::Right if stdio && focus_panel == 0 => {
                        if let Some(grapheme) = input[cursor..].graphemes(true).next() {
                            cursor += grapheme.len();
                        }
                    }
                    KeyCode::Enter if detail_card.is_some() => {}
                    KeyCode::Enter
                        if focus_panel == 1 && !key.modifiers.contains(KeyModifiers::ALT) =>
                    {
                        if model.lock().ok().is_some_and(|m| {
                            m.cards
                                .get(focused_card)
                                .is_some_and(|card| !card.is_foldable())
                        }) {
                            continue;
                        }
                        expansion_anchor = geometry().and_then(|g| g.anchor(scroll, follow));
                        follow = false;
                        toggle_expansion(&model, focused_card, &mut expanded, &command_writer)?;
                        if !expanded.contains(&focused_card) {
                            focus_panel = 0;
                        }
                    }
                    KeyCode::Enter if focus_panel == 1 => {
                        if model.lock().ok().is_some_and(|m| {
                            m.cards
                                .get(focused_card)
                                .is_some_and(|card| !card.is_foldable())
                        }) {
                            continue;
                        }
                        detail_card = Some(focused_card);
                        detail_scroll = 0;
                        follow = false;
                        let reference = model
                            .lock()
                            .ok()
                            .and_then(|mut model| model.request_details(focused_card));
                        if let Some(payload_ref) = reference {
                            write_command(
                                &command_writer,
                                serde_json::json!({"type":"show_details","data":{"payload_ref":payload_ref}}),
                            )?;
                        }
                    }
                    KeyCode::Enter if focus_panel == 2 => {
                        let selected_agent = model.lock().ok().and_then(|m| {
                            m.agents.get(focused_agent).map(|agent| {
                                let id = agent.id.clone();
                                let last = scoped_card_indices(&m, Some(&id))
                                    .last()
                                    .copied()
                                    .unwrap_or(0);
                                (id, last)
                            })
                        });
                        if let Some((agent, last_card)) = selected_agent {
                            if agent_filter.is_none() {
                                agent_return = Some((
                                    scroll,
                                    follow,
                                    focused_card,
                                    geometry().and_then(|g| g.anchor(scroll, follow)),
                                ));
                            }
                            expansion_anchor = None;
                            agent_filter = Some(agent);
                            focused_card = last_card;
                            scroll = usize::MAX;
                            follow = true;
                            focus_panel = 1;
                        }
                    }
                    KeyCode::Enter if focus_panel == 0 && !input.trim().is_empty() => {
                        paste_origin = None;
                        paste::materialize(&mut input, &mut cursor, &mut paste_chips);
                        let prompt = model
                            .lock()
                            .map(|state| {
                                state.slash_menu.submission(&input, &state.command_catalog)
                            })
                            .unwrap_or_else(|_| input.clone());
                        input.clear();
                        prompt_history.remember(&prompt);
                        input_hint(&model, "");
                        cursor = 0;
                        let view_command = prompt
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                            .to_ascii_lowercase();
                        if prompt.trim() == "/copy" {
                            if let Ok(mut state) = model.lock() {
                                state.interaction=Some(bahulam_tui::model::Interaction {
                                    request_id:"local-copy".into(),title:"Copy conversation content".into(),message:"Choose a response, code block, command, diff, or transcript.".into(),
                                    options:copy_menu::options(&state,focused_card),selected:0,allow_free_text:false,editing:false,free_text:String::new(),
                                });
                            }
                        } else if let Some(selection) = prompt.trim().strip_prefix("/copy ") {
                            pending_copy = Some((
                                selection.to_owned(),
                                focused_card,
                                seen_transcript_revision,
                            ));
                        } else if stdio
                            && [
                                "/tui inline",
                                "/tui fullscreen",
                                "/tui full screen",
                                "/tui full",
                            ]
                            .contains(&view_command.as_str())
                        {
                            let requested_inline = view_command == "/tui inline";
                            if requested_inline != inline_mode {
                                terminal.clear()?;
                                drop(terminal);
                                restore();
                                enable_raw_mode()?;
                                inline_mode = requested_inline;
                                terminal = open_terminal(inline_mode, &integration_config)?;
                                report_capabilities(
                                    &command_writer,
                                    &capabilities,
                                    inline_mode,
                                    terminal.get_frame().area(),
                                    &model,
                                )?;
                                if mouse_enabled {
                                    execute!(io::stdout(), EnableMouseCapture)?;
                                }
                                agent_filter = None;
                                agent_return = None;
                                detail_card = None;
                                focus_panel = 0;
                                follow = true;
                            }
                        } else if stdio
                            && (prompt.trim() == "/tui"
                                || prompt.split_whitespace().eq(["/tui", "default"]))
                        {
                            // Release the terminal normally; Node retains the session
                            // and resumes its existing prompt after this child exits.
                            write_command(&command_writer, serde_json::json!({"type":"detach"}))?;
                            break;
                        } else if let Some(next_theme) = prompt.trim().strip_prefix("/theme ") {
                            if ["dark", "light", "high-contrast", "ansi"].contains(&next_theme) {
                                theme = next_theme.to_owned();
                                capabilities.select_theme(next_theme);
                                report_capabilities(
                                    &command_writer,
                                    &capabilities,
                                    inline_mode,
                                    terminal.get_frame().area(),
                                    &model,
                                )?;
                            }
                        } else if stdio {
                            // Record before sending so a fast turn_started cannot outrun its acknowledgement.
                            if let Ok(mut state) = model.lock() {
                                if state
                                    .agents
                                    .iter()
                                    .any(|agent| agent.id == "main" && agent.started_at.is_some())
                                {
                                    state.queue_prompt(&prompt);
                                }
                            }
                            write_command(
                                &command_writer,
                                serde_json::json!({"type":"prompt","data":{"text":prompt}}),
                            )?;
                        } else {
                            input = prompt;
                            cursor = input.len();
                        }
                    }
                    KeyCode::Enter => {}
                    KeyCode::Up | KeyCode::Down
                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && detail_card.is_none() =>
                    {
                        if let Some(g) = geometry() {
                            scroll_history(
                                &mut scroll,
                                &mut follow,
                                g.end,
                                key.code == KeyCode::Down,
                                1,
                            );
                        }
                    }
                    KeyCode::Up if focus_panel == 2 => {
                        focused_agent = focused_agent.saturating_sub(1);
                    }
                    KeyCode::Down if focus_panel == 2 => {
                        let count = model.lock().map(|m| m.agents.len()).unwrap_or(0);
                        if count > 0 {
                            focused_agent = (focused_agent + 1).min(count - 1);
                        }
                    }
                    KeyCode::Up | KeyCode::Down if detail_card.is_some() => {
                        detail_scroll = if key.code == KeyCode::Up {
                            detail_scroll.saturating_sub(1)
                        } else {
                            detail_scroll.saturating_add(1)
                        };
                    }
                    KeyCode::PageUp if detail_card.is_some() => {
                        detail_scroll = detail_scroll.saturating_sub(10);
                    }
                    KeyCode::PageDown if detail_card.is_some() => {
                        detail_scroll = detail_scroll.saturating_add(10);
                    }
                    KeyCode::Home if detail_card.is_some() => detail_scroll = 0,
                    KeyCode::End if detail_card.is_some() => {
                        detail_scroll = model
                            .lock()
                            .map(|model| {
                                model
                                    .detail_line_count(detail_card.unwrap_or(0))
                                    .saturating_sub(1)
                            })
                            .unwrap_or(0);
                    }
                    KeyCode::Up | KeyCode::Down if focus_panel == 1 => {
                        if let Some(g) = geometry() {
                            scroll_history(
                                &mut scroll,
                                &mut follow,
                                g.end,
                                key.code == KeyCode::Down,
                                1,
                            );
                        }
                    }
                    KeyCode::Up | KeyCode::Down if editable(&model, focus_panel, detail_card) => {
                        paste::materialize(&mut input, &mut cursor, &mut paste_chips);
                        let width = terminal
                            .get_frame()
                            .area()
                            .width
                            .saturating_sub(if inline_mode { 2 } else { 4 })
                            as usize;
                        let layout = composer::PromptLayout::new(&input, width);
                        let (row, column) = layout.cursor(cursor);
                        if key.code == KeyCode::Up && row > 0 {
                            cursor = layout.offset_at(row - 1, column);
                        } else if key.code == KeyCode::Down && row + 1 < layout.lines.len() {
                            cursor = layout.offset_at(row + 1, column);
                        } else {
                            prompt_history.navigate(
                                key.code == KeyCode::Down,
                                &mut input,
                                &mut cursor,
                            );
                        }
                        input_hint(&model, "↑↓ prompt history · Ctrl+R search · Ctrl+G editor");
                    }
                    KeyCode::Up | KeyCode::Down => {}
                    KeyCode::PageUp | KeyCode::PageDown => {
                        if let Some(g) = geometry() {
                            scroll_history(
                                &mut scroll,
                                &mut follow,
                                g.end,
                                key.code == KeyCode::PageDown,
                                g.page.saturating_sub(1).max(1),
                            );
                        }
                    }
                    KeyCode::Home if stdio && focus_panel == 0 => {
                        cursor = input[..cursor].rfind('\n').map(|i| i + 1).unwrap_or(0);
                    }
                    KeyCode::Home => {
                        follow = false;
                        scroll = 0;
                    }
                    KeyCode::End if stdio && focus_panel == 0 => {
                        cursor = input[cursor..]
                            .find('\n')
                            .map(|i| cursor + i)
                            .unwrap_or(input.len());
                    }
                    KeyCode::End => {
                        follow = true;
                        scroll = 0;
                    }
                    KeyCode::Char('j')
                        if focus_panel == 0 && key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        input.insert(cursor, '\n');
                        cursor += 1;
                    }
                    _ => {}
                },
                Event::Paste(text) if model.lock().is_ok_and(|m| m.interaction.is_some()) => {
                    if let Ok(mut state) = model.lock() {
                        if let Some(menu) = state.interaction.as_mut().filter(|m| m.editing) {
                            let text = composer::normalize(&text).replace(['\n', '\t'], " ");
                            if menu.free_text.len().saturating_add(text.len())
                                <= composer::MAX_INPUT_BYTES
                            {
                                menu.free_text.push_str(&text);
                            }
                        }
                    }
                }
                Event::Paste(text) if focus_panel == 0 => {
                    let can_paste = model
                        .lock()
                        .map(|state| state.interaction.is_none() && state.approval.is_none())
                        .unwrap_or(false);
                    if can_paste && history_search.is_none() {
                        let cwd = model
                            .lock()
                            .map(|state| state.cwd.clone())
                            .unwrap_or_default();
                        let text = paste::pasted_attachment_references(&text, &cwd).unwrap_or(text);
                        if expand_paste_chips(&input, &paste_chips)
                            .len()
                            .saturating_add(text.len())
                            <= composer::MAX_INPUT_BYTES
                        {
                            insert_paste_chip(
                                &mut input,
                                &mut cursor,
                                &text,
                                &mut paste_chips,
                                &mut paste_sequence,
                            );
                        } else {
                            input_hint(&model, "Prompt exceeds the 5 MiB paste limit");
                        }
                    }
                }
                Event::Mouse(mouse) if mouse_enabled => {
                    let position = ratatui::layout::Position::new(mouse.column, mouse.row);
                    mouse_position = Some(position);
                    if mouse.kind == MouseEventKind::Moved {
                        let next = if drag_selection.as_ref().is_some_and(|s| s.dragging) {
                            None
                        } else {
                            bahulam_tui::render::browser_link_at(position)
                        };
                        dirty |= next != hovered_browser_link;
                        continue;
                    }
                    if mouse.kind == MouseEventKind::Drag(MouseButton::Left) {
                        let mut moved = true;
                        if let Some(selection) = drag_selection.as_mut().filter(|s| !s.released) {
                            selection.update(position);
                            moved = selection.dragging;
                        }
                        if moved {
                            pressed_browser_link = None;
                        }
                        continue;
                    }
                    if mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                        if let Some(selection) = drag_selection
                            .as_mut()
                            .filter(|s| s.dragging && !s.released)
                        {
                            selection.release(position);
                            pressed_browser_link = None;
                            let text = selection.text();
                            if !text.trim().is_empty() && clipboard_job.is_none() {
                                input_hint(&model, "Copying selected text…");
                                let (tx, rx) = std::sync::mpsc::channel();
                                clipboard_job = Some(rx);
                                thread::spawn(move || {
                                    let result = clipboard::copy_text(&text).map(|mut copied| {
                                        copied.message = copied
                                            .message
                                            .replace("complete content", "selected text");
                                        copied
                                    });
                                    let _ = tx.send(ClipboardReply::Copy(result));
                                });
                            } else if clipboard_job.is_some() {
                                input_hint(&model, "Copy operation busy · select again shortly");
                            }
                            continue;
                        }
                    }
                    if matches!(
                        mouse.kind,
                        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                    ) {
                        drag_selection = None;
                    }
                    // Click what is visibly painted, even if another streaming
                    // event is waiting to be drawn. Modals still own input.
                    let view_accepts_mouse = model.lock().ok().is_some_and(|state| {
                        state.interaction.is_none() && state.approval.is_none()
                    });
                    let agent_hit = if view_accepts_mouse
                        && detail_card.is_none()
                        && history_search.is_none()
                        && mouse.modifiers.is_empty()
                    {
                        bahulam_tui::render::agent_at(position)
                    } else {
                        None
                    };
                    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                        pressed_agent = agent_hit.clone();
                        if pressed_agent.is_some() {
                            drag_selection = None;
                            pressed_browser_link = None;
                            continue;
                        }
                    } else if mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                        if let Some(hit) = pressed_agent.take() {
                            if agent_hit.as_ref() == Some(&hit) {
                                let valid = model.lock().is_ok_and(|m| {
                                    m.agents.get(hit.index).is_some_and(|a| a.id == hit.id)
                                });
                                if valid {
                                    if agent_filter.is_none() {
                                        agent_return = Some((
                                            scroll,
                                            follow,
                                            focused_card,
                                            geometry().and_then(|g| g.anchor(scroll, follow)),
                                        ));
                                    }
                                    expansion_anchor = None;
                                    focused_agent = hit.index;
                                    focused_card = model
                                        .lock()
                                        .map(|m| {
                                            scoped_card_indices(&m, Some(&hit.id))
                                                .last()
                                                .copied()
                                                .unwrap_or(0)
                                        })
                                        .unwrap_or(0);
                                    agent_filter = Some(hit.id);
                                    scroll = usize::MAX;
                                    follow = true;
                                    focus_panel = 1;
                                    if let Ok(mut state) = model.lock() {
                                        state.agents_open = true;
                                    }
                                }
                            }
                            continue;
                        }
                    } else if !matches!(mouse.kind, MouseEventKind::Moved) {
                        pressed_agent = None;
                    }
                    let browser_hit = if view_accepts_mouse
                        && detail_card.is_none()
                        && mouse.modifiers.is_empty()
                    {
                        bahulam_tui::render::browser_link_at(position)
                    } else {
                        None
                    };
                    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                        drag_selection = None;
                        if view_accepts_mouse && detail_card.is_none() && history_search.is_none() {
                            if let (Ok(state), Some(buffer)) =
                                (model.lock(), painted_buffer.as_ref())
                            {
                                let area = bahulam_tui::render::conversation_area(
                                    terminal.get_frame().area(),
                                    &state,
                                    &display_input,
                                    inline_mode,
                                );
                                if state.interaction.is_none() && area.contains(position) {
                                    drag_selection =
                                        Some(bahulam_tui::text_selection::TextSelection::new(
                                            buffer.clone(),
                                            area,
                                            position,
                                        ));
                                }
                            }
                        }
                        pressed_browser_link = browser_hit.clone();
                        if browser_hit.is_some() {
                            continue;
                        }
                    } else if mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                        if let Some(pressed) = pressed_browser_link.take() {
                            if browser_hit.as_ref() == Some(&pressed) {
                                if clipboard_job.is_none() {
                                    clipboard_job = Some(browser_open_job(pressed.target.uri));
                                } else {
                                    input_hint(
                                        &model,
                                        "Open/copy operation still running; try again shortly",
                                    );
                                }
                            }
                        }
                        continue;
                    } else if !matches!(mouse.kind, MouseEventKind::Moved) {
                        pressed_browser_link = None;
                    }

                    if mouse.kind == MouseEventKind::Down(MouseButton::Left)
                        && detail_card.is_none()
                    {
                        let hit = model.lock().ok().and_then(|state| {
                            details_at(
                                &state,
                                terminal.get_frame().area(),
                                &display_input,
                                inline_mode,
                                &expanded,
                                &theme,
                                agent_filter.as_deref(),
                                if follow { usize::MAX } else { scroll },
                                ratatui::layout::Position::new(mouse.column, mouse.row),
                            )
                        });
                        if let Some(index) = hit {
                            drag_selection = None;
                            focused_card = index;
                            focus_panel = 1;
                            expansion_anchor = geometry().and_then(|g| g.anchor(scroll, follow));
                            follow = false;
                            toggle_expansion(&model, index, &mut expanded, &command_writer)?;
                            if !expanded.contains(&index) {
                                focus_panel = 0;
                            }
                        } else if model.lock().ok().is_some_and(|state| {
                            mouse_panel_at_view(
                                terminal.get_frame().area(),
                                &state,
                                &display_input,
                                ratatui::layout::Position::new(mouse.column, mouse.row),
                                inline_mode,
                            ) == Some(MousePanel::Composer)
                        }) && history_search.is_none()
                        {
                            focus_panel = 0;
                            if let Ok(state) = model.lock() {
                                if let Some(offset) = bahulam_tui::render::prompt_cursor_at(
                                    terminal.get_frame().area(),
                                    &state,
                                    &display_input,
                                    display_cursor,
                                    ratatui::layout::Position::new(mouse.column, mouse.row),
                                    inline_mode,
                                ) {
                                    cursor = paste::raw_cursor_from_display(
                                        &input,
                                        &paste_chips,
                                        offset,
                                    );
                                }
                            }
                            input_hint(&model, "");
                        }
                        continue;
                    }
                    let down = match mouse.kind {
                        MouseEventKind::ScrollDown => true,
                        MouseEventKind::ScrollUp => false,
                        _ => continue,
                    };
                    let area = terminal.get_frame().area();
                    if let Ok(state) = model.lock() {
                        match mouse_panel_at_view(
                            area,
                            &state,
                            &display_input,
                            ratatui::layout::Position::new(mouse.column, mouse.row),
                            inline_mode,
                        ) {
                            Some(MousePanel::Transcript) if detail_card.is_some() => {
                                let end = state
                                    .detail_line_count(detail_card.unwrap_or(0))
                                    .saturating_sub(1);
                                detail_scroll = if down {
                                    detail_scroll
                                        .saturating_add(capabilities.scroll_lines as usize)
                                        .min(end)
                                } else {
                                    detail_scroll.saturating_sub(capabilities.scroll_lines as usize)
                                };
                            }
                            Some(MousePanel::Transcript) => {
                                let g = history_geometry(
                                    &state,
                                    area,
                                    &display_input,
                                    inline_mode,
                                    &expanded,
                                    &theme,
                                    agent_filter.as_deref(),
                                );
                                scroll_history(
                                    &mut scroll,
                                    &mut follow,
                                    g.end,
                                    down,
                                    usize::from(capabilities.scroll_lines),
                                );
                                if let Some((index, _)) = g
                                    .cards
                                    .iter()
                                    .rev()
                                    .find(|(_, row)| *row <= scroll)
                                    .or(g.cards.first())
                                {
                                    focused_card = *index;
                                }
                                // Scrolling history must not steal an editable draft's focus.
                            }
                            Some(MousePanel::Agents) if !state.agents.is_empty() => {
                                focused_agent = if down {
                                    focused_agent.saturating_add(1).min(state.agents.len() - 1)
                                } else {
                                    focused_agent.saturating_sub(1)
                                };
                                focus_panel = 2;
                            }
                            _ => {}
                        }
                    }
                }
                Event::Resize(width, height) => {
                    if capabilities.query_safe {
                        write!(io::stdout(), "\x1b[16t")?;
                        io::stdout().flush()?;
                    }
                    pressed_browser_link = None;
                    // Keep the visible message anchored when reflow changes row
                    // counts. Following output continues to track the new tail.
                    let anchor = if !follow && detail_card.is_none() {
                        geometry().and_then(|g| {
                            g.cards
                                .iter()
                                .copied()
                                .rev()
                                .find(|(_, row)| *row <= scroll)
                                .map(|(index, row)| (index, scroll.saturating_sub(row)))
                        })
                    } else {
                        None
                    };
                    terminal.resize(ratatui::layout::Rect::new(0, 0, width, height))?;
                    report_capabilities(
                        &command_writer,
                        &capabilities,
                        inline_mode,
                        terminal.get_frame().area(),
                        &model,
                    )?;
                    if let Some((index, offset)) = anchor {
                        if let Ok(state) = model.lock() {
                            let g = history_geometry(
                                &state,
                                terminal.get_frame().area(),
                                &display_input,
                                inline_mode,
                                &expanded,
                                &theme,
                                agent_filter.as_deref(),
                            );
                            if let Some((_, row)) = g.cards.iter().find(|(card, _)| *card == index)
                            {
                                scroll = row.saturating_add(offset).min(g.end);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let inline_exit_row =
        inline_mode.then(|| terminal.get_frame().area().bottom().saturating_sub(1));
    drop(terminal);
    restore();
    let _ = report_terminal_state(&command_writer, false, inline_mode);
    if let Some(row) = inline_exit_row {
        // The shell/Node prompt starts below the viewport, not inside the old
        // composer. Keep the existing transcript; do not print it again.
        execute!(io::stdout(), crossterm::cursor::MoveTo(0, row))?;
        write!(io::stdout(), "\r\n")?;
        io::stdout().flush()?;
    }
    if !stdio || !inline_mode {
        if let Ok(model) = model.lock() {
            for line in model.transcript() {
                println!("{line}");
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
use std::os::fd::FromRawFd;
#[cfg(windows)]
use std::os::windows::io::{FromRawHandle, RawHandle};

#[cfg(unix)]
fn child_stdio_file(fd: i32) -> io::Result<File> {
    // Node/libuv maps the extra child stdio entries to Unix descriptors 3 and 4.
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(windows)]
fn child_stdio_file(fd: i32) -> io::Result<File> {
    use std::ffi::c_void;

    #[link(name = "ucrt")]
    unsafe extern "C" {
        fn _get_osfhandle(fd: i32) -> isize;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn DuplicateHandle(
            source_process: *mut c_void,
            source_handle: *mut c_void,
            target_process: *mut c_void,
            target_handle: *mut *mut c_void,
            desired_access: u32,
            inherit_handle: i32,
            options: u32,
        ) -> i32;
    }

    let source = unsafe { _get_osfhandle(fd) };
    if source == -1 {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { GetCurrentProcess() };
    let mut duplicate: RawHandle = std::ptr::null_mut();
    let duplicated = unsafe {
        DuplicateHandle(
            process,
            source as RawHandle,
            process,
            &mut duplicate,
            0,
            0,
            0x0000_0002, // DUPLICATE_SAME_ACCESS
        )
    };
    if duplicated == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(duplicate) })
}

#[cfg(not(any(unix, windows)))]
fn child_stdio_file(_fd: i32) -> io::Result<File> {
    Err(io::Error::other(
        "live stdio transport is not supported on this platform",
    ))
}

fn install_termination_handler() -> io::Result<Arc<AtomicBool>> {
    let requested = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&requested))?;
        signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&requested))?;
    }
    Ok(requested)
}

fn report_terminal_state(
    writer: &Option<Arc<Mutex<BufWriter<File>>>>,
    active: bool,
    inline: bool,
) -> io::Result<()> {
    let (keyboard, marked) = integrations::terminal_state();
    write_command(
        writer,
        serde_json::json!({"type":"terminal_state","data": {
            "active":active,"alternate_screen":active && !inline,"keyboard_enhancement":active && keyboard,"shell_command_marked":active && marked
        }}),
    )
}

fn report_capabilities(
    writer: &Option<Arc<Mutex<BufWriter<File>>>>,
    caps: &TerminalCapabilities,
    inline: bool,
    area: ratatui::layout::Rect,
    model: &Arc<Mutex<bahulam_tui::model::Model>>,
) -> io::Result<()> {
    report_terminal_state(writer, true, inline)?;
    write_command(
        writer,
        serde_json::json!({"type":"hello","data":{
            "client":"bahulam-tui","version":env!("CARGO_PKG_VERSION"),
            "last_seq":model.lock().map(|state| state.last_seq).unwrap_or_default(),
            "capabilities":caps.as_json(Some(if inline { "inline" } else { "fullscreen" }),Some((area.width,area.height)))
        }}),
    )
}

fn write_command(
    writer: &Option<Arc<Mutex<BufWriter<File>>>>,
    command: serde_json::Value,
) -> io::Result<()> {
    if let Some(writer) = writer {
        let mut writer = writer
            .lock()
            .map_err(|_| io::Error::other("command pipe lock poisoned"))?;
        serde_json::to_writer(&mut *writer, &command)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!(
            "Replay failed: {}\nCheck the log and its payloads directory; use --help for usage.",
            safe_text(&error.to_string())
        );
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::scroll_history;

    #[test]
    fn wheel_history_starts_at_visible_tail_and_returns_to_follow() {
        let (mut scroll, mut follow) = (0, true);
        scroll_history(&mut scroll, &mut follow, 95, false, 3);
        assert_eq!((scroll, follow), (92, false));
        scroll_history(&mut scroll, &mut follow, 95, false, 3);
        assert_eq!((scroll, follow), (89, false));
        scroll_history(&mut scroll, &mut follow, 95, true, 6);
        assert_eq!((scroll, follow), (95, true));
        scroll_history(&mut scroll, &mut follow, 0, false, 3);
        assert_eq!((scroll, follow), (0, false));
    }
}
