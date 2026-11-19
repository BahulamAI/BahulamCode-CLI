//! Local opt-in OSC11 reply framing. Shares the ordinary input reader; never
//! examines bytes inside a key/CSI packet or bracketed paste already being read.
use std::time::{Duration, Instant};

const PREFIX: &[u8] = b"\x1b]11;";
const PREFIX_WAIT: Duration = Duration::from_millis(25);
const PACKET_WAIT: Duration = Duration::from_millis(200);
const MAX_PACKET: usize = 128;

pub(crate) enum Decoded {
    Byte(u8),
    Input(Vec<u8>),
    Reply(String),
    Pending,
}

#[derive(Debug, Default)]
pub(crate) struct QueryDecoder {
    bytes: Vec<u8>,
    deadline: Option<Instant>,
    payload: bool,
    oversized: bool,
    escape: bool,
}

impl QueryDecoder {
    pub(crate) fn pending(&self) -> bool {
        self.deadline.is_some()
    }

    pub(crate) fn poll_timeout(&self, outer: Option<Duration>) -> Option<Duration> {
        let own = self
            .deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()));
        match (outer, own) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn reset(&mut self) -> Vec<u8> {
        self.deadline = None;
        self.payload = false;
        self.oversized = false;
        self.escape = false;
        std::mem::take(&mut self.bytes)
    }

    /// Ambiguous Escape/Alt+] input has a short timeout. Recognized but
    /// unterminated OSC packets are discarded, never held indefinitely.
    pub(crate) fn expire(&mut self) -> Option<Vec<u8>> {
        if self
            .deadline
            .is_none_or(|deadline| Instant::now() < deadline)
        {
            return None;
        }
        let reply = self.payload;
        let bytes = self.reset();
        if reply {
            None
        } else {
            Some(bytes)
        }
    }

    pub(crate) fn feed(&mut self, byte: u8) -> Decoded {
        if !self.pending() && byte != PREFIX[0] {
            return Decoded::Byte(byte);
        }
        if !self.payload {
            if byte != PREFIX[self.bytes.len()] {
                let mut input = self.reset();
                input.push(byte);
                return Decoded::Input(input);
            }
            self.bytes.push(byte);
            self.payload = self.bytes.len() == PREFIX.len();
            self.deadline = Some(
                Instant::now()
                    + if self.payload {
                        PACKET_WAIT
                    } else {
                        PREFIX_WAIT
                    },
            );
            return Decoded::Pending;
        }
        if byte == 7 || (self.escape && byte == b'\\') {
            let oversized = self.oversized;
            if !oversized {
                self.bytes.push(byte);
            }
            let bytes = self.reset();
            return Decoded::Reply(if oversized {
                String::new()
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            });
        }
        if self.escape {
            // A new escape packet interrupts a torn OSC reply. Preserve the
            // new key/query sequence (including another OSC11), not the old text.
            self.reset();
            self.bytes.push(27);
            self.deadline = Some(Instant::now() + PREFIX_WAIT);
            return self.feed(byte);
        }
        if byte < 32 && byte != 27 {
            self.reset();
            return Decoded::Byte(byte); // Ctrl+C etc. must remain usable.
        }
        self.escape = byte == 27;
        if !self.oversized {
            if self.bytes.len() < MAX_PACKET {
                self.bytes.push(byte);
            } else {
                self.oversized = true;
                self.bytes.clear();
            }
        }
        Decoded::Pending
    }
}
