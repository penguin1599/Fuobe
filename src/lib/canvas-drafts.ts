/**
 * A visitor's canvases kept in this browser (localStorage): a guest's boards, and an account's before it saves them to
 * its account. Nothing here reaches the server. Each draft is its own key, with a small index for the list; storage
 * that is full, blocked or missing (a private window) reads as no drafts and refuses a save with a plain message.
 */
import type { CanvasPage } from "@/lib/catalog/canvas-board";

export interface CanvasDraft {
  id: string;
  name: string;
  templateId: string | null;
  pages: CanvasPage[];
  createdAt: number;
  updatedAt: number;
}

export interface DraftSummary {
  id: string;
  name: string;
  templateId: string | null;
  nodeCount: number;
  updatedAt: number;
}

/** Drafts this browser keeps; the oldest goes when a new one would pass it. */
export const MAX_DRAFTS = 20;
const INDEX = "fuobe.canvas.drafts";
const KEY = (id: string) => `fuobe.canvas.draft.${id}`;
/** Said when this browser won't keep it (full, or storage is off). */
export const DRAFT_STORAGE_MESSAGE = "This browser couldn't keep your board. Free some space or allow site data, or create a free account to save it.";
export const DRAFT_EVENT = "fuobe:canvas-drafts";

const ID = /^[A-Za-z0-9_-]{6,40}$/;
export const isDraftId = (id: string) => ID.test(id);

export function newDraftId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return `d${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14)}`;
}

function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readIndex(): DraftSummary[] {
  try {
    const raw = store()?.getItem(INDEX);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((d): d is DraftSummary => !!d && typeof d === "object" && isDraftId((d as DraftSummary).id)) : [];
  } catch {
    return [];
  }
}

/** This browser's drafts, newest first. */
export function listDrafts(): DraftSummary[] {
  return readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A draft's name as last kept (the list may rename it while the board is open), or null. */
export function draftName(id: string): string | null {
  return readIndex().find((d) => d.id === id)?.name ?? null;
}

export function getDraft(id: string): CanvasDraft | null {
  if (!isDraftId(id)) return null;
  try {
    const raw = store()?.getItem(KEY(id));
    if (!raw) return null;
    const d = JSON.parse(raw) as CanvasDraft;
    return d && Array.isArray(d.pages) && d.pages.length ? { ...d, id } : null;
  } catch {
    return null;
  }
}

const summary = (d: CanvasDraft): DraftSummary => ({
  id: d.id,
  name: d.name,
  templateId: d.templateId,
  nodeCount: d.pages.reduce((n, p) => n + (p.graph?.nodes?.length ?? 0), 0),
  updatedAt: d.updatedAt,
});

const changed = () => {
  try {
    window.dispatchEvent(new Event(DRAFT_EVENT));
  } catch {
    // No window (tests): nothing listens.
  }
};

/** Keeps a draft (new or changed). Throws DRAFT_STORAGE_MESSAGE when this browser won't keep it. */
export function putDraft(d: CanvasDraft): void {
  const s = store();
  if (!s || !isDraftId(d.id)) throw new Error(DRAFT_STORAGE_MESSAGE);
  const index = readIndex().filter((x) => x.id !== d.id);
  // The oldest drafts make room for this one.
  const keep = index.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DRAFTS - 1);
  const dropped = index.filter((x) => !keep.includes(x));
  try {
    s.setItem(KEY(d.id), JSON.stringify(d));
    s.setItem(INDEX, JSON.stringify([summary(d), ...keep]));
  } catch {
    throw new Error(DRAFT_STORAGE_MESSAGE);
  }
  for (const x of dropped) {
    try {
      s.removeItem(KEY(x.id));
    } catch {
      // Left behind: the index no longer lists it.
    }
  }
  changed();
}

export function deleteDraft(id: string): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(KEY(id));
    s.setItem(INDEX, JSON.stringify(readIndex().filter((x) => x.id !== id)));
  } catch {
    // Storage is off: there was nothing to delete.
  }
  changed();
}
