//! A program on a pseudo-terminal: the master side as a file, the child in its own session so the pty is its controlling
//! terminal. Unix only (the app's other platforms have no terminal yet).

use std::{
    fs::File,
    io,
    os::{fd::OwnedFd, unix::process::CommandExt},
    process::{Child, Command, ExitStatus, Stdio},
};

use super::types::Launch;
use rustix::{
    fs::{Mode, OFlags, open},
    process::{Pid, Signal, ioctl_tiocsctty, kill_process_group, setsid},
    pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt},
    termios::{Winsize, tcsetwinsize},
};

/// A running program with its terminal.
pub struct Pty {
    master: OwnedFd,
    child: Child,
}

fn winsize(cols: u16, rows: u16, cell: (u16, u16)) -> Winsize {
    Winsize {
        ws_row: rows.max(1),
        ws_col: cols.max(1),
        ws_xpixel: cols.saturating_mul(cell.0),
        ws_ypixel: rows.saturating_mul(cell.1),
    }
}

fn io_error(e: rustix::io::Errno) -> io::Error {
    io::Error::from_raw_os_error(e.raw_os_error())
}

impl Pty {
    /// Starts the program. The child has `TERM=xterm-256color` and `COLORTERM=truecolor` (the emulator is xterm-compatible
    /// and has no terminfo of its own), and none of herdr's own variables: a shell started here must not believe it runs
    /// inside the pane the app was launched from.
    pub fn spawn(launch: &Launch) -> io::Result<Pty> {
        let (program, args) = launch
            .argv
            .split_first()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no program to run"))?;
        let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY | OpenptFlags::CLOEXEC)
            .map_err(io_error)?;
        grantpt(&master).map_err(io_error)?;
        unlockpt(&master).map_err(io_error)?;
        let name = ptsname(&master, Vec::new()).map_err(io_error)?;
        let slave = open(
            name.as_c_str(),
            OFlags::RDWR | OFlags::NOCTTY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io_error)?;
        tcsetwinsize(&master, winsize(launch.cols, launch.rows, launch.cell)).map_err(io_error)?;

        let mut command = Command::new(program);
        command.args(args);
        if let Some(cwd) = &launch.cwd {
            command.current_dir(cwd);
        }
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("HERDR_") {
                command.env_remove(key);
            }
        }
        command
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("TERM_PROGRAM", "herdr-desktop")
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls (setsid, ioctl) run between fork and exec.
        unsafe {
            command.pre_exec(|| {
                setsid().map_err(io_error)?;
                // Stdin is the slave by now: make it this session's controlling terminal.
                ioctl_tiocsctty(rustix::stdio::stdin()).map_err(io_error)?;
                Ok(())
            });
        }
        let child = command.spawn()?;
        Ok(Pty { master, child })
    }

    /// The child's process id (also its process group: it leads its own session).
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// A handle on the master side to read the program's output from (or write its input to).
    pub fn file(&self) -> io::Result<File> {
        Ok(File::from(self.master.try_clone()?))
    }

    /// Tells the program its terminal changed size.
    pub fn resize(&self, cols: u16, rows: u16, cell: (u16, u16)) -> io::Result<()> {
        tcsetwinsize(&self.master, winsize(cols, rows, cell)).map_err(io_error)
    }

    /// How the program ended, if it has.
    pub fn try_wait(&mut self) -> Option<super::frame::Exit> {
        use std::os::unix::process::ExitStatusExt;
        let status: ExitStatus = self.child.try_wait().ok()??;
        Some(match (status.code(), status.signal()) {
            (Some(code), _) => super::frame::Exit::Code(code),
            (None, Some(signal)) => super::frame::Exit::Signal(signal),
            (None, None) => super::frame::Exit::Code(0),
        })
    }

    /// Hangs up on the program's process group: only the one this started.
    pub fn hang_up(&self) {
        if let Some(pid) = Pid::from_raw(self.child.id() as i32) {
            let _ = kill_process_group(pid, Signal::HUP);
        }
    }
}
