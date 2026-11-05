import "server-only";
import fs from "node:fs";
import { ACCOUNT_ZIP_MAX_BYTES, ACCOUNT_ZIP_MAX_RUNS } from "@/lib/guest-access";
import { accountById } from "./auth";
import { DATA_DIR, db } from "./db";

/**
 * Public sign-up ("Your GPU"): what an account may keep on this server, and how much. An account's uploads and the
 * files of its runs carry its id (assets.account_id); these numbers cap them, and account-sweep.ts removes them in time.
 * The numbers are defaults the owner can change here.
 */

const MB = 2 ** 20;
const GB = 2 ** 30;
const DAY = 24 * 60 * 60_000;

export const ACCOUNT_LIMITS = {
  /** Picture uploads: PNG, JPEG or WebP, up to this size and 40 megapixels. */
  imageBytes: 25 * MB,
  imagePixels: 40_000_000,
  /** Sound uploads: MP3, WAV, OGG, FLAC, M4A or WebM. */
  audioBytes: 50 * MB,
  /** Clips: MP4, MOV, WebM, MKV or AVI (under ComfyUI's 100 MB default and a free tunnel's 100 MB request limit). */
  videoBytes: 95 * MB,
  /** A multipart upload (an old tab) is read in memory: only this small. */
  multipartBytes: 26 * MB,
  /** Live uploads per account, and all its files (uploads and results). */
  uploadsBytes: 1 * GB,
  totalBytes: 3 * GB,
  /** All its files in its first days: accounts made in bulk can't fill the disk fast. */
  newAccountBytes: 1 * GB,
  newAccountDays: 7,
  /** Uploads: per hour, per day, and at once. */
  uploadsPerHour: 60,
  uploadsPerDay: 300,
  uploadsAtOnce: 2,
  /** Form (multipart) uploads at once from every account together: a form is held in memory. A file sent as it is isn't counted. */
  uploadsAtOnceAll: 8,
  /** An upload ends when nothing arrives for this long, or when it takes longer than this in all (95 MB at about 55 KB/s). */
  uploadIdleMs: 60_000,
  uploadMaxMs: 30 * 60_000,
  /** Retention: uploads (even when a run still names them), and runs with their files. */
  uploadDays: 14,
  runDays: 30,
  /** The disk space the server keeps free, at most (a tenth of a smaller disk; diskFloorBytes): below it, no account uploads or runs. */
  diskFreeBytes: 20 * GB,
  /** Runs: at once (queued or running), per hour, and outputs per run. */
  activeRuns: 4,
  runsPerHour: 60,
  outputsPerRun: 4,
  /** What one run request may weigh (inputs are uploaded first, so a request is only words and file paths). */
  runBodyBytes: 1 * MB,
  /** Outputs kept from one job on the account's ComfyUI, and EXR frames zipped from one export. */
  outputsPerJob: 16,
  framesPerJob: 1800,
  /** How long a job may wait in the account's ComfyUI's queue. */
  queueMs: 30 * 60_000,
  /** GPU address checks and saves, per minute. */
  gpuChecksPerMinute: 10,
  /** Fuobe Soul's finished pictures (the look's grade made in the browser) stored per hour: a run's 4 outputs, 60 runs. */
  finishesPerHour: 240,
  /** 3D models finished on this server (the web GLB, model3d-finish.ts) per hour; past it a model is kept as it came. */
  modelFinishesPerHour: 60,
  /** A zip of its own runs (streamed, nothing written to disk): runs and bytes in one zip, and how long one may sit idle. */
  zipRuns: ACCOUNT_ZIP_MAX_RUNS,
  zipBytes: ACCOUNT_ZIP_MAX_BYTES,
  zipIdleMs: 2 * 60_000,
} as const;

export const RETENTION_MS = { upload: ACCOUNT_LIMITS.uploadDays * DAY, run: ACCOUNT_LIMITS.runDays * DAY };

export const ACCOUNT_MESSAGES = {
  imageTooBig: "That picture is over 25 MB. Save it smaller, then try again.",
  imageTooManyPixels: "That picture is over 40 megapixels. Save it smaller, then try again.",
  audioTooBig: "That sound file is over 50 MB. Trim it, then try again.",
  videoTooBig: "That clip is over 95 MB. Trim it or lower its quality, then try again.",
  fileTooBig: "That file is over 95 MB. Make it smaller, then try again.",
  wrongType: "Fuobe takes PNG, JPEG or WebP pictures, MP4, MOV, WebM, MKV or AVI clips, and MP3, WAV, OGG, FLAC or M4A sound.",
  uploadsFull: "You've used your 1 GB for uploads. Older uploads clear after 14 days, or delete some to make room now.",
  filesFull: "Your files have reached 3 GB. Delete some runs to make room.",
  uploadRate: "That's a lot of uploads at once. Try again in a few minutes.",
  uploadsBusy: "Lots of uploads right now. Try again in a moment.",
  uploadStalled: "The upload stopped arriving. Check your connection, then try again.",
  diskLow: "Uploads are paused for a moment. Please try again shortly.",
  activeRuns: "You have 4 runs going. Start the next one when one finishes.",
  runRate: "That's a lot of runs this hour. Try again later.",
  finishRate: "That's a lot of finished pictures this hour. Try again later.",
  finishBusy: "Your last pictures are still being saved. Try again in a moment.",
  outputsCapped: "Each run makes up to 4 results.",
  bodyTooBig: "That's too large to send. Try a smaller file.",
  gpuChecks: "Give it a minute, then check again.",
  probeRate: "Too many clip checks at once. Wait a moment, then try again.",
  reloadToUpload: "Reload the page, then upload again.",
  lengthNeeded: "That upload didn't go through. Please try again.",
  zipTooMany: `Download up to ${ACCOUNT_ZIP_MAX_RUNS} at a time.`,
  zipTooBig: "That's over 1 GB. Download fewer items at a time.",
  zipBusy: "Your last download is still going. Try again when it finishes.",
} as const;

/** What an account may keep in all: 3 GB, or 1 GB in its first 7 days (`created`: when it signed up, when known). */
export function accountTotalBytes(id: string, created = accountById(id)?.createdAt ?? 0): number {
  return Date.now() - created < ACCOUNT_LIMITS.newAccountDays * DAY ? ACCOUNT_LIMITS.newAccountBytes : ACCOUNT_LIMITS.totalBytes;
}

/** What an account is told when its files are full. */
export function filesFullMessage(id: string): string {
  return accountTotalBytes(id) < ACCOUNT_LIMITS.totalBytes
    ? "Your files have reached 1 GB. A new account keeps up to 1 GB in its first 7 days, then 3 GB. Delete some runs to make room."
    : ACCOUNT_MESSAGES.filesFull;
}

/** What an account stores: all its files, its uploads, and how many uploads. */
export function accountUsage(id: string): { total: number; uploads: number; uploadCount: number } {
  const r = db()
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS total, COALESCE(SUM(CASE WHEN source = 'upload' THEN size ELSE 0 END), 0) AS uploads,
       COALESCE(SUM(CASE WHEN source = 'upload' THEN 1 ELSE 0 END), 0) AS uploadCount FROM assets WHERE account_id = ?`,
    )
    .get(id) as { total: number; uploads: number; uploadCount: number };
  return { total: Number(r.total), uploads: Number(r.uploads), uploadCount: Number(r.uploadCount) };
}

declare global {
  /** Tests only: the free disk space and the disk's size to report. */
  var __fuobeTestDiskFree: number | undefined;
  var __fuobeTestDiskSize: number | undefined;
  /** When the owner was last told that accounts are refused for space. */
  var __fuobeDiskLowWarned: number | undefined;
}

/** The data disk's free space and size (Infinity when they can't be read: the check never blocks by mistake). */
function diskSpace(): { free: number; size: number } {
  if (process.env.VITEST === "true" && typeof globalThis.__fuobeTestDiskFree === "number") return { free: globalThis.__fuobeTestDiskFree, size: globalThis.__fuobeTestDiskSize ?? Infinity };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const s = fs.statfsSync(DATA_DIR);
    return { free: Number(s.bavail) * Number(s.bsize), size: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return { free: Infinity, size: Infinity };
  }
}

/** Free space on the disk that holds the data folder. */
export const diskFreeBytes = (): number => diskSpace().free;

/**
 * The free space accounts never use: FUOBE_ACCOUNT_DISK_FREE_GB when it is set, else 20 GB or a tenth of the disk,
 * whichever is less, and at least 2 GB (a small server keeps a share of its own disk, not a fixed 20 GB).
 */
export function diskFloorBytes(size = diskSpace().size): number {
  const set = process.env.FUOBE_ACCOUNT_DISK_FREE_GB?.trim();
  if (set && Number.isFinite(Number(set)) && Number(set) >= 0) return Number(set) * GB;
  return Math.max(2 * GB, Math.min(ACCOUNT_LIMITS.diskFreeBytes, size / 10));
}

/**
 * What all accounts together may keep: FUOBE_ACCOUNTS_DISK_GB when it is set, else a quarter of the data disk. The rest
 * stays the owner's (and the other sites' on a shared server), however many accounts sign up.
 */
export function accountsMaxBytes(size = diskSpace().size): number {
  const set = process.env.FUOBE_ACCOUNTS_DISK_GB?.trim();
  if (set && Number.isFinite(Number(set)) && Number(set) >= 0) return Number(set) * GB;
  return size / 4;
}

/** What every account's files weigh together. */
function accountsBytes(): number {
  const r = db().prepare("SELECT COALESCE(SUM(size), 0) AS n FROM assets WHERE account_id IS NOT NULL").get() as { n: number };
  return Number(r.n);
}

/**
 * Whether the server has room for an account's upload or run: the disk keeps its free floor, and all accounts together
 * stay under their share (accountsMaxBytes). When it hasn't, the server log says so once an hour.
 */
export function diskHasRoom(): boolean {
  const { free, size } = diskSpace();
  const floor = diskFloorBytes(size);
  const max = accountsMaxBytes(size);
  const used = accountsBytes();
  if (free >= floor && used < max) return true;
  if (Date.now() - (globalThis.__fuobeDiskLowWarned ?? 0) > 60 * 60_000) {
    globalThis.__fuobeDiskLowWarned = Date.now();
    console.warn(
      free < floor
        ? `[fuobe] Accounts can't upload or run now: the data disk has ${(free / GB).toFixed(1)} GB free, and ${(floor / GB).toFixed(1)} GB is kept free (FUOBE_ACCOUNT_DISK_FREE_GB sets it).`
        : `[fuobe] Accounts can't upload or run now: their files take ${(used / GB).toFixed(1)} GB, their share of the disk (FUOBE_ACCOUNTS_DISK_GB sets it).`,
    );
  }
  return false;
}

/**
 * The most a run on an account's GPU sends of one stored file (its own results too): what an upload of its kind may
 * be (a picture 25 MB, sound 50 MB, a clip 95 MB; anything else as a clip). Each file sent is held in memory a few times.
 */
export function accountInputLimit(contentType: string): { bytes: number; message: string } {
  const t = contentType.split(";")[0].trim().toLowerCase();
  if (t.startsWith("image/")) return { bytes: ACCOUNT_LIMITS.imageBytes, message: ACCOUNT_MESSAGES.imageTooBig };
  if (t.startsWith("audio/")) return { bytes: ACCOUNT_LIMITS.audioBytes, message: ACCOUNT_MESSAGES.audioTooBig };
  if (t.startsWith("video/")) return { bytes: ACCOUNT_LIMITS.videoBytes, message: ACCOUNT_MESSAGES.videoTooBig };
  return { bytes: ACCOUNT_LIMITS.videoBytes, message: ACCOUNT_MESSAGES.fileTooBig };
}

// ---------------------------------------------------------------------------
// When an account is deleted

declare global {
  var __fuobeAccountDeleted: ((id: string) => void | Promise<void>)[] | undefined;
}

/** Work to do when an account is deleted, after its runs and files are gone (other features register theirs here). */
export function onAccountDeleted(hook: (id: string) => void | Promise<void>): void {
  const hooks = (globalThis.__fuobeAccountDeleted ??= []);
  if (!hooks.includes(hook)) hooks.push(hook);
}

export async function runAccountDeletedHooks(id: string): Promise<void> {
  for (const hook of globalThis.__fuobeAccountDeleted ?? []) {
    try {
      await hook(id);
    } catch (e) {
      console.warn(`[fuobe] cleanup for a deleted account failed: ${(e as Error).message}`);
    }
  }
}
