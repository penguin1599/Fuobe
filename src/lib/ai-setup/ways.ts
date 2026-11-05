/**
 * "Set it up with my AI": the ways a person's ComfyUI can be connected to Fuobe, and which one fits this browser.
 * Pure, so the panel, the server and the tests share it.
 *
 * - direct ("This browser"): ComfyUI runs with --enable-cors-header <this site> and Fuobe's guard, and the Fuobe tab
 *   runs the jobs. Chrome, Edge, Firefox, Brave or Opera on a computer.
 * - address ("A web address"): a cloudflared quick tunnel, whose address the person pastes into Fuobe. Safari, phones,
 *   and runs that go on with the tab closed.
 * - connect ("Fuobe Connect"): offered first once FUOBE_CONNECT_PUBLISHED is true.
 */
import type { Platform } from "@/lib/comfy-install";

export type Way = "direct" | "address" | "connect";
export type Os = Platform;
/** What useComputerSupport() says of this browser. */
export type Support = "ok" | "safari" | "phone" | "http";
export type BrowserName = "chrome" | "edge" | "firefox" | "brave" | "opera" | "safari" | "other";

export const WAYS: readonly Way[] = ["direct", "address", "connect"];
export const OSES: readonly Os[] = ["windows", "mac", "linux", "other"];
export const BROWSER_NAMES: readonly BrowserName[] = ["chrome", "edge", "firefox", "brave", "opera", "safari", "other"];

export const isWay = (v: unknown): v is Way => typeof v === "string" && (WAYS as readonly string[]).includes(v);
export const isOs = (v: unknown): v is Os => typeof v === "string" && (OSES as readonly string[]).includes(v);

/** The computer's system, as the steps name it. */
export const OS_NAME: Record<Os, string> = { windows: "Windows", mac: "macOS", linux: "Linux", other: "" };

/** The browser, as the words name it. */
export const BROWSER_LABEL: Record<BrowserName, string> = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", brave: "Brave", opera: "Opera", safari: "Safari", other: "my browser" };

/** The way's name on its pill. */
export const WAY_LABEL: Record<Way, string> = { direct: "This browser", address: "A web address", connect: "Fuobe Connect" };

/**
 * The ways this browser can use, in order (the first is picked), and the ones shown but switched off ("This browser"
 * in Safari or on a page on plain http). A phone gets the web address only: ComfyUI runs on the computer.
 */
export function waysFor(support: Support, published: boolean): { ways: Way[]; off: Way[]; phone: boolean } {
  const phone = support === "phone";
  const base: Way[] = phone ? ["address"] : ["direct", "address"];
  const off: Way[] = support === "safari" || support === "http" ? ["direct"] : [];
  return { ways: published ? ["connect", ...base] : base, off, phone };
}

/** The way the panel starts on. */
export function pickWay(support: Support, published: boolean): Way {
  const { ways, off } = waysFor(support, published);
  return ways.find((w) => !off.includes(w)) ?? "address";
}

/** The browser's name, for the words only (never to decide what works: useComputerSupport does that). */
export function browserOf(nav: { userAgent?: string; brave?: unknown }): BrowserName {
  const ua = nav.userAgent ?? "";
  if (nav.brave) return "brave";
  if (/Edg\//.test(ua)) return "edge";
  if (/OPR\//.test(ua)) return "opera";
  if (/Firefox\/|FxiOS/.test(ua)) return "firefox";
  if (/Chrome\/|Chromium\/|CriOS/.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/** "on my Windows computer", or "on my computer" when the system isn't known. */
export const onMyComputer = (os: Os) => (OS_NAME[os] ? `on my ${OS_NAME[os]} computer` : "on my computer");
