"use client";

import dynamic from "next/dynamic";
import { cloneElement } from "react";
import { Cpu } from "lucide-react";
import { PlaceholdersOnChip } from "@/components/demo-mode";
import { IntentLink } from "@/components/intent-link";
import { awayFix, openConnect, useComputerSupport } from "@/components/gpu/open-connect";
import { usePagePlace } from "@/components/gpu/use-page-place";
import { useHadItems } from "@/components/use-had-items";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ownGpuOf, signInHref, useEngineMode, useHydrated, useStatus, useViewer, type EngineMode, type StatusInfo } from "@/lib/api";
import { placeholdersOn } from "@/lib/demo-mode";
import { deviceLabel } from "@/lib/gpu/readiness";
import { shortState } from "@/lib/diagnose";
import { safeLink, useInterest } from "@/lib/hosted";
import type { ViewerKind } from "@/lib/nav-model";
import { cn } from "@/lib/utils";
import { MENU_ROW_1, NavMenuItem } from "./nav-row";

/*
 * What the sidebar's footer said about GPUs, keys and balance, moved here unchanged in what it says and to whom: the
 * owner's status (cloud models, ComfyUI, the engine mode), a visitor's own GPU, an account's balance, the note of a tab
 * that runs the person's jobs on their own computer, and the owner's "Placeholders on". The account menu and the phone's
 * You sheet show them; the bar shows the balance, the computer note and placeholders as pills in slots kept for them
 * before the first paint (html[data-had-…], use-had-items.ts), so nothing in the bar moves when the status arrives.
 */

// The note of a tab that runs the person's jobs on their own computer's ComfyUI (only for someone whose runs go there).
const ComputerNote = dynamic(() => import("@/components/gpu/computer-runner").then((m) => m.ComputerNote), { ssr: false });
/** The pill's face until the runner's code is here: the same icon and words as when there is no note. */
function PillFaceIdle() {
  return (
    <>
      <Cpu aria-hidden className="size-4 text-brand-text" />
      <span className="hidden xl:inline">Your computer</span>
      <span className="sr-only xl:hidden">Your computer</span>
      <span className="sr-only">, your computer&apos;s GPU</span>
    </>
  );
}
const ComputerPillFace = dynamic(() => import("@/components/gpu/computer-runner").then((m) => m.ComputerPillFace), { ssr: false, loading: () => <PillFaceIdle /> });
const ComputerNoteLive = dynamic(() => import("@/components/gpu/computer-runner").then((m) => m.ComputerNoteLive), { ssr: false });

type Viewer = NonNullable<StatusInfo["viewer"]>;

/** A status row of the account menu or the You sheet: its dot on the rows' icon column, its words on their label column. */
const CHIP = "nav-row flex min-h-11 w-full flex-col justify-center gap-1 py-1.5 text-left text-[12px] text-muted-foreground";

export function StatusDot({ ok }: { ok: boolean | undefined }) {
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-subtle-foreground")} />;
}

/** A status dot centred in a slot as wide as the rows' icons (16 px in the menu, 18 px in the You sheet: --nav-icon). */
function DotSlot({ ok }: { ok: boolean | undefined }) {
  return (
    <span aria-hidden className="grid w-[var(--nav-icon,16px)] shrink-0 place-items-center">
      <StatusDot ok={ok} />
    </span>
  );
}

/**
 * A link or button as a row of a menu (`item`: arrow keys reach it, choosing it closes the menu) or as it is
 * elsewhere. The classes go through the menu item, so they win over its defaults.
 */
function Actionable({ item, className, children }: { item?: boolean; className: string; children: React.ReactElement<{ className?: string }> }) {
  // A sheet row's words sit on the sheet's gutter (its fill reaches 8 px past it); a menu row's on the menu's.
  if (!item) return cloneElement(children, { className: cn("-mx-2 rounded-xl px-2", className, children.props.className) });
  return (
    <NavMenuItem asChild className={cn("items-stretch", className)}>
      {children}
    </NavMenuItem>
  );
}

/**
 * "Your GPU": a visitor's own (public sign-up), never the install's, or the owner's computer. A guest is sent to sign up
 * first; anyone else without one opens "Connect your GPU"; a connected one says whether it answers.
 */
export function YourGpuChip({ gpu, guest, hosted, item }: { gpu: Viewer["gpu"]; guest: boolean; hosted?: boolean; item?: boolean }) {
  const g = gpu;
  // ComfyUI on this computer is closed, or runs without Fuobe's setting: the finder, at that step (elsewhere: /connect).
  const fix = awayFix(g.connected ? g : undefined, useComputerSupport());
  if (g.connected) {
    const vram = g.vramBytes ? `${Math.round(g.vramBytes / 2 ** 30)} GB` : "";
    const inner = (
      <>
        <span className="flex w-full items-center gap-3">
          <DotSlot ok={g.online} /> Your GPU
          <span className="ml-auto">{g.online ? "online" : g.comfy === "down" ? "ComfyUI not running" : g.comfy === "no-setting" ? "needs a setting" : shortState(g.trouble?.cause)}</span>
        </span>
        {(g.device || vram || g.mode === "computer") && (
          <span className="truncate pl-7 text-[11px]">{[g.mode === "computer" && "Your computer", deviceLabel(g.device), vram && `${vram} VRAM`].filter(Boolean).join(" · ")}</span>
        )}
      </>
    );
    return fix ? (
      <Actionable item={item} className={CHIP}>
        <button type="button" onClick={fix}>
          {inner}
        </button>
      </Actionable>
    ) : (
      <Actionable item={item} className={CHIP}>
        <IntentLink href="/connect">{inner}</IntentLink>
      </Actionable>
    );
  }
  const body = (
    <span className="flex w-full items-center gap-3">
      <DotSlot ok={false} /> Your GPU
      {/* Runs go to this studio's GPUs too (hosted runs): one's own is an option. */}
      <span className={cn("ml-auto font-medium", hosted ? "text-muted-foreground" : "text-brand-text")}>{hosted ? "Optional" : "Connect"}</span>
    </span>
  );
  return guest ? (
    <Actionable item={item} className={CHIP}>
      <a href={signInHref("signup", "/connect")}>{body}</a>
    </Actionable>
  ) : (
    <Actionable item={item} className={CHIP}>
      <button type="button" onClick={() => openConnect(true)}>
        {body}
      </button>
    </Actionable>
  );
}

/** "refills in 5 h", in the visitor's own time. */
export function refillWords(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return "refills soon";
  const h = Math.round(ms / 3_600_000);
  return h >= 1 ? `refills in ${h} h` : `refills in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * The balance's menu items (a studio with a billing service, src/server/billing.ts): the service's own words for what
 * the account has left, its detail lines, its links, its offer, and the way to run for free on one's own GPU or keys.
 */
function BalanceItems({ viewer }: { viewer: Viewer }) {
  const b = viewer.balance!;
  const interest = useInterest();
  const action = safeLink(b.action?.url);
  return (
    <>
      <DropdownMenuLabel className="px-2.5 text-[12px] font-normal text-muted-foreground">{b.text}</DropdownMenuLabel>
      {b.detail.map((d, i) => (
        <div key={i} className="flex justify-between gap-3 px-2.5 py-1 text-[12px]">
          <span className="text-muted-foreground">{d.label}</span>
          <span className="text-right">{d.text}</span>
        </div>
      ))}
      <DropdownMenuSeparator className="mx-2.5 my-1.5" />
      {action && b.action && (
        <NavMenuItem asChild className={MENU_ROW_1}>
          <a href={action} target={action.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
            {b.action.label}
          </a>
        </NavMenuItem>
      )}
      {b.offer && <NavMenuItem className={MENU_ROW_1} onSelect={() => interest.mutate(b.offer!.key)}>{b.offer.label}</NavMenuItem>}
      {(viewer.links ?? []).map((l, i) => {
        const href = safeLink(l.url);
        return href ? (
          <NavMenuItem key={i} asChild className={MENU_ROW_1}>
            <a href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noopener noreferrer">
              {l.label}
            </a>
          </NavMenuItem>
        ) : null;
      })}
      <NavMenuItem asChild className={MENU_ROW_1}>
        <IntentLink href="/connect">
          <Cpu /> Use your own GPU or keys (free)
        </IntentLink>
      </NavMenuItem>
    </>
  );
}

function balanceLabel(viewer: Viewer): { chip: string; refill: string | null } {
  const b = viewer.balance!;
  return { chip: b.chip, refill: b.refillAt ? refillWords(b.refillAt) : null };
}

/**
 * The balance chip with its own menu. `pill`: the bar's compact form (one line, 36 px); otherwise the footer-style block
 * (the You sheet, and inside the account menu it is a submenu-free block with the same items).
 */
export function BalanceChip({ viewer, pill, className }: { viewer: Viewer; pill?: boolean; className?: string }) {
  const b = viewer.balance!;
  const { chip, refill } = balanceLabel(viewer);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${chip}${refill ? `, ${refill}` : ""}`}
          className={cn(
            pill
              ? "inline-flex h-9 max-w-56 items-center gap-2 rounded-full [@media(pointer:coarse)]:h-11 border border-sidebar-border px-3 text-[12.5px] text-muted-foreground nav-row"
              : cn(CHIP, "-mx-2 rounded-xl px-2"),
            className,
          )}
        >
          <span className={cn("flex min-w-0 items-center", pill ? "gap-2" : "gap-3")}>
            {pill ? <StatusDot ok={b.amount > 0} /> : <DotSlot ok={b.amount > 0} />} <span className="truncate font-medium text-foreground">{chip}</span>
            {refill && <span className={cn("ml-auto shrink-0", pill && "hidden xl:inline")}>{refill}</span>}
          </span>
          {!pill && b.sub && <span className="truncate pl-7 text-[11px]">{b.sub}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={pill ? "bottom" : "top"} align={pill ? "end" : "start"} className="w-64">
        <BalanceItems viewer={viewer} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The balance inside the account menu: the chip's words as a label, then its items, at the same level as the menu's. */
export function BalanceSection({ viewer }: { viewer: Viewer }) {
  const b = viewer.balance!;
  const { chip, refill } = balanceLabel(viewer);
  return (
    <>
      <DropdownMenuLabel className="flex flex-col gap-0.5 px-2.5 font-normal">
        <span className="flex items-center gap-3 text-[12.5px]">
          <DotSlot ok={b.amount > 0} /> <span className="font-medium text-foreground">{chip}</span>
          {refill && <span className="ml-auto text-[12px] text-muted-foreground">{refill}</span>}
        </span>
        {b.sub && <span className="pl-7 text-[11px] text-muted-foreground">{b.sub}</span>}
      </DropdownMenuLabel>
      <BalanceItems viewer={viewer} />
    </>
  );
}

/** The owner's GPU as "Your GPU": on the owner's computer, or (a hosted studio with nothing connected) one to connect. */
function useOwnerGpu(status: StatusInfo | undefined, mode: EngineMode) {
  const place = usePagePlace();
  const comfy = status?.providers.comfyui?.configured;
  // Not in Paid APIs only mode: ComfyUI isn't used there, wherever it runs.
  return status && !status.viewer && mode !== "cloud" && (status.ownerGpu || (place === "hosted" && !comfy)) ? (ownGpuOf(status) ?? { connected: false }) : null;
}

/** The status as it may be shown: none until hydrated (a status that lands mid-hydration must not change the HTML). */
export function useShownStatus(): StatusInfo | undefined {
  const hydrated = useHydrated();
  const data = useStatus().data;
  return hydrated ? data : undefined;
}

/**
 * The owner's status (the sidebar footer's, word for word): cloud models connected or "add key", ComfyUI online or
 * offline (or the owner's computer as "Your GPU"), and the engine mode when it isn't both. Owner only: the caller
 * renders it only for the owner (useViewerKind() === "owner").
 */
export function OwnerStatus({ item }: { item?: boolean }) {
  const status = useShownStatus();
  const mode = useEngineMode();
  const ownerGpu = useOwnerGpu(status, mode);
  if (status?.viewer) return null;
  const cloud = !!status && !!(status.providers.fal?.configured || status.providers.replicate?.configured);
  const comfy = status?.providers.comfyui?.configured;
  const modeLine = mode !== "both" && <span className={cn("pb-1 text-[11px] text-muted-foreground", item ? "pl-[38px]" : "pl-7")}>{mode === "open" ? "Open source only" : "Paid APIs only"}</span>;
  if (!status)
    return (
      <div aria-hidden className="flex h-[30px] items-center px-2">
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  if (ownerGpu)
    return (
      <>
        {mode !== "open" && (
          <Actionable item={item} className={cn(CHIP, "flex-row items-center gap-3")}>
            <IntentLink href="/settings">
              <DotSlot ok={cloud} /> Cloud models
              <span className="ml-auto">{cloud ? "connected" : "add key"}</span>
            </IntentLink>
          </Actionable>
        )}
        <YourGpuChip gpu={ownerGpu} guest={false} item={item} />
        {modeLine}
      </>
    );
  return (
    <Actionable item={item} className={cn(CHIP, "gap-1.5")}>
      <IntentLink href="/settings">
        {mode !== "open" && (
          <span className="flex w-full items-center gap-3">
            <DotSlot ok={cloud} /> Cloud models
            <span className="ml-auto">{cloud ? "connected" : "add key"}</span>
          </span>
        )}
        {mode !== "cloud" && (
          <span className="flex w-full items-center gap-3">
            <DotSlot ok={comfy} /> ComfyUI
            <span className="ml-auto">{comfy ? "online" : "offline"}</span>
          </span>
        )}
        {mode !== "both" && <span className="pl-7 text-[11px] text-muted-foreground">{mode === "open" ? "Open source only" : "Paid APIs only"}</span>}
      </IntentLink>
    </Actionable>
  );
}

/**
 * The account menu's GPU section for a visitor (public sign-up): the balance when the studio bills, else their own GPU.
 * Never the install's.
 */
export function VisitorGpu({ item }: { item?: boolean }) {
  const status = useShownStatus();
  const v = status?.viewer;
  if (!v) return null;
  if (v.balance) return item ? <BalanceSection viewer={v} /> : <BalanceChip viewer={v} />;
  return <YourGpuChip gpu={v.gpu} guest={v.kind === "guest"} hosted={!!v.hosted} item={item} />;
}

/** The owner's "Placeholders on", while it is on (the owner's runs only make placeholders). */
export function usePlaceholdersOn(kind: ViewerKind | undefined): boolean {
  const status = useShownStatus();
  return kind === "owner" && !!status && !status.viewer && placeholdersOn(status.demoMode);
}

/**
 * The dot on the avatar: the owner's whether the engine mode's needs are met (a cloud key unless open source only,
 * ComfyUI unless paid APIs only), green or amber; an account's only when its own GPU answers (a positive mark only);
 * nothing for a guest or while the status is unknown.
 */
export function avatarDot(kind: ViewerKind | undefined, status: StatusInfo | undefined, mode: EngineMode): "ok" | "warn" | null {
  if (!status || !kind || kind === "guest") return null;
  if (kind === "account") return status.viewer?.gpu.connected && status.viewer.gpu.online ? "ok" : null;
  if (status.viewer) return null;
  const cloud = !!(status.providers.fal?.configured || status.providers.replicate?.configured);
  const comfy = status.ownerGpu ? status.ownerGpu.online : !!status.providers.comfyui?.configured;
  return (mode === "open" || cloud) && (mode === "cloud" || comfy) ? "ok" : "warn";
}

/**
 * Remembers which of the bar's pills this browser showed last (a balance, the computer note, placeholders on), so the
 * pre-paint script keeps their room on the next load (html[data-had-balance|computer|placeholders]). Mounted once, in
 * the bar. Nothing is remembered until the viewer and the status are known.
 */
export function useRememberPills(kind: ViewerKind | undefined): { balance: boolean; computer: boolean; placeholders: boolean } {
  const status = useShownStatus();
  const viewer = useViewer().data;
  const hydrated = useHydrated();
  const known = !!kind && !!status;
  const balance = known && !!status.viewer?.balance;
  const computer = hydrated && !!kind && viewer?.computer === true;
  const placeholders = usePlaceholdersOn(kind);
  useHadItems("balance", known ? Number(balance) : undefined);
  useHadItems("computer", hydrated && kind ? Number(computer) : undefined);
  useHadItems("placeholders", known ? Number(placeholders) : undefined);
  return { balance, computer, placeholders };
}

/**
 * The computer note as a bar pill (someone whose runs go to their own computer's ComfyUI, viewer.computer): a 36 px
 * button, with "Your computer" beside it from xl, that opens the note and its one action. When there is nothing to do
 * the popover says where the runs go and links to Your GPU.
 */
export function ComputerPill() {
  return (
    <>
      <Popover>
        <PopoverTrigger
          className="inline-flex h-9 w-full min-w-9 items-center justify-center gap-2 rounded-full [@media(pointer:coarse)]:h-11 border border-sidebar-border px-2 text-[12.5px] text-muted-foreground nav-row xl:px-3"
        >
          <ComputerPillFace />
        </PopoverTrigger>
        <PopoverContent align="end" className="group/note w-72">
          <ComputerNote />
          <p className="text-[12px] text-muted-foreground group-has-[[role=status]]/note:hidden">Your runs go to the GPU on this computer. Keep a Fuobe tab open while they run.</p>
          <IntentLink href="/connect" className="text-[12px] font-medium text-brand-text underline-offset-4 nav-hover:underline">
            Your GPU
          </IntentLink>
        </PopoverContent>
      </Popover>
      <ComputerNoteLive />
    </>
  );
}

/** The computer note as the phone's You sheet shows it (at the top), for someone whose runs go to their computer. */
export function ComputerNoteBlock() {
  const hydrated = useHydrated();
  const computer = useViewer().data?.computer === true && hydrated;
  return computer ? <ComputerNote /> : null;
}

/**
 * The bar's pills, in slots whose width is kept from the first paint by html[data-had-…] (the server's shell can't
 * know them): a billing account's balance, the computer pill, the owner's "Placeholders on". A slot that was empty last
 * time takes no room, one that had a pill keeps it until the status says otherwise.
 */
export function BarPills({ kind }: { kind: ViewerKind | undefined }) {
  const { balance, computer, placeholders } = useRememberPills(kind);
  const status = useShownStatus();
  const known = !!kind && !!status;
  return (
    <>
      {known ? (
        balance &&
        status.viewer && (
          <span data-slot="balance-pill" className={cn("flex shrink-0", PILL_W.balance)}>
            <BalanceChip viewer={status.viewer} pill className="w-full" />
          </span>
        )
      ) : (
        <span aria-hidden data-slot="balance-pill" className={cn("hidden shrink-0 [html[data-had-balance]_&]:block", PILL_W.balance)} />
      )}
      {kind ? (
        computer && (
          <span data-slot="computer-pill" className={cn("flex shrink-0", PILL_W.computer)}>
            <ComputerPill />
          </span>
        )
      ) : (
        <span aria-hidden data-slot="computer-pill" className={cn("hidden shrink-0 [html[data-had-computer]_&]:block", PILL_W.computer)} />
      )}
      {known ? (
        placeholders && (
          <span data-slot="placeholders-pill" className={cn("hidden shrink-0 items-center xl:flex", PILL_W.placeholders)}>
            <PlaceholdersOnChip className="h-8 px-3 text-[12px]" />
          </span>
        )
      ) : (
        <span aria-hidden data-slot="placeholders-pill" className={cn("hidden shrink-0 xl:[html[data-had-placeholders]_&]:block", PILL_W.placeholders)} />
      )}
    </>
  );
}

/** Each pill's fixed width: the kept room before the status is known is exactly what the pill takes after. */
export const PILL_W = { balance: "w-40", computer: "w-9 xl:w-[140px]", placeholders: "w-[136px]" } as const;
