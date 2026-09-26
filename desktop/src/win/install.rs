//! Native messaging host registration, per user and without admin rights.
//!
//! `install` writes the host manifest next to the executable and points the browsers' per-user registry
//! keys at it; `uninstall` removes exactly those keys and the manifest. Chrome, Chromium, Edge, Brave and
//! Vivaldi each read their own `HKCU\Software\<vendor>\NativeMessagingHosts\<name>` key, whose default
//! value is the manifest path.

use std::fs;
use std::path::{Path, PathBuf};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE,
    REG_OPTION_NON_VOLATILE, REG_SZ,
};

/// The host name the extension connects to (`chrome.runtime.connectNative`).
pub const HOST_NAME: &str = "net.blackboxes.obpal";
/// Extension IDs allowed to reach the helper: ob.Pal Link's stable ID (its manifest `key`).
pub const EXTENSION_IDS: &[&str] = &["jnnpcnoilofjaffabnhecfokjjknlemg"];

pub const BROWSERS: &[(&str, &str)] = &[
    ("Chrome", "Software\\Google\\Chrome\\NativeMessagingHosts"),
    ("Chromium", "Software\\Chromium\\NativeMessagingHosts"),
    ("Edge", "Software\\Microsoft\\Edge\\NativeMessagingHosts"),
    ("Brave", "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts"),
    ("Vivaldi", "Software\\Vivaldi\\NativeMessagingHosts"),
];

pub fn origin(id: &str) -> String {
    format!("chrome-extension://{id}/")
}

pub fn default_origins() -> Vec<String> {
    EXTENSION_IDS.iter().map(|id| origin(id)).collect()
}

/// A `chrome-extension://<32 letters a-p>/` origin, as Chrome requires them in `allowed_origins`.
pub fn valid_origin(o: &str) -> bool {
    o.strip_prefix("chrome-extension://")
        .and_then(|rest| rest.strip_suffix('/'))
        .map_or(false, |id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

pub fn manifest_json(exe: &Path, origins: &[String]) -> String {
    let m = serde_json::json!({
        "name": HOST_NAME,
        "description": "ob.Pal Desktop: keyboard and mouse for allowed programs, from your phone through ob.Pal Link.",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": origins,
    });
    format!("{}\n", serde_json::to_string_pretty(&m).expect("manifest"))
}

pub fn exe_path() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| format!("cannot find my own path: {e}"))
}

pub fn manifest_path() -> Result<PathBuf, String> {
    let exe = exe_path()?;
    Ok(exe.with_file_name(format!("{HOST_NAME}.json")))
}

/// The origins the installed manifest allows (what `serve` checks the launching extension against).
pub fn installed_origins() -> Vec<String> {
    let Ok(p) = manifest_path() else { return default_origins() };
    let Ok(text) = fs::read_to_string(&p) else { return default_origins() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return default_origins() };
    let list: Vec<String> = v["allowed_origins"].as_array().map(|a| a.iter().filter_map(|o| o.as_str().map(String::from)).filter(|o| valid_origin(o)).collect()).unwrap_or_default();
    if list.is_empty() { default_origins() } else { list }
}

fn key_path(sub: &str) -> String {
    format!("{sub}\\{HOST_NAME}")
}

fn set_default_value(subkey: &str, value: &str) -> Result<(), String> {
    unsafe {
        let mut h = HKEY::default();
        let sub = HSTRING::from(subkey);
        let r = RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut h, None);
        if r.is_err() {
            return Err(format!("RegCreateKeyExW {subkey}: {r:?}"));
        }
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes = std::slice::from_raw_parts(wide.as_ptr() as *const u8, wide.len() * 2);
        let r = RegSetValueExW(h, PCWSTR::null(), None, REG_SZ, Some(bytes));
        let _ = RegCloseKey(h);
        if r.is_err() {
            return Err(format!("RegSetValueExW {subkey}: {r:?}"));
        }
        Ok(())
    }
}

/// The key's default value, None when the key does not exist.
fn get_default_value(subkey: &str) -> Option<String> {
    unsafe {
        let mut h = HKEY::default();
        let sub = HSTRING::from(subkey);
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()), None, KEY_READ, &mut h).is_err() {
            return None;
        }
        let mut buf = [0u16; 2048];
        let mut len = (buf.len() * 2) as u32;
        let r = RegQueryValueExW(h, PCWSTR::null(), None, None, Some(buf.as_mut_ptr() as *mut u8), Some(&mut len));
        let _ = RegCloseKey(h);
        if r.is_err() {
            return Some(String::new());
        }
        let n = (len as usize / 2).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]).trim_end_matches('\0').to_string())
    }
}

/// Delete the key. Ok(false) when it was not there.
fn delete_key(subkey: &str) -> Result<bool, String> {
    unsafe {
        let sub = HSTRING::from(subkey);
        let r = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()));
        if r.is_ok() {
            Ok(true)
        } else if r == ERROR_FILE_NOT_FOUND {
            Ok(false)
        } else {
            Err(format!("RegDeleteKeyW {subkey}: {r:?}"))
        }
    }
}

pub struct Report {
    pub lines: Vec<String>,
}

/// Write the manifest and register it for every supported browser.
pub fn install(extra_origins: &[String]) -> Result<Report, String> {
    for o in extra_origins {
        if !valid_origin(o) {
            return Err(format!("not an extension origin: {o} (expected chrome-extension://<id>/)"));
        }
    }
    let exe = exe_path()?;
    let manifest = manifest_path()?;
    let mut origins = default_origins();
    for o in extra_origins {
        if !origins.contains(o) {
            origins.push(o.clone());
        }
    }
    fs::write(&manifest, manifest_json(&exe, &origins)).map_err(|e| format!("cannot write {}: {e}", manifest.display()))?;
    let mut lines = vec![format!("manifest  {}", manifest.display()), format!("allowed   {}", origins.join(" "))];
    let value = manifest.to_string_lossy().to_string();
    for (name, sub) in BROWSERS {
        let key = key_path(sub);
        set_default_value(&key, &value)?;
        lines.push(format!("registered {name:<8} HKCU\\{key}"));
    }
    Ok(Report { lines })
}

/// Remove the registry keys and the manifest. Reports what was actually there.
pub fn uninstall() -> Result<Report, String> {
    let manifest = manifest_path()?;
    let mut lines = Vec::new();
    for (name, sub) in BROWSERS {
        let key = key_path(sub);
        match delete_key(&key)? {
            true => lines.push(format!("removed   {name:<8} HKCU\\{key}")),
            false => lines.push(format!("absent    {name:<8} HKCU\\{key}")),
        }
    }
    match fs::remove_file(&manifest) {
        Ok(()) => lines.push(format!("deleted   {}", manifest.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => lines.push(format!("absent    {}", manifest.display())),
        Err(e) => return Err(format!("cannot delete {}: {e}", manifest.display())),
    }
    Ok(Report { lines })
}

/// Where the host is registered right now, and whether it points at this executable's manifest.
pub fn status() -> Result<Report, String> {
    let manifest = manifest_path()?;
    let mine = manifest.to_string_lossy().to_string();
    let mut lines = vec![format!("manifest  {} ({})", manifest.display(), if manifest.exists() { "present" } else { "missing" })];
    for (name, sub) in BROWSERS {
        let key = key_path(sub);
        match get_default_value(&key) {
            None => lines.push(format!("absent    {name:<8} HKCU\\{key}")),
            Some(v) if v.eq_ignore_ascii_case(&mine) => lines.push(format!("this exe  {name:<8} HKCU\\{key}")),
            Some(v) => lines.push(format!("other     {name:<8} HKCU\\{key} -> {v}")),
        }
    }
    Ok(Report { lines })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_has_what_chrome_needs() {
        let json = manifest_json(Path::new("C:\\Tools\\obpal-desktop.exe"), &default_origins());
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["name"], HOST_NAME);
        assert_eq!(v["type"], "stdio");
        assert_eq!(v["path"], "C:\\Tools\\obpal-desktop.exe");
        assert_eq!(v["allowed_origins"][0], "chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemg/");
        assert!(json.ends_with('\n'));
    }

    #[test]
    fn origins_are_checked() {
        assert!(valid_origin("chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemg/"));
        assert!(!valid_origin("chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemg"));
        assert!(!valid_origin("chrome-extension://JNNPCNOILOFJAFFABNHECFOKJJKNLEMG/"));
        assert!(!valid_origin("chrome-extension://abc/"));
        assert!(!valid_origin("https://example.com/"));
        assert!(!valid_origin("chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemq/"), "q is outside a-p");
        assert!(default_origins().iter().all(|o| valid_origin(o)));
    }

    #[test]
    fn registry_keys_are_the_browsers_own() {
        assert_eq!(key_path("Software\\Chromium\\NativeMessagingHosts"), "Software\\Chromium\\NativeMessagingHosts\\net.blackboxes.obpal");
        assert_eq!(BROWSERS.len(), 5);
        assert!(get_default_value("Software\\obpal-desktop-test-key-that-does-not-exist").is_none());
    }
}
