//! Behaviour of `herdr_core::prompt`: what the detector reads off a blocked
//! pane, which answers it offers, and which of them must be confirmed.
//!
//! The cases are the ones herdr-mobile's Dart tests pin (`prompt_detector_test`,
//! `prompt_corpus_test`, `command_risk_test`, `command_risk_hardening_test`,
//! `mode_danger_test`, and the detector-facing parts of the card tests), ported
//! one for one, plus the behaviour the desktop adds around them.

#[path = "prompt/common.rs"]
mod common;
#[path = "prompt/corpus.rs"]
mod corpus;
#[path = "prompt/detector.rs"]
mod detector;
#[path = "prompt/effect.rs"]
mod effect;
#[path = "prompt/extra.rs"]
mod extra;
#[path = "prompt/mode.rs"]
mod mode;
#[path = "prompt/risk.rs"]
mod risk;
#[path = "prompt/ui_cases.rs"]
mod ui_cases;
