//! Native messaging codec and the messages exchanged with the extension.
//!
//! Chrome Native Messaging frames every message as a native-endian u32 byte length followed by UTF-8 JSON.
//! The extension is the only peer (Chrome launches the helper and owns both pipes). Every message is parsed
//! into a typed request; anything malformed is answered with an `error` and otherwise ignored.
//!
//! Extension → helper: `hello`, `enable`, `f` (an action frame), `release`, `allow`, `scope`, `forget`,
//! `pause`, `resume`, `stats`.  Helper → extension: `hello`, `config`, `status`, `stats`, `error`.
//! See spec/PROTOCOL.md § Native messaging frames.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io::{self, Read, Write};

use crate::keys::{lookup, KeyDef};

/// Protocol version spoken by this helper.
pub const PROTO: u32 = 1;
/// Largest message accepted from the extension. Frames are a few hundred bytes; anything bigger is hostile or broken.
pub const MAX_IN: usize = 64 * 1024;
/// Chrome refuses messages from a native host above 1 MB.
pub const MAX_OUT: usize = 1024 * 1024;

/// Held keys per frame. More than this cannot come from a controller mapping.
pub const MAX_KEYS: usize = 16;
/// Mouse buttons: 0 left, 1 middle, 2 right, 3 back (X1), 4 forward (X2).
pub const MAX_BUTTON: u8 = 4;
/// Relative mouse motion per frame, px. At 60 Hz this is still 120 000 px/s.
pub const MAX_MOVE: i32 = 2000;
/// Wheel per frame, in 1/120 notch units (20 notches).
pub const MAX_WHEEL: i32 = 20 * 120;

// ---- codec ---------------------------------------------------------------------------------------

/// Read one length-prefixed message. `Ok(None)` at a clean EOF (the browser closed the port).
pub fn read_message<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n > MAX_IN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("message of {n} bytes exceeds {MAX_IN}")));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Write one length-prefixed message and flush it.
pub fn write_message<W: Write>(w: &mut W, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > MAX_OUT {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message exceeds Chrome's 1 MB limit"));
    }
    w.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    w.write_all(bytes)?;
    w.flush()
}

// ---- extension → helper --------------------------------------------------------------------------

/// A mouse button as the extension names it (MouseEvent.button order, then X1/X2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MouseButton(pub u8);

#[allow(dead_code)]
impl MouseButton {
    pub const LEFT: MouseButton = MouseButton(0);
    pub const MIDDLE: MouseButton = MouseButton(1);
    pub const RIGHT: MouseButton = MouseButton(2);
}

/// One action frame: the *whole* desired state of the keyboard and mouse buttons (never edges), plus this
/// frame's relative motion. The helper diffs `k`/`b` against what it holds, so a lost or refused frame is
/// repaired by the next one and nothing can stay stuck on a missed edge. A missing list means "nothing held".
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    /// Held keys, by KeyboardEvent.code (`KeyW`, `Space`, `ArrowUp`, ...): the helper's key table.
    #[serde(default)]
    pub k: Vec<String>,
    /// Held mouse buttons.
    #[serde(default)]
    pub b: Vec<u8>,
    /// Relative mouse motion this frame, px, +x right, +y down.
    #[serde(default)]
    pub m: Option<[i32; 2]>,
    /// Wheel this frame in 1/120 notch units, DOM convention: [deltaX, deltaY], +y scrolls down.
    #[serde(default)]
    pub w: Option<[i32; 2]>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Request {
    Hello {
        #[serde(default)]
        v: u32,
    },
    /// Arm or disarm injection. Off at start; disarming releases everything.
    Enable { on: bool },
    #[serde(rename = "f")]
    Frame(Frame),
    /// Release every held key and button now.
    Release,
    /// Allow a program the helper has seen in the foreground, with a scope.
    Allow {
        path: String,
        #[serde(default = "yes")]
        keyboard: bool,
        #[serde(default = "yes")]
        mouse: bool,
    },
    /// Change the scope of an allowed program.
    Scope { path: String, keyboard: bool, mouse: bool },
    /// Remove a program from the allowlist.
    Forget { path: String },
    /// Pause or resume all injection (persisted).
    Pause { on: bool },
    /// Clear a panic stop (a person clicked Resume in the extension).
    Resume,
    Stats,
}

fn yes() -> bool {
    true
}

/// Parse a request. Unknown `t` values and unknown fields on frames are errors: there is nothing the
/// extension could legitimately send that this helper does not know.
pub fn parse_request(bytes: &[u8]) -> Result<Request, String> {
    serde_json::from_slice::<Request>(bytes).map_err(|e| e.to_string())
}

/// A frame after validation against the key table and the per-frame limits.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Validated {
    pub keys: BTreeSet<&'static KeyDef>,
    pub buttons: BTreeSet<MouseButton>,
    pub dx: i32,
    pub dy: i32,
    pub wheel_x: i32,
    pub wheel_y: i32,
}

#[cfg_attr(not(test), allow(dead_code))]
impl Validated {
    pub fn has_motion(&self) -> bool {
        self.dx != 0 || self.dy != 0 || self.wheel_x != 0 || self.wheel_y != 0
    }
}

/// Validate a frame: every key must be in the allowlisted key table, buttons must be known, and motion
/// is clamped. A frame with an unknown key is rejected as a whole (it did not come from our mapping).
pub fn validate(frame: &Frame) -> Result<Validated, String> {
    if frame.k.len() > MAX_KEYS {
        return Err(format!("{} keys held, at most {MAX_KEYS}", frame.k.len()));
    }
    if frame.b.len() > (MAX_BUTTON as usize) + 1 {
        return Err(format!("{} buttons held", frame.b.len()));
    }
    let mut v = Validated::default();
    for code in &frame.k {
        match lookup(code) {
            Some(def) => {
                v.keys.insert(def);
            }
            None => return Err(format!("unknown key {code:?}")),
        }
    }
    for &b in &frame.b {
        if b > MAX_BUTTON {
            return Err(format!("unknown mouse button {b}"));
        }
        v.buttons.insert(MouseButton(b));
    }
    if let Some([dx, dy]) = frame.m {
        v.dx = dx.clamp(-MAX_MOVE, MAX_MOVE);
        v.dy = dy.clamp(-MAX_MOVE, MAX_MOVE);
    }
    if let Some([wx, wy]) = frame.w {
        v.wheel_x = wx.clamp(-MAX_WHEEL, MAX_WHEEL);
        v.wheel_y = wy.clamp(-MAX_WHEEL, MAX_WHEEL);
    }
    Ok(v)
}

// ---- helper → extension --------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Caps {
    pub keyboard: bool,
    pub mouse: bool,
    /// A virtual gamepad needs a driver (ViGEmBus is archived); the scope model is ready for it, the helper is not.
    pub gamepad: bool,
}

/// The kinds of input a program may receive. `gamepad` is reserved (see `Caps`).
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Scope {
    pub keyboard: bool,
    pub mouse: bool,
    #[serde(default)]
    pub gamepad: bool,
}

impl Scope {
    pub fn any(&self) -> bool {
        self.keyboard || self.mouse || self.gamepad
    }
}

/// An allowlisted program as persisted and as reported.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProgramEntry {
    /// Full image path; the identity (compared case-insensitively on Windows).
    pub path: String,
    /// File name, for display.
    pub name: String,
    #[serde(flatten)]
    pub scope: Scope,
}

/// A program as seen in the foreground.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ProgramInfo {
    pub name: String,
    pub path: String,
    pub title: String,
    pub pid: u32,
    /// Runs at a higher integrity level than the helper: UIPI would drop our input silently.
    pub elevated: bool,
    /// It is the browser that launched the helper (the extension's own input path covers it).
    pub browser: bool,
    /// Its scope when allowed, else null.
    pub allowed: Option<Scope>,
}

/// Why frames were not injected, as counters.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    pub not_enabled: u64,
    pub paused: u64,
    pub panic: u64,
    pub not_allowed: u64,
    pub elevated: u64,
    pub no_window: u64,
    pub rate: u64,
    pub invalid: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Reply {
    Hello {
        v: u32,
        version: &'static str,
        os: &'static str,
        /// The panic hotkey as registered, or null when it could not be registered.
        hotkey: Option<String>,
        caps: Caps,
    },
    Config {
        paused: bool,
        programs: Vec<ProgramEntry>,
    },
    Status {
        enabled: bool,
        panic: bool,
        /// Something is held down right now.
        held: bool,
        /// The window in front now (may be the browser), if any.
        front: Option<ProgramInfo>,
        /// The most recent foreground program that is not the browser: what "Allow this program" refers to.
        program: Option<ProgramInfo>,
    },
    Stats {
        frames: u64,
        injected: u64,
        refused: Refused,
    },
    Error {
        code: &'static str,
        msg: String,
    },
}

impl Reply {
    pub fn error(code: &'static str, msg: impl Into<String>) -> Reply {
        Reply::Error { code, msg: msg.into() }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("replies serialize")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn codec_round_trips_and_stops_at_eof() {
        let mut buf = Vec::new();
        write_message(&mut buf, br#"{"t":"hello","v":1}"#).unwrap();
        write_message(&mut buf, br#"{"t":"stats"}"#).unwrap();
        assert_eq!(&buf[..4], &19u32.to_ne_bytes());
        let mut r = Cursor::new(buf);
        assert_eq!(read_message(&mut r).unwrap().unwrap(), br#"{"t":"hello","v":1}"#);
        assert_eq!(read_message(&mut r).unwrap().unwrap(), br#"{"t":"stats"}"#);
        assert!(read_message(&mut r).unwrap().is_none());
    }

    #[test]
    fn codec_rejects_oversized_and_truncated_messages() {
        let mut big = Vec::from((MAX_IN as u32 + 1).to_ne_bytes());
        big.extend(std::iter::repeat(b' ').take(8));
        assert_eq!(read_message(&mut Cursor::new(big)).unwrap_err().kind(), io::ErrorKind::InvalidData);
        let mut cut = Vec::from(10u32.to_ne_bytes());
        cut.extend_from_slice(b"{}");
        assert!(read_message(&mut Cursor::new(cut)).is_err());
        let mut out = Vec::new();
        assert!(write_message(&mut out, &vec![b'x'; MAX_OUT + 1]).is_err());
    }

    #[test]
    fn parses_every_request_and_rejects_the_rest() {
        assert_eq!(parse_request(br#"{"t":"hello","v":1}"#).unwrap(), Request::Hello { v: 1 });
        assert_eq!(parse_request(br#"{"t":"hello"}"#).unwrap(), Request::Hello { v: 0 });
        assert_eq!(parse_request(br#"{"t":"enable","on":true}"#).unwrap(), Request::Enable { on: true });
        assert_eq!(parse_request(br#"{"t":"release"}"#).unwrap(), Request::Release);
        assert_eq!(
            parse_request(br#"{"t":"allow","path":"C:\\Games\\a.exe"}"#).unwrap(),
            Request::Allow { path: "C:\\Games\\a.exe".into(), keyboard: true, mouse: true }
        );
        assert_eq!(
            parse_request(br#"{"t":"scope","path":"x","keyboard":false,"mouse":true}"#).unwrap(),
            Request::Scope { path: "x".into(), keyboard: false, mouse: true }
        );
        assert_eq!(parse_request(br#"{"t":"forget","path":"x"}"#).unwrap(), Request::Forget { path: "x".into() });
        assert_eq!(parse_request(br#"{"t":"pause","on":false}"#).unwrap(), Request::Pause { on: false });
        assert_eq!(parse_request(br#"{"t":"resume"}"#).unwrap(), Request::Resume);
        assert_eq!(parse_request(br#"{"t":"stats"}"#).unwrap(), Request::Stats);
        let f = parse_request(br#"{"t":"f","k":["KeyW"],"b":[0],"m":[3,-2],"w":[0,120]}"#).unwrap();
        assert_eq!(f, Request::Frame(Frame { k: vec!["KeyW".into()], b: vec![0], m: Some([3, -2]), w: Some([0, 120]) }));
        assert_eq!(parse_request(br#"{"t":"f"}"#).unwrap(), Request::Frame(Frame::default()));
        for bad in [
            &br#"{"t":"exec","cmd":"calc"}"#[..],
            br#"{"t":"f","keys":["KeyW"]}"#,
            br#"{"t":"f","k":"KeyW"}"#,
            br#"{"t":"f","m":[1]}"#,
            br#"{"t":"f","m":[1,2,3]}"#,
            br#"{"t":"f","m":[1.5,2]}"#,
            br#"{"t":"scope","path":"x"}"#,
            br#"[]"#,
            b"nope",
            b"",
        ] {
            assert!(parse_request(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn validates_frames_against_the_key_table_and_limits() {
        let ok = validate(&Frame { k: vec!["KeyW".into(), "ShiftLeft".into()], b: vec![0, 2], m: Some([5000, -3]), w: Some([0, 99999]) }).unwrap();
        assert_eq!(ok.keys.iter().map(|k| k.code).collect::<Vec<_>>(), ["KeyW", "ShiftLeft"]);
        assert_eq!(ok.buttons, [MouseButton::LEFT, MouseButton::RIGHT].into_iter().collect());
        assert_eq!((ok.dx, ok.dy, ok.wheel_x, ok.wheel_y), (MAX_MOVE, -3, 0, MAX_WHEEL));
        assert!(ok.has_motion());
        assert!(!validate(&Frame::default()).unwrap().has_motion());
        // Never raw key sequences: only table keys.
        assert!(validate(&Frame { k: vec!["MetaLeft".into()], ..Default::default() }).is_err());
        assert!(validate(&Frame { k: vec!["w".into()], ..Default::default() }).is_err());
        assert!(validate(&Frame { k: vec!["".into()], ..Default::default() }).is_err());
        assert!(validate(&Frame { b: vec![5], ..Default::default() }).is_err());
        assert!(validate(&Frame { k: (0..MAX_KEYS + 1).map(|_| "KeyA".to_string()).collect(), ..Default::default() }).is_err());
        assert!(validate(&Frame { b: vec![0; 6], ..Default::default() }).is_err());
    }

    #[test]
    fn replies_serialize_with_tags() {
        let r = Reply::Status { enabled: true, panic: false, held: false, front: None, program: None };
        assert_eq!(String::from_utf8(r.to_bytes()).unwrap(), r#"{"t":"status","enabled":true,"panic":false,"held":false,"front":null,"program":null}"#);
        let e = Reply::error("bad-frame", "x");
        assert_eq!(String::from_utf8(e.to_bytes()).unwrap(), r#"{"t":"error","code":"bad-frame","msg":"x"}"#);
        let s = Reply::Stats { frames: 1, injected: 0, refused: Refused { not_allowed: 1, ..Default::default() } };
        assert!(String::from_utf8(s.to_bytes()).unwrap().contains(r#""notAllowed":1"#));
        let c = Reply::Config { paused: false, programs: vec![ProgramEntry { path: "p".into(), name: "n".into(), scope: Scope { keyboard: true, mouse: false, gamepad: false } }] };
        assert_eq!(String::from_utf8(c.to_bytes()).unwrap(), r#"{"t":"config","paused":false,"programs":[{"path":"p","name":"n","keyboard":true,"mouse":false,"gamepad":false}]}"#);
    }
}
