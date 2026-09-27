//! The control session: everything between a parsed request and the OS injector.
//!
//! Safety rules, all enforced here (PLAN.md §9):
//! - Injection is off until the extension enables it, and a panic hotkey or a pause stops it again.
//! - Only host-side mapped actions run: keys from the allowlisted table, relative mouse motion, mouse
//!   buttons and the wheel. Frames carry the whole desired held state, never edges, so a lost or refused
//!   frame cannot leave a key down that the extension thinks is up.
//! - Every frame is gated on the foreground program, looked up per frame (the `Foreground` backend makes an
//!   unchanged window cheap): only an allowed program receives input, and only the kinds its scope allows. An elevated window is refused and reported.
//! - Whole-PC mode, when a person turns it on, replaces the per-program gate: every window receives input with
//!   its scope, the browser included. Elevated windows are reported, not refused: Windows drops input to them
//!   (UIPI), and the pointer must stay free to leave them.
//! - Everything held is released when the foreground changes (except in whole-PC mode, where a click that
//!   brings a window to the front must not end its own drag), on disable, pause, panic, disconnect, and
//!   after `WATCHDOG` without frames. Frames are rate-limited to `MAX_FRAMES_PER_SEC`.
//!
//! OS access goes through the `Injector` and `Foreground` traits, so this module is unit-tested with mocks
//! and ports to other platforms by adding injectors.

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::keys::KeyDef;
use crate::protocol::{validate, validate_text, Caps, Frame, MouseButton, ProgramInfo, Refused, Reply, Request, Scope, TextFocus, Validated, PROTO};
use crate::scope::{normalize, Config};

/// How long a foreground lookup stays valid: none, so a switch to another window stops input on the next frame
/// (a cached answer would type into the newly focused window until it expired).
pub const FRONT_TTL: Duration = Duration::ZERO;
/// Release everything after this long without a frame.
pub const WATCHDOG: Duration = Duration::from_millis(500);
/// Frames per second accepted; the rest are dropped (the next accepted frame re-syncs the state).
pub const MAX_FRAMES_PER_SEC: u32 = 250;
/// Text requests per second accepted (a phone sends one per keystroke, or per word from a swipe).
pub const MAX_TEXTS_PER_SEC: u32 = 40;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const OS: &str = std::env::consts::OS;

/// The OS input injector.
pub trait Injector {
    fn key(&mut self, key: &'static KeyDef, down: bool);
    fn button(&mut self, button: MouseButton, down: bool);
    fn mouse_move(&mut self, dx: i32, dy: i32);
    /// Wheel in 1/120 notch units, DOM convention (+y scrolls down).
    fn wheel(&mut self, dx: i32, dy: i32);
    /// Delete `del` characters before the caret, then type `s` ('\n' Enter, '\t' Tab).
    fn text(&mut self, del: u32, s: &str);
}

/// The window in front and the process behind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrontWindow {
    pub pid: u32,
    /// Image path; empty when the process could not be identified (then nothing is injected).
    pub path: String,
    pub name: String,
    pub title: String,
    /// Higher integrity level than the helper: UIPI would drop our input.
    pub elevated: bool,
    /// The browser that launched the helper.
    pub browser: bool,
}

pub trait Foreground {
    fn front(&mut self) -> Option<FrontWindow>;
    /// Whether a text field has the keyboard focus (None where the OS can't tell).
    fn text_focus(&mut self) -> Option<TextFocus> {
        None
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    NotEnabled,
    Paused,
    Panic,
    NotAllowed,
    Elevated,
    NoWindow,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub frames: u64,
    pub injected: u64,
    pub refused: Refused,
}

pub struct Session<I: Injector, F: Foreground> {
    inj: I,
    fg: F,
    cfg: Config,
    cfg_path: Option<PathBuf>,
    hotkey: Option<String>,
    enabled: bool,
    panic: bool,
    held_keys: BTreeSet<&'static KeyDef>,
    held_buttons: BTreeSet<MouseButton>,
    front: Option<FrontWindow>,
    front_at: Option<Instant>,
    /// The most recent foreground program that is not the browser.
    program: Option<FrontWindow>,
    /// Programs seen in the foreground this session: the only ones `allow` accepts.
    seen: HashSet<String>,
    last_frame: Option<Instant>,
    window_start: Option<Instant>,
    window_count: u32,
    text_window: Option<Instant>,
    text_count: u32,
    /// A text field has the focus, as of the last foreground check.
    text: Option<TextFocus>,
    stats: Stats,
    last_status: Option<Reply>,
}

impl<I: Injector, F: Foreground> Session<I, F> {
    pub fn new(inj: I, fg: F, cfg: Config, cfg_path: Option<PathBuf>, hotkey: Option<String>) -> Self {
        Session {
            inj,
            fg,
            cfg,
            cfg_path,
            hotkey,
            enabled: false,
            panic: false,
            held_keys: BTreeSet::new(),
            held_buttons: BTreeSet::new(),
            front: None,
            front_at: None,
            program: None,
            seen: HashSet::new(),
            last_frame: None,
            window_start: None,
            window_count: 0,
            text_window: None,
            text_count: 0,
            text: None,
            stats: Stats::default(),
            last_status: None,
        }
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn is_holding(&self) -> bool {
        !self.held_keys.is_empty() || !self.held_buttons.is_empty()
    }

    // ---- requests -------------------------------------------------------------------------------

    /// Handle one request; returns the replies to send, in order.
    pub fn handle(&mut self, req: Request, now: Instant) -> Vec<Reply> {
        let mut out = Vec::new();
        match req {
            Request::Hello { v } => {
                if v != PROTO {
                    out.push(Reply::error("proto", format!("extension speaks v{v}, helper v{PROTO}")));
                }
                out.push(Reply::Hello {
                    v: PROTO,
                    version: VERSION,
                    os: OS,
                    hotkey: self.hotkey.clone(),
                    caps: Caps { keyboard: true, mouse: true, gamepad: false, desktop: true, text: cfg!(windows) },
                });
                out.push(self.config_reply());
                self.refresh_front(now, true);
                self.last_status = None; // a fresh extension side wants the full picture
            }
            Request::Enable { on } => {
                self.enabled = on;
                if !on {
                    self.release_all();
                }
            }
            Request::Frame(f) => {
                if let Some(err) = self.on_frame(&f, now) {
                    out.push(err);
                }
            }
            Request::Text { s, del } => {
                if let Some(err) = self.on_text(&s, del, now) {
                    out.push(err);
                }
            }
            Request::Release => self.release_all(),
            Request::Allow { path, keyboard, mouse } => {
                if !self.seen.contains(&normalize(&path)) {
                    out.push(Reply::error("unknown-program", "only a program seen in the foreground can be allowed"));
                } else {
                    match self.cfg.allow(&path, Scope { keyboard, mouse, gamepad: false }) {
                        Ok(_) => {
                            self.persist(&mut out);
                            out.push(self.config_reply());
                        }
                        Err(e) => out.push(Reply::error("bad-path", e)),
                    }
                }
            }
            Request::Scope { path, keyboard, mouse } => match self.cfg.set_scope(&path, Scope { keyboard, mouse, gamepad: false }) {
                Ok(_) => {
                    self.release_all();
                    self.persist(&mut out);
                    out.push(self.config_reply());
                }
                Err(e) => out.push(Reply::error("unknown-program", e)),
            },
            Request::Forget { path } => {
                if self.cfg.forget(&path) {
                    self.release_all();
                    self.persist(&mut out);
                }
                out.push(self.config_reply());
            }
            Request::Desktop { on, keyboard, mouse } => {
                if self.cfg.set_desktop(on.then_some(Scope { keyboard, mouse, gamepad: false })) {
                    self.release_all();
                    self.persist(&mut out);
                }
                out.push(self.config_reply());
            }
            Request::Pause { on } => {
                if self.cfg.paused != on {
                    self.cfg.paused = on;
                    if on {
                        self.release_all();
                    }
                    self.persist(&mut out);
                }
                out.push(self.config_reply());
            }
            Request::Resume => {
                self.panic = false;
            }
            Request::Stats => out.push(Reply::Stats { frames: self.stats.frames, injected: self.stats.injected, refused: self.stats.refused }),
        }
        self.push_status(&mut out);
        out
    }

    /// Periodic housekeeping (call every ~50 ms): foreground tracking, the watchdog, status changes.
    pub fn poll(&mut self, now: Instant) -> Vec<Reply> {
        self.refresh_front(now, false);
        if self.is_holding() && self.last_frame.map_or(true, |t| now.duration_since(t) >= WATCHDOG) {
            self.release_all();
        }
        let mut out = Vec::new();
        self.push_status(&mut out);
        out
    }

    /// The panic hotkey: let go of everything and stay stopped until the extension resumes.
    pub fn on_panic(&mut self) -> Vec<Reply> {
        self.panic = true;
        self.release_all();
        let mut out = Vec::new();
        self.push_status(&mut out);
        out
    }

    /// The port closed (stdin EOF, the browser went away): release and forget the extension.
    pub fn shutdown(&mut self) {
        self.enabled = false;
        self.release_all();
    }

    // ---- frames ---------------------------------------------------------------------------------

    fn on_frame(&mut self, f: &Frame, now: Instant) -> Option<Reply> {
        self.stats.frames += 1;
        self.last_frame = Some(now);
        if !self.rate_ok(now) {
            self.stats.refused.rate += 1;
            return None;
        }
        let v = match validate(f) {
            Ok(v) => v,
            Err(e) => {
                self.stats.refused.invalid += 1;
                return Some(Reply::error("bad-frame", e));
            }
        };
        match self.gate(now) {
            Ok(scope) => {
                self.apply(&v, scope);
                self.stats.injected += 1;
            }
            Err(why) => {
                self.count(why);
                // Whatever was held belonged to a window that is no longer a valid target.
                self.release_all();
            }
        }
        None
    }

    /// Typing from the phone: gated like a frame, and only where the keyboard may go. Never while a modifier is
    /// held (Ctrl held for a zoom would turn "a" into Select All).
    fn on_text(&mut self, s: &str, del: u32, now: Instant) -> Option<Reply> {
        if let Err(e) = validate_text(s, del) {
            self.stats.refused.invalid += 1;
            return Some(Reply::error("bad-text", e));
        }
        if !self.text_rate_ok(now) {
            self.stats.refused.rate += 1;
            return Some(Reply::error("text-rate", "typing too fast"));
        }
        match self.gate(now) {
            Ok(scope) if scope.keyboard => {
                if self.held_keys.iter().any(|k| k.modifier) {
                    return Some(Reply::error("keys-held", "a modifier is held: typing now would make shortcuts"));
                }
                self.inj.text(del, s);
                self.stats.injected += 1;
                None
            }
            Ok(_) => {
                self.stats.refused.not_allowed += 1;
                Some(Reply::error("not-typed", "this window may not receive the keyboard"))
            }
            Err(why) => {
                self.count(why);
                Some(Reply::error("not-typed", format!("{why:?}")))
            }
        }
    }

    fn text_rate_ok(&mut self, now: Instant) -> bool {
        match self.text_window {
            Some(t) if now.duration_since(t) < Duration::from_secs(1) => {
                self.text_count += 1;
                self.text_count <= MAX_TEXTS_PER_SEC
            }
            _ => {
                self.text_window = Some(now);
                self.text_count = 1;
                true
            }
        }
    }

    fn count(&mut self, why: Refusal) {
        let r = &mut self.stats.refused;
        match why {
            Refusal::NotEnabled => r.not_enabled += 1,
            Refusal::Paused => r.paused += 1,
            Refusal::Panic => r.panic += 1,
            Refusal::NotAllowed => r.not_allowed += 1,
            Refusal::Elevated => r.elevated += 1,
            Refusal::NoWindow => r.no_window += 1,
        }
    }

    /// May this frame be injected, and with which scope?
    fn gate(&mut self, now: Instant) -> Result<Scope, Refusal> {
        if !self.enabled {
            return Err(Refusal::NotEnabled);
        }
        if self.panic {
            return Err(Refusal::Panic);
        }
        if self.cfg.paused {
            return Err(Refusal::Paused);
        }
        self.refresh_front(now, false);
        // Whole PC: whatever is in front, the browser included. Windows itself drops input to an elevated window
        // (UIPI); the status reports it, and the pointer can still move off it and click another window.
        if let Some(scope) = self.cfg.desktop_scope() {
            return Ok(scope);
        }
        let Some(w) = &self.front else { return Err(Refusal::NoWindow) };
        if w.path.is_empty() {
            return Err(Refusal::NoWindow);
        }
        let scope = self.cfg.scope_for(&w.path).ok_or(Refusal::NotAllowed)?;
        if w.elevated {
            return Err(Refusal::Elevated);
        }
        Ok(scope)
    }

    /// Bring the held state to the frame's desired state within the scope, then apply the motion.
    fn apply(&mut self, v: &Validated, scope: Scope) {
        let want_keys: BTreeSet<&'static KeyDef> = if scope.keyboard { v.keys.clone() } else { BTreeSet::new() };
        self.sync_keys(&want_keys);
        let want_buttons: BTreeSet<MouseButton> = if scope.mouse { v.buttons.clone() } else { BTreeSet::new() };
        for b in self.held_buttons.difference(&want_buttons).copied().collect::<Vec<_>>() {
            self.held_buttons.remove(&b);
            self.inj.button(b, false);
        }
        for b in want_buttons.difference(&self.held_buttons.clone()).copied().collect::<Vec<_>>() {
            self.held_buttons.insert(b);
            self.inj.button(b, true);
        }
        if scope.mouse {
            if v.dx != 0 || v.dy != 0 {
                self.inj.mouse_move(v.dx, v.dy);
            }
            if v.wheel_x != 0 || v.wheel_y != 0 {
                self.inj.wheel(v.wheel_x, v.wheel_y);
            }
        }
    }

    /// Releases first (plain keys, then modifiers), then presses (modifiers, then plain keys), like a person.
    fn sync_keys(&mut self, want: &BTreeSet<&'static KeyDef>) {
        let ups: Vec<&'static KeyDef> = self.held_keys.difference(want).copied().collect();
        let downs: Vec<&'static KeyDef> = want.difference(&self.held_keys).copied().collect();
        for k in ups.iter().filter(|k| !k.modifier).chain(ups.iter().filter(|k| k.modifier)) {
            self.held_keys.remove(k);
            self.inj.key(k, false);
        }
        for k in downs.iter().filter(|k| k.modifier).chain(downs.iter().filter(|k| !k.modifier)) {
            self.held_keys.insert(k);
            self.inj.key(k, true);
        }
    }

    fn release_all(&mut self) {
        self.sync_keys(&BTreeSet::new());
        for b in std::mem::take(&mut self.held_buttons) {
            self.inj.button(b, false);
        }
    }

    fn rate_ok(&mut self, now: Instant) -> bool {
        match self.window_start {
            Some(t) if now.duration_since(t) < Duration::from_secs(1) => {
                self.window_count += 1;
                self.window_count <= MAX_FRAMES_PER_SEC
            }
            _ => {
                self.window_start = Some(now);
                self.window_count = 1;
                true
            }
        }
    }

    // ---- foreground -----------------------------------------------------------------------------

    fn refresh_front(&mut self, now: Instant, force: bool) {
        if !force && self.front_at.map_or(false, |t| now.duration_since(t) < FRONT_TTL) {
            return;
        }
        self.front_at = Some(now);
        let next = self.fg.front();
        self.text = self.fg.text_focus();
        let same = match (&self.front, &next) {
            (Some(a), Some(b)) => a.pid == b.pid && normalize(&a.path) == normalize(&b.path),
            (None, None) => true,
            _ => false,
        };
        // A new window in front gets nothing that was held for the old one. In whole-PC mode the held state belongs
        // to the PC, not a window: pressing on a window in the background brings it to the front, and releasing
        // then would end every drag that starts there.
        if !same && self.is_holding() && self.cfg.desktop_scope().is_none() {
            self.release_all();
        }
        if let Some(w) = &next {
            if !w.browser && !w.path.is_empty() {
                self.seen.insert(normalize(&w.path));
                self.program = Some(w.clone());
            }
        }
        self.front = next;
    }

    // ---- replies --------------------------------------------------------------------------------

    fn info(&self, w: &FrontWindow) -> ProgramInfo {
        ProgramInfo {
            name: w.name.clone(),
            path: w.path.clone(),
            title: w.title.clone(),
            pid: w.pid,
            elevated: w.elevated,
            browser: w.browser,
            allowed: if w.path.is_empty() { None } else { self.cfg.scope_for(&w.path) },
        }
    }

    fn status(&self) -> Reply {
        Reply::Status {
            enabled: self.enabled,
            panic: self.panic,
            held: self.is_holding(),
            front: self.front.as_ref().map(|w| self.info(w)),
            program: self.program.as_ref().map(|w| self.info(w)),
            text: self.text,
        }
    }

    fn push_status(&mut self, out: &mut Vec<Reply>) {
        let s = self.status();
        if self.last_status.as_ref() != Some(&s) {
            self.last_status = Some(s.clone());
            out.push(s);
        }
    }

    fn config_reply(&self) -> Reply {
        Reply::Config { paused: self.cfg.paused, desktop: self.cfg.desktop, programs: self.cfg.programs.clone() }
    }

    fn persist(&mut self, out: &mut Vec<Reply>) {
        if let Some(p) = &self.cfg_path {
            if let Err(e) = self.cfg.save(p) {
                out.push(Reply::error("config-save", format!("{}: {e}", p.display())));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::lookup;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Default)]
    struct Mock {
        log: Rc<RefCell<Vec<String>>>,
    }
    impl Injector for Mock {
        fn key(&mut self, key: &'static KeyDef, down: bool) {
            self.log.borrow_mut().push(format!("{}{}", key.code, if down { '+' } else { '-' }));
        }
        fn button(&mut self, b: MouseButton, down: bool) {
            self.log.borrow_mut().push(format!("b{}{}", b.0, if down { '+' } else { '-' }));
        }
        fn mouse_move(&mut self, dx: i32, dy: i32) {
            self.log.borrow_mut().push(format!("m{dx},{dy}"));
        }
        fn wheel(&mut self, dx: i32, dy: i32) {
            self.log.borrow_mut().push(format!("w{dx},{dy}"));
        }
        fn text(&mut self, del: u32, s: &str) {
            self.log.borrow_mut().push(format!("t{del}:{s}"));
        }
    }

    struct Fg(Rc<RefCell<Option<FrontWindow>>>, Rc<RefCell<Option<TextFocus>>>);
    impl Foreground for Fg {
        fn front(&mut self) -> Option<FrontWindow> {
            self.0.borrow().clone()
        }
        fn text_focus(&mut self) -> Option<TextFocus> {
            *self.1.borrow()
        }
    }

    fn win(path: &str) -> FrontWindow {
        FrontWindow { pid: 100, path: path.into(), name: crate::scope::base_name(path), title: "t".into(), elevated: false, browser: false }
    }
    fn abs(name: &str) -> String {
        if cfg!(windows) { format!("C:\\Games\\{name}") } else { format!("/games/{name}") }
    }
    fn frame(keys: &[&str]) -> Request {
        Request::Frame(Frame { k: keys.iter().map(|s| s.to_string()).collect(), ..Default::default() })
    }
    fn full(keys: &[&str], b: &[u8], m: [i32; 2], w: [i32; 2]) -> Request {
        Request::Frame(Frame { k: keys.iter().map(|s| s.to_string()).collect(), b: b.to_vec(), m: Some(m), w: Some(w) })
    }

    struct T {
        s: Session<Mock, Fg>,
        log: Rc<RefCell<Vec<String>>>,
        fg: Rc<RefCell<Option<FrontWindow>>>,
        focus: Rc<RefCell<Option<TextFocus>>>,
        t0: Instant,
    }
    impl T {
        fn new() -> T {
            let log = Rc::new(RefCell::new(Vec::new()));
            let fg = Rc::new(RefCell::new(None));
            let focus = Rc::new(RefCell::new(None));
            let s = Session::new(Mock { log: log.clone() }, Fg(fg.clone(), focus.clone()), Config::new(), None, Some("Ctrl+Alt+Backspace".into()));
            T { s, log, fg, focus, t0: Instant::now() }
        }
        fn at(&self, ms: u64) -> Instant {
            self.t0 + Duration::from_millis(ms)
        }
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.log.borrow_mut())
        }
        fn front(&self, w: Option<FrontWindow>) {
            *self.fg.borrow_mut() = w;
        }
        /// Enabled, with `game.exe` in front and allowed for keyboard + mouse.
        fn ready() -> T {
            let mut t = T::new();
            t.front(Some(win(&abs("game.exe"))));
            t.s.handle(Request::Hello { v: 1 }, t.at(0));
            t.s.handle(Request::Enable { on: true }, t.at(0));
            let r = t.s.handle(Request::Allow { path: abs("game.exe"), keyboard: true, mouse: true }, t.at(0));
            assert!(matches!(r[0], Reply::Config { .. }), "{r:?}");
            t.take();
            t
        }
    }

    fn refused(t: &T) -> Refused {
        t.s.stats().refused
    }

    #[test]
    fn nothing_is_injected_until_enabled() {
        let mut t = T::new();
        t.front(Some(win(&abs("game.exe"))));
        t.s.handle(frame(&["KeyW"]), t.at(0));
        assert_eq!(refused(&t).not_enabled, 1);
        assert!(t.take().is_empty());
        // allowed but still not enabled
        t.s.handle(Request::Hello { v: 1 }, t.at(10));
        t.s.handle(Request::Allow { path: abs("game.exe"), keyboard: true, mouse: true }, t.at(10));
        t.s.handle(frame(&["KeyW"]), t.at(20));
        assert_eq!(refused(&t).not_enabled, 2);
        assert!(t.take().is_empty());
    }

    #[test]
    fn hello_answers_with_hello_config_and_status() {
        let mut t = T::new();
        let out = t.s.handle(Request::Hello { v: 1 }, t.at(0));
        assert!(matches!(&out[0], Reply::Hello { v: PROTO, caps, .. } if *caps == Caps { keyboard: true, mouse: true, gamepad: false, desktop: true, text: cfg!(windows) }));
        assert!(matches!(out[1], Reply::Config { paused: false, .. }));
        assert!(matches!(out[2], Reply::Status { enabled: false, panic: false, held: false, front: None, program: None, text: None }));
        assert_eq!(out.len(), 3);
        let out = t.s.handle(Request::Hello { v: 2 }, t.at(0));
        assert!(matches!(out[0], Reply::Error { code: "proto", .. }));
    }

    #[test]
    fn default_deny_then_allow_only_a_seen_program() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.s.handle(Request::Enable { on: true }, t.at(0));
        // never seen: cannot be allowed
        let out = t.s.handle(Request::Allow { path: abs("game.exe"), keyboard: true, mouse: true }, t.at(0));
        assert!(matches!(out[0], Reply::Error { code: "unknown-program", .. }));
        assert!(t.s.config().programs.is_empty());
        // no window at all
        t.s.handle(frame(&["KeyW"]), t.at(1));
        assert_eq!(refused(&t).no_window, 1);
        // in front but not allowed
        t.front(Some(win(&abs("game.exe"))));
        t.s.handle(frame(&["KeyW"]), t.at(300));
        assert_eq!(refused(&t).not_allowed, 1);
        assert!(t.take().is_empty());
        // now it has been seen
        let out = t.s.handle(Request::Allow { path: abs("game.exe"), keyboard: true, mouse: true }, t.at(310));
        assert!(matches!(&out[0], Reply::Config { programs, .. } if programs.len() == 1));
        t.s.handle(frame(&["KeyW"]), t.at(320));
        assert_eq!(t.take(), ["KeyW+"]);
        assert_eq!(t.s.stats().injected, 1);
    }

    #[test]
    fn frames_are_desired_state_and_keys_diff_with_modifier_order() {
        let mut t = T::ready();
        t.s.handle(frame(&["KeyW", "ShiftLeft"]), t.at(10));
        assert_eq!(t.take(), ["ShiftLeft+", "KeyW+"]);
        t.s.handle(frame(&["KeyW", "ShiftLeft"]), t.at(20));
        assert!(t.take().is_empty(), "same state: nothing sent");
        t.s.handle(frame(&["KeyA", "ControlLeft"]), t.at(30));
        assert_eq!(t.take(), ["KeyW-", "ShiftLeft-", "ControlLeft+", "KeyA+"]);
        t.s.handle(frame(&[]), t.at(40));
        assert_eq!(t.take(), ["KeyA-", "ControlLeft-"]);
        assert!(!t.s.is_holding());
    }

    #[test]
    fn mouse_buttons_motion_and_wheel() {
        let mut t = T::ready();
        t.s.handle(full(&[], &[0, 2], [5, -3], [0, 120]), t.at(10));
        assert_eq!(t.take(), ["b0+", "b2+", "m5,-3", "w0,120"]);
        t.s.handle(full(&[], &[2], [0, 0], [0, 0]), t.at(20));
        assert_eq!(t.take(), ["b0-"]);
        t.s.handle(Request::Release, t.at(30));
        assert_eq!(t.take(), ["b2-"]);
    }

    #[test]
    fn scope_limits_the_kinds_and_a_scope_change_releases() {
        let mut t = T::ready();
        t.s.handle(Request::Scope { path: abs("game.exe"), keyboard: true, mouse: false }, t.at(0));
        t.take();
        t.s.handle(full(&["KeyW"], &[0], [5, 5], [0, 120]), t.at(10));
        assert_eq!(t.take(), ["KeyW+"], "keyboard only: no buttons, motion or wheel");
        t.s.handle(Request::Scope { path: abs("game.exe"), keyboard: false, mouse: true }, t.at(20));
        assert_eq!(t.take(), ["KeyW-"], "held keys are released when the scope changes");
        t.s.handle(full(&["KeyW"], &[0], [5, 5], [0, 120]), t.at(30));
        assert_eq!(t.take(), ["b0+", "m5,5", "w0,120"], "mouse only: no keys");
        t.s.handle(Request::Scope { path: abs("game.exe"), keyboard: false, mouse: false }, t.at(40));
        t.take();
        t.s.handle(full(&["KeyW"], &[0], [5, 5], [0, 120]), t.at(50));
        assert_eq!(refused(&t).not_allowed, 1, "every kind off is not allowed");
        assert!(t.take().is_empty());
    }

    #[test]
    fn elevated_windows_are_refused_and_reported() {
        let mut t = T::ready();
        let mut w = win(&abs("game.exe"));
        w.elevated = true;
        w.pid = 101;
        t.front(Some(w));
        let out = t.s.handle(frame(&["KeyW"]), t.at(300));
        assert_eq!(refused(&t).elevated, 1);
        assert!(t.take().is_empty());
        assert!(matches!(&out[0], Reply::Status { front: Some(f), .. } if f.elevated && f.allowed.is_some()));
    }

    #[test]
    fn foreground_change_releases_and_the_next_frame_resyncs() {
        let mut t = T::ready();
        t.s.handle(frame(&["KeyW"]), t.at(10));
        assert_eq!(t.take(), ["KeyW+"]);
        // the browser comes to the front (Alt-Tab): W is released even though the phone still holds it
        let mut b = win(&abs("chrome.exe"));
        b.browser = true;
        b.pid = 7;
        t.front(Some(b));
        let out = t.s.poll(t.at(300));
        assert_eq!(t.take(), ["KeyW-"]);
        assert!(matches!(&out[0], Reply::Status { front: Some(f), program: Some(p), .. } if f.browser && p.name == "game.exe"));
        t.s.handle(frame(&["KeyW"]), t.at(310));
        assert_eq!(refused(&t).not_allowed, 1);
        assert!(t.take().is_empty());
        // back to the game: the same desired state presses W again
        t.front(Some(win(&abs("game.exe"))));
        t.s.handle(frame(&["KeyW"]), t.at(600));
        assert_eq!(t.take(), ["KeyW+"]);
        // the browser is never a program that could be allowed
        let out = t.s.handle(Request::Allow { path: abs("chrome.exe"), keyboard: true, mouse: true }, t.at(610));
        assert!(matches!(out[0], Reply::Error { code: "unknown-program", .. }));
    }

    #[test]
    fn watchdog_releases_after_500ms_without_frames() {
        let mut t = T::ready();
        t.s.handle(full(&["KeyW"], &[0], [0, 0], [0, 0]), t.at(10));
        t.take();
        assert!(t.s.poll(t.at(400)).is_empty());
        assert!(t.take().is_empty());
        let out = t.s.poll(t.at(510));
        assert_eq!(t.take(), ["KeyW-", "b0-"]);
        assert!(matches!(out[0], Reply::Status { held: false, .. }));
        assert!(!t.s.is_holding());
    }

    #[test]
    fn pause_panic_disable_and_shutdown_release_and_refuse() {
        let mut t = T::ready();
        t.s.handle(frame(&["KeyW"]), t.at(10));
        t.take();
        let out = t.s.handle(Request::Pause { on: true }, t.at(20));
        assert_eq!(t.take(), ["KeyW-"]);
        assert!(matches!(out[0], Reply::Config { paused: true, .. }));
        t.s.handle(frame(&["KeyW"]), t.at(30));
        assert_eq!(refused(&t).paused, 1);
        t.s.handle(Request::Pause { on: false }, t.at(40));
        t.s.handle(frame(&["KeyW"]), t.at(50));
        assert_eq!(t.take(), ["KeyW+"]);

        let out = t.s.on_panic();
        assert_eq!(t.take(), ["KeyW-"]);
        assert!(matches!(out[0], Reply::Status { panic: true, .. }));
        t.s.handle(frame(&["KeyW"]), t.at(60));
        assert_eq!(refused(&t).panic, 1);
        assert!(t.take().is_empty());
        let out = t.s.handle(Request::Resume, t.at(70));
        assert!(matches!(out[0], Reply::Status { panic: false, .. }));
        t.s.handle(frame(&["KeyW"]), t.at(80));
        assert_eq!(t.take(), ["KeyW+"]);

        let out = t.s.handle(Request::Enable { on: false }, t.at(90));
        assert_eq!(t.take(), ["KeyW-"]);
        assert!(matches!(out[0], Reply::Status { enabled: false, .. }));
        t.s.handle(frame(&["KeyW"]), t.at(100));
        assert_eq!(refused(&t).not_enabled, 1);

        t.s.handle(Request::Enable { on: true }, t.at(110));
        t.s.handle(full(&["KeyW", "ShiftLeft"], &[0, 2], [0, 0], [0, 0]), t.at(120));
        t.take();
        t.s.shutdown();
        assert_eq!(t.take(), ["KeyW-", "ShiftLeft-", "b0-", "b2-"]);
    }

    #[test]
    fn forget_releases_and_refuses() {
        let mut t = T::ready();
        t.s.handle(frame(&["KeyW"]), t.at(10));
        t.take();
        let out = t.s.handle(Request::Forget { path: abs("game.exe") }, t.at(20));
        assert_eq!(t.take(), ["KeyW-"]);
        assert!(matches!(&out[0], Reply::Config { programs, .. } if programs.is_empty()));
        t.s.handle(frame(&["KeyW"]), t.at(30));
        assert_eq!(refused(&t).not_allowed, 1);
        assert!(t.take().is_empty());
    }

    #[test]
    fn invalid_frames_are_errors_and_change_nothing() {
        let mut t = T::ready();
        t.s.handle(frame(&["KeyW"]), t.at(10));
        t.take();
        let out = t.s.handle(frame(&["KeyW", "MetaLeft"]), t.at(20));
        assert!(matches!(out[0], Reply::Error { code: "bad-frame", .. }));
        assert!(t.take().is_empty());
        assert!(t.s.is_holding(), "the previous state stays until a valid frame or the watchdog");
        assert_eq!(refused(&t).invalid, 1);
        assert_eq!(t.s.stats().injected, 1);
    }

    #[test]
    fn rate_limit_drops_excess_frames_without_losing_state() {
        let mut t = T::ready();
        for i in 0..MAX_FRAMES_PER_SEC {
            t.s.handle(frame(&["KeyW"]), t.at(i as u64));
        }
        t.take();
        t.s.handle(frame(&[]), t.at(300));
        assert_eq!(refused(&t).rate, 1);
        assert!(t.take().is_empty(), "the release frame was dropped");
        assert!(t.s.is_holding());
        t.s.handle(frame(&[]), t.at(1001));
        assert_eq!(t.take(), ["KeyW-"], "the next accepted frame re-syncs");
    }

    #[test]
    fn status_is_sent_only_when_it_changes() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        assert!(t.s.poll(t.at(50)).is_empty());
        t.front(Some(win(&abs("game.exe"))));
        // the foreground is looked up on every poll and frame, so the change is reported at once
        let out = t.s.poll(t.at(100));
        assert!(matches!(&out[0], Reply::Status { front: Some(f), program: Some(p), .. } if f.name == "game.exe" && p.name == "game.exe" && f.allowed.is_none()));
        assert!(t.s.poll(t.at(600)).is_empty());
        // allowing it changes the reported scope
        let out = t.s.handle(Request::Allow { path: abs("game.exe"), keyboard: true, mouse: false }, t.at(610));
        assert!(matches!(&out[1], Reply::Status { front: Some(f), .. } if f.allowed == Some(Scope { keyboard: true, mouse: false, gamepad: false })));
        // no window (secure desktop): front is null, program is remembered
        t.front(None);
        let out = t.s.poll(t.at(900));
        assert!(matches!(&out[0], Reply::Status { front: None, program: Some(_), .. }));
    }

    #[test]
    fn stats_count_everything() {
        let mut t = T::ready();
        t.s.handle(frame(&["KeyW"]), t.at(10));
        t.front(None);
        t.s.handle(frame(&["KeyW"]), t.at(300));
        let out = t.s.handle(Request::Stats, t.at(310));
        assert!(matches!(out[0], Reply::Stats { frames: 2, injected: 1, refused: Refused { no_window: 1, .. } }));
    }

    #[test]
    fn unidentified_front_process_gets_nothing() {
        let mut t = T::ready();
        let mut w = win("");
        w.name = "?".into();
        w.elevated = true;
        t.front(Some(w));
        t.s.handle(frame(&["KeyW"]), t.at(300));
        assert_eq!(refused(&t).no_window, 1);
        assert!(t.take().is_empty());
        assert!(lookup("KeyW").is_some());
    }

    fn desktop(t: &mut T, on: bool, keyboard: bool, mouse: bool, ms: u64) -> Vec<Reply> {
        t.s.handle(Request::Desktop { on, keyboard, mouse }, t.at(ms))
    }

    #[test]
    fn whole_pc_mode_reaches_every_window_until_it_is_turned_off() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.s.handle(Request::Enable { on: true }, t.at(0));
        t.front(Some(win(&abs("notepad.exe"))));
        t.s.handle(frame(&["KeyW"]), t.at(10));
        assert_eq!(refused(&t).not_allowed, 1, "off by default: nothing is allowed");
        let out = desktop(&mut t, true, true, true, 20);
        assert!(matches!(&out[0], Reply::Config { desktop: Some(Scope { keyboard: true, mouse: true, .. }), .. }), "{out:?}");
        t.s.handle(full(&["KeyW"], &[0], [4, 2], [0, 120]), t.at(30));
        assert_eq!(t.take(), ["KeyW+", "b0+", "m4,2", "w0,120"]);
        // the browser, an elevated window, and no window at all: all still receive input
        let mut b = win(&abs("chrome.exe"));
        b.browser = true;
        b.pid = 7;
        t.front(Some(b));
        t.s.handle(full(&["KeyW"], &[0], [1, 0], [0, 0]), t.at(40));
        assert_eq!(t.take(), ["m1,0"], "still held across the switch, and the pointer moves");
        let mut e = win(&abs("taskmgr.exe"));
        e.elevated = true;
        e.pid = 8;
        t.front(Some(e));
        t.s.handle(full(&[], &[], [2, 0], [0, 0]), t.at(50));
        assert_eq!(t.take(), ["KeyW-", "b0-", "m2,0"]);
        t.front(None);
        t.s.handle(full(&[], &[2], [0, 0], [0, 0]), t.at(60));
        assert_eq!(t.take(), ["b2+"]);
        assert_eq!(t.s.stats().refused.elevated + t.s.stats().refused.no_window, 0);
        // off again: released, and back to the allowlist
        t.front(Some(win(&abs("notepad.exe"))));
        desktop(&mut t, false, true, true, 70);
        assert_eq!(t.take(), ["b2-"]);
        t.s.handle(frame(&["KeyW"]), t.at(80));
        assert_eq!(refused(&t).not_allowed, 2);
        assert!(t.take().is_empty());
    }

    #[test]
    fn whole_pc_mode_keeps_a_drag_across_the_click_that_raises_a_window() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.s.handle(Request::Enable { on: true }, t.at(0));
        desktop(&mut t, true, true, true, 0);
        t.front(Some(win(&abs("explorer.exe"))));
        t.s.handle(full(&[], &[0], [0, 0], [0, 0]), t.at(10));
        assert_eq!(t.take(), ["b0+"]);
        // the press brought another window to the front: the button stays down and the drag goes on
        let mut w = win(&abs("notepad.exe"));
        w.pid = 9;
        t.front(Some(w));
        t.s.poll(t.at(20));
        t.s.handle(full(&[], &[0], [30, 5], [0, 0]), t.at(30));
        t.s.handle(full(&[], &[], [0, 0], [0, 0]), t.at(40));
        assert_eq!(t.take(), ["m30,5", "b0-"]);
    }

    #[test]
    fn whole_pc_mode_honours_its_scope_pause_panic_and_the_watchdog() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.s.handle(Request::Enable { on: true }, t.at(0));
        t.front(Some(win(&abs("notepad.exe"))));
        desktop(&mut t, true, false, true, 0);
        t.s.handle(full(&["KeyW"], &[0], [1, 1], [0, 0]), t.at(10));
        assert_eq!(t.take(), ["b0+", "m1,1"], "mouse only");
        desktop(&mut t, true, true, false, 20);
        assert_eq!(t.take(), ["b0-"], "a scope change releases");
        t.s.handle(full(&["KeyW"], &[0], [1, 1], [0, 0]), t.at(30));
        assert_eq!(t.take(), ["KeyW+"], "keyboard only");
        t.s.handle(Request::Pause { on: true }, t.at(40));
        assert_eq!(t.take(), ["KeyW-"]);
        t.s.handle(frame(&["KeyW"]), t.at(50));
        assert_eq!(refused(&t).paused, 1);
        t.s.handle(Request::Pause { on: false }, t.at(60));
        t.s.handle(frame(&["KeyW"]), t.at(70));
        assert_eq!(t.take(), ["KeyW+"]);
        t.s.on_panic();
        assert_eq!(t.take(), ["KeyW-"]);
        t.s.handle(frame(&["KeyW"]), t.at(80));
        assert_eq!(refused(&t).panic, 1);
        t.s.handle(Request::Resume, t.at(90));
        t.s.handle(frame(&["KeyW"]), t.at(100));
        t.take();
        t.s.poll(t.at(700));
        assert_eq!(t.take(), ["KeyW-"], "the watchdog still lets go");
        // on with nothing allowed is off
        desktop(&mut t, true, false, false, 710);
        t.s.handle(frame(&["KeyW"]), t.at(720));
        assert_eq!(refused(&t).not_allowed, 1);
    }

    fn text(t: &mut T, s: &str, del: u32, ms: u64) -> Vec<Reply> {
        t.s.handle(Request::Text { s: s.into(), del }, t.at(ms))
    }
    fn code(out: &[Reply]) -> Option<&'static str> {
        out.iter().find_map(|r| if let Reply::Error { code, .. } = r { Some(*code) } else { None })
    }

    #[test]
    fn typing_goes_where_the_keyboard_may_go() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.front(Some(win(&abs("notepad.exe"))));
        assert_eq!(code(&text(&mut t, "hi", 0, 5)), Some("not-typed"), "not enabled yet");
        t.s.handle(Request::Enable { on: true }, t.at(10));
        assert_eq!(code(&text(&mut t, "hi", 0, 20)), Some("not-typed"), "not allowed");
        desktop(&mut t, true, true, true, 30);
        assert!(code(&text(&mut t, "héllo 👋\n", 2, 40)).is_none());
        assert_eq!(t.take(), ["t2:héllo 👋\n"]);
        // a mouse-only whole PC doesn't type
        desktop(&mut t, true, false, true, 50);
        assert_eq!(code(&text(&mut t, "x", 0, 60)), Some("not-typed"));
        t.s.handle(Request::Pause { on: true }, t.at(70));
        assert_eq!(code(&text(&mut t, "x", 0, 80)), Some("not-typed"));
        assert!(t.take().is_empty());
    }

    #[test]
    fn typing_is_refused_over_a_held_modifier_and_when_malformed_or_too_fast() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.s.handle(Request::Enable { on: true }, t.at(0));
        t.front(Some(win(&abs("notepad.exe"))));
        desktop(&mut t, true, true, true, 0);
        t.s.handle(frame(&["ControlLeft"]), t.at(10));
        t.take();
        assert_eq!(code(&text(&mut t, "a", 0, 20)), Some("keys-held"));
        t.s.handle(frame(&[]), t.at(30));
        t.take();
        assert_eq!(code(&text(&mut t, "a\u{1b}b", 0, 40)), Some("bad-text"), "Escape is a key, not text");
        assert_eq!(code(&text(&mut t, &"x".repeat(257), 0, 50)), Some("bad-text"));
        assert_eq!(code(&text(&mut t, "", 300, 60)), Some("bad-text"));
        assert_eq!(code(&text(&mut t, "", 0, 70)), Some("bad-text"));
        assert!(t.take().is_empty());
        // A burst inside one rate window (the refused "a" above opened the previous one, at 20 ms).
        let mut too_fast = 0;
        for i in 0..60 {
            if code(&text(&mut t, "k", 0, 2000 + i)) == Some("text-rate") {
                too_fast += 1;
            }
        }
        assert_eq!(too_fast, 60 - MAX_TEXTS_PER_SEC as usize);
        assert_eq!(t.take().len(), MAX_TEXTS_PER_SEC as usize);
        assert_eq!(refused(&t).rate, 60 - MAX_TEXTS_PER_SEC as u64);
    }

    #[test]
    fn the_status_says_when_a_text_field_has_the_focus() {
        let mut t = T::new();
        t.s.handle(Request::Hello { v: 1 }, t.at(0));
        t.front(Some(win(&abs("notepad.exe"))));
        *t.focus.borrow_mut() = Some(TextFocus::Text);
        let out = t.s.poll(t.at(60));
        assert!(out.iter().any(|r| matches!(r, Reply::Status { text: Some(TextFocus::Text), .. })), "{out:?}");
        *t.focus.borrow_mut() = Some(TextFocus::Secret);
        let out = t.s.poll(t.at(120));
        assert!(out.iter().any(|r| matches!(r, Reply::Status { text: Some(TextFocus::Secret), .. })), "{out:?}");
        *t.focus.borrow_mut() = None;
        assert!(t.s.poll(t.at(180)).iter().any(|r| matches!(r, Reply::Status { text: None, .. })));
    }
}
