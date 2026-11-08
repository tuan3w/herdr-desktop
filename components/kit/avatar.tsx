import { cleanup, effect, Image, signal, Text, View } from "nsh";

export type AvatarStatus = "idle" | "loading" | "loaded" | "error";

/**
 * Whether the fallback (the initials) shows: until the picture has loaded, and only once `delay` has passed, so a
 * picture that loads fast never flashes the initials first (Base UI's `Avatar.Fallback delay`).
 */
export function fallbackShown(status: AvatarStatus, delayPassed: boolean): boolean {
  return status !== "loaded" && delayPassed;
}

/**
 * What the fallback draws: at most two letters (grapheme clusters, so an emoji or an accented letter is one), upper
 * case; `?` when there is nothing to draw. A longer fallback (`WWW`) wrapped onto a second line inside a 24-pt circle.
 */
export function initials(fallback: string): string {
  // nsh's engine has no `Intl.Segmenter`: a mark, a variation selector, a skin tone, a joiner and what it joins stay
  // with the letter before them, which covers accents and emoji sequences.
  const letters: string[] = [];
  let join = false;
  for (const ch of fallback.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    const attach =
      join || /\p{M}/u.test(ch) || code === 0x200d || code === 0xfe0f || (code >= 0x1f3fb && code <= 0x1f3ff);
    if (attach && letters.length > 0) letters[letters.length - 1] += ch;
    else if (/\S/u.test(ch)) letters.push(ch);
    join = ch === "\u200d";
  }
  return letters.length === 0 ? "?" : letters.slice(0, 2).join("").toUpperCase();
}

/**
 * A person: a picture when `src` loads, else the `fallback` text (initials). `delay` (ms) holds the fallback back while
 * the picture loads. Decorative unless `label` is given: next to a name it adds nothing for a screen reader. `class`
 * sets the size and defaults to `size-9`.
 */
export function Avatar(props: { fallback: string; src?: string; delay?: number; label?: string; class?: string }) {
  const status = signal<AvatarStatus>("idle");
  const waited = signal((props.delay ?? 0) <= 0);
  effect(() => {
    status.set(props.src ? "loading" : "idle");
  });
  effect(() => {
    const delay = props.delay ?? 0;
    if (delay <= 0 || !props.src || status() === "loaded") return;
    waited.set(false);
    const timer = setTimeout(() => waited.set(true), delay);
    cleanup(() => clearTimeout(timer));
  });
  return (
    <View
      role={props.label ? "image" : undefined}
      accessibilityLabel={props.label}
      accessibilityElementsHidden={!props.label}
      importantForAccessibility={props.label ? "yes" : "no-hide-descendants"}
      class={`shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent ${props.class ?? "size-9"}`}
    >
      <If when={fallbackShown(status(), waited() || !props.src)}>
        <Text style={{ numberOfLines: 1 }} class="text-xs font-medium text-accent-foreground">
          {initials(props.fallback)}
        </Text>
      </If>
      <If when={props.src && status() !== "error" ? props.src : undefined}>
        {(src) => (
          <Image
            src={src()}
            class="absolute inset-0 size-full"
            style={{ objectFit: "cover" }}
            onLoad={() => status.set("loaded")}
            onError={() => status.set("error")}
          />
        )}
      </If>
    </View>
  );
}
