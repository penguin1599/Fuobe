import { parseArgv } from "./argv";
import { comboOptions, TopLevelScanner } from "./json-scan";
import { filePresence, deviceLabel } from "./readiness";
import { basename, indexClasses, loaderInputs, nameKey, vramGb } from "./requirements";
import { TransportError, type ComfyTransport, type TransportResponse } from "./transport";
import type { CheckLine, GpuInventory, GpuProblem, RequirementIndex } from "./types";

/**
 * The pre-flight probe (SPEC §6): read what a ComfyUI has, using GET requests only, plus the Manager's
 * read-only import-error lookup (R8). It never posts a prompt or an upload, never reads ComfyUI's log buffer, and
 * keeps only the facts the index asks about (R9). Each step emits a checklist line as it ends. A step that
 * fails leaves its part empty and is listed in `errors`: a partial inventory still counts.
 */
export interface GatherOptions {
  /** How the copy names the place: "at your link" (a tunnel), "on this computer" (browser-direct), or the studio's own server address. */
  where?: "link" | "computer" | "install";
  /** A targeted re-check: only these classes (per-class reads) and folders. */
  classes?: string[];
  folders?: string[];
  /** LoRA base names to look for in models/loras. */
  loraNames?: string[];
  /** The first request's timeout: 8 s from the server, 1.5 s from the browser. */
  statsTimeoutMs?: number;
  /** The whole check: 20 s. */
  budgetMs?: number;
  /** Requests at once (6). */
  concurrency?: number;
  onLine?: (l: CheckLine) => void;
  now?: () => number;
}

export const OBJECT_INFO_MAX_BYTES = 64 * 1024 * 1024;
const OBJECT_INFO_TIMEOUT_MS = 15_000;
const IMPORT_ERROR_BYTES = 2048;

const PROBLEM_TEXT: Record<GpuProblem, string> = {
  unreachable: "Your link didn't answer. Is the tunnel running? Quick-tunnel links change when it restarts.",
  auth: "Your ComfyUI refused the key.",
  "not-comfy": "That address isn't a ComfyUI. Check that your tunnel points at ComfyUI's port.",
  timeout: "Your ComfyUI took too long to answer.",
  "cors-off": "ComfyUI is running, but it isn't letting this page in.",
  "lna-blocked": "Your browser blocked this page from reaching apps on this device.",
  redirect: "That address sends Fuobe somewhere else. Use the final https address.",
};

/** A ComfyUI on the person's own computer that doesn't answer (read from their tab, there's no link). */
const COMPUTER_UNREACHABLE = "ComfyUI isn't answering on this computer. Start it, then check again.";
/** The studio's own ComfyUI (the owner's server address) that doesn't answer. */
const INSTALL_UNREACHABLE = "ComfyUI at the server address didn't answer. Is it running?";

export const problemText = (p: GpuProblem, where: "link" | "computer" | "install" = "link"): string =>
  p === "unreachable" && where === "computer" ? COMPUTER_UNREACHABLE : p === "unreachable" && where === "install" ? INSTALL_UNREACHABLE : PROBLEM_TEXT[p];

const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

/** A semaphore: at most `n` jobs at once. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T,>(job: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await job();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What an answer to /system_stats says about the address, or null when it looks like ComfyUI's JSON. */
function answerProblem(res: TransportResponse): { problem: GpuProblem; detail: string } | null {
  const s = res.status;
  if (s === 401 || s === 403) return { problem: "auth", detail: `HTTP ${s}` };
  if (s === 0 || (s >= 300 && s < 400)) {
    const loc = res.header("location") ?? "";
    let host = "";
    try {
      host = new URL(loc, "https://x.invalid").hostname.toLowerCase();
    } catch {}
    // A Cloudflare Access login page: a protected link without the right headers.
    if (host.endsWith(".cloudflareaccess.com")) return { problem: "auth", detail: "The link is protected by Cloudflare Access. Add its service token." };
    return { problem: "redirect", detail: loc ? `It redirects to ${clip(loc, 200)}` : `HTTP ${s}` };
  }
  if (s === 502 || s === 503 || s === 504 || (s >= 520 && s <= 530)) return { problem: "unreachable", detail: `The tunnel answered HTTP ${s}: ComfyUI behind it isn't answering.` };
  if (s < 200 || s >= 300) return { problem: "not-comfy", detail: `HTTP ${s}` };
  if (/text\/html/i.test(res.header("content-type") ?? "")) {
    const ngrok = !!res.header("ngrok-error-code") || /ngrok/i.test(res.header("server") ?? "");
    return { problem: "not-comfy", detail: ngrok ? "ngrok showed its warning page instead of ComfyUI." : "It answered with a web page." };
  }
  return null;
}

interface StatsJson {
  system?: {
    os?: string;
    ram_total?: number;
    ram_free?: number;
    comfyui_version?: string;
    python_version?: string;
    pytorch_version?: string;
    embedded_python?: boolean;
    deploy_environment?: string;
    argv?: unknown;
  };
  devices?: { name?: string; type?: string; index?: number; vram_total?: number; vram_free?: number }[];
}

type Installed = Record<string, { ver?: string; cnr_id?: string; aux_id?: string; enabled?: boolean } | null>;

export function emptyInventory(via: "server" | "browser", at: number): GpuInventory {
  return {
    v: 1,
    via,
    checkedAt: at,
    tookMs: 0,
    reachable: false,
    devices: [],
    manager: { api: "unknown" },
    nodes: { have: [], missing: [], total: 0, readAt: at, how: "per-class" },
    combos: {},
    packs: {},
    models: {},
    loras: {},
    fingerprint: "",
    errors: [],
  };
}

export async function gatherInventory(t: ComfyTransport, idx: RequirementIndex, o: GatherOptions = {}): Promise<GpuInventory> {
  const now = o.now ?? Date.now;
  const start = now();
  const deadline = start + (o.budgetMs ?? 20_000);
  const left = (ms: number) => Math.max(300, Math.min(ms, deadline - now()));
  const emit = (l: CheckLine) => o.onLine?.(l);
  const inv = emptyInventory(t.via, start);
  const where = o.where === "computer" ? "on this computer" : "at your link";
  const slot = limiter(o.concurrency ?? 6);
  let prefix = "";
  const targeted = !!(o.classes || o.folders);

  const fail = (problem: GpuProblem, detail?: string): GpuInventory => {
    inv.problem = problem;
    if (detail) inv.problemDetail = clip(detail, 300);
    inv.tookMs = now() - start;
    emit({ step: "found", state: "fail", text: problemText(problem, o.where), ...(detail && { detail: clip(detail, 300) }) });
    return inv;
  };

  // 1. System facts.
  emit({ step: "found", state: "running", text: "Looking for ComfyUI…" });
  let stats: StatsJson | null = null;
  try {
    let res = await t.request("GET", "/system_stats", { timeoutMs: left(o.statsTimeoutMs ?? 8000) });
    if (res.status === 404) {
      res.discard();
      res = await t.request("GET", "/api/system_stats", { timeoutMs: left(o.statsTimeoutMs ?? 8000) });
      prefix = "/api";
    }
    const bad = answerProblem(res);
    if (bad) {
      res.discard();
      return fail(bad.problem, bad.detail);
    }
    try {
      stats = await res.json<StatsJson>();
    } catch (e) {
      return fail("not-comfy", (e as Error).message);
    }
  } catch (e) {
    const kind = e instanceof TransportError ? e.kind : "unreachable";
    return fail(kind === "timeout" ? "timeout" : "unreachable", (e as Error).message);
  }
  const sys = stats?.system;
  if (!sys || typeof sys !== "object") return fail("not-comfy", "No system facts in the answer");

  inv.reachable = true;
  const flags = parseArgv(sys.argv);
  inv.comfy = {
    version: clip(sys.comfyui_version, 40),
    os: clip(sys.os, 20),
    ...(sys.python_version && { python: clip(String(sys.python_version).split(" ")[0], 20) }),
    ...(sys.pytorch_version && { torch: clip(sys.pytorch_version, 40) }),
    embeddedPython: !!sys.embedded_python,
    deployEnv: clip(sys.deploy_environment ?? "local-git", 40),
    flags,
    apiPrefix: prefix as "" | "/api",
  };
  inv.devices = (Array.isArray(stats!.devices) ? stats!.devices : []).slice(0, 8).map((d, i) => ({
    name: clip(d?.name, 120),
    type: clip(d?.type, 20),
    index: Number.isFinite(Number(d?.index)) ? Number(d?.index) : i,
    vramTotal: Number(d?.vram_total) || 0,
    vramFree: Number(d?.vram_free) || 0,
  }));
  if (typeof sys.ram_total === "number") inv.ram = { total: sys.ram_total, free: Number(sys.ram_free) || 0 };
  emit({
    step: "found",
    state: "done",
    text: `Found ComfyUI ${inv.comfy.version || ""} ${where}`.replace(/\s+/g, " ").trim(),
    detail: [inv.comfy.python && `Python ${inv.comfy.python}`, inv.comfy.torch && `PyTorch ${inv.comfy.torch}`].filter(Boolean).join(" · ") || undefined,
  });
  const dev = inv.devices[0];
  if (dev && (dev.type === "cuda" || dev.type === "mps" || dev.type === "xpu") && !flags.cpuOnly) {
    const gb = vramGb(dev.vramTotal);
    emit({ step: "gpu", state: "done", text: `Graphics card: ${deviceLabel(dev.name)}${gb ? `, ${gb} GB` : ""}`, detail: inv.ram ? `RAM ${vramGb(inv.ram.total)} GB` : undefined });
  } else {
    emit({ step: "gpu", state: "warn", text: "We didn't find an NVIDIA card. Tools marked “Runs on any computer” still work.", detail: dev ? `Device type: ${dev.type || "unknown"}` : undefined });
  }

  const os = inv.comfy.os;
  const key = nameKey(os);
  const p = (path: string) => `${prefix}${path}`;
  /** GET a JSON answer inside a request slot; null on 404, throws on other failures. */
  const getJson = <T,>(path: string, timeoutMs: number, maxBytes?: number): Promise<{ status: number; body: T | null }> =>
    slot(async () => {
      const res = await t.request("GET", p(path), { timeoutMs: left(timeoutMs), maxBytes });
      if (res.status === 404) {
        res.discard();
        return { status: 404, body: null };
      }
      if (res.status < 200 || res.status >= 300) {
        res.discard();
        throw new TransportError("refused", `${path} answered HTTP ${res.status}`);
      }
      return { status: res.status, body: await res.json<T>() };
    });
  const note = (step: string, e: unknown) => inv.errors.push({ step, message: clip((e as Error)?.message ?? e, 200) });

  // 2a. Add-ons (node classes) and the loaders' combo lists.
  const all = indexClasses(idx);
  const loaders = loaderInputs(idx);
  const loaderClasses = new Set([...loaders.keys()].map((k) => k.slice(0, k.lastIndexOf("."))));
  const captured: Record<string, unknown> = {};
  const addons = async () => {
    emit({ step: "addons", state: "running", text: "Checking add-ons…" });
    let keys: string[] | null = null;
    if (!targeted) {
      try {
        await slot(async () => {
          const res = await t.request("GET", p("/object_info"), { timeoutMs: left(OBJECT_INFO_TIMEOUT_MS), maxBytes: OBJECT_INFO_MAX_BYTES });
          if (res.status !== 200) {
            res.discard();
            throw new TransportError("refused", `/object_info answered HTTP ${res.status}`);
          }
          const scan = new TopLevelScanner(loaderClasses);
          for await (const c of res.chunks()) scan.push(c);
          if (!scan.done()) throw new TransportError("encoding", "/object_info isn't a JSON object");
          keys = scan.keys;
          Object.assign(captured, scan.captured);
        });
      } catch (e) {
        note("object_info", e);
      }
    }
    if (keys) {
      const have = new Set<string>(keys);
      inv.nodes = { have: [...all].filter((c) => have.has(c)).sort(), missing: [...all].filter((c) => !have.has(c)).sort(), total: (keys as string[]).length, readAt: now(), how: "object_info" };
    } else {
      // Too big, too slow or refused: one class at a time, for the classes in question (or the sentinels).
      const asked = new Set([...(o.classes ?? idx.sentinels), ...[...loaderClasses].filter((c) => !o.classes || o.classes.includes(c))]);
      const have: string[] = [];
      const missing: string[] = [];
      await Promise.all(
        [...asked].map(async (cls) => {
          try {
            const r = await getJson<Record<string, unknown>>(`/object_info/${encodeURIComponent(cls)}`, 8000);
            const body = r.body;
            if (body && typeof body === "object" && body[cls]) {
              have.push(cls);
              if (loaderClasses.has(cls)) captured[cls] = body[cls];
            } else if (r.status === 404 || (body && typeof body === "object" && Object.keys(body).length === 0)) missing.push(cls);
          } catch (e) {
            note(`object_info/${cls}`, e);
          }
        }),
      );
      inv.nodes = { have: have.filter((c) => all.has(c)).sort(), missing: missing.filter((c) => all.has(c)).sort(), total: have.length, readAt: now(), how: "per-class" };
    }
    for (const [k, names] of loaders) {
      const cls = k.slice(0, k.lastIndexOf("."));
      const input = k.slice(k.lastIndexOf(".") + 1);
      if (!(cls in captured)) continue;
      const opts = comboOptions(captured[cls], input);
      if (opts === null) continue;
      const listed = new Set(opts.map(key));
      inv.combos[k] = [...names].filter((n) => listed.has(key(n))).sort();
    }
  };

  // 2b. Model folders (names and sizes), LoRAs and the model roots.
  const folders = o.folders ?? idx.folders;
  const indexNames = new Map<string, Map<string, string>>();
  for (const f of Object.values(idx.files)) {
    const listed = f.listFolder ?? f.folder;
    if (!indexNames.has(listed)) indexNames.set(listed, new Map());
    indexNames.get(listed)!.set(key(f.file), f.file);
  }
  const loraWanted = new Map((o.loraNames ?? []).map((n) => [key(n), basename(n)]));
  const listFolders = [...new Set([...folders, ...(loraWanted.size ? ["loras"] : [])])];
  const models = async () => {
    emit({ step: "models", state: "running", text: "Looking through your models…" });
    let present: Set<string>;
    try {
      const r = await getJson<unknown>("/models", 15_000);
      present = new Set(Array.isArray(r.body) ? r.body.filter((x): x is string => typeof x === "string") : []);
    } catch (e) {
      note("models", e);
      return;
    }
    // A pack may name the folder in another case from its directory (ComfyUI-RMBG lists models/RMBG as "rmbg").
    const lower = new Map([...present].map((p) => [p.toLowerCase(), p]));
    await Promise.all(
      listFolders.map(async (folder) => {
        const listed = present.has(folder) ? folder : lower.get(folder.toLowerCase());
        if (!listed) {
          inv.models[folder] = { have: {}, total: 0, folderMissing: true };
          return;
        }
        try {
          let items: { name: string; size: number | null }[];
          const r = await getJson<unknown>(`/experiment/models/${encodeURIComponent(listed)}`, 15_000, 8 * 1024 * 1024);
          if (r.status === 404) {
            const plain = await getJson<unknown>(`/models/${encodeURIComponent(listed)}`, 15_000, 8 * 1024 * 1024);
            items = (Array.isArray(plain.body) ? plain.body : []).filter((x): x is string => typeof x === "string").map((name) => ({ name, size: null }));
          } else {
            items = (Array.isArray(r.body) ? r.body : []).flatMap((x: { name?: unknown; size?: unknown }) =>
              typeof x?.name === "string" ? [{ name: x.name, size: typeof x.size === "number" ? x.size : null }] : [],
            );
          }
          const want = indexNames.get(folder) ?? new Map<string, string>();
          const have: Record<string, number | null> = {};
          for (const it of items) {
            const k = key(it.name);
            const name = want.get(k);
            if (name !== undefined && (have[name] === undefined || (it.size ?? 0) > (have[name] ?? 0))) have[name] = it.size;
            if (folder === "loras") {
              const l = loraWanted.get(k);
              if (l !== undefined) inv.loras[l] = it.size;
            }
          }
          inv.models[folder] = { have, total: items.length };
        } catch (e) {
          note(`models/${folder}`, e);
        }
      }),
    );
    if (!targeted) {
      try {
        const r = await getJson<unknown>("/experiment/models", 8000);
        const roots: Record<string, string[]> = {};
        for (const x of Array.isArray(r.body) ? r.body : []) {
          const name = (x as { name?: unknown })?.name;
          const dirs = (x as { folders?: unknown })?.folders;
          const folder = typeof name === "string" ? (idx.folders.includes(name) ? name : idx.folders.find((f) => f.toLowerCase() === name.toLowerCase())) : undefined;
          if (folder && Array.isArray(dirs)) roots[folder] = dirs.filter((d): d is string => typeof d === "string").slice(0, 4).map((d) => clip(d, 400));
        }
        if (Object.keys(roots).length) inv.comfy!.modelRoots = roots;
      } catch (e) {
        note("experiment/models", e);
      }
    }
  };

  // 2c. ComfyUI-Manager: which API, busy or not, and the packs it lists.
  const manager = async () => {
    if (targeted) return;
    const v4First = flags.enableManager || flags.managerLegacyUi;
    const version = async (path: string) =>
      slot(async () => {
        const res = await t.request("GET", p(path), { timeoutMs: left(5000), maxBytes: 4096 });
        if (res.status !== 200) {
          res.discard();
          return null;
        }
        return clip((await res.text()).replace(/^"|"$/g, "").trim(), 40);
      }).catch(() => null);
    let api: "v4" | "v3" | "none" = "none";
    let ver = await version(v4First ? "/v2/manager/version" : "/manager/version");
    if (ver !== null) api = v4First ? "v4" : "v3";
    else {
      ver = await version(v4First ? "/manager/version" : "/v2/manager/version");
      if (ver !== null) api = v4First ? "v3" : "v4";
    }
    inv.manager = { api, ...(ver && { version: ver }), ...(api === "v4" && { legacyUi: flags.managerLegacyUi }) };
    if (api === "none") {
      emit({ step: "manager", state: "warn", text: "ComfyUI-Manager isn't on. Fuobe shows the commands to run instead." });
      return;
    }
    const pre = api === "v4" ? "/v2" : "";
    await Promise.all([
      getJson<{ is_processing?: boolean }>(`${pre}/manager/queue/status`, 4000)
        .then((r) => (inv.manager.busy = !!r.body?.is_processing))
        .catch((e) => note("manager/queue/status", e)),
      getJson<Installed>(`${pre}/customnode/installed`, 15_000, 4 * 1024 * 1024)
        .then((r) => matchPacks(r.body ?? {}))
        .catch((e) => note("customnode/installed", e)),
      api === "v4"
        ? getJson<{ extension?: { manager?: { supports_csrf_post?: boolean } } }>("/features", 4000)
            .then((r) => (inv.manager.csrfPost = !!r.body?.extension?.manager?.supports_csrf_post))
            .catch((e) => note("features", e))
        : Promise.resolve(),
    ]);
    emit({ step: "manager", state: "done", text: `ComfyUI-Manager ${inv.manager.version ?? ""}`.trim() });
  };
  const matchPacks = (installed: Installed) => {
    const lc = (s: string) => s.toLowerCase();
    for (const [dirRaw, info] of Object.entries(installed ?? {})) {
      if (!info || typeof info !== "object") continue;
      const dir = dirRaw.replace(/@.*$/, "");
      for (const [name, pack] of Object.entries(idx.packs)) {
        const repoTail = pack.repo.split("/").slice(3, 5).join("/");
        const repoName = pack.repo.split("/")[4] ?? "";
        const hit =
          lc(dir) === lc(name) ||
          lc(dir) === lc(repoName) ||
          (!!info.cnr_id && !!pack.registry?.id && lc(String(info.cnr_id)) === lc(pack.registry.id)) ||
          (!!info.aux_id && lc(String(info.aux_id)) === lc(repoTail));
        if (hit) inv.packs[name] = { dir: clip(dir, 100), ...(info.ver && { version: clip(info.ver, 40) }), enabled: info.enabled !== false };
      }
    }
  };

  // The small reads go first: a busy ComfyUI answers in order, and /object_info can hold it for seconds.
  await Promise.all([manager(), models(), addons()]);

  // 3. Import errors: a pack Manager lists whose classes didn't load.
  const missing = new Set(inv.nodes.missing);
  const broken = Object.entries(inv.packs).filter(([name, info]) => info.enabled && (idx.packs[name]?.classes.length ?? 0) > 0 && idx.packs[name].classes.every((c) => missing.has(c)));
  if (broken.length && (inv.manager.api === "v4" || inv.manager.api === "v3")) {
    const trace = (x: unknown) => {
      const r = x as { traceback?: unknown; error?: unknown; msg?: unknown } | null;
      const s = r ? String(r.traceback || r.error || r.msg || "") : "";
      return s ? s.slice(0, IMPORT_ERROR_BYTES) : undefined;
    };
    try {
      if (inv.manager.api === "v4") {
        const cnr = broken.flatMap(([n]) => (idx.packs[n].registry?.id ? [idx.packs[n].registry!.id] : []));
        const urls = broken.filter(([n]) => !idx.packs[n].registry?.id).map(([n]) => idx.packs[n].repo);
        const body = await slot(async () => {
          const res = await t.request("POST", p("/v2/customnode/import_fail_info_bulk"), { json: { cnr_ids: cnr, urls }, timeoutMs: left(6000), maxBytes: 512 * 1024 });
          if (res.status !== 200) {
            res.discard();
            return null;
          }
          return res.json<Record<string, unknown>>();
        });
        for (const [n] of broken) {
          const k = idx.packs[n].registry?.id ?? idx.packs[n].repo;
          const err = trace(body?.[k]);
          if (err) inv.packs[n].importError = err;
        }
      } else {
        await Promise.all(
          broken.map(([n]) =>
            slot(async () => {
              const id = idx.packs[n].registry?.id;
              const res = await t.request("POST", p("/customnode/import_fail_info"), { json: id ? { cnr_id: id } : { url: idx.packs[n].repo }, timeoutMs: left(6000), maxBytes: 512 * 1024 });
              if (res.status !== 200) return res.discard();
              const err = trace(await res.json<unknown>());
              if (err) inv.packs[n].importError = err;
            }),
          ),
        );
      }
    } catch (e) {
      note("import_fail_info", e);
    }
  }

  // Lines for the steps that read files and add-ons.
  const packsLoaded = Object.values(idx.packs).filter((pk) => pk.classes.length && pk.classes.every((c) => !missing.has(c) && (inv.nodes.how === "per-class" || inv.nodes.have.includes(c)))).length;
  if (inv.errors.some((e) => e.step === "object_info") && inv.nodes.how === "per-class" && !inv.nodes.have.length && !inv.nodes.missing.length) {
    emit({ step: "addons", state: "warn", text: "We couldn't read your add-ons this time." });
  } else {
    emit({ step: "addons", state: "done", text: `${packsLoaded} of ${Object.keys(idx.packs).length} add-ons Fuobe uses are loaded` });
  }
  if (!Object.keys(inv.models).length) {
    emit({ step: "models", state: "warn", text: "We couldn't read your model folders this time." });
  } else {
    const files = Object.values(idx.files);
    const have = files.filter((f) => filePresence(f, inv) === "present").length;
    emit({ step: "models", state: "done", text: `Found ${have} of ${files.length} model files Fuobe uses` });
  }

  // 4. The fingerprint: what makes this machine this machine (a heuristic for "the studio's own GPU").
  inv.fingerprint = await sha256Hex(
    JSON.stringify([
      Array.isArray(sys.argv) ? sys.argv : [],
      inv.devices.map((d) => [d.name, d.vramTotal]),
      inv.ram?.total ?? 0,
      inv.comfy.modelRoots ?? {},
    ]),
  );
  inv.tookMs = now() - start;
  return inv;
}
