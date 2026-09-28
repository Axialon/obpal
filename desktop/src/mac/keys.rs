//! KeyboardEvent.code to macOS virtual key codes (HIToolbox Events.h).

pub const SHIFT: u64 = 1 << 17;
pub const CONTROL: u64 = 1 << 18;
pub const OPTION: u64 = 1 << 19;
pub const COMMAND: u64 = 1 << 20;

/// Whole-PC gamepad navigation uses Mac chords; per-program game mappings stay physical.
pub fn desktop_chord(code: &str, flags: u64) -> Option<(u16, u64)> {
    match code {
        "Tab" if flags == OPTION => Some((48, COMMAND)),
        "ArrowLeft" if flags == OPTION => Some((33, COMMAND)),
        "ArrowRight" if flags == OPTION => Some((30, COMMAND)),
        "Escape" if flags == COMMAND || flags == CONTROL => Some((49, COMMAND)),
        _ => None,
    }
}

/// Ctrl mappings become Command by default; games can choose physical Control instead.
pub fn lookup(code: &str, ctrl_to_cmd: bool) -> Option<(u16, u64)> {
    let key = match code {
        "ControlLeft" => return Some(if ctrl_to_cmd { (55, COMMAND) } else { (59, CONTROL) }),
        "ControlRight" => return Some(if ctrl_to_cmd { (54, COMMAND) } else { (62, CONTROL) }),
        "ShiftLeft" => return Some((56, SHIFT)),
        "ShiftRight" => return Some((60, SHIFT)),
        "AltLeft" => return Some((58, OPTION)),
        "AltRight" => return Some((61, OPTION)),
        "KeyA" => 0, "KeyS" => 1, "KeyD" => 2, "KeyF" => 3, "KeyH" => 4, "KeyG" => 5,
        "KeyZ" => 6, "KeyX" => 7, "KeyC" => 8, "KeyV" => 9, "IntlBackslash" => 10, "KeyB" => 11,
        "KeyQ" => 12, "KeyW" => 13, "KeyE" => 14, "KeyR" => 15, "KeyY" => 16, "KeyT" => 17,
        "Digit1" => 18, "Digit2" => 19, "Digit3" => 20, "Digit4" => 21, "Digit6" => 22, "Digit5" => 23,
        "Equal" => 24, "Digit9" => 25, "Digit7" => 26, "Minus" => 27, "Digit8" => 28, "Digit0" => 29,
        "BracketRight" => 30, "KeyO" => 31, "KeyU" => 32, "BracketLeft" => 33, "KeyI" => 34, "KeyP" => 35,
        "Enter" => 36, "KeyL" => 37, "KeyJ" => 38, "Quote" => 39, "KeyK" => 40, "Semicolon" => 41,
        "Backslash" => 42, "Comma" => 43, "Slash" => 44, "KeyN" => 45, "KeyM" => 46, "Period" => 47,
        "Tab" => 48, "Space" => 49, "Backquote" => 50, "Backspace" => 51, "Escape" => 53,
        "NumpadDecimal" => 65, "NumpadMultiply" => 67, "NumpadAdd" => 69, "NumpadDivide" => 75,
        "NumpadEnter" => 76, "NumpadSubtract" => 78, "Numpad0" => 82, "Numpad1" => 83,
        "Numpad2" => 84, "Numpad3" => 85, "Numpad4" => 86, "Numpad5" => 87, "Numpad6" => 88,
        "Numpad7" => 89, "Numpad8" => 91, "Numpad9" => 92,
        "F1" => 122, "F2" => 120, "F3" => 99, "F4" => 118, "F5" => 96, "F6" => 97,
        "F7" => 98, "F8" => 100, "F9" => 101, "F10" => 109, "F11" => 103, "F12" => 111,
        "Insert" => 114, "Home" => 115, "PageUp" => 116, "Delete" => 117, "End" => 119, "PageDown" => 121,
        "ArrowLeft" => 123, "ArrowRight" => 124, "ArrowDown" => 125, "ArrowUp" => 126,
        _ => return None,
    };
    Some((key, 0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_the_shared_table_without_aliases_or_forbidden_keys() {
        for command in [true, false] {
            let mut seen = std::collections::HashSet::new();
            for key in crate::keys::TABLE {
                let (vk, flag) = lookup(key.code, command).expect(key.code);
                assert!(seen.insert(vk), "duplicate: {}", key.code);
                assert_eq!(flag != 0, key.modifier);
            }
            for key in crate::keys::FORBIDDEN { assert_eq!(lookup(key, command), None); }
        }
        assert_eq!(lookup("ControlLeft", true), Some((55, COMMAND)));
        assert_eq!(lookup("ControlRight", false), Some((62, CONTROL)));
        assert_eq!(lookup("Backspace", true), Some((51, 0)));
        assert_eq!(lookup("Delete", true), Some((117, 0)));
    }

    #[test]
    fn desktop_navigation_uses_mac_shortcuts() {
        assert_eq!(desktop_chord("Tab", OPTION), Some((48, COMMAND)));
        assert_eq!(desktop_chord("ArrowLeft", OPTION), Some((33, COMMAND)));
        assert_eq!(desktop_chord("ArrowRight", OPTION), Some((30, COMMAND)));
        for control in [COMMAND, CONTROL] { assert_eq!(desktop_chord("Escape", control), Some((49, COMMAND))); }
        assert_eq!(desktop_chord("KeyA", OPTION), None);
        assert_eq!(desktop_chord("ArrowLeft", OPTION | SHIFT), None);
    }
}
