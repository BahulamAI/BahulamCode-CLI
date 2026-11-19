//! Selection of painted conversation cells, independent of terminal mouse support.
use ratatui::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::{Color, Modifier},
};
use unicode_width::UnicodeWidthStr;

pub struct TextSelection {
    pub snapshot: Buffer,
    area: Rect,
    start: Position,
    end: Position,
    pub dragging: bool,
    pub released: bool,
}
impl TextSelection {
    pub fn new(snapshot: Buffer, area: Rect, start: Position) -> Self {
        Self {
            snapshot,
            area,
            start,
            end: start,
            dragging: false,
            released: false,
        }
    }
    pub fn update(&mut self, position: Position) {
        self.end = Position::new(
            position
                .x
                .clamp(self.area.x, self.area.right().saturating_sub(1)),
            position
                .y
                .clamp(self.area.y, self.area.bottom().saturating_sub(1)),
        );
        self.dragging |= self.end != self.start;
    }
    pub fn release(&mut self, position: Position) {
        self.update(position);
        self.released = true;
    }
    fn range(&self, y: u16) -> Option<std::ops::RangeInclusive<u16>> {
        let (start, end) = if (self.start.y, self.start.x) <= (self.end.y, self.end.x) {
            (self.start, self.end)
        } else {
            (self.end, self.start)
        };
        if y < start.y || y > end.y {
            return None;
        }
        Some(
            (if y == start.y { start.x } else { self.area.x })..=(if y == end.y {
                end.x
            } else {
                self.area.right() - 1
            }),
        )
    }
    pub fn text(&self) -> String {
        let mut rows = Vec::new();
        for y in self.area.y..self.area.bottom() {
            let Some(range) = self.range(y) else {
                continue;
            };
            let mut row = String::new();
            let mut x = self.area.x;
            while x < self.area.right() {
                let symbol = self.snapshot[(x, y)].symbol();
                let size = UnicodeWidthStr::width(symbol).max(1) as u16;
                if x <= *range.end() && x.saturating_add(size) > *range.start() {
                    row.push_str(symbol);
                }
                x += size;
            }
            rows.push(row.trim_end().to_owned());
        }
        rows.join("\n")
    }
    pub fn paint(&self, buffer: &mut Buffer) {
        buffer.clone_from(&self.snapshot);
        for y in self.area.y..self.area.bottom() {
            if let Some(range) = self.range(y) {
                for x in range {
                    let cell = &mut buffer[(x, y)];
                    // Explicit RGB avoids a terminal theme remapping ANSI white.
                    cell.set_fg(Color::Rgb(0, 0, 0))
                        .set_bg(Color::Rgb(255, 255, 255));
                    cell.modifier
                        .remove(Modifier::REVERSED | Modifier::DIM | Modifier::HIDDEN);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reversed_multiline_selection_keeps_unicode_and_excludes_other_panels() {
        let area = Rect::new(2, 1, 12, 2);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 30, 5));
        buffer.set_string(2, 1, "abc界def", ratatui::style::Style::default());
        buffer.set_string(2, 2, "second", ratatui::style::Style::default());
        buffer.set_string(16, 1, "agents", ratatui::style::Style::default());
        let mut selection = TextSelection::new(buffer.clone(), area, Position::new(4, 2));
        selection.update(Position::new(6, 1)); // trailing cell of 界
        assert_eq!(selection.text(), "界def\nsec");
        selection.paint(&mut buffer);
        assert_eq!(buffer[(6, 1)].bg, Color::Rgb(255, 255, 255));
        assert_eq!(buffer[(6, 1)].fg, Color::Rgb(0, 0, 0));
        assert_eq!(buffer[(16, 1)].bg, Color::Reset);
        selection.update(Position::new(0, 0));
        assert_eq!(selection.text(), "abc界def\nsec");
        selection.release(Position::new(0, 0));
        assert!(selection.released && selection.dragging);
        let mut repaint = selection.snapshot.clone();
        selection.paint(&mut repaint);
        assert_eq!(repaint[(6, 1)].bg, Color::Rgb(255, 255, 255));
        assert_eq!(selection.text(), "abc界def\nsec");
    }
}
