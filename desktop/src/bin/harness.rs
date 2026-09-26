//! A test window for the end-to-end check: a plain Win32 window with a multi-line EDIT control that prints
//! every key, character, mouse button, motion and wheel event it receives as JSON lines on stdout, and
//! answers commands on stdin (`text` prints the edit control's text, `front` brings the window to the
//! foreground, `quit` exits). The extension's e2e script allows this program, drives the phone, and reads
//! the text back to prove that input arrived through the normal Windows input path.

#[cfg(not(windows))]
fn main() {
    eprintln!("obpal-harness runs on Windows only");
}

#[cfg(windows)]
fn main() {
    harness::run();
}

#[cfg(windows)]
mod harness {
    use std::io::{self, BufRead, Write};
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::thread;

    use obpal_desktop::win::foreground::integrity_level;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, WHITE_BRUSH};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentProcess, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, SetFocus, KEYEVENTF_KEYUP, VK_MENU};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, CallNextHookEx, CallWindowProcW, CreateWindowExW, DefWindowProcW, DispatchMessageW,
        GetForegroundWindow, GetMessageExtraInfo, GetMessageW, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        PostMessageW, PostQuitMessage, RegisterClassW, SetForegroundWindow, SetWindowLongPtrW, SetWindowTextW, SetWindowsHookExW, ShowWindow,
        TranslateMessage, CS_HREDRAW, CS_VREDRAW, ES_AUTOVSCROLL, ES_MULTILINE, GWLP_WNDPROC, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, SC_KEYMENU,
        SW_SHOW, WH_KEYBOARD_LL, WINDOW_EX_STYLE, WM_APP, WM_CHAR, WM_DESTROY, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SIZE, WM_SYSCOMMAND, WM_SYSKEYDOWN, WM_SYSKEYUP,
        WM_XBUTTONDOWN, WM_XBUTTONUP, WNDCLASSW, WNDPROC, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE, WS_VSCROLL,
    };

    /// A low-level keyboard hook: sees every keyboard event the system routes, before any window does.
    /// Logged as `ll` events, so a key that shows up here but never as `key` was eaten between the hook chain
    /// and the window (another hook, or UIPI at the window).
    unsafe extern "system" fn ll_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let k = &*(l.0 as *const KBDLLHOOKSTRUCT);
            emit(format!(
                r#"{{"ev":"ll","msg":{},"vk":{},"scan":{},"injected":{},"extra":{}}}"#,
                w.0,
                k.vkCode,
                k.scanCode,
                (k.flags & LLKHF_INJECTED).0 != 0,
                k.dwExtraInfo
            ));
        }
        CallNextHookEx(None, code, w, l)
    }

    const CMD_TEXT: u32 = WM_APP + 1;
    const CMD_FRONT: u32 = WM_APP + 2;
    const CMD_QUIT: u32 = WM_APP + 3;
    const CMD_CLEAR: u32 = WM_APP + 4;

    static EDIT: AtomicIsize = AtomicIsize::new(0);
    static EDIT_PROC: AtomicIsize = AtomicIsize::new(0);

    fn emit(json: String) {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{json}");
        let _ = out.flush();
    }

    fn esc(s: &str) -> String {
        serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
    }

    fn log_input(msg: u32, w: WPARAM, l: LPARAM) {
        let lp = l.0 as u32;
        match msg {
            WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP => {
                let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let repeat = (lp >> 30) & 1 == 1;
                // extra: the injector's dwExtraInfo tag (obpal-desktop uses 0x0B9A1001), 0 for a real keyboard
                // and for this harness's own Alt tap when it takes the foreground.
                let extra = unsafe { GetMessageExtraInfo().0 } as u64;
                emit(format!(
                    r#"{{"ev":"key","down":{down},"vk":{},"scan":{},"ext":{},"repeat":{repeat},"extra":{extra}}}"#,
                    w.0,
                    (lp >> 16) & 0xFF,
                    (lp >> 24) & 1 == 1
                ));
            }
            WM_CHAR => emit(format!(
                r#"{{"ev":"char","c":{},"extra":{}}}"#,
                esc(&char::from_u32(w.0 as u32).map(String::from).unwrap_or_default()),
                unsafe { GetMessageExtraInfo().0 } as u64
            )),
            WM_MOUSEMOVE => emit(format!(r#"{{"ev":"move","x":{},"y":{}}}"#, (lp & 0xFFFF) as i16, (lp >> 16) as i16)),
            WM_LBUTTONDOWN => emit(r#"{"ev":"button","b":0,"down":true}"#.into()),
            WM_LBUTTONUP => emit(r#"{"ev":"button","b":0,"down":false}"#.into()),
            WM_MBUTTONDOWN => emit(r#"{"ev":"button","b":1,"down":true}"#.into()),
            WM_MBUTTONUP => emit(r#"{"ev":"button","b":1,"down":false}"#.into()),
            WM_RBUTTONDOWN => emit(r#"{"ev":"button","b":2,"down":true}"#.into()),
            WM_RBUTTONUP => emit(r#"{"ev":"button","b":2,"down":false}"#.into()),
            WM_XBUTTONDOWN => emit(format!(r#"{{"ev":"button","b":{},"down":true}}"#, 2 + ((w.0 >> 16) & 0xFFFF))),
            WM_XBUTTONUP => emit(format!(r#"{{"ev":"button","b":{},"down":false}}"#, 2 + ((w.0 >> 16) & 0xFFFF))),
            WM_MOUSEWHEEL => emit(format!(r#"{{"ev":"wheel","dy":{}}}"#, ((w.0 >> 16) & 0xFFFF) as u16 as i16)),
            WM_MOUSEHWHEEL => emit(format!(r#"{{"ev":"wheel","dx":{}}}"#, ((w.0 >> 16) & 0xFFFF) as u16 as i16)),
            _ => {}
        }
    }

    unsafe extern "system" fn edit_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        log_input(msg, w, l);
        let prev: WNDPROC = std::mem::transmute(EDIT_PROC.load(Ordering::SeqCst));
        CallWindowProcW(prev, hwnd, msg, w, l)
    }

    fn edit_text() -> String {
        let edit = HWND(EDIT.load(Ordering::SeqCst) as *mut _);
        unsafe {
            let n = GetWindowTextLengthW(edit).max(0) as usize;
            let mut buf = vec![0u16; n + 1];
            let got = GetWindowTextW(edit, &mut buf).max(0) as usize;
            String::from_utf16_lossy(&buf[..got])
        }
    }

    /// The foreground lock refuses SetForegroundWindow unless the caller owns the input. Attaching to the
    /// foreground thread's input queue lends us that right without injecting anything. (The usual Alt-tap
    /// trick is the fallback: an Alt tap that lands in this window once it is in front would put it into
    /// menu mode, which swallows every following key, so wnd_proc ignores SC_KEYMENU.)
    fn bring_to_front(hwnd: HWND) -> bool {
        unsafe {
            let edit = HWND(EDIT.load(Ordering::SeqCst) as *mut _);
            let fg = GetForegroundWindow();
            let me = GetCurrentThreadId();
            let fg_thread = if fg.0.is_null() { 0 } else { GetWindowThreadProcessId(fg, None) };
            let attached = fg_thread != 0 && fg_thread != me && AttachThreadInput(fg_thread, me, true).as_bool();
            let _ = SetForegroundWindow(hwnd);
            let _ = BringWindowToTop(hwnd);
            let _ = SetFocus(Some(edit));
            if attached {
                let _ = AttachThreadInput(fg_thread, me, false);
            }
            if GetForegroundWindow() != hwnd {
                keybd_event(VK_MENU.0 as u8, 0, Default::default(), 0);
                keybd_event(VK_MENU.0 as u8, 0, KEYEVENTF_KEYUP, 0);
                let _ = SetForegroundWindow(hwnd);
                let _ = SetFocus(Some(edit));
            }
            GetForegroundWindow() == hwnd
        }
    }

    unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        match msg {
            // A lone Alt would enter menu mode (the system menu), where keys stop reaching the edit control.
            WM_SYSCOMMAND if (w.0 & 0xFFF0) as u32 == SC_KEYMENU => LRESULT(0),
            WM_SIZE => {
                let edit = HWND(EDIT.load(Ordering::SeqCst) as *mut _);
                let _ = windows::Win32::UI::WindowsAndMessaging::MoveWindow(edit, 0, 0, (l.0 & 0xFFFF) as i32, ((l.0 >> 16) & 0xFFFF) as i32, true);
                LRESULT(0)
            }
            CMD_TEXT => {
                let front = GetForegroundWindow() == hwnd;
                let focus = windows::Win32::UI::Input::KeyboardAndMouse::GetFocus();
                let edit = HWND(EDIT.load(Ordering::SeqCst) as *mut _);
                emit(format!(r#"{{"ev":"text","text":{},"front":{front},"focus":{}}}"#, esc(&edit_text()), if focus == edit { "\"edit\"" } else if focus == hwnd { "\"window\"" } else { "\"none\"" }));
                LRESULT(0)
            }
            CMD_FRONT => {
                emit(format!(r#"{{"ev":"front","ok":{}}}"#, bring_to_front(hwnd)));
                LRESULT(0)
            }
            CMD_CLEAR => {
                let edit = HWND(EDIT.load(Ordering::SeqCst) as *mut _);
                let _ = SetWindowTextW(edit, w!(""));
                emit(r#"{"ev":"cleared"}"#.into());
                LRESULT(0)
            }
            CMD_QUIT => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => {
                log_input(msg, w, l);
                DefWindowProcW(hwnd, msg, w, l)
            }
        }
    }

    pub fn run() {
        unsafe {
            let hinst = GetModuleHandleW(None).expect("module handle");
            let class = w!("ObPalHarness");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(wnd_proc),
                hInstance: hinst.into(),
                lpszClassName: class,
                hbrBackground: HBRUSH(GetStockObject(WHITE_BRUSH).0),
                ..Default::default()
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!("ob.Pal harness"),
                WS_OVERLAPPEDWINDOW,
                80,
                80,
                520,
                360,
                None,
                None,
                Some(hinst.into()),
                None,
            )
            .expect("window");
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("EDIT"),
                PCWSTR::null(),
                WS_CHILD | WS_VISIBLE | WS_VSCROLL | windows::Win32::UI::WindowsAndMessaging::WINDOW_STYLE(ES_MULTILINE as u32 | ES_AUTOVSCROLL as u32),
                0,
                0,
                500,
                320,
                Some(hwnd),
                None,
                Some(hinst.into()),
                None,
            )
            .expect("edit control");
            EDIT.store(edit.0 as isize, Ordering::SeqCst);
            let prev = SetWindowLongPtrW(edit, GWLP_WNDPROC, edit_proc as *const () as usize as isize);
            EDIT_PROC.store(prev, Ordering::SeqCst);
            let _ = GetWindowLongPtrW(edit, GWLP_WNDPROC);
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetFocus(Some(edit));

            let _ = SetWindowsHookExW(WH_KEYBOARD_LL, Some(ll_hook), None, 0);
            let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let il = integrity_level(GetCurrentProcess()).unwrap_or(0);
            emit(format!(r#"{{"ev":"ready","pid":{},"path":{},"front":{},"il":{il}}}"#, std::process::id(), esc(&exe), bring_to_front(hwnd)));

            let target = hwnd.0 as isize;
            // --stay: keep running when stdin closes (launched without a pipe); otherwise EOF means quit.
            let stay = std::env::args().any(|a| a == "--stay");
            thread::spawn(move || {
                let stdin = io::stdin();
                for line in stdin.lock().lines() {
                    let Ok(line) = line else { break };
                    let cmd = match line.trim() {
                        "text" => CMD_TEXT,
                        "front" => CMD_FRONT,
                        "clear" => CMD_CLEAR,
                        "quit" => CMD_QUIT,
                        _ => continue,
                    };
                    let _ = PostMessageW(Some(HWND(target as *mut _)), cmd, WPARAM(0), LPARAM(0));
                }
                if !stay {
                    let _ = PostMessageW(Some(HWND(target as *mut _)), CMD_QUIT, WPARAM(0), LPARAM(0));
                }
            });

            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }
}
