"use client";

import { AlertCircle, PinOff, Play, RotateCcw, Sparkles, Square, Upload } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { CANVAS_TEXT_MAX, isGenerator, NODE_SPECS, nodeLabel, nodeModel, promptPlaceholder, tableRows, topoOrder, type CanvasNode } from "@/lib/catalog/canvas";
import type { MediaKind } from "@/lib/catalog/types";
import { fileToSlot } from "@/components/studio/media-slot";
import { cn } from "@/lib/utils";
import { EMPTY_VIEW, NodeIcon, useEditorActions, useEditorSnapshot } from "./canvas-context";
import { CameraPathFields, costLabel, ElementPicker, EngineBadge, LayoutNodeRow, LibraryButton, MediaPreview, OutputThumb, Results } from "./nodes";

const KIND: Partial<Record<CanvasNode["type"], MediaKind>> = { "image-input": "image", "video-input": "video", "audio-input": "audio", "clone-voice": "audio" };

const field = "field-sizing-content max-h-40 min-h-12 w-full resize-none rounded-lg bg-muted px-3 py-2 text-[15px] leading-snug outline-none placeholder:text-subtle-foreground focus:ring-2 focus:ring-brand-faint";
const pill = "inline-flex h-9 items-center gap-1.5 rounded-full bg-secondary px-3.5 text-[13px] font-medium";

/**
 * The phone view of a canvas: every node in run order as a card, with its text, files (upload or
 * library), elements, results and a Run button. Wiring stays on the board (pan and zoom it on the Board tab).
 */
export function NodeList({ onQuickStart }: { onQuickStart: () => void }) {
  const { graph } = useEditorSnapshot();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const { order, cyclic } = topoOrder(graph);
  const nodes = [...order, ...cyclic].map((id) => byId.get(id)!).filter((n) => n && n.type !== "note");
  if (!nodes.length) {
    return (
      <div className="px-6 py-16 text-center">
        <p className="text-[15px] text-muted-foreground">This canvas is empty. Start with a ready-made chain, or pick a template.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button className="rounded-full" onClick={onQuickStart}>
            <Sparkles /> Start with Text → Image
          </Button>
          <Button variant="secondary" className="rounded-full" asChild>
            <Link href="/canvas?tab=templates">Browse templates</Link>
          </Button>
        </div>
      </div>
    );
  }
  return (
    <ol className="space-y-3 px-4 pt-3 pb-24" aria-label="Nodes in run order">
      {nodes.map((n, i) => (
        <li key={n.id}>
          <NodeCard node={n} index={i + 1} />
        </li>
      ))}
    </ol>
  );
}

function NodeCard({ node, index }: { node: CanvasNode; index: number }) {
  const actions = useEditorActions();
  const { graph, views, globals } = useEditorSnapshot();
  const model = nodeModel(node, globals.mode);
  const kind = KIND[node.type];
  const file = useRef<HTMLInputElement>(null);
  const gen = isGenerator(node);
  const v = views.get(node.id) ?? EMPTY_VIEW;
  const r = v.results;
  const step = v.step;
  const running = r.state === "running" || r.state === "queued";
  const error = v.runError ?? v.error;
  const sources = node.type === "output" ? graph.edges.filter((e) => e.target === node.id).map((e) => graph.nodes.find((x) => x.id === e.source)).filter((x): x is CanvasNode => !!x) : [];
  return (
    <article className="rounded-xl border bg-card p-3 shadow-soft" data-testid={`canvas-card-${node.id}`}>
      <header className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{index}</span>
        <NodeIcon name={NODE_SPECS[node.type].icon} className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{nodeLabel(node)}</h3>
        <EngineBadge model={model} />
        {gen && (
          <button
            onClick={() => (running ? actions.cancel(node.id) : node.data.pinned ? actions.update(node.id, { pinned: false }) : actions.run([node.id], !step))}
            className={cn("grid size-9 shrink-0 place-items-center rounded-full", running || node.data.pinned ? "bg-muted" : "bg-primary text-primary-foreground")}
            aria-label={running ? `Cancel ${nodeLabel(node)}` : node.data.pinned ? `Unpin ${nodeLabel(node)}` : step ? `Run ${nodeLabel(node)}` : `Run ${nodeLabel(node)} again`}
          >
            {running ? <Square className="size-3.5" /> : node.data.pinned ? <PinOff className="size-4" /> : step ? <Play className="size-4" /> : <RotateCcw className="size-4" />}
          </button>
        )}
      </header>
      <div className="mt-2.5 space-y-2.5">
        {node.type === "prompt" && (
          <textarea value={node.data.text ?? ""} onChange={(e) => actions.update(node.id, { text: e.target.value })} maxLength={CANVAS_TEXT_MAX} className={field} aria-label={`Text of ${nodeLabel(node)}`} placeholder="Write the text" />
        )}
        {kind && (
          <>
            {node.data.url ? <MediaPreview kind={kind} url={node.data.url} /> : <p className="text-[13px] text-muted-foreground">No file yet.</p>}
            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => file.current?.click()} className={pill}>
                <Upload className="size-4" /> {node.data.url ? "Replace" : "Upload"}
              </button>
              <LibraryButton kind={kind} className={pill} onPick={(url, name) => actions.update(node.id, { url, name })} />
            </div>
            <input
              ref={file}
              type="file"
              hidden
              accept={`${kind}/*`}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void fileToSlot(f, (s) => s && !s.uploading && actions.update(node.id, { url: s.ref, name: s.name }), kind);
                e.target.value = "";
              }}
            />
          </>
        )}
        {node.type === "layout" && <LayoutNodeRow id={node.id} data={node.data} className={pill} />}
        {node.type === "table" && (
          <p className="text-[13px] text-muted-foreground">
            {(() => {
              const rows = tableRows(node);
              return rows.length ? `${rows.length === 1 ? "1 row" : `${rows.length} rows`}: ${rows.map((r) => r.filter(Boolean).join(", ")).join(" · ")}` : "No rows yet: fill the table on the board.";
            })()}
          </p>
        )}
        {node.type === "camera-path" && <CameraPathFields data={node.data} label={nodeLabel(node)} onChange={(patch) => actions.update(node.id, patch)} />}
        {node.type === "element" && (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[13px] text-brand-text">{node.data.handle ? `@${node.data.handle}` : "No element picked"}</p>
            <ElementPicker data={node.data} className={pill} onPick={(patch) => actions.update(node.id, patch)} />
          </div>
        )}
        {gen && (
          <>
            <p className="text-[12px] text-muted-foreground">
              {model?.name ?? "No model"}
              {!globals.visitor && ` · ${costLabel(globals.isDemo, model, v.costUsd)}`}
            </p>
            {node.data.prompt !== undefined || node.type === "model" ? (
              <textarea
                value={node.data.prompt ?? ""}
                onChange={(e) => actions.update(node.id, { prompt: e.target.value })}
                maxLength={CANVAS_TEXT_MAX}
                className={field}
                aria-label={`Prompt for ${nodeLabel(node)}`}
                placeholder={promptPlaceholder(v.op)}
              />
            ) : null}
            <Results id={node.id} r={r} />
          </>
        )}
        {node.type === "output" &&
          (sources.length ? (
            <div className="grid grid-cols-2 gap-2">
              {sources.flatMap((s) => {
                const out = views.get(s.id)?.results.outputs[0];
                return out ? [<OutputThumb key={s.id} o={out.o} onOpen={() => actions.open(s.id, 0)} />] : [];
              })}
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">Nothing connected.</p>
          ))}
        {error && r.state !== "failed" && (
          <p className={cn("flex items-start gap-1.5 text-[13px] leading-snug", v.runError ? "text-destructive" : "text-warning")}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
