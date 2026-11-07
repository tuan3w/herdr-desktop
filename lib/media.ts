import { signal } from "nsh";

import type { Signal } from "nsh";

/**
 * What the video and audio player knows and decides, apart from the screen: the clock, the keys, what is announced.
 * The picture, the sound and the file are the host's (`Video`) and Rust's (`Media`); this file is told what they report
 * (`loaded`, `progress`, `ended`, `failed`) and what the person asks (`toggle`, `seekBy`, `volumeBy`...), and keeps the one
 * truth the controls show. Nothing here starts by itself: a player is paused until the person presses play.
 */

const VIDEO = /\.(mp4|mov|m4v|webm|mkv|ogv)$/i;
const AUDIO = /\.(mp3|m4a|ogg|oga|opus|wav|flac|aac)$/i;

/** Whether the file name says video or audio (the core decides the same by extension). */
export function mediaKindOf(name: string): "video" | "audio" | null {
  if (VIDEO.test(name)) return "video";
  return AUDIO.test(name) ? "audio" : null;
}

/** `1:05`, `12:30`, `1:02:03`: a position or a length as a clock. A length that is not known yet is `--:--`. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What a screen reader hears for the position: `1:05 of 4:20`. */
export function positionText(position: number, duration: number): string {
  return duration > 0 ? `${clock(position)} of ${clock(duration)}` : clock(position);
}

/** The seconds one arrow key moves, and one with Shift. */
export const SEEK_STEP = 5;
export const SEEK_BIG = 30;

/** How long after a seek the engine's progress reports are ignored: the last one it sent before the jump would pull the bar back. */
const SEEK_SETTLE_MS = 600;

/** What a held key says is not repeated faster than this. */
const ANNOUNCE_EVERY_MS = 400;

export type PlayerState = "loading" | "ready" | "playing" | "paused" | "ended" | "error";

/** What the player needs from outside: the engine's seek, the screen reader, and a clock a test can set. */
export interface PlayerDeps {
  seek: (seconds: number) => void;
  say: (message: string) => void;
  now: () => number;
}

export interface Player {
  state: Signal<PlayerState>;
  /** The person wants it playing (the host's `paused` is the opposite). Not true after it ended or failed. */
  playing: Signal<boolean>;
  position: Signal<number>;
  /** 0 until the engine says. */
  duration: Signal<number>;
  /** 0 to 1. */
  volume: Signal<number>;
  muted: Signal<boolean>;
  repeat: Signal<boolean>;
  buffering: Signal<boolean>;
  /** Whether the file has a picture: unknown until it loads, false for sound that came as a video. */
  picture: Signal<boolean | null>;
  failure: Signal<string | null>;
  toggle: () => void;
  seekBy: (delta: number) => void;
  seekTo: (seconds: number) => void;
  volumeBy: (delta: number) => void;
  setVolume: (value: number) => void;
  toggleMute: () => void;
  toggleRepeat: () => void;
  /** The host's events. */
  loaded: (info: { duration: number; width: number; height: number }) => void;
  progress: (at: { currentTime: number; duration: number }) => void;
  ended: () => void;
  failed: (message: string) => void;
  buffer: (on: boolean) => void;
  /** Runs the key if it is a player key; false when it is not (the caller leaves it alone). */
  key: (key: string, shift: boolean) => boolean;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * One player's state and rules. Keys: Space play or pause; Left and Right 5 s (Shift 30 s); Up and Down volume by a tenth;
 * `m` mute; `l` loop; Home and End the ends. Everything a key does is also a control, and everything that changes says
 * what it did through `say` (`Playing`, `Paused`, `1:05 of 4:20`, `Volume 70%`).
 */
export function createPlayer(deps: PlayerDeps): Player {
  const state = signal<PlayerState>("loading");
  const playing = signal(false);
  const position = signal(0);
  const duration = signal(0);
  const volume = signal(1);
  const muted = signal(false);
  const repeat = signal(false);
  const buffering = signal(false);
  const picture = signal<boolean | null>(null);
  const failure = signal<string | null>(null);
  let settleUntil = 0;
  let saidAt = -Infinity;

  const usable = () => state() !== "error" && state() !== "loading";
  const sayHeld = (message: string) => {
    const now = deps.now();
    if (now - saidAt < ANNOUNCE_EVERY_MS) return;
    saidAt = now;
    deps.say(message);
  };

  const seekTo = (seconds: number) => {
    if (!usable()) return;
    const length = duration();
    const target = clamp(seconds, 0, length > 0 ? length : seconds);
    settleUntil = deps.now() + SEEK_SETTLE_MS;
    position.set(target);
    deps.seek(target);
    // Seeking back from the end leaves the ended state.
    if (state() === "ended" && target < length) state.set(playing() ? "playing" : "paused");
    sayHeld(positionText(target, length));
  };

  const setVolume = (value: number) => {
    const next = clamp(Math.round(value * 20) / 20, 0, 1);
    volume.set(next);
    if (next > 0 && muted()) muted.set(false);
    sayHeld(`Volume ${Math.round(next * 100)}%`);
  };

  const toggle = () => {
    if (!usable()) return;
    if (state() === "ended") {
      // Pressing play on a finished clip plays it again from the start.
      position.set(0);
      deps.seek(0);
      settleUntil = deps.now() + SEEK_SETTLE_MS;
      playing.set(true);
      state.set("playing");
      deps.say("Playing");
      return;
    }
    const next = !playing();
    playing.set(next);
    state.set(next ? "playing" : "paused");
    deps.say(next ? "Playing" : "Paused");
  };

  const toggleMute = () => {
    muted.update((m) => !m);
    deps.say(muted() ? "Muted" : "Sound on");
  };

  const toggleRepeat = () => {
    repeat.update((r) => !r);
    deps.say(repeat() ? "Loop on" : "Loop off");
  };

  return {
    state,
    playing,
    position,
    duration,
    volume,
    muted,
    repeat,
    buffering,
    picture,
    failure,
    toggle,
    seekTo,
    seekBy: (delta) => seekTo(position() + delta),
    setVolume,
    volumeBy: (delta) => setVolume(volume() + delta),
    toggleMute,
    toggleRepeat,
    loaded: ({ duration: length, width }) => {
      duration.set(Number.isFinite(length) && length > 0 ? length : 0);
      picture.set(width > 0);
      buffering.set(false);
      if (state() === "loading") state.set(playing() ? "playing" : "ready");
    },
    progress: ({ currentTime, duration: length }) => {
      if (Number.isFinite(length) && length > 0 && length !== duration()) duration.set(length);
      if (deps.now() < settleUntil || state() === "error") return;
      position.set(Math.max(0, currentTime));
    },
    ended: () => {
      if (repeat()) return;
      playing.set(false);
      state.set("ended");
      if (duration() > 0) position.set(duration());
      deps.say("Ended");
    },
    failed: (message) => {
      playing.set(false);
      buffering.set(false);
      failure.set(message);
      state.set("error");
    },
    buffer: (on) => buffering.set(on && state() !== "error"),
    key: (key, shift) => {
      switch (key) {
        case "space":
          toggle();
          return true;
        case "left":
        case "right":
          seekTo(position() + (key === "left" ? -1 : 1) * (shift ? SEEK_BIG : SEEK_STEP));
          return true;
        case "up":
        case "down":
          setVolume(volume() + (key === "up" ? 0.1 : -0.1));
          return true;
        case "m":
          toggleMute();
          return true;
        case "l":
          toggleRepeat();
          return true;
        case "home":
          seekTo(0);
          return true;
        case "end":
          seekTo(Math.max(0, duration() - 1));
          return true;
        default:
          return false;
      }
    },
  };
}

/** The player that is on screen, or `null`: a headless test has no media engine and plays the host's part through it. */
export const shownPlayer = signal<Player | null>(null);

/** The sentence of the error row: the codec when the file's headers name one, else what the system said. */
export function playbackProblem(
  codecs: string | null | undefined,
  kind: "video" | "audio",
  systemSaid: string,
): string {
  if (codecs) return `This computer cannot play ${codecs}`;
  return `This computer cannot play this ${kind === "video" ? "video" : "sound"}${systemSaid ? `: ${systemSaid}` : ""}`;
}
