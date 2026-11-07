import { Files, Media } from "herdr-desktop/native";
import { announce, cleanup, effect, keymap, signal, Text, untracked, Video, View, windowSize } from "nsh";
import { Slider } from "nsh/base";
import { isAvailable as desktop, Window } from "nsh/desktop";

import { CopyProgress } from "#components/copy-progress";
import { Btn, copyText, Empty, FOCUS_RING, Icon, IconButton, NUM, notify, Spinner } from "#kit";
import { revealLabel } from "#lib/files";
import type { Player } from "#lib/media";
import { clock, createPlayer, playbackProblem, positionText, shownPlayer } from "#lib/media";
import { openSource } from "#lib/media-source";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The height of the stage: a viewer in a dialog has the room of a window, and full screen has what the window has. */
const STAGE = 400;

/** The line under the controls: the keys, written once (`design/media.md`). */
const KEYS =
  "Space plays or pauses · Left and Right seek 5 s (Shift 30 s) · Up and Down volume · M mute · L loop · F full screen";

/** One slider of the bar: the thin rail the app draws, and the nsh slider's own keys and pointer on it. */
function Rail(props: {
  label: string;
  value: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Slider
      value={props.value}
      min={0}
      max={Math.max(props.max, props.step)}
      step={props.step}
      disabled={props.disabled}
      accessibilityLabel={props.label}
      trackClass="h-6 justify-center"
      indicatorClass="h-1.5 rounded-full bg-muted"
      rangeClass="rounded-full bg-primary"
      thumbClass={`size-3.5 rounded-full bg-primary ${FOCUS_RING}`}
      onChange={({ value }) => props.onChange(value as number)}
    />
  );
}

/**
 * The controls under the picture: the clock either side of the seek bar, play or pause, mute and volume, loop and (for a
 * picture) full screen. Every control is named and a key does the same (`Player.key`).
 */
function Controls(props: { player: Player; picture: boolean; onFullscreen: () => void; fullscreen: boolean }) {
  const p = props.player;
  const ready = () => p.state() !== "loading" && p.state() !== "error";
  return (
    <View class="gap-1" role="group" accessibilityLabel="Player controls">
      <View class="flex-row items-center gap-3">
        <Text
          style={NUM}
          class="w-14 text-right text-xs text-muted-foreground"
          accessibilityLabel={`Position ${positionText(p.position(), p.duration())}`}
        >
          {clock(p.position())}
        </Text>
        <View class="min-w-0 flex-1">
          <Rail
            label="Position"
            value={p.position()}
            max={p.duration()}
            step={1}
            disabled={!ready() || p.duration() === 0}
            onChange={(v) => p.seekTo(v)}
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
          icon={p.muted() || p.volume() === 0 ? "volume-off" : "volume"}
          label={p.muted() ? "Unmute" : "Mute"}
          shortcut="M"
          onPress={p.toggleMute}
        />
        <View class="w-24">
          <Rail
            label="Volume"
            value={p.muted() ? 0 : p.volume()}
            max={1}
            step={0.05}
            onChange={(v) => p.setVolume(v)}
          />
        </View>
        <IconButton icon="repeat" label="Loop" selected={p.repeat()} shortcut="L" onPress={p.toggleRepeat} />
        <If when={props.picture}>
          <IconButton
            icon="maximize"
            label={props.fullscreen ? "Leave full screen" : "Full screen"}
            shortcut="F"
            onPress={props.onFullscreen}
          />
        </If>
      </View>
      <Text class="text-xs text-muted-foreground">{KEYS}</Text>
    </View>
  );
}

/**
 * Plays a video or a sound of any machine, in the viewer: the picture or, for sound, a plain panel; play and pause, a seek
 * bar, volume, loop, full screen; time and length; a poster (the first frame while it waits); and nothing starts until
 * the person presses play. A file of another machine is copied first into the media cache, with progress and `Cancel`
 * (`lib/media-source.ts`), and a file the system cannot play says which codec it is and offers the system's player. The
 * keys work while the player is on screen (`Space`, `Left`, `Right`, `Up`, `Down`, `M`, `L`, `F`, `Home`, `End`), and each
 * says what it did to a screen reader.
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

  const toggleFullscreen = () => {
    if (!desktop || props.kind !== "video") return;
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

  // The keys, while the player is on screen. Held keys repeat; the rest fire once.
  effect(() => {
    const held = keymap.bind(
      {
        left: () => player.key("left", false),
        right: () => player.key("right", false),
        "shift+left": () => player.key("left", true),
        "shift+right": () => player.key("right", true),
        up: () => player.key("up", false),
        down: () => player.key("down", false),
      },
      { when: "notEditing", repeat: true },
    );
    const once = keymap.bind(
      {
        space: () => player.key("space", false),
        m: () => player.key("m", false),
        l: () => player.key("l", false),
        home: () => player.key("home", false),
        end: () => player.key("end", false),
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
  const stageHeight = () => (fullscreen() ? Math.max(STAGE, windowSize().height - 330) : STAGE);
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
    <View class="gap-3">
      <View
        role="group"
        accessibilityLabel={`${props.name}, ${props.kind} player`}
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
                onLoad={({ duration, size }) => player.loaded({ duration, width: size.width, height: size.height })}
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
      <If when={source.phase() === "ready" && player.state() !== "error"}>
        <Controls player={player} picture={showsPicture()} fullscreen={fullscreen()} onFullscreen={toggleFullscreen} />
      </If>
    </View>
  );
}
