// Fuobe Connect's pairing mode, end to end: a studio on 3361 with a throwaway data folder, the stand-in ComfyUI
// (tests/helpers/fake-local-comfy.ts) on 3362, and Fuobe Connect's own runner (integrations/fuobe-connect, run outside
// ComfyUI by its tests/pair_and_run.py). No browser and no real ComfyUI: nothing touches any other port.
//
//   pnpm build && node tests/e2e/fuobe-connect.mjs
//   E2E_DEV=1 node tests/e2e/fuobe-connect.mjs          (next dev instead of a build)
//   FUOBE_CONNECT_PYTHON=/path/to/python                 (a Python with aiohttp; default: python3, then python)
//
// Checks: a code is approved only by a signed-in person; the ComfyUI gets a token for that person alone and runs their
// run to the end with no browser; another person's ComfyUI never gets that run; the token can't act as the owner or
// reach any other route; an owner API token can't act as a worker; Disconnect in the studio stops the token at its
// next call.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { root } from "./_browser.mjs";
import { tempDir, removeDir, stopProcess } from "./_temp.mjs";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3361);
const FAKE_PORT = Number(process.env.E2E_FAKE_PORT ?? 3362);
const SITE = `http://127.0.0.1:${APP_PORT}`;
const FAKE = `http://127.0.0.1:${FAKE_PORT}`;
const data = tempDir("fuobe-connect-e2e-");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30_000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

const python = process.env.FUOBE_CONNECT_PYTHON ?? (spawnSync("python3", ["-c", "import aiohttp"]).status === 0 ? "python3" : "python");
const password = `e2e-${Math.random().toString(36).slice(2)}`;
const server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), process.env.E2E_DEV ? "dev" : "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], {
  cwd: root,
  env: { ...process.env, FUOBE_DATA_DIR: data, FUOBE_PASSWORD: password, FUOBE_PUBLIC_SIGNUP: "1", COMFYUI_URL: "http://127.0.0.1:3399", ...(process.env.E2E_DEV ? {} : { NODE_ENV: "production" }) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const fake = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", path.join(root, "tests/helpers/fake-local-comfy.ts"), "--port", String(FAKE_PORT), "--cors", "off", "--steps", "4", "--step-ms", "200", "--has", path.join(root, "workflows/comfyui/requirements.json")], {
  stdio: ["ignore", "pipe", "inherit"],
});

const clients = [];
/** Fuobe Connect's runner as its own process: its JSON lines, one by one. */
function connect(name, token) {
  // The helper prints the worker token only when asked (this studio is a throwaway one), and takes one from the environment.
  const env = { ...process.env, FUOBE_CONNECT_TEST_PRINT_TOKEN: "1", ...(token ? { FUOBE_CONNECT_TOKEN: token } : {}) };
  const p = spawn(python, [path.join(root, "integrations/fuobe-connect/tests/pair_and_run.py"), "--site", SITE, "--comfy", FAKE, "--name", name], { stdio: ["ignore", "pipe", "pipe"], env });
  clients.push(p);
  const lines = [];
  let err = "";
  readline.createInterface({ input: p.stdout }).on("line", (l) => {
    try {
      lines.push(JSON.parse(l));
    } catch {}
  });
  p.stderr.on("data", (d) => (err += d));
  return { p, lines, err: () => err, next: (event, ms = 30_000) => until(() => lines.find((l) => l.event === event), ms) };
}

/** A signed-up account's calls (its session cookie), as a browser on the studio's page would send them. */
async function account(email) {
  const r = await fetch(`${SITE}/api/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "long enough password" }) });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("fuobe_session=")) throw new Error(`sign-up answered ${r.status}`);
  return async (url, init = {}) => {
    const res = await fetch(`${SITE}${url}`, { ...init, headers: { cookie, origin: SITE, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

async function finish() {
  for (const c of clients) c.kill();
  fake.kill();
  await stopProcess(server);
  removeDir(data);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed.`);
  if (failed.length) console.log(serverLog.split("\n").slice(-40).join("\n"));
  process.exit(failed.length ? 1 : 0);
}

try {
  if (!(await until(() => fetch(`${SITE}/api/auth/me`).then((r) => r.ok), 180_000, 500))) throw new Error(`the studio didn't start:\n${serverLog}`);
  if (!(await until(() => fetch(`${FAKE}/__fake/stats`).then((r) => r.ok), 15_000))) throw new Error("the stand-in ComfyUI didn't start");
  const alice = await account("alice@example.com");
  const bob = await account("bob@example.com");

  // Pairing: a code, approved by Alice while signed in.
  const a = connect("alice-pc");
  const code = await a.next("code");
  check("Fuobe Connect gets a code and a link to the studio", code && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code.code) && code.url === `${SITE}/connect?pair=1`, code ? `${code.code} ${code.url}` : a.err());
  const anon = await fetch(`${SITE}/api/gpu/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code }) });
  check("a signed-out visitor can't approve a code", anon.status === 401, `${anon.status}`);
  const look = await alice(`/api/gpu/pair?code=${encodeURIComponent(code.code)}`);
  check("the person sees the computer before approving", look.status === 200 && look.body?.name === "alice-pc" && look.body?.facts?.device === "Test GPU", JSON.stringify(look.body));
  const wrong = await alice(`/api/gpu/pair?code=ABCD-EFGH`);
  check("an unknown code is no code", wrong.status === 404, `${wrong.status}`);
  const ok = await alice("/api/gpu/pair", { method: "POST", body: JSON.stringify({ code: code.code }) });
  check("Alice approves the code", ok.status === 200 && ok.body?.ok, JSON.stringify(ok.body));
  const paired = await a.next("paired");
  check("the ComfyUI gets its token once approved", paired?.token?.startsWith("fuobe_wkr_"), paired ? paired.workerId : a.err());
  check("the ComfyUI learns who approved it, masked", paired?.account === "al•••@example.com", paired?.account);
  const again = await alice("/api/gpu/pair", { method: "POST", body: JSON.stringify({ code: code.code }) });
  check("an approved code can't be used again", again.status === 404, `${again.status}`);
  const gpu = await alice("/api/account/gpu");
  check("Alice's GPU is now her computer", gpu.body?.gpu?.mode === "computer", JSON.stringify(gpu.body));
  const list = await alice("/api/gpu/paired");
  check("Alice's paired ComfyUIs list it", list.body?.paired?.length === 1 && list.body.paired[0].name === "alice-pc", JSON.stringify(list.body));
  check("Bob's list is empty", (await bob("/api/gpu/paired")).body?.paired?.length === 0);

  // The token is a worker's, nothing more.
  const token = paired.token;
  const bearer = { authorization: `Bearer ${token}` };
  const other = await fetch(`${SITE}/api/settings`, { headers: bearer });
  check("the worker token gets 403 on any other route", other.status === 403, `${other.status}`);
  const gens = await fetch(`${SITE}/api/generations`, { headers: bearer });
  check("the worker token can't read runs", gens.status === 403, `${gens.status}`);

  // Bob pairs a ComfyUI too, and starts nothing.
  const b = connect("bob-pc");
  const bcode = await b.next("code");
  await bob("/api/gpu/pair", { method: "POST", body: JSON.stringify({ code: bcode.code }) });
  const bpaired = await b.next("paired");
  check("Bob's ComfyUI is paired to Bob", !!bpaired?.token);
  await sleep(1500);

  // Alice's run goes to Alice's ComfyUI, with no browser open anywhere.
  const run = await alice("/api/generations", { method: "POST", body: JSON.stringify({ feature: "image", modelId: "oss-z-image-turbo", prompt: "a red door" }) });
  const gid = run.body?.items?.[0]?.id;
  check("Alice starts a run", run.status === 200 || run.status === 201, `${run.status} ${JSON.stringify(run.body).slice(0, 200)}`);
  const done = await until(async () => {
    const g = await alice(`/api/generations/${gid}`);
    return ["succeeded", "failed", "canceled"].includes(g.body?.status) ? g.body : null;
  }, 90_000, 1000);
  check("Alice's run finishes on her paired ComfyUI", done?.status === "succeeded", done ? `${done.status} ${done.error ?? ""}` : "timed out");
  const stats = await fetch(`${FAKE}/__fake/stats`).then((r) => r.json()).catch(() => null);
  check("the stand-in ComfyUI ran exactly one prompt", stats?.posts === 1, JSON.stringify(stats)?.slice(0, 200));
  const bobRuns = await bob("/api/generations?limit=5");
  check("Bob sees none of Alice's runs", (bobRuns.body?.items ?? []).length === 0);
  const bobClaim = await fetch(`${SITE}/api/gpu/computer/claim`, { method: "POST", headers: { authorization: `Bearer ${bpaired.token}`, "content-type": "application/json" }, body: JSON.stringify({ device: "connect-bob-x", running: [] }) });
  check("Bob's ComfyUI gets no job of Alice's", bobClaim.status === 204, `${bobClaim.status}`);

  // An owner API token is never a worker.
  const owner = await fetch(`${SITE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const ownerCookie = (owner.headers.get("set-cookie") ?? "").split(";")[0];
  const made = await fetch(`${SITE}/api/auth/tokens`, { method: "POST", headers: { cookie: ownerCookie, origin: SITE, "content-type": "application/json" }, body: JSON.stringify({ name: "e2e" }) }).then((r) => r.json()).catch(() => null);
  if (made?.token) {
    const asWorker = await fetch(`${SITE}/api/gpu/computer/beat`, { method: "POST", headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json" }, body: JSON.stringify({ device: "owner-token-x" }) });
    check("an owner API token can't act as a worker", asWorker.status === 403, `${asWorker.status}`);
  } else check("an owner API token can't act as a worker", false, "couldn't make an owner token");

  // Disconnect in the studio: the token stops at its next call, and the runner says so.
  const id = list.body.paired[0].id;
  const gone = await alice(`/api/gpu/paired/${id}`, { method: "DELETE" });
  check("Alice disconnects her ComfyUI", gone.status === 200);
  const after = await fetch(`${SITE}/api/gpu/computer/beat`, { method: "POST", headers: { ...bearer, "content-type": "application/json" }, body: JSON.stringify({ device: "connect-alice-pc" }) });
  check("a disconnected token gets 401 at once", after.status === 401, `${after.status}`);
  check("the runner hears it and stops", !!(await a.next("unpaired", 30_000)));
  const bobUnpair = await fetch(`${SITE}/api/gpu/computer/unpair`, { method: "POST", headers: { authorization: `Bearer ${bpaired.token}` } });
  check("Fuobe Connect's own Disconnect revokes its token", bobUnpair.status === 200 && (await fetch(`${SITE}/api/gpu/computer/claim`, { method: "POST", headers: { authorization: `Bearer ${bpaired.token}` }, body: "{}" })).status === 401);
} catch (e) {
  check("the run", false, String(e?.stack ?? e));
}
await finish();
