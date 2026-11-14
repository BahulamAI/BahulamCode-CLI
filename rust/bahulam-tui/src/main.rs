use bahulam_tui::{model::safe_text, render::draw_with_input, replay};
use crossterm::{
    cursor::Show,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    style::ResetColor,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::{
    collections::HashSet,
    fs::File,
    io::{self, BufRead, BufReader, BufWriter, IsTerminal, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use unicode_segmentation::UnicodeSegmentation;

fn restore() {
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen, ResetColor, Show);
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
        .filter(|(_, card)| {
            agent_filter
                .map(|agent| card.agent == agent)
                .unwrap_or(card.agent == "main")
        })
        .map(|(index, _)| index)
        .collect()
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut file = None;
    let mut plain = false;
    let mut watch = false;
    let mut stdio = false;
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
            "--help" | "-h" => {
                println!(
                    "Bahulam Rust terminal client\n\n\
                     USAGE:\n\
                     \x20 bahulam-tui --replay <events.jsonl> [--watch] [--plain]\n\
                     \x20 bahulam-tui --help | --version\n\n\
                     OPTIONS:\n\
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
    let core_connected = Arc::new(AtomicBool::new(true));
    let command_writer = if stdio {
        #[cfg(unix)]
        {
            let events = unsafe { File::from_raw_fd(3) };
            let shared = Arc::clone(&model);
            let connected = Arc::clone(&core_connected);
            thread::spawn(move || {
                for line in BufReader::new(events).lines().map_while(Result::ok) {
                    if let Ok(event) =
                        serde_json::from_str::<bahulam_tui::protocol::EventEnvelope>(&line)
                    {
                        if let Ok(mut model) = shared.lock() {
                            let _ = model.apply(&event);
                        }
                    }
                }
                connected.store(false, Ordering::Release);
            });
            Some(Arc::new(Mutex::new(BufWriter::new(unsafe {
                File::from_raw_fd(4)
            }))))
        }
        #[cfg(not(unix))]
        {
            return Err("--stdio mode is not supported on this platform yet".into());
        }
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
    let original_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        original_hook(info);
    }));
    enable_raw_mode()?;
    let _guard = TerminalGuard;
    execute!(io::stdout(), EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    let mut scroll: u16 = 0;
    let mut follow = stdio;
    let mut last_refresh = std::time::Instant::now();
    let mut input = String::new();
    let mut cursor = 0usize;
    let mut theme = std::env::var("BAHULAM_THEME").unwrap_or_else(|_| "dark".into());
    let mut expanded = HashSet::new();
    let mut focused_card = 0usize;
    let mut focused_agent = 0usize;
    let mut focus_panel = 0u8; // prompt, transcript, agents
    let mut agent_filter: Option<String> = None;
    let mut detail_card: Option<usize> = None;
    let mut detail_scroll = 0u16;
    loop {
        if stdio && !core_connected.load(Ordering::Acquire) {
            break;
        }
        if watch && !stdio && last_refresh.elapsed() >= Duration::from_millis(100) {
            if let Some(file) = &file {
                *model.lock().map_err(|_| "view model lock poisoned")? = replay(file)?;
            }
            last_refresh = std::time::Instant::now();
        }
        if follow {
            focused_card = model
                .lock()
                .map(|m| {
                    scoped_card_indices(&m, agent_filter.as_deref())
                        .last()
                        .copied()
                        .unwrap_or(0)
                })
                .unwrap_or(0);
        }
        let visible_scroll = if follow { u16::MAX } else { scroll };
        terminal.draw(|frame| {
            if let Ok(model) = model.lock() {
                draw_with_input(
                    frame,
                    &model,
                    visible_scroll,
                    stdio || watch,
                    &theme,
                    &input,
                    cursor,
                    &expanded,
                    Some(focused_card),
                    stdio,
                    agent_filter.as_deref(),
                    Some(focused_agent),
                    focus_panel,
                    detail_card,
                    detail_scroll,
                );
            }
        })?;
        if event::poll(Duration::from_millis(50))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => match key.code {
                    KeyCode::Char('c')
                        if key.modifiers.contains(KeyModifiers::CONTROL) && stdio =>
                    {
                        write_command(&command_writer, serde_json::json!({"type":"interrupt"}))?;
                    }
                    KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
                    KeyCode::Char('q') if !stdio && input.is_empty() => break,
                    KeyCode::Char('q') if key.modifiers.contains(KeyModifiers::CONTROL) => break,
                    KeyCode::Esc if detail_card.is_some() => {
                        detail_card = None;
                        detail_scroll = 0;
                        focus_panel = 1;
                    }
                    KeyCode::Esc if agent_filter.is_some() => {
                        agent_filter = None;
                        focus_panel = 1;
                        follow = true;
                    }
                    KeyCode::Esc if focus_panel != 0 => focus_panel = 0,
                    KeyCode::Esc => break,
                    KeyCode::Tab => focus_panel = (focus_panel + 1) % 3,
                    KeyCode::Char('o') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        let count = model.lock().map(|m| m.cards.len()).unwrap_or(0);
                        if expanded.len() == count {
                            expanded.clear();
                        } else {
                            expanded.extend(0..count);
                        }
                    }
                    KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        let indices = model
                            .lock()
                            .map(|m| scoped_card_indices(&m, agent_filter.as_deref()))
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
                        let indices = model
                            .lock()
                            .map(|m| scoped_card_indices(&m, agent_filter.as_deref()))
                            .unwrap_or_default();
                        if !indices.is_empty() {
                            let position = indices
                                .iter()
                                .position(|index| *index == focused_card)
                                .unwrap_or(0);
                            let next = (position + 1).min(indices.len() - 1);
                            focused_card = indices[next];
                            follow = false;
                            scroll = next.min(u16::MAX as usize) as u16;
                            focus_panel = 1;
                        }
                    }
                    KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                        let indices = model
                            .lock()
                            .map(|m| scoped_card_indices(&m, agent_filter.as_deref()))
                            .unwrap_or_default();
                        if !indices.is_empty() {
                            let position = indices
                                .iter()
                                .position(|index| *index == focused_card)
                                .unwrap_or(0);
                            let previous = position.saturating_sub(1);
                            focused_card = indices[previous];
                            follow = false;
                            scroll = previous.min(u16::MAX as usize) as u16;
                            focus_panel = 1;
                        }
                    }
                    KeyCode::Char('1') if stdio && focus_panel == 0 => {
                        let action = model
                            .lock()
                            .ok()
                            .map(|mut model| {
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
                            })
                            .flatten();
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
                    KeyCode::Char(ch)
                        if focus_panel == 0 && !key.modifiers.contains(KeyModifiers::CONTROL) =>
                    {
                        input.insert(cursor, ch);
                        cursor += ch.len_utf8();
                    }
                    KeyCode::Backspace if focus_panel == 0 => {
                        if cursor > 0 {
                            if let Some((start, _)) = input[..cursor].grapheme_indices(true).last()
                            {
                                input.replace_range(start..cursor, "");
                                cursor = start;
                            }
                        }
                    }
                    KeyCode::Left if stdio && focus_panel == 0 => {
                        if let Some((start, _)) = input[..cursor].grapheme_indices(true).last() {
                            cursor = start;
                        }
                    }
                    KeyCode::Right if stdio && focus_panel == 0 => {
                        if let Some(grapheme) = input[cursor..].graphemes(true).next() {
                            cursor += grapheme.len();
                        }
                    }
                    KeyCode::Enter if detail_card.is_some() => {}
                    KeyCode::Enter if focus_panel == 1 => {
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
                            agent_filter = Some(agent);
                            focused_card = last_card;
                            scroll = u16::MAX;
                            follow = true;
                            focus_panel = 1;
                        }
                    }
                    KeyCode::Enter if focus_panel == 0 && !input.trim().is_empty() => {
                        let prompt = std::mem::take(&mut input);
                        cursor = 0;
                        if let Some(next_theme) = prompt.trim().strip_prefix("/theme ") {
                            if ["dark", "light", "high-contrast", "ansi"].contains(&next_theme) {
                                theme = next_theme.to_owned();
                            }
                        } else if stdio {
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
                    KeyCode::Up
                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && detail_card.is_none() =>
                    {
                        if follow {
                            scroll = model
                                .lock()
                                .map(|m| {
                                    scoped_card_indices(&m, agent_filter.as_deref())
                                        .len()
                                        .saturating_sub(5)
                                        as u16
                                })
                                .unwrap_or(0);
                            follow = false;
                        } else {
                            scroll = scroll.saturating_sub(1);
                        }
                    }
                    KeyCode::Down
                        if key.modifiers.contains(KeyModifiers::CONTROL)
                            && detail_card.is_none() =>
                    {
                        if !follow {
                            let count = model
                                .lock()
                                .map(|m| scoped_card_indices(&m, agent_filter.as_deref()).len())
                                .unwrap_or(0);
                            scroll = scroll.saturating_add(1);
                            if scroll as usize >= count.saturating_sub(5) {
                                follow = true;
                            }
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
                                    .min(u16::MAX as usize) as u16
                            })
                            .unwrap_or(0);
                    }
                    KeyCode::Up | KeyCode::Down if focus_panel == 1 => {
                        follow = false;
                        if key.code == KeyCode::Up {
                            scroll = scroll.saturating_sub(1);
                        } else {
                            scroll = scroll.saturating_add(1);
                        }
                    }
                    KeyCode::Up | KeyCode::Down => {}
                    KeyCode::PageUp if focus_panel == 1 => {
                        if follow {
                            scroll = model
                                .lock()
                                .map(|m| {
                                    scoped_card_indices(&m, agent_filter.as_deref())
                                        .len()
                                        .saturating_sub(15)
                                        as u16
                                })
                                .unwrap_or(0);
                            follow = false;
                        } else {
                            scroll = scroll.saturating_sub(10);
                        }
                    }
                    KeyCode::PageDown if focus_panel == 1 => {
                        if !follow {
                            let count = model
                                .lock()
                                .map(|m| scoped_card_indices(&m, agent_filter.as_deref()).len())
                                .unwrap_or(0);
                            scroll = scroll.saturating_add(10);
                            if scroll as usize >= count.saturating_sub(5) {
                                follow = true;
                            }
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
                Event::Resize(_, _) => {}
                _ => {}
            }
        }
    }
    drop(terminal);
    restore();
    if let Ok(model) = model.lock() {
        for line in model.transcript() {
            println!("{line}");
        }
    }
    Ok(())
}

#[cfg(unix)]
use std::os::fd::FromRawFd;

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
