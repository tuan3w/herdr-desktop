//! Time, injected: the link never reads the system clock or sleeps on its own, so a test drives
//! backoff, polling and throttling by moving a [`ManualClock`] instead of waiting for them.

use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime};

use crossbeam_channel::{Receiver, Sender, bounded};
use parking_lot::{Condvar, Mutex};

/// A source of time for [`MachineLink`](super::MachineLink).
pub trait Clock: Send + Sync + 'static {
    /// Monotonic time, for deadlines and ages.
    fn now(&self) -> Instant;

    /// Wall-clock time. Unlike [`Clock::now`] it keeps running while the computer is suspended
    /// (Linux's monotonic clock stops), so a jump of this clock that `now` does not share means
    /// the machine slept and every socket is presumed dead.
    fn wall(&self) -> SystemTime;

    /// A timer that fires once `deadline` has passed. Dropping the [`Timer`] cancels it.
    fn timer(&self, deadline: Instant) -> Timer;
}

/// A one-shot timer: [`Timer::receiver`] yields a message when the deadline passes.
pub struct Timer {
    rx: Receiver<Instant>,
    /// A [`ManualClock`] holds a `Weak` to this to tell a dropped timer from a pending one.
    _alive: Arc<()>,
}

impl Timer {
    /// The channel to select on.
    pub fn receiver(&self) -> &Receiver<Instant> {
        &self.rx
    }
}

/// The real clocks.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn wall(&self) -> SystemTime {
        SystemTime::now()
    }

    fn timer(&self, deadline: Instant) -> Timer {
        Timer {
            rx: crossbeam_channel::after(deadline.saturating_duration_since(Instant::now())),
            _alive: Arc::new(()),
        }
    }
}

struct Pending {
    deadline: Instant,
    tx: Sender<Instant>,
    alive: Weak<()>,
}

struct ManualState {
    now: Instant,
    wall: SystemTime,
    pending: Vec<Pending>,
}

impl ManualState {
    fn purge(&mut self) {
        self.pending.retain(|p| p.alive.strong_count() > 0);
    }

    fn fire_due(&mut self) {
        let now = self.now;
        self.pending.retain(|p| {
            if p.alive.strong_count() == 0 {
                return false;
            }
            if p.deadline <= now {
                let _ = p.tx.try_send(now);
                return false;
            }
            true
        });
    }
}

/// A clock that only moves when told to: for tests.
pub struct ManualClock {
    state: Mutex<ManualState>,
    timer_registered: Condvar,
}

impl Default for ManualClock {
    fn default() -> Self {
        Self::new()
    }
}

impl ManualClock {
    /// A clock that starts at the moment it is created and then stands still.
    pub fn new() -> Self {
        Self {
            state: Mutex::new(ManualState {
                now: Instant::now(),
                wall: SystemTime::now(),
                pending: Vec::new(),
            }),
            timer_registered: Condvar::new(),
        }
    }

    /// Moves both clocks forward and fires every timer that is due.
    pub fn advance(&self, by: Duration) {
        let mut s = self.state.lock();
        s.now += by;
        s.wall += by;
        s.fire_due();
    }

    /// The computer slept for `by`: wall-clock time moves, monotonic time does not.
    pub fn suspend(&self, by: Duration) {
        self.state.lock().wall += by;
    }

    /// How many timers are waiting (dropped ones do not count).
    pub fn pending_timers(&self) -> usize {
        let mut s = self.state.lock();
        s.purge();
        s.pending.len()
    }

    /// Waits (in real time, at most `patience`) until some timer is waiting, then moves time to the
    /// earliest deadline and fires it. Returns how far time moved, or `None` if no timer showed up:
    /// a test that expects the link to be sleeping learns it is not.
    pub fn advance_to_next_timer(&self, patience: Duration) -> Option<Duration> {
        let give_up = Instant::now() + patience;
        let mut s = self.state.lock();
        loop {
            s.purge();
            if let Some(deadline) = s.pending.iter().map(|p| p.deadline).min() {
                let by = deadline.saturating_duration_since(s.now);
                s.now += by;
                s.wall += by;
                s.fire_due();
                return Some(by);
            }
            let left = give_up.checked_duration_since(Instant::now())?;
            self.timer_registered.wait_for(&mut s, left);
        }
    }
}

impl Clock for ManualClock {
    fn now(&self) -> Instant {
        self.state.lock().now
    }

    fn wall(&self) -> SystemTime {
        self.state.lock().wall
    }

    fn timer(&self, deadline: Instant) -> Timer {
        let (tx, rx) = bounded(1);
        let alive = Arc::new(());
        let mut s = self.state.lock();
        if deadline <= s.now {
            let _ = tx.try_send(s.now);
        } else {
            s.pending.push(Pending {
                deadline,
                tx,
                alive: Arc::downgrade(&alive),
            });
            self.timer_registered.notify_all();
        }
        Timer { rx, _alive: alive }
    }
}
