"use client";

import { useCallback, useEffect, useRef } from "react";
import { useAskBeforeUpload, useStatus, useViewer, type RefusalAction } from "@/lib/api";

/** Whether who is looking is known well enough to ask first: a guest, the owner, or an account with its GPU and keys read. */
export function viewerKnown(v: { owner: boolean; account?: unknown } | undefined, viewerFailed: boolean, statusRead: boolean): boolean {
  if (viewerFailed) return true;
  if (!v) return false;
  return v.owner || !v.account || statusRead;
}

/**
 * Ask first, then act: a guest gets "Create a free account" and an account with neither its own GPU nor its own key
 * "Connect your GPU" (useAskBeforeUpload), anyone else `then`. A press made before the page knows who is looking waits
 * for that (a guest's early press opens the sign-up card, never the form), then goes the same way. Only for actions a
 * browser lets run a moment later (a dialog, a run), not a file chooser.
 */
export function useAskFirst(): (then: () => void, action?: RefusalAction) => void {
  const ask = useAskBeforeUpload();
  const viewer = useViewer();
  const status = useStatus();
  const known = viewerKnown(viewer.data, viewer.isError, !!status.data || status.isError);
  const waiting = useRef<{ then: () => void; action: RefusalAction } | null>(null);
  useEffect(() => {
    const w = waiting.current;
    if (!known || !w) return;
    waiting.current = null;
    if (!ask(w.action)) w.then();
  }, [known, ask]);
  return useCallback(
    (then: () => void, action: RefusalAction = "upload") => {
      if (!known) {
        waiting.current = { then, action };
        return;
      }
      if (!ask(action)) then();
    },
    [known, ask],
  );
}
