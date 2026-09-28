//! Accessibility roles describe the focused control, never its contents.

use crate::protocol::TextFocus;

pub fn classify(role: &str, subrole: &str, enabled: bool, editable: Option<bool>) -> Option<TextFocus> {
    if !enabled || editable == Some(false) { return None; }
    if subrole == "AXSecureTextField" || role == "AXSecureTextField" { return Some(TextFocus::Secret); }
    match role {
        "AXTextField" | "AXTextArea" => Some(TextFocus::Text),
        "AXComboBox" if editable == Some(true) => Some(TextFocus::Text),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_roles_without_reading_values() {
        for role in ["AXTextField", "AXTextArea"] {
            assert_eq!(classify(role, "", true, None), Some(TextFocus::Text));
            assert_eq!(classify(role, "", true, Some(false)), None);
            assert_eq!(classify(role, "", false, Some(true)), None);
        }
        assert_eq!(classify("AXTextField", "AXSecureTextField", true, None), Some(TextFocus::Secret));
        assert_eq!(classify("AXSecureTextField", "", true, None), Some(TextFocus::Secret));
        assert_eq!(classify("AXComboBox", "", true, Some(true)), Some(TextFocus::Text));
        for role in ["AXButton", "AXStaticText", "AXWebArea", "AXGroup", "AXComboBox", ""] { assert_eq!(classify(role, "", true, None), None); }
    }
}
