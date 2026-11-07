//! When to tell the person, and what to say: the rules of `docs/ALERTS.md` as a pure state machine.
//!
//! [`Policy::step`] takes what the board shows right now (a [`Frame`]) and the time, and returns the
//! notifications to show and to withdraw. It does no I/O and reads no clock, so every rule is tested by
//! moving an [`Instant`] forward instead of waiting. The rules are herdr-mobile's `AttentionNotifier`:
//!
//! * transitions, not states: an agent is announced when it *becomes* blocked (or, with the second
//!   switch, finished and not reviewed) and its machine is reachable; what was already so when the
//!   window went away is taken as seen;
//! * one notification per agent per episode (`machine`, `pane`, `state_change_seq`); the episode ends
//!   when the agent is seen in another state or gone, and then its notification is withdrawn; an
//!   unreachable machine does not end it;
//! * at most [`BURST_LIMIT`] notifications of their own per burst, the rest one summary
//!   (`5 agents need you`); an agent announced in the last [`FLAP_WINDOW`] waits for the minute to pass;
//! * nothing is posted while the window is in front, and coming back withdraws everything.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use herdr_core::prompt::{PromptInfo, answerable_from_notification};

/// Agents that get a notification of their own in one burst; the rest are summarised.
pub const BURST_LIMIT: usize = 3;
/// Announcements this close to the first of a burst belong to it.
pub const BURST_WINDOW: Duration = Duration::from_secs(5);
/// An agent that was announced is announced again no sooner than this.
pub const FLAP_WINDOW: Duration = Duration::from_secs(60);
/// How long a blocked agent's question may take to be read before it is announced without one.
pub const QUESTION_WAIT: Duration = Duration::from_secs(3);
/// A command longer than this is not shown whole in a notification, so it is not offered for approval.
pub const SHOWN_SUBJECT_MAX: usize = 640;
/// Answer buttons on one notification.
pub const MAX_BUTTONS: usize = 2;
/// A title is cut to this many characters.
const TITLE_MAX: usize = 60;
/// A button's text is cut to this many characters.
const BUTTON_MAX: usize = 22;
/// The freedesktop action a click on the notification invokes.
pub const DEFAULT_ACTION: &str = "default";

/// What news an item is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// The agent is blocked on a question.
    NeedsYou,
    /// The agent finished and nobody has looked yet.
    Finished,
}

/// Where a click on a notification goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// That agent's pane.
    Agent {
        /// The machine's id.
        machine: String,
        /// The pane's id.
        pane: String,
    },
    /// The board (a summary).
    Board,
}

/// What is known of a blocked agent's question.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Question {
    /// The pane has not been read for this episode yet.
    Unread,
    /// It was read; `None` when the screen shows no question the app understands.
    Read(Option<PromptInfo>),
}

/// One agent in a state worth telling about, as the board has it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    /// The machine's id.
    pub machine: String,
    /// The pane's id.
    pub pane: String,
    /// herdr's number of the state episode.
    pub seq: u64,
    /// What kind of news it is.
    pub kind: Kind,
    /// Its machine is connected: news from a link that is down is not news yet.
    pub reachable: bool,
    /// What the person calls the agent.
    pub name: String,
    /// `claude on devbox`.
    pub place: String,
    /// The question, for a blocked agent.
    pub question: Question,
}

/// Everything one step needs to know.
#[derive(Debug, Clone, Copy)]
pub struct Frame<'a> {
    /// The window is not in front.
    pub away: bool,
    /// `Notify me when an agent needs me`.
    pub needs_you: bool,
    /// `Also when an agent finishes` (only with `needs_you`).
    pub also_done: bool,
    /// Agents in a state worth telling about; only read while `away` and enabled.
    pub items: &'a [Item],
}

/// One answer button of a notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Button {
    /// The option's words, cut to fit.
    pub label: String,
    /// Index into the prompt's options.
    pub index: usize,
    /// The question the button was made for: the answer is sent only if the pane still shows it.
    pub digest: String,
}

/// A notification to show. Showing one with an `id` already live replaces it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    /// Ours, stable for an agent's episode.
    pub id: u64,
    /// The headline.
    pub title: String,
    /// The question, the command and where the agent runs.
    pub body: String,
    /// Up to [`MAX_BUTTONS`] one-tap answers.
    pub buttons: Vec<Button>,
    /// Where a click goes.
    pub target: Target,
    /// Stays until dealt with (a blocked agent) rather than fading.
    pub persistent: bool,
}

/// What to do with the desktop's notifications.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    /// Show it, or replace the one with the same id.
    Show(Notification),
    /// Withdraw it.
    Close(u64),
}

/// What pressing something on a notification asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Press {
    /// Nothing: unknown or already spent.
    Nothing,
    /// Bring the app to the front and show this.
    Open(Target),
    /// Send an answer, if the pane still shows the question.
    Answer {
        /// The notification it was pressed on.
        id: u64,
        /// The machine's id.
        machine: String,
        /// The pane's id.
        pane: String,
        /// The question the button was made for.
        digest: String,
        /// The option to send.
        index: usize,
    },
}

/// How an answer from a notification ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    /// The keys went to the pane.
    Yes,
    /// Nothing was sent; the text says why.
    No(String),
}

struct Track {
    seq: u64,
    kind: Kind,
    id: u64,
    posted: bool,
    summarized: bool,
    /// Announce once the question is known (or the wait is over) and the machine reachable.
    pending: bool,
    /// A flapping agent is announced at this time, if it is still in the state.
    due: Option<Instant>,
    /// Announce without a question after this.
    wait_until: Instant,
}

struct Live {
    target: Target,
    buttons: Vec<Button>,
    spent: bool,
}

/// The rules. One per app.
#[derive(Default)]
pub struct Policy {
    away: bool,
    enabled: bool,
    also_done: bool,
    tracks: HashMap<(String, String), Track>,
    announced: HashMap<(String, String, Kind), Instant>,
    burst: Option<(Instant, usize)>,
    summary: HashMap<Kind, usize>,
    live: HashMap<u64, Live>,
    next_id: u64,
}

fn summary_id(kind: Kind) -> u64 {
    match kind {
        Kind::NeedsYou => 1,
        Kind::Finished => 2,
    }
}

impl Policy {
    /// A policy that has seen nothing and has nothing shown.
    pub fn new() -> Self {
        Self {
            next_id: 100,
            ..Self::default()
        }
    }

    /// Whether anything of ours is on the desktop (so a withdrawal may still be due).
    pub fn has_live(&self) -> bool {
        !self.live.is_empty()
    }

    /// Forgets every notification and returns their ids, for the app to withdraw (it is stopping).
    pub fn close_all(&mut self) -> Vec<u64> {
        let mut out = Vec::new();
        self.reset(&mut out);
        out.into_iter()
            .filter_map(|c| match c {
                Cmd::Close(id) => Some(id),
                Cmd::Show(_) => None,
            })
            .collect()
    }

    /// Whether the frame's items matter: only while away and switched on.
    pub fn wants_items(frame_away: bool, needs_you: bool) -> bool {
        frame_away && needs_you
    }

    /// The next time a step is due without anything changing: a flapping agent's minute, a question's
    /// wait.
    pub fn next_wake(&self) -> Option<Instant> {
        self.tracks
            .values()
            .flat_map(|t| t.due.into_iter().chain(t.pending.then_some(t.wait_until)))
            .min()
    }

    /// Applies what the board shows now.
    pub fn step(&mut self, now: Instant, frame: &Frame<'_>) -> Vec<Cmd> {
        let mut out = Vec::new();
        let (was_away, was_enabled, was_also_done) = (self.away, self.enabled, self.also_done);
        self.away = frame.away;
        self.enabled = frame.needs_you;
        self.also_done = frame.needs_you && frame.also_done;

        // Switched off, or the window is in front again: nothing is pending, nothing is shown.
        if (was_enabled && !self.enabled) || (was_away && !self.away) {
            self.reset(&mut out);
            return out;
        }
        if !self.enabled || !self.away {
            return out;
        }
        let items: Vec<&Item> = frame
            .items
            .iter()
            .filter(|i| i.kind == Kind::NeedsYou || self.also_done)
            .collect();
        // What is already so when the window goes away (or the switch goes on) is not news.
        if !was_away || !was_enabled || (self.also_done && !was_also_done) {
            for item in &items {
                let key = (item.machine.clone(), item.pane.clone());
                if !self.tracks.contains_key(&key) {
                    let track = self.fresh_track(item, now, false);
                    self.tracks.insert(key, track);
                }
            }
        }
        self.follow(now, &items, &mut out);
        out
    }

    fn fresh_track(&mut self, item: &Item, now: Instant, pending: bool) -> Track {
        self.next_id += 1;
        Track {
            seq: item.seq,
            kind: item.kind,
            id: self.next_id,
            posted: false,
            summarized: false,
            pending,
            due: None,
            wait_until: now + QUESTION_WAIT,
        }
    }

    fn reset(&mut self, out: &mut Vec<Cmd>) {
        let mut ids: Vec<u64> = self.live.drain().map(|(id, _)| id).collect();
        ids.sort_unstable();
        out.extend(ids.into_iter().map(Cmd::Close));
        self.tracks.clear();
        self.announced.clear();
        self.burst = None;
        self.summary.clear();
    }

    fn close(&mut self, id: u64, out: &mut Vec<Cmd>) {
        if self.live.remove(&id).is_some() {
            out.push(Cmd::Close(id));
        }
    }

    fn follow(&mut self, now: Instant, items: &[&Item], out: &mut Vec<Cmd>) {
        let seen: HashMap<(&str, &str), &Item> = items
            .iter()
            .map(|i| ((i.machine.as_str(), i.pane.as_str()), *i))
            .collect();

        // Episodes that ended: the agent is in another state, or gone. One that is merely out of reach
        // stays in the list with its last known state, so it goes on.
        let ended: Vec<(String, String)> = self
            .tracks
            .iter()
            .filter(|((m, p), t)| {
                seen.get(&(m.as_str(), p.as_str()))
                    .is_none_or(|i| i.kind != t.kind || i.seq != t.seq)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for key in ended {
            if let Some(track) = self.tracks.remove(&key) {
                self.close(track.id, out);
            }
        }

        self.announced
            .retain(|_, at| now.saturating_duration_since(*at) < FLAP_WINDOW);

        // New episodes, what needs the person first; only what can be reached.
        for kind in [Kind::NeedsYou, Kind::Finished] {
            for item in items.iter().filter(|i| i.kind == kind && i.reachable) {
                let key = (item.machine.clone(), item.pane.clone());
                if self.tracks.contains_key(&key) {
                    continue;
                }
                let mut track = self.fresh_track(item, now, true);
                let last = self
                    .announced
                    .get(&(key.0.clone(), key.1.clone(), kind))
                    .copied();
                if let Some(at) = last {
                    // Announced a moment ago: say it again when the minute is up, if still so.
                    track.pending = false;
                    track.due = Some(at + FLAP_WINDOW);
                }
                self.tracks.insert(key, track);
            }
        }

        // A flapping agent whose minute is up.
        for item in items {
            let key = (item.machine.clone(), item.pane.clone());
            if let Some(track) = self.tracks.get_mut(&key)
                && track.due.is_some_and(|due| now >= due)
            {
                track.due = None;
                // Out of reach at the minute: nothing to announce, nothing to retry.
                track.pending = item.reachable;
                track.wait_until = now + QUESTION_WAIT;
            }
        }

        // Announce what is ready, in board order.
        for item in items {
            let key = (item.machine.clone(), item.pane.clone());
            let ready = self.tracks.get(&key).is_some_and(|t| {
                t.pending
                    && item.reachable
                    && (item.kind == Kind::Finished
                        || matches!(item.question, Question::Read(_))
                        || now >= t.wait_until)
            });
            if ready {
                self.announce(&key, item, now, out);
            }
        }

        self.update_summaries(out);
    }

    fn announce(&mut self, key: &(String, String), item: &Item, now: Instant, out: &mut Vec<Cmd>) {
        match &mut self.burst {
            Some((start, _)) if now.saturating_duration_since(*start) < BURST_WINDOW => {}
            slot => *slot = Some((now, 0)),
        }
        self.announced
            .insert((key.0.clone(), key.1.clone(), item.kind), now);
        let (posted, id) = {
            let Some(track) = self.tracks.get_mut(key) else {
                return;
            };
            track.pending = false;
            let burst = self.burst.as_mut().map(|b| &mut b.1);
            let room = burst.as_ref().is_some_and(|n| **n < BURST_LIMIT);
            if room {
                if let Some(n) = burst {
                    *n += 1;
                }
                track.posted = true;
            } else {
                track.summarized = true;
            }
            (track.posted, track.id)
        };
        if posted {
            let notification = notification_for(id, item);
            self.live.insert(
                id,
                Live {
                    target: notification.target.clone(),
                    buttons: notification.buttons.clone(),
                    spent: false,
                },
            );
            out.push(Cmd::Show(notification));
        }
    }

    /// One summary per kind for the agents the burst limit held back: how many there are now (those
    /// with a notification of their own too), replaced as that changes, gone when none held back is left.
    fn update_summaries(&mut self, out: &mut Vec<Cmd>) {
        for kind in [Kind::NeedsYou, Kind::Finished] {
            let mut held = false;
            let mut count = 0;
            for track in self.tracks.values().filter(|t| t.kind == kind) {
                held |= track.summarized;
                count += usize::from(track.summarized || track.posted);
            }
            let id = summary_id(kind);
            let shown = self.summary.get(&kind).copied();
            let want = held.then_some(count);
            if want == shown {
                continue;
            }
            match want {
                None => {
                    self.summary.remove(&kind);
                    self.close(id, out);
                }
                Some(n) => {
                    self.summary.insert(kind, n);
                    let (title, persistent) = match kind {
                        Kind::NeedsYou => (format!("{n} agents need you"), true),
                        Kind::Finished => (format!("{n} agents finished"), false),
                    };
                    self.live.insert(
                        id,
                        Live {
                            target: Target::Board,
                            buttons: Vec::new(),
                            spent: false,
                        },
                    );
                    out.push(Cmd::Show(Notification {
                        id,
                        title,
                        body: "Open Herdr Desktop to see which".to_owned(),
                        buttons: Vec::new(),
                        target: Target::Board,
                        persistent,
                    }));
                }
            }
        }
    }

    /// Something was pressed on notification `id`: its body (`DEFAULT_ACTION`) or answer button `n`
    /// (`answer:n`). A button is spent by its first press, before anything is sent, so it cannot send
    /// twice.
    pub fn press(&mut self, id: u64, action: &str) -> Press {
        let Some(live) = self.live.get_mut(&id) else {
            return Press::Nothing;
        };
        if action == DEFAULT_ACTION {
            return Press::Open(live.target.clone());
        }
        let Some(button) = action
            .strip_prefix("answer:")
            .and_then(|n| n.parse::<usize>().ok())
            .and_then(|n| live.buttons.get(n))
        else {
            return Press::Nothing;
        };
        if live.spent {
            return Press::Nothing;
        }
        live.spent = true;
        let Target::Agent { machine, pane } = &live.target else {
            return Press::Nothing;
        };
        Press::Answer {
            id,
            machine: machine.clone(),
            pane: pane.clone(),
            digest: button.digest.clone(),
            index: button.index,
        }
    }

    /// An answer from notification `id` ended. Sent: withdrawn, and the agent's next question is news
    /// at once. Not sent: the notification says so (replacing the question: its buttons are gone).
    pub fn answered(&mut self, id: u64, sent: &Sent) -> Vec<Cmd> {
        let mut out = Vec::new();
        let Some(live) = self.live.get_mut(&id) else {
            return out;
        };
        let target = live.target.clone();
        match sent {
            Sent::Yes => {
                if let Target::Agent { machine, pane } = &target {
                    self.announced
                        .remove(&(machine.clone(), pane.clone(), Kind::NeedsYou));
                }
                self.close(id, &mut out);
            }
            Sent::No(why) => {
                live.buttons.clear();
                out.push(Cmd::Show(Notification {
                    id,
                    title: "Answer not sent".to_owned(),
                    body: why.clone(),
                    buttons: Vec::new(),
                    target,
                    persistent: true,
                }));
            }
        }
        out
    }

    /// The person dismissed or the desktop expired notification `id`: it is gone, its agent still
    /// needs them and is not announced again.
    pub fn gone(&mut self, id: u64) {
        self.live.remove(&id);
    }
}

fn notification_for(id: u64, item: &Item) -> Notification {
    let target = Target::Agent {
        machine: item.machine.clone(),
        pane: item.pane.clone(),
    };
    match item.kind {
        Kind::Finished => Notification {
            id,
            title: cut(&format!("{} finished", one_line(&item.name)), TITLE_MAX),
            body: item.place.clone(),
            buttons: Vec::new(),
            target,
            persistent: false,
        },
        Kind::NeedsYou => {
            let prompt = match &item.question {
                Question::Read(Some(prompt)) => Some(prompt),
                _ => None,
            };
            let mut body = Vec::new();
            let mut buttons = Vec::new();
            if let Some(prompt) = prompt {
                body.push(prompt.question.clone());
                let subject = prompt.subject.as_deref().unwrap_or("");
                if !subject.is_empty() {
                    body.push(subject.to_owned());
                }
                // A command too long to be shown whole is not one to approve from here.
                if subject.chars().count() <= SHOWN_SUBJECT_MAX {
                    for (index, reply) in prompt.options.iter().enumerate() {
                        if buttons.len() == MAX_BUTTONS {
                            break;
                        }
                        if answerable_from_notification(reply) {
                            buttons.push(Button {
                                label: cut(&one_line(&reply.label), BUTTON_MAX),
                                index,
                                digest: prompt.digest.clone(),
                            });
                        }
                    }
                }
            }
            body.push(item.place.clone());
            Notification {
                id,
                title: cut(&format!("{} needs you", one_line(&item.name)), TITLE_MAX),
                body: body.join("\n"),
                buttons,
                target,
                persistent: true,
            }
        }
    }
}

/// `s` on one line.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `s` cut to `max` characters, with an ellipsis.
fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut cut: String = s.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;
    use herdr_core::prompt::{PromptInfo, QuickReply, Risk};

    fn item(pane: &str, seq: u64) -> Item {
        Item {
            machine: "local".to_owned(),
            pane: pane.to_owned(),
            seq,
            kind: Kind::NeedsYou,
            reachable: true,
            name: format!("agent {pane}"),
            place: "claude on this computer".to_owned(),
            question: Question::Read(None),
        }
    }

    fn done(pane: &str, seq: u64) -> Item {
        Item {
            kind: Kind::Finished,
            ..item(pane, seq)
        }
    }

    fn reply(label: &str, keys: &[&str], risk: Option<Risk>) -> QuickReply {
        QuickReply {
            label: label.to_owned(),
            keys: keys.iter().map(|k| (*k).to_owned()).collect(),
            risk,
            standing_grant: false,
        }
    }

    fn asking(pane: &str, subject: &str, options: Vec<QuickReply>) -> Item {
        Item {
            question: Question::Read(Some(PromptInfo {
                question: "Do you want to run this command?".to_owned(),
                subject: Some(subject.to_owned()),
                options,
                digest: "d1".to_owned(),
            })),
            ..item(pane, 1)
        }
    }

    struct Rig {
        policy: Policy,
        start: Instant,
        at: Duration,
        away: bool,
        needs_you: bool,
        also_done: bool,
    }

    impl Rig {
        fn new() -> Self {
            Self {
                policy: Policy::new(),
                start: Instant::now(),
                at: Duration::ZERO,
                away: false,
                needs_you: true,
                also_done: false,
            }
        }

        fn step(&mut self, items: &[Item]) -> Vec<Cmd> {
            let frame = Frame {
                away: self.away,
                needs_you: self.needs_you,
                also_done: self.also_done,
                items: if self.away && self.needs_you {
                    items
                } else {
                    &[]
                },
            };
            self.policy.step(self.start + self.at, &frame)
        }

        fn later(&mut self, secs: u64) {
            self.at += Duration::from_secs(secs);
        }
    }

    fn shown(cmds: &[Cmd]) -> Vec<&Notification> {
        cmds.iter()
            .filter_map(|c| match c {
                Cmd::Show(n) => Some(n),
                Cmd::Close(_) => None,
            })
            .collect()
    }

    fn closed(cmds: &[Cmd]) -> usize {
        cmds.iter().filter(|c| matches!(c, Cmd::Close(_))).count()
    }

    #[test]
    fn nothing_is_posted_while_the_window_is_in_front_or_the_setting_is_off() {
        let mut rig = Rig::new();
        assert!(rig.step(&[item("p1", 1)]).is_empty());
        rig.away = true;
        rig.needs_you = false;
        assert!(rig.step(&[item("p1", 1)]).is_empty());
        rig.away = false;
        rig.needs_you = true;
        assert!(rig.step(&[item("p1", 1), item("p2", 1)]).is_empty());
    }

    #[test]
    fn an_agent_that_becomes_blocked_while_away_is_announced_once() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        assert!(rig.step(&[]).is_empty());
        let cmds = rig.step(&[item("p1", 1)]);
        let shown = shown(&cmds);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].title, "agent p1 needs you");
        assert!(rig.step(&[item("p1", 1)]).is_empty(), "no repeat");
    }

    #[test]
    fn what_was_already_blocked_when_the_window_went_away_is_not_announced() {
        let mut rig = Rig::new();
        rig.step(&[item("old", 3)]);
        rig.away = true;
        assert!(rig.step(&[item("old", 3)]).is_empty());
        assert!(rig.step(&[item("old", 3)]).is_empty());
        let cmds = rig.step(&[item("old", 3), item("new", 1)]);
        assert_eq!(shown(&cmds).len(), 1);
        assert_eq!(shown(&cmds)[0].title, "agent new needs you");
        // The baseline also covers a machine that was out of reach when the window left.
        let mut rig = Rig::new();
        rig.away = true;
        let mut cut_off = item("far", 2);
        cut_off.reachable = false;
        assert!(rig.step(std::slice::from_ref(&cut_off)).is_empty());
        cut_off.reachable = true;
        assert!(
            rig.step(&[cut_off]).is_empty(),
            "last known state counts as seen"
        );
    }

    #[test]
    fn a_notification_is_withdrawn_when_its_agent_stops_needing_you() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let id = shown(&rig.step(&[item("p1", 1)]))[0].id;
        let cmds = rig.step(&[]);
        assert_eq!(cmds, vec![Cmd::Close(id)]);
        // Answered elsewhere and asking again (a new episode) is news after the minute.
    }

    #[test]
    fn an_unreachable_machine_does_not_withdraw_what_was_announced() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let blocked = item("p1", 1);
        assert_eq!(shown(&rig.step(std::slice::from_ref(&blocked))).len(), 1);
        let mut cut_off = blocked.clone();
        cut_off.reachable = false;
        assert!(rig.step(&[cut_off]).is_empty());
        assert!(rig.step(&[blocked]).is_empty(), "same episode, not again");
    }

    #[test]
    fn a_burst_of_five_gives_three_notifications_and_one_summary_that_follows_the_count() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let five: Vec<Item> = (1..=5).map(|n| item(&format!("p{n}"), 1)).collect();
        let cmds = rig.step(&five);
        let shown_now = shown(&cmds);
        assert_eq!(shown_now.len(), 4);
        assert_eq!(
            shown_now
                .iter()
                .filter(|n| n.target != Target::Board)
                .count(),
            3
        );
        let summary = shown_now
            .iter()
            .find(|n| n.target == Target::Board)
            .expect("a summary");
        assert_eq!(summary.title, "5 agents need you");

        // One of the held-back ones is answered: the summary says 4. Both held back: it goes.
        let four: Vec<Item> = five[..4].to_vec();
        let cmds = rig.step(&four);
        assert_eq!(shown(&cmds)[0].title, "4 agents need you");
        let cmds = rig.step(&five[..3]);
        assert_eq!(cmds, vec![Cmd::Close(summary.id)]);
    }

    #[test]
    fn a_new_burst_after_the_window_gets_its_own_three() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let first: Vec<Item> = (1..=3).map(|n| item(&format!("a{n}"), 1)).collect();
        assert_eq!(shown(&rig.step(&first)).len(), 3);
        rig.later(6);
        let mut more = first.clone();
        more.push(item("b1", 1));
        let cmds = rig.step(&more);
        assert_eq!(shown(&cmds).len(), 1);
        assert_eq!(
            shown(&cmds)[0].target.clone(),
            Target::Agent {
                machine: "local".to_owned(),
                pane: "b1".to_owned()
            }
        );
    }

    #[test]
    fn an_agent_that_flaps_is_announced_at_most_once_a_minute() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        assert_eq!(shown(&rig.step(&[item("p1", 1)])).len(), 1);
        rig.later(2);
        assert_eq!(closed(&rig.step(&[])), 1, "it went back to work");
        rig.later(2);
        assert!(rig.step(&[item("p1", 2)]).is_empty(), "blocked again: held");
        assert_eq!(
            rig.policy.next_wake(),
            Some(rig.start + FLAP_WINDOW),
            "the minute counts from the first announcement"
        );
        rig.later(30);
        assert!(rig.step(&[item("p1", 2)]).is_empty());
        rig.later(30);
        assert_eq!(
            shown(&rig.step(&[item("p1", 2)])).len(),
            1,
            "still blocked after the minute"
        );

        // Held, then it stops needing you before the minute: nothing is ever shown.
        rig.later(1);
        rig.step(&[]);
        rig.later(1);
        rig.step(&[item("p1", 3)]);
        rig.later(1);
        assert!(rig.step(&[]).is_empty());
        rig.later(120);
        assert!(rig.step(&[]).is_empty());
    }

    #[test]
    fn coming_back_withdraws_everything_and_forgets_the_episodes() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let five: Vec<Item> = (1..=5).map(|n| item(&format!("p{n}"), 1)).collect();
        rig.step(&five);
        rig.away = false;
        let cmds = rig.step(&five);
        assert_eq!(closed(&cmds), 4, "three agents and the summary");
        assert!(shown(&cmds).is_empty());
        assert!(!rig.policy.has_live());
        // Going away again: what is blocked then is the new baseline.
        rig.later(1);
        rig.away = true;
        assert!(rig.step(&five).is_empty());
    }

    #[test]
    fn switching_off_withdraws_and_switching_on_while_away_takes_the_current_state_as_seen() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        rig.step(&[item("p1", 1)]);
        rig.needs_you = false;
        assert_eq!(closed(&rig.step(&[item("p1", 1)])), 1);
        rig.needs_you = true;
        assert!(rig.step(&[item("p1", 1)]).is_empty());
    }

    #[test]
    fn finished_agents_are_announced_only_with_the_second_switch() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        assert!(rig.step(&[done("p1", 1)]).is_empty());
        rig.also_done = true;
        assert!(
            rig.step(&[done("p1", 1)]).is_empty(),
            "already finished when it went on"
        );
        let cmds = rig.step(&[done("p1", 1), done("p2", 1)]);
        assert_eq!(shown(&cmds).len(), 1);
        assert_eq!(shown(&cmds)[0].title, "agent p2 finished");
        assert!(!shown(&cmds)[0].persistent);
    }

    #[test]
    fn the_notification_shows_the_question_and_the_command_and_offers_only_plain_answers() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let blocked = asking(
            "p1",
            "git status",
            vec![
                reply("1. Yes", &["1", "enter"], None),
                reply("2. Yes, push it", &["2", "enter"], Some(Risk::Pushes)),
                reply("3. No", &["3", "enter"], None),
            ],
        );
        let cmds = rig.step(&[blocked]);
        let n = shown(&cmds)[0];
        assert!(n.body.contains("Do you want to run this command?"));
        assert!(n.body.contains("git status"), "the command is in the text");
        assert!(n.body.ends_with("claude on this computer"));
        let labels: Vec<_> = n
            .buttons
            .iter()
            .map(|b| (b.label.as_str(), b.index))
            .collect();
        assert_eq!(
            labels,
            [("1. Yes", 0), ("3. No", 2)],
            "the risky one is left off"
        );
    }

    #[test]
    fn a_standing_grant_and_a_long_command_get_no_buttons() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let grant = asking(
            "p1",
            "ls",
            vec![reply("1. Yes, and don't ask again", &["1"], None)],
        );
        assert!(shown(&rig.step(&[grant]))[0].buttons.is_empty());
        let long = asking(
            "p2",
            &"x".repeat(SHOWN_SUBJECT_MAX + 1),
            vec![reply("1. Yes", &["1"], None)],
        );
        let cmds = rig.step(&[asking("p1", "ls", vec![]), long]);
        let n = shown(&cmds)[0];
        assert!(n.buttons.is_empty());
        assert!(n.body.contains(&"x".repeat(SHOWN_SUBJECT_MAX + 1)));
        let ok = asking(
            "p3",
            &"x".repeat(SHOWN_SUBJECT_MAX),
            vec![
                reply("1. Yes", &["1"], None),
                reply("2. Always edits", &["2"], None),
                reply("3. No", &["3"], None),
                reply("4. Maybe", &["4"], None),
            ],
        );
        let cmds = rig.step(&[asking("p1", "ls", vec![]), asking("p2", "x", vec![]), ok]);
        assert_eq!(shown(&cmds)[0].buttons.len(), MAX_BUTTONS);
    }

    #[test]
    fn the_announcement_waits_for_the_question_but_not_for_ever() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let mut unread = item("p1", 1);
        unread.question = Question::Unread;
        assert!(rig.step(std::slice::from_ref(&unread)).is_empty());
        assert_eq!(rig.policy.next_wake(), Some(rig.start + QUESTION_WAIT));
        rig.later(1);
        assert!(rig.step(std::slice::from_ref(&unread)).is_empty());
        // The read lands: announced with the question.
        let read = asking("p1", "ls", vec![reply("1. Yes", &["1"], None)]);
        let cmds = rig.step(&[read]);
        assert_eq!(shown(&cmds).len(), 1);
        assert_eq!(shown(&cmds)[0].buttons.len(), 1);

        // A read that never lands: announced without one after the wait.
        let mut other = item("p2", 1);
        other.question = Question::Unread;
        rig.step(std::slice::from_ref(&other));
        rig.later(4);
        let cmds = rig.step(&[other]);
        assert_eq!(shown(&cmds).len(), 1);
        assert!(shown(&cmds)[0].buttons.is_empty());
    }

    #[test]
    fn a_button_press_is_spent_once_and_a_click_opens_the_agent() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let cmds = rig.step(&[asking("p1", "ls", vec![reply("1. Yes", &["1"], None)])]);
        let id = shown(&cmds)[0].id;
        assert_eq!(
            rig.policy.press(id, DEFAULT_ACTION),
            Press::Open(Target::Agent {
                machine: "local".to_owned(),
                pane: "p1".to_owned()
            })
        );
        let first = rig.policy.press(id, "answer:0");
        assert!(matches!(first, Press::Answer { index: 0, .. }), "{first:?}");
        assert_eq!(rig.policy.press(id, "answer:0"), Press::Nothing, "spent");
        assert_eq!(rig.policy.press(id, "answer:7"), Press::Nothing);
        assert_eq!(rig.policy.press(9999, "answer:0"), Press::Nothing);
    }

    #[test]
    fn an_answer_not_sent_replaces_the_question_and_one_that_was_sent_withdraws_it() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let blocked = asking("p1", "ls", vec![reply("1. Yes", &["1"], None)]);
        let id = shown(&rig.step(std::slice::from_ref(&blocked)))[0].id;
        rig.policy.press(id, "answer:0");
        let cmds = rig
            .policy
            .answered(id, &Sent::No("The question changed".to_owned()));
        let n = shown(&cmds)[0];
        assert_eq!((n.id, n.title.as_str()), (id, "Answer not sent"));
        assert!(n.buttons.is_empty());
        assert_eq!(rig.policy.press(id, "answer:0"), Press::Nothing);

        let other = asking("p2", "ls", vec![reply("1. Yes", &["1"], None)]);
        let id = shown(&rig.step(&[blocked, other]))[0].id;
        assert_eq!(rig.policy.answered(id, &Sent::Yes), vec![Cmd::Close(id)]);
    }

    #[test]
    fn a_dismissed_notification_is_not_posted_again_for_the_same_episode() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let id = shown(&rig.step(&[item("p1", 1)]))[0].id;
        rig.policy.gone(id);
        assert!(rig.step(&[item("p1", 1)]).is_empty());
    }

    #[test]
    fn a_new_question_from_an_agent_that_was_answered_from_a_notification_is_news_at_once() {
        let mut rig = Rig::new();
        rig.step(&[]);
        rig.away = true;
        rig.step(&[]);
        let blocked = asking("p1", "ls", vec![reply("1. Yes", &["1"], None)]);
        let id = shown(&rig.step(&[blocked]))[0].id;
        rig.policy.answered(id, &Sent::Yes);
        rig.later(2);
        rig.step(&[]);
        rig.later(2);
        let again = Item {
            seq: 2,
            ..asking("p1", "rm file", vec![reply("1. Yes", &["1"], None)])
        };
        assert_eq!(
            shown(&rig.step(&[again])).len(),
            1,
            "not held for the minute"
        );
    }
}
