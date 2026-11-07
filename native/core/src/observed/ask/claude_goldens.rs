//! Screens of Claude Code's question dialog (2.1.29x) as the pane shows them: the layout of the screens
//! captured from a real Claude Code, with synthetic questions, paths and prompts. The fake in `fake_claude`
//! was compared with the captures; the shapes of these and of the fake's screens are compared in the tests.

/// A lone single-choice question, the cursor on the first row.
pub(super) const SINGLE: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me which color I prefer.
────────────────────────────────────────────────────────────
 ☐ Color

Which color do you prefer?

❯ 1. Red
     Red
  2. Green
     Green
  3. Blue
     Blue
  4. Type something.
────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel"#;

/// The same, with `purple` typed on the Other row.
pub(super) const SINGLE_OTHER: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me which color I prefer.
────────────────────────────────────────────────────────────
 ☐ Color

Which color do you prefer?

  1. Red
     Red
  2. Green
     Green
  3. Blue
     Blue
❯ 4. purple
────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel"#;

/// A lone multi-select with Apple and Cherry ticked, the cursor on Cherry.
pub(super) const MULTI_TOGGLED: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me which fruits I like.
────────────────────────────────────────────────────────────
←  ☒ Fruits  ✔ Submit  →

Which fruits do I like?

  1. [✔] Apple
         Apple
  2. [ ] Banana
         Banana
❯ 3. [✔] Cherry
         Cherry
  4. [ ] Date
         Date
  5. [ ] Type something
     Submit
────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel"#;

/// A multi-select with `Elderberry` typed and ticked, the cursor on the unnumbered Submit row.
pub(super) const MULTI_SUBMIT_ROW: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me which fruits I like.
────────────────────────────────────────────────────────────
←  ☒ Fruits  ✔ Submit  →

Which fruits do I like?

  1. [✔] Apple
         Apple
  2. [ ] Banana
         Banana
  3. [✔] Cherry
         Cherry
  4. [ ] Date
         Date
  5. [✔] Elderberry
❯    Submit
────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel"#;

/// The same multi-select with the cursor on `Chat about this`.
pub(super) const MULTI_CHAT: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me which fruits I like.
────────────────────────────────────────────────────────────
←  ☒ Fruits  ✔ Submit  →

Which fruits do I like?

  1. [✔] Apple
         Apple
  2. [ ] Banana
         Banana
  3. [✔] Cherry
         Cherry
  4. [ ] Date
         Date
  5. [✔] Elderberry
     Submit
────────────────────────────────────────────────────────────
❯ 6. Chat about this

Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel"#;

/// The first tab of a two-question form, nothing answered.
pub(super) const FORM_Q1: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me two things.
────────────────────────────────────────────────────────────
←  ☐ Lang  ☐ Extras  ✔ Submit  →

Which language do I prefer?

❯ 1. Python
     Python as your preferred language
  2. Go
     Go as your preferred language
  3. Rust
     Rust as your preferred language
  4. Type something.
────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel"#;

/// Back on the first tab after answering both: Go is marked, the cursor is on row 1.
pub(super) const FORM_Q1_ANSWERED: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me two things.
────────────────────────────────────────────────────────────
←  ☒ Lang  ☒ Extras  ✔ Submit  →

Which language do I prefer?

❯ 1. Python
     Python as your preferred language
  2. Go ✔
     Go as your preferred language
  3. Rust
     Rust as your preferred language
  4. Type something.
────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel"#;

/// A question longer than a row wraps under a bar of its own, and so does a long label.
pub(super) const WRAP: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me about deployment.
────────────────────────────────────────────────────────────
 ☐ Deploy

│ Which of the following deployment strategies would you prefer to use for the next production release of
│ the mobile backend service?

❯ 1. Blue-green deployment with automated smoke tests and an instant rollback path if errors rise
     Run the new version alongside the current one, verify it with automated smoke tests, then switch
     traffic over and roll back instantly if errors increase.
  2. Canary
     Send a small share of traffic to the new version first, then widen the rollout gradually as metrics
     stay healthy.
  3. Rolling
     Replace instances of the old version with the new one in batches until the whole fleet is updated.
  4. Type something.
────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel"#;

/// Four options whose labels wrap onto a second row and whose descriptions are long.
pub(super) const TALL: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me about a rollout.
────────────────────────────────────────────────────────────
 ☐ Plan

Which rollout plan do you want?

❯ 1. Phased rollout: ship to a small internal canary group first, then expand to all users over two weeks
     once error rates and latency hold steady
     Start with a canary cohort of internal employees and a few trusted beta users, watching error rates,
     latency, and support tickets closely at each stage. Expand in measured increments over roughly two
     weeks, pausing automatically if any health metric crosses its threshold.
  2. Big-bang release: enable the feature for every user at once on a single scheduled date with a
     coordinated announcement and support staffing
     Turn the feature on for all users simultaneously on one pre-agreed launch date, paired with a
     coordinated announcement, updated help documentation, and extra support staffing.
  3. Region-by-region rollout: release market by market, starting with one smaller region and adding
     larger regions only after each one is verified stable
     Launch first in a single lower-risk region with a smaller user population, verify functionality,
     then add remaining regions one at a time in order of increasing size and complexity.
  4. Opt-in beta program: keep the feature hidden behind a settings toggle and let users choose to enable
     it, collecting feedback before any default change
     Release the feature as an optional toggle that users must actively switch on, so only motivated
     early adopters encounter it at first.
  5. Type something.
────────────────────────────────────────────────────────────
  6. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel"#;

/// The review tab of the form: both questions answered.
pub(super) const REVIEW: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me two things.
────────────────────────────────────────────────────────────
←  ☒ Lang  ☒ Extras  ✔ Submit  →

Review your answers

 ● Which language do I prefer?
   → Go
 ● Which extras do I want?
   → Tests

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel"#;

/// The review tab with the first question left out.
pub(super) const REVIEW_UNANSWERED: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ Ask me two things.
────────────────────────────────────────────────────────────
←  ☐ Lang  ☒ Extras  ✔ Submit  →

Review your answers

⚠ You have not answered all questions

 ● Which extras do I want?
   → Tests

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel"#;

/// A command approval of Claude Code: numbered rows, no question tool.
pub(super) const APPROVAL_BASH: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

⏺ Update(note.txt)
  Creating an empty file
  ⎿  $ touch /home/dev/project/x.txt

────────────────────────────────────────────────────────────
 Bash command
 Create an empty file
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 touch /home/dev/project/x.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /home/dev/project from this project
   3. No

 Esc to cancel · Tab to amend"#;

/// An edit approval.
pub(super) const APPROVAL_EDIT: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

⏺ Update(note.txt)
  Read 1 file

⏺ Update(/home/dev/project/note.txt)

────────────────────────────────────────────────────────────
 Edit file
 note.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 1 -hello world
 2 +hello there
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to note.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits for this session
      (shift+tab)
   3. No

 Esc to cancel · Tab to amend"#;

/// A plan approval.
pub(super) const PLAN_APPROVAL: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

⏺ Plan ready
  ────────────────────────────────────────────────────────────
   Claude has written up a plan and is ready to execute. Would you like to proceed?

   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback

   ctrl+g to edit in Vim · ~/.claude/plans/plan.md"#;

/// A picker with the question dialog's footer and numbered rows, but no `Chat about this`: not the question tool.
pub(super) const PICKER: &str = r#" ▐▛███▛█   Claude Code v2.1.295
▝▜██████▀  Sonnet 5.5 · Claude Max
   /home/dev/project

❯ /model
────────────────────────────────────────────────────────────
 Select model

❯ 1. Default
  2. Opus
  3. Haiku

Enter to select · ↑/↓ to navigate · Esc to cancel"#;
