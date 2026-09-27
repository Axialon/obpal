//! Whether a text field has the keyboard focus, from UI Automation: the phone offers its keyboard while one does.
//!
//! A thread in COM's multithreaded apartment asks UI Automation for the focused element about four times a
//! second and classifies it (`classify`): an edit box whose Value pattern is not read-only, an editable combo box,
//! a document whose Value pattern is not read-only, or an editable region of a web page, is a text field; a
//! password field (IsPassword) is a secret; anything else, anything that fails, and every elevated window (typing
//! can't reach it) is no text field. One cached request per look reads the control type and flags (IsPassword,
//! which patterns it has, IsReadOnly), never a value or any other text.
//!
//! The answer is kept with the foreground window it was taken in, in one atomic word, so a window that has just
//! come to the front shows no text field until its own answer is in.
//!
//! Cost: a UI Automation client makes Chrome (and other Chromium browsers and Electron apps) build their
//! accessibility tree, which takes memory and CPU while they keep it. That is a known cost of this watcher. It
//! runs only while the helper serves the extension (`WinForeground::watching_focus`), never for `install`,
//! `uninstall` or `status`, and stops with it.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::System::Variant::{VariantClear, VT_BOOL};
use windows::Win32::UI::Accessibility::{
    AutomationElementMode_None, CUIAutomation, CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest, IUIAutomationElement,
    TreeScope_Element, UIA_ComboBoxControlTypeId, UIA_ControlTypePropertyId, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_GroupControlTypeId,
    UIA_IsPasswordPropertyId, UIA_IsTextPatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId, UIA_ValueIsReadOnlyPropertyId, UIA_CONTROLTYPE_ID,
    UIA_PROPERTY_ID,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use super::foreground::{integrity_level, MEDIUM_IL};
use crate::protocol::TextFocus;

/// How often the focused element is looked at.
pub const POLL: Duration = Duration::from_millis(250);
/// UI Automation's connection and call timeouts, shortened from 2 s and 20 s: a hung program must not hold the
/// watcher for long.
const TIMEOUT_MS: u32 = 1000;

/// What UI Automation says about an element, as far as typing goes: its control type and flags, nothing it holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Element {
    pub control: UIA_CONTROLTYPE_ID,
    pub password: bool,
    /// The Value pattern's IsReadOnly; None when the element has no Value pattern.
    pub read_only: Option<bool>,
    /// It has the Text pattern (text with a caret, as in a text box or an editor).
    pub text: bool,
}

/// Is the element a text field, a password field, or neither? An edit box is a text field unless its value is
/// read-only. A document is one when its value is editable (an editor rather than a page). A combo box is one
/// when its value is editable and it has the Text pattern: a drop-down list's value can be set by choosing, so
/// its Value pattern isn't read-only either (a Win32 drop-down list, a page's `<select>`), but only one you type
/// into has text. A group is one when it has the Text pattern, unless its value is read-only: that is how
/// Chromium shows an editable region of a page (`contenteditable`), and other groups there don't have it.
pub fn classify(e: &Element) -> Option<TextFocus> {
    let editable = if e.control == UIA_EditControlTypeId {
        e.read_only != Some(true)
    } else if e.control == UIA_DocumentControlTypeId {
        e.read_only == Some(false)
    } else if e.control == UIA_ComboBoxControlTypeId {
        e.read_only == Some(false) && e.text
    } else if e.control == UIA_GroupControlTypeId {
        e.text && e.read_only != Some(true)
    } else {
        false
    };
    match (editable, e.password) {
        (false, _) => None,
        (true, true) => Some(TextFocus::Secret),
        (true, false) => Some(TextFocus::Text),
    }
}

/// An answer and the window it belongs to, in one word: the window handle (32 significant bits, also on 64-bit
/// Windows) above, the kind below.
fn pack(hwnd: HWND, kind: Option<TextFocus>) -> u64 {
    let k = match kind {
        None => 0,
        Some(TextFocus::Text) => 1,
        Some(TextFocus::Secret) => 2,
    };
    (u64::from(hwnd.0 as usize as u32) << 32) | k
}

fn unpack(word: u64, hwnd: HWND) -> Option<TextFocus> {
    if (word >> 32) as u32 != hwnd.0 as usize as u32 {
        return None;
    }
    match word & 0xFF {
        1 => Some(TextFocus::Text),
        2 => Some(TextFocus::Secret),
        _ => None,
    }
}

/// The watcher thread's handle: the latest answer, and the flag that stops the thread (on drop, within one poll).
pub struct FocusWatcher {
    state: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
}

impl FocusWatcher {
    /// Start watching. None when the thread can't start; where UI Automation can't be created, it never finds a text field.
    pub fn start() -> Option<FocusWatcher> {
        let state = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (s, st) = (state.clone(), stop.clone());
        thread::Builder::new().name("text-focus".into()).spawn(move || watch(&s, &st)).ok()?;
        Some(FocusWatcher { state, stop })
    }

    /// What has the keyboard focus in `hwnd`, the foreground window; None until the watcher has looked at it.
    pub fn kind_in(&self, hwnd: HWND) -> Option<TextFocus> {
        unpack(self.state.load(Ordering::Acquire), hwnd)
    }
}

impl Drop for FocusWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn watch(state: &AtomicU64, stop: &AtomicBool) {
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
        if let Some(uia) = Uia::new() {
            let my_il = integrity_level(GetCurrentProcess()).unwrap_or(MEDIUM_IL);
            let mut last = None;
            while !stop.load(Ordering::Acquire) {
                let hwnd = GetForegroundWindow();
                let kind = if hwnd.0.is_null() || outranks(hwnd, my_il, &mut last) { None } else { uia.focused() };
                // A window that came to the front meanwhile gets nothing that was seen in another one.
                let now = GetForegroundWindow();
                state.store(pack(now, if now == hwnd { kind } else { None }), Ordering::Release);
                thread::sleep(POLL);
            }
        }
        CoUninitialize();
    }
}

/// Whether the process behind `hwnd` runs above our integrity level, or can't be looked at (then it usually does).
/// `last` keeps the answer for the last window, so an unchanged foreground costs no process query.
unsafe fn outranks(hwnd: HWND, my_il: u32, last: &mut Option<(isize, u32, bool)>) -> bool {
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if let Some((h, p, above)) = *last {
        if h == hwnd.0 as isize && p == pid {
            return above;
        }
    }
    let above = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(h) => {
            let il = integrity_level(h);
            CloseHandle(h).ok();
            il.map_or(true, |il| il > my_il)
        }
        Err(_) => true,
    };
    *last = Some((hwnd.0 as isize, pid, above));
    above
}

/// A UI Automation client and its one cache request: an element's control type and flags in a single call, with
/// no live reference to the element kept.
struct Uia {
    automation: IUIAutomation,
    cache: IUIAutomationCacheRequest,
}

impl Uia {
    unsafe fn new() -> Option<Uia> {
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
            .or_else(|_| CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER))
            .ok()?;
        if let Ok(a2) = automation.cast::<IUIAutomation2>() {
            a2.SetConnectionTimeout(TIMEOUT_MS).ok();
            a2.SetTransactionTimeout(TIMEOUT_MS).ok();
        }
        let cache = automation.CreateCacheRequest().ok()?;
        for id in [
            UIA_ControlTypePropertyId,
            UIA_IsPasswordPropertyId,
            UIA_IsValuePatternAvailablePropertyId,
            UIA_ValueIsReadOnlyPropertyId,
            UIA_IsTextPatternAvailablePropertyId,
        ] {
            cache.AddProperty(id).ok()?;
        }
        cache.SetTreeScope(TreeScope_Element).ok()?;
        cache.SetAutomationElementMode(AutomationElementMode_None).ok()?;
        Some(Uia { automation, cache })
    }

    /// The focused element, classified. Nothing focused, a window that went away or a timeout is None.
    unsafe fn focused(&self) -> Option<TextFocus> {
        classify(&element(&self.automation.GetFocusedElementBuildCache(&self.cache).ok()?)?)
    }
}

/// The flags of an element fetched with `Uia`'s cache request.
unsafe fn element(el: &IUIAutomationElement) -> Option<Element> {
    Some(Element {
        control: el.CachedControlType().ok()?,
        password: el.CachedIsPassword().is_ok_and(|p| p.as_bool()),
        read_only: match cached_bool(el, UIA_IsValuePatternAvailablePropertyId) {
            Some(true) => cached_bool(el, UIA_ValueIsReadOnlyPropertyId),
            _ => None,
        },
        text: cached_bool(el, UIA_IsTextPatternAvailablePropertyId) == Some(true),
    })
}

/// A cached boolean property, or None when the element doesn't support it (UI Automation then hands back its
/// "not supported" object, released here with the variant).
unsafe fn cached_bool(el: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<bool> {
    let mut v = el.GetCachedPropertyValueEx(id, true).ok()?;
    let b = (v.Anonymous.Anonymous.vt == VT_BOOL).then(|| v.Anonymous.Anonymous.Anonymous.boolVal.0 != 0);
    VariantClear(&mut v).ok();
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, LoadLibraryW};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{UIA_ButtonControlTypeId, UIA_CheckBoxControlTypeId, UIA_DataGridControlTypeId, UIA_TextControlTypeId};
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, FindWindowExW, GetMessageW, PostThreadMessageW, TranslateMessage, CBS_DROPDOWN,
        CBS_DROPDOWNLIST, ES_MULTILINE, ES_PASSWORD, ES_READONLY, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_QUIT, WS_CHILD, WS_OVERLAPPEDWINDOW,
    };

    const TEXT: Option<TextFocus> = Some(TextFocus::Text);
    const SECRET: Option<TextFocus> = Some(TextFocus::Secret);

    /// The rows follow what Chromium (Playwright's build) and standard Win32 controls report through UI Automation.
    #[test]
    fn text_fields_are_told_by_control_type_and_flags() {
        let (edit, combo, doc, group) = (UIA_EditControlTypeId, UIA_ComboBoxControlTypeId, UIA_DocumentControlTypeId, UIA_GroupControlTypeId);
        let el = |control, password, read_only, text| Element { control, password, read_only, text };
        for (e, want) in [
            (el(edit, false, Some(false), true), TEXT), // <input>, <textarea>, role=textbox, the address bar, EDIT
            (el(edit, false, None, false), TEXT),       // an edit box without a Value pattern
            (el(edit, false, Some(true), true), None),  // readonly or disabled
            (el(edit, true, Some(false), true), SECRET), // <input type=password>, ES_PASSWORD
            (el(edit, true, None, false), SECRET),
            (el(edit, true, Some(true), false), None),
            (el(combo, false, Some(false), true), TEXT), // <input list>, role=combobox on an input
            (el(combo, false, Some(false), false), None), // <select>, a drop-down list: chosen, not typed
            (el(combo, false, Some(true), true), None),
            (el(combo, false, None, true), None),
            (el(doc, false, Some(false), true), TEXT), // designMode, a multi-line EDIT, rich edit
            (el(doc, false, Some(true), true), None),  // a web page itself
            (el(doc, false, None, false), None),       // role=document
            (el(group, false, None, true), TEXT),      // contenteditable
            (el(group, false, None, false), None),     // a focusable <div>, contenteditable=false
            (el(group, false, Some(true), true), None),
            (el(UIA_DataGridControlTypeId, false, Some(false), false), None), // role=grid: a Value pattern, no text
            (el(UIA_CheckBoxControlTypeId, false, Some(false), false), None),
            (el(UIA_ButtonControlTypeId, false, None, false), None),
            (el(UIA_TextControlTypeId, false, None, true), None),
        ] {
            assert_eq!(classify(&e), want, "{e:?}");
        }
    }

    #[test]
    fn an_answer_belongs_to_the_window_it_was_taken_in() {
        let (a, b) = (HWND(0x1234_5678usize as _), HWND(0x0001_0ABCusize as _));
        for kind in [None, TEXT, SECRET] {
            assert_eq!(unpack(pack(a, kind), a), kind);
            assert_eq!(unpack(pack(a, kind), b), None);
        }
        assert_eq!(unpack(0, HWND(std::ptr::null_mut())), None, "the first word, before any look");
        assert_eq!(unpack(pack(HWND(std::ptr::null_mut()), None), a), None);
    }

    /// Standard Win32 controls in a window that is never shown or activated, classified through UI Automation with
    /// the watcher's own cache request, by window handle rather than by focus: no input, and the foreground stays
    /// where it is.
    #[test]
    fn win32_controls_are_classified_through_ui_automation() {
        let (tx, rx) = mpsc::channel();
        let ui = thread::spawn(move || unsafe {
            let hinst = GetModuleHandleW(None).unwrap();
            let rich = LoadLibraryW(w!("msftedit.dll")).is_ok();
            let parent =
                CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("ob.Pal focus test"), WS_OVERLAPPEDWINDOW, 0, 0, 400, 300, None, None, Some(hinst.into()), None).unwrap();
            let child = |class: PCWSTR, style: i32| {
                let h = CreateWindowExW(WINDOW_EX_STYLE(0), class, PCWSTR::null(), WS_CHILD | WINDOW_STYLE(style as u32), 0, 0, 200, 80, Some(parent), None, Some(hinst.into()), None);
                h.unwrap().0 as isize
            };
            let combo = child(w!("COMBOBOX"), CBS_DROPDOWN);
            // An editable combo box types into its own edit box, which is what has the focus.
            let combo_edit = FindWindowExW(Some(HWND(combo as _)), None, w!("Edit"), PCWSTR::null()).unwrap().0 as isize;
            let mut controls = vec![
                ("edit", child(w!("EDIT"), 0), TEXT),
                ("multi-line edit", child(w!("EDIT"), ES_MULTILINE), TEXT),
                ("read-only edit", child(w!("EDIT"), ES_READONLY), None),
                ("password edit", child(w!("EDIT"), ES_PASSWORD), SECRET),
                ("editable combo box's edit box", combo_edit, TEXT),
                ("drop-down list", child(w!("COMBOBOX"), CBS_DROPDOWNLIST), None),
                ("button", child(w!("BUTTON"), 0), None),
                ("label", child(w!("STATIC"), 0), None),
            ];
            if rich {
                controls.push(("rich edit", child(w!("RICHEDIT50W"), ES_MULTILINE), TEXT));
                controls.push(("read-only rich edit", child(w!("RICHEDIT50W"), ES_MULTILINE | ES_READONLY), None));
            }
            tx.send((GetCurrentThreadId(), controls)).unwrap();
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = DestroyWindow(parent);
        });
        let (ui_thread, controls) = rx.recv().unwrap();
        let mut seen = Vec::new();
        unsafe {
            assert!(CoInitializeEx(None, COINIT_MULTITHREADED).is_ok());
            match Uia::new() {
                None => eprintln!("skipped: UI Automation is not available here"),
                Some(uia) => {
                    for (name, hwnd, want) in controls {
                        let el = uia.automation.ElementFromHandleBuildCache(HWND(hwnd as _), &uia.cache).ok();
                        seen.push((name, el.and_then(|el| element(&el)), want));
                    }
                }
            }
            CoUninitialize();
            PostThreadMessageW(ui_thread, WM_QUIT, WPARAM(0), LPARAM(0)).unwrap();
        }
        ui.join().unwrap();
        for (name, el, want) in seen {
            assert_eq!(el.as_ref().and_then(classify), want, "{name}: {el:?}");
        }
    }
}
