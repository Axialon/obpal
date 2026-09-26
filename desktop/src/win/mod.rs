//! Windows implementation: SendInput injection, foreground process lookup, the panic hotkey, the parent
//! browser process, and the native messaging host registration (HKCU, no admin).

pub mod foreground;
pub mod hotkey;
pub mod inject;
#[cfg(test)]
mod inject_test;
pub mod install;
pub mod process;
