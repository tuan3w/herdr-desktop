import { Media } from "herdr-desktop/native";
import { cleanup, computed, effect, signal, untracked } from "nsh";

import type { FetchView } from "herdr-desktop/native";

/**
 * A file made ready to play: on this computer it is ready at once (the file itself, nothing copied); on another machine
 * it is copied into the media cache with progress and a way to stop, then played from there. Call it in a component: it
 * lets go of its copy when the component goes (the cache then takes the copy away when it needs the room), and starting
 * over (`retry`) lets go of the old one first. The copying is Rust's (`Media.fetch`); this holds the one thing the screen
 * reads, in the words of `phase`.
 */
export type SourcePhase = "starting" | "copying" | "ready" | "failed" | "cancelled";

export interface Source {
  phase: () => SourcePhase;
  /** Where the file plays on this computer, once ready. */
  local: () => string | undefined;
  /** Whether `local` is a copy in the cache (another machine's file). */
  copied: () => boolean;
  /** Why it failed, in words for the person. */
  message: () => string | undefined;
  /** It failed because the file is bigger than the cache. */
  tooBig: () => boolean;
  /** 0 to 1 while copying, `null` when the size is not known. */
  fraction: () => number | null;
  done: () => number;
  total: () => number;
  /** The copy's id for Rust-side calls (`Media.releaseFetch`), or `null` before it started. */
  id: () => number | null;
  cancel: () => void;
  retry: () => void;
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Starts making `path` of `machine` ready, now and again whenever either changes. */
export function openSource(target: () => { machine: string; path: string }): Source {
  const id = signal<number | null>(null);
  const views = signal<readonly FetchView[]>([]);
  const startError = signal<string | undefined>(undefined);
  const attempt = signal(0);
  let latest = 0;

  cleanup(Media.onFetchChange(() => views.set(Media.fetches())));
  const view = computed(() => views().find((v) => v.id === id()));

  effect(() => {
    const { machine, path } = target();
    attempt();
    const mine = ++latest;
    untracked(() => {
      const old = id();
      if (old !== null) Media.releaseFetch(old);
      id.set(null);
      startError.set(undefined);
      Media.fetch(machine, path).then(
        (next) => {
          if (mine !== latest) {
            Media.releaseFetch(next);
            return;
          }
          id.set(next);
          views.set(Media.fetches());
        },
        (e) => {
          if (mine === latest) startError.set(reason(e));
        },
      );
    });
  });
  cleanup(() => {
    latest++;
    const old = id();
    if (old !== null) Media.releaseFetch(old);
  });

  const phase = (): SourcePhase => {
    if (startError() !== undefined) return "failed";
    const v = view();
    if (!v) return "starting";
    return v.state === "running"
      ? "copying"
      : v.state === "ready"
        ? "ready"
        : v.state === "failed"
          ? "failed"
          : "cancelled";
  };

  return {
    phase,
    local: () => view()?.local ?? undefined,
    copied: () => view()?.copied ?? false,
    message: () => startError() ?? view()?.message ?? undefined,
    tooBig: () => view()?.tooBig ?? false,
    fraction: () => {
      const v = view();
      return v && v.total > 0 ? Math.min(1, v.done / v.total) : null;
    },
    done: () => view()?.done ?? 0,
    total: () => view()?.total ?? 0,
    id,
    cancel: () => {
      const now = id();
      if (now !== null) Media.cancelFetch(now);
    },
    retry: () => attempt.update((n) => n + 1),
  };
}
