//! Which browser launched us. Chrome on Windows starts a native messaging host through `cmd.exe /d /s /c`
//! (to wire its pipes to stdin and stdout), so the parent is usually `cmd.exe` and the browser is the process
//! above it. Its windows are reported as the browser: never allowed as a program (the extension's page path
//! covers tabs), controllable only in whole-PC mode.

use std::collections::HashMap;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::GetCurrentProcessId;

use super::foreground::image_path;
use crate::scope::base_name;

/// Shells a browser may put between itself and the helper.
const LAUNCHERS: &[&str] = &["cmd.exe"];
/// How far up the parent chain to look for the browser.
const MAX_HOPS: usize = 3;

/// Every process's parent, from one snapshot.
fn parents() -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        CloseHandle(snap).ok();
    }
    map
}

pub fn parent_pid() -> Option<u32> {
    parents().get(&unsafe { GetCurrentProcessId() }).copied()
}

/// The first ancestor that is not a launcher shell, from `(pid, image path)` pairs nearest first.
pub fn browser_in(chain: &[(u32, String)]) -> Option<String> {
    chain
        .iter()
        .take(MAX_HOPS)
        .find(|(_, path)| !LAUNCHERS.iter().any(|l| base_name(path).eq_ignore_ascii_case(l)))
        .map(|(_, path)| path.clone())
}

/// Image path of the browser that launched us, skipping the `cmd.exe` Chrome starts hosts through.
pub fn launcher_path() -> Option<String> {
    let map = parents();
    let mut chain = Vec::new();
    let mut pid = unsafe { GetCurrentProcessId() };
    for _ in 0..MAX_HOPS {
        let Some(&parent) = map.get(&pid) else { break };
        if parent == 0 || parent == pid {
            break;
        }
        let Some(path) = image_path(parent) else { break };
        chain.push((parent, path));
        pid = parent;
    }
    browser_in(&chain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_parent() {
        // cargo test runs us under the test runner, which has a path.
        let pid = parent_pid().expect("parent pid");
        assert_ne!(pid, std::process::id());
        assert!(launcher_path().is_some());
    }

    #[test]
    fn skips_the_shell_chrome_starts_hosts_through() {
        let chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe".to_string();
        let cmd = "C:\\WINDOWS\\system32\\cmd.exe".to_string();
        assert_eq!(browser_in(&[(2, cmd.clone()), (1, chrome.clone())]), Some(chrome.clone()));
        assert_eq!(browser_in(&[(2, "C:\\Windows\\System32\\CMD.EXE".into()), (1, chrome.clone())]), Some(chrome.clone()));
        // Edge, Brave and Firefox-style direct launches
        assert_eq!(browser_in(&[(1, chrome.clone())]), Some(chrome));
        assert_eq!(browser_in(&[(2, cmd.clone())]), None, "a shell with nothing above it is not a browser");
        assert_eq!(browser_in(&[]), None);
    }
}
