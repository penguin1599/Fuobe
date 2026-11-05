import { FAL_KEYS_URL } from "./connections";
import { dualEngine } from "./catalog/engines";
import { presetRoutes } from "./catalog/preset-recipe-routes";

/**
 * Your keys (public sign-up): an account's own fal.ai key or Replicate token, so it can run paid models billed to its own
 * account with that provider, never to the studio (src/server/account-keys.ts, src/server/provider-keys.ts). The names,
 * links and words the server and the browser share. Never a key.
 */

export type CloudProvider = "fal" | "replicate";

export const CLOUD_PROVIDERS: readonly CloudProvider[] = ["fal", "replicate"];

export const isCloudProvider = (p: unknown): p is CloudProvider => p === "fal" || p === "replicate";

/** Where to make a Replicate API token. */
export const REPLICATE_TOKENS_URL = "https://replicate.com/account/api-tokens";

export const CLOUD_KEY: Record<
  CloudProvider,
  { label: string; field: string; setting: "falKey" | "replicateToken"; placeholder: string; keysUrl: string; getKey: string; blurb: string }
> = {
  fal: { label: "fal.ai", field: "fal.ai API key", setting: "falKey", placeholder: "key_id:key_secret", keysUrl: FAL_KEYS_URL, getKey: "Get a key", blurb: "One key runs almost every paid model." },
  replicate: { label: "Replicate", field: "Replicate API token", setting: "replicateToken", placeholder: "r8_…", keysUrl: REPLICATE_TOKENS_URL, getKey: "Get a token", blurb: "Hosts some of the same models." },
};

/** What Settings → Your keys shows of a saved key: never the key itself. */
export interface KeyInfo {
  last4: string;
  addedAt: number;
  /** False when this server can't open it any more (its server key was lost): add it again. */
  readable: boolean;
  /** When the provider refused it in a run. */
  rejectedAt?: number;
}

/** GET /api/account/keys. */
export interface YourKeys {
  keys: Record<CloudProvider, KeyInfo | null>;
  /** "both" while it has a usable key and the studio isn't open-source only. */
  engineMode: "open" | "both";
  /** The studio lets accounts use paid models with their own keys (it isn't open-source only). */
  paidAllowed: boolean;
  /** The account limits its paid runs still count against, as it has them now: "4 runs at once, … 1 GB of files in your first week, then 3 GB". */
  limits: string;
}

/** Set on an account's refused run (its value: fal or replicate): the client opens "Add your key". */
export const ADD_KEY_HEADER = "x-fuobe-add-key";

export const addKeyMessage = (p: CloudProvider) => `Add your ${CLOUD_KEY[p].label} key to run this. Runs on ${CLOUD_KEY[p].label} are billed to your own ${CLOUD_KEY[p].label} account.`;
export const keyRejectedMessage = (p: CloudProvider) => `${CLOUD_KEY[p].label} didn't accept your key. Check it in Settings → Your keys.`;
export const balanceMessage = (p: CloudProvider) => `Your ${CLOUD_KEY[p].label} balance has run out. Top it up on ${CLOUD_KEY[p].label}, then run again.`;
/** A key saved that works, on a provider account with nothing on it yet. */
export const emptyBalanceNote = (p: CloudProvider) =>
  `Your ${CLOUD_KEY[p].label} key works, but your ${CLOUD_KEY[p].label} balance is empty. Top it up on ${CLOUD_KEY[p].label} before you run.`;
export const keyRemovedMessage = (p: CloudProvider) => `Your ${CLOUD_KEY[p].label} key was removed, so this run stopped.`;
/** The owner (or anyone not signed in as an account) on /api/account/keys. */
export const NOT_ACCOUNT_KEYS = "Log in to add your keys.";

// ---------------------------------------------------------------------------
// What the studios say to an account about its keys (pure: tests/your-keys-ui.test.ts)

/** The part of /api/status these read (StatusInfo in src/lib/api.ts). */
export interface KeyStatus {
  viewer?: { kind: "guest" | "account"; gpu?: { connected: boolean }; keys?: CloudProvider[]; paidAllowed?: boolean };
}
type Routed = { engine: string; routes: { provider: string }[] };

const viewerKeys = (s: KeyStatus | undefined): CloudProvider[] | null => (s?.viewer?.kind === "account" ? (s.viewer.keys ?? []) : null);

/**
 * A paid model an account can't run yet: the providers that serve it (fal.ai first), any of whose keys would do. Null
 * for the owner and guests, an open model, or a paid model the account has a key for.
 */
export function needsKey(m: Routed | undefined, s: KeyStatus | undefined): CloudProvider[] | null {
  const keys = viewerKeys(s);
  if (!m || !keys || m.engine === "open") return null;
  const served = CLOUD_PROVIDERS.filter((p) => m.routes.some((r) => r.provider === p));
  return served.length && !served.some((p) => keys.includes(p)) ? served : null;
}

/** The provider an account's run of a paid model is billed through: the first that serves it and has its key. */
export function paidThrough(m: Routed | undefined, s: KeyStatus | undefined): CloudProvider | null {
  const keys = viewerKeys(s);
  if (!m || !keys || m.engine === "open") return null;
  return CLOUD_PROVIDERS.find((p) => keys.includes(p) && m.routes.some((r) => r.provider === p)) ?? null;
}

/**
 * The account's key that runs a tool's cloud version, for "Run with your fal.ai key" when its own GPU is off: a preset's
 * cloud routes in order, or a Fuobe Original (both engines) on the cloud engine. Null when no key of its runs one.
 */
export function cloudVersionKey(
  preset: Parameters<typeof presetRoutes>[0] | undefined,
  model: (Routed & { id: string }) | undefined,
  keys: readonly CloudProvider[],
  has: (id: string) => boolean,
  getModel: (id: string) => Routed | undefined,
): CloudProvider | null {
  if (!keys.length) return null;
  const ids = preset ? presetRoutes(preset, "cloud", has).map((r) => r.modelId) : model && dualEngine(model as Parameters<typeof dualEngine>[0]) ? [model.id] : [];
  for (const id of ids) {
    const m = getModel(id);
    const p = m && CLOUD_PROVIDERS.find((k) => keys.includes(k) && m.routes.some((r) => r.provider === k));
    if (p) return p;
  }
  return null;
}

/** "Add your fal.ai key": the words on a paid model an account can't run yet. */
export const addKeyLabel = (p: CloudProvider) => `Add your ${CLOUD_KEY[p].label} key`;

/** "your fal.ai account": who pays for an account's paid run. */
export const billedTo = (p: CloudProvider) => `your ${CLOUD_KEY[p].label} account`;

/** "fal.ai and Replicate" */
const names = (ps: readonly CloudProvider[]) => ps.map((p) => CLOUD_KEY[p].label).join(" and ");

/**
 * The engine switch for an account: locked on open source (and why, and where to change that), or the words for its two
 * sides. Null for the owner and guests (the switch follows Settings → Engine mode). `addKey`: locked only for want of a
 * key, so the switch opens "Add your key" (and says "Add key" where a phone has no room for the rest).
 */
export function accountEngine(
  s: KeyStatus | undefined,
): { locked: { text: string; tip: string; href: string; addKey?: true } } | { tips: { cloud: string; open: string } } | null {
  const v = s?.viewer;
  if (v?.kind !== "account") return null;
  if (v.paidAllowed === false) return { locked: { text: "Open source", tip: "Runs on your own GPU.", href: "/settings#your-gpu" } };
  const keys = v.keys ?? [];
  if (!keys.length) {
    return {
      locked: { text: "Open source", tip: "Runs on your own GPU. Add a fal.ai or Replicate key to use paid models.", href: "/settings#your-keys", addKey: true },
    };
  }
  return {
    tips: {
      cloud: `Paid models, billed to your ${names(keys)} ${keys.length > 1 ? "accounts" : "account"}`,
      open: v.gpu?.connected ? "Open models on your own GPU" : "Open models on your own GPU. Connect it first",
    },
  };
}

/** The first model of a list an account can run (the studio's default when it can): where a studio starts it. */
export function startingModel<M extends Routed & { id: string }>(defaultId: string | undefined, models: readonly M[], s: KeyStatus | undefined): string | undefined {
  const own = models.find((m) => m.id === defaultId);
  if (!own || !needsKey(own, s)) return defaultId;
  return models.find((m) => m.engine === own.engine && !needsKey(m, s))?.id ?? defaultId;
}
