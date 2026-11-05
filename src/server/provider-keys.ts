import "server-only";
import { addKeyMessage, balanceMessage, CLOUD_KEY, keyRejectedMessage, type CloudProvider } from "@/lib/your-keys";
import { accountKey, markKeyRejected } from "./account-keys";
import { ProviderError } from "./providers/types";
import { getSetting } from "./settings";
import { tenant, tenantAccount } from "./tenant";

/**
 * The fal.ai key or Replicate token a provider call sends: the one place Fuobe reads one (tests/byo-keys-static.test.ts
 * keeps it so).
 *
 * - Inside an account's work (tenant.ts): that account's own key ("Your keys"), or "" when it has none or this server
 *   can't open it. Never the studio's key, the environment's, an unsaved "Save & test" value, or another account's.
 * - Inside a guest's work: "".
 * - Otherwise (the owner, the owner's background work): Settings → Paid API configuration, or FAL_KEY /
 *   REPLICATE_API_TOKEN.
 */
export function cloudKey(p: CloudProvider): string {
  const t = tenant();
  if (t?.kind === "account") return accountKey(t.id, p) ?? "";
  if (t) return "";
  return getSetting(p === "fal" ? "falKey" : "replicateToken");
}

/** A provider call with no key to send: refused before anything is sent. */
export function missingKeyError(p: CloudProvider): ProviderError {
  return new ProviderError(tenantAccount() ? addKeyMessage(p) : `Add a ${CLOUD_KEY[p].label} key in Settings → Paid API configuration`, 401);
}

/**
 * Text that may hold a key (a provider's error that echoes the request): the key, and each half of a fal.ai
 * key_id:key_secret, become "••••".
 */
export function redactKey(text: string, key: string): string {
  if (!key) return text;
  let out = text.split(key).join("••••");
  for (const half of key.split(":")) if (half.length >= 8) out = out.split(half).join("••••");
  return out;
}

const BALANCE = /exhausted balance|insufficient (credit|balance|funds)|out of credit|top up your balance|payment required/i;

/**
 * A refusal that is about the provider account's balance, not the key: 402, or fal.ai's 403 "User is locked. Reason:
 * Exhausted balance". The key itself works.
 */
export const balanceRefusal = (status: number, text: string): boolean => status === 402 || ((status === 401 || status === 403) && BALANCE.test(text));

/**
 * An account's run refused by its provider, said the way to fix it: its key (Settings → Your keys, which then says the
 * provider stopped accepting it) or its balance. Undefined for the owner's runs and for any other error.
 */
export function accountKeyError(p: CloudProvider, status: number, text: string, used: string): ProviderError | undefined {
  const account = tenantAccount();
  if (!account) return undefined;
  // `said`: the provider's own words (the key already taken out), for the run's details line and to tell a key refused
  // from a model the key may not run (src/lib/diagnose.ts).
  const said = (e: ProviderError) => Object.assign(e, { said: text });
  if (balanceRefusal(status, text)) return said(new ProviderError(balanceMessage(p), status));
  if (status === 401 || status === 403) {
    if (status === 401) markKeyRejected(account, p, used);
    return said(new ProviderError(keyRejectedMessage(p), status));
  }
  return undefined;
}

declare global {
  /** Tests only: a stand-in fal.ai (queue and REST) on this machine (see standIn). */
  var __fuobeTestFalUrl: string | undefined;
  /** Tests only: a stand-in Replicate on this machine (see standIn). */
  var __fuobeTestReplicateUrl: string | undefined;
}

/**
 * Tests and `next dev` only: a stand-in fal.ai or Replicate on this machine, so no test or local smoke run ever calls
 * the real (paid) services. vitest: globalThis.__fuobeTestFalUrl / __fuobeTestReplicateUrl; `next dev`:
 * FUOBE_DEV_FAL_URL / FUOBE_DEV_REPLICATE_URL. Only an http://127.0.0.1 or http://localhost origin. `next start` and
 * `next build` run with NODE_ENV=production, so this is always null on a live server.
 */
export function standIn(p: CloudProvider): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const v =
    process.env.VITEST === "true"
      ? p === "fal"
        ? globalThis.__fuobeTestFalUrl
        : globalThis.__fuobeTestReplicateUrl
      : process.env.NODE_ENV === "development"
        ? process.env[p === "fal" ? "FUOBE_DEV_FAL_URL" : "FUOBE_DEV_REPLICATE_URL"]
        : undefined;
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") ? u.origin : null;
  } catch {
    return null;
  }
}

/** The origin of a URL, or "" for one that can't be read. */
export const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};
