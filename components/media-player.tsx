import { Files, Media } from "herdr-desktop/native";
import { announce, cleanup, effect, keymap, signal, Text, untracked, Video, View, windowSize } from "nsh";
import { Slider } from "nsh/base";
import { isAvailable as desktop, Window } from "nsh/desktop";

import { CopyProgress } from "#components/copy-progress";
import { Btn, copyText, Empty, FOCUS_RING, Icon, IconButton, NUM, notify, Popover, PopoverTitle, Spinner } from "#kit";
import { revealLabel } from "#lib/files";
import type { Player } from "#lib/media";
import { clock, createPlayer, playbackProblem, positionText, shownPlayer } from "#lib/media";
import { openSource } from "#lib/media-source";
import { hoverTransition, motionClock } from "#lib/motion";
import { largeTargets, mediaVolume } from "#lib/settings";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The tallest the stage grows in the dialog; a viewer in a dialog has the room of a window, full screen has what the window has. */
const STAGE = 400;
/** The shortest a picture's stage gets: a wide clip in a narrow dialog is as high as its picture, down to this. */
const STAGE_MIN = 240;
/** What the controls and the gap under the stage take: the stage grows by this while full screen hides them. */
const CONTROLS_HEIGHT = 120;

/** One step of the volume slider and of Up and Down: the same, so a key on the slider and a key on the page agree. */
export const VOLUME_STEP = 0.05;

/** Full screen hides the controls and the pointer after this long without a pointer move or a key, while playing. */
export const HIDE_AFTER_MS = 2500;

/** A wake (pointer move) younger than this is not recorded again: a move is a JS turn per frame. */
const WAKE_EVERY_MS = 250;

/** The keys, written once: the Keys popover lists them and the button's name says them (`design/media.md`). */
export const KEY_ROWS: readonly (readonly [keys: string, does: string])[] = [
  ["Space", "Play or pause"],
  ["Left, Right", "Seek 5 s"],
  ["Shift+Left, Shift+Right", "Seek 30 s"],
  ["Up, Down", "Volume"],
  ["M", "Mute"],
  ["L", "Loop"],
  ["F", "Full screen (video)"],
  ["Home, End", "Start, end"],
];

/** What a screen reader hears on the Keys button: every key and what it does. */
export const keysSpoken = (): string => `Keys. ${KEY_ROWS.map(([keys, does]) => `${keys}: ${does}`).join(". ")}`;

/** What the position slider shows: the place being dragged to while a drag is on, else where the clip is. */
export const railValue = (preview: number | null, actual: number): number => preview ?? actual;

/**
 * What the position slider's events do. A change only moves the preview (a drag reports one per pixel: the engine and the
 * screen reader hear nothing yet); the end seeks once and drops the preview. A key step reports both at once, so it
 * seeks at once.
 */
export function scrubbed(event: "change" | "end", value: number): { preview: number | null; seek: number | null } {
  return event === "change" ? { preview: value, seek: null } : { preview: null, seek: value };
}

/**
 * Whether the controls and the pointer are hidden: only in full screen, only while playing, and only once nothing moved
 * for `HIDE_AFTER_MS`. Paused, ended, failed and the windowed player always show them.
 */
export function controlsHidden(state: { fullscreen: boolean; playing: boolean; idleMs: number }): boolean {
  return state.fullscreen && state.playing && state.idleMs >= HIDE_AFTER_MS;
}

/**
 * The level Unmute gives back: a sound that was silenced by the slider at 0 (no mute flag) comes back at the last level it
 * had, else Unmute would press and stay silent. `null`: the volume is not 0, the mute flag alone is what to toggle.
 */
export const unmuteLevel = (volume: number, last: number): number | null => (volume === 0 ? last : null);

/**
 * The stage's height: the picture's own at the width the stage has, between `STAGE_MIN` and `STAGE`; `STAGE` while the size
 * is not known (the poster and the spinner wait in a box that does not change under them) and for a sound.
 */
export function stageFit(width: number, picture: { width: number; height: number } | null): number {
  if (!picture || picture.width <= 0 || picture.height <= 0 || width <= 0) return STAGE;
  return Math.round(Math.min(STAGE, Math.max(STAGE_MIN, (width * picture.height) / picture.width)));
}

/**
 * One slider of the bar: the thin rail the app draws, and the nsh slider's own keys and pointer on it. The hit area is 32 pt
 * (44 under Large hit targets) around a 6 pt rail; the thumb grows under the pointer, while it drags and with the focus (an
 * instant change of size: the pointer rule of `design/motion.md`, nothing to lag behind a drag).
 */
function Rail(props: {
  label: string;
  value: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
  onEnd?: (value: number) => void;
}) {
  return (
    <Slider
      value={props.value}
      min={0}
      max={Math.max(props.max, props.step)}
      step={props.step}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      trackClass={`${largeTargets() ? "h-11" : "h-8"} justify-center`}
      indicatorClass="h-1.5 rounded-full bg-muted"
      rangeClass="rounded-full bg-primary"
      thumbClass={`size-3.5 rounded-full bg-primary hover:size-4 active:size-4 focus:size-4 ${FOCUS_RING}`}
      onChange={({ value }) => props.onChange(value as number)}
      onChangeEnd={({ value }) => props.onEnd?.(value as number)}
    />
  );
}

/** The Keys button: a word that opens the list, named for a screen reader with the whole list. */
function KeysButton() {
  return (
    <Popover
      side="top"
      align="end"
      popupClass="w-72"
      trigger={(t) => (
        <View
          role="button"
          accessibilityLabel={keysSpoken()}
          accessibilityState={{ expanded: t.expanded() }}
          onPress={t.onPress}
          onFocus={t.onFocus}
          onBlur={t.onBlur}
          style={hoverTransition()}
          class={`${largeTargets() ? "min-h-11" : "min-h-8"} justify-center rounded-md px-2 hover:bg-accent ${FOCUS_RING}`}
        >
          <Text class="text-xs text-muted-foreground">Keys</Text>
        </View>
      )}
    >
      <PopoverTitle>Keys</PopoverTitle>
      <Each of={KEY_ROWS} key={(row: readonly [string, string]) => row[0]}>
        {(row) => (
          <View class="flex-row items-center justify-between gap-4">
            <Text class="text-sm text-popover-foreground">{row()[1]}</Text>
            <Text style={NUM} class="text-xs text-muted-foreground">
              {row()[0]}
            </Text>
          </View>
        )}
      </Each>
    </Popover>
  );
}

/**
 * The controls under the picture: the clock either side of the seek bar, play or pause, mute and volume, loop and (for a
 * picture) full screen. Every control is named and a key does the same (`Player.key`).
 */
function Controls(props: {
  player: Player;
  picture: boolean;
  onFullscreen: () => void;
  fullscreen: boolean;
  silent: boolean;
  onMute: () => void;
}) {
  const p = props.player;
  const ready = () => p.state() !== "loading" && p.state() !== "error";
  // The place a drag is at: shown in the clock and on the rail while the engine and the screen reader wait for the release.
  const preview = signal<number | null>(null);
  const shown = () => railValue(preview(), p.position());
  const scrub = (event: "change" | "end") => (value: number) => {
    const next = scrubbed(event, value);
    preview.set(next.preview);
    if (next.seek !== null) p.seekTo(next.seek);
  };
  return (
    <View class="gap-1" role="group" accessibilityLabel="Player controls">
      <View class="flex-row items-center gap-3">
        <Text
          style={NUM}
          class="w-14 text-right text-xs text-muted-foreground"
          accessibilityLabel={`Position ${positionText(shown(), p.duration())}`}
        >
          {clock(shown())}
        </Text>
        <View class="min-w-0 flex-1">
          <Rail
            label="Position"
            value={shown()}
            max={p.duration()}
            step={1}
            disabled={!ready() || p.duration() === 0}
            onChange={scrub("change")}
            onEnd={scrub("end")}
          />
        </View>
        <Text
          style={NUM}
          class="w-14 text-xs text-muted-foreground"
          accessibilityLabel={`Length ${clock(p.duration())}`}
        >
          {clock(p.duration())}
        </Text>
      </View>
      <View class="flex-row flex-wrap items-center gap-2">
        <IconButton
          icon={p.playing() ? "pause" : "play"}
          label={p.playing() ? "Pause" : "Play"}
          shortcut="Space"
          onPress={p.toggle}
        />
        <IconButton
          icon={props.silent ? "volume-off" : "volume"}
          label={props.silent ? "Unmute" : "Mute"}
          shortcut="M"
          onPress={props.onMute}
        />
        <View class="w-24">
          <Rail
            label="Volume"
            value={p.muted() ? 0 : p.volume()}
            max={1}
            step={VOLUME_STEP}
            onChange={(v) => p.setVolume(v)}
          />
        </View>
        <IconButton icon="repeat" label="Loop" selected={p.repeat()} shortcut="L" onPress={p.toggleRepeat} />
        <If when={props.picture}>
          <IconButton
            icon={props.fullscreen ? "x" : "maximize"}
            label={props.fullscreen ? "Leave full screen" : "Full screen"}
            shortcut="F"
            onPress={props.onFullscreen}
          />
        </If>
        <View class="flex-1" />
        <KeysButton />
      </View>
    </View>
  );
}

/**
 * Plays a video or a sound of any machine, in the viewer: the picture or, for sound, a plain panel; play and pause, a seek
 * bar, volume, loop, full screen; time and length; a poster (the first frame while it waits); and nothing starts until
 * the person presses play. A file of another machine is copied first into the media cache, with progress and `Cancel`
 * (`lib/media-source.ts`), and a file the system cannot play says which codec it is and offers the system's player. The
 * keys work while the player is on screen (`Space`, `Left`, `Right`, `Up`, `Down`, `M`, `L`, `F`, `Home`, `End`), and each
 * says what it did to a screen reader. A drag on the seek bar seeks on release. In full screen the controls and the
 * pointer go after `HIDE_AFTER_MS` of playing with no movement and come back on a move or a key.
 *
 * The player on screen is `shownPlayer()` (`lib/media.ts`): a headless test, which has no media engine, plays the host's
 * part through it (`loaded`, `progress`).
 */
export function MediaPlayer(props: {
  machine: string;
  machineName: string;
  path: string;
  name: string;
  kind: "video" | "audio";
  /** The file is on this computer: it can be revealed. */
  local: boolean;
}) {
  const source = openSource(() => ({ machine: props.machine, path: props.path }));
  const fullscreen = signal(false);
  // The size the file reported at load, so the stage takes the picture's shape; the stage's width is its own layout.
  const picture = signal<{ width: number; height: number } | null>(null);
  const stageWidth = signal(0);
  const idleSince = signal(motionClock.now());
  const hidden = signal(false);
  const codecs = signal<string | null>(null);
  let video: { seek: (seconds: number) => void } | undefined;
  const player = createPlayer({
    seek: (seconds) => video?.seek(seconds),
    say: announce,
    now: Date.now,
  });
  shownPlayer.set(player);
  cleanup(() => {
    if (shownPlayer() === player) shownPlayer.set(null);
  });

  // The volume the person left, and the last audible one for Unmute to give back.
  player.volume.set(untracked(mediaVolume));
  let lastLevel = untracked(mediaVolume) > 0 ? untracked(mediaVolume) : 0.5;
  effect(() => {
    const level = player.volume();
    mediaVolume.set(level);
    if (level > 0) lastLevel = level;
  });
  const silent = () => player.muted() || player.volume() === 0;
  const toggleMute = () => {
    const back = unmuteLevel(player.volume(), lastLevel);
    if (back === null) player.toggleMute();
    else player.setVolume(back);
  };

  // Full screen only: the controls and the pointer wait out `HIDE_AFTER_MS` of playing with no move and no key. The clock
  // is `motionClock`, so a test moves it. Hiding is instant: it is a change of state, not a motion, and reduced motion
  // has nothing to remove.
  const wake = () => {
    const now = motionClock.now();
    if (!untracked(hidden) && now - untracked(idleSince) < WAKE_EVERY_MS) return;
    idleSince.set(now);
    hidden.set(false);
  };
  effect(() => {
    const since = idleSince();
    if (!fullscreen() || !player.playing()) {
      untracked(() => hidden.set(false));
      return;
    }
    return motionClock.after(Math.max(0, HIDE_AFTER_MS - (motionClock.now() - since)), () =>
      hidden.set(controlsHidden({ fullscreen: true, playing: true, idleMs: motionClock.now() - since })),
    );
  });

  const toggleFullscreen = () => {
    if (!desktop || props.kind !== "video") return;
    wake();
    fullscreen.update((on) => !on);
    Window.toggleFullScreen();
  };
  cleanup(() => {
    // A window left full screen by a viewer that closed would stay so.
    if (fullscreen()) Window.toggleFullScreen();
  });

  // What the system says when it cannot play: the file's own headers name the codec (a few ranged reads, never the file).
  effect(() => {
    if (player.state() !== "error") return;
    const { machine, path } = props;
    untracked(() => {
      Media.probe(machine, path).then(
        (found) => codecs.set(found.summary ?? null),
        () => codecs.set(null),
      );
    });
  });

  // The keys, while the player is on screen. Held keys repeat; the rest fire once. Each wakes the controls. Newest binding
  // wins in nsh's keymap (`keymap.rs`, `find`), and a slider binds its own arrows only while it has the focus, so the focused
  // Position slider steps itself (1 s) and the Volume slider the volume, and these never double a step.
  const act = (run: () => void) => () => {
    wake();
    run();
  };
  effect(() => {
    const held = keymap.bind(
      {
        left: act(() => player.key("left", false)),
        right: act(() => player.key("right", false)),
        "shift+left": act(() => player.key("left", true)),
        "shift+right": act(() => player.key("right", true)),
        up: act(() => player.volumeBy(VOLUME_STEP)),
        down: act(() => player.volumeBy(-VOLUME_STEP)),
      },
      { when: "notEditing", repeat: true },
    );
    const once = keymap.bind(
      {
        space: act(() => player.key("space", false)),
        m: act(toggleMute),
        l: act(() => player.key("l", false)),
        home: act(() => player.key("home", false)),
        end: act(() => player.key("end", false)),
        f: toggleFullscreen,
      },
      { when: "notEditing" },
    );
    return () => {
      held();
      once();
    };
  });

  // The name of what opened, once the length is known: said once.
  let told = false;
  effect(() => {
    if (told || player.state() === "loading" || player.state() === "error") return;
    told = true;
    untracked(() =>
      announce(`${props.name}, ${props.kind}, ${clock(player.duration())}. Space plays, Left and Right seek`),
    );
  });

  const showsPicture = () => props.kind === "video" && player.picture() !== false && player.state() !== "error";
  const stageHeight = () =>
    fullscreen()
      ? Math.max(STAGE, windowSize().height - 330 + (hidden() ? CONTROLS_HEIGHT : 0))
      : stageFit(stageWidth(), showsPicture() ? picture() : null);
  const failedOpen = (what: string) => (e: unknown) => notify(`${what}: ${reason(e)}`, { type: "error" });
  const openInSystem = () => {
    const id = source.id();
    if (id === null) return;
    void Media.openFetched(id).catch(failedOpen("Could not open the file"));
  };

  const Problem = (p: { title: string; detail?: string; copying?: boolean }) => (
    <View role="alert" class="items-center gap-3 px-6">
      <View class="size-10 items-center justify-center rounded-full bg-background">
        <Icon name="alert" size={20} tone="warning" />
      </View>
      <Text class="text-center text-base font-medium text-foreground" style={{ userSelect: "text" }}>
        {p.title}
      </Text>
      <If when={p.detail}>
        <Text class="max-w-md text-center text-sm text-muted-foreground" style={{ userSelect: "text" }}>
          {p.detail}
        </Text>
      </If>
      <View class="flex-row flex-wrap items-center justify-center gap-2">
        <If
          when={p.copying}
          else={
            <>
              <If when={source.phase() === "ready"}>
                <Btn label="Open in the system player" icon="external-link" onPress={openInSystem} />
              </If>
              <If when={props.local}>
                <Btn
                  label={revealLabel()}
                  icon="folder"
                  onPress={() =>
                    void Files.reveal(props.machine, props.path).catch(failedOpen("Could not show the file"))
                  }
                />
              </If>
              <Btn label="Copy path" icon="copy" onPress={() => void copyText(props.path, "Path")} />
            </>
          }
        >
          <Btn label={source.tooBig() ? "Try again" : "Copy again"} icon="refresh" onPress={source.retry} />
          <Btn label="Copy path" icon="copy" onPress={() => void copyText(props.path, "Path")} />
        </If>
      </View>
    </View>
  );

  return (
    <View class="gap-3" style={{ cursor: hidden() ? "none" : undefined }} onMouseMove={wake}>
      <View
        role="group"
        accessibilityLabel={`${props.name}, ${props.kind} player`}
        onLayout={({ bounds }) => stageWidth.set(bounds.size.width)}
        style={{ height: stageHeight() }}
        class={`items-center justify-center overflow-hidden rounded-md ${showsPicture() ? "bg-black" : "bg-muted"}`}
      >
        <If when={source.phase() === "starting" || source.phase() === "copying"}>
          <If when={source.phase() === "copying"} else={<Spinner />}>
            <CopyProgress source={source} machineName={props.machineName} />
          </If>
        </If>
        <If when={source.phase() === "failed" || source.phase() === "cancelled"}>
          <Problem
            copying
            title={source.phase() === "cancelled" ? "The copy was stopped" : "This file cannot be played"}
            detail={source.phase() === "cancelled" ? undefined : source.message()}
          />
        </If>
        <If when={source.phase() === "ready" ? source.local() : undefined}>
          {(src) => (
            <>
              <Video
                ref={(node) => {
                  video = node;
                }}
                src={src()}
                paused={!player.playing()}
                muted={player.muted()}
                volume={player.volume()}
                repeat={player.repeat()}
                progressUpdateInterval={250}
                accessibilityLabel={props.kind === "video" ? `${props.name}, video` : undefined}
                style={
                  showsPicture()
                    ? { width: "100%", height: "100%", objectFit: "contain" }
                    : { position: "absolute", width: 1, height: 1, opacity: 0 }
                }
                onLoad={({ duration, size }) => {
                  picture.set({ width: size.width, height: size.height });
                  player.loaded({ duration, width: size.width, height: size.height });
                }}
                onProgress={player.progress}
                onEnd={player.ended}
                onBuffer={({ isBuffering }) => player.buffer(isBuffering)}
                onError={({ message }) => player.failed(message)}
              />
              <If when={player.state() === "error"}>
                <Problem title={playbackProblem(codecs(), props.kind, "")} detail={player.failure() ?? undefined} />
              </If>
              <If when={player.state() !== "error" && !showsPicture()}>
                <Empty
                  icon={props.kind === "video" ? "film" : "music"}
                  title={props.name}
                  hint={
                    player.picture() === false && props.kind === "video"
                      ? "This file has sound and no picture"
                      : undefined
                  }
                />
              </If>
              <If when={player.buffering() || player.state() === "loading"}>
                <View class="absolute" accessibilityLabel="Loading" accessibilityState={{ busy: true }}>
                  <Spinner size={20} tone={showsPicture() ? "primary-foreground" : "muted-foreground"} />
                </View>
              </If>
            </>
          )}
        </If>
      </View>
      <If when={source.phase() === "ready" && player.state() !== "error" && !hidden()}>
        <Controls
          player={player}
          picture={showsPicture()}
          fullscreen={fullscreen()}
          onFullscreen={toggleFullscreen}
          silent={silent()}
          onMute={toggleMute}
        />
      </If>
    </View>
  );
}
