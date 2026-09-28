//! NSWorkspace identifies the frontmost executable. AX queries run off the injection thread with timeouts.

use std::ffi::{c_char, c_void, CStr};
use std::ptr::null;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicI32, Ordering}};
use std::time::{Duration, Instant};
use crate::{protocol::TextFocus, session::{Foreground, FrontWindow}};
use super::{ffi::*, focus::classify};

#[link(name = "AppKit", kind = "framework")]
extern "C" {}
#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Ref;
    fn sel_registerName(name: *const c_char) -> Ref;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}
#[link(name = "proc")]
extern "C" {
    fn proc_pidpath(pid: i32, buffer: *mut c_void, size: u32) -> i32;
}
extern "C" { fn getppid() -> i32; }

unsafe fn object(obj: Ref, selector: &[u8]) -> Ref {
    let send: unsafe extern "C" fn(Ref, Ref) -> Ref = std::mem::transmute(objc_msgSend as *const ());
    send(obj, sel_registerName(selector.as_ptr().cast()))
}

fn front_pid() -> i32 {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let ws = object(objc_getClass(c"NSWorkspace".as_ptr()), b"sharedWorkspace\0");
        let app = object(ws, b"frontmostApplication\0");
        let send: unsafe extern "C" fn(Ref, Ref) -> i32 = std::mem::transmute(objc_msgSend as *const ());
        let pid = send(app, sel_registerName(c"processIdentifier".as_ptr()));
        objc_autoreleasePoolPop(pool);
        pid
    }
}

fn path_for(pid: i32) -> Option<String> {
    let mut buf = [0u8; 4096];
    if unsafe { proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) } <= 0 { return None; }
    let path = unsafe { CStr::from_ptr(buf.as_ptr().cast()) }.to_str().ok()?;
    std::fs::canonicalize(path).ok()?.to_str().map(str::to_owned)
}

pub fn browser() -> Option<String> { path_for(unsafe { getppid() }) }
/// A null options dictionary never opens a permission prompt, even while polling.
pub fn trusted() -> bool { unsafe { AXIsProcessTrustedWithOptions(null()) != 0 } }

unsafe fn attribute(el: Ref, name: &CStr) -> Option<Owned> {
    let key = Owned::new(CFStringCreateWithCString(null(), name.as_ptr(), 0x08000100))?;
    let mut value = null();
    if AXUIElementCopyAttributeValue(el, key.0, &mut value) != 0 { return None; }
    Owned::new(value)
}
unsafe fn string(el: Ref, name: &CStr) -> Option<String> {
    let value = attribute(el, name)?;
    if CFGetTypeID(value.0) != CFStringGetTypeID() { return None; }
    let mut buf = [0i8; 128];
    if CFStringGetCString(value.0, buf.as_mut_ptr(), buf.len() as isize, 0x08000100) == 0 { return None; }
    Some(CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
}

unsafe fn focused(pid: i32) -> Option<TextFocus> {
    let app = Owned::new(AXUIElementCreateApplication(pid))?;
    AXUIElementSetMessagingTimeout(app.0, 0.15);
    let el = attribute(app.0, c"AXFocusedUIElement")?;
    if CFGetTypeID(el.0) != AXUIElementGetTypeID() { return None; }
    AXUIElementSetMessagingTimeout(el.0, 0.15);
    let mut owner = 0;
    if AXUIElementGetPid(el.0, &mut owner) != 0 || owner != pid { return None; }
    let role = string(el.0, c"AXRole")?;
    let subrole = string(el.0, c"AXSubrole").unwrap_or_default();
    let enabled = attribute(el.0, c"AXEnabled").map_or(true, |v| CFGetTypeID(v.0) == CFBooleanGetTypeID() && CFBooleanGetValue(v.0) != 0);
    // Query whether AXValue is writable; never copy AXValue or AXSelectedText.
    let name = Owned::new(CFStringCreateWithCString(null(), c"AXValue".as_ptr(), 0x08000100))?;
    let mut settable = 0;
    let editable = (AXUIElementIsAttributeSettable(el.0, name.0, &mut settable) == 0).then_some(settable != 0);
    classify(&role, &subrole, enabled, editable)
}

pub struct MacForeground {
    browser: Option<String>,
    cached: Option<FrontWindow>,
    pid: Arc<AtomicI32>,
    stop: Arc<AtomicBool>,
    focus: Arc<Mutex<Option<(i32, Option<TextFocus>, Instant)>>>,
}
impl MacForeground {
    pub fn new(browser: Option<String>) -> Self {
        let pid = Arc::new(AtomicI32::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let focus = Arc::new(Mutex::new(None));
        let (p, s, f) = (pid.clone(), stop.clone(), focus.clone());
        std::thread::Builder::new().name("text-focus".into()).spawn(move || {
            while !s.load(Ordering::Acquire) {
                let target = p.load(Ordering::Acquire);
                let kind = if target > 0 && trusted() { unsafe { focused(target) } } else { None };
                if target == p.load(Ordering::Acquire) { *f.lock().unwrap() = Some((target, kind, Instant::now())); }
                std::thread::sleep(Duration::from_millis(150));
            }
        }).ok();
        Self { browser, cached: None, pid, stop, focus }
    }
}
impl Drop for MacForeground { fn drop(&mut self) { self.stop.store(true, Ordering::Release); } }
impl Foreground for MacForeground {
    fn front(&mut self) -> Option<FrontWindow> {
        let pid = front_pid();
        self.pid.store(pid, Ordering::Release);
        if pid <= 0 { self.cached = None; return None; }
        if self.cached.as_ref().is_some_and(|c| c.pid == pid as u32) { return self.cached.clone(); }
        let path = path_for(pid)?;
        self.cached = Some(FrontWindow { pid: pid as u32, name: crate::scope::base_name(&path), browser: self.browser.as_ref() == Some(&path), path, title: String::new(), elevated: false });
        self.cached.clone()
    }
    fn text_focus(&mut self) -> Option<TextFocus> {
        let state = *self.focus.lock().ok()?;
        let (pid, kind, at) = state?;
        if pid == self.pid.load(Ordering::Acquire) && at.elapsed() < Duration::from_millis(600) { kind } else { None }
    }
}
