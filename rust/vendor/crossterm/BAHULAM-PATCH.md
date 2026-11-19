# Crossterm 0.29.0: terminal query replies

Source: the crates.io `crossterm` 0.29.0 release, MIT license (`LICENSE`).
Upstream archive SHA-256:
`d8b9f2e4c67f833b660cdb0a3523065869fb35570177239812ed4c905aeff87b`.

This source snapshot is patched through the Rust workspace's `[patch.crates-io]`.
Only the library sources, manifest, README and license are included; example
manifest entries were removed because the examples are not shipped here.

Why: upstream hides DA1 and keyboard query replies in its private event queue,
discards the DA1 parameters, and does not parse DECRQM/pixel-size replies. Its
keyboard detection helper waits up to two seconds. Bahulam needs one 200 ms
deadline and one input owner, preserving keys/pastes typed while waiting.

Local changes, behind the opt-in `terminal-queries` feature:

- `Event::TerminalResponse(String)` exposes CSI private mode, DA1, keyboard and
  window/cell pixel replies plus OSC11 through the same Unix event queue as normal input.
- `parse_csi` recognizes these replies separately from keys, mouse, paste and
  cursor-position reports. Unknown private CSI final bytes are discarded.
- Both Unix input sources bound query-response packets to 128 bytes. Oversized
  numeric replies retain an invalid parameter until the final byte; their tails
  cannot become typed input. Bracketed paste has no new size limit.
- The shared `terminal_query` decoder frames OSC11 replies (BEL or ST) across
  reads, including fragmented Escape/prefix bytes. It runs only outside the
  existing key/CSI/paste packet parser. Escape/Alt+] ambiguity waits at most 25 ms;
  recognized packets have a 128-byte bound and a 200 ms timeout. Oversized packets
  are discarded through their terminator; torn packets time out or yield to a
  new escape/control key. Both poll backends wake for these parser deadlines.
- Partial CSI query replies also have a 200 ms packet timeout and yield to control
  keys/new escape packets. Before another read, both sources check readiness with
  `rustix::event::poll`: inherited tty stdin can be blocking, so a second unchecked
  read could otherwise defeat the deadline and stall standalone Esc. This does
  not change the descriptor's flags or add an input owner. EOF/read failures leave
  the renderer through its existing cleanup path instead of spinning.
- One upstream redundant pair of parentheses was removed to avoid a local
  dependency warning in `terminal/sys/unix.rs`.

No alternate reader or background stdin thread is added. The default feature set
does not enable this extension. Bahulam does not call upstream's keyboard query
helper while this feature is enabled (the replies are public events instead).
The Windows console reader is unchanged; active probing is skipped there.

Validation lives in `scripts/test-tui-capability-probes.mjs`: both renderer modes,
fragmented/late/oversized replies, typing/Unicode/arrows/paste during probing,
negative replies, silence/deadline, overrides, cache/reattach and mode cleanup.
`bahulam-tui/tests/query_decoder.rs` exercises the actual shared decoder's timeout,
control-key interruption and bounded-packet behavior as part of `cargo test`.
Keep this patch isolated when updating upstream. Remove it when upstream offers
an equivalent bounded query API sharing its event reader.
