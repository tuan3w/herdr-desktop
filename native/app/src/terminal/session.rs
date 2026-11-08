//! A terminal session as the rest of the app sees it: a handle that takes [`Input`] and hands out immutable [`Frame`]s.
//! The emulation itself (`emulator.rs`, libghostty-vt on a thread of its own) exists only with the `terminal` feature;
//! without it a session is one frame that says so.

use std::{sync::Arc, time::Duration};

use crossbeam_channel::{Sender, bounded, unbounded};
use parking_lot::Mutex;

use super::{
    frame::Frame,
    types::{Config, Input},
};

/// A handle on a running session: dropping it hangs up on the program (the process this session started, nothing else).
pub struct Session {
    input: Sender<Input>,
    latest: Arc<Mutex<Arc<Frame>>>,
    wake: async_channel::Receiver<()>,
}

impl Session {
    /// Starts the program and the thread.
    pub fn start(config: Config) -> Session {
        let (input, rx) = unbounded();
        let latest = Arc::new(Mutex::new(Arc::new(Frame::default())));
        let (wake_tx, wake) = async_channel::bounded(1);
        let publisher = Publisher {
            latest: latest.clone(),
            wake: wake_tx,
        };
        let words = if !cfg!(all(unix, feature = "terminal")) {
            Some("This build has no terminal (cargo feature `terminal`).")
        } else {
            None
        };
        match words {
            None => {
                #[cfg(all(unix, feature = "terminal"))]
                std::thread::Builder::new()
                    .name("terminal".into())
                    .spawn(move || super::emulator::run(config, rx, publisher))
                    .expect("the terminal thread starts");
                #[cfg(not(all(unix, feature = "terminal")))]
                let _ = (config, rx, publisher);
            }
            Some(words) => {
                let _ = (config, rx);
                publisher.publish(Frame {
                    rev: 1,
                    cols: 80,
                    rows: vec![std::sync::Arc::new(herdr_core::screen::Row::new(vec![
                        herdr_core::screen::Run {
                            text: words.to_owned(),
                            style: Default::default(),
                        },
                    ]))],
                    ..Frame::default()
                });
            }
        }
        Session {
            input,
            latest,
            wake,
        }
    }

    pub fn send(&self, input: Input) {
        let _ = self.input.send(input);
    }

    /// The selected text, asking the thread (which owns the selection); `None` when nothing is selected or the thread is
    /// busy for more than a moment.
    pub fn selection(&self) -> Option<String> {
        let (reply, answer) = bounded(1);
        self.send(Input::Copy(reply));
        answer.recv_timeout(Duration::from_secs(2)).ok().flatten()
    }

    /// The newest frame.
    pub fn frame(&self) -> Arc<Frame> {
        self.latest.lock().clone()
    }

    /// One message per published frame, at most one waiting: read [`Session::frame`] after it.
    pub fn frames(&self) -> async_channel::Receiver<()> {
        self.wake.clone()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // A closed channel ends the thread, which hangs up on its program.
        let (dead, _) = unbounded();
        self.input = dead;
    }
}

#[derive(Clone)]
pub(super) struct Publisher {
    latest: Arc<Mutex<Arc<Frame>>>,
    wake: async_channel::Sender<()>,
}

impl Publisher {
    pub(super) fn publish(&self, frame: Frame) {
        *self.latest.lock() = Arc::new(frame);
        let _ = self.wake.try_send(());
    }
}
