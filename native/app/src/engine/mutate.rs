//! Everything the person does to herdr besides answering: type into a pane, create, split, rename,
//! focus and close things, start an agent. Method names and parameters are those of
//! `docs/herdr-api.schema.json`; a herdr error is returned as its message.

use herdr_core::wire::WireError;
use serde_json::{Value, json};

use super::{Fleet, REQUEST_TIMEOUT, unknown};

/// What a create call made.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Created {
    /// The workspace; empty when the call made none (`splitPane`).
    pub workspace_id: String,
    /// The tab; empty for `splitPane`.
    pub tab_id: String,
    /// The pane (a new tab or workspace has one).
    pub pane_id: String,
}

/// Which way a split goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Split {
    /// The new pane is on the right.
    Right,
    /// The new pane is below.
    Down,
}

/// What `startAgent` is given.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct StartAgent {
    /// The folder the agent works in.
    pub cwd: String,
    /// The agent's kind as herdr knows it (`claude`, `codex`, `omp`).
    pub agent: String,
    /// The name of the new tab or workspace and of the agent; the kind when left out.
    pub name: Option<String>,
    /// Open the agent in a new tab of this workspace; a new workspace when left out.
    pub workspace_id: Option<String>,
    /// Arguments after the agent's command.
    pub args: Vec<String>,
}

impl Fleet {
    /// One request to a machine's herdr over its shared connection. Asks the link to read the snapshot
    /// soon, because whatever was changed shows there.
    fn call(&self, machine: &str, method: &str, params: Value) -> Result<Value, String> {
        let link = self.link(machine).ok_or_else(|| unknown(machine))?;
        let result = link
            .wire()
            .request(method, params, REQUEST_TIMEOUT)
            .map_err(|e: WireError| e.message);
        link.refresh();
        result
    }

    /// Types `text` into a pane without pressing anything.
    pub fn send_text(&self, machine: &str, pane: &str, text: &str) -> Result<(), String> {
        self.call(
            machine,
            "pane.send_text",
            json!({"pane_id": pane, "text": text}),
        )
        .map(drop)
    }

    /// Presses keys in a pane, by herdr's names (`enter`, `esc`, `ctrl+c`, `up`).
    pub fn send_keys(&self, machine: &str, pane: &str, keys: &[String]) -> Result<(), String> {
        self.call(
            machine,
            "pane.send_keys",
            json!({"pane_id": pane, "keys": keys}),
        )
        .map(drop)
    }

    /// Types `text`, then presses `keys`, as one request: the composer's Enter, so the text and the key
    /// cannot be separated by a failure in between.
    pub fn send_input(
        &self,
        machine: &str,
        pane: &str,
        text: &str,
        keys: &[String],
    ) -> Result<(), String> {
        let mut params = json!({"pane_id": pane});
        if !text.is_empty() {
            params["text"] = json!(text);
        }
        if !keys.is_empty() {
            params["keys"] = json!(keys);
        }
        self.call(machine, "pane.send_input", params).map(drop)
    }

    /// A new workspace (with one tab and one pane) running a shell in `cwd`. Never focused: moving the
    /// person's view in herdr is not this app's to do unasked.
    pub fn create_workspace(
        &self,
        machine: &str,
        label: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<Created, String> {
        let result = self.call(machine, "workspace.create", create_params(None, label, cwd))?;
        created(&result)
    }

    /// A new tab (with one pane) in a workspace.
    pub fn create_tab(
        &self,
        machine: &str,
        workspace_id: &str,
        label: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<Created, String> {
        let result = self.call(
            machine,
            "tab.create",
            create_params(Some(workspace_id), label, cwd),
        )?;
        created(&result)
    }

    /// Splits a pane; the new pane's id.
    pub fn split_pane(
        &self,
        machine: &str,
        pane: &str,
        direction: Split,
    ) -> Result<String, String> {
        let direction = match direction {
            Split::Right => "right",
            Split::Down => "down",
        };
        let result = self.call(
            machine,
            "pane.split",
            json!({"direction": direction, "target_pane_id": pane, "focus": false}),
        )?;
        id_at(&result, "/pane/pane_id")
    }

    /// Closes a pane (and kills what runs in it).
    pub fn close_pane(&self, machine: &str, pane: &str) -> Result<(), String> {
        self.call(machine, "pane.close", json!({"pane_id": pane}))
            .map(drop)
    }

    /// Closes a tab and its panes.
    pub fn close_tab(&self, machine: &str, tab: &str) -> Result<(), String> {
        self.call(machine, "tab.close", json!({"tab_id": tab}))
            .map(drop)
    }

    /// Closes a workspace and everything in it.
    pub fn close_workspace(&self, machine: &str, workspace: &str) -> Result<(), String> {
        self.call(
            machine,
            "workspace.close",
            json!({"workspace_id": workspace}),
        )
        .map(drop)
    }

    /// Names a workspace.
    pub fn rename_workspace(
        &self,
        machine: &str,
        workspace: &str,
        label: &str,
    ) -> Result<(), String> {
        self.call(
            machine,
            "workspace.rename",
            json!({"workspace_id": workspace, "label": label}),
        )
        .map(drop)
    }

    /// Names a tab.
    pub fn rename_tab(&self, machine: &str, tab: &str, label: &str) -> Result<(), String> {
        self.call(
            machine,
            "tab.rename",
            json!({"tab_id": tab, "label": label}),
        )
        .map(drop)
    }

    /// Names a pane; an empty label clears the name (herdr takes `null` for that).
    pub fn rename_pane(&self, machine: &str, pane: &str, label: &str) -> Result<(), String> {
        let label = if label.is_empty() {
            Value::Null
        } else {
            json!(label)
        };
        self.call(
            machine,
            "pane.rename",
            json!({"pane_id": pane, "label": label}),
        )
        .map(drop)
    }

    /// Moves herdr's own focus to a workspace. This changes what is on the owner's herdr screen: call it
    /// only for something the person asked for.
    pub fn focus_workspace(&self, machine: &str, workspace: &str) -> Result<(), String> {
        self.call(
            machine,
            "workspace.focus",
            json!({"workspace_id": workspace}),
        )
        .map(drop)
    }

    /// Moves herdr's own focus to a tab (see [`Fleet::focus_workspace`]).
    pub fn focus_tab(&self, machine: &str, tab: &str) -> Result<(), String> {
        self.call(machine, "tab.focus", json!({"tab_id": tab}))
            .map(drop)
    }

    /// Moves herdr's own focus to a pane (see [`Fleet::focus_workspace`]).
    pub fn focus_pane(&self, machine: &str, pane: &str) -> Result<(), String> {
        self.call(machine, "pane.focus", json!({"pane_id": pane}))
            .map(drop)
    }

    /// Zooms a pane (`on`) or puts it back (`!on`) with the public `pane.zoom`, so a client attached to the session shows
    /// only that pane. Answers whether herdr changed the zoom: a pane that was already zoomed is not ours to unzoom later.
    pub fn zoom_pane(&self, machine: &str, pane: &str, on: bool) -> Result<bool, String> {
        let mode = if on { "on" } else { "off" };
        let answer = self.call(machine, "pane.zoom", json!({"pane_id": pane, "mode": mode}))?;
        let changed = |v: &Value| v.get("zoom_changed").and_then(Value::as_bool);
        Ok(changed(&answer)
            .or_else(|| answer.get("result").and_then(changed))
            .unwrap_or(false))
    }

    /// Starts an agent in a new tab (or workspace) in a folder: herdr starts agents in an existing pane
    /// at a shell prompt, so the pane is made first. When the agent does not start, the new pane is
    /// left (it is a shell the person may want) and the error says so.
    pub fn start_agent(&self, machine: &str, start: &StartAgent) -> Result<Created, String> {
        let kind = start.agent.trim();
        if kind.is_empty() {
            return Err("Choose which agent to start".to_owned());
        }
        let name = start
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(kind);
        let cwd = Some(start.cwd.as_str()).filter(|c| !c.is_empty());
        let made = match &start.workspace_id {
            Some(workspace) => self.create_tab(machine, workspace, Some(name), cwd)?,
            None => self.create_workspace(machine, Some(name), cwd)?,
        };
        let mut params = json!({"name": name, "kind": kind, "pane_id": made.pane_id});
        if !start.args.is_empty() {
            params["args"] = json!(start.args);
        }
        self.call(machine, "agent.start", params)
            .map_err(|e| format!("A shell was opened, but {kind} did not start: {e}"))?;
        Ok(made)
    }
}

fn create_params(workspace: Option<&str>, label: Option<&str>, cwd: Option<&str>) -> Value {
    let mut params = json!({"focus": false});
    if let Some(workspace) = workspace {
        params["workspace_id"] = json!(workspace);
    }
    if let Some(label) = label.filter(|l| !l.is_empty()) {
        params["label"] = json!(label);
    }
    if let Some(cwd) = cwd {
        params["cwd"] = json!(cwd);
    }
    params
}

fn id_at(result: &Value, pointer: &str) -> Result<String, String> {
    result
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "herdr's answer did not name what it made".to_owned())
}

fn created(result: &Value) -> Result<Created, String> {
    Ok(Created {
        workspace_id: result
            .pointer("/workspace/workspace_id")
            .or_else(|| result.pointer("/tab/workspace_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        tab_id: id_at(result, "/tab/tab_id")?,
        pane_id: id_at(result, "/root_pane/pane_id")?,
    })
}
