import "server-only";
import { ACCOUNT_LIMITS } from "./account-files";

/**
 * One zip at a time per signed-in account (/api/generations/zip): a zip is streamed from the files on disk, so it
 * holds no memory or disk, but each one keeps a file open and the server sending. A zip counts as going while its
 * reader keeps pulling: it ends when the zip is sent, the download is stopped, or nothing is pulled for
 * ACCOUNT_LIMITS.zipIdleMs (a stalled download never locks the account out).
 */

interface Going {
  touched: number;
}

declare global {
  var __fuobeAccountZips: Map<string, Going> | undefined;
}

const going = (): Map<string, Going> => (globalThis.__fuobeAccountZips ??= new Map());

/** Whether this account has a zip going now. */
export function accountZipBusy(account: string, now = Date.now()): boolean {
  const g = going().get(account);
  return !!g && now - g.touched < ACCOUNT_LIMITS.zipIdleMs;
}

/**
 * Send `stream` as this account's one zip: null when it has one going. The stream returned marks the zip as going
 * while it is read, and frees the account when it ends, fails or is cancelled.
 */
export function accountZipStream(account: string, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> | null {
  if (accountZipBusy(account)) return null;
  const mine: Going = { touched: Date.now() };
  going().set(account, mine);
  // A later zip may take the place of a stalled one: only this zip's own entry is removed.
  const done = () => {
    if (going().get(account) === mine) going().delete(account);
  };
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      mine.touched = Date.now();
      try {
        const r = await reader.read();
        if (r.done) {
          done();
          controller.close();
        } else controller.enqueue(r.value);
      } catch (e) {
        done();
        controller.error(e);
      }
    },
    async cancel(reason) {
      done();
      await reader.cancel(reason);
    },
  });
}
