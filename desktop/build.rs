//! Build script: on Windows (MSVC), obpal-desktop.exe gets its icon (obpal-desktop.ico, made by icon.mjs) and its
//! version information (the Details tab in a file's properties; what Windows shows as the program's name).
//!
//! No resource compiler: the icon and the VERSIONINFO are written here as a compiled resource file (.res) in
//! OUT_DIR, which MSVC's linker takes as an input like an object file. The versions follow Cargo.toml.

use std::env;
use std::fs;
use std::path::PathBuf;

const ICON: &str = "obpal-desktop.ico";
const RT_ICON: u16 = 3;
const RT_GROUP_ICON: u16 = 14;
const RT_VERSION: u16 = 16;
/// English (United States): the resources' language, and with Unicode (1200) the version strings' block, 040904B0.
const LANG: u16 = 0x0409;
const CODEPAGE: u16 = 1200;

fn main() {
    println!("cargo:rerun-if-changed={ICON}");
    println!("cargo:rerun-if-changed=build.rs");
    let target = |key: &str| env::var(key).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") != "windows" || target("CARGO_CFG_TARGET_ENV") != "msvc" {
        return;
    }
    let ico = fs::read(ICON).expect("desktop/obpal-desktop.ico (made by node desktop/icon.mjs)");
    let mut res = Vec::new();
    resource(&mut res, 0, 0, 0, 0, &[]); // the empty entry every 32-bit .res file starts with
    let group = icons(&mut res, &ico);
    resource(&mut res, RT_GROUP_ICON, 1, 0x1030, LANG, &group);
    resource(&mut res, RT_VERSION, 1, 0x0030, LANG, &version_info());
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("obpal-desktop.res");
    fs::write(&out, res).expect("write the .res file");
    println!("cargo:rustc-link-arg-bin=obpal-desktop={}", out.display());
}

/// One resource: its header (type and name as numbers, flags, language), then the data, padded to 4 bytes.
fn resource(res: &mut Vec<u8>, kind: u16, name: u16, flags: u16, lang: u16, data: &[u8]) {
    res.extend((data.len() as u32).to_le_bytes());
    res.extend(32u32.to_le_bytes()); // header size
    res.extend([0xFF, 0xFF]);
    res.extend(kind.to_le_bytes());
    res.extend([0xFF, 0xFF]);
    res.extend(name.to_le_bytes());
    res.extend(0u32.to_le_bytes()); // data version
    res.extend(flags.to_le_bytes());
    res.extend(lang.to_le_bytes());
    res.extend(0u32.to_le_bytes()); // version
    res.extend(0u32.to_le_bytes()); // characteristics
    res.extend(data);
    pad(res);
}

/// Each image of the .ico as an RT_ICON resource (numbered from 1), and the RT_GROUP_ICON directory that lists
/// them: the .ico's own directory, with resource numbers in place of file offsets.
fn icons(res: &mut Vec<u8>, ico: &[u8]) -> Vec<u8> {
    let word = |at: usize| u16::from_le_bytes([ico[at], ico[at + 1]]);
    let dword = |at: usize| u32::from_le_bytes([ico[at], ico[at + 1], ico[at + 2], ico[at + 3]]) as usize;
    assert!(ico.len() >= 6 && word(0) == 0 && word(2) == 1, "{ICON} is not an icon file");
    let count = word(4);
    let mut group = Vec::new();
    group.extend(0u16.to_le_bytes());
    group.extend(1u16.to_le_bytes());
    group.extend(count.to_le_bytes());
    for i in 0..count {
        let entry = 6 + 16 * i as usize;
        let (size, offset) = (dword(entry + 8), dword(entry + 12));
        resource(res, RT_ICON, i + 1, 0x1010, LANG, &ico[offset..offset + size]);
        group.extend(&ico[entry..entry + 12]); // width, height, colours, reserved, planes, bits, size
        group.extend((i + 1).to_le_bytes());
    }
    group
}

/// VS_VERSIONINFO: the numeric versions (an application, for 32-bit Windows), then the strings and their language.
fn version_info() -> Vec<u8> {
    let number = |key: &str| env::var(key).expect(key).parse::<u32>().expect(key);
    let (major, minor, patch) = (number("CARGO_PKG_VERSION_MAJOR"), number("CARGO_PKG_VERSION_MINOR"), number("CARGO_PKG_VERSION_PATCH"));
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION");
    let mut fixed = Vec::new();
    for field in [
        0xFEEF_04BD, // signature
        0x0001_0000, // structure version
        major << 16 | minor, // file version
        patch << 16,
        major << 16 | minor, // product version
        patch << 16,
        0x3F, // the flags that mean something
        0, // flags: none (not a debug or prerelease build)
        0x0004_0004, // VOS_NT_WINDOWS32
        1, // VFT_APP
        0, // no subtype
        0, // no file date
        0,
    ] {
        fixed.extend(u32::to_le_bytes(field));
    }
    let strings: Vec<Vec<u8>> = [
        ("CompanyName", "Blackboxes"),
        ("FileDescription", "ob.Pal Desktop"),
        ("FileVersion", version.as_str()),
        ("InternalName", "obpal-desktop"),
        ("LegalCopyright", "Copyright (c) 2026 Club V Crew & Blackboxes Contributors. MIT License."),
        ("OriginalFilename", "obpal-desktop.exe"),
        ("ProductName", "ob.Pal Desktop"),
        ("ProductVersion", version.as_str()),
    ]
    .into_iter()
    .map(|(key, value)| block(key, Value::Text(value), &[]))
    .collect();
    let table = block(&format!("{LANG:04X}{CODEPAGE:04X}"), Value::None, &strings);
    let language = [LANG.to_le_bytes(), CODEPAGE.to_le_bytes()].concat();
    let translation = block("Translation", Value::Binary(&language), &[]);
    block(
        "VS_VERSION_INFO",
        Value::Binary(&fixed),
        &[block("StringFileInfo", Value::None, &[table]), block("VarFileInfo", Value::None, &[translation])],
    )
}

enum Value<'a> {
    None,
    Text(&'a str),
    Binary(&'a [u8]),
}

/// One block of version information: its length, the value's length (characters for text, bytes for binary),
/// the value's type, the key, the value, then the child blocks, each starting on a 4-byte boundary.
fn block(key: &str, value: Value, children: &[Vec<u8>]) -> Vec<u8> {
    let (length, text, bytes) = match value {
        Value::None => (0, 1u16, Vec::new()),
        Value::Text(s) => {
            let b = utf16z(s);
            (b.len() / 2, 1, b)
        }
        Value::Binary(b) => (b.len(), 0, b.to_vec()),
    };
    let mut b = vec![0, 0];
    b.extend((length as u16).to_le_bytes());
    b.extend(text.to_le_bytes());
    b.extend(utf16z(key));
    pad(&mut b);
    b.extend(bytes);
    for child in children {
        pad(&mut b);
        b.extend(child);
    }
    let total = b.len() as u16;
    b[..2].copy_from_slice(&total.to_le_bytes());
    b
}

/// UTF-16LE with the terminating zero.
fn utf16z(s: &str) -> Vec<u8> {
    s.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect()
}

fn pad(b: &mut Vec<u8>) {
    while b.len() % 4 != 0 {
        b.push(0);
    }
}
