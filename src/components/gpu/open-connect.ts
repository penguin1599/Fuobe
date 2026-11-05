"use client";

import { useSyncExternalStore } from "react";
import { CONNECT_GPU_EVENT, type ConnectGpuDetail } from "@/lib/api";
import { browserSupport, pageCanReach } from "@/lib/local-comfy";

/**
 * Opening "Connect your GPU" (GuestPrompt) from anywhere, and whether this browser can use the ComfyUI on its computer.
 * Kept small: the account menu and the header pill use it without loading the finder or the runner.
 */

/** Why the "Connect your GPU" card opens from the runner: ComfyUI needs the setting again, find ComfyUI, or allow this browser. */
export type FindReason = NonNullable<ConnectGpuDetail["reason"]>;

const open = (detail: ConnectGpuDetail) => window.dispatchEvent(new CustomEvent<ConnectGpuDetail>(CONNECT_GPU_EVENT, { detail }));

export const openFinder = (reason: FindReason) => open({ reason });

/**
 * Open "Connect your GPU" from a button (never with a run: only a refused run's card starts one). `look`: the button said
 * "Use the ComfyUI on this computer", so the dialog opens already looking; otherwise it waits for "Find my ComfyUI".
 */
export const openConnect = (look = false) => open({ look });

/**
 * The one fix for the person's computer from a status line ("ComfyUI not running", "needs a setting"), when this browser
 * can make it: the finder, at the right step. Null on a phone or in Safari, or when nothing needs fixing here.
 */
export function awayFix(g: { mode?: string; online?: boolean; comfy?: "down" | "no-setting" } | undefined, support: string): (() => void) | null {
  if (!g || g.mode !== "computer" || g.online || support !== "ok") return null;
  if (g.comfy === "no-setting") return () => openFinder("setting");
  if (g.comfy === "down") return () => openFinder("find");
  return null;
}

const NARROW = "(max-width: 767px)";
const subscribeNarrow = (cb: () => void) => {
  const m = window.matchMedia(NARROW);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

/**
 * Under Safari's words, a quieter last line: what the other browsers allow (never "open Fuobe in…": it is open). Not on
 * an iPad, whose browsers are all Safari underneath (that is a "phone").
 */
export const OTHER_BROWSERS = "Chrome, Edge and Firefox allow this, so switching browser also works.";

/** Can this browser use the ComfyUI on its computer at all ("ok"), or why not. */
export function useComputerSupport(): "ok" | "safari" | "phone" | "http" {
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  if (typeof window === "undefined") return "ok";
  const coarse = window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(hover: hover)").matches;
  const b = browserSupport(navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } }, { narrow, coarse });
  if (b !== "ok") return b;
  return pageCanReach(window.location.origin, window.isSecureContext) ? "ok" : "http";
}
