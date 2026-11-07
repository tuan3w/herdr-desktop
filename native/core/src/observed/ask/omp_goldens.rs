//! Dialogs of a real omp (18.4), as plain text: the layout the fake in `fake_omp` draws and the readers
//! parse. Each was compared row for row with a screen captured from a real omp; the questions and texts are
//! the synthetic ones of `omp_fixtures`.

/// A single-choice question, nothing chosen.
pub(super) const SINGLE: &str = r#"╭─ Ask ───────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Which database should the project use?                                                                              │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ❯ ○ SQLite (Recommended)                                                                                            │
│       Single file, zero setup, good for local tools                                                                 │
│   ○ Postgres                                                                                                        │
│       Full server, best for concurrent writes and large data sets                                                   │
│   ○ DuckDB                                                                                                          │
│       Embedded columnar engine for analytics queries                                                                │
│   ○ Other (type your own)                                                                                           │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⎋ cancel                                                                             │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"#;

/// A lone multi-select, two boxes ticked, the cursor on the third.
pub(super) const MULTI_TWO: &str = r#"╭─ Ask ───────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  tools    Submit                                                                                                    │
│ Which tools should the pipeline run?                                                                                │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│   ☑ Lint                                                                                                            │
│       Static checks on every commit                                                                                 │
│   ☐ Unit tests                                                                                                      │
│       Fast tests, under a minute                                                                                    │
│ ❯ ☑ Integration tests                                                                                               │
│       Needs a database container and takes several minutes on a cold CI runner, so schedule it nightly              │
│   ☐ Type check                                                                                                      │
│   ☐ Other (type your own)                                                                                           │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ␣ toggle · ⏎ submit · ↑/↓ move · ⇥/←/→ · ⎋ cancel                                                                   │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"#;

/// The review tab of a three-question form.
pub(super) const FORM_REVIEW: &str = r#"╭─ Ask ───────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  Storage    extras    name    Submit                                                                                │
│ Review answers                                                                                                      │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Storage: DuckDB                                                                                                  │
│ 2. extras: Docker image, Changelog                                                                                  │
│ 3. name: “Hà Nội — dự án”                                                                                           │
│                                                                                                                     │
│ ❯ Submit                                                                                                            │
│                                                                                                                     │
│                                                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⏎ submit · ↑/↓ scroll · ⎋ cancel                                                                                    │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"#;

/// The custom-answer editor with typed text.
pub(super) const OTHER_TYPED: &str = r#"╭─ Custom answer: Which database should the project use? ─────────────────────────────────────────────────────────────╮
│                                                                                                                     │
│ > Postgres, nhưng dùng PgBouncer                                                                                    │
│                                                                                                                     │
│ ⏎ or Ctrl+Q submit  ⎋ cancel  Ctrl+G external editor                                                                │
│                                                                                                                     │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"#;

/// A list taller than the box: a scrollbar, wrapped label, the tab label cut.
pub(super) const LONG_SCROLL: &str = r#"╭─ Ask ──────────────────────────────────────────────────╮
│  pick    Release flags a…    Submit                    │
│ Pick a release number?                                 │
├────────────────────────────────────────────────────────┤
│   ○ Release 01                                       █ │
│   ○ Release 02                                       █ │
│   ○ Release 03                                       █ │
│   ○ Release 04 with a considerably longer label that █ │
│     wraps over several lines in a narrow pane        █ │
│   ○ Release 05                                       █ │
│   ○ Release 06                                       █ │
│   ○ Release 07                                       █ │
│   ○ Release 08                                       █ │
│   ○ Release 09                                       █ │
│   ○ Release 10                                       █ │
│   ○ Release 11                                       █ │
│   ○ Release 12                                       █ │
│   ○ Release 13                                       │ │
│   ○ Release 14                                       │ │
│ ❯ ○ Release 15 (Recommended)                         │ │
│   ○ Release 16                                       │ │
│   ○ Release 17                                       │ │
│   ○ Release 18                                       │ │
│   ○ Release 19                                       │ │
│   ○ Release 20                                       │ │
├────────────────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⇥/←/→ · ↓ scroll · ⎋ c… │
╰────────────────────────────────────────────────────────╯"#;
