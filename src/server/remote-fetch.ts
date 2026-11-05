import "server-only";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { Readable, Transform } from "node:stream";

/**
 * Fetch a file from a URL someone handed us (API callers, MCP clients, the Assist LLM) without
 * letting it reach this machine's own network: loopback, private, link-local (cloud metadata),
 * CGNAT and multicast addresses are refused. The check runs on the address the socket actually
 * connects to (so DNS can't swap it after the check), and again on every redirect.
 * Set FUOBE_ALLOW_PRIVATE_URLS=1 to allow private addresses (a LAN-only install that wants them).
 */

export const MAX_REMOTE_BYTES = 200 * 1024 * 1024;

export class RemoteFetchError extends Error {}

const v4 = (ip: string): number[] => ip.split(".").map(Number);

function blockedV4(ip: string): boolean {
  const [a, b, c] = v4(ip);
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT (and Alibaba's metadata service)
    (a === 169 && b === 254) || // link-local: cloud metadata endpoints
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 address to its 8 hextets (handles "::" and an embedded IPv4 tail). */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = v4(tail[1]);
    s = s.slice(0, -tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined ? (rest ? rest.split(":") : []) : [];
  const fill = rest !== undefined ? 8 - h.length - r.length : 0;
  const all = [...h, ...Array(Math.max(0, fill)).fill("0"), ...r].map((x) => parseInt(x || "0", 16));
  return all.length === 8 && all.every((n) => Number.isFinite(n)) ? all : null;
}

const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 addresses an IPv6 address carries inside it: IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d),
 * NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48), 6to4 (2002::/16) and Teredo (2001::/32: its server, and its
 * client with the bits flipped). `wrapped` is true for every form but the mapped one, which a dual-stack socket uses
 * for plain IPv4.
 */
function innerV4(h: number[]): { v4: string[]; wrapped: boolean } {
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return { v4: [embedded(h[6], h[7])], wrapped: false };
  if (h.slice(0, 6).every((x) => x === 0) && (h[6] !== 0 || h[7] > 1)) return { v4: [embedded(h[6], h[7])], wrapped: true };
  if (h[0] === 0x64 && h[1] === 0xff9b) return { v4: [embedded(h[6], h[7])], wrapped: true };
  if (h[0] === 0x2002) return { v4: [embedded(h[1], h[2])], wrapped: true };
  if (h[0] === 0x2001 && h[1] === 0) return { v4: [embedded(h[2], h[3]), embedded(h[6] ^ 0xffff, h[7] ^ 0xffff)], wrapped: true };
  return { v4: [], wrapped: false };
}

function blockedV6(ip: string): boolean {
  const h = hextets(ip);
  if (!h) return true;
  if (h.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  const inner = innerV4(h);
  if (inner.v4.length && !(h[0] === 0x2001 && h[1] === 0)) return inner.v4.some(blockedV4);
  return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] & 0xff00) === 0xff00;
}

/** True for addresses on this machine or its private networks (never fetched for a caller). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return blockedV4(ip);
  if (net.isIPv6(ip)) return blockedV6(ip);
  return true;
}

// ---------------------------------------------------------------------------
// An account's own ComfyUI (public sign-up): stricter than a link someone hands us

declare global {
  /** This machine's own addresses (os.networkInterfaces), refreshed every minute. */
  var __fuobeSelfAddresses: { at: number; set: Set<string> } | undefined;
  /** Tests only: the port of a stand-in ComfyUI an account may use on this machine (see loopbackGpuPort). */
  var __fuobeTestGpuPort: number | undefined;
}

/** An address as compared: IPv4 as it is, IPv6 as 8 hextets (no zone). */
const canonical = (ip: string): string => {
  const bare = ip.toLowerCase().split("%")[0];
  if (!net.isIPv6(bare)) return bare;
  const h = hextets(bare);
  return h ? h.map((x) => x.toString(16)).join(":") : bare;
};

/** This machine's own addresses (every interface, plus FUOBE_SELF_ADDRESSES, a comma list: a public address behind NAT). */
export function selfAddresses(): Set<string> {
  const cur = globalThis.__fuobeSelfAddresses;
  if (cur && Date.now() - cur.at < 60_000) return cur.set;
  const set = new Set<string>();
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) set.add(canonical(a.address));
  } catch {}
  for (const a of (process.env.FUOBE_SELF_ADDRESSES ?? "").split(",")) if (a.trim()) set.add(canonical(a.trim()));
  globalThis.__fuobeSelfAddresses = { at: Date.now(), set };
  return set;
}

/** Loopback and "this host" addresses, in any IPv6 form that carries them. */
function loopbackish(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a] = v4(ip);
    return a === 127 || a === 0;
  }
  const h = hextets(ip);
  if (!h) return true;
  if (h.slice(0, 7).every((x) => x === 0)) return true;
  return innerV4(h).v4.some(loopbackish);
}

/**
 * Addresses an account's ComfyUI may never be at: private and reserved networks (isPrivateAddress), this machine's own
 * addresses, and IPv6 addresses that wrap an IPv4 address (::a.b.c.d, NAT64, 6to4, Teredo: no tunnel needs them, and
 * they hide what they reach). FUOBE_ALLOW_PRIVATE_URLS=1 allows LAN addresses, never loopback or this machine.
 */
export function blockedForAccounts(ip: string): boolean {
  if (!net.isIP(ip)) return true;
  const h = net.isIPv6(ip) ? hextets(ip) : null;
  const inner = h ? innerV4(h) : { v4: [] as string[], wrapped: false };
  if (inner.wrapped) return true;
  const self = selfAddresses();
  if (self.has(canonical(ip)) || inner.v4.some((x) => self.has(x))) return true;
  if (loopbackish(ip) || linkLocalOrMetadata(ip) || inner.v4.some(linkLocalOrMetadata)) return true;
  return !allowPrivate() && isPrivateAddress(ip);
}

/**
 * Link-local addresses and the clouds' metadata services (169.254.0.0/16, fe80::/10, Alibaba's 100.100.100.200, AWS's
 * fd00:ec2::254): never an account's GPU, whatever FUOBE_ALLOW_PRIVATE_URLS says. No tunnel or LAN server is there.
 */
function linkLocalOrMetadata(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = v4(ip);
    return (a === 169 && b === 254) || ip === "100.100.100.200";
  }
  const h = hextets(ip);
  if (!h) return true;
  return (h[0] & 0xffc0) === 0xfe80 || canonical(ip) === canonical("fd00:ec2::254");
}

/**
 * The default check for links someone hands the owner's studio (fetchRemote): private and reserved networks (unless
 * FUOBE_ALLOW_PRIVATE_URLS=1), and always this machine's own public addresses, so a page can't steer the server into
 * fetching itself past the reverse proxy.
 */
export function blockedForLinks(ip: string): boolean {
  if (!allowPrivate() && isPrivateAddress(ip)) return true;
  const h = net.isIPv6(ip) ? hextets(ip) : null;
  const inner = h ? innerV4(h) : { v4: [] as string[], wrapped: false };
  const self = selfAddresses();
  return self.has(canonical(ip)) && !isPrivateAddress(ip) ? true : inner.v4.some((x) => self.has(x) && !isPrivateAddress(x));
}

/** Ports a stand-in ComfyUI may never use (the real ones on this machine, and the studio's own). */
const RESERVED_PORTS = [8000, 8188, 8189, 8190, 8288, 3000, 3001];

/**
 * Tests and `next dev` only: an account's GPU may be a stand-in ComfyUI on this machine, at one port
 * (vitest: globalThis.__fuobeTestGpuPort; `next dev`: FUOBE_DEV_GPU_LOOPBACK_PORT). `next start` and `next build`
 * run with NODE_ENV=production, so this is always null on a live server.
 */
export function loopbackGpuPort(): number | null {
  if (process.env.NODE_ENV === "production") return null;
  const v =
    process.env.VITEST === "true" ? globalThis.__fuobeTestGpuPort : process.env.NODE_ENV === "development" ? Number(process.env.FUOBE_DEV_GPU_LOOPBACK_PORT) : NaN;
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535 && !RESERVED_PORTS.includes(v) ? v : null;
}

/** An address that is the stand-in ComfyUI of loopbackGpuPort: http://localhost or http://127.0.0.1 at exactly that port. */
export function isLoopbackGpu(u: URL): boolean {
  const port = loopbackGpuPort();
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return port !== null && u.protocol === "http:" && (host === "localhost" || host === "127.0.0.1") && Number(u.port) === port;
}

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

export interface RemoteFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Tests: resolve host names without DNS. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests: which addresses to refuse (default: {@link isPrivateAddress}). */
  blocked?: (ip: string) => boolean;
}

const allowPrivate = () => process.env.FUOBE_ALLOW_PRIVATE_URLS === "1";

function refuse(host: string): RemoteFetchError {
  return new RemoteFetchError(`Fuobe won't fetch ${host}: it points to this machine or a private network. Upload the file instead.`);
}

/** GET a public http(s) URL into memory, with a timeout, a size cap and checked redirects. */
export async function fetchRemote(url: string, o: RemoteFetchOptions = {}): Promise<{ data: Buffer; contentType: string | null; url: string }> {
  const res = await download(url, o);
  return { data: res.data!, contentType: res.contentType, url: res.url };
}

/** Big results a provider links to (LTX HDR's EXR frames as a zip): streamed to disk, never held in memory. */
export const MAX_REMOTE_FILE_BYTES = 16 * 2 ** 30;

/**
 * GET a public http(s) URL straight into the file `dest` (the same checks as fetchRemote; the cap defaults
 * to MAX_REMOTE_FILE_BYTES and the deadline to 30 minutes). A failed download leaves no file behind.
 */
export async function fetchRemoteToFile(url: string, dest: string, o: RemoteFetchOptions = {}): Promise<{ bytes: number; contentType: string | null; url: string }> {
  try {
    const res = await download(url, { maxBytes: MAX_REMOTE_FILE_BYTES, timeoutMs: 30 * 60_000, ...o }, dest);
    return { bytes: res.bytes, contentType: res.contentType, url: res.url };
  } catch (e) {
    fs.rmSync(dest, { force: true });
    throw e;
  }
}

async function download(url: string, o: RemoteFetchOptions, dest?: string): Promise<{ data?: Buffer; bytes: number; contentType: string | null; url: string }> {
  const maxBytes = o.maxBytes ?? MAX_REMOTE_BYTES;
  const blocked = o.blocked ?? blockedForLinks;
  const resolve = o.resolve ?? (async (host: string) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  const deadline = Date.now() + (o.timeoutMs ?? 60_000);
  let current = new URL(url);
  for (let hop = 0; hop <= (o.maxRedirects ?? 5); hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") throw new RemoteFetchError(`Only http(s) links can be fetched, not ${current.protocol}`);
    if (current.username || current.password) throw new RemoteFetchError("Links with a user name or password aren't fetched");
    const host = current.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && blocked(host)) throw refuse(current.host);
    const res = await get(current, { host, maxBytes, deadline, resolve, blocked, dest });
    if (res.location) {
      current = new URL(res.location, current);
      continue;
    }
    return { data: res.data, bytes: res.bytes ?? 0, contentType: res.contentType, url: current.toString() };
  }
  throw new RemoteFetchError(`Too many redirects fetching ${url}`);
}

function get(
  url: URL,
  o: { host: string; maxBytes: number; deadline: number; resolve: (host: string) => Promise<string[]>; blocked: (ip: string) => boolean; dest?: string },
): Promise<{ location?: string; data?: Buffer; bytes?: number; contentType: string | null }> {
  // Checked at connect time, on the address actually used.
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    o.resolve(hostname).then(
      (addrs) => {
        if (!addrs.length) return cb(new RemoteFetchError(`Couldn't resolve ${hostname}`), "", 4);
        if (addrs.some(o.blocked)) return cb(refuse(hostname), "", 4);
        if (options.all) return (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs.map((a) => ({ address: a, family: net.isIPv6(a) ? 6 : 4 })));
        cb(null, addrs[0], net.isIPv6(addrs[0]) ? 6 : 4);
      },
      (e: Error) => cb(e, "", 4),
    );
  };
  const left = o.deadline - Date.now();
  if (left <= 0) return Promise.reject(new RemoteFetchError(`Timed out fetching ${url.host}`));
  return new Promise((resolveOuter, rejectOuter) => {
    // A hard deadline for the whole download, not just an idle timeout.
    const timer = setTimeout(() => {
      req.destroy();
      reject(new RemoteFetchError(`Timed out fetching ${url.host}`));
    }, left);
    const resolvePromise = (v: { location?: string; data?: Buffer; bytes?: number; contentType: string | null }) => {
      clearTimeout(timer);
      resolveOuter(v);
    };
    // To a file (o.dest): written as it arrives; closed on any failure.
    let file: fs.WriteStream | null = null;
    const reject = (e: Error) => {
      clearTimeout(timer);
      file?.destroy();
      rejectOuter(e);
    };
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "GET", lookup, headers: { "User-Agent": "Fuobe", Accept: "*/*" }, timeout: left }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolvePromise({ location: res.headers.location, contentType: null });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new RemoteFetchError(`Could not fetch ${url.toString()}: ${status}`));
      }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > o.maxBytes) {
        res.destroy();
        return reject(new RemoteFetchError(`That file is over ${Math.round(o.maxBytes / 1024 / 1024)} MB`));
      }
      const contentType = res.headers["content-type"]?.split(";")[0].trim() || null;
      const chunks: Buffer[] = [];
      // The response pauses while the disk catches up.
      file = o.dest ? fs.createWriteStream(o.dest) : null;
      file?.on("error", (e) => {
        res.destroy();
        req.destroy();
        reject(e);
      });
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          res.destroy();
          req.destroy();
          reject(new RemoteFetchError(`That file is over ${Math.round(o.maxBytes / 1024 / 1024)} MB`));
          return;
        }
        if (!file) return void chunks.push(c);
        if (!file.write(c)) {
          res.pause();
          file.once("drain", () => res.resume());
        }
      });
      res.on("end", () => {
        if (!file) return resolvePromise({ data: Buffer.concat(chunks), bytes: size, contentType });
        file.end(() => resolvePromise({ bytes: size, contentType }));
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new RemoteFetchError(`Timed out fetching ${url.host}`)));
    req.on("error", (e) => reject(e instanceof RemoteFetchError ? e : new RemoteFetchError(`Could not fetch ${url.toString()}: ${e.message}`)));
    req.end();
  });
}

/**
 * fetch() for a server someone else named (an account's own ComfyUI, public sign-up): any method and
 * body, the response streamed, but the connection only goes to a public address, checked on the
 * address the socket actually connects to (so a name re-pointed at this machine after it was saved
 * still can't reach the install's own ComfyUI or anything else on its network: blockedForAccounts).
 * Redirects aren't followed. The whole exchange has a deadline and the answer a size cap, so a slow
 * or endless answer can't hold the server. FUOBE_ALLOW_PRIVATE_URLS=1 allows LAN addresses, never
 * loopback or this machine's own.
 */
export interface PublicFetchOptions extends Pick<RemoteFetchOptions, "resolve" | "blocked"> {
  /** Idle time: no bytes for this long ends the request (default 60 s). */
  timeoutMs?: number;
  /** The whole exchange, the answer's body read to its end included (default 60 s): past it, request and answer are destroyed. */
  deadlineMs?: number;
  /** The most the answer's body may hold (default 8 MiB): past it, reading the body fails. */
  maxBytes?: number;
}

export const PUBLIC_FETCH_MAX_BYTES = 8 * 2 ** 20;

/** Let go of an answer whose body won't be read (an error status): its connection closes now (fetchPublic). */
export function discardBody(res: Response): void {
  if (res.body && !res.bodyUsed) res.body.cancel().catch(() => {});
}

/**
 * The start of an answer's body as text (an error page, for a details line): at most `maxBytes`, waited for at most `ms`.
 * The rest is let go of, so a body that never ends can't hold the caller.
 */
export async function peekText(res: Response, maxBytes = 4096, ms = 2000): Promise<string> {
  if (!res.body || res.bodyUsed) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
    timer.unref?.();
  });
  try {
    while (size < maxBytes) {
      const next = await Promise.race([reader.read(), late]);
      if (!next || next.done) break;
      chunks.push(next.value);
      size += next.value.length;
    }
  } catch {
    // A body that broke off: what came is enough.
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

const mbOf = (n: number) => (n >= 2 ** 30 ? `${Math.round(n / 2 ** 30)} GB` : `${Math.max(1, Math.round(n / 2 ** 20))} MB`);

export async function fetchPublic(url: string, init: RequestInit = {}, o: PublicFetchOptions = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new RemoteFetchError(`Only http(s) addresses, not ${target.protocol}`);
  // A stand-in ComfyUI on this machine (tests and `next dev` only): loopback, and nothing else, for this request.
  const blocked = o.blocked ?? (isLoopbackGpu(target) ? (ip: string) => !LOOPBACK.has(ip) : blockedForAccounts);
  const maxBytes = o.maxBytes ?? PUBLIC_FETCH_MAX_BYTES;
  const deadlineMs = o.deadlineMs ?? 60_000;
  const resolve = o.resolve ?? (async (host: string) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  const host = target.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && blocked(host)) throw refuse(target.host);
  // The body and headers as fetch would send them (FormData gets its boundary).
  const asked = new Request(target, init);
  const body = asked.method === "GET" || asked.method === "HEAD" ? undefined : Buffer.from(await asked.arrayBuffer());
  const headers: Record<string, string> = {};
  asked.headers.forEach((v, k) => (headers[k] = v));
  if (body) headers["content-length"] = String(body.length);
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    resolve(hostname).then(
      (addrs) => {
        if (!addrs.length) return cb(new RemoteFetchError(`Couldn't resolve ${hostname}`), "", 4);
        if (addrs.some(blocked)) return cb(refuse(hostname), "", 4);
        if (options.all) return (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs.map((a) => ({ address: a, family: net.isIPv6(a) ? 6 : 4 })));
        cb(null, addrs[0], net.isIPv6(addrs[0]) ? 6 : 4);
      },
      (e: Error) => cb(e, "", 4),
    );
  };
  const tooBig = () => new RemoteFetchError(`The answer was over ${mbOf(maxBytes)}`);
  return new Promise<Response>((resolveRes, reject) => {
    let settled = false;
    // The answer's body, counted on its way to the caller.
    let counted: Transform | null = null;
    const settle = (e?: Error, res?: Response) => {
      if (settled) return;
      settled = true;
      if (e) reject(e);
      else resolveRes(res!);
    };
    const fail = (e: Error) => {
      clearTimeout(deadline);
      req.destroy(e);
      counted?.destroy(e);
      settle(e);
    };
    // The whole exchange, not only the idle time: a ComfyUI that drips a byte at a time can't hold a request open.
    const deadline = setTimeout(() => fail(new RemoteFetchError(`${target.host} took over ${Math.round(deadlineMs / 1000)} s to answer`)), deadlineMs);
    deadline.unref?.();
    const req = (target.protocol === "https:" ? https : http).request(target, { method: asked.method, headers, lookup, timeout: o.timeoutMs ?? 60_000 }, (res) => {
      const status = res.statusCode ?? 0;
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
      if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
        res.destroy();
        return fail(tooBig());
      }
      const empty = asked.method === "HEAD" || status === 204 || status === 304;
      if (empty) {
        res.resume();
        clearTimeout(deadline);
        return settle(undefined, new Response(null, { status, statusText: res.statusMessage, headers: out }));
      }
      let seen = 0;
      counted = new Transform({
        transform(this: Transform, chunk: Buffer, _enc, cb) {
          seen += chunk.length;
          if (seen > maxBytes) {
            // The answer's own error first (at once): destroying the response after can't replace it.
            this.destroy(tooBig());
            res.destroy();
            return;
          }
          cb(null, chunk);
        },
        // Let go of (discardBody) or failed with a chunk still on its way: Node 22's Readable.toWeb would put that
        // chunk into the closed web stream, a "Controller is already closed" nothing catches. Nobody reads it now.
        destroy(this: Transform, err, cb) {
          this.removeAllListeners("data");
          cb(err);
        },
      });
      const stream = counted;
      res.on("error", (e) => stream.destroy(e));
      res.on("aborted", () => stream.destroy(new RemoteFetchError(`${target.host} stopped answering`)));
      // Read to its end, failed, or let go by the caller (discardBody): the connection closes at once, never held
      // open until the deadline.
      stream.on("close", () => {
        clearTimeout(deadline);
        if (!res.complete) res.destroy();
      });
      res.pipe(stream);
      settle(undefined, new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage, headers: out }));
    });
    req.on("timeout", () => req.destroy(new RemoteFetchError(`Timed out reaching ${target.host}`)));
    req.on("error", (e) => {
      const err = e instanceof RemoteFetchError ? e : new RemoteFetchError(`Couldn't reach ${target.host}: ${e.message}`);
      counted?.destroy(err);
      clearTimeout(deadline);
      settle(err);
    });
    if (init.signal) init.signal.addEventListener("abort", () => fail(new RemoteFetchError("Aborted")), { once: true });
    req.end(body);
  });
}
