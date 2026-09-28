//! Carbon's registered hotkey needs neither an event tap nor Input Monitoring permission.
//! Registration and event dispatch run on the main thread, alongside the native messaging loop.

use std::ffi::c_void;
type Ref = *mut c_void;
#[repr(C)]
struct EventType { class: u32, kind: u32 }
#[repr(C)]
struct HotKeyId { signature: u32, id: u32 }
type Handler = unsafe extern "C" fn(Ref, Ref, Ref) -> i32;
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn GetApplicationEventTarget() -> Ref;
    fn GetEventDispatcherTarget() -> Ref;
    fn InstallEventHandler(target: Ref, handler: Handler, count: u32, events: *const EventType, data: Ref, installed: *mut Ref) -> i32;
    fn RemoveEventHandler(handler: Ref) -> i32;
    fn RegisterEventHotKey(key: u32, modifiers: u32, id: HotKeyId, target: Ref, options: u32, hotkey: *mut Ref) -> i32;
    fn ReceiveNextEvent(count: u32, events: *const EventType, timeout: f64, pull: u8, event: *mut Ref) -> i32;
    fn SendEventToEventTarget(event: Ref, target: Ref) -> i32;
    fn ReleaseEvent(event: Ref);
}
const PRESSED: EventType = EventType { class: u32::from_be_bytes(*b"keyb"), kind: 5 };
struct Callback(Box<dyn Fn() + Send>);
unsafe extern "C" fn pressed(_: Ref, _: Ref, data: Ref) -> i32 {
    (*(data as *const Callback)).0();
    0
}
pub fn start(on_panic: impl Fn() + Send + 'static) -> Option<String> {
    let data = Box::into_raw(Box::new(Callback(Box::new(on_panic))));
    unsafe {
        let mut handler = std::ptr::null_mut();
        let target = GetApplicationEventTarget();
        if InstallEventHandler(target, pressed, 1, &PRESSED, data.cast(), &mut handler) != 0 { drop(Box::from_raw(data)); return None; }
        let mut hotkey = std::ptr::null_mut();
        // Mac Delete is the backward-delete key (51), not forward delete (117).
        if RegisterEventHotKey(51, (1 << 12) | (1 << 11), HotKeyId { signature: u32::from_be_bytes(*b"obPl"), id: 1 }, target, 0, &mut hotkey) != 0 {
            RemoveEventHandler(handler); drop(Box::from_raw(data)); return None;
        }
    }
    // The callback and registration live until the helper exits; the OS removes them then.
    Some("Ctrl+⌥+Delete".into())
}
pub fn poll() {
    unsafe {
        for _ in 0..8 {
            let mut event = std::ptr::null_mut();
            if ReceiveNextEvent(1, &PRESSED, 0.0, 1, &mut event) != 0 { break; }
            SendEventToEventTarget(event, GetEventDispatcherTarget());
            ReleaseEvent(event);
        }
    }
}
