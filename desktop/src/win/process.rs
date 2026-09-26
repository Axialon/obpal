//! Which process launched us. Chrome starts native messaging hosts from its browser process, so the parent
//! is the browser whose windows the helper must never inject into (the extension's page path covers them).

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::GetCurrentProcessId;

use super::foreground::image_path;

pub fn parent_pid() -> Option<u32> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let me = GetCurrentProcessId();
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut parent = None;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                if entry.th32ProcessID == me {
                    parent = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        CloseHandle(snap).ok();
        parent
    }
}

/// Image path of the parent process, if it is still around.
pub fn parent_path() -> Option<String> {
    image_path(parent_pid()?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_a_parent() {
        // cargo test runs us under the test runner, which has a path.
        let pid = super::parent_pid().expect("parent pid");
        assert_ne!(pid, std::process::id());
    }
}
