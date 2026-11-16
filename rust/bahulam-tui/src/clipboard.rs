//! Native/OSC52/file clipboard routes adapted from the preserved client.
//! Call native routes on a worker; terminal escape output stays on the UI thread.
use crate::composer::MAX_INPUT_BYTES;
use std::{
    env,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const TIMEOUT: Duration = Duration::from_secs(2);
fn command_path(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|path| path.join(name))
        .find(|path| path.is_file())
}

fn run(name: &str, args: &[&str], input: Option<&str>) -> io::Result<String> {
    let mut child = Command::new(name)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + TIMEOUT;
    let writer = input.map(|input| {
        let mut pipe = child.stdin.take().unwrap();
        let bytes = input.as_bytes().to_vec();
        thread::spawn(move || pipe.write_all(&bytes))
    });
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(MAX_INPUT_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let output = match rx.recv_timeout(TIMEOUT) {
        Ok(Ok(bytes)) if bytes.len() <= MAX_INPUT_BYTES => bytes,
        result => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(match result {
                Ok(Err(error)) => error,
                Ok(Ok(_)) => io::Error::other("Clipboard exceeds 5 MiB"),
                Err(_) => io::Error::other("Clipboard command timed out"),
            });
        }
    };
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(io::Error::other(format!(
                    "Clipboard command exited with {status}"
                )));
            }
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("Clipboard command timed out"));
        }
        thread::sleep(Duration::from_millis(10));
    }
    if let Some(writer) = writer {
        writer
            .join()
            .map_err(|_| io::Error::other("Clipboard writer failed"))??;
    }
    String::from_utf8(output).map_err(|_| {
        io::Error::other(
            "Clipboard does not contain UTF-8 text; use /attach clipboard for an image",
        )
    })
}

pub fn mode() -> String {
    env::var("BAHULAM_CLIPBOARD")
        .unwrap_or_else(|_| "auto".into())
        .to_lowercase()
}
fn remote() -> bool {
    env::var_os("SSH_CONNECTION").is_some() || env::var_os("SSH_TTY").is_some()
}

pub fn read_text() -> io::Result<String> {
    let mode = mode();
    if !matches!(mode.as_str(), "auto" | "native") {
        return Err(io::Error::other(format!(
            "Clipboard mode '{mode}' does not support native paste"
        )));
    }
    if mode == "auto" && remote() {
        return Err(io::Error::other(
            "Paste through your local terminal over SSH",
        ));
    }
    #[cfg(target_os = "macos")]
    let commands: &[(&str, &[&str])] = &[("pbpaste", &[])];
    #[cfg(target_os = "windows")]
    let commands: &[(&str, &[&str])] = &[(
        "powershell.exe",
        &["-NoProfile", "-Command", "Get-Clipboard -Raw"],
    )];
    #[cfg(target_os = "linux")]
    let commands: &[(&str, &[&str])] = &[
        ("wl-paste", &["--no-newline"]),
        ("xclip", &["-selection", "clipboard", "-o"]),
        ("xsel", &["--clipboard", "--output"]),
    ];
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let commands: &[(&str, &[&str])] = &[];
    for (name, args) in commands {
        if let Some(path) = command_path(name) {
            return run(&path.to_string_lossy(), args, None);
        }
    }
    Err(io::Error::other(
        "No native clipboard reader; paste through your terminal",
    ))
}

pub struct Copied {
    pub message: String,
    pub terminal_sequence: Option<String>,
}
pub fn copy_text(text: &str) -> io::Result<Copied> {
    if text.len() > MAX_INPUT_BYTES {
        return Err(io::Error::other("Copy exceeds 5 MiB"));
    }
    match mode().as_str() {
        "file" => save_file(text),
        "osc52" if text.len() > 100_000 => save_file(text),
        "osc52" => {
            let encoded = base64(text.as_bytes());
            let sequence = if env::var_os("TMUX").is_some() {
                format!("\x1bPtmux;\x1b\x1b]52;c;{encoded}\x07\x1b\\")
            } else {
                format!("\x1b]52;c;{encoded}\x07")
            };
            Ok(Copied {
                message: "Copy sent via OSC 52".into(),
                terminal_sequence: Some(sequence),
            })
        }
        "auto" if remote() => save_file(text),
        "auto" | "native" => {
            #[cfg(target_os = "macos")]
            let commands: &[(&str, &[&str])] = &[("pbcopy", &[])];
            #[cfg(target_os = "windows")]
            let commands: &[(&str, &[&str])] = &[("clip.exe", &[])];
            #[cfg(target_os = "linux")]
            let commands: &[(&str, &[&str])] = &[
                ("wl-copy", &[]),
                ("xclip", &["-selection", "clipboard"]),
                ("xsel", &["--clipboard", "--input"]),
            ];
            #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
            let commands: &[(&str, &[&str])] = &[];
            for (name, args) in commands {
                if let Some(path) = command_path(name) {
                    run(&path.to_string_lossy(), args, Some(text))?;
                    return Ok(Copied {
                        message: "Copied complete content".into(),
                        terminal_sequence: None,
                    });
                }
            }
            save_file(text)
        }
        mode => Err(io::Error::other(format!(
            "Unsupported clipboard mode '{mode}'"
        ))),
    }
}
fn save_file(text: &str) -> io::Result<Copied> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let path = env::temp_dir().join(format!("bahulam-copy-{}-{stamp}.txt", std::process::id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    if let Err(error) = file.write_all(text.as_bytes()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(error);
    }
    Ok(Copied {
        message: format!("Saved copy: {}", path.display()),
        terminal_sequence: None,
    })
}
fn base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in input.chunks(3) {
        let a = chunk[0] as usize;
        let b = *chunk.get(1).unwrap_or(&0) as usize;
        let c = *chunk.get(2).unwrap_or(&0) as usize;
        output.push(TABLE[a >> 2] as char);
        output.push(TABLE[((a & 3) << 4) | (b >> 4)] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[c & 63] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn osc52_encoding_preserves_utf8_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64("界".as_bytes()), "55WM");
    }
    #[test]
    fn fallback_file_is_private_and_preserves_exact_content() {
        let content = "```rs\nlet x = \"界\";\n```\n";
        let copied = save_file(content).unwrap();
        assert!(copied.terminal_sequence.is_none());
        let path = PathBuf::from(copied.message.strip_prefix("Saved copy: ").unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_file(path).unwrap();
    }
}
