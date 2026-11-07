//! The `Terminal` view on a headless engine with a real program behind it: that it starts at the size the view has, draws
//! what the program prints, and shows the end of the program.

use nsh_core::{
    element::Root,
    geometry::{px, size},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

use super::view::terminal;

#[component]
fn Shell() -> impl IntoElement {
    view().size_full().child(
        terminal()
            .command("printf 'hello from a pty\\r\\n\\033[31mred\\033[0m\\r\\n'; sleep 30")
            .label("test")
            .font_size(12.0),
    )
}

#[component]
fn Ends() -> impl IntoElement {
    view()
        .size_full()
        .child(terminal().command("echo bye; exit 4").label("test"))
}

fn start<C: Component>() -> Headless
where
    C::Props: Default,
{
    // SAFETY: every test sets the same value.
    unsafe { std::env::set_var("HERDR_DESKTOP_TERMINAL", "1") };
    let config = EngineConfig {
        viewport: size(px(640.0), px(320.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    Headless::start(config).expect("the engine starts")
}

#[test]
fn the_program_prints_and_the_view_draws_it_in_rows() {
    let mut app = start::<Shell>();
    app.wait_for("text:hello from a pty").unwrap();
    app.wait_for("text:red").unwrap();
}

#[test]
fn an_ended_program_says_so_and_offers_restart() {
    let mut app = start::<Ends>();
    app.wait_for("text:bye").unwrap();
    app.wait_for("text:The program ended with status 4")
        .unwrap();
    assert!(app.screen().matches("label:Restart").unwrap());
}
