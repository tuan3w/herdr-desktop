/** `oklch(L C H)` or `oklch(L C H / A)` as numbers; alpha 1 without one. */
export interface Oklch {
  l: number;
  c: number;
  h: number;
  a: number;
}

const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/;

export function parseOklch(css: string): Oklch {
  const m = OKLCH.exec(css.trim());
  if (!m) throw new Error(`not an oklch() color: ${css}`);
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

/** Linear-light sRGB channels, 0..1, clipped to the gamut. */
export function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clip(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clip(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clip(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/** `#rrggbb` of an opaque oklch color (alpha ignored): for swatches drawn with inline styles. */
export function oklchToHex(css: string): string {
  const [r, g, b] = oklchToLinear(parseOklch(css));
  return `#${[r, g, b]
    .map((x) =>
      Math.round(encode(x) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** WCAG relative luminance of linear-light channels. */
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** `top` painted at `alpha` over `under`, in linear light. */
export function mix(
  top: [number, number, number],
  under: [number, number, number],
  alpha: number,
): [number, number, number] {
  return [0, 1, 2].map((i) => top[i] * alpha + under[i] * (1 - alpha)) as [number, number, number];
}

/** WCAG 2 contrast ratio between two linear-light colors, 1..21. */
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
