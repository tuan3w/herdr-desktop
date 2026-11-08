//! The `Terminal` view on a headless engine with a real program behind it: that it starts at the size the view has, draws
//! what the program prints, and shows the end of the program.

use nsh_core::{
    element::Root,
    geometry::{px, size},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

use super::view::{line_ends, row_height, terminal};

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
fn Tracking() -> impl IntoElement {
    view().size_full().child(
        terminal()
            .command("printf '\\033[?1000h\\033[?1006h'; cat -v")
            .label("test"),
    )
}

#[component]
fn Plain() -> impl IntoElement {
    view().size_full().child(
        terminal()
            .command("printf 'hello world\\r\\n'; sleep 30")
            .label("test"),
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
    let mut config = EngineConfig {
        viewport: size(px(640.0), px(320.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    // A mouse: a phone has no right click.
    config.environment.os = nsh_core::platform::Os::Linux;
    config.environment.idiom = nsh_core::platform::Idiom::Desktop;
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

#[test]
fn rows_are_whole_points_at_one_and_a_quarter_times_the_size() {
    for (size, rows) in [
        (10.0, 13.0),
        (11.0, 14.0),
        (12.0, 15.0),
        (13.0, 16.0),
        (14.0, 18.0),
        (16.0, 20.0),
    ] {
        assert_eq!(row_height(size), rows, "{size} pt");
    }
}

#[test]
fn pasted_line_ends_are_the_enter_key() {
    assert_eq!(line_ends("a\r\nb\nc"), "a\rb\rc");
}

#[test]
fn a_right_click_is_the_menu_unless_the_program_tracks_the_mouse() {
    let mut app = start::<Plain>();
    app.wait_for("text:hello world").unwrap();
    app.right_click("label:Terminal, test").unwrap();
    let items = app.menu().expect("a context menu");
    let labels: Vec<_> = items.iter().map(|e| e.label.as_str()).collect();
    assert_eq!(labels, ["Copy", "Paste", "Select all", "Clear scrollback"]);
    assert!(items[0].disabled, "nothing is selected: nothing to copy");
    app.choose_menu_item("Select all").unwrap();
    app.right_click("label:Terminal, test").unwrap();
    assert!(
        !app.menu().unwrap()[0].disabled,
        "Select all selected something"
    );
    app.close_menu().unwrap();

    // A program that asked for the mouse is told of the click instead, and no menu opens.
    let mut app = start::<Tracking>();
    app.wait_for("label:Terminal input, test").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    app.right_click("label:Terminal, test").unwrap();
    app.wait_for("text:/<2;/").unwrap();
    assert!(app.menu().is_none());
}

#[component]
fn Nothing() -> impl IntoElement {
    view()
        .size_full()
        .child(terminal().command("").label("test"))
}

#[test]
fn no_command_starts_nothing() {
    let mut app = start::<Nothing>();
    app.wait_for("text:/Could not start the program/").unwrap();
}
