//! Native encoders run on the existing image worker, never in the input/render loop.
use crate::capabilities::TerminalCapabilities;
use ratatui::layout::Size;
use ratatui_image::{
    picker::{Picker, ProtocolType},
    protocol::Protocol,
    Resize,
};
use std::hash::{Hash, Hasher};

#[derive(Clone, Copy, Debug)]
pub struct Graphics {
    pub protocol: ProtocolType,
    pub cell: [u16; 2],
}
impl Graphics {
    pub fn detect(caps: &TerminalCapabilities) -> Option<Self> {
        if !caps.interactive || caps.color_depth == "none" {
            return None;
        }
        let requested = std::env::var("BAHULAM_TUI_GRAPHICS").unwrap_or_else(|_| "auto".into());
        let protocol = match requested.as_str() {
            "off" | "cells" => return None,
            "kitty" => ProtocolType::Kitty,
            "sixel" => ProtocolType::Sixel,
            "iterm2" => ProtocolType::Iterm2,
            "auto" if caps.tmux || caps.screen => return None,
            "auto" => match caps.profile.as_str() {
                "Kitty" => ProtocolType::Kitty,
                "iTerm2" => ProtocolType::Iterm2,
                _ if caps.probe.sixel == Some(true) => ProtocolType::Sixel,
                _ => return None,
            },
            _ => return None,
        };
        // An explicit protocol is useful for native validation when ConPTY drops replies.
        // Automatic selection never guesses pixel geometry.
        let cell = caps
            .probe
            .cell_pixels
            .or_else(|| (requested != "auto").then_some([10, 20]))?;
        if cell[0] == 0 || cell[1] == 0 {
            return None;
        }
        Some(Self { protocol, cell })
    }
    pub fn encode(self, pixels: &image::RgbaImage) -> Option<NativeImage> {
        // Reuse our bounded probe instead of introducing a second stdin reader.
        #[allow(deprecated)]
        let mut picker =
            Picker::from_fontsize(ratatui_image::FontSize::new(self.cell[0], self.cell[1]));
        picker.set_protocol_type(self.protocol);
        let protocol = picker
            .new_protocol(
                image::DynamicImage::ImageRgba8(pixels.clone()),
                Size::new(48, 8),
                Resize::Fit(None),
            )
            .ok()?;
        Some(NativeImage(protocol))
    }
}
pub struct NativeImage(pub Protocol);
impl std::fmt::Debug for NativeImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("NativeImage").field(&self.0.size()).finish()
    }
}
impl Hash for NativeImage {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.0.size().hash(state);
    }
}
