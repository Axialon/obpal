//! Unicode event batches, never split inside a UTF-16 surrogate pair.

#[derive(Debug, PartialEq, Eq)]
pub enum Part { Key(u16), Unicode(Vec<u16>) }

pub fn parts(s: &str) -> Vec<Part> {
    let mut out = Vec::new();
    let mut chunk = Vec::new();
    for ch in s.chars() {
        let special = match ch { '\n' => Some(36), '\t' => Some(48), _ => None };
        if special.is_some() || chunk.len() + ch.len_utf16() > 20 {
            if !chunk.is_empty() { out.push(Part::Unicode(std::mem::take(&mut chunk))); }
        }
        if let Some(key) = special { out.push(Part::Key(key)); }
        else { chunk.extend_from_slice(ch.encode_utf16(&mut [0; 2])); }
    }
    if !chunk.is_empty() { out.push(Part::Unicode(chunk)); }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_chunks_keep_characters_and_control_keys_in_order() {
        let s = format!("{}👋é\n\tend", "a".repeat(19));
        let p = parts(&s);
        assert_eq!(p, vec![Part::Unicode(vec![97; 19]), Part::Unicode("👋é".encode_utf16().collect()), Part::Key(36), Part::Key(48), Part::Unicode("end".encode_utf16().collect())]);
        for part in parts(&"👋".repeat(256)) {
            if let Part::Unicode(chunk) = part { assert!(chunk.len() <= 20); assert!(String::from_utf16(&chunk).is_ok()); }
        }
    }
}
