/**
 * What the account's open Fuobe tab reports about its setup (POST /api/setup/session/<code>/report), and what the
 * server adds of its own. Fixed values and whole numbers only: nothing a visitor, a tab or a ComfyUI writes is ever
 * kept or said back (prompt injection has nothing to ride on). Pure.
 */
import { z } from "zod";
import { BROWSER_NAMES, WAYS, type BrowserName, type Os, type Way } from "./ways";
import { FIRST_PICTURE_MODELS, type FirstModel } from "./first-picture";

/** The install kinds the tab can tell (src/lib/comfy-install.ts ComfyInstall). */
export const INSTALLS = ["desktop", "portable", "stability-matrix", "terminal"] as const;
export type InstallKind = (typeof INSTALLS)[number];

/** Why a web address didn't connect, as the tab read it from the check's cause (src/lib/diagnose.ts). */
export const ADDRESS_CAUSES = ["local", "not-found", "no-answer", "not-comfy", "password", "format", "unknown"] as const;
export type AddressCause = (typeof ADDRESS_CAUSES)[number];

export interface TabFacts {
  way: Way;
  /** The tab is in view now. */
  visible: boolean;
  /** This tab's id (a routing label, not a secret): the setup follows one tab at a time. */
  tabId: string;
  /** The browser's own permission to reach apps on this computer. */
  browser: "granted" | "ask" | "blocked" | "unknown" | "unsupported";
  browserName?: BrowserName;
  /** What the tab's look found: ComfyUI it can read, one it can't read yet, another app, nothing, or ComfyUI restarting. */
  comfy?: "none" | "unreadable" | "found" | "other" | "waiting";
  port?: number;
  install?: InstallKind;
  /** ComfyUI's cross-site setting: this site exactly, every site, or another site. */
  cors?: "exact" | "any" | "other";
  /** ComfyUI listens on more than this computer (--listen with another address, or none). */
  listen?: boolean;
  /** ComfyUI restarted and still doesn't let this page in (the setting didn't take). */
  restarted?: boolean;
  guard?: "guard" | "connect" | "none";
  /** The person pressed "Connect anyway" without the guard. */
  guardSkipped?: boolean;
  /** Runs go to this computer now (the tab connected it). */
  connected?: boolean;
  /** The GPU is the computer's processor (no graphics card ComfyUI uses). */
  cpu?: boolean;
  address?: "none" | "testing" | "ok" | "failed";
  addressCause?: AddressCause;
  /** A picture model for the first picture. */
  model?: "checking" | "ready" | "download" | "none";
  modelId?: FirstModel;
  /** The download it needs, in tenths of a GB. */
  modelGbTenths?: number;
  picture?: "none" | "running" | "ok" | "failed" | "no-model";
  pictureSecs?: number;
  pictureCause?: "out-of-memory" | "unknown";
  /** Opened from a run the account started: that run is the first picture. */
  fromRun?: boolean;
}

/** The report's body: unknown keys are refused (400), every value is a fixed word or a whole number in range. */
export const TabFactsSchema = z.strictObject({
  way: z.enum(WAYS as [Way, ...Way[]]),
  visible: z.boolean(),
  tabId: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
  browser: z.enum(["granted", "ask", "blocked", "unknown", "unsupported"]),
  browserName: z.enum(BROWSER_NAMES as [BrowserName, ...BrowserName[]]).optional(),
  comfy: z.enum(["none", "unreadable", "found", "other", "waiting"]).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  install: z.enum(INSTALLS).optional(),
  cors: z.enum(["exact", "any", "other"]).optional(),
  listen: z.boolean().optional(),
  restarted: z.boolean().optional(),
  guard: z.enum(["guard", "connect", "none"]).optional(),
  guardSkipped: z.boolean().optional(),
  connected: z.boolean().optional(),
  cpu: z.boolean().optional(),
  address: z.enum(["none", "testing", "ok", "failed"]).optional(),
  addressCause: z.enum(ADDRESS_CAUSES).optional(),
  model: z.enum(["checking", "ready", "download", "none"]).optional(),
  modelId: z.enum(FIRST_PICTURE_MODELS).optional(),
  modelGbTenths: z.number().int().min(0).max(10_000).optional(),
  picture: z.enum(["none", "running", "ok", "failed", "no-model"]).optional(),
  pictureSecs: z.number().int().min(0).max(3600).optional(),
  pictureCause: z.enum(["out-of-memory", "unknown"]).optional(),
  fromRun: z.boolean().optional(),
});

/** What the server knows itself: the account's saved GPU (a database read) and, for a link, its cached check. */
export interface ServerFacts {
  gpu: "none" | "link" | "computer";
  /** Answering: a link's last check (null: not checked in the last 30 s), or the computer's tab beating with ComfyUI. */
  online: boolean | null;
}

/** One setup as the steps and the next step read it. */
export interface SetupView {
  site: string;
  way: Way;
  os: Os;
  phone: boolean;
  tab: TabFacts | null;
  /** When the tab last reported (ms). */
  tabAt: number;
  server: ServerFacts;
}

/** The tab's look at a web address's failed check: the check's cause (src/lib/diagnose.ts TroubleCause) in a few words. */
export function addressCauseOf(cause: string | undefined): AddressCause {
  switch (cause) {
    case "address-local":
      return "local";
    case "gpu-not-found":
      return "not-found";
    case "gpu-offline":
    case "gpu-starting":
    case "gpu-stopped":
    case "gpu-busy":
      return "no-answer";
    case "gpu-not-comfy":
      return "not-comfy";
    case "gpu-password":
    case "gpu-password-wrong":
    case "gpu-sign-in":
      return "password";
    case "address-format":
    case "address-credentials":
      return "format";
    default:
      return "unknown";
  }
}

/**
 * ComfyUI listens beyond this computer: a --listen with no address (every address) or one that isn't this computer's
 * own. Read from its command line, which the tab reads and never sends.
 */
export function listensWide(argv: readonly string[] | undefined): boolean {
  if (!argv) return false;
  const at = argv.indexOf("--listen");
  if (at < 0) return false;
  const value = argv[at + 1];
  if (!value || value.startsWith("--")) return true;
  return value.split(",").some((a) => !["127.0.0.1", "localhost", "::1"].includes(a.trim()));
}
