import { describe, expect, it } from "vitest";
import {
  addressFixNote,
  backoffMs,
  BILLING_URL,
  canSaveAnyway,
  checksTooFast,
  cleanDetails,
  diagnoseAddress,
  diagnoseGpu,
  diagnoseGpuJob,
  diagnoseKey,
  diagnoseRefusal,
  gpuHostOf,
  ISOLATED_ON_GPU,
  retryPlan,
  RUNPOD_CONSOLE_URL,
  shortState,
  troubleOf,
  waitingWords,
  type Diagnosis,
  type GpuPlace,
} from "@/lib/diagnose";

// What an account sees when its own GPU or key has a problem: one plain sentence, a details line, the buttons that help,
// and whether waiting fixes it (src/lib/diagnose.ts). Pure: no network.

const pod: GpuPlace = { kind: "link", url: "https://abc123xyz-8188.proxy.runpod.net" };
const tunnel: GpuPlace = { kind: "link", url: "https://quiet-river.trycloudflare.com" };
const withToken: GpuPlace = { kind: "link", url: "https://gpu.example.com", hasToken: true };
const kinds = (d: Diagnosis) => d.actions.map((a) => a.kind);

/** The main sentence never carries a status code, a program's own error words, an address or jargon. */
function plain(d: Diagnosis) {
  expect(d.words, d.cause).not.toMatch(/\b(HTTP|[1-5]\d\d)\b|upload failed|\/prompt|provider|route|ECONN|ENOTFOUND|getaddrinfo|<!DOCTYPE|<html|undefined|null|\{/i);
  expect(d.words, d.cause).not.toMatch(/proxy\.runpod\.net|trycloudflare|127\.0\.0\.1/);
  expect(d.words.length, d.cause).toBeLessThan(200);
}

describe("the kind of address a GPU has", () => {
  it("tells a RunPod pod's port, a quick tunnel and another web address apart", () => {
    expect(gpuHostOf("https://abc123xyz-8188.proxy.runpod.net")).toEqual({ kind: "runpod", port: 8188 });
    expect(gpuHostOf("https://abc123xyz-3000.proxy.runpod.net/")).toEqual({ kind: "runpod", port: 3000 });
    expect(gpuHostOf("https://quiet-river.trycloudflare.com")).toEqual({ kind: "tunnel" });
    expect(gpuHostOf("https://x.ngrok-free.app")).toEqual({ kind: "tunnel" });
    expect(gpuHostOf("https://gpu.example.com")).toEqual({ kind: "web" });
    expect(gpuHostOf("not a url")).toEqual({ kind: "web" });
  });
});

describe("Your GPU: what came back", () => {
  it("the reported case: a stopped RunPod pod's 404 says start the pod, links to RunPod, and waits", () => {
    for (const stage of ["upload", "test", "status", "prompt"] as const) {
      const d = diagnoseGpu({ stage, status: 404, body: "404 page not found", contentType: "text/plain" }, pod);
      expect(d.cause).toBe("gpu-stopped");
      expect(d.words).toMatch(/^Your RunPod pod isn't running, or ComfyUI isn't on port 8188\./);
      expect(d.actions[0]).toEqual({ kind: "start-gpu", label: "Start your pod", target: RUNPOD_CONSOLE_URL });
      expect(kinds(d)).toContain("check-gpu");
      expect(d.retryable).toBe(true);
      expect(d.details).toMatch(/abc123xyz-8188\.proxy\.runpod\.net · HTTP 404/);
      plain(d);
    }
    // A check connects once it answers; a run says what to press.
    expect(diagnoseGpu({ stage: "test", status: 404 }, pod).words).toMatch(/we connect as soon as it answers/);
    expect(diagnoseGpu({ stage: "upload", status: 404 }, pod).words).toMatch(/then press Retry/);
    expect(kinds(diagnoseGpu({ stage: "upload", status: 404 }, pod))).toEqual(["start-gpu", "retry", "check-gpu", "gpu-settings"]);
  });

  it("a RunPod 502 (nothing on the port yet) is the same; 503, 504 and Cloudflare's 52x are a GPU starting up", () => {
    expect(diagnoseGpu({ stage: "upload", status: 502, body: "<html>Bad gateway</html>" }, pod).cause).toBe("gpu-stopped");
    for (const status of [502, 503, 504, 520, 522, 524]) {
      const d = diagnoseGpu({ stage: "upload", status, body: "<!DOCTYPE html><html><head><title>Bad gateway</title></head><body>…</body></html>", contentType: "text/html" }, tunnel);
      expect(d.cause, String(status)).toBe("gpu-starting");
      expect(d.retryable).toBe(true);
      // An HTML error page never reaches the words, and only its title the details.
      expect(d.details).toBe(`quiet-river.trycloudflare.com · HTTP ${status} · Bad gateway`);
      plain(d);
    }
    expect(diagnoseGpu({ stage: "upload", status: 503 }, pod)).toMatchObject({ cause: "gpu-starting", actions: expect.arrayContaining([expect.objectContaining({ kind: "start-gpu" })]) });
  });

  it("a tunnel that isn't running (Cloudflare 530, ngrok's offline page) is a GPU that doesn't answer", () => {
    expect(diagnoseGpu({ stage: "status", status: 530, body: "error code: 1033" }, tunnel).cause).toBe("gpu-offline");
    expect(diagnoseGpu({ stage: "upload", status: 404, body: "ERR_NGROK_3200 The endpoint x.ngrok-free.app is offline." }, { kind: "link", url: "https://x.ngrok-free.app" }).cause).toBe("gpu-offline");
  });

  it("no answer at all: refused, timed out, a name that can't be found, a certificate, a private address", () => {
    const offline = diagnoseGpu({ stage: "prompt", error: "Couldn't reach gpu.example.com: connect ECONNREFUSED 1.2.3.4:443" }, tunnel);
    expect(offline).toMatchObject({ cause: "gpu-offline", retryable: true });
    expect(offline.details).toMatch(/ECONNREFUSED/);
    plain(offline);
    expect(diagnoseGpu({ stage: "test", error: "quiet-river.trycloudflare.com took over 15 s to answer" }, tunnel).cause).toBe("gpu-offline");
    const gone = diagnoseGpu({ stage: "upload", error: "Couldn't reach x: getaddrinfo ENOTFOUND quiet-river.trycloudflare.com" }, tunnel);
    expect(gone).toMatchObject({ cause: "gpu-not-found", retryable: true });
    expect(gone.words).toMatch(/new address/);
    expect(kinds(gone)).toEqual(expect.arrayContaining(["gpu-settings", "pair"]));
    plain(gone);
    const cert = diagnoseGpu({ stage: "test", error: "Couldn't reach 1.2.3.4: self-signed certificate" }, withToken);
    expect(cert).toMatchObject({ cause: "gpu-certificate", retryable: false });
    plain(cert);
    const priv = diagnoseGpu({ stage: "upload", error: "Fuobe won't fetch gpu.example.com: it points to this machine or a private network. Upload the file instead." }, withToken);
    expect(priv.cause).toBe("address-local");
    // The owner's advice about uploading a file isn't for a GPU.
    expect(priv.words).not.toMatch(/Upload the file/);
    // A big clip over a slow address: not a dead GPU.
    expect(diagnoseGpu({ stage: "upload", error: "x took over 300 s to answer", bytes: 80 * 2 ** 20 }, tunnel)).toMatchObject({ cause: "gpu-slow-upload", retryable: false });
  });

  it("a password: none sent, or the one sent refused; a sign-in page in front", () => {
    const none = diagnoseGpu({ stage: "test", status: 401 }, tunnel);
    expect(none).toMatchObject({ cause: "gpu-password", retryable: false, words: "Your GPU asks for a password. Paste it in Access token." });
    const wrong = diagnoseGpu({ stage: "test", status: 403 }, withToken);
    expect(wrong.cause).toBe("gpu-password-wrong");
    expect(wrong.words).toMatch(/didn't work/);
    expect(diagnoseGpu({ stage: "upload", status: 401 }, withToken).words).toMatch(/Settings → Your GPU/);
    const access = diagnoseGpu({ stage: "test", status: 302, location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" }, tunnel);
    expect(access).toMatchObject({ cause: "gpu-sign-in", retryable: false });
    expect(kinds(access)).toContain("pair");
  });

  it("another app or a web page: the address to fix, with the RunPod port it should end in", () => {
    const page = diagnoseGpu({ stage: "test", status: 200, body: "<html><title>Jupyter</title></html>", contentType: "text/html" }, pod);
    expect(page.cause).toBe("gpu-not-comfy");
    expect(page.words).toMatch(/ending in -8188/);
    expect(diagnoseGpu({ stage: "test", status: 404 }, tunnel).cause).toBe("gpu-not-comfy");
    expect(diagnoseGpu({ stage: "test", status: 301, location: "https://elsewhere.example/" }, tunnel)).toMatchObject({ cause: "gpu-not-comfy", details: expect.stringMatching(/elsewhere/) });
  });

  it("a file too big: the address's own cap (a web page) apart from ComfyUI's", () => {
    const cap = diagnoseGpu({ stage: "upload", status: 413, body: "<html>413 Request Entity Too Large</html>", bytes: 150 * 2 ** 20 }, tunnel);
    expect(cap).toMatchObject({ cause: "gpu-too-big", retryable: false });
    expect(cap.words).toMatch(/too big to send to your GPU's address \(150 MB\)/);
    expect(kinds(cap)).toContain("pair");
    const comfy = diagnoseGpu({ stage: "upload", status: 413, body: "", contentType: "text/plain", bytes: 120 * 2 ** 20 }, tunnel);
    expect(comfy.words).toMatch(/too big for your ComfyUI \(120 MB\).*max-upload-size/);
  });

  it("a 500 from ComfyUI itself is not waited out; a 429 from the address is", () => {
    expect(diagnoseGpu({ stage: "upload", status: 500, body: "upload folder is read-only" }, tunnel)).toMatchObject({ cause: "gpu-error", retryable: false, details: expect.stringMatching(/upload · upload folder is read-only/) });
    expect(diagnoseGpu({ stage: "upload", status: 429, retryAfterS: 7 }, tunnel)).toMatchObject({ cause: "gpu-busy", retryable: true, retryAfterMs: 7000 });
  });

  it("a paired ComfyUI that is offline names it", () => {
    const d = diagnoseGpu({ stage: "poll", error: "no beat" }, { kind: "connect", name: "Studio PC" });
    expect(d.words).toBe("Studio PC isn't online. Start ComfyUI there, and your runs go on by themselves.");
  });
});

describe("Your GPU: the address before it is called", () => {
  it("says what to fix in plain words", () => {
    expect(diagnoseAddress("credentials").words).toMatch(/Access token box/);
    expect(diagnoseAddress("local")).toMatchObject({ cause: "address-local", actions: [{ kind: "use-computer" }, { kind: "pair", target: "/connect" }] });
    expect(diagnoseAddress("studio").words).toBe("Fuobe can't use this address. Connect your own ComfyUI.");
    expect(diagnoseAddress("format").words).toMatch(/https:\/\//);
    expect(addressFixNote(["scheme"])).toBe("We added https:// to the start of your address.");
    expect(addressFixNote(["scheme", "query"])).toBe("We added https:// to the start of your address. We kept only the address part.");
    expect(addressFixNote([])).toBeNull();
    expect(checksTooFast(12)).toMatchObject({ cause: "checks-too-fast", words: "Checking again in a few seconds.", retryable: true, retryAfterMs: 12_000 });
  });
});

describe("Your GPU: a run that failed there", () => {
  it("out of memory, stopped on the GPU, an add-on's exception: plain words, ComfyUI's own in the details", () => {
    const oom = diagnoseGpuJob({ kind: "error", nodeType: "KSampler", message: "CUDA out of memory. Tried to allocate 2.00 GiB" }, tunnel);
    expect(oom).toMatchObject({ cause: "gpu-out-of-memory", words: "Your GPU ran out of memory. Try a smaller size or a shorter clip." });
    expect(oom.details).toMatch(/^KSampler · CUDA out of memory/);
    expect(diagnoseGpuJob({ kind: "interrupted" }, tunnel).words).toBe("This run was stopped on your GPU. Press Retry to run it again.");
    const node = diagnoseGpuJob({ kind: "error", nodeType: "VHS_LoadVideo", message: "Traceback (most recent call last):\n  File …" }, tunnel);
    expect(node.cause).toBe("gpu-job-error");
    plain(node);
    expect(node.details).toMatch(/^VHS_LoadVideo · Traceback/);
  });

  it("restarted, moved, gone, busy, a result it couldn't copy, a graph it can't run", () => {
    expect(diagnoseGpuJob({ kind: "lost", resent: true }, tunnel).words).toBe("Your GPU restarted, so we sent this run again.");
    expect(diagnoseGpuJob({ kind: "lost" }, tunnel).words).toMatch(/Press Retry/);
    expect(diagnoseGpuJob({ kind: "moved" }, tunnel).words).toBe("This run stopped because your GPU moved to a new address. Press Retry.");
    const gone = diagnoseGpuJob({ kind: "gone", minutes: 15 }, pod);
    expect(gone.words).toBe("Your GPU stopped answering for 15 minutes, so this run stopped. Start it again, then press Retry.");
    expect(kinds(gone)).toEqual(["start-gpu", "retry", "check-gpu"]);
    expect(diagnoseGpuJob({ kind: "busy", minutes: 30 }, tunnel).words).toMatch(/busy for 30 minutes/);
    expect(diagnoseGpuJob({ kind: "save", over: "1 GB" }, tunnel).words).toBe("Your ComfyUI made a file over 1 GB. Try a shorter clip or a lower size.");
    expect(diagnoseGpuJob({ kind: "save" }, tunnel).words).toMatch(/couldn't copy it from your GPU/);
    expect(diagnoseGpuJob({ kind: "isolated" }, tunnel)).toMatchObject({ words: ISOLATED_ON_GPU, actions: [{ kind: "pick-model" }] });
    expect(diagnoseRefusal("KSampler: Value 9 smaller than min of 10")).toMatchObject({ cause: "gpu-refused", details: "KSampler: Value 9 smaller than min of 10" });
  });
});

describe("Your keys: what fal.ai or Replicate said", () => {
  const fal = { provider: "fal" as const };
  it("a key refused or out of credit is never waited out, and says where to fix it", () => {
    const key = diagnoseKey({ stage: "submit", status: 401, text: "fal.ai didn't accept your key. Check it in Settings → Your keys." }, fal);
    expect(key).toMatchObject({ cause: "key-rejected", retryable: false, words: "fal.ai didn't accept your key. Check it in Settings → Your keys." });
    expect(key.actions[0]).toEqual({ kind: "key-settings", label: "Replace key", target: "/settings#your-keys" });
    for (const f of [
      { status: 403, text: "fal 403: User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing." },
      { status: 402, text: "replicate 402: You have insufficient credit to run this model." },
    ]) {
      const d = diagnoseKey({ stage: "submit", ...f }, f.status === 402 ? { provider: "replicate" } : fal);
      expect(d.cause).toBe("key-balance");
      expect(d.retryable).toBe(false);
      expect(d.actions[0]).toEqual({ kind: "add-credit", label: `Add credit on ${f.status === 402 ? "Replicate" : "fal.ai"}`, target: BILLING_URL[f.status === 402 ? "replicate" : "fal"] });
    }
    expect(diagnoseKey({ stage: "submit", status: 403, text: "replicate 403: You do not have permission to run this model." }, { provider: "replicate" })).toMatchObject({ cause: "key-permission", retryable: false });
  });

  it("a model gone, an input refused, a content check: the main sentence plain, the provider's words in details", () => {
    const gone = diagnoseKey({ stage: "submit", status: 404, text: "fal 404: Application 'minimax/h9' not found" }, fal);
    expect(gone).toMatchObject({ cause: "model-unavailable", words: "This model isn't available on fal.ai right now. Pick another model." });
    expect(gone.details).toBe("fal.ai answered 404 · Application 'minimax/h9' not found");
    const input = diagnoseKey({ stage: "submit", status: 422, text: "fal 422: body.image_url: Could not download the file" }, fal);
    expect(input.words).toBe("fal.ai couldn't use this picture. Change it, then run again.");
    plain(input);
    expect(diagnoseKey({ stage: "submit", status: 422, text: "fal 422: body.prompt: too long" }, fal).words).toMatch(/these words/);
    expect(diagnoseKey({ stage: "poll", failed: true, text: "fal 422: The content could not be processed because it contained material flagged by a content checker." }, fal).cause).toBe("content-flag");
    expect(diagnoseKey({ stage: "poll", failed: true, text: "CUDA error: device-side assert" }, fal)).toMatchObject({ cause: "provider-failed", retryable: false });
    expect(diagnoseKey({ stage: "poll", failed: true, canceled: true, text: "canceled" }, { provider: "replicate" }).words).toBe("This run was stopped on Replicate. Press Retry to run it again.");
    expect(diagnoseKey({ stage: "poll", failed: true, text: 'No media in response: {"output":null}' }, fal).cause).toBe("no-result");
  });

  it("busy, down or unreachable is waited out, except a submit that may have landed", () => {
    expect(diagnoseKey({ stage: "submit", status: 429, text: "replicate 429: Request was throttled.", retryAfterS: 3 }, { provider: "replicate" })).toMatchObject({ cause: "provider-busy", retryable: true, retryAfterMs: 3000 });
    expect(diagnoseKey({ stage: "submit", status: 503, text: "fal 503: Service unavailable" }, fal)).toMatchObject({ cause: "provider-down", retryable: true });
    // A 502 or 504 at submit may have started a job already: never sent twice.
    expect(diagnoseKey({ stage: "submit", status: 502, text: "fal 502: <!DOCTYPE html>…" }, fal)).toMatchObject({ cause: "provider-down", retryable: false });
    expect(diagnoseKey({ stage: "poll", status: 502 }, fal).retryable).toBe(true);
    expect(diagnoseKey({ stage: "submit", error: "fetch failed ECONNREFUSED" }, fal)).toMatchObject({ cause: "provider-unreachable", retryable: true });
    expect(diagnoseKey({ stage: "submit", error: "fetch failed UND_ERR_SOCKET" }, fal).retryable).toBe(false);
  });

  it("offers the other key when it runs the same model", () => {
    const d = diagnoseKey({ stage: "submit", status: 503 }, { provider: "fal", other: "replicate" });
    expect(d.actions).toContainEqual({ kind: "run-with-key", label: "Run with your Replicate key", target: "replicate" });
  });
});

describe("waiting, and how long", () => {
  it("has a budget for what waiting can fix, and none for what it can't", () => {
    expect(retryPlan("gpu-stopped")).toEqual({ budgetMs: 30 * 60_000, firstMs: 15_000, maxMs: 60_000 });
    expect(retryPlan("gpu-offline")?.budgetMs).toBe(30 * 60_000);
    expect(retryPlan("gpu-starting")?.budgetMs).toBe(10 * 60_000);
    expect(retryPlan("gpu-offline", "check")?.budgetMs).toBe(3 * 60_000);
    expect(retryPlan("gpu-starting", "check")?.budgetMs).toBe(5 * 60_000);
    expect(retryPlan("provider-busy")?.budgetMs).toBe(60_000);
    for (const never of ["key-rejected", "key-balance", "gpu-password", "gpu-refused", "bad-input", "gpu-not-comfy", "gpu-out-of-memory", "content-flag"] as const) {
      expect(retryPlan(never), never).toBeNull();
    }
    expect(retryPlan("gpu-not-found", "check")).toBeNull();
  });

  it("doubles its wait up to a cap, or takes what the other side said", () => {
    const plan = { budgetMs: 60_000, firstMs: 5_000, maxMs: 60_000 };
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, plan))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(backoffMs(1, plan, 12_000)).toBe(12_000);
    expect(backoffMs(1, plan, 1)).toBe(5_000);
  });

  it("says what a run waits for, and the strip's short words", () => {
    expect(waitingWords({ cause: "gpu-stopped" })).toBe("Waiting for your RunPod pod to start");
    expect(waitingWords({ cause: "gpu-starting" })).toBe("Waiting for your GPU to start up");
    expect(waitingWords({ cause: "gpu-offline" })).toBe("Waiting for your GPU");
    expect(waitingWords({ cause: "provider-busy" }, "fal")).toBe("fal.ai is busy, trying again in a moment");
    expect(shortState("gpu-stopped")).toBe("pod stopped");
    expect(shortState("gpu-password-wrong")).toBe("needs a password");
    expect(shortState(undefined)).toBe("offline");
  });
});

describe("Save anyway", () => {
  it("keeps an address whose GPU is only off right now, never one that can't work as it is", () => {
    for (const c of ["gpu-stopped", "gpu-starting", "gpu-offline", "gpu-busy"] as const) expect(canSaveAnyway(c), c).toBe(true);
    for (const c of ["gpu-not-found", "gpu-password", "gpu-not-comfy", "gpu-certificate", "address-local"] as const) expect(canSaveAnyway(c), c).toBe(false);
  });
});

describe("the details line", () => {
  it("is short and never an HTML page", () => {
    expect(cleanDetails("<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>x</h1></body></html>")).toBe("502 Bad Gateway");
    expect(cleanDetails("<html><body>no title</body></html>")).toBe("");
    expect(cleanDetails("a\n  b\tc")).toBe("a b c");
    expect(cleanDetails("x".repeat(500)).length).toBe(160);
    expect(troubleOf(diagnoseGpu({ stage: "upload", status: 404 }, pod))).toEqual({ cause: "gpu-stopped", details: "abc123xyz-8188.proxy.runpod.net · HTTP 404", actions: expect.any(Array) });
  });
});
