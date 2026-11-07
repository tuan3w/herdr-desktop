//! What a person types in the palette against what exists: golden orders, folding, scopes, filters and typos.

use herdr_core::search::{Field, Focus, Index, Item, Kind, KindSet, Mode, Request};

fn item(kind: Kind, title: &str) -> Item {
    Item {
        kind,
        title: title.to_owned(),
        title_mode: Mode::Name,
        fields: Vec::new(),
        aliases: Vec::new(),
        frecency: 0.0,
        project: None,
        machine: None,
        machine_name: String::new(),
        project_name: String::new(),
        tags: Vec::new(),
        disabled: false,
    }
}

fn agent(title: &str, project: &str, machine: &str) -> Item {
    Item {
        fields: vec![Field::name(project, 0.6), Field::name(machine, 0.4)],
        project: Some(project.to_owned()),
        machine: Some(machine.to_owned()),
        machine_name: machine.to_owned(),
        project_name: project.to_owned(),
        tags: vec!["chat"],
        ..item(Kind::Agent, title)
    }
}

fn request(query: &str) -> Request {
    Request {
        query: query.to_owned(),
        kinds: KindSet::of(&[
            Kind::Agent,
            Kind::Project,
            Kind::Command,
            Kind::Setting,
            Kind::Theme,
            Kind::Machine,
        ]),
        focus: Focus::default(),
        limit: 50,
        caps: Vec::new(),
    }
}

fn titles(items: &[Item], index: &Index, req: &Request) -> Vec<String> {
    index
        .search(req)
        .hits
        .iter()
        .map(|h| items[h.item].title.clone())
        .collect()
}

#[test]
fn a_name_beats_a_project_match_and_every_word_must_match() {
    let items = vec![
        agent("refactor ledger", "payments", "gpu-box"),
        agent("payments api", "payments", "gpu-box"),
        agent("docs pass", "site", "this computer"),
    ];
    let index = Index::new(&items);
    assert_eq!(titles(&items, &index, &request("pay"))[0], "payments api");
    assert_eq!(
        titles(&items, &index, &request("ledger pay")),
        vec!["refactor ledger"]
    );
    assert!(titles(&items, &index, &request("ledger zzz")).is_empty());
}

#[test]
fn dinh_finds_the_vietnamese_name_and_the_marks_underline_the_original_letters() {
    let items = vec![
        item(Kind::Project, "Định tuyến"),
        item(Kind::Project, "docs"),
    ];
    let index = Index::new(&items);
    let page = index.search(&request("dinh"));
    assert_eq!(page.hits.len(), 1);
    assert_eq!(page.hits[0].marks, vec![(0, 4)]);
}

#[test]
fn a_synonym_finds_the_command_and_says_which_one_won() {
    let mut split = item(Kind::Command, "Split pane right in herdr");
    split.aliases = vec!["new terminal".to_owned()];
    let items = vec![split, item(Kind::Command, "Settings")];
    let index = Index::new(&items);
    let page = index.search(&request("terminal"));
    assert_eq!(page.hits.len(), 1);
    assert_eq!(page.hits[0].alias, Some(0));
    assert!(page.hits[0].marks.is_empty());
}

#[test]
fn frecency_breaks_a_tie_but_never_beats_a_better_match() {
    let mut often = agent("ledger notes", "x", "m");
    often.frecency = 50.0;
    let items = vec![
        agent("ledger", "x", "m"),
        often,
        agent("l e d g e r", "x", "m"),
    ];
    let index = Index::new(&items);
    let order = titles(&items, &index, &request("ledger"));
    // The exact name is the best match; the frequent one is next, the scattered one is last.
    assert_eq!(order, vec!["ledger", "ledger notes", "l e d g e r"]);
}

#[test]
fn the_focused_project_ranks_a_little_higher() {
    let items = vec![
        agent("api server", "infra", "m"),
        agent("api client", "payments", "m"),
    ];
    let index = Index::new(&items);
    let mut req = request("api");
    assert_eq!(titles(&items, &index, &req)[0], "api server");
    req.focus.project = Some("payments".to_owned());
    assert_eq!(titles(&items, &index, &req)[0], "api client");
}

#[test]
fn the_same_query_gives_the_same_order() {
    let items: Vec<Item> = (0..300)
        .map(|i| agent(&format!("agent {}", i % 7), "p", "m"))
        .collect();
    let index = Index::new(&items);
    let a = titles(&items, &index, &request("agent 3"));
    let b = titles(&items, &index, &request("agent 3"));
    assert_eq!(a, b);
    assert!(!a.is_empty());
}

#[test]
fn a_disabled_command_matches_but_ranks_last() {
    let mut off = item(Kind::Command, "Close pane in herdr");
    off.disabled = true;
    let items = vec![
        off,
        item(Kind::Command, "Close tab"),
        item(Kind::Command, "close"),
    ];
    let index = Index::new(&items);
    let order = titles(&items, &index, &request("close"));
    assert_eq!(order.last().unwrap(), "Close pane in herdr");
    assert_eq!(order.len(), 3);
}

#[test]
fn a_typo_finds_the_name_only_when_little_else_matched() {
    let items = vec![agent("payments api", "p", "m"), agent("docs", "d", "m")];
    let index = Index::new(&items);
    assert_eq!(
        titles(&items, &index, &request("paymnets")),
        vec!["payments api"]
    );
    // Three letters: one edit is a different word.
    assert!(titles(&items, &index, &request("dcs")).len() <= 1);
    assert!(titles(&items, &index, &request("pyaments")).contains(&"payments api".to_owned()));
}

#[test]
fn a_typo_never_replaces_strict_results() {
    let items: Vec<Item> = ["alpha one", "alpha two", "alpha three", "alpho four"]
        .iter()
        .map(|t| item(Kind::Project, t))
        .collect();
    let index = Index::new(&items);
    let order = titles(&items, &index, &request("alpha"));
    assert!(
        !order.contains(&"alpho four".to_owned()),
        "strict hits are enough: {order:?}"
    );
}

#[test]
fn filters_narrow_by_machine_project_and_state() {
    let mut waiting = agent("migrate", "ledger", "gpu-box");
    waiting.tags = vec!["needs", "chat"];
    let items = vec![
        waiting,
        agent("migrate db", "ledger", "this computer"),
        agent("migrate ui", "site", "gpu-box"),
    ];
    let index = Index::new(&items);
    assert_eq!(
        titles(&items, &index, &request("migrate on:gpu in:ledger")),
        vec!["migrate"]
    );
    assert_eq!(
        titles(&items, &index, &request("migrate is:needs")),
        vec!["migrate"]
    );
    let page = index.search(&request("migrate is:ne"));
    assert_eq!(page.filters, vec!["is:ne"]);
    // An unfinished or unknown filter is just text and hides nothing it did not match.
    assert!(titles(&items, &index, &request("migrate is:zzz")).is_empty());
}

#[test]
fn scopes_and_caps_limit_what_is_listed() {
    let mut items = vec![agent("notes agent", "p", "m"), item(Kind::Project, "notes")];
    for i in 0..6 {
        items.push(Item {
            title_mode: Mode::Text,
            ..item(Kind::Message, &format!("remember the notes {i}"))
        });
    }
    let index = Index::new(&items);
    let mut req = request("notes");
    req.kinds = KindSet::of(&[Kind::Agent, Kind::Project, Kind::Message]);
    req.caps = vec![(Kind::Message, 3)];
    let page = index.search(&req);
    assert_eq!(
        page.hits
            .iter()
            .filter(|h| items[h.item].kind == Kind::Message)
            .count(),
        3
    );
    assert_eq!(page.total, 8);
    req.kinds = KindSet::of(&[Kind::Project]);
    assert_eq!(titles(&items, &index, &req), vec!["notes"]);
}

#[test]
fn a_longer_query_starts_from_the_last_matches_and_agrees_with_a_cold_search() {
    let items: Vec<Item> = (0..400)
        .map(|i| agent(&format!("task {i} of service {}", i % 13), "proj", "m"))
        .collect();
    let warm = Index::new(&items);
    for q in ["s", "se", "ser", "serv", "service 1", "service 12"] {
        warm.search(&request(q));
    }
    let cold = Index::new(&items);
    let want = titles(&items, &cold, &request("service 12"));
    assert_eq!(titles(&items, &warm, &request("service 12")), want);
    // And a different filter set does not reuse them.
    assert_eq!(
        titles(&items, &warm, &request("service 12 in:zzz")),
        Vec::<String>::new()
    );
}

#[test]
fn long_text_matches_a_word_start_not_a_subsequence() {
    let mut message = item(Kind::Message, "retry the payments job once more");
    message.title_mode = Mode::Text;
    let items = vec![message];
    let index = Index::new(&items);
    let mut req = request("pay");
    req.kinds = KindSet::of(&[Kind::Message]);
    let page = index.search(&req);
    assert_eq!(page.hits.len(), 1);
    assert_eq!(page.hits[0].marks, vec![(10, 13)]);
    req.query = "rpj".to_owned();
    assert!(index.search(&req).hits.is_empty());
}
