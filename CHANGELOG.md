# Changelog

What changed for the person using Herdr Desktop, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow `docs/RELEASING.md` (0.1.x, patch bumps). The section of a version is its release notes: write it for the person, not for the commit log.

## [Unreleased]

### Added

- **One window for every agent.** The board groups agents by what they need from you (`Needs you`, `To review`, `Working`, `Idle`) with one count shared by the status line, the window title and the triage list. `Answer one by one` walks the agents that are waiting, longest first.
- **Answer safely.** A permission prompt from a terminal agent becomes buttons that show the exact command. A risky answer takes two presses (the first arms it for four seconds and says why), a button pressed just as the question changed is ignored, and nothing is sent when the pane no longer shows the question you saw.
- **Watch and steer a pane.** A live mirror of the terminal (fit to the width, actual size, or wrapped lines), a composer, a key row, an opt-in typing mode with a visible way out, links in the output, slash commands, and quick phrases learned on your computer.
- **Many machines.** This computer plus any machine you can reach with `ssh`: your `~/.ssh/config`, agent and jump hosts are used, a changed host key stops that machine, and a machine that is out never affects another.
- **Work from the keyboard.** A command palette (`Ctrl+K`), shortcuts to jump to the next agent that needs you (`Ctrl+J`), tabs and splits you can arrange, and a list of every shortcut (`F1`).
- **Made to be heard and seen.** Every control has a name for screen readers, states are shapes and text rather than colour alone, the four themes pass contrast checks in light and dark, and reduced motion and large text are honoured.
- **A developer panel** (`Ctrl+Shift+D`) with how long it takes from a pane changing to its text being on screen, how often panes are read, how fast their text is parsed, how many rows are redrawn per update, and the app's memory, threads and open files.
- **Updates.** Settings > About asks GitHub once, when Settings opens, whether a newer release exists and offers `Open release page`. It only reads `api.github.com` (the latest release of this project), sends nothing about you, installs nothing, and has a switch to turn it off.
- **Packaging.** `make package` builds a `.tar.gz` for Linux; `local/install.sh` installs it for your user with a launcher entry and icon, and removes it again with `--uninstall`.

### Changed

- The window opens at desktop size instead of phone size.

### Not yet

Agent sessions (ACP chat), observed `Show chat`, files, web pages from a machine and desktop notifications are planned; `docs/PARITY.md` lists every feature of the phone app and where it stands.
