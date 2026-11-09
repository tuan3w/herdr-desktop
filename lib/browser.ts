/**
 * The embedded browser's address rules (`components/browser.tsx`, `design/files.md`, "The side panel"). Pure, so the
 * headless tests can pin them: what typed text means, what may load here, and how an address reads at rest.
 */

/** A tunnel's two origins: where the page loads on this computer, and where the machine serves it. */
export interface Via {
  /** `http://127.0.0.1:43123`. */
  local: string;
  /** `http://localhost:5173`. */
  remote: string;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/** Whether `host` (no port) is this computer's own loopback name or address. */
const isLoopback = (host: string): boolean => LOOPBACK.test(host);

/** A scheme followed by something other than a port: `mailto:`, `file:`, `javascript:` (`localhost:5173` is a host). */
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

/**
 * What the address field loads for `typed`: an address with `https://` or `http://` as written, and one without a scheme
 * as https (http for this computer's loopback). The panel shows what travels encrypted or never leaves the computer, as
 * `routeLink` decides for a pressed link: plain http to another host, another scheme and words that are not an address
 * are refused with what to do. Never a search: a browser that sends what was typed to a search engine would leak it.
 */
export function webAddress(typed: string): { url: string } | { error: string } {
  const text = typed.trim();
  if (text === "") return { error: "Type a web address" };
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") {
    return { error: `${scheme}: addresses do not open here` };
  }
  let candidate = text;
  if (scheme === undefined) {
    const host = text.split(/[/?#]/, 1)[0]!.replace(/:\d+$/, "");
    if (/\s/.test(text) || (!host.includes(".") && !isLoopback(host))) {
      return { error: "Type a web address, like github.com: this browser does not search" };
    }
    candidate = `${isLoopback(host) ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: `${text} is not a web address` };
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return { error: "Plain http to another computer opens in your browser, not here" };
  }
  return { url: url.href };
}

/**
 * An address as the field shows it at rest: the host to read first, the rest muted after it. `lead` is the scheme when it
 * is not https (`http://`, so an unencrypted page never reads like an encrypted one), else empty. A user name in the
 * address (`https://github.com@evil.example/`) is left out: the host shown is the one the page came from.
 */
export function addressParts(url: string): { lead: string; host: string; rest: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { lead: "", host: url, rest: "" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { lead: "", host: url, rest: "" };
  let rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  try {
    rest = decodeURI(rest);
  } catch {
    // A malformed escape is shown as written.
  }
  return { lead: parsed.protocol === "https:" ? "" : "http://", host: parsed.host, rest };
}

/** `url` with origin `from` swapped for `to`; any other address unchanged. */
export function swapOrigin(url: string, from: string, to: string): string {
  if (url === from) return to;
  return url.startsWith(from) && /^[/?#]/.test(url.slice(from.length)) ? to + url.slice(from.length) : url;
}

/**
 * What to tell the person when nsh refused a navigation of a shown page (`ERR_ACCESS_DENIED`): a link to `mailto:`,
 * `file:` or an app's own scheme says it does not open here; a page's own internals (a frame of `about:`, `data:` or
 * `blob:`, a `javascript:` address) say nothing, since the person did not ask for them.
 */
export function refusedNote(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === undefined || ["about", "data", "blob", "javascript"].includes(scheme)) return null;
  return `${scheme}: links do not open here`;
}
