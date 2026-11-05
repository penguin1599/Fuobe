"use client";

import { CheckCircle2, ChevronRight, CircleAlert, Cpu, Download, Layers, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { openGpuSetup, type ReadinessView } from "@/hooks/use-gpu";
import { useEngine } from "@/lib/api";
import { rankOf, stateLine } from "@/lib/gpu/readiness";
import { formatBytes } from "@/lib/gpu/requirements";
import type { Readiness, StudioGroup, StudioRow } from "@/lib/gpu/types";
import { cn } from "@/lib/utils";

/**
 * The readiness board (UX §5): what the viewer has installed and downloaded, and every studio's state on their GPU,
 * grouped. Each row has one button: Open, Get, Set up, or Details / Use cloud. Get and Set up open the guided fix
 * with that studio's plan; nothing is ever set up from here without the plan being shown first.
 */

type Filter = "all" | "ready" | "almost" | "setup" | "gpu";
const GROUPS: StudioGroup[] = ["Images", "Video", "Audio", "Video tools"];

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function StateIcon({ state }: { state: Readiness }) {
  const Icon = state === "ready" ? CheckCircle2 : state === "gpu" ? Cpu : state === "unsupported" ? Layers : state === "unknown" ? CircleAlert : Download;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-7 shrink-0 place-items-center rounded-full",
        state === "ready" ? "bg-success/15 text-success" : state === "almost" || state === "setup" ? "bg-highlight text-highlight-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

const STATE_WORD: Record<Readiness, string> = { ready: "Ready", almost: "One step away", setup: "Needs setup", gpu: "Needs a bigger GPU", unsupported: "Not on your GPU", unknown: "Not checked" };

function Row({ row, owner }: { row: StudioRow; owner: boolean }) {
  const [, setEngine] = useEngine();
  const t = row.tool;
  const open = () => openGpuSetup({ ref: `studio:${row.href}`, name: t.name });
  const btn = "h-11 w-full sm:h-8 sm:w-auto";
  let action: React.ReactNode = null;
  if (t.state === "ready")
    action = (
      <Button asChild size="sm" variant="secondary" className={btn}>
        <Link href={row.href}>Open</Link>
      </Button>
    );
  else if (t.state === "almost" || t.state === "setup")
    action = (
      <Button size="sm" className={btn} onClick={open}>
        {t.state === "almost" && t.needs.every((n) => n.kind === "model" || n.kind === "lora" || n.kind === "hf-licence") ? "Get" : "Set up"}
      </Button>
    );
  else if (t.state === "gpu" && owner && t.cloud)
    action = (
      <Button asChild size="sm" variant="secondary" className={btn}>
        <Link href={row.href} onClick={() => setEngine("cloud")}>
          Use cloud
        </Link>
      </Button>
    );
  else if (t.state === "gpu" || t.state === "unsupported")
    action = (
      <Button size="sm" variant="ghost" className={btn} onClick={open}>
        Details
      </Button>
    );
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <StateIcon state={t.state} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-[14px]">
            <span className="font-medium">{row.label}</span>
            <span className="truncate text-muted-foreground">{t.name}</span>
          </p>
          <p className="text-[12px] text-muted-foreground">
            <span className="sr-only">{STATE_WORD[t.state]}: </span>
            {stateLine(t)}
            {(t.state === "almost" || t.state === "setup") && t.downloadBytes > 0 ? ` · about ${Math.max(1, Math.ceil(t.downloadBytes / 100e6 / 60))}–${Math.max(1, Math.ceil(t.downloadBytes / 25e6 / 60))} min` : ""}
          </p>
          {row.gpuTier && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {row.gpuTier.label === "Standard" ? "" : t.state === "ready" ? "Ready on this GPU: " : "On this GPU: "}
              {row.gpuTier.label === "Standard" ? "" : <span className="font-medium text-foreground">{row.gpuTier.label}</span>}
              {row.gpuTier.note ? `${row.gpuTier.label === "Standard" ? "" : " · "}${row.gpuTier.note}` : ""}
            </p>
          )}
          {row.others.length > 0 && t.state !== "ready" && (
            <p className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground">
              <ChevronRight aria-hidden className="size-3" />
              {row.others.length === 1 ? "1 other tool fits your GPU" : `${row.others.length} other tools fit your GPU`}: {row.others.map((o) => `${o.name} (${o.state === "ready" ? "Ready" : "one step"})`).join(", ")}
            </p>
          )}
        </div>
      </div>
      {action && <div className="sm:shrink-0">{action}</div>}
    </li>
  );
}

export function ReadinessBoard({ view, owner, onCheck, checking }: { view: ReadinessView; owner: boolean; onCheck: () => void; checking: boolean }) {
  const report = view.report!;
  const [filter, setFilter] = useState<Filter>("all");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const rows = report.studios;
  const count = (s: Readiness) => rows.filter((r) => r.tool.state === s).length;
  const ready = count("ready");
  const almost = count("almost");
  const setup = count("setup");
  // A tool that needs an NVIDIA RTX card the GPU isn't is counted on its own: a bigger card wouldn't help.
  const card = rows.filter((r) => r.tool.state === "unsupported" && r.tool.gpuNeed).length;
  const gpu = count("gpu") + count("unsupported") - card;
  const s = report.summary;
  const gpuName = s.gpu ? `${s.gpu.replace(/^NVIDIA\s+(GeForce\s+)?/i, "")}${s.vramGb ? ` (${s.vramGb} GB)` : ""}` : "ComfyUI";
  const headline = ready ? `Your ${gpuName} is ready for ${ready} of ${rows.length} studios` : `Your ${gpuName} is connected`;
  const sub = [
    almost && `${almost} more ${almost === 1 ? "needs" : "need"} one step.`,
    setup && `${setup} ${setup === 1 ? "needs" : "need"} a few things set up.`,
    gpu && `${gpu} ${gpu === 1 ? "needs" : "need"} a bigger graphics card${owner ? ", and can run in the cloud" : ""}.`,
    card && `${card} ${card === 1 ? "needs" : "need"} an NVIDIA RTX card.`,
  ]
    .filter(Boolean)
    .join(" ");
  const summary = [
    s.comfyVersion && `ComfyUI ${s.comfyVersion}`,
    s.manager,
    `${s.packs.have} of ${s.packs.of} add-ons`,
    `${s.files.have} of ${s.files.of} model files${s.files.bytes ? ` (${formatBytes(s.files.bytes)})` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = useMemo(() => (filter === "all" ? rows : rows.filter((r) => (filter === "gpu" ? r.tool.state === "gpu" || r.tool.state === "unsupported" : r.tool.state === filter))), [rows, filter]);
  const chips: { id: Filter; label: string; n: number }[] = [
    { id: "all", label: "All", n: rows.length },
    { id: "ready", label: "Ready", n: ready },
    { id: "almost", label: "One step away", n: almost },
    { id: "setup", label: "Needs setup", n: setup },
    { id: "gpu", label: "Bigger GPU", n: gpu },
  ];
  return (
    <section aria-labelledby="board-title" className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-72">
          <h2 id="board-title" className="font-heading text-[26px] leading-tight">
            {headline}
          </h2>
          {sub && <p className="mt-1 text-[14px] text-muted-foreground">{sub}</p>}
          <p className="mt-1 text-[12px] text-muted-foreground">{summary}</p>
        </div>
        <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={onCheck} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again{view.checkedAt ? ` (checked ${ago(view.checkedAt, now)})` : ""}
        </Button>
      </div>
      {report.warnings.length > 0 && (
        <ul className="space-y-1.5">
          {report.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 rounded-lg bg-brand-faint px-3 py-2 text-[13px]">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              {w}
            </li>
          ))}
        </ul>
      )}
      <div className="fade-x -mx-1 flex gap-1.5 overflow-x-auto px-1 scrollbar-none" role="group" aria-label="Show">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={filter === c.id}
            onClick={() => setFilter(c.id)}
            className={cn(
              "h-8 shrink-0 rounded-full border px-3 text-[13px] transition-colors",
              filter === c.id ? "border-foreground bg-foreground text-background" : "bg-background text-muted-foreground hover:text-foreground",
            )}
          >
            {c.label} {c.n}
          </button>
        ))}
      </div>
      {GROUPS.map((g) => {
        const list = shown.filter((r) => r.group === g).sort((a, b) => rankOf(b.tool.state) - rankOf(a.tool.state));
        if (!list.length) return null;
        const n = (st: Readiness) => list.filter((r) => r.tool.state === st).length;
        return (
          <div key={g}>
            <div className="flex items-baseline justify-between border-b pb-1.5">
              <h3 className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{g}</h3>
              <span className="text-[12px] text-muted-foreground">
                {[n("ready") && `${n("ready")} ready`, n("almost") + n("setup") && `${n("almost") + n("setup")} to set up`, n("gpu") && `${n("gpu")} bigger GPU`].filter(Boolean).join(" · ")}
              </span>
            </div>
            <ul className="divide-y">
              {list.map((r) => (
                <Row key={r.href} row={r} owner={owner} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
