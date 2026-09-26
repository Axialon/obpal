//! The allowlisted key table: every key the helper can press, named by `KeyboardEvent.code` (the physical
//! key, as the extension's Keys mapping names it), with its PC/AT set-1 scan code.
//!
//! Only keys in this table are ever injected. The phone never sends key names; the extension maps controller
//! state to these names host-side, and the helper looks each one up. Keys that are unsafe to press blind are
//! left out on purpose: the OS keys (Meta), the context-menu key, lock keys, PrintScreen, Pause, Sleep,
//! Power, and the media and browser keys.
//!
//! Injection sends the scan code with the virtual key derived from it through the active keyboard layout,
//! so `KeyW` is the physical W key on every layout, as `KeyboardEvent.code` promises.

/// A key the helper may press.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KeyDef {
    /// `KeyboardEvent.code` name.
    pub code: &'static str,
    /// Set-1 make code (without the 0xE0 prefix).
    pub scan: u16,
    /// Needs the 0xE0 prefix (KEYEVENTF_EXTENDEDKEY).
    pub extended: bool,
    /// Windows virtual-key code used when the layout cannot map the scan code.
    pub vk: u16,
    /// Shift, Control or Alt: pressed before and released after other keys.
    pub modifier: bool,
}

const fn k(code: &'static str, scan: u16, vk: u16) -> KeyDef {
    KeyDef { code, scan, extended: false, vk, modifier: false }
}
const fn e(code: &'static str, scan: u16, vk: u16) -> KeyDef {
    KeyDef { code, scan, extended: true, vk, modifier: false }
}
const fn m(code: &'static str, scan: u16, vk: u16, extended: bool) -> KeyDef {
    KeyDef { code, scan, extended, vk, modifier: true }
}

/// Every injectable key. Sorted by `code` at test time so lookups can stay a linear scan of a small table.
pub static TABLE: &[KeyDef] = &[
    // letters
    k("KeyA", 0x1E, 0x41), k("KeyB", 0x30, 0x42), k("KeyC", 0x2E, 0x43), k("KeyD", 0x20, 0x44),
    k("KeyE", 0x12, 0x45), k("KeyF", 0x21, 0x46), k("KeyG", 0x22, 0x47), k("KeyH", 0x23, 0x48),
    k("KeyI", 0x17, 0x49), k("KeyJ", 0x24, 0x4A), k("KeyK", 0x25, 0x4B), k("KeyL", 0x26, 0x4C),
    k("KeyM", 0x32, 0x4D), k("KeyN", 0x31, 0x4E), k("KeyO", 0x18, 0x4F), k("KeyP", 0x19, 0x50),
    k("KeyQ", 0x10, 0x51), k("KeyR", 0x13, 0x52), k("KeyS", 0x1F, 0x53), k("KeyT", 0x14, 0x54),
    k("KeyU", 0x16, 0x55), k("KeyV", 0x2F, 0x56), k("KeyW", 0x11, 0x57), k("KeyX", 0x2D, 0x58),
    k("KeyY", 0x15, 0x59), k("KeyZ", 0x2C, 0x5A),
    // digits
    k("Digit1", 0x02, 0x31), k("Digit2", 0x03, 0x32), k("Digit3", 0x04, 0x33), k("Digit4", 0x05, 0x34),
    k("Digit5", 0x06, 0x35), k("Digit6", 0x07, 0x36), k("Digit7", 0x08, 0x37), k("Digit8", 0x09, 0x38),
    k("Digit9", 0x0A, 0x39), k("Digit0", 0x0B, 0x30),
    // whitespace and editing
    k("Space", 0x39, 0x20), k("Enter", 0x1C, 0x0D), k("Escape", 0x01, 0x1B), k("Tab", 0x0F, 0x09),
    k("Backspace", 0x0E, 0x08), e("Insert", 0x52, 0x2D), e("Delete", 0x53, 0x2E),
    e("Home", 0x47, 0x24), e("End", 0x4F, 0x23), e("PageUp", 0x49, 0x21), e("PageDown", 0x51, 0x22),
    // arrows
    e("ArrowUp", 0x48, 0x26), e("ArrowDown", 0x50, 0x28), e("ArrowLeft", 0x4B, 0x25), e("ArrowRight", 0x4D, 0x27),
    // modifiers
    m("ShiftLeft", 0x2A, 0xA0, false), m("ShiftRight", 0x36, 0xA1, false),
    m("ControlLeft", 0x1D, 0xA2, false), m("ControlRight", 0x1D, 0xA3, true),
    m("AltLeft", 0x38, 0xA4, false), m("AltRight", 0x38, 0xA5, true),
    // punctuation (US positions; the layout decides the character)
    k("Minus", 0x0C, 0xBD), k("Equal", 0x0D, 0xBB), k("BracketLeft", 0x1A, 0xDB), k("BracketRight", 0x1B, 0xDD),
    k("Semicolon", 0x27, 0xBA), k("Quote", 0x28, 0xDE), k("Backquote", 0x29, 0xC0), k("Backslash", 0x2B, 0xDC),
    k("Comma", 0x33, 0xBC), k("Period", 0x34, 0xBE), k("Slash", 0x35, 0xBF), k("IntlBackslash", 0x56, 0xE2),
    // function keys
    k("F1", 0x3B, 0x70), k("F2", 0x3C, 0x71), k("F3", 0x3D, 0x72), k("F4", 0x3E, 0x73), k("F5", 0x3F, 0x74),
    k("F6", 0x40, 0x75), k("F7", 0x41, 0x76), k("F8", 0x42, 0x77), k("F9", 0x43, 0x78), k("F10", 0x44, 0x79),
    k("F11", 0x57, 0x7A), k("F12", 0x58, 0x7B),
    // numpad
    k("Numpad0", 0x52, 0x60), k("Numpad1", 0x4F, 0x61), k("Numpad2", 0x50, 0x62), k("Numpad3", 0x51, 0x63),
    k("Numpad4", 0x4B, 0x64), k("Numpad5", 0x4C, 0x65), k("Numpad6", 0x4D, 0x66), k("Numpad7", 0x47, 0x67),
    k("Numpad8", 0x48, 0x68), k("Numpad9", 0x49, 0x69), k("NumpadDecimal", 0x53, 0x6E),
    k("NumpadAdd", 0x4E, 0x6B), k("NumpadSubtract", 0x4A, 0x6D), k("NumpadMultiply", 0x37, 0x6A),
    e("NumpadDivide", 0x35, 0x6F), e("NumpadEnter", 0x1C, 0x0D),
];

/// Find a key by its `KeyboardEvent.code`. Exact match only: `keyw` or `w` is not a key.
pub fn lookup(code: &str) -> Option<&'static KeyDef> {
    TABLE.iter().find(|k| k.code == code)
}

/// Keys deliberately not in the table.
#[cfg_attr(not(test), allow(dead_code))]
pub const FORBIDDEN: &[&str] = &[
    "MetaLeft", "MetaRight", "OSLeft", "OSRight", "ContextMenu", "CapsLock", "NumLock", "ScrollLock",
    "PrintScreen", "Pause", "Power", "Sleep", "WakeUp", "MediaPlayPause", "AudioVolumeMute", "BrowserHome",
    "LaunchApp1", "Fn", "Lang1", "Convert", "KanaMode",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn codes_are_unique_and_scan_codes_unique_per_prefix() {
        let mut codes = HashSet::new();
        let mut scans = HashSet::new();
        for k in TABLE {
            assert!(codes.insert(k.code), "duplicate code {}", k.code);
            assert!(scans.insert((k.scan, k.extended)), "duplicate scan code for {}", k.code);
            assert!(k.scan != 0 && k.scan < 0x80, "{} has an implausible scan code", k.code);
            assert!(k.vk != 0, "{} has no virtual key", k.code);
        }
    }

    #[test]
    fn covers_every_key_the_extension_mapping_can_name() {
        // extension/src/shared/keys.ts KEYS table. Add here when a row is added there.
        for code in [
            "KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ", "KeyR", "KeyF", "KeyC", "KeyX", "KeyZ",
            "Digit1", "Digit2", "Digit3", "Digit4", "Space", "Enter", "Escape", "Tab", "Backspace",
            "ShiftLeft", "ControlLeft", "AltLeft", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        ] {
            assert!(lookup(code).is_some(), "{code} missing from the helper key table");
        }
    }

    #[test]
    fn extended_keys_and_modifiers_are_flagged() {
        for code in ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Insert", "Delete", "Home", "End", "PageUp", "PageDown", "ControlRight", "AltRight", "NumpadEnter", "NumpadDivide"] {
            assert!(lookup(code).unwrap().extended, "{code} needs the E0 prefix");
        }
        for code in ["KeyW", "Numpad8", "Numpad4", "Enter", "ShiftRight"] {
            assert!(!lookup(code).unwrap().extended, "{code} is not extended");
        }
        let mods: Vec<_> = TABLE.iter().filter(|k| k.modifier).map(|k| k.code).collect();
        assert_eq!(mods, ["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight"]);
        assert_eq!(lookup("ArrowUp").unwrap().scan, lookup("Numpad8").unwrap().scan);
    }

    #[test]
    fn dangerous_keys_are_not_injectable() {
        for code in FORBIDDEN {
            assert!(lookup(code).is_none(), "{code} must not be injectable");
        }
        assert!(lookup("keyw").is_none());
        assert!(lookup("w").is_none());
        assert!(lookup("KeyW ").is_none());
    }

    #[test]
    fn well_known_scan_codes() {
        let sc = |c: &str| lookup(c).unwrap().scan;
        assert_eq!((sc("KeyW"), sc("KeyA"), sc("KeyS"), sc("KeyD")), (0x11, 0x1E, 0x1F, 0x20));
        assert_eq!((sc("Space"), sc("Escape"), sc("Enter")), (0x39, 0x01, 0x1C));
        assert_eq!((sc("ArrowUp"), sc("ArrowLeft"), sc("ArrowRight"), sc("ArrowDown")), (0x48, 0x4B, 0x4D, 0x50));
        assert_eq!(lookup("KeyW").unwrap().vk, 0x57);
    }
}
