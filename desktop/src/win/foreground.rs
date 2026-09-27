//! The foreground window and the process behind it: image path, title, and whether UIPI would block us.
//!
//! GetForegroundWindow → GetWindowThreadProcessId → OpenProcess(QUERY_LIMITED) → QueryFullProcessImageNameW.
//! Elevation: the process token's integrity level compared with ours. UIPI drops input sent from a lower
//! integrity level to a higher one without any error, so the helper refuses up front and reports it. A
//! process whose token cannot be opened is treated as higher (it usually is).
//!
//! Whether a text field has the keyboard focus comes from the UI Automation watcher (`focus.rs`), which a
//! serving helper starts with `watching_focus`.

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

use super::focus::FocusWatcher;
use crate::protocol::TextFocus;
use crate::scope::{base_name, normalize};
use crate::session::{Foreground, FrontWindow};

/// SECURITY_MANDATORY_MEDIUM_RID: what a normal, non-elevated process runs at.
pub const MEDIUM_IL: u32 = 0x2000;
const TITLE_MAX: usize = 120;

pub struct WinForeground {
    my_il: u32,
    browser: Option<String>,
    /// The last lookup, by window and process: asked every frame, only a new window costs a process query.
    last: Option<(isize, u32, FrontWindow)>,
    /// What has the keyboard focus, while serving (`watching_focus`).
    focus: Option<FocusWatcher>,
}

impl WinForeground {
    /// `browser` is the image path of the browser that launched us: its windows are reported, never injected.
    pub fn new(browser: Option<String>) -> WinForeground {
        let my_il = integrity_level(unsafe { GetCurrentProcess() }).unwrap_or(MEDIUM_IL);
        WinForeground { my_il, browser: browser.map(|b| normalize(&b)), last: None, focus: None }
    }

    /// Also tell when a text field has the keyboard focus: starts the UI Automation watcher, which stops when this is dropped.
    pub fn watching_focus(mut self) -> WinForeground {
        self.focus = FocusWatcher::start();
        self
    }
}

/// Full image path of a process handle opened with PROCESS_QUERY_LIMITED_INFORMATION.
pub fn image_path_of(h: HANDLE) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

pub fn image_path(pid: u32) -> Option<String> {
    let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let path = image_path_of(h);
    unsafe { CloseHandle(h) }.ok();
    path
}

/// The integrity level RID of a process token (0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system).
pub fn integrity_level(process: HANDLE) -> Option<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        let mut buf = vec![0u8; (len as usize).max(std::mem::size_of::<TOKEN_MANDATORY_LABEL>())];
        let r = GetTokenInformation(token, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), buf.len() as u32, &mut len);
        CloseHandle(token).ok();
        r.ok()?;
        let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let sid = label.Label.Sid;
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, (count - 1) as u32))
    }
}

impl Foreground for WinForeground {
    fn front(&mut self) -> Option<FrontWindow> {
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None; // the secure desktop, or a moment between windows
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return None;
        }
        if let Some((h, p, w)) = &self.last {
            if *h == hwnd.0 as isize && *p == pid {
                return Some(w.clone());
            }
        }
        let front = self.lookup(hwnd, pid);
        self.last = front.clone().map(|w| (hwnd.0 as isize, pid, w));
        front
    }

    fn text_focus(&mut self) -> Option<TextFocus> {
        let watcher = self.focus.as_ref()?;
        // Only in the window `front` has just looked up, and never in an elevated one: typing can't reach it.
        let hwnd = unsafe { GetForegroundWindow() };
        match &self.last {
            Some((h, _, w)) if *h == hwnd.0 as isize && !w.elevated => watcher.kind_in(hwnd),
            _ => None,
        }
    }
}

impl WinForeground {
    fn lookup(&self, hwnd: windows::Win32::Foundation::HWND, pid: u32) -> Option<FrontWindow> {
        let mut tbuf = [0u16; TITLE_MAX + 1];
        let n = unsafe { GetWindowTextW(hwnd, &mut tbuf) }.max(0) as usize;
        let title = String::from_utf16_lossy(&tbuf[..n.min(TITLE_MAX)]);
        let Ok(h) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
            // Protected or otherwise off-limits: unidentified, so nothing is injected.
            return Some(FrontWindow { pid, path: String::new(), name: "?".into(), title, elevated: true, browser: false });
        };
        let path = image_path_of(h).unwrap_or_default();
        let il = integrity_level(h);
        unsafe { CloseHandle(h) }.ok();
        let elevated = il.map_or(true, |il| il > self.my_il);
        let browser = self.browser.as_deref().map_or(false, |b| b == normalize(&path));
        Some(FrontWindow { pid, name: if path.is_empty() { "?".into() } else { base_name(&path) }, path, title, elevated, browser })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_own_process_is_identified_and_not_elevated_relative_to_itself() {
        let me = unsafe { GetCurrentProcess() };
        let path = image_path_of(me).expect("own image path");
        assert!(path.to_lowercase().ends_with(".exe"), "{path}");
        let il = integrity_level(me).expect("own integrity level");
        assert!(il >= 0x1000, "{il:#x}");
        let fg = WinForeground::new(Some(path.clone()));
        assert_eq!(fg.my_il, il);
        assert_eq!(fg.browser.as_deref(), Some(normalize(&path).as_str()));
        assert_eq!(image_path(std::process::id()).as_deref(), Some(path.as_str()));
    }
}
