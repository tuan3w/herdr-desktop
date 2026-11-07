//! What ACP says about an agent session besides its rows: a message's pictures and files, a tool call's
//! files, what the agent can do, how to sign in to it, what the session costs. Plain objects built from
//! `herdr-core`'s `AcpInfo` and `Part`; doc comments become TypeScript doc comments.

use herdr_core::session::{self as core, PartKind};
use nsh_core::prelude::*;

/// What a non-text block of a message or a tool's output is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum PartKindName {
    /// A picture.
    Image,
    /// Sound.
    Audio,
    /// A file the message points at (its text has an `@name` line for it).
    File,
    /// A file the message includes (embedded context).
    Resource,
}

/// A picture, sound or file carried by a message or a tool's output, beside its text.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct PartView {
    /// What it is.
    pub part_kind: PartKindName,
    /// What the person reads: the file's name, or `image` / `audio`.
    pub name: String,
    /// Where it lives (`file:///...`), when it says.
    #[prop(skip_none)]
    pub uri: Option<String>,
    /// `image/png`... when it says.
    #[prop(skip_none)]
    pub mime: Option<String>,
    /// Bytes, when known.
    #[prop(skip_none)]
    pub size: Option<u64>,
    /// A small picture's bytes as base64 (at most 512 KiB of it); a bigger one is named and sized, not
    /// carried. Never set for sound.
    #[prop(skip_none)]
    pub data: Option<String>,
}

impl From<&core::Part> for PartView {
    fn from(p: &core::Part) -> Self {
        Self {
            part_kind: match p.kind {
                PartKind::Image => PartKindName::Image,
                PartKind::Audio => PartKindName::Audio,
                PartKind::File => PartKindName::File,
                PartKind::Resource => PartKindName::Resource,
            },
            name: p.name.clone(),
            uri: p.uri.clone(),
            mime: p.mime.clone(),
            size: p.size,
            data: p.data.clone(),
        }
    }
}

/// A file and line a tool call touches.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct LocationView {
    /// Absolute path on the agent's machine.
    pub path: String,
    /// 1-based, when the agent says.
    #[prop(skip_none)]
    pub line: Option<u32>,
}

impl From<&core::Location> for LocationView {
    fn from(l: &core::Location) -> Self {
        Self {
            path: l.path.clone(),
            line: l.line,
        }
    }
}

/// One way to sign in to an agent.
#[derive(Debug, Clone, PartialEq, Eq, JsObject)]
pub struct AuthMethodView {
    /// Pass to `Sessions.authenticate`.
    pub id: String,
    /// What the person reads.
    pub name: String,
    /// What the agent says about it.
    #[prop(skip_none)]
    pub description: Option<String>,
    /// For a method done in a terminal on the agent's machine: the arguments the agent says to run it
    /// with. `authenticate` refuses it and says so; after the person did it, call `Sessions.reopen`.
    /// Absent for a method the app carries out itself.
    #[prop(skip_none)]
    pub terminal_args: Option<Vec<String>>,
}

/// The context window of the session and what it has cost.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct UsageView {
    /// Tokens in the context now.
    pub used: u64,
    /// The window's size in tokens.
    pub size: u64,
    /// What the session has cost so far, when the agent says: the amount...
    #[prop(skip_none)]
    pub cost_amount: Option<f64>,
    /// ...and its currency (`USD`, or the agent's own unit such as `credits`).
    #[prop(skip_none)]
    pub cost_currency: Option<String>,
}

/// What the last turn used; the agent may leave any part out.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct TurnUsageView {
    /// Tokens sent.
    #[prop(skip_none)]
    pub input: Option<u64>,
    /// Tokens written.
    #[prop(skip_none)]
    pub output: Option<u64>,
    /// All of them.
    #[prop(skip_none)]
    pub total: Option<u64>,
    /// Tokens spent thinking.
    #[prop(skip_none)]
    pub thought: Option<u64>,
    /// Tokens read from the cache.
    #[prop(skip_none)]
    pub cached_read: Option<u64>,
    /// Tokens written to the cache.
    #[prop(skip_none)]
    pub cached_write: Option<u64>,
}

/// What ACP says about an agent session besides its rows (`SessionView.acp`). Empty for an observed
/// session (an agent in a terminal pane).
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct AcpView {
    /// The agent's own name, title and version (`initialize`'s `agentInfo`).
    #[prop(skip_none)]
    pub agent_name: Option<String>,
    /// The agent's title.
    #[prop(skip_none)]
    pub agent_title: Option<String>,
    /// The agent's version.
    #[prop(skip_none)]
    pub agent_version: Option<String>,
    /// The agent can reopen an old session without replaying it.
    pub can_resume: bool,
    /// The agent can list its old sessions.
    pub can_list: bool,
    /// The agent can close a session.
    pub can_close: bool,
    /// The agent can sign out.
    pub can_logout: bool,
    /// A prompt may carry sound.
    pub accepts_audio: bool,
    /// A prompt may embed a file's text.
    pub accepts_embedded: bool,
    /// While `phase` is `authRequired`: how the person can sign in.
    pub auth: Vec<AuthMethodView>,
    /// The context window and cost, when the agent has said.
    #[prop(skip_none)]
    pub usage: Option<UsageView>,
    /// What the last turn used, when the agent said.
    #[prop(skip_none)]
    pub turn_usage: Option<TurnUsageView>,
    /// When the agent says the session last changed (ISO 8601).
    #[prop(skip_none)]
    pub updated_at: Option<String>,
    /// When the running turn began, in milliseconds on the clock of `SessionItem.startedMs`; absent when
    /// none runs.
    #[prop(skip_none)]
    pub turn_started_ms: Option<u64>,
}

impl From<&core::AcpInfo> for AcpView {
    fn from(a: &core::AcpInfo) -> Self {
        Self {
            agent_name: a.agent_name.clone(),
            agent_title: a.agent_title.clone(),
            agent_version: a.agent_version.clone(),
            can_resume: a.can_resume,
            can_list: a.can_list,
            can_close: a.can_close,
            can_logout: a.can_logout,
            accepts_audio: a.accepts_audio,
            accepts_embedded: a.accepts_embedded,
            auth: a
                .auth
                .iter()
                .map(|m| AuthMethodView {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    description: m.description.clone(),
                    terminal_args: m.terminal_args.clone(),
                })
                .collect(),
            usage: a.usage.as_ref().map(|u| UsageView {
                used: u.used,
                size: u.size,
                cost_amount: u.cost.as_ref().map(|(amount, _)| *amount),
                cost_currency: u.cost.as_ref().map(|(_, currency)| currency.clone()),
            }),
            turn_usage: a.turn_usage.as_ref().map(|t| TurnUsageView {
                input: t.input,
                output: t.output,
                total: t.total,
                thought: t.thought,
                cached_read: t.cached_read,
                cached_write: t.cached_write,
            }),
            updated_at: a.updated_at.clone(),
            turn_started_ms: a.turn_started_ms,
        }
    }
}
