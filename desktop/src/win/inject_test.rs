//! Windows integration test: a window created by the test process receives what `WinInjector` sends (keys, and
//! typed text as characters).
//! It needs the interactive desktop: when the window cannot take the foreground (a UAC prompt is up, or
//! the session is not interactive) the test reports that and passes without checking.

use std::cell::RefCell;
use std::time::{Duration, Instant};

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetForegroundWindow, GetWindowThreadProcessId, PeekMessageW,
    RegisterClassW, SetForegroundWindow, ShowWindow, TranslateMessage, MSG, PM_REMOVE, SC_KEYMENU, SW_SHOW, WINDOW_EX_STYLE, WM_CHAR, WM_KEYDOWN,
    WM_KEYUP, WM_SYSCOMMAND, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

use super::inject::WinInjector;
use crate::keys::lookup;
use crate::session::Injector;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Got {
    Down { vk: u32, scan: u32, ext: bool },
    Up { vk: u32 },
    /// A WM_CHAR: one UTF-16 code unit.
    Char(u32),
}

thread_local! {
    static GOT: RefCell<Vec<Got>> = const { RefCell::new(Vec::new()) };
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let lp = l.0 as u32;
    match msg {
        WM_KEYDOWN => GOT.with(|g| g.borrow_mut().push(Got::Down { vk: w.0 as u32, scan: (lp >> 16) & 0xFF, ext: (lp >> 24) & 1 == 1 })),
        WM_KEYUP => GOT.with(|g| g.borrow_mut().push(Got::Up { vk: w.0 as u32 })),
        WM_CHAR => GOT.with(|g| g.borrow_mut().push(Got::Char(w.0 as u32))),
        WM_SYSCOMMAND if (w.0 & 0xFFF0) as u32 == SC_KEYMENU => return LRESULT(0), // never enter menu mode
        _ => {}
    }
    DefWindowProcW(hwnd, msg, w, l)
}

/// Take the foreground without injecting keys: borrow the foreground thread's input right.
unsafe fn take_foreground(hwnd: HWND) -> bool {
    let fg = GetForegroundWindow();
    let me = GetCurrentThreadId();
    let fg_thread = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
    let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(fg_thread, me, true).as_bool();
    let _ = SetForegroundWindow(hwnd);
    let _ = SetFocus(Some(hwnd));
    if attached {
        let _ = AttachThreadInput(fg_thread, me, false);
    }
    GetForegroundWindow() == hwnd
}

fn pump_until(hwnd: HWND, timeout: Duration, done: impl Fn(&[Got]) -> bool) -> Vec<Got> {
    let end = Instant::now() + timeout;
    let mut msg = MSG::default();
    loop {
        unsafe {
            while PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let got = GOT.with(|g| g.borrow().clone());
        if done(&got) || Instant::now() > end {
            return got;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "takes the foreground: cargo test -- --include-ignored"]
fn injected_keys_arrive_in_a_foreground_window() {
    unsafe {
        let hinst = GetModuleHandleW(None).unwrap();
        let class = w!("ObPalInjectTest");
        let wc = WNDCLASSW { lpfnWndProc: Some(wnd_proc), hInstance: hinst.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("ob.Pal inject test"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, Some(hinst.into()), None).unwrap();
        let _ = ShowWindow(hwnd, SW_SHOW);
        pump_until(hwnd, Duration::from_millis(100), |_| false);
        let front = take_foreground(hwnd);
        pump_until(hwnd, Duration::from_millis(100), |_| false);
        if !front || GetForegroundWindow() != hwnd {
            eprintln!("skipped: the test window could not take the foreground (no interactive desktop?)");
            let _ = DestroyWindow(hwnd);
            return;
        }
        GOT.with(|g| g.borrow_mut().clear());

        let mut inj = WinInjector;
        let key_w = lookup("KeyW").unwrap();
        inj.key(key_w, true);
        inj.key(key_w, false);
        let got = pump_until(hwnd, Duration::from_secs(2), |g| g.iter().any(|x| matches!(x, Got::Up { vk: 0x57 })));
        let _ = DestroyWindow(hwnd);

        assert!(got.iter().any(|x| matches!(x, Got::Down { vk: 0x57, scan: 0x11, ext: false })), "WM_KEYDOWN for W with scan 0x11: {got:?}");
        assert!(got.iter().any(|x| matches!(x, Got::Char(0x77 | 0x57))), "WM_CHAR w: {got:?}");
        assert!(got.iter().any(|x| matches!(x, Got::Up { vk: 0x57 })), "WM_KEYUP for W: {got:?}");
    }
}

#[test]
#[ignore = "takes the foreground: cargo test -- --include-ignored"]
fn extended_keys_carry_the_extended_bit() {
    unsafe {
        let hinst = GetModuleHandleW(None).unwrap();
        let class = w!("ObPalInjectTestExt");
        let wc = WNDCLASSW { lpfnWndProc: Some(wnd_proc), hInstance: hinst.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("ob.Pal inject test (ext)"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, Some(hinst.into()), None).unwrap();
        let _ = ShowWindow(hwnd, SW_SHOW);
        pump_until(hwnd, Duration::from_millis(100), |_| false);
        let front = take_foreground(hwnd);
        pump_until(hwnd, Duration::from_millis(100), |_| false);
        if !front || GetForegroundWindow() != hwnd {
            eprintln!("skipped: the test window could not take the foreground");
            let _ = DestroyWindow(hwnd);
            return;
        }
        GOT.with(|g| g.borrow_mut().clear());
        let mut inj = WinInjector;
        let left = lookup("ArrowLeft").unwrap();
        inj.key(left, true);
        inj.key(left, false);
        let got = pump_until(hwnd, Duration::from_secs(2), |g| g.iter().any(|x| matches!(x, Got::Up { vk: 0x25 })));
        let _ = DestroyWindow(hwnd);
        assert!(got.iter().any(|x| matches!(x, Got::Down { vk: 0x25, scan: 0x4B, ext: true })), "VK_LEFT with the extended bit: {got:?}");
        assert!(!got.iter().any(|x| matches!(x, Got::Char(_))), "arrows produce no character: {got:?}");
    }
}

#[test]
#[ignore = "takes the foreground and types: cargo test -- --include-ignored"]
fn typed_text_arrives_as_characters() {
    unsafe {
        let hinst = GetModuleHandleW(None).unwrap();
        let class = w!("ObPalInjectTestText");
        let wc = WNDCLASSW { lpfnWndProc: Some(wnd_proc), hInstance: hinst.into(), lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(WINDOW_EX_STYLE(0), class, w!("ob.Pal inject test (text)"), WS_OVERLAPPEDWINDOW, 40, 40, 300, 200, None, None, Some(hinst.into()), None).unwrap();
        let _ = ShowWindow(hwnd, SW_SHOW);
        pump_until(hwnd, Duration::from_millis(100), |_| false);
        let front = take_foreground(hwnd);
        pump_until(hwnd, Duration::from_millis(100), |_| false);
        if !front || GetForegroundWindow() != hwnd {
            eprintln!("skipped: the test window could not take the foreground");
            let _ = DestroyWindow(hwnd);
            return;
        }
        GOT.with(|g| g.borrow_mut().clear());
        let mut inj = WinInjector;
        inj.text(1, "a€😀\n\t");
        // Backspace, a, €, 😀 as its two surrogates, then Enter and Tab as the characters their keys make.
        let want = [0x08, 0x61, 0x20AC, 0xD83D, 0xDE00, 0x0D, 0x09];
        let chars = |g: &[Got]| g.iter().filter_map(|x| if let Got::Char(c) = x { Some(*c) } else { None }).collect::<Vec<u32>>();
        let got = pump_until(hwnd, Duration::from_secs(2), |g| chars(g).len() >= want.len());
        let _ = DestroyWindow(hwnd);
        assert_eq!(chars(&got), want, "{got:?}");
    }
}
