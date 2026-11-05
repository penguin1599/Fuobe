import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers/temp-dir";
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const dir = tempDir("fuobe-bodies-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
process.env.FUOBE_PUBLIC_SIGNUP = "1";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_TRUST_PROXY;

const auth = await import("@/server/auth");
const { config } = await import("@/proxy");
const nextConfig = (await import("../next.config")).default;
const finish = await import("@/app/api/generations/[id]/finish/route");
const renders = await import("@/app/api/layers/renders/route");
const skillsUpload = await import("@/app/api/assist/skills/upload/route");
const sources = await import("@/app/api/assist/projects/[projectId]/sources/route");
const explainerDoc = await import("@/app/api/explainer/document/route");
const generations = await import("@/app/api/generations/route");
const mixExport = await import("@/app/api/audio-tools/export/route");

let owner = "";
let account = "";
beforeAll(() => {
  auth.setPassword("install password");
  owner = auth.createSession().value;
  account = auth.createSession(auth.createAccount("bodies@example.com", "long enough").id).value;
});
afterEach(() => delete process.env.FUOBE_ALLOWED_ORIGINS);

const MB = 2 ** 20;
const bytes = (v: string | number | undefined) => {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(String(v ?? "10mb"));
  if (!m) return Number(v);
  return Number(m[1]) * { b: 1, kb: 2 ** 10, mb: MB, gb: 2 ** 30 }[m[2].toLowerCase() as "b" | "kb" | "mb" | "gb"];
};

/** The routes that take a big body (a file in a form): the proxy leaves them out and they check the asker themselves. */
const BIG = [
  { name: "finish", path: "/api/generations/g1/finish", call: (r: Request) => finish.POST(r, { params: Promise.resolve({ id: "g1" }) } as never) },
  { name: "layer renders", path: "/api/layers/renders", call: (r: Request) => renders.POST(r) },
  { name: "skill upload", path: "/api/assist/skills/upload", call: (r: Request) => skillsUpload.POST(r) },
  { name: "Assist sources", path: "/api/assist/projects/p1/sources", call: (r: Request) => sources.POST(r, { params: Promise.resolve({ projectId: "p1" }) } as never) },
  { name: "explainer document", path: "/api/explainer/document", call: (r: Request) => explainerDoc.POST(r) },
  // PR #15: Split soundtrack's mix export takes its WAV as the body, in parts of 16 MB (a library change: the owner's).
  { name: "mix export", path: "/api/audio-tools/export", call: (r: Request) => mixExport.POST(r) },
];

function form(pathname: string, init: { cookie?: string; headers?: Record<string, string> } = {}) {
  const body = new FormData();
  body.set("file", new File([Buffer.from("not a png")], "x.png", { type: "image/png" }));
  return new Request(`http://localhost:3000${pathname}`, { method: "POST", headers: { ...(init.cookie && { cookie: `${auth.SESSION_COOKIE}=${init.cookie}` }), ...init.headers }, body });
}

describe("M-3: the proxy holds at most a few MB of any request body", () => {
  it("buffers 4 MB at most", () => {
    expect(bytes(nextConfig.experimental?.proxyClientMaxBodySize)).toBeLessThanOrEqual(4 * MB);
    // Still more than the largest JSON body a page sends (Evolution's 2 MB frame).
    expect(bytes(nextConfig.experimental?.proxyClientMaxBodySize)).toBeGreaterThan(2 * MB + 64 * 1024);
  });

  it("leaves out only the routes that take a file in a form", () => {
    const matches = (p: string) => new RegExp(`^${config.matcher[0]}$`).test(p);
    for (const r of BIG) expect(matches(r.path), r.path).toBe(false);
    for (const p of ["/api/generations", "/api/generations/g1", "/api/generations/g1/cancel", "/api/layers", "/api/layers/abc", "/api/assist/skills", "/api/assist/projects/p1", "/api/assist/projects/p1/sources/s1", "/api/explainer", "/api/audio-tools"]) {
      expect(matches(p), p).toBe(true);
    }
  });

  it("each of those routes refuses a guest, an account and another website as the proxy would", async () => {
    for (const r of BIG) {
      // Assist and the tools an account's own GPU doesn't run give a guest the account's answer (403): signing up
      // wouldn't let it in. A run's finish, a save to the library and an explainer's document offer to sign up (401).
      expect((await r.call(form(r.path))).status, `${r.name}: guest`).toBe(["finish", "mix export", "explainer document"].includes(r.name) ? 401 : 403);
      expect((await r.call(form(r.path, { cookie: owner, headers: { origin: "http://evil.example" } }))).status, `${r.name}: cross-site`).toBe(403);
    }
    // An account: its own Export mix and an explainer's document pass the proxy's rules (the route then reads the WAV or the
    // document: a PNG isn't one), and its own
    // run's finish does too, but "g1" isn't its own.
    for (const r of BIG) expect((await r.call(form(r.path, { cookie: account }))).status, `${r.name}: account`).toBe(["mix export", "explainer document"].includes(r.name) ? 415 : 403);
  });

  it("each lets the owner through to the route's own checks", async () => {
    for (const r of BIG) expect([400, 404, 413, 415, 422], `${r.name}: owner`).toContain((await r.call(form(r.path, { cookie: owner }))).status);
  });

  it("each stops reading a body without a length (chunked) once it passes the route's limit", async () => {
    // A real form with one 120 MB file, sent 1 MB at a time as it is asked for: the route must stop asking soon after its own limit.
    const chunk = new Uint8Array(MB);
    const enc = new TextEncoder();
    for (const r of BIG) {
      let pulled = 0;
      let state = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (state === 0) {
            state = 1;
            return c.enqueue(enc.encode('--x\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n'));
          }
          if (pulled >= 120 * MB) {
            c.enqueue(enc.encode("\r\n--x--\r\n"));
            return c.close();
          }
          pulled += chunk.length;
          c.enqueue(chunk);
        },
      });
      const headers = { cookie: `${auth.SESSION_COOKIE}=${owner}`, "content-type": "multipart/form-data; boundary=x" };
      const res = await r.call(new Request(`http://localhost:3000${r.path}`, { method: "POST", headers, body, duplex: "half" } as RequestInit));
      expect(res.status, `${r.name}: status`).toBe(413);
      expect(pulled, `${r.name}: bytes read`).toBeLessThanOrEqual(66 * MB);
    }
  });

  it("a run request cut short at the proxy's limit says it is too large", async () => {
    const r = await generations.POST(
      new Request("http://localhost:3000/api/generations", {
        method: "POST",
        headers: { cookie: `${auth.SESSION_COOKIE}=${owner}`, "content-type": "application/json", "content-length": String(5 * MB) },
        body: `{"modelId":"oss-z-image-turbo","prompt":"x","inputs":{"images":["data:image/png;base64,AAAA`,
      }),
    );
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/upload/i);
  });
});
