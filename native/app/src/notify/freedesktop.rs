//! Delivery over the freedesktop notification service (`org.freedesktop.Notifications` on the session
//! bus), through `zbus`'s blocking API, the stack `notify-rust` 4 builds on.
//!
//! `notify-rust` itself is not used: its handle waits for a response by consuming itself, so one
//! notification can be waited on or withdrawn but not both, and every wait is a thread and a bus
//! connection of its own. One connection and one listener thread serve every notification here.
//!
//! Three details are about what the person is shown:
//!
//! * a server that renders markup (`body-markup`) would swallow the `<` and `&` of a command, so the body
//!   is escaped for it: what is approved must be what is read;
//! * buttons and the click action are sent only to a server that supports actions;
//! * a blocked agent's notification never expires on its own, because it should stay until the person
//!   deals with it or the agent stops needing them (`policy`).

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use crossbeam_channel::Sender;
use parking_lot::Mutex;
use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::Value;
use zbus::{MatchRule, message::Type};

use super::policy::{DEFAULT_ACTION, Notification};
use super::{Input, Sink, Support};

const SERVICE: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const APP_NAME: &str = "Herdr Desktop";
/// The icon and `.desktop` entry name: the app's id.
const APP_ID: &str = "dev.herdrmobile.herdr_desktop";

/// `NotificationClosed` reasons that mean the person (or the clock) took it away: 1 expired,
/// 2 dismissed. 3 is our own `CloseNotification`, 4 undefined.
const GONE_REASONS: [u32; 2] = [1, 2];

struct Shared {
    /// Our id to the service's id of the notification now showing.
    ids: Mutex<HashMap<u64, u32>>,
    events: Sender<Input>,
}

struct Link {
    connection: Connection,
    support: Support,
}

/// Notifications on this desktop. Connects on first use, so an app with notifications off never
/// touches the bus.
pub struct DesktopSink {
    shared: Arc<Shared>,
    link: Mutex<Option<Arc<Link>>>,
}

impl DesktopSink {
    /// A sink whose presses and dismissals go to the notifier thread through `events`.
    pub fn new(events: Sender<Input>) -> Self {
        Self {
            shared: Arc::new(Shared {
                ids: Mutex::new(HashMap::new()),
                events,
            }),
            link: Mutex::new(None),
        }
    }

    /// Connects (once it works) and says what the service can do, or why there is none: no session bus,
    /// or nothing owns `org.freedesktop.Notifications`. A failure is not remembered: a service that starts
    /// later is found by the next call. Blocks on the bus: call it off the UI thread.
    pub fn support(&self) -> Result<Support, String> {
        self.link().map(|l| l.support)
    }

    fn link(&self) -> Result<Arc<Link>, String> {
        let mut slot = self.link.lock();
        if let Some(link) = slot.as_ref() {
            return Ok(link.clone());
        }
        let link = Arc::new(connect(&self.shared)?);
        *slot = Some(link.clone());
        Ok(link)
    }
}

fn connect(shared: &Arc<Shared>) -> Result<Link, String> {
    let connection = Connection::session()
        .map_err(|e| format!("There is no desktop notification service to talk to ({e})"))?;
    let reply = connection
        .call_method(Some(SERVICE), PATH, Some(SERVICE), "GetCapabilities", &())
        .map_err(|e| format!("No notification service answered: {e}"))?;
    let caps: Vec<String> = reply.body().deserialize().map_err(|e| {
        format!("The notification service sent capabilities this app cannot read: {e}")
    })?;
    let support = Support {
        actions: caps.iter().any(|c| c == "actions"),
        markup: caps.iter().any(|c| c == "body-markup"),
    };
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(SERVICE)
        .map_err(|e| e.to_string())?
        .build();
    let signals = MessageIterator::for_match_rule(rule, &connection, None)
        .map_err(|e| format!("cannot listen for notification clicks: {e}"))?;
    let weak = Arc::downgrade(shared);
    std::thread::Builder::new()
        .name("herdr-notify-signals".to_owned())
        .spawn(move || listen(signals, &weak))
        .map_err(|e| format!("cannot start a thread: {e}"))?;
    Ok(Link {
        connection,
        support,
    })
}

/// Turns the service's signals about our notifications into inputs. Ends when the sink is gone.
fn listen(signals: MessageIterator, shared: &Weak<Shared>) {
    for message in signals {
        let Ok(message) = message else { break };
        let Some(shared) = shared.upgrade() else {
            break;
        };
        let header = message.header();
        let body = message.body();
        match header.member().map(|m| m.as_str()) {
            Some("ActionInvoked") => {
                if let Ok((server_id, action)) = body.deserialize::<(u32, String)>()
                    && let Some(id) = ours(&shared, server_id)
                {
                    let _ = shared.events.send(Input::Pressed { id, action });
                }
            }
            Some("NotificationClosed") => {
                if let Ok((server_id, reason)) = body.deserialize::<(u32, u32)>()
                    && let Some(id) = ours(&shared, server_id)
                {
                    shared.ids.lock().remove(&id);
                    if GONE_REASONS.contains(&reason) {
                        let _ = shared.events.send(Input::Gone(id));
                    }
                }
            }
            _ => {}
        }
    }
}

fn ours(shared: &Shared, server_id: u32) -> Option<u64> {
    shared
        .ids
        .lock()
        .iter()
        .find(|(_, s)| **s == server_id)
        .map(|(id, _)| *id)
}

/// `text` safe to put in a body the service renders as markup.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

impl Sink for DesktopSink {
    fn show(&self, n: &Notification) -> Result<(), String> {
        let link = self.link()?;
        let mut actions: Vec<String> = Vec::new();
        if link.support.actions {
            actions.extend([DEFAULT_ACTION.to_owned(), "Open".to_owned()]);
            for (i, button) in n.buttons.iter().enumerate() {
                actions.extend([format!("answer:{i}"), button.label.clone()]);
            }
        }
        let body = if link.support.markup {
            escape(&n.body)
        } else {
            n.body.clone()
        };
        let mut hints: HashMap<&str, Value<'_>> = HashMap::new();
        hints.insert("desktop-entry", Value::from(APP_ID));
        // Normal for a question, low for news that can wait.
        hints.insert("urgency", Value::U8(if n.persistent { 1 } else { 0 }));
        let replaces = self.shared.ids.lock().get(&n.id).copied().unwrap_or(0);
        let timeout: i32 = if n.persistent { 0 } else { -1 };
        let reply = link
            .connection
            .call_method(
                Some(SERVICE),
                PATH,
                Some(SERVICE),
                "Notify",
                &(
                    APP_NAME,
                    replaces,
                    APP_ID,
                    n.title.as_str(),
                    body.as_str(),
                    actions,
                    hints,
                    timeout,
                ),
            )
            .map_err(|e| {
                // The bus connection may be what died: connect afresh at the next notification.
                *self.link.lock() = None;
                e.to_string()
            })?;
        let server_id: u32 = reply.body().deserialize().map_err(|e| e.to_string())?;
        self.shared.ids.lock().insert(n.id, server_id);
        Ok(())
    }

    fn close(&self, id: u64) {
        let Some(server_id) = self.shared.ids.lock().remove(&id) else {
            return;
        };
        if let Ok(link) = self.link() {
            // Nothing to do on failure: the service restarted, and its notifications went with it.
            let _ = link.connection.call_method(
                Some(SERVICE),
                PATH,
                Some(SERVICE),
                "CloseNotification",
                &(server_id,),
            );
        }
    }
}
