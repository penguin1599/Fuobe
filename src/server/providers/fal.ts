import "server-only";
import fs from "node:fs";
import { createFalClient } from "@fal-ai/client";
import { loraEndpointFor, routeLoraField } from "@/lib/catalog/loras";
import { buildPayload, extractOutputs, noOutputsError } from "@/lib/catalog/payload";
import { accountKeyError, balanceRefusal, cloudKey, missingKeyError, originOf, redactKey, standIn } from "../provider-keys";
import { tenant, tenantAccount } from "../tenant";
import { unzip } from "../unzip";
import { ACCOUNT_MESSAGES, accountTotalBytes, accountUsage, diskHasRoom, filesFullMessage } from "../account-files";
import { discardBody, fetchPublic, RemoteFetchError } from "../remote-fetch";
import { newScratchOutput } from "../storage";
import type { FieldMap } from "@/lib/catalog/types";
import { ProviderError, type ProviderAdapter } from "./types";

/**
 * fal.ai queue API.
 *   submit: POST https://queue.fal.run/<endpoint>            → { request_id, status_url, response_url, cancel_url }
 *   status: GET  <status_url>?logs=1                          → { status: IN_QUEUE | IN_PROGRESS | COMPLETED, logs }
 *   result: GET  <response_url>                               → model output (or { detail } on failure)
 *   cancel: PUT  <cancel_url>
 * We always use the URLs returned at submit time: for nested endpoint ids
 * (fal-ai/kling-video/v2.5-turbo/pro/image-to-video) the status/result paths drop the sub-path.
 *
 * The key is the run's own (provider-keys.ts cloudKey: an account's run sends its own key, never the studio's), and it
 * goes to fal.ai's own hosts only.
 */
const QUEUE = "https://queue.fal.run";
const REST = "https://rest.fal.ai";
/** fal.ai's synchronous runs: a song tool's song sent first through the provider's files/upload (Mureka's), which answers at once. */
const RUN = "https://fal.run";

/** fal.ai's queue: the real one, or a stand-in on this machine in tests and `next dev` (provider-keys.ts standIn). */
export const falQueue = () => standIn("fal") ?? QUEUE;

/** Where a fal.ai key may go: the queue and the REST API (storage uploads), or the stand-in. */
function keyOrigin(url: string): boolean {
  const o = originOf(url);
  return o === QUEUE || o === REST || o === RUN || (!!o && o === standIn("fal"));
}

/** A synchronous fal.ai run: the real one, or the stand-in in tests and `next dev`. */
const falRun = () => standIn("fal") ?? RUN;

/**
 * A song tool's song that isn't one of the provider's own, sent first through its files/upload (FieldMap.songSource: Mureka's,
 * $0.01, priced as Pricing.uploadUsd): the id the tool then takes.
 */
async function uploadSong(upload: { endpoint: string; purpose: string }, fileUrl: string): Promise<string> {
  const res = (await falFetch(`${falRun()}/${upload.endpoint}`, { method: "POST", body: JSON.stringify({ file_url: fileUrl, purpose: upload.purpose }) })) as { id?: unknown };
  if (typeof res?.id !== "string" || !res.id) throw new ProviderError("The song couldn't be sent to Mureka: try again");
  return res.id;
}

/** The most a stems download may be, and how long it may take: past either, it stops and the run fails. */
const STEMS_MAX_BYTES = 256 * 1024 * 1024;
const STEMS_WAIT_MS = 3 * 60 * 1000;

/** A download read with a byte count: past `max` bytes (declared or streamed) it stops at once, never held whole. */
async function bytesWithin(res: Response, max: number): Promise<Buffer> {
  const tooBig = () => new Error("The stems download is larger than Fuobe keeps from one result");
  if (Number(res.headers.get("content-length")) > max) {
    res.body?.cancel().catch(() => {});
    throw tooBig();
  }
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** An account's stems: a smaller zip and less unpacked than the owner's, and never more than its files have room for. */
const ACCOUNT_STEMS_MAX_BYTES = 128 * 1024 * 1024;
const ACCOUNT_STEMS_UNPACKED_BYTES = 256 * 1024 * 1024;

/**
 * The stems a song tool answers with in one zip (Mureka's zip_url), one result each, named by their file (meta.stem).
 * Each stem is written to the scratch folder as it is unpacked (a `scratch:` result, moved into the run's files when it
 * is saved), never held as a data: URL. An account's zip comes from public addresses only (fetchPublic), within what its
 * files have room for.
 */
export async function stemsFromZip(
  zipUrl: string,
  limits: { maxBytes?: number; waitMs?: number } = {},
): Promise<{ url: string; kind: "audio"; contentType: string; meta: { stem: string } }[]> {
  const account = tenantAccount();
  let maxBytes = limits.maxBytes ?? (account ? ACCOUNT_STEMS_MAX_BYTES : STEMS_MAX_BYTES);
  let unpacked = account ? ACCOUNT_STEMS_UNPACKED_BYTES : 2 * maxBytes;
  let left = Infinity;
  if (account) {
    left = accountTotalBytes(account) - accountUsage(account).total;
    if (left <= 0) throw new Error(filesFullMessage(account));
    if (!diskHasRoom()) throw new Error(ACCOUNT_MESSAGES.diskLow);
    maxBytes = Math.min(maxBytes, left);
    unpacked = Math.min(unpacked, left);
  }
  const waitMs = limits.waitMs ?? STEMS_WAIT_MS;
  const tooBig = () => new Error(account && left <= maxBytes ? filesFullMessage(account) : "The stems download is larger than Fuobe keeps from one result");
  let zipped: Buffer;
  try {
    // The stand-in fal.ai (tests and `next dev`) is on this machine: only it skips the public-address check.
    const res =
      account && originOf(zipUrl) !== standIn("fal")
        ? await fetchPublic(zipUrl, {}, { maxBytes, deadlineMs: waitMs, timeoutMs: Math.min(waitMs, 60_000) })
        : await fetch(zipUrl, { signal: AbortSignal.timeout(waitMs) });
    if (!res.ok) {
      discardBody(res);
      throw new Error(`The stems couldn't be downloaded (${res.status})`);
    }
    zipped = await bytesWithin(res, maxBytes);
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error("The stems took too long to download. Try again.");
    if (err instanceof RemoteFetchError && /took over|Timed out/.test(err.message)) throw new Error("The stems took too long to download. Try again.");
    if (err instanceof RemoteFetchError && /^The answer was over/.test(err.message)) throw tooBig();
    if (/^The stems download is larger/.test(err.message)) throw tooBig();
    throw e;
  }
  const outputs: { url: string; kind: "audio"; contentType: string; meta: { stem: string } }[] = [];
  const written: string[] = [];
  try {
    await unzip(zipped, {
      maxBytes: unpacked,
      only: (name) => AUDIO_FILE.test(name),
      onEntry: (name, data) => {
        const ext = AUDIO_FILE.exec(name)![1].toLowerCase();
        const contentType = AUDIO_TYPES[ext] ?? "audio/mpeg";
        const stem = name.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().toLowerCase();
        const out = newScratchOutput(ext);
        written.push(out.file);
        fs.writeFileSync(out.file, data);
        outputs.push({ url: out.url, kind: "audio", contentType, meta: { stem } });
      },
    });
  } catch (e) {
    for (const f of written) fs.rmSync(f, { force: true });
    if (account && left <= unpacked && /more than Fuobe keeps/.test((e as Error).message)) throw new Error(filesFullMessage(account));
    throw e;
  }
  if (!outputs.length) throw new Error("The stems archive held no audio");
  return outputs;
}

const AUDIO_FILE = /\.(mp3|wav|flac|m4a|ogg)$/i;
const AUDIO_TYPES: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", ogg: "audio/ogg" };

function key(): string {
  return cloudKey("fal");
}

export async function falFetch(url: string, init: RequestInit = {}): Promise<unknown> {
  const k = key();
  if (!k && tenant()) throw missingKeyError("fal");
  // A status, result or cancel address is the one fal.ai gave at submit: the key goes to fal.ai's own hosts only.
  if (!keyOrigin(url)) throw new ProviderError("fal.ai gave an address outside fal.ai, so Fuobe didn't send the key there");
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${k}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    // A provider's error may echo the request: the key never reaches a message, a row or a log.
    const said = redactKey(`fal ${res.status}: ${describeError(body)}`, k);
    throw accountKeyError("fal", res.status, said, k) ?? new ProviderError(said, res.status);
  }
  return body;
}

/**
 * The fal client's requests. The client adds the key on calls to fal.ai's REST API only (a file's upload address gets
 * none); this keeps it so. In tests and `next dev` the REST API is the stand-in.
 */
const clientFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const local = standIn("fal");
  const target = local && url.startsWith(REST) ? local + url.slice(REST.length) : url;
  const headers = new Headers(init?.headers);
  if (!keyOrigin(target)) headers.delete("authorization");
  return fetch(target, { ...init, headers });
};

function describeError(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500);
  const b = body as { detail?: unknown; error?: unknown; message?: unknown };
  const d = b.detail ?? b.error ?? b.message ?? body;
  if (Array.isArray(d)) {
    return d
      .map((e: { loc?: unknown[]; msg?: string }) => `${(e.loc ?? []).join(".")}: ${e.msg ?? JSON.stringify(e)}`)
      .join("; ");
  }
  return typeof d === "string" ? d : JSON.stringify(d).slice(0, 500);
}

/** A plain file name with an extension to upload under ("x.safetensors", "dataset.zip"), or undefined. */
function fileName(name: string | undefined): string | undefined {
  const base = name?.split(/[\\/]/).pop()?.trim();
  return base && /^[\w.\-()[\] ]{1,200}\.[A-Za-z0-9]{1,12}$/.test(base) && !base.startsWith(".") ? base : undefined;
}

/** How long the clone step of a two-step voice may take (it is a few seconds of work on fal). */
const CLONE_WAIT_MS = 3 * 60 * 1000;

/**
 * Step 1 of a two-step voice (FieldMap.cloneFirst): the sample (and what it says) to the clone endpoint, waited for on its
 * queue, and the URL of the file it returns (Qwen3-TTS's speaker_embedding safetensors).
 */
export async function cloneVoice(cf: NonNullable<FieldMap["cloneFirst"]>, audio: string, transcript?: string, waitMs = CLONE_WAIT_MS): Promise<string> {
  const body = { [cf.audio]: audio, ...(cf.text && transcript?.trim() && { [cf.text]: transcript.trim() }) };
  const job = (await falFetch(`${falQueue()}/${cf.endpoint}`, { method: "POST", body: JSON.stringify(body) })) as { status_url: string; response_url: string };
  const until = Date.now() + waitMs;
  for (let wait = 500; ; wait = Math.min(wait * 1.5, 3000)) {
    const st = (await falFetch(job.status_url)) as { status?: string; error?: string };
    if (st.status === "COMPLETED") {
      if (st.error) throw new ProviderError(`Couldn't clone the voice: ${st.error}`);
      break;
    }
    if (Date.now() + wait > until) throw new ProviderError("Cloning the voice took too long. Try again.");
    await new Promise((r) => setTimeout(r, wait));
  }
  const result = (await falFetch(job.response_url)) as Record<string, unknown>;
  const file = result?.[cf.output] as { url?: unknown } | string | undefined;
  const url = typeof file === "string" ? file : typeof file?.url === "string" ? file.url : undefined;
  if (!url) throw new ProviderError("Couldn't clone the voice: the sample gave no voice back. Try a longer, cleaner sample.");
  return url;
}

export const falProvider: ProviderAdapter = {
  id: "fal",
  label: "fal.ai",
  isConfigured: () => !!key(),

  async prepareFile(data, contentType, name) {
    // Always a key as a string ("" too): left out, the fal client would take FAL_KEY from the environment.
    const k = key();
    if (!k && tenant()) throw missingKeyError("fal");
    const client = createFalClient({ credentials: k, fetch: clientFetch, suppressLocalCredentialsWarning: true });
    // The file keeps its name (and so its extension): an unnamed blob is stored as "<time>.<subtype>", and
    // a LoRA mirrored as application/octet-stream would land at ….octet, which loaders that go by the
    // extension (fal's LTX-2.3 quality takes only .safetensors URLs) refuse.
    const blob = fileName(name) ? new File([new Uint8Array(data)], fileName(name)!, { type: contentType }) : new Blob([new Uint8Array(data)], { type: contentType });
    try {
      return await client.storage.upload(blob);
    } catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      const said = redactKey(`fal ${status || "upload"}: ${(e as Error).message}`, k);
      throw accountKeyError("fal", status, said, k) ?? new ProviderError(said, status || undefined);
    }
  },

  async submit({ route, input }) {
    // A voice sample the endpoint can't take is cloned first (Qwen3-TTS: clone-voice makes an embedding file, which the
    // text-to-speech call speaks with). A saved voice that already has its file skips the clone (src/server/voices.ts).
    const cf = route.map?.cloneFirst;
    let embedding: string | undefined;
    if (cf && input.voiceAudio && !input.voiceEmbedding) {
      embedding = await cloneVoice(cf, input.voiceAudio, input.voiceTranscript);
      input = { ...input, voiceEmbedding: embedding };
    }
    // LoRAs (trained identities, a recipe's looks and motions) go in the route's LoRA field (FieldMap.loras:
    // `transformer` per file on Wan 2.2, `weight_name`, at most the API's maximum) and switch to its LoRA endpoint.
    const map = { ...route.map, loras: routeLoraField(route) };
    const payload = buildPayload(map, input);
    // A song tool's song that isn't one of the provider's own goes up first (Mureka's files/upload).
    const song = map.songSource;
    if (song && payload[song.songId] === undefined) {
      if (!input.audio) throw new ProviderError("Add the song");
      payload[song.uploadId] = await uploadSong(song.upload, input.audio);
    }
    let endpoint: string;
    try {
      endpoint = loraEndpointFor({ ...route, map }, input.loras);
    } catch (e) {
      throw new ProviderError((e as Error).message);
    }
    const res = (await falFetch(`${falQueue()}/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(payload),
    })) as { request_id: string; status_url: string; response_url: string; cancel_url: string };
    return {
      externalId: res.request_id,
      meta: { statusUrl: res.status_url, responseUrl: res.response_url, cancelUrl: res.cancel_url, ...(embedding && { voiceEmbedding: embedding }) },
      payload,
    };
  },

  async poll({ meta, route }) {
    const status = (await falFetch(`${meta.statusUrl as string}?logs=1`)) as {
      status: string;
      queue_position?: number;
      logs?: { message: string }[];
      error?: string;
    };
    if (status.status === "IN_QUEUE") {
      return { state: "queued", message: status.queue_position != null ? `In queue · position ${status.queue_position + 1}` : "In queue" };
    }
    if (status.status === "IN_PROGRESS") {
      const last = status.logs?.at(-1)?.message;
      const pct = last ? /(\d{1,3})%/.exec(last)?.[1] : undefined;
      return { state: "running", progress: pct ? Number(pct) / 100 : undefined, message: last ?? "Generating" };
    }
    if (status.status === "COMPLETED") {
      if (status.error) return { state: "failed", error: status.error };
      try {
        const result = await falFetch(meta.responseUrl as string);
        // A song's stems come back as one zip (Mureka): each track becomes a result of its own.
        const zipUrl = route?.op === "song-stems" ? (result as { zip_url?: unknown })?.zip_url : undefined;
        if (typeof zipUrl === "string" && zipUrl) return { state: "succeeded", outputs: await stemsFromZip(zipUrl) };
        // Layers, text blocks, transcripts, 3D models and stems keep their structure (OutputFile.meta / text).
        const outputs = extractOutputs(result, route?.op);
        if (!outputs.length) return { state: "failed", error: noOutputsError(result) };
        // Seedance draft mode: keep the id that finishes this take at 1080p.
        const draftId = /"draft_id"\s*:\s*"([^"]+)"/.exec(JSON.stringify(result))?.[1];
        return { state: "succeeded", outputs: draftId ? outputs.map((o) => ({ ...o, draftId })) : outputs };
      } catch (e) {
        // An account's finished (and paid) job isn't failed for a passing problem collecting it (busy, down, no answer):
        // the runner asks again with a growing wait (generations.ts healPoll).
        const s = (e as { status?: number }).status;
        if (tenantAccount() && e instanceof ProviderError && (s === 429 || (s !== undefined && s >= 500) || (s === undefined && /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/i.test(e.message)))) throw e;
        if (tenantAccount() && e instanceof TypeError && /fetch failed/i.test(e.message)) throw e;
        return { state: "failed", error: (e as Error).message };
      }
    }
    return { state: "running", message: status.status };
  },

  async cancel({ meta }) {
    if (meta.cancelUrl) await falFetch(meta.cancelUrl as string, { method: "PUT" }).catch(() => {});
  },

  async test() {
    const { ok, detail } = await testFalKey(key());
    return { ok, detail };
  },
};

/**
 * What a key check found: accepted, refused by the provider, a key that works on an account with no balance left, the
 * provider out of reach, or an answer that says nothing.
 */
export type KeyCheck = { ok: true; detail: string } | { ok: false; detail: string; reason: "rejected" | "balance" | "unreachable" | "odd"; status?: number };

/**
 * Check a fal.ai key, and only that key (Settings' "Save & test", an account's Your keys): the status of a request that
 * doesn't exist. Free, and nothing runs: 401/403 means a bad key (or, saying so, an empty balance), 404/422 a key that
 * works. The path is the app's (fal-ai/flux), as fal.ai's status paths are: with an endpoint's sub-path
 * (fal-ai/flux/dev) fal.ai answers 405 to every key.
 */
export async function testFalKey(k: string): Promise<KeyCheck> {
  if (!k) return { ok: false, detail: "No key set", reason: "rejected" };
  let res: Response;
  try {
    res = await fetch(`${falQueue()}/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status`, {
      headers: { Authorization: `Key ${k}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, detail: redactKey(`Can't reach fal.ai (${(e as Error).message})`, k), reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 402 || res.status === 403) {
    const text = await res.text().catch(() => "");
    if (balanceRefusal(res.status, text)) return { ok: false, detail: "Key works, but the fal.ai balance is empty: top it up on fal.ai", reason: "balance", status: res.status };
    return { ok: false, detail: `Key rejected (${res.status})`, reason: "rejected", status: res.status };
  }
  if (res.ok || [400, 404, 422].includes(res.status)) return { ok: true, detail: "Key accepted" };
  // A proxy or an outage (405, 407, 5xx) says nothing about the key: don't call it accepted.
  return { ok: false, detail: `Couldn't check the key: fal.ai answered ${res.status}. Try again in a moment`, reason: "odd", status: res.status };
}
