//! Small C ABI surface from Apple's public frameworks. Owned CoreFoundation objects release on drop.

use std::ffi::{c_char, c_void};
pub type Ref = *const c_void;
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Point { pub x: f64, pub y: f64 }

pub struct Owned(pub Ref);
impl Owned {
    pub fn new(raw: Ref) -> Option<Self> { (!raw.is_null()).then_some(Self(raw)) }
}
impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) } } }

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFRelease(value: Ref);
    pub fn CFGetTypeID(value: Ref) -> usize;
    pub fn CFStringGetTypeID() -> usize;
    pub fn CFStringCreateWithCString(allocator: Ref, text: *const c_char, encoding: u32) -> Ref;
    pub fn CFStringGetCString(value: Ref, buf: *mut c_char, size: isize, encoding: u32) -> u8;
    pub fn CFBooleanGetTypeID() -> usize;
    pub fn CFBooleanGetValue(value: Ref) -> u8;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXIsProcessTrustedWithOptions(options: Ref) -> u8;
    pub fn AXUIElementCreateApplication(pid: i32) -> Ref;
    pub fn AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, value: *mut Ref) -> i32;
    pub fn AXUIElementIsAttributeSettable(element: Ref, attribute: Ref, settable: *mut u8) -> i32;
    pub fn AXUIElementGetTypeID() -> usize;
    pub fn AXUIElementGetPid(element: Ref, pid: *mut i32) -> i32;
    pub fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
    pub fn CGEventSourceCreate(state: i32) -> Ref;
    pub fn CGEventCreate(source: Ref) -> Ref;
    pub fn CGEventGetLocation(event: Ref) -> Point;
    pub fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: bool) -> Ref;
    pub fn CGEventKeyboardSetUnicodeString(event: Ref, length: usize, text: *const u16);
    pub fn CGEventCreateMouseEvent(source: Ref, kind: u32, point: Point, button: u32) -> Ref;
    pub fn CGEventCreateScrollWheelEvent(source: Ref, units: u32, wheels: u32, vertical: i32, ...) -> Ref;
    pub fn CGEventSetFlags(event: Ref, flags: u64);
    pub fn CGEventSetIntegerValueField(event: Ref, field: u32, value: i64);
    pub fn CGEventPost(tap: u32, event: Ref);
}
