import { type JSX, type Motion, Overlay } from "nsh";

import type { Align, Bounds, OverlayPosition, Placement, Point, ViewRef, ViewStyle } from "nsh/types";

/**
 * Where popups are placed (Base UI's `Positioner`) and the geometry rules around that. An `Overlay` places itself against
 * its anchor and follows it natively; what it cannot do is notice that the anchor went somewhere it should not be followed
 * to. That is the **anchor policy**:
 *
 * - `"close"` (default, tooltips, preview cards, popovers): the popup ends when the anchor moved. The host sends no hover
 *   event for content that scrolls under a still pointer, a recycled list cell is another record by the time it is placed
 *   again, and the overlay is drawn over everything: carried along with its anchor it would end up over the header, the
 *   sidebar or the next row.
 * - `"follow"` (opt-in, a popover on a trigger that no scroll view can move: a header button): the popup stays with
 *   its anchor through layout changes and window resizes. The host does not say whether a scroll view clips the anchor,
 *   so a followed anchor that scrolls away is never noticed: use it only where nothing scrolls the trigger.
 */

export type AnchorPolicy = "close" | "follow";

/** Where a popup hung the last time it was placed: what `anchorMoved` compares. */
export interface Hung {
  placement: string;
  edge: number;
  along: number;
  width: number;
  height: number;
}

/**
 * Whether the anchor moved between two placements of the popup. The edge nearest the anchor does not depend on the
 * popup's size; along it the popup is lined up with the anchor by `align`, so its corner is only comparable between two
 * placements of the same size (it also moves while it is still measured). A flip to the other side is not movement.
 */
export function anchorMoved(before: Hung | undefined, p: OverlayPosition): { moved: boolean; hung: Hung } {
  const { x, y } = p.bounds.origin;
  const { width, height } = p.bounds.size;
  const edge =
    p.placement === "bottom" ? y : p.placement === "top" ? y + height : p.placement === "right" ? x : x + width;
  const along = p.placement === "bottom" || p.placement === "top" ? x : y;
  const hung = { placement: p.placement, edge, along, width, height };
  if (!before || before.placement !== p.placement) return { moved: false, hung };
  const sameSize = before.width === width && before.height === height;
  return { moved: Math.abs(edge - before.edge) > 0.5 || (sameSize && Math.abs(along - before.along) > 0.5), hung };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const inside = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

function sign(p: Point, a: Point, b: Point) {
  return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

function inTriangle(p: Point, a: Point, b: Point, c: Point) {
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Turns the plane so that a popup on `side` of its trigger is below it: the rules are then written once. */
function below(side: Placement, p: Point): Point {
  if (side === "bottom") return p;
  if (side === "top") return { x: p.x, y: -p.y };
  if (side === "right") return { x: p.y, y: p.x };
  return { x: p.y, y: -p.x };
}

function rectBelow(side: Placement, r: Rect): Rect {
  const a = below(side, { x: r.x, y: r.y });
  const b = below(side, { x: r.x + r.width, y: r.y + r.height });
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/**
 * Whether the pointer at `at` may still be on its way to a popup: over the trigger or the popup, in the gap between them,
 * or inside the triangle from `apex` (where the pointer left the trigger) to the popup's near edge (Floating UI's
 * `safePolygon`, and the menu's `inTransit`). While it is, the popup is not closed for the pointer being elsewhere.
 */
export function inSafeZone(apex: Point, trigger: Rect, popup: Rect, side: Placement, at: Point): boolean {
  if (inside(trigger, at) || inside(popup, at)) return true;
  const t = rectBelow(side, trigger);
  const f = rectBelow(side, popup);
  const a = below(side, at);
  const narrow = t.width <= f.width ? t : f;
  if (a.y >= t.y + t.height && a.y <= f.y && a.x >= narrow.x && a.x <= narrow.x + narrow.width) return true;
  return inTriangle(a, below(side, apex), { x: f.x, y: f.y }, { x: f.x + f.width, y: f.y });
}

/**
 * An `Overlay` against `anchor` with Base UI's vocabulary (`side`, `align`, `offset`, `margin`) and an anchor policy.
 * `onAnchorMoved` is called, once per placement that moved, when the policy is `"close"`: closing is the owner's.
 * `onPosition` hears every placement (a hoverable popup needs its frame for the safe zone).
 */
export function Positioner(props: {
  anchor: ViewRef | Point | Bounds | null | undefined;
  side?: Placement;
  align?: Align;
  offset?: number;
  margin?: number;
  policy?: AnchorPolicy;
  onAnchorMoved?: () => void;
  onPosition?: (p: OverlayPosition) => void;
  onPressOutside?: () => void;
  onCancel?: () => void;
  /** Any press went down on the popup or in what it holds (capture). */
  onPressCapture?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  noPointer?: boolean;
  role?: "menu" | "none";
  label?: string;
  hint?: string;
  class?: string;
  /** The popup's own style: a popover's entrance (`popupEnter`). */
  style?: ViewStyle | Motion["style"];
  children?: JSX.Element;
}) {
  let hung: Hung | undefined;
  let hungFor = props.anchor;
  return (
    <Overlay
      anchor={props.anchor}
      placement={props.side ?? "bottom"}
      align={props.align ?? "center"}
      offset={props.offset ?? 6}
      margin={props.margin ?? 8}
      style={props.noPointer ? [{ pointerEvents: "none" }, props.style] : props.style}
      role={props.role}
      accessibilityLabel={props.label}
      accessibilityHint={props.hint}
      onPressOutside={props.onPressOutside}
      onCancel={props.onCancel}
      onTouchStartCapture={props.onPressCapture}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
      onPosition={(p) => {
        if (hungFor !== props.anchor) {
          hungFor = props.anchor;
          hung = undefined;
        }
        const next = anchorMoved(hung, p);
        hung = next.hung;
        props.onPosition?.(p);
        if (next.moved && (props.policy ?? "close") === "close") props.onAnchorMoved?.();
      }}
      class={props.class}
    >
      {props.children}
    </Overlay>
  );
}
