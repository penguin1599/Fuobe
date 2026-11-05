import { useIsOwner } from "@/lib/api";

/**
 * The largest clip a signed-in account uploads (src/server/account-files.ts ACCOUNT_LIMITS.videoBytes: under ComfyUI's
 * default and a free tunnel's 100 MB).
 */
export const ACCOUNT_CLIP_BYTES = 95 * 1024 * 1024;

/**
 * The largest clip an upload box takes from whoever is looking: the tool's own limit for the studio's owner, an
 * account's for anyone else (a guest uploads once signed up, as an account). What the box says and checks before a byte
 * is sent, so a clip the upload would refuse is never sent.
 */
export function useClipLimit(toolMax: number): number {
  return useIsOwner() ? toolMax : Math.min(toolMax, ACCOUNT_CLIP_BYTES);
}

/** A limit in whole MB, as the boxes say it. */
export const limitMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
