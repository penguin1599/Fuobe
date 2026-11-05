/**
 * Fuobe Connect: the ComfyUI custom node pack (integrations/fuobe-connect) that lets this page use the ComfyUI on the
 * person's computer with one install, and can pair a ComfyUI with their account instead (for Safari, phones and PCs
 * with no screen). What the "Connect your GPU" screens say about it. Pure.
 */

/**
 * Fuobe Connect's repository is published: the "Connect your GPU" screens offer it (install it, pair with a code), and
 * "Set it up with my AI" offers it first. Until then they offer Fuobe's setting with Fuobe's guard, and a web address.
 * Nothing else decides whether Fuobe Connect is offered.
 */
export const FUOBE_CONNECT_PUBLISHED: boolean = false;

export const FUOBE_CONNECT = {
  name: "Fuobe Connect",
  /** What to type in ComfyUI-Manager's Custom Nodes Manager. */
  search: "Fuobe Connect",
  /** For "Install via Git URL", or a git clone in ComfyUI's custom_nodes folder. */
  gitUrl: "https://github.com/workingprototype/ComfyUI-Fuobe-Connect",
  /** The studios it trusts when the person names none. */
  defaultStudios: ["https://fuobe.com", "https://www.fuobe.com"],
} as const;

/** Does Fuobe Connect trust this page's origin without a setting? (A self-hosted studio has to be added.) */
export const trustedByDefault = (origin: string): boolean => (FUOBE_CONNECT.defaultStudios as readonly string[]).includes(origin.replace(/\/+$/, ""));

/** Its answer at GET /fuobe/connect. */
export const isConnectAnswer = (answer: unknown): boolean => !!answer && typeof answer === "object" && Number((answer as { connect?: unknown }).connect) >= 1;

/** "abcd efgh" → "ABCD-EFGH" as the person types it (null until it is a whole code). */
export function pairCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJKMNP-Z2-9]{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4)}` : null;
}

/** One ComfyUI paired with this person, as /api/gpu/paired lists it. */
export interface PairedComfy {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  facts: { device?: string; vramBytes?: number; version?: string };
}

/** Heard from in the last minute. */
export const pairedOnline = (p: Pick<PairedComfy, "lastUsedAt">, now: number): boolean => !!p.lastUsedAt && now - p.lastUsedAt < 60_000;
