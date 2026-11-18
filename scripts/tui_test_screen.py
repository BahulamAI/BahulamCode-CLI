"""Small VT cell reader for local TUI tests; handles the sequences our renderer emits."""
import codecs
import re
import unicodedata


class Screen:
    def __init__(self, rows, columns):
        self.rows, self.columns = rows, columns
        self.cells = [[' '] * columns for _ in range(rows)]
        self.row = self.column = 0
        self.saved_cursor = (0, 0)
        self.decoder = codecs.getincrementaldecoder('utf8')('replace')
        self.pending = ''

    def text(self):
        return '\n'.join(''.join(row) for row in self.cells)

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        while self.pending:
            if self.pending.startswith('\x1b['):
                match = re.match(r'\x1b\[([0-?]*)([ -/]*)([@-~])', self.pending)
                if not match:
                    return
                self.pending = self.pending[match.end():]
                raw, _, command = match.groups()
                numbers = [int(value or '0') for value in raw.lstrip('?').split(';') if value.isdigit() or value == '']
                first = numbers[0] if numbers else 0
                if command in ('H', 'f'):
                    self.row = min(self.rows - 1, max(0, (first or 1) - 1))
                    self.column = min(self.columns - 1, max(0, (numbers[1] if len(numbers) > 1 else 1) - 1))
                elif command in ('A', 'B'):
                    self.row = max(0, min(self.rows - 1, self.row + (first or 1) * (-1 if command == 'A' else 1)))
                elif command in ('C', 'D'):
                    self.column = max(0, min(self.columns - 1, self.column + (first or 1) * (-1 if command == 'D' else 1)))
                elif command == 'G':
                    self.column = min(self.columns - 1, max(0, (first or 1) - 1))
                elif command == 'J' and first == 2 or command == 'h' and raw == '?1049':
                    self.cells = [[' '] * self.columns for _ in range(self.rows)]
                elif command == 'K':
                    start = self.column if first == 0 else 0
                    end = self.column + 1 if first == 1 else self.columns
                    self.cells[self.row][start:end] = [' '] * (end - start)
                continue
            if self.pending.startswith('\x1b]'):
                end = re.search(r'\x07|\x1b\\', self.pending)
                if not end:
                    return
                self.pending = self.pending[end.end():]
                continue
            if self.pending[0] == '\x1b':
                if len(self.pending) < 2:
                    return
                if self.pending[1] == '7':
                    self.saved_cursor = (self.row, self.column)
                elif self.pending[1] == '8':
                    self.row, self.column = self.saved_cursor
                self.pending = self.pending[2:]
                continue
            char, self.pending = self.pending[0], self.pending[1:]
            if char == '\r':
                self.column = 0
            elif char == '\n':
                self.row += 1
            elif char == '\b':
                self.column = max(0, self.column - 1)
            elif char >= ' ':
                width = 0 if unicodedata.combining(char) else (2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1)
                if self.column >= self.columns:
                    self.column = 0
                    self.row += 1
                if self.row >= self.rows:
                    self.cells.pop(0)
                    self.cells.append([' '] * self.columns)
                    self.row = self.rows - 1
                if width:
                    self.cells[self.row][self.column] = char
                    if width == 2 and self.column + 1 < self.columns:
                        self.cells[self.row][self.column + 1] = ''
                    self.column += width
            if self.row >= self.rows:
                self.cells.pop(0)
                self.cells.append([' '] * self.columns)
                self.row = self.rows - 1
