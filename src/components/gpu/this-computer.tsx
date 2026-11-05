"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, Download, Loader2, MonitorSmartphone, RefreshCw, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { gib } from "@/components/gpu/comfy-finder";
import { useNow } from "@/components/studio/use-now";
import type { ReadinessView } from "@/hooks/use-gpu";
import { copyWithToast } from "@/lib/clipboard";
import { GUARD_FILE_NAME, GUARD_SOURCE, isGuard } from "@/lib/comfy-guard";
import { LIVE_NODES_FILE_NAME, LIVE_NODES_SOURCE } from "@/lib/comfy-live-nodes";
import { FUOBE_CONNECT_PUBLISHED, isConnectAnswer } from "@/lib/fuobe-connect";
import { corsFlag, fixFor, guessInstall, installFromStats, platformOf, startFile, START_FILE_NAME, type ComfyInstall } from "@/lib/comfy-install";
import { checkThisComputer, loopbackFetch, sendCheck } from "@/lib/gpu/browser-check";
import { deviceLabel } from "@/lib/gpu/readiness";
import { COMFY_PORT, DESKTOP_PORT, localBase, statsFacts, typedPort, type SystemStats } from "@/lib/local-comfy";
import { madeNoun } from "@/lib/relay";
import { cn } from "@/lib/utils";
import { computerState, rememberComfy, rememberedComfy, restartComputerRunner, store, stored } from "./computer-runtime";
import { InstallConnect, PairInstead } from "./fuobe-connect";
import { OTHER_BROWSERS } from "./open-connect";
import { useLocalComfy, type Finder } from "./use-local-comfy";

/**
 * "Use the ComfyUI on this computer": finds the person's ComfyUI from this page, gives the one fix its install needs
 * (a start file, a setting, a command) with Fuobe's guard, notices by itself when ComfyUI comes back with it, connects,
 * checks what it has, and, when it was opened from a run, starts that run. Every state has its own screen and words
 * (DESIGN 9.1).
 */

const INSTALLS: { id: ComfyInstall; label: string }[] = [
  { id: "desktop", label: "ComfyUI Desktop" },
  { id: "portable", label: "Portable or Easy-Install" },
  { id: "stability-matrix", label: "Stability Matrix" },
  { id: "terminal", label: "Started from a terminal" },
];

const origin = () => (typeof window === "undefined" ? "https://fuobe.com" : window.location.origin);
const nav = () => navigator as Navigator & { userAgentData?: { platform?: string } };

function CopyLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2">
      <code aria-label={label} className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-nowrap">
        {text}
      </code>
      <button
        type="button"
        onClick={() => void copyWithToast(text)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={`Copy ${label}`}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

/** A soft pulsing dot and a line: Fuobe is watching for something by itself. */
function Watching({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <span className="relative flex size-2 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex size-2 rounded-full bg-primary" />
      </span>
      {children}
    </p>
  );
}

/** What the browser's question looks like, with the button to press. */
export function PromptPicture() {
  const host = typeof window === "undefined" ? "fuobe.com" : window.location.host;
  return (
    <div aria-hidden className="w-56 max-w-full shrink-0 rounded-lg border bg-background p-2.5 text-[11px] shadow-sm">
      <p className="font-medium">{host} wants to</p>
      <p className="mt-0.5 text-muted-foreground">Access other apps and services on this device</p>
      <div className="mt-2 flex justify-end gap-1.5">
        <span className="rounded-md border px-2 py-0.5 text-muted-foreground">Block</span>
        <span className="rounded-md bg-primary px-2 py-0.5 font-medium text-primary-foreground ring-2 ring-primary/40 ring-offset-1 ring-offset-background">Allow</span>
      </div>
    </div>
  );
}

/** The browser's question, explained: its picture and what to press. */
export function AllowNote() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <PromptPicture />
      <p className="min-w-[12rem] flex-1 text-[12px] text-muted-foreground">Your browser will ask to let Fuobe reach apps on this computer. Press Allow. Fuobe only talks to ComfyUI.</p>
    </div>
  );
}

export function blockedSteps(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Click the icon to the left of the address and allow apps and services on this device, then reload.";
  if ((navigator as Navigator & { brave?: unknown }).brave) return "Click the Brave icon and allow localhost access, then reload.";
  return "Click the icon to the left of the address, turn on Apps on device, then reload.";
}

type Unsupported = "safari" | "phone" | "http";

/**
 * Why this browser can't use the ComfyUI on the person's computer, in their terms, then the way that works from right
 * here: the web address form shown below these words. Two short sentences. The person already has Fuobe open, so no
 * line tells them to open it.
 */
const UNSUPPORTED: Record<Unsupported, string> = {
  phone: "A phone or tablet can't reach the ComfyUI on your computer from a website. Give your ComfyUI a web address below, and your runs reach it from here.",
  safari: "Safari doesn't let a website talk to programs on your Mac, so this page can't reach your ComfyUI. Give your ComfyUI a web address below, and it works from Safari.",
  http: "Your browser marks this page as not secure, so it doesn't let the page talk to programs on this computer, like ComfyUI. Give your ComfyUI a web address below, and it works from here.",
};

/** The owner's way from here is a ComfyUI at a server address (a cloud GPU, a tunnel), shown below these words. */
const UNSUPPORTED_OWNER: Record<Unsupported, string> = {
  phone: "A phone or tablet can't reach the ComfyUI on your computer from a website. Use a ComfyUI on a server below, and your runs reach it from here.",
  safari: "Safari doesn't let a website talk to programs on your Mac, so this page can't reach your ComfyUI. Use a ComfyUI on a server below, and it works from Safari.",
  http: "Your browser marks this page as not secure, so it doesn't let the page talk to programs on this computer, like ComfyUI. Use a ComfyUI on a server below, or give this studio a secure address.",
};

/** The words, for a <p>: the two sentences, and on Safari the other browsers' line below them. */
export const unsupportedWords = (why: Unsupported, owner = false) => (
  <>
    {(owner ? UNSUPPORTED_OWNER : UNSUPPORTED)[why]}
    {why === "safari" && <span className="mt-1 block text-[12px]">{OTHER_BROWSERS}</span>}
  </>
);

/** Save a file the page made (the start file, the guard). */
function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const installOf = (port: number): ComfyInstall => (stored("install") as ComfyInstall | null) ?? guessInstall(port, platformOf(nav()));

/**
 * Fuobe's guard, for the person to add: the start file does it on Windows (portable, Easy-Install); for the other
 * installs, the file and where it goes. ComfyUI loads it at its next start.
 */
export function GuardFix({ port, install = installOf(port) }: { port: number; install?: ComfyInstall }) {
  const fix = fixFor(install, origin(), port);
  if (fix.startFile) {
    return (
      <Button size="sm" variant="secondary" onClick={() => save(START_FILE_NAME, startFile(port, origin()))}>
        <Download /> Download start file
      </Button>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="secondary" onClick={() => save(GUARD_FILE_NAME, GUARD_SOURCE)}>
          <Download /> Download Fuobe&apos;s guard
        </Button>
        <Button size="sm" variant="ghost" onClick={() => save(LIVE_NODES_FILE_NAME, LIVE_NODES_SOURCE)} title="For Live edit: change a picture as you type">
          <Download /> Fuobe&apos;s live nodes
        </Button>
      </div>
      <p className="text-[12px] text-muted-foreground">{fix.guard} The live nodes go there too, for Live edit. Then restart ComfyUI.</p>
    </div>
  );
}

/** The line about a port the person picked: Fuobe is looking there, nothing answers there now, or another app does. */
function PickedNote({ checking, missed, notComfy }: { checking?: number | null; missed?: number; notComfy?: number }) {
  if (checking != null)
    return (
      <p role="status" className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> Checking port {checking}…
      </p>
    );
  if (missed !== undefined)
    return (
      <p role="status" className="text-[12px] text-muted-foreground">
        Nothing answers on port {missed} right now. Is ComfyUI still running there?
      </p>
    );
  if (notComfy !== undefined)
    return (
      <p role="status" className="text-[12px] text-muted-foreground">
        Another app answers on port {notComfy}, not ComfyUI.
      </p>
    );
  return null;
}

/**
 * The other ports where something answers, behind a quiet disclosure: each can be picked ("Use port 8189"), which looks
 * there at once. While it looks, and when it isn't ComfyUI's there now, a line says so (never silence). `shown`: the
 * port the card is about, whose own line is said next to it instead.
 */
function OtherPorts({
  others,
  onChoose,
  checking,
  missed,
  notComfy,
  shown,
}: {
  others: number[];
  onChoose: (port: number) => void;
  checking?: number | null;
  missed?: number;
  notComfy?: number;
  shown?: number;
}) {
  const [open, setOpen] = useState(false);
  const mine = (p: number | null | undefined) => (p == null || p === shown ? undefined : p);
  return (
    <div data-other-ports className="space-y-1.5">
      {others.length > 0 && (
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} /> Other ports ({others.length})
        </button>
      )}
      {open && others.length > 0 && (
        <ul className="space-y-1 rounded-xl border p-2">
          {others.map((p) => (
            <li key={p} className="flex items-center justify-between gap-2 text-[12px]">
              <span className="text-muted-foreground">Something answers on port {p}</span>
              <Button size="sm" variant="ghost" className="h-7" disabled={checking === p} onClick={() => onChoose(p)}>
                {checking === p && <Loader2 className="animate-spin" />} Use port {p}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <PickedNote checking={mine(checking)} missed={mine(missed)} notComfy={mine(notComfy)} />
    </div>
  );
}

/** What the card says about the port shown, and why this page can't use it yet. */
function settingWords(port: number, o: { back: boolean; again?: boolean }): { heading: string; why: string } {
  const trust = "ComfyUI only answers the websites it's told to trust, so this page can't use it yet. One step lets Fuobe in:";
  if (o.back)
    return {
      heading: "ComfyUI is back, but it still doesn't let this page in.",
      why: FUOBE_CONNECT_PUBLISHED ? "Did ComfyUI restart after the install? Fuobe Connect starts with ComfyUI." : "Did ComfyUI start again with Fuobe's setting? Check it below.",
    };
  if (o.again) return { heading: "ComfyUI is running, but Fuobe can't use it this time.", why: trust };
  if (port === COMFY_PORT) return { heading: `Something is running on port ${port}, ComfyUI's usual port.`, why: trust };
  if (rememberedComfy()?.port === port) return { heading: `Something is running on port ${port}, where your ComfyUI was before.`, why: trust };
  if (port === DESKTOP_PORT) return { heading: `Something is running on port ${port}, ComfyUI Desktop's usual port.`, why: trust };
  // A port the person picked or typed: it may be another app.
  return { heading: `Something answers on port ${port}.`, why: "Fuobe can't read this port yet. If it's ComfyUI, one step lets Fuobe in:" };
}

/**
 * Something answers on a port that may be ComfyUI's, but this page can't read it. Shown only when nothing better
 * answers: no ComfyUI on its usual port, and another app may be what answers here.
 */
function WeakCandidate({ port, onCheck, onChoose, checking }: { port: number; onCheck: () => void; onChoose?: (port: number) => void; checking?: number | null }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[15px] font-medium">No ComfyUI found on port {COMFY_PORT}, its usual port.</p>
        <p className="mt-1 text-[13px] text-muted-foreground">Something answers on port {port}, but Fuobe can&apos;t tell if it&apos;s ComfyUI. Start ComfyUI, then check again.</p>
      </div>
      <Button className="h-11 sm:h-9" onClick={onCheck}>
        <RefreshCw /> Check again
      </Button>
      {onChoose &&
        (checking === port ? (
          <PickedNote checking={port} />
        ) : (
          <p className="text-[12px] text-muted-foreground">
            <button type="button" onClick={() => onChoose(port)} className="underline underline-offset-4 hover:text-foreground">
              Port {port} is my ComfyUI
            </button>
          </p>
        ))}
    </div>
  );
}

/**
 * ComfyUI answers, but this page can't use it yet: the one step is Fuobe Connect (it lets this studio in, and keeps every
 * other website out), and Fuobe connects by itself once ComfyUI restarts with it. The start setting with Fuobe's guard
 * (the way before Fuobe Connect) is under Advanced. Until Fuobe Connect is published (FUOBE_CONNECT_PUBLISHED), the start
 * setting with Fuobe's guard is the one step. `back`: ComfyUI restarted, still not usable. `again`: it was usable
 * before (started the usual way this time). `weak`: maybe not ComfyUI (another port, nothing on 8188). `chosen`: the
 * person picked this port. `others`: more ports where something answers, under "Other ports". `onCheck`: Check again.
 */
export function SettingFix({
  port,
  back,
  again,
  weak,
  others,
  missed,
  notComfy,
  checking,
  onChoose,
  onCheck,
}: {
  port: number;
  back: boolean;
  again?: boolean;
  weak?: boolean;
  others?: number[];
  missed?: number;
  notComfy?: number;
  checking?: number | null;
  onChoose?: (port: number) => void;
  onCheck?: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const asWeak = !!weak && !!onCheck && !back;
  const otherPorts = onChoose && (!!others?.length || missed !== undefined || notComfy !== undefined || checking != null) && (
    <OtherPorts others={others ?? []} onChoose={onChoose} checking={checking} missed={missed} notComfy={notComfy} shown={asWeak ? port : undefined} />
  );
  if (asWeak)
    return (
      <div className="space-y-3">
        <WeakCandidate port={port} onCheck={onCheck} onChoose={onChoose} checking={checking} />
        {otherPorts}
      </div>
    );
  const { heading, why } = settingWords(port, { back, again });
  if (!FUOBE_CONNECT_PUBLISHED)
    return (
      <div className="space-y-3">
        <div>
          <p className="text-[15px] font-medium">{heading}</p>
          <p className="mt-1 text-[13px] text-muted-foreground">{why}</p>
        </div>
        <FlagFix port={port} back={back} again={again} />
        <Watching>Fuobe connects by itself once ComfyUI lets this page in.</Watching>
        {onCheck && (
          <Button size="sm" variant="secondary" onClick={onCheck}>
            <RefreshCw /> Check again
          </Button>
        )}
        {otherPorts}
      </div>
    );
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[15px] font-medium">{heading}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{why}</p>
      </div>
      <InstallConnect />
      {!advanced && (
        <p className="text-[12px] text-muted-foreground">
          Or start ComfyUI with one setting instead.{" "}
          <button type="button" onClick={() => setAdvanced(true)} className="underline underline-offset-4 hover:text-foreground">
            Show the setting
          </button>
        </p>
      )}
      <Watching>Fuobe connects by itself once ComfyUI lets this page in.</Watching>
      {onCheck && (
        <Button size="sm" variant="secondary" onClick={onCheck}>
          <RefreshCw /> Check again
        </Button>
      )}
      {otherPorts}
      <div>
        <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
          <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} /> Advanced: a start setting instead
        </button>
        {advanced && (
          <div className="mt-2 rounded-xl border p-3">
            <FlagFix port={port} back={back} again={again} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The way before Fuobe Connect: the start setting for the install the person has (a start file, a setting in an app,
 * or a command), with Fuobe's guard, which keeps other websites out while the setting is on.
 */
function FlagFix({ port, back, again }: { port: number; back: boolean; again?: boolean }) {
  const [install, setInstall] = useState<ComfyInstall>(() => installOf(port));
  const [choosing, setChoosing] = useState(false);
  const [yourself, setYourself] = useState(false);
  const fix = fixFor(install, origin(), port);
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] text-muted-foreground">{fix.lead}</p>
        {back && <p className="mt-1 text-[12px] text-muted-foreground">The address must be exactly {origin()}, with nothing after it.</p>}
        {again && fix.startFile && <p className="mt-1 text-[12px] text-muted-foreground">Next time, start ComfyUI with {START_FILE_NAME} (next to ComfyUI): it has the setting.</p>}
      </div>
      <p className="flex items-start gap-1.5 rounded-lg bg-muted/60 px-2.5 py-2 text-[12px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-brand-text" />
        {fix.startFile
          ? "On its own, this setting would also let other websites send work to your ComfyUI. The start file adds Fuobe's guard, which turns them away."
          : "On its own, this setting would also let other websites send work to your ComfyUI. Add Fuobe's guard too: it turns them away."}
      </p>
      {fix.startFile ? (
        <>
          <Button size="sm" variant="secondary" onClick={() => save(START_FILE_NAME, startFile(port, origin()))}>
            <Download /> Download start file
          </Button>
          <p className="text-[12px] text-muted-foreground">
            Restarting stops anything ComfyUI is making right now. If Windows warns you about a file from the internet, press More info, then Run anyway.
          </p>
          <div>
            <button type="button" onClick={() => setYourself((v) => !v)} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
              <ChevronDown className={cn("size-3.5 transition-transform", yourself && "rotate-180")} /> Rather do it yourself?
            </button>
            {yourself && (
              <div className="mt-2 space-y-1.5">
                <p className="text-[12px] text-muted-foreground">Add this to the end of the line that starts ComfyUI in your start file, then start ComfyUI again:</p>
                <CopyLine text={corsFlag(origin())} label="the setting" />
                <GuardFix port={port} install="terminal" />
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <CopyLine text={fix.copy} label={install === "desktop" ? "the address" : "the setting"} />
          {fix.path && <p className="text-[12px] text-muted-foreground">{fix.path.join(" → ")}</p>}
          {fix.example && <p className="text-[12px] text-muted-foreground">For example: <code className="font-mono">{fix.example}</code></p>}
          <GuardFix port={port} install={install} />
        </>
      )}
      <div>
        <button type="button" onClick={() => setChoosing((v) => !v)} className="text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          Not what you use?
        </button>
        {choosing && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {INSTALLS.map((i) => (
              <Button
                key={i.id}
                size="sm"
                variant={i.id === install ? "secondary" : "ghost"}
                className="h-8"
                onClick={() => {
                  setInstall(i.id);
                  store("install", i.id);
                  setChoosing(false);
                }}
              >
                {i.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function OtherPort({ onLook, missed, notComfy }: { onLook: (port: number, host: string) => void; missed?: number; notComfy?: number }) {
  const [typed, setTyped] = useState(String(rememberedComfy()?.port ?? 8188));
  const [bad, setBad] = useState(false);
  const go = () => {
    const p = typedPort(typed);
    setBad(!p);
    if (p) onLook(p.port, p.host);
  };
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] text-muted-foreground">ComfyUI on another port?</p>
      <div className="flex gap-2">
        <Input aria-label="ComfyUI's port" inputMode="numeric" className="h-9 w-28" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
        <Button size="sm" variant="secondary" className="h-9" onClick={go}>
          <Search /> Look
        </Button>
      </div>
      {bad && <p className="text-[12px] text-destructive">Enter the port ComfyUI shows, like 8188.</p>}
      {!bad && missed !== undefined && <p role="status" className="text-[12px] text-muted-foreground">Nothing answered on port {missed}.</p>}
      {!bad && notComfy !== undefined && <p role="status" className="text-[12px] text-muted-foreground">Another app answers on port {notComfy}, not ComfyUI.</p>}
    </div>
  );
}

type Connected = { port: number; stats: SystemStats; guard: Guarded; board?: ReadinessView | null; checkFailed?: boolean };

function readyLine(board: ReadinessView | null | undefined): string | null {
  const studios = board?.report?.studios;
  if (!studios?.length) return null;
  const ready = studios.filter((s) => s.tool.state === "ready").length;
  const near = studios.filter((s) => s.tool.state === "almost" || s.tool.state === "setup").length;
  return `Ready now: ${ready} ${ready === 1 ? "studio" : "studios"}${near ? ` · ${near} need${near === 1 ? "s" : ""} a one-time download or setup` : ""}`;
}

/** The connected screen: the GPU, what's ready, and the run starting (when it was opened from one). */
function Celebration({ c, fromRun, kind, onStart, onNotNow, doneWords }: { c: Connected; fromRun?: boolean; kind?: string; onStart?: () => void; onNotNow?: () => void; doneWords?: string }) {
  const facts = statsFacts(c.stats, origin(), !!c.guard);
  const gpu = [facts.device && deviceLabel(facts.device), gib(facts.vramBytes), facts.version && `ComfyUI ${facts.version}`].filter(Boolean).join(" · ");
  const ready = readyLine(c.board);
  const checked = c.board !== undefined || c.checkFailed;
  const [starting, setStarting] = useState(false);
  const [stopped, setStopped] = useState(false);
  // Opened from a run: once the check is in (or after a few seconds), the run starts by itself.
  useEffect(() => {
    if (!fromRun || stopped) return;
    const t = setTimeout(() => setStarting(true), checked ? 300 : 4000);
    return () => clearTimeout(t);
  }, [fromRun, stopped, checked]);
  useEffect(() => {
    if (!starting || stopped) return;
    const t = setTimeout(() => onStart?.(), 1200);
    return () => clearTimeout(t);
  }, [starting, stopped, onStart]);
  // The run about to start stays this page's: what's ready is a link once it has started, or when there is none.
  const waitingRun = fromRun && !stopped;
  return (
    <div className="space-y-3 rounded-2xl bg-brand-faint p-4">
      <div className="flex items-center gap-3">
        <div className="grid size-10 shrink-0 animate-in place-items-center rounded-full bg-primary text-primary-foreground duration-300 zoom-in-50 fade-in-0">
          <Check className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">Your GPU is connected</p>
          {gpu && <p className="truncate text-[13px] text-muted-foreground">{gpu}</p>}
        </div>
      </div>
      {facts.cors === "any" ? (
        <div className="space-y-1.5 text-[12px]">
          <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
            <TriangleAlert className="size-3.5" /> Your ComfyUI lets every website in. To keep it private, use {origin()} instead:
          </p>
          <CopyLine text={corsFlag(origin())} label="the setting" />
        </div>
      ) : c.guard ? (
        <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <ShieldCheck className="size-3.5 text-brand-text" /> {c.guard === "connect" ? "Fuobe Connect" : "Fuobe's guard"} keeps other websites out of your ComfyUI.
        </p>
      ) : (
        <div className="space-y-1.5 text-[12px]">
          <p className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Other websites could also send work to your ComfyUI. Add Fuobe&apos;s guard to turn them away:
          </p>
          <GuardFix port={c.port} />
        </div>
      )}
      <p className="text-[13px]">
        {!checked ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Checking what your ComfyUI has…
          </span>
        ) : ready ? (
          <>
            {ready}.{" "}
            {!waitingRun && (
              <a href="/connect" className="text-brand-text underline-offset-4 hover:underline">
                See them
              </a>
            )}
          </>
        ) : null}
      </p>
      {waitingRun ? (
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {starting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Starting your {madeNoun(kind)}…
              </>
            ) : (
              "Your run starts in a moment."
            )}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStopped(true);
              onNotNow?.();
            }}
          >
            Not now
          </Button>
        </div>
      ) : (
        !fromRun && <p className="text-[13px] text-muted-foreground">{doneWords ?? "Done. Runs from the Image, Video and Audio studios now use your GPU. Keep a Fuobe tab open while they run."}</p>
      )}
    </div>
  );
}

export interface ThisComputerProps {
  /** Connect "this computer" on the server (an account's Your GPU, or the owner's setting). */
  connect: () => Promise<void>;
  /** Opened from a run that needs a GPU: it starts by itself once connected. */
  fromRun?: boolean;
  /** What that run makes (image, video, audio). */
  kind?: string;
  /** Start the run (fromRun), then close. */
  onStart?: () => void;
  onNotNow?: () => void;
  /** Look at once (Settings, after the person picked this option; ComfyUI needs the setting again). */
  autoLook?: boolean;
  /** ComfyUI had Fuobe's setting before, and runs without it now (the fix says so). */
  again?: boolean;
  /** The last line once connected, when it wasn't opened from a run (the owner's own words). */
  doneWords?: string;
  /** Changes when something outside asks to look now ("Use the ComfyUI on this computer" under a refused address). */
  lookNow?: number;
  /**
   * Wait for "Find my ComfyUI", even when the browser lets Fuobe in already: a card that only shows the choice (Settings,
   * /connect, a dialog opened without a run) never moves the runs to this computer by itself.
   */
  waitForTap?: boolean;
}

/**
 * Does this ComfyUI keep other websites out: Fuobe Connect (it answers at /fuobe/connect, and leaves ComfyUI's own check
 * on for every other site), or Fuobe's guard (at /fuobe/guard)?
 */
type Guarded = "connect" | "guard" | false;

const guardAt = async (port: number, host: string): Promise<Guarded> => {
  const read = (path: string, ok: (a: unknown) => boolean) =>
    loopbackFetch(`${localBase(port, host)}${path}`, { credentials: "omit", cache: "no-store" }).then(
      (r) => (r.ok ? r.json().then(ok, () => false) : false),
      () => false,
    );
  if (await read("/fuobe/connect", isConnectAnswer)) return "connect";
  return (await read("/fuobe/guard", isGuard)) ? "guard" : false;
};

/** The whole flow, from "Find my ComfyUI" to connected. */
export function ThisComputer({ connect, fromRun, kind, onStart, onNotNow, autoLook, again, doneWords, lookNow, waitForTap }: ThisComputerProps) {
  const qc = useQueryClient();
  const { state, look, choose, checking, perm } = useLocalComfy(true, { auto: !waitForTap });
  const [done, setDone] = useState<Connected | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connecting = useRef<string | null>(null);
  const autoLooked = useRef(false);

  useEffect(() => {
    if (!autoLook || autoLooked.current || state.s !== "start") return;
    autoLooked.current = true;
    void look();
  }, [autoLook, state.s, look]);

  // Asked from outside: look now (from the start screen, or after nothing answered).
  const looked = useRef(lookNow ?? 0);
  useEffect(() => {
    if (!lookNow || lookNow === looked.current) return;
    looked.current = lookNow;
    if (state.s === "start" || state.s === "none") void look();
  }, [lookNow, state.s, look]);

  // Found and readable: connect with no click, then check what it has.
  useEffect(() => {
    if (state.s !== "found") return;
    const key = `${state.host}:${state.port}`;
    if (connecting.current === key) return;
    connecting.current = key;
    const { port, host, stats } = state;
    void (async () => {
      try {
        await connect();
        rememberComfy(port, host);
        store("reached", "1");
        store("install", installFromStats(stats, port, platformOf(nav())));
        // The tab that runs the jobs goes there now (another port, or a browser that only listened until now).
        const running = computerState().view;
        if (running && (running.port !== port || running.access)) restartComputerRunner();
        const guard = await guardAt(port, host);
        setError(null);
        setDone({ port, stats, guard });
        void qc.invalidateQueries({ queryKey: ["viewer"] });
        void qc.invalidateQueries({ queryKey: ["account-gpu"] });
        // What the account may do now (its own files are taken, useAskBeforeUpload): the status says so.
        void qc.invalidateQueries({ queryKey: ["status"] });
        try {
          const board = await sendCheck<ReadinessView>(await checkThisComputer(port, { host }));
          qc.setQueryData(["gpu", "readiness"], board);
          void qc.invalidateQueries({ queryKey: ["gpu", "badges"] });
          void qc.invalidateQueries({ queryKey: ["gpu", "plan"] });
          setDone({ port, stats, guard, board });
        } catch {
          setDone({ port, stats, guard, checkFailed: true });
        }
      } catch (e) {
        connecting.current = null;
        setError((e as Error).message);
      }
    })();
  }, [state, connect, qc]);

  if (done) return <Celebration c={done} fromRun={fromRun} kind={kind} onStart={onStart} onNotNow={onNotNow} doneWords={doneWords} />;
  return (
    <div className="space-y-3 text-[13px]">
      <Screen state={state} look={look} choose={choose} checking={checking} again={again} asks={perm !== "granted"} />
      {error && <p className="text-[12px] text-destructive">{error}</p>}
    </div>
  );
}

/** Waiting for ComfyUI to start; after two minutes, what to check. */
function WaitingScreen({ port, since, onLook }: { port: number; since: number; onLook: () => void }) {
  const now = useNow(1000);
  const long = now - since >= 120_000;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 font-medium">
        <Loader2 className="size-4 animate-spin" /> Waiting for ComfyUI to start…
      </p>
      {!long ? (
        <p className="text-[12px] text-muted-foreground">This usually takes 10 to 30 seconds.</p>
      ) : (
        <div className="space-y-2 text-[12px] text-muted-foreground">
          <p>Still waiting. Is ComfyUI&apos;s window open? It says &ldquo;To see the GUI go to: http://127.0.0.1:{port}&rdquo; when it&apos;s ready.</p>
          <p>Check that the address is exactly {origin()}, with nothing after it.</p>
          <Button size="sm" variant="secondary" onClick={onLook}>
            <RefreshCw /> Check again
          </Button>
        </div>
      )}
    </div>
  );
}

/** `asks`: the browser may still ask to let Fuobe reach apps on this computer (its question is explained). */
function Screen({
  state,
  look,
  choose,
  checking,
  again,
  asks,
}: {
  state: Finder;
  look: ReturnType<typeof useLocalComfy>["look"];
  choose: (port: number) => void;
  checking: number | null;
  again?: boolean;
  asks: boolean;
}) {
  const lookAt = (port: number, host: string) => void look({ ports: [{ port, host }] });
  const checkAgain = () => void look();
  switch (state.s) {
    case "unsupported":
      return (
        <div className="space-y-3">
          <p className="flex items-start gap-2 text-muted-foreground">
            <MonitorSmartphone className="mt-0.5 size-4 shrink-0" /> <span>{unsupportedWords(state.why)}</span>
          </p>
          {FUOBE_CONNECT_PUBLISHED && <PairInstead />}
        </div>
      );
    case "start":
      return (
        <div className="space-y-3">
          {FUOBE_CONNECT_PUBLISHED && <InstallConnect then="Already have it? Skip this step." />}
          <Button className="h-11 sm:h-9" onClick={() => void look()}>
            <Search /> Find my ComfyUI
          </Button>
          {asks && <AllowNote />}
        </div>
      );
    case "looking":
      return (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Looking for ComfyUI on this computer…
          </p>
          {asks && <AllowNote />}
        </div>
      );
    case "found":
      return (
        <p className="flex items-center gap-2">
          <Check className="size-4 text-brand-text" /> Found ComfyUI on port {state.port}. Connecting…
        </p>
      );
    case "needs-setting":
      return (
        <SettingFix
          key={state.port}
          port={state.port}
          back={state.back}
          again={again}
          weak={state.weak}
          others={state.others}
          missed={state.missed}
          notComfy={state.notComfy}
          checking={checking}
          onChoose={choose}
          onCheck={checkAgain}
        />
      );
    case "waiting":
      return <WaitingScreen port={state.port} since={state.since} onLook={checkAgain} />;
    case "none":
      return (
        <div className="space-y-3">
          <div>
            <p className="text-[15px] font-medium">No ComfyUI found on this computer.</p>
            <p className="mt-1 text-muted-foreground">Start ComfyUI, then check again.</p>
          </div>
          <Button className="h-11 sm:h-9" onClick={checkAgain}>
            <RefreshCw /> Check again
          </Button>
          <Watching>Fuobe also looks for it by itself every few seconds.</Watching>
          <OtherPort onLook={lookAt} missed={state.missed} notComfy={state.notComfy} />
          <p className="text-[12px] text-muted-foreground">
            Don&apos;t have ComfyUI?{" "}
            <a href="https://www.comfy.org/download" target="_blank" rel="noreferrer" className="text-brand-text underline-offset-4 hover:underline">
              Get ComfyUI Desktop
            </a>
          </p>
        </div>
      );
    case "blocked":
      return (
        <div className="space-y-2">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 text-amber-600 dark:text-amber-400" /> Your browser is blocking Fuobe from reaching apps on this computer.
          </p>
          <p className="text-[12px] text-muted-foreground">{blockedSteps()}</p>
          <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
            <RefreshCw /> Reload
          </Button>
          {FUOBE_CONNECT_PUBLISHED && <PairInstead className="mt-2" />}
        </div>
      );
  }
}
