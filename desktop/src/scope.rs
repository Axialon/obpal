//! Per-program scope: the allowlist of programs and what each may receive, and whole-PC mode, persisted in
//! `%APPDATA%\obpal\desktop.json` (Windows) or `$XDG_CONFIG_HOME/obpal/desktop.json`.
//!
//! Nothing is allowed by default, and whole-PC mode is off until a person turns it on in the extension. The file is written only by the helper, in response to validated messages
//! from the extension; a hand-edited or damaged file is treated as empty rather than trusted.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::protocol::{ProgramEntry, Scope};

pub const CONFIG_VERSION: u32 = 1;
/// An allowlist longer than this is not a person's list.
pub const MAX_PROGRAMS: usize = 200;
pub const MAX_PATH_LEN: usize = 1024;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Config {
    #[serde(default)]
    pub v: u32,
    /// A global stop: nothing is injected while set.
    #[serde(default)]
    pub paused: bool,
    /// Whole-PC mode: while set, every window in front receives input with this scope, the browser included.
    #[serde(default)]
    pub desktop: Option<Scope>,
    #[serde(default)]
    pub programs: Vec<ProgramEntry>,
}

/// Program identity: the image path, compared case-insensitively with one separator style on Windows.
pub fn normalize(path: &str) -> String {
    if cfg!(windows) {
        path.trim().replace('/', "\\").to_lowercase()
    } else {
        path.trim().to_string()
    }
}

/// The file name of an image path, for display.
pub fn base_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_string()
}

/// A path the helper is willing to store: absolute, printable, bounded.
pub fn valid_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() || path.len() > MAX_PATH_LEN {
        return Err("path length");
    }
    if path.chars().any(|c| c.is_control()) {
        return Err("path has control characters");
    }
    let absolute = if cfg!(windows) {
        let b = path.as_bytes();
        (b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
            || path.starts_with("\\\\")
            || path.starts_with("//")
    } else {
        path.starts_with('/')
    };
    if !absolute {
        return Err("path is not absolute");
    }
    if base_name(path).is_empty() {
        return Err("path has no file name");
    }
    Ok(())
}

impl Config {
    pub fn new() -> Config {
        Config { v: CONFIG_VERSION, paused: false, desktop: None, programs: Vec::new() }
    }

    /// Whole-PC mode's scope while it is on and allows something.
    pub fn desktop_scope(&self) -> Option<Scope> {
        self.desktop.filter(|s| s.any())
    }

    /// Turn whole-PC mode on with a scope, or off. Returns true when it changed.
    pub fn set_desktop(&mut self, scope: Option<Scope>) -> bool {
        let changed = self.desktop != scope;
        self.desktop = scope;
        changed
    }

    fn position(&self, path: &str) -> Option<usize> {
        let id = normalize(path);
        self.programs.iter().position(|p| normalize(&p.path) == id)
    }

    /// The scope a program is allowed, or None when it is not on the list (or has every kind off).
    pub fn scope_for(&self, path: &str) -> Option<Scope> {
        self.position(path).map(|i| self.programs[i].scope).filter(|s| s.any())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_allowed(&self, path: &str) -> bool {
        self.scope_for(path).is_some()
    }

    /// Add a program (or replace its scope). Returns true when the list changed.
    pub fn allow(&mut self, path: &str, scope: Scope) -> Result<bool, &'static str> {
        valid_path(path)?;
        if let Some(i) = self.position(path) {
            let changed = self.programs[i].scope != scope;
            self.programs[i].scope = scope;
            return Ok(changed);
        }
        if self.programs.len() >= MAX_PROGRAMS {
            return Err("too many programs");
        }
        self.programs.push(ProgramEntry { path: path.to_string(), name: base_name(path), scope });
        Ok(true)
    }

    /// Change the scope of a listed program. Err when it is not listed.
    pub fn set_scope(&mut self, path: &str, scope: Scope) -> Result<bool, &'static str> {
        let i = self.position(path).ok_or("program is not allowed")?;
        let changed = self.programs[i].scope != scope;
        self.programs[i].scope = scope;
        Ok(changed)
    }

    /// Remove a program. Returns true when it was listed.
    pub fn forget(&mut self, path: &str) -> bool {
        match self.position(path) {
            Some(i) => {
                self.programs.remove(i);
                true
            }
            None => false,
        }
    }

    // ---- persistence ----

    /// `%APPDATA%\obpal\desktop.json`, or the XDG equivalent. None when the platform gives no home.
    pub fn default_path() -> Option<PathBuf> {
        let dir = if cfg!(windows) {
            std::env::var_os("APPDATA").map(PathBuf::from)
        } else {
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        }?;
        Some(dir.join("obpal").join("desktop.json"))
    }

    /// Load the file; a missing, unreadable or malformed file is an empty config (nothing allowed).
    pub fn load(path: &Path) -> Config {
        let Ok(bytes) = fs::read(path) else { return Config::new() };
        let mut cfg: Config = match serde_json::from_slice(&bytes) {
            Ok(c) => c,
            Err(_) => return Config::new(),
        };
        cfg.v = CONFIG_VERSION;
        cfg.programs.retain(|p| valid_path(&p.path).is_ok());
        cfg.programs.truncate(MAX_PROGRAMS);
        for p in &mut cfg.programs {
            p.name = base_name(&p.path);
        }
        cfg
    }

    /// Write atomically: a temp file next to the target, then rename over it.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_vec_pretty(self).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
        fs::write(&tmp, json)?;
        if let Err(e) = fs::rename(&tmp, path) {
            // Windows refuses to rename over an existing file only in odd cases; fall back to replace.
            fs::remove_file(path).ok();
            fs::rename(&tmp, path).map_err(|_| e)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KM: Scope = Scope { keyboard: true, mouse: true, gamepad: false };
    const K: Scope = Scope { keyboard: true, mouse: false, gamepad: false };
    const NONE: Scope = Scope { keyboard: false, mouse: false, gamepad: false };

    fn abs(name: &str) -> String {
        if cfg!(windows) { format!("C:\\Games\\{name}") } else { format!("/games/{name}") }
    }

    #[test]
    fn nothing_is_allowed_by_default() {
        let cfg = Config::new();
        assert!(cfg.programs.is_empty());
        assert!(!cfg.paused);
        assert_eq!(cfg.desktop_scope(), None, "whole-PC mode starts off");
        assert_eq!(cfg.scope_for(&abs("game.exe")), None);
        assert!(!cfg.is_allowed(""));
    }

    #[test]
    fn allow_scope_forget() {
        let mut cfg = Config::new();
        let p = abs("Game.exe");
        assert_eq!(cfg.allow(&p, KM), Ok(true));
        assert_eq!(cfg.allow(&p, KM), Ok(false));
        assert_eq!(cfg.programs.len(), 1);
        assert_eq!(cfg.programs[0].name, "Game.exe");
        assert_eq!(cfg.scope_for(&p), Some(KM));
        assert_eq!(cfg.set_scope(&p, K), Ok(true));
        assert_eq!(cfg.scope_for(&p), Some(K));
        // every kind off: listed, but nothing is allowed
        assert_eq!(cfg.set_scope(&p, NONE), Ok(true));
        assert_eq!(cfg.scope_for(&p), None);
        assert_eq!(cfg.set_scope(&abs("other.exe"), K), Err("program is not allowed"));
        assert!(cfg.forget(&p));
        assert!(!cfg.forget(&p));
        assert!(cfg.programs.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_paths_match_case_and_separator_insensitively() {
        let mut cfg = Config::new();
        cfg.allow("C:\\Games\\Game.exe", KM).unwrap();
        assert!(cfg.is_allowed("c:\\games\\game.exe"));
        assert!(cfg.is_allowed("C:/Games/Game.exe"));
        assert!(!cfg.is_allowed("C:\\Games\\Game.exe.bak"));
        assert!(!cfg.is_allowed("D:\\Games\\Game.exe"));
        assert!(!cfg.is_allowed("Game.exe"));
        assert_eq!(cfg.allow("c:/games/game.exe", K), Ok(true));
        assert_eq!(cfg.programs.len(), 1);
    }

    #[test]
    fn rejects_paths_that_are_not_absolute_files() {
        let mut cfg = Config::new();
        for bad in ["", "game.exe", "..\\game.exe", "C:game.exe", "C:\\a\\b\\", "C:\\a\nb.exe", "relative/path"] {
            let r = cfg.allow(bad, KM);
            assert!(r.is_err(), "{bad:?} accepted: {r:?}");
        }
        assert!(cfg.allow(&"C:\\".to_string().repeat(400), KM).is_err());
        assert!(cfg.programs.is_empty());
    }

    #[test]
    fn caps_the_list() {
        let mut cfg = Config::new();
        for i in 0..MAX_PROGRAMS {
            cfg.allow(&abs(&format!("g{i}.exe")), KM).unwrap();
        }
        assert_eq!(cfg.allow(&abs("one-more.exe"), KM), Err("too many programs"));
    }

    #[test]
    fn persists_and_survives_damage() {
        let dir = std::env::temp_dir().join(format!("obpal-desktop-test-{}", std::process::id()));
        let file = dir.join("nested").join("desktop.json");
        let mut cfg = Config::new();
        cfg.allow(&abs("game.exe"), K).unwrap();
        cfg.paused = true;
        assert!(cfg.set_desktop(Some(KM)));
        assert!(!cfg.set_desktop(Some(KM)));
        cfg.save(&file).unwrap();
        let back = Config::load(&file);
        assert_eq!(back, cfg);
        assert_eq!(back.desktop_scope(), Some(KM));
        // a file from before whole-PC mode loads with it off
        fs::write(&file, br#"{"v":1,"paused":false,"programs":[]}"#).unwrap();
        assert_eq!(Config::load(&file).desktop, None);
        // on with every kind off is off
        let mut off = Config::new();
        off.set_desktop(Some(NONE));
        assert_eq!(off.desktop_scope(), None);
        assert!(!file.with_extension("json.tmp").exists());
        // damaged or hostile content: nothing allowed
        fs::write(&file, b"{not json").unwrap();
        assert_eq!(Config::load(&file), Config::new());
        fs::write(&file, br#"{"v":1,"paused":false,"programs":[{"path":"game.exe","name":"game.exe","keyboard":true,"mouse":true}]}"#).unwrap();
        assert!(Config::load(&file).programs.is_empty(), "a relative path in the file is dropped");
        assert_eq!(Config::load(&dir.join("missing.json")), Config::new());
        fs::remove_dir_all(&dir).ok();
    }
}
