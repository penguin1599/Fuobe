"use client";

import { CheckCircle2, Cpu, Download, Layers } from "lucide-react";
import { badgeState, badgeText } from "@/hooks/use-gpu";
import { ownGpuOf, useHydrated, useStatus } from "@/lib/api";
import type { Badge } from "@/lib/gpu/types";
import { cn } from "@/lib/utils";
import { awayFix, useComputerSupport } from "./open-connect";

/**
 * A tool's state on the viewer's GPU (UX §6): Ready · One step away · Needs setup · Needs a bigger GPU. Each state has
 * its own icon, a word and a colour, never colour alone. Nothing at all when there's no badge (a guest, no check yet,
 * an unknown state, a cloud-only studio). Three sizes: a card's corner (CSS-only tooltip: a gallery has hundreds),
 * a header pill (a button when it opens the guided fix) and a model row's dot.
 */

/** A badge as one string, for memoized cards ("a,1,123,0"). */
export const badgeKey = (b: Badge | null | undefined): string | undefined => (b ? b.join(",") : undefined);

export function parseBadgeKey(k: string | undefined): Badge | null {
  if (!k) return null;
  const [s, steps, gb, flags] = k.split(",");
  if (!["r", "a", "s", "g", "u"].includes(s)) return null;
  return [s as Badge[0], Number(steps) || 0, Number(gb) || 0, Number(flags) || 0];
}

function look(b: Badge) {
  const s = badgeState(b);
  if (s === "ready") return { Icon: CheckCircle2, cls: "bg-black/45 text-white", icon: "text-success" };
  if (s === "gpu") return { Icon: Cpu, cls: "bg-black/45 text-white/90", icon: "" };
  if (s === "unsupported") return { Icon: Layers, cls: "bg-black/45 text-white/90", icon: "" };
  return { Icon: Download, cls: "bg-highlight text-highlight-foreground", icon: "" };
}

/** The card's corner chip (PresetCard). */
export function CardChip({ badge, gpu }: { badge: Badge; gpu?: string }) {
  const { Icon, cls, icon } = look(badge);
  const t = badgeText(badge, gpu);
  const word = badge[0] === "g" ? `${t.short}` : t.short;
  return (
    <span role="img" aria-label={t.long} className={cn("group/gpu pointer-events-auto relative inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold", cls)}>
      <Icon aria-hidden className={cn("size-3", icon)} />
      {word}
      <span
        aria-hidden
        className="pointer-events-none absolute top-full right-0 z-10 mt-1.5 rounded-md bg-tooltip px-2 py-1 text-[11px] font-normal whitespace-nowrap text-tooltip-foreground opacity-0 shadow-soft transition-opacity group-hover/gpu:opacity-100"
      >
        {t.long}
      </span>
    </span>
  );
}

/**
 * The header pill (StudioHeader, PresetHeader): a button when it opens the guided fix. A tool that's ready on a GPU that
 * isn't there right now (ComfyUI closed, without Fuobe's setting, a link that doesn't answer) says that instead, and on the
 * computer that runs ComfyUI it is a button to the one fix (the finder).
 */
export function HeaderPill({ badge, gpu, onOpen, compact }: { badge: Badge; gpu?: string; onOpen?: () => void; compact?: boolean }) {
  // The viewer's own GPU: an account's, or the owner's computer (whose tab says whether ComfyUI is there now).
  const own = ownGpuOf(useStatus().data);
  const support = useComputerSupport();
  const hydrated = useHydrated();
  const s = badgeState(badge);
  const t = badgeText(badge, gpu);
  const tenths = badge[2];
  const away = s === "ready" && !(badge[3] & 4) && own?.connected && !own.online ? (own.comfy === "down" ? "ComfyUI isn't running" : own.comfy === "no-setting" ? "ComfyUI needs a setting" : "Your GPU is offline") : null;
  const label =
    away ??
    (s === "ready"
      ? badge[3] & 4
        ? "Runs on any computer"
        : "Ready on your GPU"
      : s === "gpu"
        ? "Needs a bigger GPU"
        : s === "unsupported"
          ? badge[3] & 24
            ? "Needs an RTX card"
            : "Not on your GPU"
          : `Set up${tenths ? ` · ${tenths / 10} GB` : ""}`);
  const Icon = away ? Cpu : s === "ready" ? CheckCircle2 : s === "gpu" ? Cpu : s === "unsupported" ? Layers : Download;
  const cls = cn(
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium",
    s === "ready" ? "bg-secondary text-foreground" : s === "almost" || s === "setup" ? "bg-highlight text-highlight-foreground" : "bg-muted text-muted-foreground",
    compact && "max-sm:w-8 max-sm:justify-center max-sm:px-0",
  );
  const inner = (
    <>
      <Icon aria-hidden className={cn("size-3.5", s === "ready" && !away && "text-success")} />
      <span className={cn(compact && "max-sm:sr-only")}>{label}</span>
    </>
  );
  const fix = away && hydrated ? awayFix(own, support) : null;
  if (fix)
    return (
      <button type="button" onClick={fix} aria-label={label} title={label} className={cn(cls, "transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}>
        {inner}
      </button>
    );
  if (!onOpen || s === "ready") return <span role="status" aria-label={t.long} title={t.long} className={cls}>{inner}</span>;
  return (
    <button type="button" onClick={onOpen} aria-label={`${label}: ${t.long}`} title={t.long} className={cn(cls, "transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none")}>
      {inner}
    </button>
  );
}

/** A model row's dot (the model picker). */
export function RowDot({ badge, gpu }: { badge: Badge; gpu?: string }) {
  const s = badgeState(badge);
  const t = badgeText(badge, gpu);
  const Icon = s === "ready" ? CheckCircle2 : s === "gpu" ? Cpu : s === "unsupported" ? Layers : Download;
  return (
    <span role="img" aria-label={t.long} title={t.long} className="inline-flex shrink-0 items-center">
      <Icon aria-hidden className={cn("size-3", s === "ready" ? "text-success" : s === "almost" || s === "setup" ? "text-warning" : "text-muted-foreground")} />
    </span>
  );
}
