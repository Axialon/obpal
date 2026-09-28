//! CoreGraphics input. A private event source keeps synthetic modifiers separate from the user's keyboard.

use std::collections::{BTreeMap, BTreeSet};
use std::ptr::null;
use std::time::{Duration, Instant};
use crate::{keys::KeyDef, protocol::MouseButton, session::Injector};
use super::{ffi::*, keys, text::{parts, Part}};

pub struct MacInjector {
    source: Option<Owned>,
    modifiers: BTreeMap<&'static str, u64>,
    buttons: BTreeSet<MouseButton>,
    ctrl_to_cmd: bool,
    desktop: bool,
    pressed: BTreeMap<&'static str, (u16, u64)>,
    zoom: i32,
    click: Option<(MouseButton, Point, Instant, i64)>,
}

impl Default for MacInjector {
    fn default() -> Self {
        Self { source: unsafe { Owned::new(CGEventSourceCreate(-1)) }, modifiers: BTreeMap::new(), buttons: BTreeSet::new(), ctrl_to_cmd: true, desktop: false, pressed: BTreeMap::new(), zoom: 0, click: None }
    }
}

impl MacInjector {
    fn source(&self) -> Ref { self.source.as_ref().map_or(null(), |s| s.0) }
    fn flags(&self) -> u64 { self.modifiers.values().fold(0, |a, b| a | b) }
    fn post(&self, event: Option<Owned>, flags: u64) {
        if let Some(event) = event { unsafe { CGEventSetFlags(event.0, flags); CGEventPost(0, event.0); } }
    }
    fn key_event(&self, code: u16, down: bool, flags: u64) {
        self.post(unsafe { Owned::new(CGEventCreateKeyboardEvent(self.source(), code, down)) }, flags);
    }
    fn tap(&self, code: u16, flags: u64) { self.key_event(code, true, flags); self.key_event(code, false, flags); }
    fn location(&self) -> Option<Point> {
        let event = unsafe { Owned::new(CGEventCreate(null()))? };
        Some(unsafe { CGEventGetLocation(event.0) })
    }
}

impl Injector for MacInjector {
    fn accessibility(&self) -> Option<bool> { Some(super::foreground::trusted()) }
    fn set_shortcuts(&mut self, ctrl_to_cmd: bool) { self.ctrl_to_cmd = ctrl_to_cmd; self.zoom = 0; }
    fn set_desktop(&mut self, desktop: bool) { self.desktop = desktop; }
    fn key(&mut self, key: &'static KeyDef, down: bool) {
        let Some((code, flag)) = keys::lookup(key.code, self.ctrl_to_cmd) else { return };
        if flag != 0 {
            if down { self.modifiers.insert(key.code, flag); } else { self.modifiers.remove(key.code); }
        }
        if !down && key.code.starts_with("Control") { self.zoom = 0; }
        let mapped = if flag == 0 && down {
            let mapped = if self.desktop { keys::desktop_chord(key.code, self.flags()) } else { None }.unwrap_or((code, self.flags()));
            self.pressed.insert(key.code, mapped);
            mapped
        } else if flag == 0 {
            self.pressed.remove(key.code).unwrap_or((code, self.flags()))
        } else { (code, self.flags()) };
        self.key_event(mapped.0, down, mapped.1);
    }
    fn button(&mut self, button: MouseButton, down: bool) {
        let Some(point) = self.location() else { return };
        if down { self.buttons.insert(button); } else { self.buttons.remove(&button); }
        let (native, kind) = match button.0 { 0 => (0, if down { 1 } else { 2 }), 2 => (1, if down { 3 } else { 4 }), n => (u32::from(n.max(2)), if down { 25 } else { 26 }) };
        // DOM middle is 1, Quartz center is 2; DOM back/forward already use 3/4.
        let native = if button.0 == 1 { 2 } else { native };
        let now = Instant::now();
        if down {
            let count = self.click.filter(|(b, p, t, _)| *b == button && now.duration_since(*t) <= Duration::from_millis(500) && (p.x - point.x).abs() < 4.0 && (p.y - point.y).abs() < 4.0).map_or(1, |c| c.3 % 3 + 1);
            self.click = Some((button, point, now, count));
        }
        let event = unsafe { Owned::new(CGEventCreateMouseEvent(self.source(), kind, point, native)) };
        if let Some(e) = &event { unsafe { CGEventSetIntegerValueField(e.0, 1, self.click.map_or(1, |c| c.3)); } }
        self.post(event, self.flags());
    }
    fn mouse_move(&mut self, dx: i32, dy: i32) {
        let Some(mut point) = self.location() else { return };
        point.x += f64::from(dx); point.y += f64::from(dy);
        let (kind, button) = if self.buttons.contains(&MouseButton::LEFT) { (6, 0) }
            else if self.buttons.contains(&MouseButton::RIGHT) { (7, 1) }
            else if let Some(b) = self.buttons.first() { (27, if b.0 == 1 { 2 } else { u32::from(b.0) }) }
            else { (5, 0) };
        let event = unsafe { Owned::new(CGEventCreateMouseEvent(self.source(), kind, point, button)) };
        if let Some(e) = &event { unsafe { CGEventSetIntegerValueField(e.0, 4, dx.into()); CGEventSetIntegerValueField(e.0, 5, dy.into()); } }
        self.post(event, self.flags());
    }
    fn wheel(&mut self, dx: i32, dy: i32) {
        // Link expresses zoom as Ctrl+wheel. Mac apps use Command +/- instead of Command+wheel.
        if self.modifiers.keys().any(|k| k.starts_with("Control")) {
            self.zoom += dy;
            while self.zoom.abs() >= 120 {
                self.tap(if self.zoom < 0 { 24 } else { 27 }, keys::COMMAND);
                self.zoom -= self.zoom.signum() * 120;
            }
        } else {
            // Pixel units preserve small trackpad deltas. Quartz's sign is the opposite of the DOM's.
            self.post(unsafe { Owned::new(CGEventCreateScrollWheelEvent(self.source(), 0, 2, -dy, -dx)) }, self.flags());
        }
    }
    fn text(&mut self, del: u32, s: &str) {
        for _ in 0..del { self.tap(51, 0); }
        for part in parts(s) {
            match part {
                Part::Key(key) => self.tap(key, 0),
                Part::Unicode(chunk) => for down in [true, false] {
                    let event = unsafe { Owned::new(CGEventCreateKeyboardEvent(self.source(), 0, down)) };
                    if let Some(e) = &event { unsafe { CGEventKeyboardSetUnicodeString(e.0, chunk.len(), chunk.as_ptr()); } }
                    self.post(event, 0);
                },
            }
        }
    }
}
