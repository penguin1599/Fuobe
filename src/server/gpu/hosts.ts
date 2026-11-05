import "server-only";
import { getSetting } from "../settings";

/**
 * Host names as compared (SPEC review 2a): lower case, no trailing dot, IDN as punycode (the URL parser does
 * that), no IPv6 brackets. Scheme, port and path don't count: "https://comfy.example/api" and
 * "http://comfy.example." are the same host as "https://comfy.example".
 */
export function hostKey(url: string): string | null {
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/** The hosts of this install's own ComfyUI (main and isolated worker) and its WorldCast worker. */
export function installHosts(): Set<string> {
  const out = new Set<string>();
  for (const name of ["comfyUrl", "comfyIsolatedUrl", "worldcastUrl"] as const) {
    const h = hostKey(getSetting(name) ?? "");
    if (h) out.add(h);
  }
  return out;
}

/** Is this address on the host of the install's own ComfyUI? */
export function isInstallHost(url: string): boolean {
  const h = hostKey(url);
  return !!h && installHosts().has(h);
}

/** One message for every address Fuobe refuses for an account, so a refusal never confirms a guess (review 2d). */
export const REFUSED_ADDRESS = "Fuobe can't use this address. Connect your own ComfyUI.";
