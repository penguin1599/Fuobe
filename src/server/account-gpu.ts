import "server-only";
import dns from "node:dns/promises";
import net from "node:net";
import { isCloudProvider, type CloudProvider } from "@/lib/your-keys";
import { accountEngineMode, accountProviders, paidAllowed } from "./account-keys";
import { accountGpu, type Account, type AccountGpu } from "./auth";
import type { OwnerGpuView } from "@/lib/connections";
import { runnerFacts, type Principal } from "./computer/tasks";
import { offeredSummary } from "./model-access";
import { MODELS } from "@/lib/catalog";
import { hostedUntestedSummary } from "@/lib/catalog/hosted-untested";
import { PROVIDERS } from "./providers";
import { blockedForAccounts, fetchPublic, isLoopbackGpu, peekText } from "./remote-fetch";
import { isInstallHost, REFUSED_ADDRESS } from "./gpu/hosts";
import { balance as billingBalance, OPEN_POLICY, policy as billingPolicy, type Action, type Balance } from "./billing";
import { poolReady } from "./hosted";
import { diagnoseAddress, diagnoseGpu, gpuHostOf, type Diagnosis, type GpuFailure, type GpuPlace, type GpuStage } from "@/lib/diagnose";

/** A diagnosis as the status strip sends it. */
const visitorTrouble = (d: Diagnosis): VisitorTrouble => ({ cause: d.cause, words: d.words, actions: d.actions, retryable: d.retryable, ...(d.details && { details: d.details }) });

/**
 * "Your GPU" (public sign-up): the ComfyUI an account connects, where its runs go. The server calls
 * it, so it must be reachable from the internet (a Cloudflare Tunnel or ngrok in front of a local
 * ComfyUI). Addresses on this machine or a private network are refused, and so is the install's own
 * ComfyUI. A ComfyUI on the visitor's own computer (localhost) is the browser's to reach, never sent here.
 */

/**
 * A check of an account's GPU that failed: its plain words (the message), and what helps (diagnose.ts). `failure`:
 * what came back, so a run can say the same in its own words (diagnoseGpu at its stage).
 */
export class GpuError extends Error {
  constructor(
    readonly trouble: Diagnosis,
    readonly failure?: GpuFailure,
  ) {
    super(trouble.words);
  }
}

/** A check's failure, read for the person. */
const failed = (f: GpuFailure, place: GpuPlace) => new GpuError(diagnoseGpu(f, place), f);

const allowPrivate = () => process.env.FUOBE_ALLOW_PRIVATE_URLS === "1";

export const LOCAL_GPU_MESSAGE = diagnoseAddress("local").words;

/** An address as stored and compared: origin and path, no trailing slash. */
const normal = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;

/** What checkGpuAddress fixed by itself in an address as pasted: "https://" added at its start, a "?…" or "#…" part left out. */
export type AddressFix = "scheme" | "query";

/**
 * An address as pasted, made whole: spaces trimmed, https:// added when it has no scheme (abc-8188.proxy.runpod.net),
 * and a "?…" or "#…" copied from the browser's bar left out. A password inside it is refused: it goes in the token box.
 */
export function cleanGpuAddress(raw: string): { url: URL; fixed: AddressFix[] } {
  const fixed: AddressFix[] = [];
  let text = raw.trim();
  // "abc-8188.proxy.runpod.net" or "localhost:8188": no scheme (a host:port reads as one to URL), so https:// goes first.
  if (text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    text = `https://${text.replace(/^\/+/, "")}`;
    fixed.push("scheme");
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new GpuError(diagnoseAddress("format"));
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new GpuError(diagnoseAddress("scheme"));
  if (u.username || u.password) throw new GpuError(diagnoseAddress("credentials"));
  if (u.search || u.hash) {
    u.search = "";
    u.hash = "";
    fixed.push("query");
  }
  return { url: u, fixed };
}

/**
 * Check an account's ComfyUI address: http(s), a public host, not the install's own ComfyUI. Returns it normalised (made
 * whole first by cleanGpuAddress; `fixed` gets what that changed).
 */
export async function checkGpuAddress(raw: string, o: { resolve?: (host: string) => Promise<string[]>; fixed?: AddressFix[] } = {}): Promise<string> {
  const { url: u, fixed } = cleanGpuAddress(raw);
  o.fixed?.push(...fixed);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal") || !host.includes(".");
  // A stand-in ComfyUI on this machine is allowed in tests and `next dev` only (remote-fetch.ts loopbackGpuPort).
  if (!isLoopbackGpu(u)) {
    if (local && !net.isIP(host) && !allowPrivate()) throw new GpuError(diagnoseAddress("local"));
    const resolve = o.resolve ?? (async (h: string) => (await dns.lookup(h, { all: true, verbatim: true })).map((a) => a.address));
    let addrs: string[];
    try {
      addrs = net.isIP(host) ? [host] : await resolve(host);
    } catch {
      throw new GpuError(diagnoseAddress("not-found", host));
    }
    if (!addrs.length) throw new GpuError(diagnoseAddress("not-found", host));
    // Private networks, this machine's own addresses (loopback too, even with FUOBE_ALLOW_PRIVATE_URLS), wrapped IPv4.
    if (addrs.some(blockedForAccounts)) throw new GpuError(diagnoseAddress("local"));
  }
  const url = normal(u);
  // The install's own ComfyUI on any scheme, port or path (ComfyUI answers every route under /api too), compared by
  // host. One message for every such refusal, so it never confirms a guessed address.
  // (The tests' and `next dev`'s stand-in on this machine is on a port of its own: loopbackGpuPort.)
  if (!isLoopbackGpu(u) && isInstallHost(url)) throw new GpuError({ ...diagnoseAddress("studio"), words: REFUSED_ADDRESS });
  return url;
}

export interface GpuInfo {
  device?: string;
  vramBytes?: number;
  version?: string;
}

/** An answer's text, up to `max` (ComfyUI's /system_stats is a few KB; an error page's start, for the details line). */
async function headText(res: Response, max = 4096): Promise<string> {
  try {
    return (await res.text()).slice(0, max);
  } catch {
    return "";
  }
}

const safeUrl = (u: string, base?: string): URL | null => {
  try {
    return new URL(u, base);
  } catch {
    return null;
  }
};

/**
 * Ask the account's ComfyUI for /system_stats, the check the studio makes of its own. Anything but ComfyUI's answer
 * throws a GpuError that says what it is (diagnose.ts: a stopped RunPod pod, a GPU starting up, a password…). An
 * http:// address that sends to the same host's https:// is followed once (`url` then names the https address).
 */
export async function testGpu(
  gpu: { url: string; token?: string },
  o: { resolve?: (host: string) => Promise<string[]>; timeoutMs?: number; maxBytes?: number; stage?: GpuStage } = {},
): Promise<GpuInfo & { url?: string }> {
  const ask = (url: string) =>
    fetchPublic(
      `${url}/system_stats`,
      // ngrok's free addresses show their warning page instead unless this is sent.
      { headers: { "ngrok-skip-browser-warning": "1", ...(gpu.token ? { Authorization: `Bearer ${gpu.token}` } : {}) } },
      { timeoutMs: o.timeoutMs ?? 10_000, deadlineMs: (o.timeoutMs ?? 10_000) + 5_000, maxBytes: o.maxBytes ?? 1 * 2 ** 20, resolve: o.resolve },
    );
  const place = { kind: "link" as const, url: gpu.url, hasToken: !!gpu.token };
  const stage = o.stage ?? "test";
  let url = gpu.url;
  let res: Response;
  try {
    res = await ask(url);
    // http:// sent to the same host's https://: followed once.
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    const next = to ? safeUrl(to, url) : null;
    const from = safeUrl(url);
    if (next && from && from.protocol === "http:" && next.protocol === "https:" && next.hostname === from.hostname) {
      res.body?.cancel().catch(() => {});
      url = normal(new URL(`https://${from.hostname}${from.pathname}`));
      res = await ask(url);
    }
  } catch (e) {
    console.warn(`[your-gpu] ${gpu.url}: ${(e as Error).message}`);
    throw failed({ stage, error: (e as Error).message }, place);
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  if (!res.ok) {
    const redirect = res.status >= 300 && res.status < 400;
    // An error page's start only, briefly: one that never ends can't hold the check.
    const body = redirect ? "" : await peekText(res);
    res.body?.cancel().catch(() => {});
    const retryAfterS = Number(res.headers.get("retry-after")) || undefined;
    throw failed({ stage, status: res.status, body, contentType, location: res.headers.get("location") ?? undefined, retryAfterS }, place);
  }
  const text = await headText(res, o.maxBytes ?? 1 * 2 ** 20);
  let s: { system?: { comfyui_version?: string }; devices?: { name?: string; vram_total?: number }[] } | null = null;
  try {
    s = JSON.parse(text);
  } catch {}
  if (!s?.system) throw failed({ stage, status: res.status, body: text.slice(0, 4096), contentType }, place);
  const dev = s.devices?.[0];
  return { device: dev?.name, vramBytes: typeof dev?.vram_total === "number" ? dev.vram_total : undefined, version: s.system.comfyui_version, ...(url !== gpu.url && { url }) };
}

declare global {
  /** Each account's GPU as last asked (Your GPU: online or not, what it is, and why not), for the status strip. */
  var __fuobeAccountGpus: Map<string, { url: string; at: number; online: boolean; info: GpuInfo; trouble?: Diagnosis }> | undefined;
  /** The checks on their way, one per account: status requests that arrive meanwhile wait for it. */
  var __fuobeAccountGpuChecks: Map<string, Promise<GpuStateAnswer>> | undefined;
}

/** What a status check reads of /system_stats at most: a ComfyUI's answer is a few KB. */
const STATUS_MAX_BYTES = 64 * 1024;

/** What the status check says of an account's GPU: online or not, what it is, and (offline) why, with what helps. */
export type GpuStateAnswer = { online: boolean; comfy?: "down" | "no-setting"; trouble?: Diagnosis } & GpuInfo;

/** How long a status check's answer is kept: the status strip asks an account's GPU at most this often. */
export const GPU_STATE_MS = 30_000;

/**
 * Note what a check or a run just learnt of an account's link (Settings' Check my GPU, a run that couldn't reach it, or
 * one that did): the status strip, the composer's check before Run and the next run read it without asking again.
 */
export function noteGpuState(id: string, url: string, online: boolean, o: { info?: GpuInfo; trouble?: Diagnosis } = {}): void {
  const cache = (globalThis.__fuobeAccountGpus ??= new Map());
  const hit = cache.get(id);
  const info = o.info ?? (hit?.url === url ? hit.info : {});
  cache.delete(id);
  cache.set(id, { url, at: Date.now(), online, info, ...(!online && o.trouble && { trouble: o.trouble }) });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
}

/** The last status check's answer for an account's saved link, while it is fresh: never asks the GPU. */
export function cachedGpuState(id: string, url: string): GpuStateAnswer | undefined {
  const hit = globalThis.__fuobeAccountGpus?.get(id);
  if (!hit || hit.url !== url || Date.now() - hit.at >= GPU_STATE_MS) return undefined;
  return { online: hit.online, ...hit.info, ...(hit.trouble && { trouble: hit.trouble }) };
}

/**
 * Is the account's ComfyUI answering, and what is it? Asked at most every 30 s per account, and one check at a time:
 * status requests that arrive while one is on its way share its answer.
 */
export async function gpuState(id: string, gpu: AccountGpu): Promise<GpuStateAnswer> {
  // On the person's own computer: what its Fuobe tab last said (online while it beats and its ComfyUI answers; `comfy`:
  // the tab is open, but ComfyUI is closed or runs without Fuobe's setting).
  if (gpu.mode === "computer") {
    const f = runnerFacts(`acct:${id}`);
    return { online: !!f?.online, ...(f?.comfy && { comfy: f.comfy }), ...(f?.device && { device: f.device }), ...(f?.vramBytes && { vramBytes: f.vramBytes }), ...(f?.version && { version: f.version }) };
  }
  const cache = (globalThis.__fuobeAccountGpus ??= new Map());
  const hit = cache.get(id);
  if (hit && hit.url === gpu.url && Date.now() - hit.at < GPU_STATE_MS) return { online: hit.online, ...hit.info, ...(hit.trouble && { trouble: hit.trouble }) };
  const checks = (globalThis.__fuobeAccountGpuChecks ??= new Map());
  const key = `${id} ${gpu.url}`;
  const going = checks.get(key);
  if (going) return going;
  const check = (async (): Promise<GpuStateAnswer> => {
    let online = false;
    let info: GpuInfo = hit?.url === gpu.url ? hit.info : {};
    let trouble: Diagnosis | undefined;
    try {
      const { url: _moved, ...read } = await testGpu(gpu, { timeoutMs: 5000, maxBytes: STATUS_MAX_BYTES, stage: "status" });
      void _moved;
      info = read;
      online = true;
    } catch (e) {
      if (e instanceof GpuError) trouble = e.trouble;
    }
    noteGpuState(id, gpu.url, online, { info, trouble });
    return { online, ...info, ...(trouble && { trouble }) };
  })().finally(() => checks.delete(key));
  checks.set(key, check);
  return check;
}

/**
 * The device type ("cuda", "cpu", "mps"…) of an account's ComfyUI as its last status check read it (the start of
 * /system_stats devices[0].name: "cuda:0 NVIDIA …"), without asking it again; undefined when no check of its saved
 * address has read one. A price check reads this and never calls the GPU (Split soundtrack's pick and time).
 */
export function lastGpuDevice(id: string): string | undefined {
  const gpu = accountGpu(id);
  // On the person's own computer: what its Fuobe tab last said.
  if (gpu?.mode === "computer") return /^[a-z]+/i.exec(runnerFacts(`acct:${id}`)?.device ?? "")?.[0].toLowerCase();
  const hit = globalThis.__fuobeAccountGpus?.get(id);
  if (!gpu || hit?.url !== gpu.url) return undefined;
  return /^[a-z]+/i.exec(hit.info.device ?? "")?.[0].toLowerCase();
}

/**
 * What someone's computer's Fuobe tab last said (an account's "this computer", or the owner's when ComfyUI runs on the
 * owner's computer): its GPU, memory, ComfyUI version and port, the guard and the cross-site setting, and whether it
 * is open now. Never an address, a token or anything of the server's.
 */
export function computerView(principal: Principal): OwnerGpuView {
  const f = runnerFacts(principal);
  return {
    mode: "computer" as const,
    online: !!f?.online,
    ...(f?.comfy && { comfy: f.comfy }),
    ...(f?.guard !== undefined && { guard: f.guard }),
    ...(f?.device && { device: f.device }),
    ...(f?.vramBytes && { vramBytes: f.vramBytes }),
    ...(f?.version && { version: f.version }),
    ...(f?.port && { port: f.port }),
    ...(f?.cors && { cors: f.cors }),
  };
}

/** What a visitor's status strip shows (GET /api/status): its own GPU, never the install's providers, servers or Demo mode. */
export interface VisitorView {
  kind: "guest" | "account";
  /** `mode` "computer": the ComfyUI on the person's own computer, which their Fuobe tab runs. */
  gpu: {
    connected: boolean;
    mode?: "link" | "computer";
    online?: boolean;
    comfy?: "down" | "no-setting";
    device?: string;
    vramBytes?: number;
    /** A link that didn't answer its last status check: why, in plain words, and what helps (diagnose.ts). */
    trouble?: VisitorTrouble;
    /** A link's kind: a RunPod pod's port gets "Start your pod". */
    host?: "runpod" | "tunnel" | "web";
  };
  /** The providers it has its own key for that this server can open ("Your keys"): never a key. */
  keys: CloudProvider[];
  /** The studio lets accounts run paid models on their own keys (it isn't open-source only). */
  paidAllowed: boolean;
  /**
   * Hosted runs (FUOBE_HOSTED_RUNS=1): this account (or a guest, once signed up) may run on this install's GPUs, so
   * connecting a GPU of its own is optional.
   */
  hosted?: boolean;
  /** The billing service's words for the account's balance (billing.ts): the top bar's chip and the account menu. */
  balance?: Balance;
  /** Extra links the billing service sends for the menu. */
  links?: Action[];
  /** A notice to show once per id (the billing service's policy). */
  notice?: { id: string; text: string; url?: string };
}

/** What the status strip and the composer show of a GPU that didn't answer: never more than the person's own GPU said. */
export type VisitorTrouble = Pick<Diagnosis, "cause" | "words" | "actions" | "retryable" | "details">;

/**
 * GET /api/status for a guest or an account: ComfyUI is its own GPU (taken as there until it has one,
 * so the studios offer Generate and the run asks it to connect one), fal.ai and Replicate are its own
 * keys, the engine mode they allow (account-keys.ts), no Demo mode, and nothing of the install's own
 * servers, keys or addresses.
 */
export async function visitorStatus(account: Account | null) {
  const gpu = account ? accountGpu(account.id) : null;
  const live = account && gpu ? await gpuState(account.id, gpu) : null;
  const keys = account ? accountProviders(account.id) : [];
  const viewer: VisitorView = {
    kind: account ? "account" : "guest",
    gpu: gpu
      ? {
          connected: true,
          mode: gpu.mode === "computer" ? "computer" : "link",
          online: !!live?.online,
          ...(live?.comfy && { comfy: live.comfy }),
          ...(live?.device && { device: live.device }),
          ...(live?.vramBytes && { vramBytes: live.vramBytes }),
          ...(gpu.mode !== "computer" && { host: gpuHostOf(gpu.url).kind }),
          ...(!live?.online && live?.trouble && { trouble: visitorTrouble(live.trouble) }),
        }
      : { connected: false },
    keys,
    paidAllowed: paidAllowed(),
  };
  // Hosted runs and the billing hook: nothing of either with them off.
  if (poolReady()) {
    const p = account ? await billingPolicy(account.id) : OPEN_POLICY;
    if (p?.hosted) viewer.hosted = true;
    if (account && p?.links?.length) viewer.links = p.links;
    if (account && p?.notice) viewer.notice = p.notice;
    const b = account ? await billingBalance(account.id) : null;
    if (b) viewer.balance = b;
  }
  const configured = (id: string) => (id === "comfyui" ? (gpu ? !!live?.online : true) : isCloudProvider(id) && keys.includes(id));
  // With keys: the hosted routes no live call has passed yet are left out too (they run for the owner only).
  const access = keys.length ? hostedUntestedSummary(MODELS, offeredSummary()) : undefined;
  return {
    providers: Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, { label: p.id === "comfyui" ? "Your GPU" : p.label, configured: configured(p.id) }])),
    demoMode: "off",
    engineMode: account ? accountEngineMode(account.id) : "open",
    cloudProvider: "auto",
    onboarded: true,
    // Settings → Models & licences: the paid models the owner switched off stay out of its pickers too.
    ...(access && { access }),
    viewer,
  };
}
