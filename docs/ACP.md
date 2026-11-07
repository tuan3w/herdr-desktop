# ACP coverage

What this app does of the [Agent Client Protocol](https://agentclientprotocol.com), measured against the schema, with the test that shows it. **Schema checked: v1 `1.29.1` (2026-11-02, `agentclientprotocol/agent-client-protocol` `schema/v1/schema.json`, the stable surface; unstable RFDs are listed at the end).** A row is `full` only when a test makes the scripted agent (`native/core/tests/support/fake_acp_agent.py`) or a reducer test do the thing and checks what the person would see. `partial` and `missing` say why.

Tests: `E2E` is `native/core/tests/session_acp.rs` (the real keeper script, the scripted agent, `SessionHub`); `S` is `native/core/tests/session.rs`; `A` is the `tests` module of `native/core/src/session/adapter.rs`; `V` are unit tests inside `native/core/src/session/vendored/` (the vendored reducer and `acp` parser).

## How it is wired

The agent runs on some machine under a **keeper** (python3, herdr-mobile's one file). The keeper is the agent's only client: it sends `initialize` itself, caches the answer, replays the conversation to whoever attaches, and holds `session/request_permission` and `elicitation/create` until one client answers. This app is a *client of the keeper* speaking ACP JSON-RPC lines (`attach`); the reducer in `native/core/src/session/vendored/session.rs` is a viewer. So **what the agent is told it can do is decided in the keeper's `init_request`** (`vendored/keeper.py`), and what this app does with the answers is `vendored/{session,transcript,acp}` behind `adapter.rs`.

## Matrix

| Feature | Spec | Handled where | Status | Tested by |
|---|---|---|---|---|
| `initialize`: `protocolVersion` 1 | initialization | keeper `init_request` | partial: sent, the agent's answered version is not checked | `E2E the_keeper_tells_the_agent_what_this_client_can_do...` (sent) |
| `clientCapabilities.fs`, `terminal` | file-system, terminals | keeper: both `false` | **by decision**, see "Files and terminals" | `E2E the_keeper_tells_the_agent...`, `E2E a_request_for_a_file_or_a_terminal_is_refused_as_not_offered` |
| `clientCapabilities.elicitation.form` | elicitation | keeper, `vendored/question.rs` | full | `E2E the_keeper_tells...`, `S a_permission_is_answered_only_by_the_person...` (a form) |
| `clientCapabilities.elicitation.url` | elicitation | not advertised; an agent never asks | missing: no browser hand-off UI | `E2E the_keeper_tells...` (absent) |
| `clientCapabilities.session.configOptions.boolean` | session-config-options | keeper | full | `E2E the_keeper_tells...`, `E2E a_select_and_a_boolean_option...` |
| `clientCapabilities.session.notices` / `.compaction` | prompt-turn | keeper | full | `E2E the_keeper_tells...`, `E2E a_notice_and_a_compaction_arrive...` |
| `clientCapabilities.auth.terminal` | authentication | not advertised | missing: the app cannot run a terminal login for the person | |
| `clientInfo` | initialization | the keeper tells the agent `herdr-keeper`; this app tells the keeper `herdr-desktop` | full (names the other clients see) | (read from `native/core/src/session/vendored/session.rs`, not asserted) |
| `agentCapabilities`, `agentInfo` read | initialization | `AgentCaps` in `vendored/session.rs` -> `AcpInfo` -> `SessionView.acp` | full | `E2E what_the_agent_says_about_itself_reaches_the_screen` |
| `authMethods` (agent type) + `authenticate` | authentication | `Session::authenticate`, `SessionPhase::AuthRequired`, `Sessions.authenticate`; the card is `components/session-signin.tsx` | full | `E2E an_agent_that_wants_a_sign_in_is_signed_in_to...`; the card: `components/session-tab.test.tsx` (scripted port) |
| `authMethods` (terminal type) | authentication | shown with its `args` (the card gives the arguments only: the agent's program name is not in `SessionView`); `Sessions.reopen` after the person did it | full | `E2E a_sign_in_done_in_a_terminal_is_told_how...`; the card: `components/session-tab.test.tsx` |
| `logout`, `auth.logout` | authentication | flag exposed (`AcpView.canLogout`) only | missing: no sign-out UI | `E2E what_the_agent_says...` (flag) |
| `session/new` (`cwd`, `mcpServers: []`) | session-setup | `Begin::Create` | full | every `E2E` test; `S` |
| `mcpServers` with servers, `additionalDirectories`, `systemPrompt` | session-setup | never sent | missing: no UI for them | |
| `session/load` (replay) | session-setup | keeper serves its own; a new keeper forwards | full | `S closing_the_connection_leaves_the_agent_running...`, `E2E an_agent_that_loads_replays_a_past_session...` |
| `session/resume` | session-setup | fallback when the agent refuses `session/load` | full | `E2E an_agent_that_only_resumes_reopens...` |
| `session/list` (+ `cwd`, cursor) | session-list | keeper `history` (`PastSessions`) | full | `S a_past_session_can_be_continued_in_a_new_keeper`, `E2E an_agent_that_loads...` |
| `session/close`, `session/delete`, `session/fork` | session-setup, session-delete | `Sessions.kill` ends the keeper's agent process instead | missing: no UI; agents offer them (omp: close, fork; Claude/Codex: close, delete, fork) | |
| `session/prompt` text, `resource_link`, `image` blocks | content | `attach::blocks`; a pasted picture is prepared by `compose::prepare` and sent by `outgoing::build` (refused for another machine's agent that cannot see) | full | `E2E a_prompt_carries_text_a_picture_and_a_link...`, `E2E a_pasted_picture_reaches_an_agent_that_sees...`, `E2E an_agent_that_cannot_see_is_told_where_the_picture_is...` |
| prompt `audio` | content | never sent | missing: no mainstream agent advertises `promptCapabilities.audio` (omp, Claude Code, Codex, pi: all false or absent) | `E2E what_the_agent_says...` (flag exposed) |
| prompt embedded `resource` | content | a text file of at most 32 KB goes as an embedded `resource` when the agent advertises `embeddedContext`, else as `resource_link` (`session/outgoing.rs`) | full | `E2E a_mentioned_small_file_is_embedded_for_an_agent_that_takes_context...` |
| message blocks of every type shown (`image`, `audio`, `resource_link`, `resource`) | content | `Part` in `acp/update.rs`, `ItemKind::Message.parts` | full | `E2E every_kind_of_content_block_in_a_message...`, `V update.rs chunks_carry...` |
| tool output blocks (`image`, `resource_link`) | tool-calls | `ToolView.parts` | full; `resource` and `audio` blocks go through the same parser, not tested on their own | `E2E a_tool_row_has_its_name_files_input...` |
| stop reasons `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled` | prompt-turn | `Transcript::turn_end` | full: `end_turn` is silent, the others say `Turn ended: <reason>` | `V transcript.rs a_turn_that_ends_with_a_call_open...`, `A a_stopped_turn_leaves_its_open_calls_cancelled...` |
| `session/cancel` (notification), pending requests answered `cancelled`, open calls marked | cancellation | `Session::cancel` | full | `E2E a_stopped_turn_that_the_agent_answers_with_an_error_ends_as_cancelled`, `V session.rs` cancel tests |
| a cancelled prompt answered with an error counts as cancelled | cancellation | `Session::cancelling` | full | `E2E a_stopped_turn_that_the_agent_answers_with_an_error...` |
| `$/cancel_request` from the agent | cancellation | `Session::forget` | full | `A` (`$/cancel_request` of a waiting request) |
| `$/cancel_request` sent by the client | cancellation | never sent (a turn is stopped with `session/cancel`) | missing: nothing needs it | |
| `session/set_mode` and `modes` | session-modes | `legacy_modes`, `Session::set_config` | full | `E2E an_agent_that_reports_only_modes...` |
| `session/set_config_option` select + boolean | session-config-options | `Session::set_config`, `SessionOption.boolean` | full | `E2E a_select_and_a_boolean_option...` |
| `config_option_update`, `current_mode_update` | session-config-options, session-modes | `Transcript::apply` | full | `E2E a_select_and_a_boolean_option...` (update), `E2E an_agent_that_reports_only_modes...` |
| config option categories `mode`, `model`, `model_config`, `thought_level` | session-config-options | `SessionOption.category` | full for `mode`, `model`, `thought_level`; `model_config` and other categories shown as ordinary options | `E2E a_select_and_a_boolean_option...` |
| `session/update`: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk` (+ `messageId`) | prompt-turn | `Transcript::chunk` | full | `V transcript.rs chunks_of_one_message_join...`, `S` |
| `tool_call`, `tool_call_update`: title, kind, status, text and diff content | tool-calls | `merge_tool` | full | `S`, `V transcript.rs`, `A unchanged_items_keep_their_identity...` |
| tool `terminal` content and `_meta` output (`terminal_output_delta`, `terminal_output`, `terminal_exit`, `terminal_info`) | terminals (as agents use it) | `Stream` in `acp/update.rs`, `Streamed` in `transcript.rs` | full | `E2E a_command_whose_output_only_comes_in_meta...`, `E2E a_failed_command_shows_its_exit_code...`, `A a_long_streamed_output_keeps_only_its_head_and_tail...` |
| tool `locations`, `rawInput`, `rawOutput`, `name` | tool-calls | `ToolCall::from_value` | full | `E2E a_tool_row_has_its_name_files_input...`, `A what_the_agent_puts_in_content_is_its_own_account...` |
| `plan` | agent-plan | `Transcript::plan` | full | `E2E the_plan_the_commands_and_the_context_are_kept_current` |
| `available_commands_update` (+ `input.hint`) | slash-commands | `Transcript::commands` | full | same |
| `session_info_update` (`title`, `updatedAt`) | session-list | `Transcript::title`, `updated_at` | full | same |
| `usage_update` (`used`, `size`, `cost`) and the prompt answer's `usage` | usage (RFD, stable in v1.29) | `AcpInfo.usage`, `AcpInfo.turn_usage` | full | same |
| `notice` | prompt-turn | `ItemKind::Notice`; dropped while the history replays | full | `E2E a_notice_and_a_compaction_arrive...`, `A a_notice_in_a_history_replay_is_not_news...` |
| `compaction_update` | prompt-turn | one `Note` that changes in place | partial: `compaction_summary_chunk` and the summary text are not shown | `E2E a_notice_and_a_compaction_arrive...` |
| `session/request_permission`, option kinds `allow_once`, `allow_always`, `reject_once`, `reject_always` | tool-calls | `Waiting`, `PermissionView` (`standing` for `*_always`) | full | `S a_permission_is_answered_only_by_the_person...`, `A` |
| `elicitation/create` form mode | elicitation | `vendored/question.rs` | full | `S a_permission_is_answered_only_by_the_person...` |
| `fs/read_text_file`, `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release` | file-system, terminals | answered `-32601` | **by decision** (not offered), see below | `E2E a_request_for_a_file_or_a_terminal_is_refused_as_not_offered` |
| unknown agent request (`_...`) | extensibility | answered `-32601` | full | same |
| unknown update kind, unknown `_` notification | extensibility | ignored, never an error | full | `V update.rs an_unknown_kind_is_kept...` |
| `_meta` | extensibility | read where a convention needs it (terminal output, `_meta.herdr`) | partial: not propagated | |
| errors `-32000` (auth), `-32002`, `-32003` (omp busy), `-32602`, `-32603` | error | `-32000` opens `AuthRequired`; `-32003` queues; the rest show the agent's message (`Not sent: ...`, `the session did not open (...)`) | full for `-32000` and `-32003`; partial for the rest | `E2E an_agent_that_wants_a_sign_in...`, `V session.rs a_prompt_the_agent_fails_is_a_failed_turn_for_the_queue_but_a_busy_one_is_not` |
| malformed line, stray output | transports | ignored | full | `S` (`noise`) |
| items timed (`startedMs`, `endedMs`, `turnStartedMs`) | not ACP: the app's clock | `ItemCache::stamp` | full | `E2E live_items_have_a_start_and_an_end...`, `E2E a_stopped_turn...` |

## Files and terminals: why the app does not offer them

`fs/*` and `terminal/*` are the editor's way to let an agent use the editor's buffers and terminal. Here the agent runs on the keeper's machine as the same user, with its own file and shell tools, and the person watches a transcript, not a buffer. Evidence, read from the adapters installed on this machine (`~/.local/share/herdr-mobile/acp-adapters`) and from real `initialize` runs (below):

- All four agents answered `initialize` **identically** whether `fs` and `terminal` were `true` or `false`, and none sent an `fs/*` or `terminal/*` request in a turn.
- `codex-acp` streams a command's output in `_meta.terminal_output_delta` to every client that is not JetBrains AIR, announcing the command as `content: [{type: "terminal"}]`; `pi-acp` does the same with `terminal_output`. That output was **invisible** here before this work (the reducer dropped terminal content and `_meta`); it now shows in the tool row. Claude Code's adapter has no terminal `_meta` in its source (command output is text content).
- If the keeper advertised `terminal: true`, it would have to *run* the agent's commands outside the agent's own sandbox and approval rules, keep their output, and replay it to clients that attach later (the replay log trims entries by turn): a second execution surface for a gain the agent already provides. If the *app* answered, it would fail whenever the window is closed, because the agent blocks on the answer and the keeper cannot hold it (only permissions and questions are held).
- An agent that asks anyway gets `-32601` at once from the reducer (tested), never a hang.

So: not offered, refused cleanly. Revisit only if an agent appears whose output cannot reach the transcript otherwise.

## Real agents (this machine, 2026-11-07, `say hi`, no tool use, scratch folder)

All four speak ACP headless here and answered `initialize`, `session/new` and one turn with `end_turn`. Run with a throwaway driver under `.scratch/acp-smoke/`; credentials and session titles were not read.

| Agent | Version | `agentInfo` | `promptCapabilities` | `sessionCapabilities` | `authMethods` | Options (`session/new`) | Notes |
|---|---|---|---|---|---|---|---|
| omp | `omp acp` 18.10.2 | `omp` | image, embeddedContext | list, fork, resume, close; `loadSession` | `agent` ("Use existing local credentials") | `mode`, `model` (834 values), `thinking` (`thought_level`), also `modes` | 101 commands; `usage_update` + prompt `usage`; `session_info_update` carries only `updatedAt`; no title (the app falls back to the first message) |
| Claude Code | `claude-agent-acp` 0.85.1 | `@agentclientprotocol/claude-agent-acp` | image, embeddedContext | list, delete, fork, resume, close, additionalDirectories, subagents; `loadSession`; `auth.logout` | none (uses the `~/.claude` login) | `mode` (5), `model`, `effort` (`thought_level`) | 127 commands; `usage_update` size 1,000,000; `_meta.steering.supported`; `_auth/status_update` notification |
| Codex | `codex-acp` 2.1.1 | `@agentclientprotocol/codex-acp` | image, embeddedContext | resume, list, close, delete, fork, additionalDirectories, subagents; `loadSession`; `auth.logout` | `api-key`, `chat-gpt` | `mode`, `collaboration_mode`, `model`; also legacy `models` | 98 commands; **no** `usage_update`, prompt `usage` is null; `session_info_update` carries `_meta.codex.threadStatus`; `mcpCapabilities.acp: false` |
| pi | `pi-acp` 0.0.34 | `pi-acp` | image only (`audio: false`, `embeddedContext: false`) | list, delete; `loadSession` (no resume, close, fork) | `pi_terminal_login` (**terminal** type, `args: ["--terminal-login"]`) | `model`, `thought_level`; its `modes` are thinking levels | startup banner pushed as an `agent_message_chunk`; the `say hi` turn ended with `end_turn` and **no message** (cause not found, `[INFERENCE]` a login or model problem on pi's side) |

None sent an agent-to-client request during the turn. `omp`'s `elicitation/create` is documented in herdr-mobile's `docs/AGENT_SESSIONS.md` (needs the form capability the keeper offers).

## What changed in the vendored code

Everything lives in `native/core/src/session/vendored.patch` (regenerate with `scripts/sync-vendored.sh --make-patch` after editing the vendored files; `--check` must pass against herdr-mobile at the commit in `vendored/UPSTREAM`). **The patch is about 2,200 lines** (diff context included), most of it the `acp` crate's parser and the reducer: that is more divergence than a patch should carry. The `acp` changes (`Part`, terminal `Stream`, locations, `rawOutput`, boolean options, `modes`, usage with cost, notices, compaction) are general, tested, and the candidate to upstream into herdr-mobile's `rust/crates/acp` so the next `sync-vendored.sh` drops them from the patch.

- `acp` is vendored as `vendored/acp/` (it was a path dependency on herdr-mobile). That dropped the `preserve_order` feature of `serde_json` that herdr-mobile's workspace turns on; `native/core/Cargo.toml` sets it, because a question form is walked in the order its schema lists the fields (three question tests failed without it).
- `keeper.py`: the keeper also tells the agent `session.notices` and `session.compaction`.
- `Driver::begin_turn`: a turn begins when the prompt goes out. A turn the agent answered while the session thread was still draining one burst of lines was never seen to run, so it ended with no `Done in ...` summary and its queue was never settled (the cause of the flaky `Done` waits in tests).

## Still partial or missing, and why

| Row | Why |
|---|---|
| `fs/*`, `terminal/*` | by decision, above |
| `elicitation` URL mode, `auth.terminal` | no UI to hand a URL to a browser or run a login in a terminal; both stay unadvertised so no agent asks |
| `logout`, `session/close`, `session/delete`, `session/fork`, `additionalDirectories`, `systemPrompt`, MCP servers | no UI; agents offer them |
| prompt `audio` | no mainstream agent advertises it |
| `compaction_summary_chunk` | the summary text is not shown, only the progress note |
| `_meta` propagation, `-32602`/`-32603` details | messages are shown as the agent words them |
| subagents (`sessionCapabilities.subagents`, RFD), `session/set_model`, `session/set_title`, `session/status`, `auth/status`, archive, plan operations, v2 draft (`user_message`/`agent_message` upserts, `plan_update` variants beyond `items`, `tool_call_content_chunk`) | unstable or draft, and none was seen from the four agents here; unknown kinds are ignored, never an error |
| Claude/Codex `_meta.steering` (send while a turn runs) | messages sent mid-turn are queued by the app and go when the turn ends |
| a sign-in or turn against the agents' real servers, `Continue` against a real `omp`, permissions with a real Claude/Codex | **unverified**: no tool use or login was driven; only `initialize`, `session/new` and a `say hi` turn |

## Files and pictures in a prompt (what the adapters do with them)

Read from `~/.local/share/herdr-mobile/acp-adapters` (2026-11-07): Claude Code's `promptToClaude` turns a `resource_link` into the text `[@name](uri)` and an embedded text `resource` into that link plus a `<context ref="uri">` block, an `image` into an image source; Codex's `buildPromptItems` does the same (`resource_link` becomes text, `resource` link plus `<context>`, `image` a data URL). Zed embeds small files the same way. So the message keeps `@path` in its words (an agent that reads only text still sees it) AND sends the file as a block. Folders go as `resource_link` only. Files are read on the caller's thread (local or over the shared ssh connection), never on the session's.
