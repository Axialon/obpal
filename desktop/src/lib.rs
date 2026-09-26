//! ob.Pal Desktop as a library: the protocol, key table, allowlist and session logic (platform-neutral),
//! plus the Windows implementation. `main.rs` is the CLI and serve loop; `bin/harness.rs` the test window.

pub mod keys;
pub mod protocol;
pub mod scope;
pub mod session;
#[cfg(windows)]
pub mod win;
