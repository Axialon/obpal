//! The panic hotkey: a system-wide RegisterHotKey on its own thread. Pressing it releases everything the
//! helper holds and stops injection until the extension's Resume.

use std::sync::mpsc;
use std::thread;

use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_BACK};
use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

pub const PANIC_HOTKEY: &str = "Ctrl+Alt+Backspace";
const HOTKEY_ID: i32 = 1;

/// Register the hotkey on a message-loop thread. Returns its name when registered, None when another
/// program owns the combination (the helper still runs; the extension shows that there is no panic key).
pub fn start(on_panic: impl Fn() + Send + 'static) -> Option<String> {
    let (ready_tx, ready_rx) = mpsc::channel::<bool>();
    thread::Builder::new()
        .name("panic-hotkey".into())
        .spawn(move || {
            let ok = unsafe { RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_BACK.0 as u32) }.is_ok();
            ready_tx.send(ok).ok();
            if !ok {
                return;
            }
            let mut msg = MSG::default();
            while unsafe { GetMessageW(&mut msg, None, 0, 0) }.as_bool() {
                if msg.message == WM_HOTKEY && msg.wParam.0 == HOTKEY_ID as usize {
                    on_panic();
                }
            }
        })
        .ok()?;
    ready_rx.recv().ok().filter(|ok| *ok).map(|_| PANIC_HOTKEY.to_string())
}
