# The GTK host dies when a native widget goes away: `LD_PRELOAD=libjemalloc` + `free_sized(NULL)`, not a `selectable` `TextView`

Not an nsh bug, and nothing to send to `longbridge/nsh`. This file keeps its old name because it first held a draft report that blamed a selectable `TextView` in a recycled `List` cell (the heap abort `memory allocation of 5 bytes failed` in `selectable_view::Area::install`). That diagnosis was wrong. The real cause was found on 2026-11-07 and is below, with the evidence.

## Summary

On a machine that preloads a jemalloc 5.3.1 into every process (`export LD_PRELOAD=/usr/local/lib/libjemalloc.so.2` in `~/.zshrc`), the nsh Linux host dies as soon as it destroys certain native widgets (a chat tab replaced by the terminal mirror, a tab closed, a text input unmounted):

- GTK 4.22 (Ubuntu 26.04, glibc 2.43) frees a `GtkActionMuxer` with the C23 function `free_sized(ptr, size)` and `ptr` is `NULL`. C23 defines that as a no-op.
- The preloaded jemalloc interposes `free_sized`, does not test for `NULL`, and puts the `NULL` pointer into its thread cache (`tcache`) as if it were a freed 8-byte block.
- The next allocation of that size class (a Rust `Vec` of 5 bytes, a Pango glyph array) is served that entry: `malloc` returns `NULL`. Rust's allocator then aborts with `memory allocation of 5 bytes failed` (the old report), or a later `tcache` flush dereferences it and the process gets `SIGSEGV` with no message (the `pane` scenario: `the host left`). The same on `junk:true` is an immediate fault in `memset(NULL)`.

Neither the app's TSX nor nsh's `selectable_view` takes part. Without the preload the same flows pass; with it, they fail in the first widget swap.

## How it was found

1. `.shots/screens.test.tsx` scenario `pane` (open `payments review`, press `Show terminal`) failed 6 of 6 with `the host left`. `nsh test` hides the child's exit status. `strace -f -e trace=exit_group,kill,tgkill -o /tmp/x nsh test ...` showed the host `killed by SIGSEGV (core dumped)`.
2. The host under `gdb` (the test host binary swapped for a wrapper script once the build step finished; `ptrace_scope` is 1, so attaching from outside is refused):

```
Thread 1 received signal SIGSEGV
#0  emap_edata_lookup_batch (... nptrs=4 ...)           include/jemalloc/internal/emap.h:381
#1  arena_ptr_array_flush_impl                          src/arena.c:1481
#3  tcache_bin_flush_bottom                             src/tcache.c:648
#7  tcache_gc_event
#11 isfree (...)  #12 je_sdallocx_default               src/jemalloc.c
#13 ?? () from libpangoft2-1.0.so.0
#16 pango_layout_iter_get_run_extents () from libpango-1.0.so.0
#18 pango_layout_get_cursor_pos ()  #19 pango_layout_get_caret_pos ()
#20 ?? () from libgtk-4.so.1   (a text input drawing its caret)
#34 nsh_platform_linux::view::imp::NshView::draw
```

   jemalloc's own frames in the process, a Pango free as the victim: the heap was already damaged. `LD_PRELOAD` was set in the shell (`echo $LD_PRELOAD` printed `/usr/local/lib/libjemalloc.so.2`).
3. Without the preload (`env -u LD_PRELOAD`, or any other `LD_PRELOAD` value) `pane light 1280` passed 3 of 3. With an unrelated preload that only added a constructor it passed too.
4. The cause, from a breakpoint on `free_sized` with `$rdi == 0` (`jemalloc.c:2084`, `free_sized (ptr=0x0, size=0)`):

```
#0  free_sized (ptr=0x0, size=0)                    jemalloc.c:2084
#1  ?? () from libgtk-4.so.1
#2  g_object_unref ()         <- the object: GtkActionMuxer
#3  ?? () from libgtk-4.so.1
#4  g_object_unref ()
#5  glib::object::ObjectRef::drop ... nsh_platform_linux::view::Native (the widget of an input in the chat's view)
#12 nsh_platform_linux::mount::Mounter::apply
```

   With `MALLOC_CONF=junk:true,tcache:false` the first `free_sized(NULL, ...)` crashes at once in `default_junk_free` (`memset(__dest=0x0)`).
5. A reproduction without GTK, `free_sized.c` (`gcc -std=gnu2x`, glibc 2.43):

```c
void *volatile z = NULL;
for (int i = 0; i < 3; i++) free_sized(z, 0);
int nulls = 0;
for (int i = 0; i < 5; i++) if (!malloc(5)) nulls++;
printf("malloc(5) returned NULL %d times of 5\n", nulls);
```

   `env -u LD_PRELOAD ./a.out`: `0 times of 5`. `LD_PRELOAD=/usr/local/lib/libjemalloc.so.2 ./a.out`: `3 times of 5`. The jemalloc is `5.3.1-0-g81034ce` (strings of the library; it has `free_sized`, which stock 5.3.0 does not).

## What it means

- Any program on such a machine that links a GTK built against glibc 2.43 and starts from that shell can hit it; every widget that owns actions (all of them in a window) frees an action muxer. nsh only makes it likely, because it creates and destroys native widgets as the TSX tree changes.
- The earlier note (`components/markdown.tsx`: "a selectable view that a recycled cell unmounts takes the process down, seen with a chat of 40 rows") was this bug seen from another window state: `memory allocation of 5 bytes failed` is the allocator abort of a `malloc` that returned the `NULL` queued by `free_sized`. [INFERENCE] The stripped lab that did not reproduce it never destroyed a widget that frees such a muxer. After the fix, scenes of a transcript of 130 rows with `selectable` on every agent message's `TextView` (`components/session-lab.tsx`: `long`, `chat`, `tools`, `plan`), scrolled up and down 8 times each, dragged over, with `Ctrl+A` and `Ctrl+C`, a theme switch and two resizes, pass on the real GTK host (a throwaway test, not kept).

## The fix in herdr-desktop

`native/app/src/preload_guard.rs`, a constructor that runs before `main` (the loader calls it from `.init_array`), looks at the entries of `LD_PRELOAD`, finds those that the loader has mapped and that export `free_sized` (`dlopen(.., RTLD_NOLOAD)` + `dlsym`), and, when there are any, executes the same binary again (`/proc/self/exe`, same arguments) with those entries removed. It prints one line to stderr naming the library. `HERDR_DESKTOP_KEEP_PRELOAD=1` keeps the preload, to reproduce the failure. A process cannot unload a library the loader mapped, so a restart before `main` is the only place where "impossible" is true: it covers `nsh run`, `nsh test --target linux`, and the packaged app, in any shell. Only entries that define `free_sized` go: other preloads (and a jemalloc without `free_sized`) stay.

Checks:

- `cargo test --manifest-path native/app/Cargo.toml --lib preload_guard`: the entry split, and a child process started with the machine's jemalloc preloaded that calls `free_sized(NULL, 0)` and then allocates (`PROBE preload="" nulls=0` with the guard, `preload="/usr/local/lib/libjemalloc.so.2" nulls=3` without).
- `make shots`, scenario `chat-swap` (chat, `Show terminal`, `Show chat` twice, `mod+w`, a second chat with a theme switch and a resize, `mod+w`): with the guard 6 of 6 pass; with `HERDR_DESKTOP_KEEP_PRELOAD=1` it fails in its first swap with `the host left`. The scenario fails whenever the host dies, for any reason.

Consequence for the chat: `MarkdownText` no longer has `inList`; every agent message is one selectable area again, so a drag crosses paragraphs, lists, code blocks and tables. `Copy message` stays as the one-press way to take a whole answer.

## If you report something upstream

- jemalloc (`jemalloc/jemalloc`): `free_sized(NULL, n)` and `free_aligned_sized(NULL, ...)` must be no-ops (C23 7.24.3.4); the `sdallocx` path they share has no `NULL` check.
- Anyone preloading a jemalloc that has `free_sized` on a glibc >= 2.43 desktop: remove it from `LD_PRELOAD` for GUI programs (`env -u LD_PRELOAD herdr-desktop`), or use a jemalloc that checks `NULL`.
