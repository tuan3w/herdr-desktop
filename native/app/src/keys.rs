//! Capture mode's key table: which keystrokes `pane.send_keys` carries and under which herdr names.
//!
//! A pane mirror has no terminal behind it: herdr takes text through `pane.send_text` and everything
//! that is not text through `pane.send_keys` as key-combo strings (`esc`, `enter`, `shift+tab`,
//! `ctrl+c`, `alt+x`, `f5`). Capture mode therefore asks this table about every keystroke it hears
//! (in nsh's `keymap` spelling) and sends text itself when the answer is `None`. Names come from
//! herdr's key-combo documentation (`esc` is canonical, `escape` an alias); `home`, `end`, `pageup`,
//! `pagedown`, `delete`, `insert` and `space` follow the same lower-case naming but the herdr
//! documentation lists none of them, so they are the names herdr most likely accepts: herdr validates
//! every key before writing a byte, so a wrong name fails the whole send loudly, never half-types.

use nsh_core::prelude::*;

/// The keys herdr names the way nsh does, apart from `escape`.
const NAMED: [&str; 13] = [
    "enter",
    "tab",
    "backspace",
    "delete",
    "insert",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
];

/// The herdr key name of `keystroke` (nsh's `keymap` spelling: modifiers and a key joined by `+`, in
/// any case), or `None` when it is not a key herdr takes: text (a letter, digit or punctuation with no
/// `ctrl` or `alt`, or with only `shift`) goes through `pane.send_text`; `mod`, `cmd`, `meta`,
/// `super` and `win` chords are the app's own shortcuts, never the pane's; punctuation chords
/// (`ctrl+/`) have no herdr name here.
///
/// Modifiers come out in the order `ctrl`, `alt`, `shift`.
pub fn herdr_key(keystroke: &str) -> Option<String> {
    let keystroke = keystroke.to_ascii_lowercase();
    let mut parts: Vec<&str> = keystroke.split('+').collect();
    let key = parts.pop().filter(|key| !key.is_empty())?;
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    for modifier in parts {
        match modifier {
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" | "opt" => alt = true,
            "shift" => shift = true,
            _ => return None,
        }
    }
    let chord = ctrl || alt;
    let name = match key {
        "escape" | "esc" => "esc",
        "space" if chord => "space",
        key if NAMED.contains(&key) => key,
        key if is_function_key(key) => key,
        // A letter or digit is a key only as part of a chord; alone (or shifted) it is typed text.
        key if chord && key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() => key,
        _ => return None,
    };
    let mut out = String::new();
    for (held, modifier) in [(ctrl, "ctrl"), (alt, "alt"), (shift, "shift")] {
        if held {
            out.push_str(modifier);
            out.push('+');
        }
    }
    out.push_str(name);
    Some(out)
}

/// `f1` to `f24`, the range nsh's `keymap` spells.
fn is_function_key(key: &str) -> bool {
    key.strip_prefix('f')
        .and_then(|n| n.parse::<u8>().ok())
        .is_some_and(|n| (1..=24).contains(&n))
        && !key.starts_with("f0")
}

/// The pane's keyboard: what capture mode needs to forward a keystroke.
#[module]
pub struct PaneKeys;

#[module]
impl PaneKeys {
    /// The herdr key name (for `Herdr.sendKeys`) that carries `keystroke`, as `keymap` spells it
    /// (`"ctrl+c"`, `"shift+tab"`, `"escape"`, `"f5"`); `null` when it is not a key herdr takes and
    /// the text it types (if any) belongs to `Herdr.sendText`: plain letters, digits and
    /// punctuation, and `shift+letter`. The app's own shortcuts (`mod`, `cmd`, `meta`, `super`,
    /// `win`) are never keys.
    pub fn herdr_key(keystroke: String) -> Option<String> {
        herdr_key(&keystroke)
    }
}

#[cfg(test)]
mod tests {
    use super::herdr_key;

    fn key(keystroke: &str) -> Option<String> {
        herdr_key(keystroke)
    }

    fn assert_sends(typed: &str, sent: &str) {
        assert_eq!(key(typed).as_deref(), Some(sent), "{typed}");
    }

    #[test]
    fn control_keys_map_to_herdr_names() {
        for (typed, sent) in [
            ("escape", "esc"),
            ("esc", "esc"),
            ("enter", "enter"),
            ("tab", "tab"),
            ("shift+tab", "shift+tab"),
            ("backspace", "backspace"),
            ("delete", "delete"),
            ("up", "up"),
            ("down", "down"),
            ("left", "left"),
            ("right", "right"),
            ("home", "home"),
            ("end", "end"),
            ("pageup", "pageup"),
            ("pagedown", "pagedown"),
            ("insert", "insert"),
            ("f1", "f1"),
            ("f12", "f12"),
            ("f24", "f24"),
        ] {
            assert_sends(typed, sent);
        }
    }

    #[test]
    fn a_chord_names_its_modifiers_in_a_fixed_order() {
        assert_sends("ctrl+c", "ctrl+c");
        assert_sends("control+d", "ctrl+d");
        assert_sends("Ctrl+C", "ctrl+c");
        assert_sends("alt+x", "alt+x");
        assert_sends("option+1", "alt+1");
        assert_sends("shift+ctrl+a", "ctrl+shift+a");
        assert_sends("alt+ctrl+left", "ctrl+alt+left");
        assert_sends("ctrl+space", "ctrl+space");
        assert_sends("shift+up", "shift+up");
        assert_sends("ctrl+enter", "ctrl+enter");
    }

    #[test]
    fn typed_text_is_not_a_key() {
        for typed in [
            "a", "A", "z", "5", "space", "shift+a", "shift+5", "/", "shift+/", "plus",
        ] {
            assert_eq!(key(typed), None, "{typed} is text");
        }
    }

    #[test]
    fn the_apps_own_shortcuts_never_reach_the_pane() {
        for typed in [
            "mod+k",
            "cmdorctrl+c",
            "cmd+c",
            "meta+x",
            "super+l",
            "win+e",
            "ctrl+cmd+c",
        ] {
            assert_eq!(key(typed), None, "{typed}");
        }
    }

    #[test]
    fn what_herdr_has_no_name_for_is_refused() {
        for typed in [
            "",
            "+",
            "ctrl+",
            "ctrl+/",
            "ctrl+plus",
            "f0",
            "f25",
            "f01",
            "ctrl+ab",
            "banana",
        ] {
            assert_eq!(key(typed), None, "{typed:?}");
        }
    }
}
