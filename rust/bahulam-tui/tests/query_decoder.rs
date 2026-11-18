// Exercise the exact vendored decoder used by both Unix input backends without
// pulling in crossterm's unrelated upstream test dependencies.
#[path = "../../vendor/crossterm/src/event/source/unix/terminal_query.rs"]
mod terminal_query;

use std::{thread, time::Duration};
use terminal_query::{Decoded, QueryDecoder};

fn feed(decoder: &mut QueryDecoder, bytes: &[u8]) -> Vec<Decoded> {
    bytes
        .iter()
        .map(|b| decoder.feed(*b))
        .filter(|event| !matches!(event, Decoded::Pending))
        .collect()
}

#[test]
fn escape_and_alt_bracket_return_to_input_after_a_short_wait() {
    for input in [b"\x1b".as_slice(), b"\x1b]", b"\x1b]1"] {
        let mut decoder = QueryDecoder::default();
        assert!(feed(&mut decoder, input).is_empty());
        assert!(decoder.pending());
        assert!(
            decoder.poll_timeout(Some(Duration::from_secs(1))).unwrap()
                <= Duration::from_millis(25)
        );
        thread::sleep(Duration::from_millis(30));
        assert_eq!(decoder.expire().unwrap(), input);
        assert!(!decoder.pending());
        assert!(matches!(decoder.feed(b'x'), Decoded::Byte(b'x')));
    }
}

#[test]
fn torn_oversized_and_interrupted_packets_cannot_hold_the_reader_forever() {
    let mut decoder = QueryDecoder::default();
    feed(&mut decoder, b"\x1b]11;rgb:ffff/");
    thread::sleep(Duration::from_millis(210));
    assert!(decoder.expire().is_none());
    assert!(!decoder.pending());
    assert!(matches!(decoder.feed(b'x'), Decoded::Byte(b'x')));

    feed(&mut decoder, b"\x1b]11;");
    feed(&mut decoder, &vec![b'f'; 4096]);
    assert!(matches!(decoder.feed(7), Decoded::Reply(reply) if reply.is_empty()));
    assert!(!decoder.pending());

    feed(&mut decoder, b"\x1b]11;rgb:ffff/");
    assert!(matches!(decoder.feed(3), Decoded::Byte(3))); // Ctrl+C
    feed(&mut decoder, b"\x1b]11;rgb:ffff/");
    let events = feed(&mut decoder, b"\x1b[");
    assert!(matches!(&events[0], Decoded::Input(input) if input == b"\x1b["));
    assert!(!decoder.pending());
}
