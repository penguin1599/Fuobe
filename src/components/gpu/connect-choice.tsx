"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChevronDown, Cpu, Globe, Info, Loader2, TriangleAlert, Unplug } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { toast } from "sonner";
import { ConnectField, useAllowPrivate, useSettings, type PublicSetting } from "@/components/connect-field";
import { gib } from "@/components/gpu/comfy-finder";
import { YourGpu } from "@/components/gpu/your-gpu";
import { AiSetupPanel } from "@/components/gpu/ai-setup/ai-setup-panel";
import { AI_SETUP_HREF, AiSetupRow } from "@/components/gpu/ai-setup/ai-setup-row";
import { Button } from "@/components/ui/button";
import { deviceLabel } from "@/lib/gpu/readiness";
import { useStatus, useViewer } from "@/lib/api";
import type { OwnerGpuView } from "@/lib/connections";
import { addressKind, refusedOnHosted } from "@/lib/page-place";
import { cn } from "@/lib/utils";
import { restartComputerRunner, rememberComfy, rememberedComfy } from "./computer-runtime";
import { PairedComfyUIs } from "./fuobe-connect";
import { GuardFix, SettingFix, ThisComputer, unsupportedWords } from "./this-computer";
import { lookOn, useComputerSupport, usePagePlace } from "./use-local-comfy";
import { openConnect, openFinder, useComputerState, type FindReason } from "./computer-runner";

/**
 * "Connect your GPU": the ComfyUI on this computer first (the quickest way: nothing to install, runs while Fuobe is
 * open in this browser). For an account, a link (a tunnel) second, for runs that go on with the tab closed; for the
 * owner of a hosted studio, a ComfyUI at a server address (a cloud GPU, a tunnel). On a phone, in Safari, or on a page
 * that can't ask for the permission, only the second way, with why; or, when the computer was connected from another
 * browser, its state (runs started here go to it), with the second way on request.
 */

export type AccountGpuView = OwnerGpuView | { mode: "link"; url: string; hasToken: boolean };

type ComputerView = Extract<AccountGpuView, { mode: "computer" }>;

async function gpuCall<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch("/api/account/gpu", { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? "Something went wrong. Please try again.");
  return j;
}

export function useAccountGpu(enabled = true) {
  return useQuery({ queryKey: ["account-gpu"], queryFn: () => gpuCall<{ gpu: AccountGpuView | null }>("GET"), enabled });
}

/** Turn "this computer" on for the signed-in account. */
export async function connectThisComputer(): Promise<void> {
  await gpuCall("PUT", { mode: "computer" });
}

/** `disconnect`: the owner pressed Disconnect (the runs that stop say so, not "ComfyUI now runs somewhere else"). */
async function putWhere(where: "server" | "computer", disconnect = false): Promise<void> {
  const res = await fetch(disconnect ? "/api/settings?why=disconnected" : "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comfyWhere: where }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong. Please try again.");
}

/** The owner's: ComfyUI runs on the computer the owner uses (Settings → Where ComfyUI runs). */
export async function connectOwnerComputer(): Promise<void> {
  await putWhere("computer");
}

/** The owner's ComfyUI goes back to the server's address (the runs still waiting for the computer stop, saying why). */
export async function disconnectOwnerComputer(qc: QueryClient): Promise<void> {
  await putWhere("server", true);
  for (const key of ["viewer", "status", "settings"]) void qc.invalidateQueries({ queryKey: [key] });
}

/** The owner's last line once the computer is connected. */
const OWNER_DONE = "Done. Your open-source runs now go to this computer. Keep a Fuobe tab open here while they run.";

const ABOUT =
  "Fuobe's setting lets the Fuobe page use your ComfyUI. On its own, it would also let other websites send work to your ComfyUI if your browser lets them reach apps on this computer (Chrome, Edge and Firefox ask you first). Fuobe's guard, a small file in ComfyUI's custom_nodes folder, turns them away. To turn the setting off, start ComfyUI the usual way.";

/**
 * What this browser knows of the ComfyUI on this computer, when one of its tabs runs the jobs (or would, once allowed):
 * that tab's own look beats the server's word. Null when this browser doesn't run them (another computer has the jobs,
 * or no tab of this browser holds them yet).
 */
function useHere() {
  const local = useComputerState();
  if (local.holder === "other") return { other: true as const };
  const v = local.holder === "this" ? local.view : null;
  if (!v || v.stopped || v.heldElsewhere) return null;
  // Runs this tab is working on, or that wait for it: Disconnect would stop them.
  const busy = v.waiting > 0 || v.jobs.some((j) => j.phase !== "done" && j.phase !== "failed");
  return { other: false as const, comfy: v.comfy, access: v.access, port: v.port, facts: v.facts, busy };
}

const Act = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button type="button" className="font-medium text-brand-text underline-offset-4 hover:underline" onClick={onClick}>
    {children}
  </button>
);

/** What is wrong with the ComfyUI on this computer, as this browser sees it, with its one fix; elsewhere the server's word. */
function ComputerProblem({ here, server }: { here: ReturnType<typeof useHere>; server?: "down" | "no-setting" }) {
  if (here?.other) return <p className="text-[12px] text-muted-foreground">Running in another Fuobe tab of this browser.</p>;
  if (here) {
    if (here.access === "ask")
      return (
        <p className="text-[12px] text-muted-foreground">
          This browser hasn&apos;t been allowed to reach ComfyUI yet. <Act onClick={() => openFinder("browser")}>Connect</Act>
        </p>
      );
    if (here.access === "blocked")
      return (
        <p className="text-[12px] text-muted-foreground">
          Your browser is blocking Fuobe from reaching ComfyUI on this computer. <Act onClick={() => openFinder("browser")}>Show me how</Act>
        </p>
      );
    if (here.comfy === "down")
      return (
        <p className="text-[12px] text-muted-foreground">
          ComfyUI isn&apos;t running on this computer. Start it, and Fuobe connects by itself. <Act onClick={() => openFinder("find")}>Find my ComfyUI</Act>
        </p>
      );
    if (here.comfy === "no-setting")
      return (
        <div className="mt-2">
          <SettingFix key={here.port} port={here.port} back={false} again />
        </div>
      );
    return null;
  }
  // The server's word: this browser doesn't hold the jobs (a phone, Safari, another computer). The tab that runs them is
  // in the browser that connected the computer, which may be on this very computer: never "open Fuobe" as if it weren't.
  return <p className="text-[12px] text-muted-foreground">{SERVER_PROBLEM[server ?? "offline"]}</p>;
}

const SERVER_PROBLEM: Record<"down" | "no-setting" | "offline", string> = {
  down: "ComfyUI isn't running on your computer. Start it, and your runs go on by themselves.",
  "no-setting": "ComfyUI on your computer needs Fuobe's setting again. The Fuobe tab in the browser you connected it from shows how.",
  offline: "Offline. Your runs start when a Fuobe tab is open in the browser you connected your computer from.",
};

/** "Other websites could also send work to your ComfyUI": the guard isn't in it yet. */
function NoGuard({ port }: { port: number }) {
  return (
    <div className="space-y-1.5">
      <p className="flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Other websites could also send work to your ComfyUI. Add Fuobe&apos;s guard to turn them away:
      </p>
      <GuardFix port={port} />
    </div>
  );
}

/**
 * "This computer · RTX 5090 · port 8188 · Ready", another port, the other way to connect, Disconnect. `look`: this
 * browser can reach a ComfyUI on its computer (not a phone): the port can be changed from here.
 */
function ComputerStatus({ gpu, onDisconnect, other, look = true }: { gpu: ComputerView; onDisconnect: () => Promise<void>; other: { label: string; onClick: () => void }; look?: boolean }) {
  const here = useHere();
  const [busy, setBusy] = useState(false);
  const [about, setAbout] = useState(false);
  const [port, setPort] = useState(String(rememberedComfy()?.port ?? gpu.port ?? 8188));
  const [note, setNote] = useState<string | null>(null);
  const [fixPort, setFixPort] = useState<number | null>(null);
  // A tab of this browser runs the jobs: what it sees now. Elsewhere (a phone, another computer has them): the server.
  const mine = here && !here.other ? here : null;
  const online = mine ? mine.comfy === "ok" && !mine.access : gpu.online;
  const shownPort = mine?.port ?? (look ? rememberedComfy()?.port : undefined) ?? gpu.port;
  const facts = [gpu.device && deviceLabel(gpu.device), gib(gpu.vramBytes), shownPort && `port ${shownPort}`].filter(Boolean).join(" · ");
  const guard = mine?.facts ? mine.facts.guard : gpu.guard;
  const lookAt = async () => {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setNote("Enter the port ComfyUI shows, like 8188.");
    setNote(null);
    setFixPort(null);
    const l = await lookOn(p);
    if (l.state === "none") return setNote(`Nothing answered on port ${p}.`);
    if (l.state === "other") return setNote(`Another app answers on port ${p}, not ComfyUI.`);
    // The tab that runs the jobs goes there; it needs the setting first, the fix shows here.
    rememberComfy(p);
    restartComputerRunner();
    if (l.state === "found") setNote(`Found ComfyUI on port ${p}. Fuobe uses it from now on.`);
    else setFixPort(p);
  };
  const remove = async () => {
    setBusy(true);
    try {
      await onDisconnect();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 text-[13px]">
      <div className="flex items-start gap-2.5 rounded-xl bg-brand-faint px-3 py-2.5">
        <Cpu className="mt-0.5 size-4 shrink-0 text-brand-text" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {look ? "This computer" : "Your computer"}
            {online ? " · Ready" : ""}
          </p>
          {online ? <p className="truncate text-[12px] text-muted-foreground">{facts || "Your ComfyUI"}</p> : <ComputerProblem here={here} server={gpu.comfy} />}
        </div>
        <Button size="sm" variant="ghost" className="-my-1 h-7" onClick={() => void remove()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Unplug />} Disconnect
        </Button>
      </div>
      {!look && online && <p className="text-[12px] text-muted-foreground">Runs you start from here go to your computer.</p>}
      {mine?.busy && <p className="text-[12px] text-muted-foreground">Disconnect stops the runs going on now.</p>}
      {gpu.cors === "any" && <p className="text-[12px] text-amber-700 dark:text-amber-400">Your ComfyUI lets every website in. To keep it private, start it with --enable-cors-header {window.location.origin} instead.</p>}
      {look && online && guard === false && gpu.cors !== "any" && shownPort && <NoGuard port={shownPort} />}
      {look && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted-foreground">ComfyUI on another port?</span>
          <input aria-label="ComfyUI's port" inputMode="numeric" className="h-8 w-20 rounded-md border bg-background px-2 text-[13px]" value={port} onChange={(e) => setPort(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void lookAt()} />
          <Button size="sm" variant="secondary" className="h-8" onClick={() => void lookAt()}>
            Look
          </Button>
        </div>
      )}
      {note && <p className="text-[12px] text-muted-foreground">{note}</p>}
      {fixPort && <SettingFix key={fixPort} port={fixPort} back={false} />}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
        <button type="button" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={other.onClick}>
          {other.label}
        </button>
        <button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setAbout((v) => !v)}>
          About this setting <ChevronDown className={cn("size-3.5 transition-transform", about && "rotate-180")} />
        </button>
      </div>
      {about && <p className="text-[12px] text-muted-foreground">{ABOUT}</p>}
    </div>
  );
}

/** The two ways, as cards: this computer (primary), and the second way behind a disclosure. */
function ChoiceCards({
  instead,
  computer,
  title,
  sub,
  open,
  onToggle,
  children,
  className,
}: {
  /** The second way is connected: this computer is offered "instead". */
  instead: boolean;
  computer: React.ReactNode;
  title: string;
  sub: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** 36rem wide at most from sm up, unless a wider page lifts that (ConnectChoice's className). */
  className?: string;
}) {
  return (
    <div className={cn("w-full min-w-0 space-y-3 sm:max-w-[36rem]", className)}>
      <div className={cn("space-y-3 rounded-2xl border bg-background p-4", !instead && "border-primary/40")}>
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Cpu className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-medium">{instead ? "Use the ComfyUI on this computer instead" : "Use the ComfyUI on this computer"}</p>
            <p className="text-[13px] text-muted-foreground">The quickest way. Runs while Fuobe is open in this browser.</p>
          </div>
        </div>
        {computer}
      </div>
      <div className="rounded-2xl border border-dashed p-4">
        <button type="button" className="flex w-full items-start gap-3 text-left" onClick={onToggle} aria-expanded={open}>
          <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{title}</span>
            <span className="block text-[12px] text-muted-foreground">{sub}</span>
          </span>
          <ChevronDown className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        {open && <div className="mt-3">{children}</div>}
      </div>
    </div>
  );
}

/**
 * The way under a refused address, inside the choice: start this computer's finder there ("Use the ComfyUI on this
 * computer"), or, while ComfyUI runs there already, fold the server address away ("Keep using this computer").
 */
const FindHere = createContext<{ label: string; go: () => void } | null>(null);

/**
 * A ComfyUI address the server must not call from a hosted page (127.0.0.1 is the server itself there): what that
 * address means here, in one line, and the way that reaches the owner's own computer.
 */
export function HostedRefusal({ line }: { line: string }) {
  const find = useContext(FindHere);
  const support = useComputerSupport();
  return (
    <div className="mt-1 space-y-2 rounded-xl bg-brand-faint px-3 py-2.5 text-[13px]">
      <p className="flex items-start gap-1.5">
        <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand-text" /> {line}
      </p>
      {support === "ok" && (
        <Button size="sm" onClick={() => (find ? find.go() : openConnect(true))}>
          <Cpu /> {find?.label ?? "Use the ComfyUI on this computer"}
        </Button>
      )}
    </div>
  );
}

/**
 * The owner's ComfyUI at a server address: a cloud GPU, a tunnel to the owner's own, or (on the server's own machine)
 * 127.0.0.1. On a hosted studio the built-in 127.0.0.1 isn't shown, and an address on the server's machine or network
 * is refused before anything is sent. While ComfyUI runs on the owner's computer, a green test moves it to the server.
 * `onlyAddress`: the address alone (the first-run guide). On a hosted page the second ComfyUI (the isolated worker) is
 * only in Settings (`advanced`), never in the connect dialog.
 */
export function OwnerServerComfy({
  hosted,
  computer = false,
  onlyAddress = false,
  advanced = false,
  onConnected: then,
}: {
  hosted: boolean;
  computer?: boolean;
  onlyAddress?: boolean;
  advanced?: boolean;
  /** After a green test: the card a refused run opened closes, and the run starts. */
  onConnected?: () => void;
}) {
  const qc = useQueryClient();
  const settings = useSettings().data;
  const status = useStatus().data;
  const get = (n: string) => settings?.find((s) => s.name === n);
  // A server ComfyUI that answers works for the server, wherever this page is: only a newly typed address is checked.
  const trustSaved = !computer && !!status?.providers.comfyui?.configured;
  const place = hosted ? ("hosted" as const) : undefined;
  const refusal = hosted ? (line: string) => <HostedRefusal line={line} /> : undefined;
  const connected = (r: { detail: string }) => {
    toast.success("ComfyUI connected", { description: r.detail });
    void qc.invalidateQueries({ queryKey: ["viewer"] });
    then?.();
  };
  return (
    <div className="space-y-4">
      <ConnectField
        name="comfyUrl"
        setting={get("comfyUrl")}
        provider="comfyui"
        label={hosted ? "Server address" : "ComfyUI server URL"}
        idleLabel="Connect"
        placeholder={hosted ? "https://…" : "http://127.0.0.1:8188"}
        hint={hosted ? "A web address Fuobe's server can reach: a cloud GPU, or the ComfyUI on your computer through cloudflared." : "Where ComfyUI listens; a local install is http://127.0.0.1:8188."}
        hideDefault={hosted}
        extraValues={computer ? { comfyWhere: "server" } : undefined}
        place={place}
        trustSaved={trustSaved}
        refusal={refusal}
        onConnected={connected}
      />
      {!onlyAddress && (
        <ConnectField
          name="comfyToken"
          setting={get("comfyToken")}
          provider="comfyui"
          label={hosted ? "Access token (optional)" : "Auth token (optional)"}
          hint={hosted ? "For a ComfyUI behind a login or a proxy." : "Sent as a Bearer token, for ComfyUI behind a proxy."}
          place={computer ? undefined : place}
          trustSaved={trustSaved}
          refusal={refusal}
        />
      )}
      {!onlyAddress && !computer && (!hosted || advanced) && (
        <ConnectField
          name="comfyIsolatedUrl"
          setting={get("comfyIsolatedUrl")}
          provider="comfyui"
          label={hosted ? "Second ComfyUI for lip sync and sound (optional)" : "Isolated worker URL (optional)"}
          placeholder={hosted ? "https://…" : "http://127.0.0.1:8189"}
          hint={
            hosted
              ? "LatentSync 1.6 and ThinkSound need add-ons that can't share your main ComfyUI. Give the address of a second one here."
              : "A second ComfyUI for LatentSync 1.6 and ThinkSound, whose node packs can't share the main install. scripts/comfy/README.md shows how to start one."
          }
          place={place}
          refusal={refusal}
        />
      )}
      {!onlyAddress && !computer && (!hosted || advanced) && <WorldcastField get={get} hosted={hosted} />}
      {computer && <p className="text-[12px] text-muted-foreground">Connecting a server address stops the runs still going on your computer.</p>}
    </div>
  );
}

/**
 * The WorldCast worker's address (build plan N7-9; docs/workers/worldcast.md), beside the isolated worker: Fly path,
 * Turnaround and the exact orbits film with WorldCast while it answers.
 */
export function WorldcastField({ get, hosted = false }: { get: (n: string) => PublicSetting | undefined; hosted?: boolean }) {
  const place = hosted ? ("hosted" as const) : undefined;
  return (
    <ConnectField
      name="worldcastUrl"
      setting={get("worldcastUrl")}
      provider="comfyui"
      label="WorldCast worker URL (optional)"
      placeholder={hosted ? "https://…" : "http://127.0.0.1:8190"}
      hint="WorldCast films Fly path, Turnaround and exact orbits so the back and sides match your photos. It runs beside ComfyUI on a GPU with 48 GB or more: workers/worldcast/README.md shows how to start it."
      place={place}
      refusal={hosted ? (line: string) => <HostedRefusal line={line} /> : undefined}
    />
  );
}

export interface ConnectChoiceProps {
  /** Opened from a run: once connected, the run starts by itself. */
  fromRun?: boolean;
  /** What that run makes (image, video, audio). */
  kind?: string;
  /**
   * Opened by the note of the tab that runs the jobs: ComfyUI needs the setting again, or doesn't answer (both look at
   * once), or this browser hasn't been allowed to reach it yet (the browser's question is explained first).
   */
  reason?: FindReason;
  /** Connected, from this computer or with a link: the card that asked can close (and a refused run start again). */
  onStart?: () => void;
  onNotNow?: () => void;
  /** The two options' box (and the link's form): 36rem at most from sm up, unless a wider page lifts that (sm:max-w-none). */
  className?: string;
  /**
   * Opened by a button that already said "Use the ComfyUI on this computer" (the guide, the account menu's Connect): look at
   * once. Without it (and without a run or a reason) the finder waits for "Find my ComfyUI": a card that only shows the
   * choice (Settings, /connect) never moves the runs to this computer by itself.
   */
  look?: boolean;
  /** Settings: the owner's server way has the second ComfyUI (the isolated worker) too. */
  advanced?: boolean;
  /** Start with "Set it up with my AI" open (an account's; /connect?setup=ai). */
  ai?: boolean;
}

export function ConnectChoice(props: ConnectChoiceProps) {
  const viewer = useViewer().data;
  if (!viewer) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  return viewer.owner ? <OwnerChoice {...props} /> : <AccountChoice {...props} />;
}

function AccountChoice({ fromRun, kind, reason, onStart, onNotNow, className, look, ai: startAi }: ConnectChoiceProps) {
  const qc = useQueryClient();
  const support = useComputerSupport();
  const q = useAccountGpu();
  const gpu = q.data?.gpu ?? null;
  const live = useStatus().data?.viewer?.gpu;
  // Once the person starts finding their ComfyUI, the flow stays on screen through to "connected".
  const [flow, setFlow] = useState(!!reason);
  const [link, setLink] = useState(false);
  // "Set it up with my AI": in place for a refused run (the run starts once connected), else its own page.
  const [ai, setAi] = useState(!!startAi);
  if (q.isError) return <p className="text-[13px] text-muted-foreground">{q.error.message}</p>;
  if (!q.data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  if (ai) return <AiSetupPanel onBack={() => setAi(false)} fromRun={fromRun} kind={kind} onStart={onStart} onNotNow={onNotNow} />;
  // Shown while nothing answers: "Fix it" when a GPU is saved but offline or needs the setting.
  const online = !!gpu && !!live?.connected && !!live.online;
  const aiRow = !online && !reason && <AiSetupRow fix={!!gpu} {...(fromRun ? { onOpen: () => setAi(true) } : { href: AI_SETUP_HREF })} className={cn("sm:max-w-[36rem]", className)} />;
  const disconnect = async () => {
    qc.setQueryData(["account-gpu"], await gpuCall("DELETE"));
    void qc.invalidateQueries({ queryKey: ["viewer"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
  if (support !== "ok") {
    // A phone, Safari, a plain-http page: nothing looks for a ComfyUI on this device.
    // Connected with "this computer" already (from another browser): runs started here go to it, so its state comes
    // first, and the web address (which would take the runs off it) only on request.
    if (gpu?.mode === "computer")
      return (
        <div className="space-y-4">
          {aiRow}
          <ComputerStatus gpu={gpu} look={false} onDisconnect={disconnect} other={{ label: link ? "Keep using your computer" : "Use a web address instead", onClick: () => setLink((v) => !v) }} />
          {link && (
            <>
              <p className="text-[12px] text-muted-foreground">Once a web address is connected, your runs go there instead of to your computer.</p>
              <YourGpu className={className} onLinked={onStart} />
            </>
          )}
        </div>
      );
    // Why not this computer, then the web address form (once connected, the form alone says so).
    return (
      <div className="space-y-4">
        {aiRow}
        {!gpu && <p className="rounded-xl bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">{unsupportedWords(support)}</p>}
        <YourGpu className={className} onLinked={onStart} />
      </div>
    );
  }
  if (gpu?.mode === "computer" && !flow && !link)
    return (
      <div className="space-y-4">
        {aiRow}
        <ComputerStatus gpu={gpu} onDisconnect={disconnect} other={{ label: "Use a link instead", onClick: () => setLink(true) }} />
      </div>
    );
  const linked = gpu?.mode === "link";
  return (
    <div className="space-y-3">
      {aiRow}
      <ChoiceCards
        className={className}
        instead={linked}
        title="Keep it running with this tab closed"
        sub="Give your ComfyUI a web address. Takes about two minutes."
        open={link || linked}
        onToggle={() => setLink((v) => !v)}
        computer={
          <div onClickCapture={() => setFlow(true)}>
            <ThisComputer
              connect={async () => {
                setFlow(true);
                await connectThisComputer();
              }}
              fromRun={fromRun}
              kind={kind}
              onStart={onStart}
              onNotNow={onNotNow}
              autoLook={reason === "setting" || reason === "find" || look}
              again={reason === "setting"}
              waitForTap={!fromRun && !reason && !look}
            />
          </div>
        }
      >
        <YourGpu className={className} onLinked={onStart} />
      </ChoiceCards>
    </div>
  );
}

/**
 * The owner's choice. On a hosted studio (the page isn't on the server's machine): the ComfyUI on this computer first,
 * a ComfyUI at a server address second. On the server's own machine or network: the server address, as before (the
 * computer is in Settings' "Where ComfyUI runs"). While ComfyUI runs on the owner's computer: its state, with
 * Disconnect and the server address as the other way.
 */
function OwnerChoice({ fromRun, kind, reason, onStart, onNotNow, className, look, advanced }: ConnectChoiceProps) {
  const qc = useQueryClient();
  const support = useComputerSupport();
  const place = usePagePlace();
  const status = useStatus().data;
  const settings = useSettings().data;
  const allowPrivate = useAllowPrivate(place === "hosted");
  // Once the person starts finding their ComfyUI, the flow stays on screen through to "connected".
  const [flow, setFlow] = useState(!!reason);
  // The server way, opened or closed by hand (until then: open when an address is saved or connected).
  const [serverOpen, setServerOpen] = useState<boolean | null>(null);
  const [lookNow, setLookNow] = useState(0);
  // This computer's finder looks by itself only when the person asked for this computer (a run, a reason, a button that
  // said so). Anywhere else, and after Disconnect, it waits for "Find my ComfyUI".
  const [armed, setArmed] = useState<"tap" | "look">(look ? "look" : "tap");
  const thisComputer = (
    <ThisComputer
      connect={async () => {
        setFlow(true);
        await connectOwnerComputer();
        void qc.invalidateQueries({ queryKey: ["settings"] });
        void qc.invalidateQueries({ queryKey: ["status"] });
      }}
      fromRun={fromRun}
      kind={kind}
      onStart={onStart}
      onNotNow={onNotNow}
      autoLook={reason === "setting" || reason === "find" || armed === "look"}
      again={reason === "setting"}
      doneWords={OWNER_DONE}
      lookNow={lookNow}
      waitForTap={!fromRun && !reason && armed === "tap"}
    />
  );
  // Opened by the note of the tab that runs the jobs: straight to the finder, as before.
  if (reason) return support !== "ok" ? <p className="text-[13px] text-muted-foreground">{unsupportedWords(support, true)}</p> : thisComputer;
  if (!settings || !status || place === null) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const computer = settings.find((s) => s.name === "comfyWhere")?.value === "computer";
  const hosted = place === "hosted" && status.engineMode !== "cloud";
  const serverConnected = !computer && !!status.providers.comfyui?.configured;
  const address = settings.find((s) => s.name === "comfyUrl");
  // Opens by itself for a server address of the owner's: connected, or saved and one the server may call from here.
  const usable = !!address?.isSet && !(hosted && refusedOnHosted(addressKind(address.value), allowPrivate));
  const open = serverOpen ?? (serverConnected || usable);
  const serverForm = <OwnerServerComfy hosted={hosted} computer={computer} advanced={advanced} onConnected={fromRun ? onStart : undefined} />;
  const findHere = {
    label: "Use the ComfyUI on this computer",
    go: () => {
      setServerOpen(false);
      setFlow(true);
      setArmed("look");
      setLookNow((n) => n + 1);
    },
  };
  // ComfyUI runs on this computer already: a refused server address only folds away.
  const keepHere = { label: "Keep using this computer", go: () => setServerOpen(false) };
  const disconnect = async () => {
    await disconnectOwnerComputer(qc);
    setArmed("tap");
    setFlow(false);
    setServerOpen(null);
  };
  const state = computer ? (
    <ComputerStatus
      gpu={status.ownerGpu ?? { mode: "computer", online: false }}
      look={support === "ok"}
      onDisconnect={disconnect}
      other={{ label: "Use a server address instead", onClick: () => setServerOpen((v) => !(v ?? false)) }}
    />
  ) : null;
  const serverBox = (
    <div className="rounded-2xl border border-dashed p-4">
      <p className="mb-3 text-[13px] font-medium">Use a ComfyUI on a server</p>
      {serverForm}
    </div>
  );

  // A page on the server's own machine or its network: the server address, as before (the computer is in Settings'
  // "Where ComfyUI runs").
  if (!hosted)
    return (
      <div className={cn("w-full min-w-0 space-y-3 sm:max-w-[36rem]", className)}>
        {state}
        {computer ? serverOpen && serverBox : serverForm}
      </div>
    );
  // A phone, Safari, a plain-http page. While ComfyUI runs on the owner's computer, runs started here go to it: its
  // state, and the server way (which would stop them) only on request. Otherwise why not here, and the server way.
  if (support !== "ok")
    return (
      <div className={cn("w-full min-w-0 space-y-3 sm:max-w-[36rem]", className)}>
        {computer ? (
          <>
            {state}
            {serverOpen && serverBox}
          </>
        ) : (
          <>
            <p className="rounded-xl bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">{unsupportedWords(support, true)}</p>
            {serverBox}
          </>
        )}
      </div>
    );
  if (computer && !flow)
    return (
      <FindHere.Provider value={keepHere}>
        <div className={cn("w-full min-w-0 space-y-3 sm:max-w-[36rem]", className)}>
          {state}
          {serverOpen && serverBox}
        </div>
      </FindHere.Provider>
    );
  return (
    <FindHere.Provider value={findHere}>
      <ChoiceCards
        className={className}
        instead={serverConnected}
        title="Use a ComfyUI on a server"
        sub="A cloud GPU or a tunnel address. Runs go on with this tab closed."
        open={open}
        onToggle={() => setServerOpen(!open)}
        computer={<div onClickCapture={() => setFlow(true)}>{thisComputer}</div>}
      >
        {serverForm}
      </ChoiceCards>
    </FindHere.Provider>
  );
}

/**
 * The owner's "Where ComfyUI runs" (Settings → Open-source engine · ComfyUI, on the server's own machine or network):
 * on this server, at the address below, or on the computer the owner uses, which the owner's own Fuobe tab runs.
 */
export function OwnerComfyWhere({ value, onChange }: { value: string; onChange: (v: "server" | "computer") => Promise<unknown> }) {
  const qc = useQueryClient();
  const support = useComputerSupport();
  const [picking, setPicking] = useState(false);
  const computer = value === "computer";
  const choices = [
    { id: "server" as const, title: "On this server", body: "Fuobe calls ComfyUI at the address below, with or without a tab open." },
    { id: "computer" as const, title: "On the computer you're using", body: "Your Fuobe tab runs the jobs on this computer's ComfyUI while it's open." },
  ];
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Where ComfyUI runs" className="grid gap-2 sm:grid-cols-2">
        {choices.map((c) => {
          const active = c.id === "computer" ? computer || picking : !computer && !picking;
          return (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                if (c.id === "server") {
                  setPicking(false);
                  if (computer) void onChange("server").then(() => qc.invalidateQueries({ queryKey: ["viewer"] }));
                } else if (!computer) setPicking(true);
              }}
              className={cn("flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors hover:bg-accent", active && "border-primary bg-brand-faint hover:bg-brand-faint")}
            >
              <span className="text-[14px] font-medium">{c.title}</span>
              <span className="text-[12px] text-muted-foreground">{c.body}</span>
            </button>
          );
        })}
      </div>
      {support !== "ok" && computer ? (
        // Set up from another browser: runs started here go there, and this page can't see that ComfyUI itself.
        <p className="text-[13px] text-muted-foreground">Your runs go to your computer while a Fuobe tab is open in the browser you connected it from.</p>
      ) : support !== "ok" && picking ? (
        <p className="text-[13px] text-muted-foreground">{unsupportedWords(support, true)}</p>
      ) : picking && !computer ? (
        <ThisComputer
          connect={async () => {
            await onChange("computer");
            void qc.invalidateQueries({ queryKey: ["viewer"] });
          }}
        />
      ) : computer ? (
        <OwnerComputerLine />
      ) : null}
      {computer && <p className="text-[12px] text-muted-foreground">Moving ComfyUI to this server stops the runs still going on your computer.</p>}
      <PairedComfyUIs />
    </div>
  );
}

/** "This computer · RTX 5090 · port 8188 · Ready" (or what's wrong), as this browser's tab sees it. */
export function OwnerComputerLine() {
  const here = useHere();
  const mine = here && !here.other ? here : null;
  const facts = mine?.facts;
  const ready = !!mine && mine.comfy === "ok" && !mine.access;
  return (
    <div className="flex items-start gap-2 text-[13px] text-muted-foreground">
      <Cpu className="mt-0.5 size-4 shrink-0 text-brand-text" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{ready && mine ? ["This computer", facts?.device && deviceLabel(facts.device), gib(facts?.vramBytes), `port ${mine.port}`, "Ready"].filter(Boolean).join(" · ") : "This computer"}</p>
        {!ready && <ComputerProblem here={here} />}
        {ready && mine && facts?.guard === false && facts.cors !== "any" && <NoGuard port={mine.port} />}
      </div>
    </div>
  );
}
