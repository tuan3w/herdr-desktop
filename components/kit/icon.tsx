import { Image, token } from "nsh";
import alert from "./icons/alert.svg";
import arrowLeft from "./icons/arrow-left.svg";
import check from "./icons/check.svg";
import chevronDown from "./icons/chevron-down.svg";
import chevronLeft from "./icons/chevron-left.svg";
import chevronRight from "./icons/chevron-right.svg";
import circleCheck from "./icons/circle-check.svg";
import clock from "./icons/clock.svg";
import copy from "./icons/copy.svg";
import download from "./icons/download.svg";
import ellipsis from "./icons/ellipsis.svg";
import image from "./icons/image.svg";
import link from "./icons/link.svg";
import list from "./icons/list.svg";
import loader from "./icons/loader.svg";
import monitor from "./icons/monitor.svg";
import moon from "./icons/moon.svg";
import panelLeft from "./icons/panel-left.svg";
import plus from "./icons/plus.svg";
import refresh from "./icons/refresh.svg";
import search from "./icons/search.svg";
import sliders from "./icons/sliders.svg";
import sun from "./icons/sun.svg";
import trash from "./icons/trash.svg";
import undo from "./icons/undo.svg";
import x from "./icons/x.svg";

const ICONS = {
  alert,
  "arrow-left": arrowLeft,
  check,
  "chevron-down": chevronDown,
  "chevron-left": chevronLeft,
  "chevron-right": chevronRight,
  "circle-check": circleCheck,
  clock,
  copy,
  download,
  ellipsis,
  image,
  link,
  list,
  loader,
  monitor,
  moon,
  "panel-left": panelLeft,
  plus,
  refresh,
  search,
  sliders,
  sun,
  trash,
  undo,
  x,
};

export type IconName = keyof typeof ICONS;
/** Theme tokens an icon may take its color from. */
export type IconTone =
  | "foreground"
  | "muted-foreground"
  | "primary"
  | "primary-foreground"
  | "destructive"
  | "success"
  | "warning"
  | "info"
  | "signal"
  | "sidebar-foreground"
  | "sidebar-accent-foreground"
  | "sidebar-primary"
  | "sidebar-primary-foreground";

/**
 * A 24-unit stroke icon recolored from a token. Decorative: it is hidden from screen readers, so whatever
 * presses it must carry the label (`IconButton`, `Btn`).
 */
export function Icon(props: { name: IconName; size?: 12 | 14 | 16 | 20; tone?: IconTone }) {
  return (
    <Image
      src={ICONS[props.name]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: props.size ?? 16, height: props.size ?? 16, tintColor: token(props.tone ?? "foreground") }}
    />
  );
}
