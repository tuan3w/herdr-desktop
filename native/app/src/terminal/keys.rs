//! Which keystrokes a focused terminal takes for its program, and which stay the app's.
//!
//! nsh 0.4.0 has no raw key event: a view hears a key only by binding its keystroke (`on_key_with`), and a binding of a
//! view wins over the app's of the same keystroke while it exists. So the rule is carried out by *binding*: while the
//! terminal has the keyboard focus it binds every keystroke a terminal program can be sent except [`app_owns`], and the
//! app's own shortcut for each keystroke it did not bind still fires. Printable text does not come through here: it
//! arrives in the terminal's hidden input (so a layout, a dead key or an input method composes it).
//!
//! The rule, in one sentence: **the program gets every key it can encode, the app keeps the chords that a terminal cannot
//! tell apart from a plain one** (`Ctrl+Shift+<letter>` reads as `Ctrl+<letter>` on the wire), `Ctrl+Tab`, `Ctrl+,` and
//! `Ctrl+<digit>`. `Ctrl+Shift+<digit>` (tabs) is therefore always the way out; the palette (`Ctrl+P`) is the program's inside a terminal, so it needs a Ctrl+Shift chord of its own (docs/specs/terminal.md).

use std::collections::BTreeSet;

/// A key, by what it is rather than by the character it types.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Code {
    /// A key typing a printable ASCII character without Shift (lower-case letter, digit, punctuation, space).
    Char(char),
    Enter,
    Escape,
    Tab,
    Backspace,
    Delete,
    Insert,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F(u8),
}

/// Modifier keys, `sup` being Command or the Windows key.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub sup: bool,
}

/// A key press as the program is to be told.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct KeyInput {
    pub code: Code,
    pub mods: Mods,
}

const NAMED: [(&str, Code); 14] = [
    ("enter", Code::Enter),
    ("escape", Code::Escape),
    ("tab", Code::Tab),
    ("backspace", Code::Backspace),
    ("delete", Code::Delete),
    ("insert", Code::Insert),
    ("up", Code::Up),
    ("down", Code::Down),
    ("left", Code::Left),
    ("right", Code::Right),
    ("home", Code::Home),
    ("end", Code::End),
    ("pageup", Code::PageUp),
    ("pagedown", Code::PageDown),
];

/// The keystroke as nsh's `keymap` spells it (`ctrl+alt+left`, `f5`, `shift+tab`, `ctrl+space`), for `key`.
pub fn spell(key: KeyInput) -> String {
    let mut out = String::new();
    for (held, name) in [
        (key.mods.ctrl, "ctrl+"),
        (key.mods.alt, "alt+"),
        (key.mods.shift, "shift+"),
        (key.mods.sup, "cmd+"),
    ] {
        if held {
            out.push_str(name);
        }
    }
    match key.code {
        Code::Char(' ') => out.push_str("space"),
        Code::Char(c) => out.push(c),
        Code::F(n) => out.push_str(&format!("f{n}")),
        code => out.push_str(
            NAMED
                .iter()
                .find(|(_, c)| *c == code)
                .map_or("?", |(n, _)| n),
        ),
    }
    out
}

/// The key a keystroke in nsh's spelling names; `mod` is read as Command when `apple`, else Control.
pub fn parse(keystroke: &str, apple: bool) -> Option<KeyInput> {
    let lower = keystroke.to_ascii_lowercase();
    let (mods_text, key) = match lower.rfind('+') {
        // `ctrl++` is Control and the plus sign's key (`=`): not a terminal key.
        Some(i) if i + 1 == lower.len() => return None,
        Some(i) => (&lower[..i], &lower[i + 1..]),
        None => ("", lower.as_str()),
    };
    let mut mods = Mods::default();
    if !mods_text.is_empty() {
        for m in mods_text.split('+') {
            match m {
                "ctrl" | "control" => mods.ctrl = true,
                "alt" | "option" | "opt" => mods.alt = true,
                "shift" => mods.shift = true,
                "cmd" | "super" | "win" => mods.sup = true,
                "mod" if apple => mods.sup = true,
                "mod" => mods.ctrl = true,
                _ => return None,
            }
        }
    }
    let code = if key == "space" {
        Code::Char(' ')
    } else if let Some((_, code)) = NAMED.iter().find(|(n, _)| *n == key) {
        *code
    } else if let Some(n) = key.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()) {
        if !(1..=24).contains(&n) || key.starts_with("f0") {
            return None;
        }
        Code::F(n)
    } else {
        let mut chars = key.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if c.is_ascii_graphic() => Code::Char(c),
            _ => return None,
        }
    };
    Some(KeyInput { code, mods })
}

/// Whether the app keeps this keystroke while a terminal has the focus (on Windows and Linux, where `mod` is Ctrl and the
/// terminal's own control keys are Ctrl chords; every Command chord is the app's on Apple platforms and no Control chord).
///
/// The app keeps: every chord with Command; every chord with Control *and* Shift (the wire cannot tell it from the plain
/// chord, so a program that wants it must be sent the plain one); `Ctrl+Tab`; Control with a digit or with punctuation a
/// terminal has no control byte for (`Ctrl+,` and so on). The program gets the rest, so Ctrl+K, E, J, N, W, P, F, B and
/// `[ ] \ /` are the shell's and the editor's, not the palette's, the switcher's or the tab's.
pub fn app_owns(key: KeyInput) -> bool {
    let m = key.mods;
    if m.sup {
        return true;
    }
    if m.ctrl && m.shift {
        return true;
    }
    if m.ctrl {
        return match key.code {
            Code::Tab => true,
            Code::Char(c) => !(c.is_ascii_lowercase() || matches!(c, '[' | ']' | '\\' | '/' | ' ')),
            _ => false,
        };
    }
    false
}

/// The keys a terminal binds while it has the focus: everything a program can be sent that is not [`app_owns`], in nsh's
/// spelling, in a fixed order. Text keys (a letter, digit or punctuation key with no Control or Alt, and Shift on its own)
/// are not here: they arrive as text.
pub fn bound(apple: bool) -> Vec<String> {
    let mut keys: BTreeSet<KeyInput> = BTreeSet::new();
    let none = Mods::default();
    let mut named: Vec<Code> = NAMED.iter().map(|(_, c)| *c).collect();
    named.extend((1..=24).map(Code::F));
    for code in named {
        for (shift, ctrl, alt) in [
            (false, false, false),
            (true, false, false),
            (false, true, false),
            (false, false, true),
            (true, false, true),
            (false, true, true),
        ] {
            keys.insert(KeyInput {
                code,
                mods: Mods {
                    shift,
                    ctrl,
                    alt,
                    ..none
                },
            });
        }
    }
    let letters = 'a'..='z';
    let punctuation = ['[', ']', '\\', '/', ';', '\'', ',', '.', '-', '=', '`'];
    // Control: the characters that have a control byte.
    for c in letters.clone().chain(['[', ']', '\\', '/', ' ']) {
        keys.insert(KeyInput {
            code: Code::Char(c),
            mods: Mods { ctrl: true, ..none },
        });
    }
    // Alt (Meta): an ESC prefix. Not on Apple platforms, where Option types characters.
    if !apple {
        for c in letters
            .clone()
            .chain('0'..='9')
            .chain(punctuation)
            .chain([' '])
        {
            keys.insert(KeyInput {
                code: Code::Char(c),
                mods: Mods { alt: true, ..none },
            });
        }
        for c in letters {
            keys.insert(KeyInput {
                code: Code::Char(c),
                mods: Mods {
                    alt: true,
                    shift: true,
                    ..none
                },
            });
        }
    }
    keys.into_iter()
        .filter(|k| !app_owns(*k))
        .filter(|k| !(apple && k.mods.alt && matches!(k.code, Code::Char(_))))
        .map(spell)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &str) -> KeyInput {
        parse(s, false).unwrap_or_else(|| panic!("{s}"))
    }

    #[test]
    fn spelling_round_trips() {
        for s in [
            "enter",
            "ctrl+k",
            "alt+x",
            "shift+tab",
            "ctrl+space",
            "ctrl+alt+left",
            "f5",
            "ctrl+[",
            "alt+shift+f",
        ] {
            assert_eq!(spell(key(s)), s);
        }
        assert_eq!(key("mod+k"), key("ctrl+k"));
        assert_eq!(parse("mod+k", true), parse("cmd+k", true));
        assert_eq!(parse("ctrl++", false), None);
        assert_eq!(parse("f25", false), None);
        assert_eq!(parse("banana", false), None);
    }

    #[test]
    fn the_program_gets_the_controls_the_palette_and_the_tabs_used_to_take() {
        let bound = bound(false);
        for k in [
            "ctrl+k",
            "ctrl+e",
            "ctrl+j",
            "ctrl+n",
            "ctrl+w",
            "ctrl+p",
            "ctrl+f",
            "ctrl+b",
            "ctrl+z",
            "ctrl+[",
            "ctrl+]",
            "ctrl+\\",
            "ctrl+/",
            "ctrl+c",
            "ctrl+d",
            "ctrl+l",
            "ctrl+r",
            "ctrl+u",
            "ctrl+a",
            "ctrl+space",
            "escape",
            "tab",
            "shift+tab",
            "up",
            "ctrl+left",
            "alt+left",
            "alt+b",
            "alt+shift+f",
            "f1",
            "f12",
            "alt+enter",
            "ctrl+enter",
        ] {
            assert!(
                bound.contains(&k.to_owned()),
                "{k} should reach the program"
            );
        }
    }

    #[test]
    fn the_app_keeps_what_a_terminal_cannot_tell_apart_and_so_there_is_always_a_way_out() {
        let bound = bound(false);
        for k in [
            "ctrl+shift+p",
            "ctrl+shift+j",
            "ctrl+shift+1",
            "ctrl+shift+[",
            "ctrl+shift+k",
            "ctrl+shift+left",
            "ctrl+tab",
            "ctrl+shift+tab",
            "ctrl+,",
            "ctrl+0",
            "ctrl+1",
            "ctrl+9",
            "cmd+k",
        ] {
            assert!(!bound.contains(&k.to_owned()), "{k} must stay the app's");
        }
        // The palette chord and the tab chords are all reserved, whatever else changes.
        assert!(app_owns(key("ctrl+shift+p")));
        for n in 1..=9 {
            assert!(app_owns(key(&format!("ctrl+shift+{n}"))));
        }
    }

    #[test]
    fn plain_text_is_never_bound_so_layouts_and_input_methods_type_it() {
        let bound = bound(false);
        for k in [
            "a",
            "shift+a",
            "1",
            "shift+1",
            "space",
            "shift+space",
            "/",
            ".",
            "ctrl+alt+a",
            "ctrl+alt+q",
        ] {
            assert!(!bound.contains(&k.to_owned()), "{k} is text or AltGr");
        }
    }

    #[test]
    fn on_apple_platforms_control_is_the_programs_command_is_the_apps_and_option_types_text() {
        let bound = bound(true);
        assert!(bound.contains(&"ctrl+k".to_owned()));
        assert!(bound.contains(&"ctrl+left".to_owned()));
        assert!(!bound.iter().any(|k| k.starts_with("alt+") && k.len() == 5));
        assert!(!bound.iter().any(|k| k.contains("cmd")));
        assert!(app_owns(parse("mod+c", true).unwrap()));
    }

    #[test]
    fn every_bound_key_parses() {
        for apple in [false, true] {
            for k in bound(apple) {
                assert!(parse(&k, apple).is_some(), "{k}");
            }
        }
    }
}
