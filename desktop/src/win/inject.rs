//! Keyboard and mouse injection with `SendInput`.
//!
//! Keys are sent as scan code + virtual key. The scan code is the physical key from the table (what
//! `KeyboardEvent.code` names); the virtual key is derived from it through the active layout, so games that
//! read scan codes (DirectInput, raw input) and programs that read virtual keys agree on the key. Extended
//! keys carry the E0 prefix flag. Mouse motion is relative (`MOUSEEVENTF_MOVE`), the path games with raw
//! input expect; buttons and the wheel use their own flags.
//!
//! Typing (`text` requests) sends characters, not keys: each UTF-16 code unit as a `KEYEVENTF_UNICODE` press
//! and release, which Windows delivers as that character whatever the keyboard layout. Deleting is Backspace,
//! and newline and tab are the Enter and Tab keys, which programs act on as keys rather than as characters.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use windows::Win32::Foundation::GetLastError;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MAPVK_VSC_TO_VK_EX, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE_NOCOALESCE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};

use crate::keys::{lookup, KeyDef};
use crate::protocol::MouseButton;
use crate::session::Injector;

/// Tag on every injected event (GetMessageExtraInfo), so a hook could tell our input from a person's.
pub const EXTRA_INFO: usize = 0x0B9A_1001;

const XBUTTON1: u32 = 1;
const XBUTTON2: u32 = 2;

/// Most events in one SendInput call while typing. A call is never interleaved with other input, so a long text
/// goes in several, split between characters: a person's own keys may come between two characters, never inside one.
pub const TYPING_CHUNK: usize = 64;

pub struct WinInjector;

/// Virtual key for a table key under the current layout, else the table's US fallback.
pub fn virtual_key(key: &KeyDef) -> u16 {
    let code = if key.extended { 0xE000 | key.scan as u32 } else { key.scan as u32 };
    let vk = unsafe { MapVirtualKeyW(code, MAPVK_VSC_TO_VK_EX) };
    if vk == 0 { key.vk } else { vk as u16 }
}

pub fn key_input(key: &KeyDef, down: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if key.extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(virtual_key(key)), wScan: key.scan, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO },
        },
    }
}

fn mouse_input(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO } },
    }
}

/// Button flags and X-button data for a button edge, or None for a button Windows does not have.
pub fn button_input(button: MouseButton, down: bool) -> Option<INPUT> {
    let (flags, data) = match (button.0, down) {
        (0, true) => (MOUSEEVENTF_LEFTDOWN, 0),
        (0, false) => (MOUSEEVENTF_LEFTUP, 0),
        (1, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
        (1, false) => (MOUSEEVENTF_MIDDLEUP, 0),
        (2, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
        (2, false) => (MOUSEEVENTF_RIGHTUP, 0),
        (3, true) => (MOUSEEVENTF_XDOWN, XBUTTON1 as i32),
        (3, false) => (MOUSEEVENTF_XUP, XBUTTON1 as i32),
        (4, true) => (MOUSEEVENTF_XDOWN, XBUTTON2 as i32),
        (4, false) => (MOUSEEVENTF_XUP, XBUTTON2 as i32),
        _ => return None,
    };
    Some(mouse_input(0, 0, data, flags))
}

/// One UTF-16 code unit as a character press or release (`KEYEVENTF_UNICODE`: no virtual key, the unit in the scan code).
pub fn unicode_input(unit: u16, down: bool) -> INPUT {
    let flags = if down { KEYEVENTF_UNICODE } else { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO } },
    }
}

/// The SendInput calls that type one `text` request: Backspace `del` times, then each character of `s`, '\n' as
/// the Enter key, '\t' as the Tab key, anything else as a press and release of each of its UTF-16 units (a
/// surrogate pair's two units one after the other). Calls hold at most `TYPING_CHUNK` events and end between
/// characters.
pub fn typing(del: u32, s: &str) -> Vec<Vec<INPUT>> {
    let key = |code: &str| lookup(code).expect("typing keys are in the table");
    let tap = |k: &KeyDef| vec![key_input(k, true), key_input(k, false)];
    let (backspace, enter, tab) = (key("Backspace"), key("Enter"), key("Tab"));
    let chars = s.chars().map(|c| match c {
        '\n' => tap(enter),
        '\t' => tap(tab),
        c => c.encode_utf16(&mut [0; 2]).iter().flat_map(|&u| [unicode_input(u, true), unicode_input(u, false)]).collect(),
    });
    let mut calls: Vec<Vec<INPUT>> = Vec::new();
    for group in (0..del).map(|_| tap(backspace)).chain(chars) {
        match calls.last_mut() {
            Some(call) if call.len() + group.len() <= TYPING_CHUNK => call.extend(group),
            _ => calls.push(group),
        }
    }
    calls
}

/// SendInput calls that did not deliver every event, and the last Win32 error: UIPI blocks silently, so this
/// is the only trace. Reported in the helper's stop line.
pub static FAILURES: AtomicU64 = AtomicU64::new(0);
pub static LAST_ERROR: AtomicU32 = AtomicU32::new(0);

fn send(inputs: &[INPUT]) -> bool {
    if inputs.is_empty() {
        return true;
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    let ok = sent as usize == inputs.len();
    if !ok {
        FAILURES.fetch_add(1, Ordering::Relaxed);
        LAST_ERROR.store(unsafe { GetLastError() }.0, Ordering::Relaxed);
    }
    ok
}

impl Injector for WinInjector {
    fn key(&mut self, key: &'static KeyDef, down: bool) {
        send(&[key_input(key, down)]);
    }

    fn button(&mut self, button: MouseButton, down: bool) {
        if let Some(i) = button_input(button, down) {
            send(&[i]);
        }
    }

    fn mouse_move(&mut self, dx: i32, dy: i32) {
        send(&[mouse_input(dx, dy, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_MOVE_NOCOALESCE)]);
    }

    fn wheel(&mut self, dx: i32, dy: i32) {
        let mut inputs = Vec::with_capacity(2);
        // DOM +y scrolls down; Windows positive wheel data scrolls up (away from the user).
        if dy != 0 {
            inputs.push(mouse_input(0, 0, -dy, MOUSEEVENTF_WHEEL));
        }
        if dx != 0 {
            inputs.push(mouse_input(0, 0, dx, MOUSEEVENTF_HWHEEL));
        }
        send(&inputs);
    }

    fn text(&mut self, del: u32, s: &str) {
        for call in typing(del, s) {
            // Blocked (UIPI, or another desktop took over): the rest would land somewhere else, if anywhere.
            if !send(&call) {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::lookup;

    #[test]
    fn key_inputs_carry_scan_code_flags_and_a_layout_virtual_key() {
        let w = lookup("KeyW").unwrap();
        let i = key_input(w, true);
        let ki = unsafe { i.Anonymous.ki };
        assert_eq!(i.r#type, INPUT_KEYBOARD);
        assert_eq!(ki.wScan, 0x11);
        assert_eq!(ki.dwFlags, KEYBD_EVENT_FLAGS(0));
        assert!(ki.wVk.0 != 0, "a virtual key is always present");
        let up = unsafe { key_input(lookup("ArrowLeft").unwrap(), false).Anonymous.ki };
        assert_eq!(up.dwFlags, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP);
        assert_eq!(up.wVk, VIRTUAL_KEY(0x25), "VK_LEFT under any layout");
        assert_eq!(unsafe { key_input(lookup("Numpad4").unwrap(), true).Anonymous.ki }.dwFlags, KEYBD_EVENT_FLAGS(0));
    }

    #[test]
    fn button_inputs() {
        let l = unsafe { button_input(MouseButton::LEFT, true).unwrap().Anonymous.mi };
        assert_eq!(l.dwFlags, MOUSEEVENTF_LEFTDOWN);
        let x2 = unsafe { button_input(MouseButton(4), false).unwrap().Anonymous.mi };
        assert_eq!((x2.dwFlags, x2.mouseData), (MOUSEEVENTF_XUP, XBUTTON2));
        assert!(button_input(MouseButton(5), true).is_none());
    }

    /// A typing event as `u<unit>` (a character) or `k<scan>` (a table key), then + for a press, - for a release.
    fn typed(i: &INPUT) -> String {
        let ki = unsafe { i.Anonymous.ki };
        assert_eq!((i.r#type, ki.dwExtraInfo), (INPUT_KEYBOARD, EXTRA_INFO));
        let edge = if ki.dwFlags.contains(KEYEVENTF_KEYUP) { '-' } else { '+' };
        if ki.dwFlags.contains(KEYEVENTF_UNICODE) {
            assert_eq!(ki.wVk, VIRTUAL_KEY(0), "a character has no virtual key");
            format!("u{:04X}{edge}", ki.wScan)
        } else {
            assert!(ki.wVk.0 != 0);
            format!("k{:02X}{edge}", ki.wScan)
        }
    }

    #[test]
    fn typing_deletes_first_then_types_characters_with_enter_and_tab_as_keys() {
        let calls = typing(2, "a€😀\n\t");
        assert_eq!(calls.len(), 1);
        let events: Vec<String> = calls.iter().flatten().map(typed).collect();
        assert_eq!(
            events,
            [
                "k0E+", "k0E-", "k0E+", "k0E-", // Backspace twice
                "u0061+", "u0061-", "u20AC+", "u20AC-", // a, €
                "uD83D+", "uD83D-", "uDE00+", "uDE00-", // 😀, a surrogate pair
                "k1C+", "k1C-", "k0F+", "k0F-", // Enter, Tab
            ]
        );
        assert!(typing(0, "").is_empty());
    }

    #[test]
    fn long_texts_are_split_into_calls_between_characters() {
        let calls = typing(30, &"😀a".repeat(100));
        assert!(calls.len() > 1);
        assert_eq!(calls.iter().map(Vec::len).sum::<usize>(), 30 * 2 + 100 * (4 + 2));
        for call in &calls {
            assert!(!call.is_empty() && call.len() <= TYPING_CHUNK, "{}", call.len());
            let (first, last) = unsafe { (call[0].Anonymous.ki, call[call.len() - 1].Anonymous.ki) };
            assert!(!first.dwFlags.contains(KEYEVENTF_KEYUP) && last.dwFlags.contains(KEYEVENTF_KEYUP), "a press and its release stay together");
            assert!(!(0xDC00..0xE000).contains(&first.wScan), "never starts on a low surrogate");
            assert!(!(0xD800..0xDC00).contains(&last.wScan), "never ends on a high surrogate");
        }
        // The largest request (256 deletions, 256 characters outside the BMP) still types in whole characters.
        let most = typing(256, &"😀".repeat(256));
        assert_eq!(most.iter().map(Vec::len).sum::<usize>(), 256 * 2 + 256 * 4);
        assert!(most.iter().all(|c| c.len() <= TYPING_CHUNK && c.len() % 2 == 0));
    }
}
