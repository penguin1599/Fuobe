import "server-only";
import crypto from "node:crypto";
import { problemText } from "@/lib/gpu/gather";
import { fixPlan } from "@/lib/gpu/plan";
import { badgeOf, cardLabel, needTargets, rankOf, shortGpu, summaryOf, toolReadiness, type ReadinessContext } from "@/lib/gpu/readiness";
import type { BadgeMap, FixPlan, GpuInventory, GpuProblem, ReadinessReport, RequirementIndex, StudioRow, ToolReadiness, ToolRef } from "@/lib/gpu/types";
import { vramGb } from "@/lib/gpu/requirements";
import { chooseH3Tier, deviceOf, tierOnCard, tierRowNote } from "@/lib/gpu/h3-tier";
import { tierOpen } from "../h3-gpu";
import { getSetting } from "../settings";
import { loadIndex } from "./index-file";
import { probe, readSnapshot, saveViews, checkWait, type Snapshot } from "./snapshots";
import { STUDIO_ROWS, openModelTools, presetRouteTools, presetTools, studioOthers, studioTool, toolFor, type Tool } from "./tools";
import { urlHash, type ReadTarget } from "./target";

/**
 * The views of a snapshot (SPEC §7.3, §10): the readiness board, the badge map, and one tool's fix plan.
 * Built from the stored inventory and cached with it until the index changes; nothing here probes, except a
 * plan's re-check of its own classes and folders when the snapshot is more than 60 s old.
 */

export function contextFor(t: ReadTarget): ReadinessContext {
  return { account: t.kind === "account" || (t.kind === "computer" && t.key !== "install"), computer: t.kind === "computer", isolatedUrl: t.kind === "install" && !!getSetting("comfyIsolatedUrl") };
}

/**
 * MiniMax H3's graphs as this card runs them (src/lib/gpu/h3-tier.ts): FastH3 V2 or Trim, with the card's file, when the card is
 * under 32 GB and that build is switched on in Models & licences. A studio row keeps only the modes the build has.
 */
export function onCard(tool: Tool, inv: GpuInventory, idx: RequirementIndex) {
  return tierOnCard(tool.workflows, inv, idx, { studio: tool.ref.startsWith("studio:"), allowed: tierOpen });
}

export function readinessOf(tool: Tool, inv: GpuInventory, idx: RequirementIndex, ctx: ReadinessContext): ToolReadiness {
  if (tool.local) {
    return { ref: tool.ref, name: tool.name, state: inv.reachable ? "ready" : "unknown", needs: [], have: [], downloadBytes: 0, vram: { needGb: 0, fit: "any" }, firstRun: [], unvalidated: false, unobservable: [] };
  }
  const card = inv.reachable ? onCard(tool, inv, idx) : { workflows: tool.workflows, idx };
  return toolReadiness(tool.ref, tool.name, card.workflows, tool.loras, inv, card.idx, { ...ctx, kind: tool.kind }, tool.cloud);
}

interface Views {
  report: ReadinessReport;
  badges: BadgeMap;
}

export function buildViews(inv: GpuInventory, idx: RequirementIndex, ctx: ReadinessContext): Views {
  const studios: StudioRow[] = [];
  for (const row of STUDIO_ROWS) {
    const tool = studioTool(row);
    if (!tool) continue;
    const t = readinessOf(tool, inv, idx, ctx);
    const others = studioOthers(row)
      .map((o) => ({ ref: o.ref, name: o.name, state: readinessOf(o, inv, idx, ctx).state }))
      .filter((o) => o.state === "ready" || o.state === "almost")
      .sort((a, b) => rankOf(b.state) - rankOf(a.state))
      .slice(0, 4);
    const tier = tierRowNote(tool.workflows, onCard(tool, inv, idx).choice, inv, idx);
    studios.push({ href: row.href, label: row.label, group: row.group, tool: { ...t, needs: t.needs.slice(0, 12), have: [] }, others, ...(tier && { gpuTier: tier }) });
  }
  const badges: BadgeMap = { connected: true, checkedAt: inv.checkedAt, models: {}, presets: {} };
  const summary = summaryOf(inv, idx);
  if (summary.gpu) badges.gpu = shortGpu(summary.gpu);
  if (summary.vramGb) badges.vramGb = summary.vramGb;
  const h3 = chooseH3Tier(deviceOf(inv)).tier;
  if (h3 !== "standard" && tierOpen(h3)) badges.h3Tier = h3;
  for (const tool of openModelTools()) {
    const b = badgeOf(readinessOf(tool, inv, idx, ctx));
    if (b) badges.models[tool.ref.slice("model:".length)] = b;
  }
  // The route a preset opens on ("<id>"), and its other routes ("<id>@<model id>": Fuobe DoP with the move's LoRAs).
  for (const tool of [...presetTools(), ...presetRouteTools()]) {
    const b = badgeOf(readinessOf(tool, inv, idx, ctx));
    if (b) badges.presets[tool.ref.slice("preset:".length)] = b;
  }
  const warnings: string[] = [];
  if (inv.exposed) warnings.push("Your ComfyUI is open to anyone online. Add a token, or put it behind Cloudflare Access, before you share the link.");
  if (inv.errors.length) warnings.push("A few checks didn't finish, so some items may show as ready. Check again to be sure.");
  return { report: { indexHash: idx.hash, checkedAt: inv.checkedAt, summary, studios, warnings }, badges };
}

/** The views for a snapshot, cached on it. */
export function viewsOf(t: ReadTarget, snap: Snapshot): Views {
  const idx = loadIndex();
  const cached = snap.views as { indexHash: string; data: Views } | undefined;
  if (cached && cached.indexHash === idx.hash) return cached.data;
  const data = buildViews(snap.inventory, idx, contextFor(t));
  saveViews(snap, data);
  return data;
}

/** GET /api/gpu/readiness: the stored check's board (never probes). */
export interface ReadinessView {
  connected: boolean;
  /** Whose ComfyUI: the studio's own, the account's, or the one on the person's computer (its tab checks it). */
  target?: "install" | "account" | "computer";
  reason?: "guest" | "no-gpu" | "token" | "refused" | "off";
  checkedAt?: number | null;
  stale?: boolean;
  /** Seconds until a new check may start. */
  wait?: number;
  problem?: GpuProblem;
  problemText?: string;
  problemDetail?: string;
  report?: ReadinessReport;
}

export function readinessView(t: ReadTarget): ReadinessView {
  const snap = readSnapshot(t);
  const base: ReadinessView = { connected: true, target: t.kind, wait: t.via === "server" ? checkWait(t) : 0 };
  if (!snap) return { ...base, checkedAt: null };
  const inv = snap.inventory;
  if (!inv.reachable) {
    return { ...base, checkedAt: snap.checkedAt, stale: snap.stale, problem: inv.problem ?? "unreachable", problemText: problemText(inv.problem ?? "unreachable", t.via === "browser" ? "computer" : t.kind === "install" ? "install" : "link"), ...(inv.problemDetail && { problemDetail: inv.problemDetail }) };
  }
  return { ...base, checkedAt: snap.checkedAt, stale: snap.stale, report: viewsOf(t, snap).report };
}

export function badgesView(t: ReadTarget): BadgeMap {
  const snap = readSnapshot(t);
  if (!snap || !snap.inventory.reachable) return { connected: true, ...(snap && { checkedAt: snap.checkedAt }), models: {}, presets: {} };
  // Badges count as fresh for 10 minutes; past that they still show (the board offers "Check again").
  return viewsOf(t, snap).badges;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * A tool's fix plan from the snapshot. When the snapshot is more than 60 s old and says something is missing,
 * the plan's own classes and folders are read again first (sharing the target's probe and its 10 s limit).
 */
export async function planFor(t: ReadTarget, ref: string, actor: string): Promise<FixPlan | null> {
  const tool = toolFor(ref);
  if (!tool) return null;
  const idx = loadIndex();
  const ctx = contextFor(t);
  let snap = readSnapshot(t);
  if (!snap) return null;
  let r = readinessOf(tool, snap.inventory, idx, ctx);
  // (A computer's ComfyUI is read by its tab: the plan is from what it sent last.)
  if (t.via === "server" && snap.inventory.reachable && r.needs.length && Date.now() - snap.checkedAt > 60_000 && checkWait(t) === 0) {
    const targets = needTargets(r.needs, idx);
    await probe(t, { actor, ...targets, loraNames: tool.loras.map((l) => l.file) }).catch(() => null);
    snap = readSnapshot(t) ?? snap;
    r = readinessOf(tool, snap.inventory, idx, ctx);
  }
  const fits = fitsFor(tool, t, snap.inventory, idx, ctx);
  const gpu = cardLabel(snap.inventory.devices[0]);
  return fixPlan(r, snap.inventory, idx, { hash: sha256, urlHash: urlHash(t), account: ctx.account, loras: tool.loras, fits, gpu: gpu && vramGb(snap.inventory.devices[0].vramTotal) ? gpu : undefined });
}

/** Other tools of the same studio that fit this GPU (for the "needs a bigger GPU" sheet). */
function fitsFor(tool: Tool, t: ReadTarget, inv: GpuInventory, idx: RequirementIndex, ctx: ReadinessContext): { ref: ToolRef; name: string; state: "ready" | "almost" }[] {
  const op = /#(.+)$/.exec(tool.ref)?.[1];
  const row = STUDIO_ROWS.find((s) => s.config && (s.config.defaultModels.open === tool.ref.replace(/^model:|#.*$/g, "") || (op && s.config.ops.includes(op as never) && s.config.kind === tool.kind)));
  if (!row) return [];
  return studioOthers(row)
    .filter((o) => o.ref !== tool.ref)
    .map((o) => ({ ref: o.ref, name: o.name, state: readinessOf(o, inv, idx, ctx).state }))
    .filter((o): o is { ref: ToolRef; name: string; state: "ready" | "almost" } => o.state === "ready" || o.state === "almost")
    .sort((a, b) => rankOf(b.state) - rankOf(a.state))
    .slice(0, 3);
}
