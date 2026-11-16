#!/usr/bin/env python3
"""Isolated clipboard/editor and PTY fixture; no real clipboard access."""
import os, sys, time, json, termios, stat
home = os.environ['BAHULAM_HOME']
name = os.path.basename(sys.argv[0])
if name in ('pbpaste', 'wl-paste'):
    mode = open(os.path.join(home, 'clip-mode')).read()
    if mode == 'timeout': time.sleep(10)
    if mode == 'delayed': time.sleep(0.5)
    if mode == 'oversize':
        print('x' * (5 * 1024 * 1024 + 1), end='')
        sys.exit(0)
    print('paste alpha\nsecond', end='')
    sys.exit(0)
if name in ('pbcopy', 'wl-copy'):
    open(os.path.join(home, 'copied'), 'w').write(sys.stdin.read())
    sys.exit(0)
if name == 'fake editor':
    record = os.path.join(home, 'editor.json')
    calls = json.load(open(record)) if os.path.exists(record) else []
    target = sys.argv[-1]
    calls.append({'raw': not bool(termios.tcgetattr(0)[3] & termios.ICANON),
                  'mode': stat.S_IMODE(os.stat(target).st_mode), 'path': target,
                  'input': open(target).read(), 'args': sys.argv[1:-1]})
    json.dump(calls, open(record, 'w'))
    open(target, 'w').write('edited answer\nline two' if len(calls) == 1 else 'failed edit')
    sys.exit(0 if len(calls) == 1 else 3)

import pty, fcntl, struct, select, subprocess, signal
sys.dont_write_bytecode = True
from tui_test_screen import Screen
screen = Screen(36, 140)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 140, 0, 0))
original = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)

def pump(predicate):
    end = time.monotonic() + 4
    while time.monotonic() < end and child.poll() is None:
        if select.select([master], [], [], 0.02)[0]:
            screen.feed(os.read(master, 65536))
        if predicate(screen.text()): return
    raise Exception('Composer did not settle:\n' + screen.text())

def send(keys, predicate):
    os.write(master, keys)
    pump(predicate)

def commands():
    return json.load(open(os.path.join(home, 'commands.json')))

try:
    pump(lambda t: 'TOOL_PREVIEW' in t and 'Ask Bahulam' in t)
    send(b'draft saved\x1b[A', lambda t: 'newer prompt' in t)
    send(b'\x1b[B', lambda t: 'draft saved' in t)
    send(b'\x12older', lambda t: 'older prompt' in t and 'History: older' in t)
    send(b'\x1b', lambda t: 'draft saved' in t and 'search cancelled' in t)
    send(b'\x12older\r', lambda t: 'older prompt' in t and 'History selected' in t)
    assert not any(c['type'] == 'prompt' for c in commands()), 'Search submitted without confirmation'
    send(b'\x07', lambda t: 'edited answer' in t and 'line two' in t and 'Editor draft loaded' in t)
    send(b'\x07', lambda t: 'Editor cancelled' in t)
    assert 'edited answer' in screen.text() and 'line two' in screen.text(), 'Failed editor replaced draft'
    calls = json.load(open(os.path.join(home, 'editor.json')))
    assert len(calls) == 2 and all(not c['raw'] and c['mode'] == 0o600 for c in calls)
    assert all(c['args'] == ['--wait'] and not os.path.exists(c['path']) for c in calls), 'Editor arguments/cleanup'
    send(b'\x15\x16', lambda t: 'paste alpha' in t and 'second' in t and 'Pasted text' in t)
    send(b'\r', lambda t: 'Ask Bahulam' in t and any(c['type'] == 'prompt' for c in commands()))
    assert [c['data']['text'] for c in commands() if c['type'] == 'prompt'] == ['paste alpha\nsecond']
    send(b'\t\x19', lambda t: 'Loading full result' in t)
    start = time.monotonic()
    pump(lambda t: time.monotonic() - start > 0.15)
    send(b'\x19', lambda t: 'Copied complete content' in t)
    send(b'\x1b', lambda t: 'Ask Bahulam' in t)
    open(os.path.join(home, 'clip-mode'), 'w').write('delayed')
    send(b'\x16', lambda t: 'Reading clipboard' in t)
    send(b'changed', lambda t: 'Draft changed during clipboard read' in t)
    assert 'changed' in screen.text() and 'paste alpha' not in screen.text(), 'Stale paste replaced draft'
    open(os.path.join(home, 'clip-mode'), 'w').write('timeout')
    send(b'\x15\x16', lambda t: 'Reading clipboard' in t)
    pump(lambda t: 'Clipboard command timed out' in t)
    open(os.path.join(home, 'clip-mode'), 'w').write('oversize')
    send(b'\x16', lambda t: 'Clipboard exceeds 5 MiB' in t)
    os.write(master, b'\x03\x03')
    end = time.monotonic() + 3
    while child.poll() is None and time.monotonic() < end:
        if select.select([master], [], [], 0.02)[0]: os.read(master, 65536)
    assert child.poll() == 0, 'Renderer did not exit'
    restored = termios.tcgetattr(slave)
    pending = getattr(termios, 'PENDIN', 0)
    restored[3] &= ~pending
    original[3] &= ~pending
    assert restored == original, 'Terminal modes not restored'
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=2)
    os.close(master)
    os.close(slave)
