import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { CONNECT_GPU_HEADER, CONNECT_GPU_UPLOAD_MESSAGE, CONNECT_GPU_UPLOAD_OPEN_MESSAGE, KINETIC_UPLOAD_HEADER } from "@/lib/guest-access";
import { accountProviders, paidAllowed } from "@/server/account-keys";
import { policy as billingPolicy } from "@/server/billing";
import { poolReady } from "@/server/hosted";
import { imageSize } from "@/lib/image-size";
import { sniffMedia, type SniffKind } from "@/lib/sniff";
import { ACCOUNT_LIMITS, ACCOUNT_MESSAGES, accountTotalBytes, accountUsage, diskHasRoom, filesFullMessage } from "@/server/account-files";
import { accountGpu, type Account } from "@/server/auth";
import { gateDirect } from "@/server/direct-gate";
import { enter, hit } from "@/server/rate";
import { adoptFile, contentTypeFor, saveFile, scratchDir } from "@/server/storage";

/**
 * Upload a picture, clip or sound. The body is the file itself (Content-Type and X-File-Name: its name, URI-encoded),
 * streamed to disk; a multipart form with a `file` field still works (the CLI, older pages). The proxy doesn't run
 * on this route (src/proxy.ts config.matcher), so a large upload never waits in its memory: gateDirect makes the
 * proxy's checks here.
 *
 * - The owner: up to 200 MB, the types below.
 * - An account (public sign-up): with its own ComfyUI connected or its own fal.ai or Replicate key (something to run
 *   its files on), any of the types below; without either, only a result rendered in its browser (sent with
 *   KINETIC_UPLOAD_HEADER: a Kinetic Motion clip or poster, a colour grade, a Relight blend; an MP4 or WebM clip, or a
 *   PNG picture), which no model makes. A picture up to 25 MB
 *   and 40 megapixels, a
 *   sound up to 50 MB, a clip up to 95 MB; its uploads up to 1 GB and all its files up to 3 GB; 60 uploads an hour,
 *   300 a day, 2 at once. The stored type is read from the file's first bytes, never taken from the client.
 */

const OWNER_MAX_BYTES = 200 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime|x-matroska|x-msvideo)|audio\/(mpeg|wav|x-wav|ogg|flac|mp4|webm))$/;
const UNSUPPORTED = "Fuobe can't open that file. Use a JPG, PNG, WebP, GIF, MP4, MOV, WebM, MP3 or WAV.";
/** Names browsers give AVI and Matroska files, to the one Fuobe stores them under. */
const VIDEO_ALIASES: Record<string, string> = { "video/avi": "video/x-msvideo", "video/msvideo": "video/x-msvideo", "video/vnd.avi": "video/x-msvideo", "video/mkv": "video/x-matroska" };

/** A result rendered in the browser: a clip or a picture (the stored type, read from its bytes). */
const KINETIC_TYPES = /^(video\/(mp4|webm)|image\/png)$/;

const KIND_CAP: Record<SniffKind, number> = { image: ACCOUNT_LIMITS.imageBytes, audio: ACCOUNT_LIMITS.audioBytes, video: ACCOUNT_LIMITS.videoBytes };
const KIND_MESSAGE: Record<SniffKind, string> = { image: ACCOUNT_MESSAGES.imageTooBig, audio: ACCOUNT_MESSAGES.audioTooBig, video: ACCOUNT_MESSAGES.videoTooBig };

const json = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** An account with nothing that would let it add this file: "Connect your GPU" (with a key too, where paid models are on). */
const connectFirst = () => json(403, { error: paidAllowed() ? CONNECT_GPU_UPLOAD_MESSAGE : CONNECT_GPU_UPLOAD_OPEN_MESSAGE, code: "connect-gpu" }, { [CONNECT_GPU_HEADER]: "1" });

const isMultipart = (request: Request) => (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");

class TooBig extends Error {}
class Stalled extends Error {}

/** One read of a body, or Stalled when nothing arrives within `ms`. */
function readWithin<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<ReadableStreamReadResult<T>> {
  if (!Number.isFinite(ms)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Stalled()), Math.max(0, ms));
  });
  return Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
}

/** The file's name as display text only: no folders, no control or path characters, at most 120 characters. */
function displayName(raw: string | null): string | undefined {
  if (!raw) return undefined;
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {}
  name = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .trim()
    .slice(0, 120);
  return name || undefined;
}

/** The type a client says a file is (its Content-Type, else its name's extension), with the browser aliases. */
function declaredType(contentType: string | null, name: string | undefined): string {
  const t = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const given = !t || t === "application/octet-stream" ? contentTypeFor(name ?? "", "") : t;
  return VIDEO_ALIASES[given] ?? given;
}

const kindOf = (type: string): SniffKind | null => (/^image\//.test(type) ? "image" : /^video\//.test(type) ? "video" : /^audio\//.test(type) ? "audio" : null);

/**
 * Stream a request body into `dest`, at most `max` bytes (TooBig past it; no file is left on any failure). With
 * `idleMs` / `totalMs`: Stalled when nothing arrives for that long, or the whole body takes longer.
 */
async function streamTo(body: ReadableStream<Uint8Array> | null, dest: string, max: number, opts: { idleMs?: number; totalMs?: number } = {}): Promise<number> {
  const out = fs.createWriteStream(dest);
  const reader = body?.getReader();
  const deadline = Date.now() + (opts.totalMs ?? Infinity);
  let bytes = 0;
  try {
    while (reader) {
      const { done, value } = await readWithin(reader, Math.min(opts.idleMs ?? Infinity, deadline - Date.now()));
      if (done) break;
      bytes += value.length;
      if (bytes > max) throw new TooBig();
      if (!out.write(value)) await new Promise<void>((resolve, reject) => out.once("drain", resolve).once("error", reject));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    return bytes;
  } catch (e) {
    reader?.cancel().catch(() => {});
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
}

/** The first bytes of a file on disk (enough to tell its type and a picture's size). */
function headOf(file: string, n = 1024 * 1024): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(n, fs.fstatSync(fd).size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

const tempFile = () => path.join(scratchDir(), `up-${nanoid(12)}`);

export async function POST(request: Request) {
  const viewer = gateDirect(request);
  if (viewer instanceof Response) return viewer;
  if (viewer.kind === "account") return accountUpload(request, viewer.account);
  return ownerUpload(request);
}

// ---------------------------------------------------------------------------
// The owner

async function ownerUpload(request: Request): Promise<Response> {
  if ((request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a file to upload." }, { status: 400 });
    if (file.size > OWNER_MAX_BYTES) return Response.json({ error: "That file is over 200 MB. Try a smaller one." }, { status: 413 });
    // Scripts often send no type (or octet-stream): go by the file extension then.
    const type = declaredType(file.type, file.name);
    if (!ALLOWED.test(type)) return Response.json({ error: UNSUPPORTED }, { status: 415 });
    const asset = saveFile({ data: Buffer.from(await file.arrayBuffer()), contentType: type, name: displayName(file.name), source: "upload" });
    return Response.json(asset, { status: 201 });
  }
  // The file as the body.
  const name = displayName(request.headers.get("x-file-name"));
  const type = declaredType(request.headers.get("content-type"), name);
  if (!ALLOWED.test(type)) return Response.json({ error: UNSUPPORTED }, { status: 415 });
  if (Number(request.headers.get("content-length") ?? 0) > OWNER_MAX_BYTES) return Response.json({ error: "That file is over 200 MB. Try a smaller one." }, { status: 413 });
  const dest = tempFile();
  let bytes: number;
  try {
    bytes = await streamTo(request.body, dest, OWNER_MAX_BYTES);
  } catch (e) {
    if (e instanceof TooBig) return Response.json({ error: "That file is over 200 MB. Try a smaller one." }, { status: 413 });
    throw e;
  }
  if (!bytes) {
    fs.rmSync(dest, { force: true });
    return Response.json({ error: "Choose a file to upload." }, { status: 400 });
  }
  return Response.json(adoptFile({ from: dest, contentType: type, name, source: "upload" }), { status: 201 });
}

// ---------------------------------------------------------------------------
// An account

type Kinds = { image: boolean; video: boolean; audio: boolean };

/**
 * What an account with no GPU or key of its own may add: the kinds its runs on this install's GPUs may use (hosted runs
 * on), and a result it rendered in its browser (a Kinetic Motion clip or poster, a colour grade, a Relight blend: no
 * model makes one).
 */
type Without = { hosted: Kinds | null; kinetic: boolean };

/** The kinds of file an account with no GPU or key of its own may add for runs on this install's GPUs (hosted runs). */
async function hostedUploads(accountId: string): Promise<Kinds | null> {
  if (!poolReady()) return null;
  const p = await billingPolicy(accountId);
  if (!p?.hosted || !(p.uploads.image || p.uploads.video || p.uploads.audio)) return null;
  return p.uploads;
}

async function accountUpload(request: Request, account: Account): Promise<Response> {
  // No GPU and no key of its own: with hosted runs on, the files a run on this install's GPUs may use (the policy says
  // which kinds), and a Kinetic Motion clip or poster; checked again once the file's type is known. Else nothing.
  const own = !!accountGpu(account.id) || accountProviders(account.id).length > 0;
  const without: Without | null = own ? null : { hosted: await hostedUploads(account.id), kinetic: request.headers.get(KINETIC_UPLOAD_HEADER) === "1" };
  if (without && !without.hosted && !without.kinetic) return connectFirst();
  // Only a clip or a poster then: refused before a byte is read when it says it is anything else.
  if (without?.kinetic && !without.hosted && !isMultipart(request) && !KINETIC_TYPES.test(declaredType(request.headers.get("content-type"), displayName(request.headers.get("x-file-name"))))) return connectFirst();
  if (!diskHasRoom()) return json(503, { error: ACCOUNT_MESSAGES.diskLow });
  // A fair share: 60 an hour, 300 a day, 2 at once.
  const hour = hit(`up:h:${account.id}`, ACCOUNT_LIMITS.uploadsPerHour, 60 * 60_000);
  const day = hour.ok ? hit(`up:d:${account.id}`, ACCOUNT_LIMITS.uploadsPerDay, 24 * 60 * 60_000) : hour;
  if (!hour.ok || !day.ok) return json(429, { error: ACCOUNT_MESSAGES.uploadRate }, { "Retry-After": String(Math.max(hour.retryAfterS, day.retryAfterS)) });
  const release = enter(`up:${account.id}`, ACCOUNT_LIMITS.uploadsAtOnce);
  if (!release) return json(429, { error: ACCOUNT_MESSAGES.uploadRate }, { "Retry-After": "10" });
  // And a few forms at once from every account together: a form is held in memory. A file sent as it is streams to
  // disk (it holds no memory), so it never waits for other accounts' uploads.
  const multipart = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
  const releaseAll = multipart ? enter("up:accounts", ACCOUNT_LIMITS.uploadsAtOnceAll) : () => {};
  if (!releaseAll) {
    release();
    return json(429, { error: ACCOUNT_MESSAGES.uploadsBusy }, { "Retry-After": "10" });
  }
  try {
    return await accountUploadBody(request, account, without);
  } finally {
    releaseAll();
    release();
  }
}

async function accountUploadBody(request: Request, account: Account, without: Without | null): Promise<Response> {
  const lengthHeader = request.headers.get("content-length");
  const length = lengthHeader === null ? NaN : Number(lengthHeader);
  if (!Number.isFinite(length) || length < 0) return json(411, { error: ACCOUNT_MESSAGES.lengthNeeded });
  const multipart = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
  // A page from before the file was sent as it is: only a small form is read (it is held in memory).
  if (multipart && length > ACCOUNT_LIMITS.multipartBytes) return json(413, { error: ACCOUNT_MESSAGES.reloadToUpload });
  let name = multipart ? undefined : displayName(request.headers.get("x-file-name"));
  const declared = multipart ? null : kindOf(declaredType(request.headers.get("content-type"), name));
  // Refused before a byte is read: over the declared kind's cap, or over the largest cap.
  if (declared && length > KIND_CAP[declared]) return json(413, { error: KIND_MESSAGE[declared] });
  if (length > ACCOUNT_LIMITS.videoBytes) return json(413, { error: ACCOUNT_MESSAGES.videoTooBig });
  const usage = accountUsage(account.id);
  if (usage.uploads + length > ACCOUNT_LIMITS.uploadsBytes) return json(413, { error: ACCOUNT_MESSAGES.uploadsFull });
  if (usage.total + length > accountTotalBytes(account.id)) return json(413, { error: filesFullMessage(account.id) });

  const dest = tempFile();
  let bytes: number;
  let declaredFull = "";
  try {
    if (multipart) {
      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      if (!(file instanceof File)) return json(400, { error: "Choose a file to upload." });
      if (file.size > ACCOUNT_LIMITS.multipartBytes) return json(413, { error: ACCOUNT_MESSAGES.reloadToUpload });
      name = displayName(file.name);
      declaredFull = file.type;
      fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
      bytes = file.size;
    } else {
      declaredFull = request.headers.get("content-type") ?? "";
      // Never more than it said it would send, and never one that stops arriving (it would hold its place for good).
      bytes = await streamTo(request.body, dest, Math.min(length, ACCOUNT_LIMITS.videoBytes), { idleMs: ACCOUNT_LIMITS.uploadIdleMs, totalMs: ACCOUNT_LIMITS.uploadMaxMs });
    }
  } catch (e) {
    fs.rmSync(dest, { force: true });
    if (e instanceof TooBig) return json(413, { error: ACCOUNT_MESSAGES.videoTooBig });
    if (e instanceof Stalled) return json(408, { error: ACCOUNT_MESSAGES.uploadStalled });
    throw e;
  }
  const drop = (status: number, error: string) => {
    fs.rmSync(dest, { force: true });
    return json(status, { error });
  };
  if (!bytes) return drop(400, "Choose a file to upload.");
  // The stored type is the one its bytes say: a page or a script never passes for a picture.
  const head = headOf(dest);
  const sniffed = sniffMedia(head, declaredType(declaredFull, name));
  if (!sniffed) return drop(415, ACCOUNT_MESSAGES.wrongType);
  if (bytes > KIND_CAP[sniffed.kind]) return drop(413, KIND_MESSAGE[sniffed.kind]);
  // Without a GPU or key of its own: a kind its hosted runs take, or a Kinetic Motion clip or poster.
  if (without && !without.hosted?.[sniffed.kind] && !(without.kinetic && KINETIC_TYPES.test(sniffed.contentType))) {
    fs.rmSync(dest, { force: true });
    return connectFirst();
  }
  if (sniffed.kind === "image") {
    const size = imageSize(head);
    if (!size) return drop(415, ACCOUNT_MESSAGES.wrongType);
    if (size.width * size.height > ACCOUNT_LIMITS.imagePixels) return drop(413, ACCOUNT_MESSAGES.imageTooManyPixels);
  }
  const asset = adoptFile({ from: dest, contentType: sniffed.contentType, name, source: "upload", accountId: account.id });
  return json(201, { ...asset });
}
