//! macOS backends. Pure mapping and classification also build on Windows for unit tests.

pub mod keys;
pub mod text;
pub mod focus;
#[cfg(target_os = "macos")]
pub mod foreground;
#[cfg(target_os = "macos")]
pub mod hotkey;
#[cfg(target_os = "macos")]
mod ffi;
#[cfg(target_os = "macos")]
pub mod inject;
