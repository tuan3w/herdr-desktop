//! `FakeHerdr`: a unix-socket server that speaks herdr's wire protocol from a script.
//!
//! Every test in this crate and every TSX test goes through it: nothing in the test suite touches the
//! owner's live herdr. It records the requests it served so a test can assert what the app sent
//! (for example `pane.send_keys` after pressing an answer chip).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, unbounded};
use serde_json::{Value, json};

type Handler = Box<dyn Fn(&Value) -> Result<Value, (String, String)> + Send + Sync>;

/// What the fake answers. Unscripted methods answer `{"error":{"code":"unknown_method",..}}`.
#[derive(Default)]
pub struct Script {
    handlers: HashMap<String, Handler>,
    initial_events: Vec<Value>,
}

impl Script {
    pub fn new() -> Self {
        Self::default()
    }

    /// Answers `method` with this `result` every time.
    pub fn on(mut self, method: &str, result: Value) -> Self {
        self.handlers
            .insert(method.to_owned(), Box::new(move |_| Ok(result.clone())));
        self
    }

    /// Answers `method` by calling `f(params)`; `Err((code, message))` is a herdr error answer.
    pub fn on_with(
        mut self,
        method: &str,
        f: impl Fn(&Value) -> Result<Value, (String, String)> + Send + Sync + 'static,
    ) -> Self {
        self.handlers.insert(method.to_owned(), Box::new(f));
        self
    }

    /// Events (`{"event":"pane_updated","data":{..}}`) sent to every subscriber right after its ack.
    pub fn on_events(mut self, events: impl IntoIterator<Item = Value>) -> Self {
        self.initial_events.extend(events);
        self
    }
}

/// One request the fake served.
#[derive(Debug, Clone, PartialEq)]
pub struct Recorded {
    pub method: String,
    pub params: Value,
}

struct Shared {
    script: Script,
    requests: Mutex<Vec<Recorded>>,
    subscribers: Mutex<Vec<Sender<Value>>>,
    stop: AtomicBool,
}

/// A running fake herdr; dropping it stops the server and removes the socket.
pub struct FakeHerdr {
    path: PathBuf,
    shared: Arc<Shared>,
    accept: Option<JoinHandle<()>>,
}

impl FakeHerdr {
    /// Binds `<dir>/herdr.sock` and serves `script` on a background thread.
    pub fn start(dir: &Path, script: Script) -> std::io::Result<Self> {
        let path = dir.join("herdr.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path)?;
        listener.set_nonblocking(true)?;
        let shared = Arc::new(Shared {
            script,
            requests: Mutex::new(Vec::new()),
            subscribers: Mutex::new(Vec::new()),
            stop: AtomicBool::new(false),
        });
        let accept_shared = shared.clone();
        let accept = std::thread::spawn(move || {
            while !accept_shared.stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let shared = accept_shared.clone();
                        std::thread::spawn(move || serve(stream, shared));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            path,
            shared,
            accept: Some(accept),
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.path
    }

    /// Every request served so far, oldest first (`events.subscribe` included).
    pub fn requests(&self) -> Vec<Recorded> {
        self.shared.requests.lock().unwrap().clone()
    }

    /// The served requests of one method.
    pub fn requests_of(&self, method: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.method == method)
            .collect()
    }

    /// Sends an event line to every current subscriber.
    pub fn push_event(&self, event: Value) {
        self.shared
            .subscribers
            .lock()
            .unwrap()
            .retain(|tx| tx.send(event.clone()).is_ok());
    }

    /// How many event streams are open.
    pub fn subscribers(&self) -> usize {
        self.shared.subscribers.lock().unwrap().len()
    }
}

impl Drop for FakeHerdr {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        // Dropping the senders ends the subscriber loops.
        self.shared.subscribers.lock().unwrap().clear();
        if let Some(h) = self.accept.take() {
            let _ = h.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

fn serve(stream: UnixStream, shared: Arc<Shared>) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut writer = stream;
    let mut line = String::new();
    if BufReader::new(read_half).read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let Ok(req) = serde_json::from_str::<Value>(&line) else {
        return;
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    shared.requests.lock().unwrap().push(Recorded {
        method: method.clone(),
        params: params.clone(),
    });

    if method == "events.subscribe" {
        let rx: Receiver<Value> = {
            let (tx, rx) = unbounded();
            for ev in &shared.script.initial_events {
                let _ = tx.send(ev.clone());
            }
            shared.subscribers.lock().unwrap().push(tx);
            rx
        };
        if write_line(
            &mut writer,
            &json!({"id": id, "result": {"type": "subscription_started"}}),
        )
        .is_err()
        {
            return;
        }
        while let Ok(ev) = rx.recv() {
            if write_line(&mut writer, &ev).is_err() {
                return;
            }
        }
        return;
    }

    let answer = match shared.script.handlers.get(&method) {
        Some(h) => match h(&params) {
            Ok(result) => json!({"id": id, "result": result}),
            Err((code, message)) => json!({"id": id, "error": {"code": code, "message": message}}),
        },
        None => {
            json!({"id": id, "error": {"code": "unknown_method", "message": format!("no script for {method}")}})
        }
    };
    let _ = write_line(&mut writer, &answer);
}

fn write_line(w: &mut UnixStream, v: &Value) -> std::io::Result<()> {
    let mut s = serde_json::to_vec(v)?;
    s.push(b'\n');
    w.write_all(&s)
}
