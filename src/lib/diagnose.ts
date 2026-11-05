/**
 * What went wrong for an account's own GPU or its own key, in plain words, with the ways out: one sentence for the
 * person, a short details line for the curious, the buttons that help, and whether waiting can fix it. Pure, so the
 * server (Test, the status check, a run's hand-over, its polls and the copy of its result) and the browser (Settings →
 * Your GPU, the composer's check before Run, a failed run's tile) say the same thing (tests/diagnose.test.ts).
 *
 * Only an account's own GPU and keys are read this way. The owner's runs and runs on the studio's GPUs keep their words.
 */
import { balanceMessage, CLOUD_KEY, keyRejectedMessage, type CloudProvider } from "./your-keys";

/** RunPod's list of pods, where a stopped pod is started again. */
export const RUNPOD_CONSOLE_URL = "https://console.runpod.io/pods";

/** Where a provider account gets credit. */
export const BILLING_URL: Record<CloudProvider, string> = { fal: "https://fal.ai/dashboard/billing", replicate: "https://replicate.com/account/billing" };

export type TroubleCause =
  // Your GPU: the address
  | "address-fixed"
  | "address-format"
  | "address-credentials"
  | "address-local"
  | "address-studio"
  | "checks-too-fast"
  // Your GPU: reaching it
  | "gpu-stopped"
  | "gpu-starting"
  | "gpu-offline"
  | "gpu-not-found"
  | "gpu-certificate"
  | "gpu-password"
  | "gpu-password-wrong"
  | "gpu-sign-in"
  | "gpu-not-comfy"
  | "gpu-busy"
  // Your GPU: a run on it
  | "gpu-too-big"
  | "gpu-slow-upload"
  | "gpu-refused"
  | "gpu-error"
  | "gpu-out-of-memory"
  | "gpu-stopped-run"
  | "gpu-job-error"
  | "gpu-restarted"
  | "gpu-moved"
  | "gpu-went-away"
  | "gpu-save-failed"
  | "gpu-isolated"
  // Your keys
  | "key-rejected"
  | "key-balance"
  | "key-permission"
  | "model-unavailable"
  | "bad-input"
  | "content-flag"
  | "provider-busy"
  | "provider-down"
  | "provider-unreachable"
  | "provider-failed"
  | "provider-stopped"
  | "no-result"
  | "result-expired"
  | "unknown";

export type TroubleActionKind =
  | "retry"
  | "check-gpu"
  | "gpu-settings"
  | "key-settings"
  | "run-with-key"
  | "add-credit"
  | "pick-model"
  /** Open the page where the GPU is started (RunPod's pods). */
  | "start-gpu"
  /** Pair a ComfyUI with a code (/connect): no web address needed. */
  | "pair"
  /** Run on the ComfyUI on this computer instead. */
  | "use-computer";

export interface TroubleAction {
  kind: TroubleActionKind;
  label: string;
  /** A link (start-gpu, add-credit, gpu-settings, key-settings, pair) or the provider (run-with-key). */
  target?: string;
  /** run-with-key: the model that runs this tool on that key (its cloud version), and its operation there. */
  modelId?: string;
  op?: string;
}

export interface Diagnosis {
  cause: TroubleCause;
  /** One plain sentence: what is wrong and what to do. Never a status code, an address or a program's own words. */
  words: string;
  /** For the curious: the status, the host and the reason, short. */
  details?: string;
  actions: TroubleAction[];
  /** Waiting can fix it: the run (or the check) tries again by itself. */
  retryable: boolean;
  /** The other side said when to try again. */
  retryAfterMs?: number;
}

/** What a failed run keeps of its diagnosis (the words are the run's error): generations.fix_json `trouble`. */
export interface RunTrouble {
  cause: TroubleCause;
  details?: string;
  actions: TroubleAction[];
}

export const troubleOf = (d: Diagnosis): RunTrouble => ({ cause: d.cause, ...(d.details && { details: d.details }), actions: d.actions });

// ---------------------------------------------------------------------------
// Where the GPU is

/** An account's GPU: a saved address, a ComfyUI paired with a code (Fuobe Connect), or the ComfyUI on this computer. */
export type GpuPlace = { kind: "link"; url: string; hasToken?: boolean } | { kind: "connect"; name?: string } | { kind: "computer" };

/** <pod id>-<port>.proxy.runpod.net: RunPod's web address of a pod's port. */
const RUNPOD_HOST = /^[a-z0-9]+-(\d{2,5})\.proxy\.runpod\.net$/i;
const TUNNEL_HOST = /(^|\.)(trycloudflare\.com|ngrok-free\.app|ngrok-free\.dev|ngrok\.app|ngrok\.dev|ngrok\.io|loca\.lt)$/i;

/** What kind of address a GPU has: a RunPod pod's port, a quick tunnel, or another web address. */
export function gpuHostOf(url: string): { kind: "runpod"; port: number } | { kind: "tunnel" } | { kind: "web" } {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { kind: "web" };
  }
  const pod = RUNPOD_HOST.exec(host);
  if (pod) return { kind: "runpod", port: Number(pod[1]) };
  return TUNNEL_HOST.test(host) ? { kind: "tunnel" } : { kind: "web" };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------
// The details line

/** A short details line from an answer's text: an HTML page's title (or nothing), other text on one line, cut short. */
export function cleanDetails(text: string | undefined, max = 160): string {
  const t = String(text ?? "");
  if (!t.trim()) return "";
  if (/^\s*</.test(t) || /<html|<!doctype/i.test(t)) {
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(t)?.[1];
    return title ? title.replace(/\s+/g, " ").trim().slice(0, max) : "";
  }
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const joinDetails = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(" · ") || undefined;

// ---------------------------------------------------------------------------
// Buttons

const A = {
  retry: (): TroubleAction => ({ kind: "retry", label: "Retry" }),
  check: (): TroubleAction => ({ kind: "check-gpu", label: "Check my GPU" }),
  gpuSettings: (label = "Open Settings → Your GPU"): TroubleAction => ({ kind: "gpu-settings", label, target: "/settings#your-gpu" }),
  keySettings: (label = "Open Settings → Your keys"): TroubleAction => ({ kind: "key-settings", label, target: "/settings#your-keys" }),
  startPod: (): TroubleAction => ({ kind: "start-gpu", label: "Start your pod", target: RUNPOD_CONSOLE_URL }),
  pair: (): TroubleAction => ({ kind: "pair", label: "Pair with a code", target: "/connect" }),
  pick: (): TroubleAction => ({ kind: "pick-model", label: "Pick another model" }),
  credit: (p: CloudProvider): TroubleAction => ({ kind: "add-credit", label: `Add credit on ${CLOUD_KEY[p].label}`, target: BILLING_URL[p] }),
  withKey: (p: CloudProvider): TroubleAction => ({ kind: "run-with-key", label: `Run with your ${CLOUD_KEY[p].label} key`, target: p }),
};

/**
 * "Run with your fal.ai key": offered on a GPU trouble when the account has a key that runs this tool's cloud version
 * (`modelId`). An explicit click: it spends the person's own credit.
 */
export function withKeyAction(p: CloudProvider, modelId?: string, op?: string): TroubleAction {
  return { ...A.withKey(p), ...(modelId && { modelId }), ...(modelId && op && { op }) };
}

// ---------------------------------------------------------------------------
// Your GPU

/** Where the GPU was asked: a check (Settings' Test or Connect, the status check) or a step of a run. */
export type GpuStage = "test" | "status" | "upload" | "prompt" | "poll" | "result";

/** What came back from the GPU (or didn't): an answer's status and body, or a network error's message. */
export interface GpuFailure {
  stage: GpuStage;
  status?: number;
  /** The answer's text (its first part is enough). */
  body?: string;
  contentType?: string;
  /** A redirect's Location. */
  location?: string;
  /** A network error's message (no answer at all). */
  error?: string;
  /** The size of the file sent (an upload answered 413). */
  bytes?: number;
  retryAfterS?: number;
}

const NOT_FOUND = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo|Couldn't resolve|couldn't find/i;
const CERTIFICATE = /certificate|CERT_|self[- ]signed|SSL|TLS|unable to verify|ERR_TLS|wrong version number/i;
const PRIVATE = /won't fetch .*(this machine|private network)/i;
const TOO_LONG = /took over \d+ s|Timed out|ETIMEDOUT|timeout/i;
const NGROK_OFFLINE = /ERR_NGROK_3200|ERR_NGROK_8012|endpoint .{0,40}is offline|tunnel .{0,40}not found/i;
const CF_TUNNEL_DOWN = /Error 1033|Argo Tunnel error|Cloudflare Tunnel error/i;

const isHtml = (f: GpuFailure) => /text\/html/i.test(f.contentType ?? "") || /^\s*</.test(f.body ?? "");

const mb = (n: number) => Math.max(1, Math.ceil(n / 2 ** 20));

/** A check (Test, Connect, the status strip) or a run: the words end in "check again" or in "press Retry". */
const isCheck = (s: GpuStage) => s === "test" || s === "status";

/**
 * A GPU that didn't answer as ComfyUI, read from what came back: the cause, plain words, a details line and the buttons
 * that help. `place` names what the GPU is (a RunPod pod's port gets its own words and "Start your pod").
 */
export function diagnoseGpu(f: GpuFailure, place: GpuPlace): Diagnosis {
  const link = place.kind === "link" ? place : null;
  const kind = link ? gpuHostOf(link.url) : { kind: "web" as const };
  const pod = kind.kind === "runpod" ? kind : null;
  const host = link ? hostOf(link.url) : "";
  const check = isCheck(f.stage);
  const status = f.status ?? 0;
  const said = cleanDetails(f.body);
  const retryAfterMs = f.retryAfterS && f.retryAfterS > 0 ? f.retryAfterS * 1000 : undefined;
  const detailsFor = (what?: string) => joinDetails(host, status ? `HTTP ${status}` : undefined, what);
  // How a waiting problem goes on: a check connects once it answers; a run goes on by itself, then "press Retry".
  const thenCheck = check ? "and we connect as soon as it answers" : "then press Retry";
  const gpuButtons = (): TroubleAction[] => (check ? [A.check()] : [A.retry(), A.check()]);

  // The pod's port answers nothing (404: the pod is stopped; 502: nothing listens on that port yet).
  const podDown = (): Diagnosis => ({
    cause: "gpu-stopped",
    words: `Your RunPod pod isn't running, or ComfyUI isn't on port ${pod!.port}. Start your pod, ${thenCheck}.`,
    details: detailsFor(said),
    actions: [A.startPod(), ...gpuButtons(), A.gpuSettings()],
    retryable: true,
  });
  const offline = (what?: string): Diagnosis =>
    place.kind === "connect"
      ? {
          cause: "gpu-offline",
          words: `${place.name ? `${place.name} isn't` : "Your paired ComfyUI isn't"} online. Start ComfyUI there, and your runs go on by themselves.`,
          details: what,
          actions: [A.pair(), A.gpuSettings()],
          retryable: true,
        }
      : {
          cause: "gpu-offline",
          words: check
            ? "Your GPU didn't answer. Start ComfyUI and its tunnel, and we connect as soon as it answers."
            : "We can't reach your GPU. Start ComfyUI and its tunnel, then press Retry.",
          details: detailsFor(what),
          actions: [...(pod ? [A.startPod()] : []), ...gpuButtons(), A.gpuSettings()],
          retryable: true,
        };
  const starting = (): Diagnosis => ({
    cause: "gpu-starting",
    words: check
      ? "Your GPU is starting up. This can take a few minutes, and we connect as soon as ComfyUI is ready."
      : "Your GPU is starting up, so ComfyUI wasn't ready for this run. Press Retry in a minute.",
    details: detailsFor(said),
    actions: [...(pod ? [A.startPod()] : []), ...gpuButtons(), A.gpuSettings()],
    retryable: true,
    ...(retryAfterMs && { retryAfterMs }),
  });

  // No answer at all.
  if (f.error && !status) {
    const e = f.error;
    if (PRIVATE.test(e)) return diagnoseAddress("local");
    if (CERTIFICATE.test(e)) {
      return {
        cause: "gpu-certificate",
        words: "Your GPU's address has a certificate problem. Use the https address your tunnel or pod gives you.",
        details: detailsFor(cleanDetails(e)),
        actions: [A.gpuSettings(), A.pair()],
        retryable: false,
      };
    }
    if (NOT_FOUND.test(e)) {
      return {
        cause: "gpu-not-found",
        words: "We can't find your GPU's address. If your tunnel restarted, it has a new address: paste it in Settings → Your GPU.",
        details: detailsFor(cleanDetails(e)),
        actions: [A.gpuSettings("Paste the new address"), A.pair(), ...(check ? [] : [A.retry()])],
        retryable: true,
      };
    }
    // A big file over a slow address: sending it took longer than the upload may take.
    if (f.stage === "upload" && TOO_LONG.test(e) && (f.bytes ?? 0) > 20 * 2 ** 20) {
      return {
        cause: "gpu-slow-upload",
        words: "Sending your file to your GPU took too long. Try a shorter clip, or a smaller file.",
        details: detailsFor(cleanDetails(e)),
        actions: [A.retry()],
        retryable: false,
      };
    }
    return offline(cleanDetails(e));
  }

  // An answer, but not ComfyUI's.
  if (status === 401 || status === 403) {
    const wrong = !!link?.hasToken;
    return {
      cause: wrong ? "gpu-password-wrong" : "gpu-password",
      words: wrong
        ? check
          ? "That password didn't work. Check it, and paste it in Access token again."
          : "Your GPU didn't take its password. Update it in Settings → Your GPU, then press Retry."
        : check
          ? "Your GPU asks for a password. Paste it in Access token."
          : "Your GPU asks for a password. Add it in Settings → Your GPU, then press Retry.",
      details: detailsFor(),
      actions: [A.gpuSettings(wrong ? "Update the password" : "Add the password"), ...(check ? [] : [A.retry()])],
      retryable: false,
    };
  }
  if (status >= 300 && status < 400) {
    let to = "";
    try {
      to = new URL(f.location ?? "", "https://x.invalid").hostname.toLowerCase();
    } catch {}
    if (to.endsWith(".cloudflareaccess.com")) {
      return {
        cause: "gpu-sign-in",
        words: "Your GPU's address asks for a sign-in first. Turn the sign-in off for this address, or pair your ComfyUI with a code.",
        details: detailsFor("Cloudflare Access"),
        actions: [A.pair(), A.gpuSettings()],
        retryable: false,
      };
    }
    return {
      cause: "gpu-not-comfy",
      words: "Your GPU's address sends us to another page. Paste the final https address in Settings → Your GPU.",
      details: detailsFor(f.location ? `to ${cleanDetails(f.location, 120)}` : undefined),
      actions: [A.gpuSettings("Fix the address"), ...(check ? [] : [A.retry()])],
      retryable: false,
    };
  }
  if (pod && (status === 404 || status === 502)) return podDown();
  if (status === 404 && NGROK_OFFLINE.test(f.body ?? "")) return offline(said || `HTTP ${status}`);
  if (status === 530 || CF_TUNNEL_DOWN.test(f.body ?? "")) return offline(said || `HTTP ${status}`);
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 529)) return starting();
  if (status === 429) {
    return {
      cause: "gpu-busy",
      words: check ? "Your GPU's address is busy. We check again in a moment." : "Your GPU's address was busy. Press Retry in a minute.",
      details: detailsFor(said),
      actions: gpuButtons(),
      retryable: true,
      ...(retryAfterMs && { retryAfterMs }),
    };
  }
  if (status === 413) {
    const size = f.bytes ? ` (${mb(f.bytes)} MB)` : "";
    // A web page: the tunnel's or the pod's own size limit. Plain words: ComfyUI's own (--max-upload-size).
    return isHtml(f)
      ? {
          cause: "gpu-too-big",
          words: `This file is too big to send to your GPU's address${size}. Use a shorter clip or a smaller file, or pair your ComfyUI with a code.`,
          details: detailsFor(),
          actions: [A.pair(), A.retry()],
          retryable: false,
        }
      : {
          cause: "gpu-too-big",
          words: `This file is too big for your ComfyUI${size}. Use a smaller file, or start ComfyUI with a higher --max-upload-size.`,
          details: detailsFor(said),
          actions: [A.retry()],
          retryable: false,
        };
  }
  if (status >= 500) {
    return {
      cause: "gpu-error",
      words: "Your ComfyUI couldn't take this run. Restart ComfyUI, then press Retry.",
      details: detailsFor(joinDetails(f.stage === "upload" ? "upload" : f.stage === "prompt" ? "start" : undefined, said)),
      actions: [A.retry(), A.check()],
      retryable: false,
    };
  }
  // Another app, a web page, a 404 off a pod, or JSON without ComfyUI's facts.
  return {
    cause: "gpu-not-comfy",
    words: pod
      ? `That address opens a different app. Use the address of ComfyUI's port (on RunPod, the one ending in -8188).`
      : "That address opens a different app. Use the address of ComfyUI's port.",
    details: detailsFor(said || (isHtml(f) ? "a web page" : undefined)),
    actions: [A.gpuSettings("Fix the address"), ...(check ? [] : [A.retry()])],
    retryable: false,
  };
}

/** An address the check refused before calling it (checkGpuAddress), in the words Settings → Your GPU shows. */
export function diagnoseAddress(problem: "format" | "scheme" | "credentials" | "local" | "studio" | "not-found", host?: string): Diagnosis {
  switch (problem) {
    case "format":
    case "scheme":
      return {
        cause: "address-format",
        words: "Paste the whole web address of your ComfyUI, starting with https://.",
        actions: [],
        retryable: false,
      };
    case "credentials":
      return { cause: "address-credentials", words: "A password goes in the Access token box, not in the address.", actions: [], retryable: false };
    case "local":
      return {
        cause: "address-local",
        words: "That address only works on your own network. Use the ComfyUI on this computer, or pair your ComfyUI with a code.",
        actions: [{ kind: "use-computer", label: "Use this computer" }, A.pair()],
        retryable: false,
      };
    case "studio":
      return { cause: "address-studio", words: "Fuobe can't use this address. Connect your own ComfyUI.", actions: [A.pair()], retryable: false };
    case "not-found":
      return {
        cause: "gpu-not-found",
        words: "We can't find this address. If your tunnel restarted, it has a new address: paste the new one.",
        details: host,
        actions: [A.pair()],
        retryable: true,
      };
  }
}

/** What the check changed in an address as pasted (account-gpu.ts cleanGpuAddress), said under the field. */
export function addressFixNote(fixed: readonly ("scheme" | "query")[]): string | null {
  const said = [fixed.includes("scheme") && "We added https:// to the start of your address.", fixed.includes("query") && "We kept only the address part."].filter(Boolean);
  return said.length ? said.join(" ") : null;
}

/**
 * An address whose GPU is off right now (a stopped pod, one starting up or not answering) can be saved anyway: its runs
 * wait for it. One that can't work as it is (not found, a password, another app) can't.
 */
export const canSaveAnyway = (cause: TroubleCause): boolean => cause === "gpu-stopped" || cause === "gpu-starting" || cause === "gpu-offline" || cause === "gpu-busy";

/** Too many checks in a minute: the next one goes by itself once the wait is over. */
export function checksTooFast(retryAfterS: number): Diagnosis {
  return { cause: "checks-too-fast", words: "Checking again in a few seconds.", actions: [], retryable: true, retryAfterMs: Math.max(1, retryAfterS) * 1000 };
}

/** The out-of-memory words of a run on the person's own GPU (the computer path says the same). */
export const OUT_OF_MEMORY_WORDS = "Your GPU ran out of memory. Try a smaller size or a shorter clip.";

const OOM = /out of memory|CUDA error: out of memory|OutOfMemoryError|allocation on device|Allocation on device|MPS backend out of memory|HIP out of memory/i;
export const isOutOfMemoryText = (s: string) => OOM.test(s);

const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/** A job that failed on the person's own GPU while it ran: its own words for the details line, plain words above. */
export function diagnoseGpuJob(e: { kind: "error"; nodeType?: string; message?: string } | { kind: "interrupted" } | { kind: "lost"; resent?: boolean } | { kind: "moved" } | { kind: "gone"; minutes: number } | { kind: "busy"; minutes: number } | { kind: "save"; over?: string } | { kind: "isolated" }, place: GpuPlace): Diagnosis {
  const pod = place.kind === "link" && gpuHostOf(place.url).kind === "runpod";
  switch (e.kind) {
    case "error": {
      const msg = (e.message ?? "").trim();
      if (isOutOfMemoryText(msg)) return { cause: "gpu-out-of-memory", words: OUT_OF_MEMORY_WORDS, details: joinDetails(e.nodeType, cleanDetails(msg, 120)), actions: [A.retry(), A.pick()], retryable: false };
      return {
        cause: "gpu-job-error",
        words: "Your GPU hit a problem while making this. Press Retry, or update your add-ons.",
        details: joinDetails(e.nodeType, cleanDetails(msg, 160)),
        actions: [A.retry(), A.pick()],
        retryable: false,
      };
    }
    case "interrupted":
      return { cause: "gpu-stopped-run", words: "This run was stopped on your GPU. Press Retry to run it again.", actions: [A.retry()], retryable: false };
    case "lost":
      return {
        cause: "gpu-restarted",
        words: e.resent ? "Your GPU restarted, so we sent this run again." : "Your GPU restarted and lost this run. Press Retry.",
        actions: e.resent ? [] : [A.retry()],
        retryable: !e.resent,
      };
    case "moved":
      return { cause: "gpu-moved", words: "This run stopped because your GPU moved to a new address. Press Retry.", actions: [A.retry()], retryable: false };
    case "gone":
      return {
        cause: "gpu-went-away",
        words: `Your GPU stopped answering for ${minutes(e.minutes)}, so this run stopped. Start it again, then press Retry.`,
        actions: [...(pod ? [A.startPod()] : []), A.retry(), A.check()],
        retryable: false,
      };
    case "busy":
      return { cause: "gpu-busy", words: `Your GPU was busy for ${minutes(e.minutes)}, so this run stopped. Press Retry when it's free.`, actions: [A.retry()], retryable: false };
    case "save":
      return e.over
        ? { cause: "gpu-save-failed", words: `Your ComfyUI made a file over ${e.over}. Try a shorter clip or a lower size.`, actions: [A.retry()], retryable: false }
        : {
            cause: "gpu-save-failed",
            words: "Your result was made, but we couldn't copy it from your GPU. Start it again if it stopped, then press Retry.",
            actions: [...(pod ? [A.startPod()] : []), A.retry(), A.check()],
            retryable: false,
          };
    case "isolated":
      return { cause: "gpu-isolated", words: ISOLATED_ON_GPU, actions: [A.pick()], retryable: false };
  }
}

/** A workflow that needs a second ComfyUI of its own (LatentSync 1.6, ThinkSound): an account's single GPU can't run it. */
export const ISOLATED_ON_GPU = "This one needs its own ComfyUI, so it can't run on your GPU next to your other add-ons. Pick another model.";

/** ComfyUI refused the job (an add-on older than the tool expects, an input value it rejects): its words go in the details. */
export function diagnoseRefusal(comfyWords: string | undefined): Diagnosis {
  return {
    cause: "gpu-refused",
    words: "Your ComfyUI couldn't start this run. Update your add-ons, then press Retry.",
    details: cleanDetails(comfyWords, 200) || undefined,
    actions: [A.retry()],
    retryable: false,
  };
}

// ---------------------------------------------------------------------------
// Your keys

export type KeyStage = "submit" | "upload" | "poll" | "result";

/** What came back from fal.ai or Replicate (or didn't). */
export interface KeyFailure {
  stage: KeyStage;
  status?: number;
  /** The provider's words (already without the key). */
  text?: string;
  /** A network error's message (no answer at all). */
  error?: string;
  /** The job ran and failed there (fal's COMPLETED with an error, Replicate's "failed"). */
  failed?: boolean;
  /** Replicate's "canceled" or "aborted" from outside. */
  canceled?: boolean;
  retryAfterS?: number;
}

export interface KeyContext {
  provider: CloudProvider;
  /** Another key of the account that runs this tool too: offered as "Run with your … key". */
  other?: CloudProvider;
}

const BALANCE = /exhausted balance|insufficient (credit|balance|funds)|out of credit|top up your balance|payment required|balance has run out/i;
const CONTENT = /content (checker|policy|moderation)|flagged|nsfw|safety (checker|filter|system)|E005|sensitive/i;
const PERMISSION = /(do not|don't) have (permission|access)|not authori[sz]ed to (access|use|run)|no access to (this )?(model|app|endpoint)|not allowed to (use|run)/i;
/** The provider's words without its "fal 422: " or "replicate 404: " start. */
const providerText = (t: string | undefined) => (t ?? "").replace(/^(fal|replicate)\s+(\d{3}|upload):\s*/i, "");
/** A request field fal or Replicate named in a refusal ("body.image_url", "input.image"), as the person knows it. */
function fieldWords(text: string): string {
  const t = text.toLowerCase();
  if (/image|photo|picture|start_frame|end_frame|reference/.test(t)) return "this picture";
  if (/video|clip/.test(t)) return "this clip";
  if (/audio|voice|sound|song/.test(t)) return "this sound";
  if (/prompt|text/.test(t)) return "these words";
  if (/duration|num_frames|length|seconds/.test(t)) return "this length";
  return "these settings";
}

/**
 * A refusal or failure of an account's run on its own fal.ai or Replicate key, read from the provider's status and words:
 * the key (Settings → Your keys), the credit (the provider's billing page), the model, the input, or a passing problem
 * that waiting fixes.
 */
export function diagnoseKey(f: KeyFailure, ctx: KeyContext): Diagnosis {
  const name = CLOUD_KEY[ctx.provider].label;
  const status = f.status ?? 0;
  const said = cleanDetails(providerText(f.text) || f.error, 200);
  const details = joinDetails(status ? `${name} answered ${status}` : undefined, said);
  const other = ctx.other ? [A.withKey(ctx.other)] : [];
  const retryAfterMs = f.retryAfterS && f.retryAfterS > 0 ? f.retryAfterS * 1000 : undefined;
  const text = `${f.text ?? ""} ${f.error ?? ""}`;
  if (f.canceled) return { cause: "provider-stopped", words: `This run was stopped on ${name}. Press Retry to run it again.`, details, actions: [A.retry()], retryable: false };
  if (status === 402 || ((status === 401 || status === 403) && BALANCE.test(text)) || BALANCE.test(text)) {
    return {
      cause: "key-balance",
      words: balanceMessage(ctx.provider),
      details,
      actions: [A.credit(ctx.provider), A.retry(), ...other],
      retryable: false,
    };
  }
  if (status === 401 || (status === 403 && !PERMISSION.test(providerText(f.text)))) {
    return {
      cause: "key-rejected",
      words: keyRejectedMessage(ctx.provider),
      details,
      actions: [A.keySettings("Replace key"), ...other, A.retry()],
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      cause: "key-permission",
      words: `Your ${name} account can't run this model yet. Pick another model, or turn it on in your ${name} account.`,
      details,
      actions: [A.pick(), ...other],
      retryable: false,
    };
  }
  if (status === 404) {
    return { cause: "model-unavailable", words: `This model isn't available on ${name} right now. Pick another model.`, details, actions: [A.pick(), ...other], retryable: false };
  }
  if (CONTENT.test(text)) {
    return { cause: "content-flag", words: "The safety check stopped this one. Try different words or another picture.", details, actions: [A.retry(), A.pick()], retryable: false };
  }
  if (status === 400 || status === 422) {
    return {
      cause: "bad-input",
      words: `${name} couldn't use ${fieldWords(providerText(f.text))}. Change it, then run again.`,
      details,
      actions: [A.retry(), A.pick()],
      retryable: false,
    };
  }
  if (status === 429) {
    return { cause: "provider-busy", words: `${name} is busy right now. Press Retry in a minute.`, details, actions: [A.retry(), ...other], retryable: true, ...(retryAfterMs && { retryAfterMs }) };
  }
  if (status >= 500) {
    return {
      cause: "provider-down",
      words: `${name} is having trouble right now. Press Retry in a few minutes.`,
      details,
      actions: [A.retry(), ...other],
      retryable: f.stage !== "submit" || status === 503,
      ...(retryAfterMs && { retryAfterMs }),
    };
  }
  if (f.error && !status) {
    return {
      cause: "provider-unreachable",
      words: `We couldn't reach ${name}. Press Retry in a minute.`,
      details: joinDetails(cleanDetails(f.error, 160)),
      actions: [A.retry(), ...other],
      // At submit, only an error raised before anything was sent (no job made) is safe to send again.
      retryable: f.stage !== "submit" || /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(f.error),
    };
  }
  if (/no media|nothing back|replied:/i.test(text)) {
    return { cause: "no-result", words: `${name} finished but sent nothing back. Press Retry, or try other words.`, details, actions: [A.retry()], retryable: false };
  }
  if (f.failed) {
    return { cause: "provider-failed", words: `${name} couldn't finish this one. Press Retry, or try different words or another picture.`, details, actions: [A.retry(), A.pick()], retryable: false };
  }
  return { cause: "unknown", words: `${name} couldn't run this one. Press Retry.`, details, actions: [A.retry(), ...other], retryable: false };
}

/** A finished result whose link at the provider expired before it was saved. */
export function resultExpired(): Diagnosis {
  return { cause: "result-expired", words: "The finished file expired before we could save it. Press Retry to make it again.", actions: [A.retry()], retryable: false };
}

/** A GPU's state in two or three words, for the status strip ("Your GPU · pod stopped"). */
export function shortState(cause: TroubleCause | undefined): string {
  switch (cause) {
    case "gpu-stopped":
      return "pod stopped";
    case "gpu-starting":
      return "starting up";
    case "gpu-password":
    case "gpu-password-wrong":
    case "gpu-sign-in":
      return "needs a password";
    case "gpu-not-found":
      return "address not found";
    case "gpu-not-comfy":
    case "address-local":
      return "check the address";
    default:
      return "offline";
  }
}

// ---------------------------------------------------------------------------
// Waiting

/** While a run waits for its GPU (or its provider) to come back: the tile's words. */
export function waitingWords(d: Pick<Diagnosis, "cause">, provider?: CloudProvider): string {
  switch (d.cause) {
    case "gpu-stopped":
      return "Waiting for your RunPod pod to start";
    case "gpu-starting":
      return "Waiting for your GPU to start up";
    case "gpu-busy":
      return "Waiting for your GPU";
    case "provider-busy":
      return `${provider ? CLOUD_KEY[provider].label : "The provider"} is busy, trying again in a moment`;
    case "provider-down":
    case "provider-unreachable":
      return `Waiting for ${provider ? CLOUD_KEY[provider].label : "the provider"} to answer`;
    default:
      return "Waiting for your GPU";
  }
}

/** How long a run (or a check) keeps trying again by itself, from the first try to giving up, and its waits. */
export interface RetryPlan {
  budgetMs: number;
  firstMs: number;
  maxMs: number;
}

const MIN = 60_000;

/**
 * Self-healing: how long a passing problem is waited out, by cause. A run on a stopped pod or a GPU that doesn't answer
 * waits as long as a run may wait in its own GPU's queue (30 minutes); a GPU that is starting up, a few minutes; a
 * provider that is busy or down, a minute or three. Null: waiting can't fix it (a key, credit, a missing add-on, the
 * input), so it is never tried again by itself. A check (Settings' Test) waits less: 3 to 5 minutes.
 */
export function retryPlan(cause: TroubleCause, use: "run" | "check" = "run"): RetryPlan | null {
  const check = use === "check";
  switch (cause) {
    case "gpu-stopped":
      return { budgetMs: check ? 5 * MIN : 30 * MIN, firstMs: 15_000, maxMs: 60_000 };
    case "gpu-offline":
      return { budgetMs: check ? 3 * MIN : 30 * MIN, firstMs: 5_000, maxMs: check ? 30_000 : 60_000 };
    case "gpu-starting":
      return { budgetMs: check ? 5 * MIN : 10 * MIN, firstMs: 5_000, maxMs: check ? 30_000 : 60_000 };
    case "gpu-not-found":
      return check ? null : { budgetMs: 2 * MIN, firstMs: 10_000, maxMs: 30_000 };
    case "gpu-busy":
      return { budgetMs: 2 * MIN, firstMs: 5_000, maxMs: 30_000 };
    case "checks-too-fast":
      return { budgetMs: 2 * MIN, firstMs: 5_000, maxMs: 60_000 };
    case "provider-busy":
      return { budgetMs: 1 * MIN, firstMs: 3_000, maxMs: 20_000 };
    case "provider-down":
    case "provider-unreachable":
      return { budgetMs: 3 * MIN, firstMs: 5_000, maxMs: 60_000 };
    default:
      return null;
  }
}

/** The wait before try number `attempt` (1 = the first try again): doubling from firstMs up to maxMs, or what the other side said. */
export function backoffMs(attempt: number, plan: RetryPlan, retryAfterMs?: number): number {
  const doubled = Math.min(plan.maxMs, plan.firstMs * 2 ** Math.max(0, attempt - 1));
  return retryAfterMs && retryAfterMs > 0 ? Math.min(Math.max(retryAfterMs, plan.firstMs), plan.maxMs * 2) : doubled;
}
