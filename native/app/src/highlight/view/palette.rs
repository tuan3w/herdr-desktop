//! The theme's code colours, read once per theme or appearance change.

use std::rc::Rc;

use nsh_base::theme;
use nsh_core::prelude::*;

use crate::highlight::Role;

/// Every `code-*` token as the colour of both appearances, so the view restyles natively when the
/// appearance flips; a theme that lacks a token (an older `theme.json`) falls back to the text colour.
pub struct Colours {
    pub roles: Vec<AdaptiveColor>,
    pub bg: AdaptiveColor,
    pub line_bg: AdaptiveColor,
    pub add_bg: AdaptiveColor,
    pub add_word: AdaptiveColor,
    pub remove_bg: AdaptiveColor,
    pub remove_word: AdaptiveColor,
    pub hunk_bg: AdaptiveColor,
    pub gutter: AdaptiveColor,
    pub whitespace: AdaptiveColor,
    pub border: AdaptiveColor,
    pub transparent: AdaptiveColor,
}

#[derive(Clone)]
pub struct PaletteRef(pub Rc<Colours>);

impl PartialEq for PaletteRef {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

impl Colours {
    pub fn role(&self, role: Role) -> AdaptiveColor {
        self.roles[role as usize]
    }
}

/// The colours of the theme now (read inside a memo: a theme switch or an appearance flip re-runs it).
pub fn palette() -> PaletteRef {
    let theme = theme();
    let get = |name: &str| theme.color(name).unwrap_or(theme.foreground);
    let bg = theme.color("code-bg").unwrap_or(theme.background);
    PaletteRef(Rc::new(Colours {
        roles: Role::ALL
            .iter()
            .map(|r| get(&format!("code-{}", r.name())))
            .collect(),
        bg,
        line_bg: get("code-line-bg"),
        add_bg: get("code-add-bg"),
        add_word: get("code-add-word"),
        remove_bg: get("code-remove-bg"),
        remove_word: get("code-remove-word"),
        hunk_bg: get("code-hunk-bg"),
        gutter: get("code-gutter"),
        whitespace: get("code-whitespace"),
        border: theme.color("code-border").unwrap_or(theme.border),
        transparent: AdaptiveColor::from(Hsla {
            h: 0.0,
            s: 0.0,
            l: 0.0,
            a: 0.0,
        }),
    }))
}
