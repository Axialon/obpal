//! Keyboard and mouse injection with `SendInput`.
//!
//! Keys are sent as scan code + virtual key. The scan code is the physical key from the table (what
//! `KeyboardEvent.code` names); the virtual key is derived from it through the active layout, so games that
//! read scan codes (DirectInput, raw input) and programs that read virtual keys agree on the key. Extended
//! keys carry the E0 prefix flag. Mouse motion is relative (`MOUSEEVENTF_MOVE`), the path games with raw
//! input expect; buttons and the wheel use their own flags.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use windows::Win32::Foundation::GetLastError;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    MAPVK_VSC_TO_VK_EX, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
    MOUSEEVENTF_MOVE, MOUSEEVENTF_MOVE_NOCOALESCE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP,
    MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};

use crate::keys::KeyDef;
use crate::protocol::MouseButton;
use crate::session::Injector;

/// Tag on every injected event (GetMessageExtraInfo), so a hook could tell our input from a person's.
pub const EXTRA_INFO: usize = 0x0B9A_1001;

const XBUTTON1: u32 = 1;
const XBUTTON2: u32 = 2;

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
}
