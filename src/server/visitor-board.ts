import "server-only";
import { cleanGraph, EMPTY_GRAPH, getTemplate, isGenerator, outputType, type CanvasGraph } from "@/lib/catalog/canvas";
import { FIRST_PAGE_ID, pageName, type CanvasPage } from "@/lib/catalog/canvas-board";
import { shownTo } from "@/lib/canvas-sections";
import { templateDetail, templateIds } from "@/lib/canvas-template-cards";
import { templateCover } from "@/lib/template-covers";
import { fillSamples } from "./canvas-samples";

/** "Start blank": the one board that isn't a template. */
export const BLANK_BOARD = "blank";

/** The result a ready board shows on its last step before anyone runs it: the template's own published example. */
export interface BoardExample {
  nodeId: string;
  kind: "image" | "video";
  url: string;
  poster: string;
}

/** A board as a visitor opens it in the editor: nothing stored yet, its files Fuobe's own published examples. */
export interface VisitorBoard {
  name: string;
  templateId: string | null;
  pages: CanvasPage[];
  example?: BoardExample;
  /** The Video effect that makes the same in one step (an effect film's), for a visitor's Run. */
  oneStep?: { href: string; label: string };
}

const hasCover = (id: string) => !!templateCover("canvas", id);

/** The ready boards a visitor may open in the editor (the ones whose card they see), and "blank". */
export function visitorBoardIds(): string[] {
  // The same rule as the cards a visitor's /canvas shows (shownTo).
  return [BLANK_BOARD, ...templateIds().filter((id) => visible(id))];
}

function visible(id: string): boolean {
  const d = templateDetail(id);
  return !!d && shownTo(d, { visitor: true, hasCover });
}

/**
 * The last step that makes the board's film (or picture): the generator whose result is the board's example. A board's
 * nodes are built in order, so the last generator of that kind is the one at the end of the chain.
 */
function exampleNode(graph: CanvasGraph, kind: "image" | "video"): string | undefined {
  return graph.nodes.filter((n) => isGenerator(n) && outputType(graph, n) === kind).at(-1)?.id;
}

/**
 * A board for a visitor's editor: a ready board (the open-source variant, as a visitor's studio runs it) with its
 * starting files as Fuobe's published example paths (never a copy in anyone's storage), or a blank one. Null for a
 * board a visitor doesn't see (no real cover yet, or not a ready board).
 */
export function visitorBoard(id: string): VisitorBoard | null {
  if (id === BLANK_BOARD) return { name: "Untitled canvas", templateId: null, pages: [{ id: FIRST_PAGE_ID, name: pageName(0), graph: EMPTY_GRAPH }] };
  const t = getTemplate(id);
  const detail = templateDetail(id);
  if (!t || !detail || !visible(id)) return null;
  const graph = cleanGraph(fillSamples(t.build("open"), t.samples, false));
  const cover = templateCover("canvas", id);
  const kind = cover?.video ? "video" : "image";
  const nodeId = cover && exampleNode(graph, kind);
  return {
    name: t.name,
    templateId: t.id,
    pages: [{ id: FIRST_PAGE_ID, name: pageName(0), graph }],
    ...(cover && nodeId && { example: { nodeId, kind, url: cover.video ?? cover.poster, poster: cover.poster } }),
    ...(detail.oneStep && { oneStep: detail.oneStep }),
  };
}

/** Each ready board's example and one-step effect, by template id: a saved board shows them as its ready board did. */
export function boardExtras(): Record<string, Pick<VisitorBoard, "example" | "oneStep">> {
  const out: Record<string, Pick<VisitorBoard, "example" | "oneStep">> = {};
  for (const id of visitorBoardIds()) {
    const b = id === BLANK_BOARD ? null : visitorBoard(id);
    if (b && (b.example || b.oneStep)) out[id] = { ...(b.example && { example: b.example }), ...(b.oneStep && { oneStep: b.oneStep }) };
  }
  return out;
}
