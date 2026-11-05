"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BotMessageSquare, Check, ChevronDown, ChevronLeft, ClipboardPaste, Copy, Ellipsis, Loader2, RefreshCw, Search, Send, Terminal } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { isLocalAddress } from "@/components/gpu/comfy-finder";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { useNow } from "@/components/studio/use-now";
import { useGpuBadges, useGpuCheck, useGpuPlan } from "@/hooks/use-gpu";
import { showCode, spokenCode } from "@/lib/ai-setup/code";
import { addressCauseOf, type AddressCause, type TabFacts } from "@/lib/ai-setup/facts";
import { FIRST_MODEL_NAME, firstModelOf, type FirstModel } from "@/lib/ai-setup/first-picture";
import { agentLine, AGENTS, AI_TARGETS, chatLink, fullInstructions, isAgent, prefillText, type Agent, type AiTarget } from "@/lib/ai-setup/handoff";
import { nextOf } from "@/lib/ai-setup/next-step";
import { isConnected, isDone, stepsOf } from "@/lib/ai-setup/steps";
import { BROWSER_LABEL, browserOf, OS_NAME, pickWay, WAY_LABEL, waysFor, type Os, type Way } from "@/lib/ai-setup/ways";
import { useStatus } from "@/lib/api";
import { copyText, copyWithToast } from "@/lib/clipboard";
import { platformOf } from "@/lib/comfy-install";
import { FUOBE_CONNECT_PUBLISHED } from "@/lib/fuobe-connect";
import { deviceLabel } from "@/lib/gpu/readiness";
import { cn } from "@/lib/utils";
import { useComputerSupport } from "../open-connect";
import { AllowNote, blockedSteps, GuardFix, OtherPort } from "../this-computer";
import { FinishCard, useFirstPicture } from "./first-picture";
import { SetupChecklist } from "./setup-checklist";
import { checkHere, useAutoConnect } from "./use-auto-connect";
import { useSetupProbe } from "./use-setup-probe";
import { useSetupSession } from "./use-setup-session";

/**
 * "Set it up with my AI" (accounts): the person's own AI (ChatGPT, Claude, or a coding agent on their computer) does the
 * setup steps, and this panel checks each one as it happens. It picks the way for this browser, makes a short-lived
 * setup code, and hands the AI a short message with two links: the steps for this way and computer, and the status
 * address for the code. The checklist ticks off what this tab sees; the AI reads the same from the status. It ends with
 * a first picture made on the person's own GPU. In place of ConnectChoice's content (a dialog, /connect, Settings).
 */

export interface AiSetupPanelProps {
  onBack: () => void;
  /** Opened by a refused run: once connected, that run starts (it is the first picture). */
  fromRun?: boolean;
  kind?: string;
  onStart?: () => void;
  onNotNow?: () => void;
}

type GpuView = { gpu: { mode: "computer" } | { mode?: "link"; url: string } | null };

const AGENT_KEY = "fuobe.ai-setup.agent";
const STUCK_MS = 240_000;
const GUARD_WAIT_MS = 60_000;

function readAgent(): Agent {
  try {
    const v = localStorage.getItem(AGENT_KEY);
    return isAgent(v) ? v : "claude";
  } catch {
    return "claude";
  }
}

const nav = () => navigator as Navigator & { userAgentData?: { platform?: string }; brave?: unknown };

/** A command or a code to copy: one line that scrolls sideways, and a copy button that says it copied. */
function CopyLine({ text, label, mono = true }: { text: string; label: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2">
      <code aria-label={label} className={cn("min-w-0 flex-1 overflow-x-auto text-[12px] whitespace-nowrap", mono && "font-mono")}>
        {text}
      </code>
      <button
        type="button"
        onClick={async () => {
          if (await copyWithToast(text)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        }}
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={`Copy ${label}`}
      >
        {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** A quiet text button. */
const Quiet = ({ children, onClick, className }: { children: React.ReactNode; onClick: () => void; className?: string }) => (
  <button type="button" onClick={onClick} className={cn("text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline", className)}>
    {children}
  </button>
);

export function AiSetupPanel({ onBack, fromRun, onStart, onNotNow }: AiSetupPanelProps) {
  const qc = useQueryClient();
  const support = useComputerSupport();
  const { ways, off, phone } = waysFor(support, FUOBE_CONNECT_PUBLISHED);
  // The way picked by hand, while this browser can use it; else the one that fits (the browser's own answer can come a
  // moment after the first paint, on a phone's narrow screen).
  const [chosen, setWay] = useState<Way | null>(null);
  const way: Way = chosen && ways.includes(chosen) && !off.includes(chosen) ? chosen : pickWay(support, FUOBE_CONNECT_PUBLISHED);
  const detected = useMemo<Os>(() => (typeof window === "undefined" ? "other" : platformOf(nav())), []);
  const [osPicked, setOsPicked] = useState<Os | null>(null);
  // A phone's own system is never the computer's: the person picks Windows, Mac or Linux.
  const os: Os | null = osPicked ?? (phone ? null : detected);
  const browser = useMemo(() => (typeof window === "undefined" ? ("other" as const) : browserOf(nav())), []);
  const [changing, setChanging] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  // The account's GPU (what is saved) and whether it answers (the status strip's check).
  const gpuQ = useQuery({ queryKey: ["account-gpu"], queryFn: async () => (await (await fetch("/api/account/gpu")).json()) as GpuView });
  const saved = gpuQ.data?.gpu ? (gpuQ.data.gpu.mode === "computer" ? "computer" : "link") : "none";
  const status = useStatus();
  const viewerGpu = status.data?.viewer?.gpu;
  const online = viewerGpu?.connected ? !!viewerGpu.online : false;

  // This browser's way: the ComfyUI on this computer, watched while the AI works.
  const [connectedHere, setConnectedHere] = useState(false);
  const probe = useSetupProbe(way === "direct" && support === "ok", !connectedHere);
  const [skipGuard, setSkipGuard] = useState(false);
  const [switchOk, setSwitchOk] = useState(false);
  const found = probe.state.s === "found";
  const allowed = found && (probe.cors === "exact" || probe.guard === "connect") && !probe.listen;
  const guarded = probe.guard === "guard" || probe.guard === "connect";
  const auto = useAutoConnect({
    ready: way === "direct" && allowed && (guarded || skipGuard) && (saved !== "link" || switchOk),
    port: probe.port,
    host: probe.host,
    stats: probe.stats,
    onConnected: () => setConnectedHere(true),
  });

  // The web address: what the form last did.
  const [address, setAddress] = useState<{ state: "none" | "testing" | "ok" | "failed"; cause?: AddressCause; words?: string }>({ state: "none" });
  const check = useGpuCheck();

  // A picture model, and the first picture.
  const badges = useGpuBadges().data;
  const model = firstModelOf(badges ? { ...badges, vramGb: badges.vramGb ?? probe.vramGb } : undefined);
  const picture = useFirstPicture();

  const browserState: TabFacts["browser"] =
    way !== "direct" ? "unknown" : support !== "ok" ? "unsupported" : probe.state.s === "blocked" ? "blocked" : probe.perm === "granted" ? "granted" : probe.state.s === "start" ? "ask" : "unknown";
  const comfy = probe.state.s === "found" ? "found" : probe.state.s === "needs-setting" ? "unreadable" : probe.state.s === "waiting" ? "waiting" : probe.state.s === "none" ? "none" : undefined;
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const facts: Omit<TabFacts, "tabId"> = {
    way,
    visible,
    browser: browserState,
    browserName: browser,
    ...(way !== "address" && {
      ...(comfy && { comfy }),
      ...(probe.port && { port: probe.port }),
      ...(probe.install && { install: probe.install }),
      ...(probe.cors && { cors: probe.cors }),
      ...(found && { listen: probe.listen }),
      ...(probe.restarted && { restarted: true }),
      ...(found && { guard: probe.guard ?? "none" }),
      ...(skipGuard && { guardSkipped: true }),
      ...((connectedHere || (saved === "computer" && online && found)) && { connected: true }),
      ...(probe.cpu && { cpu: true }),
    }),
    ...(way === "address" && { address: address.state === "none" && saved === "link" ? "ok" : address.state, ...(address.cause && { addressCause: address.cause }) }),
    model: model.state === "checking" ? "checking" : model.state,
    ...(model.state !== "checking" && model.state !== "none" && { modelId: model.model }),
    ...(model.state === "download" && { modelGbTenths: model.gbTenths }),
    picture: picture.state,
    ...(picture.secs !== undefined && { pictureSecs: Math.min(3600, picture.secs) }),
    ...(picture.cause && { pictureCause: picture.cause }),
    ...(fromRun && { fromRun: true }),
  };
  const server = { gpu: saved, online: saved === "none" ? false : status.data ? online : null } as const;
  const now = useNow(5000);
  const viewNow = { site: typeof window === "undefined" ? "" : window.location.origin, way, os: os ?? "other", phone, tab: { ...facts, tabId: "this-tab-0" }, tabAt: now, server };
  const steps = stepsOf(viewNow);
  const connected = isConnected(viewNow);
  const done = isDone(viewNow);

  const session = useSetupSession({ way, os: os ?? "other", phone, facts, onPoke: probe.poke });
  const site = session.site ?? (typeof window === "undefined" ? "" : window.location.origin);

  // Connected: what this ComfyUI has (once), and again every 45 s while it needs a model download.
  const checkedFor = useRef<string | null>(null);
  // Only stable values here: a new recheck on every render would start the 45 s timer over each time.
  const startCheck = check.start;
  const recheck = useCallback(async () => {
    if (way === "address") await startCheck();
    else if (probe.port && probe.host) await checkHere(qc, probe.port, probe.host).catch(() => {});
  }, [way, startCheck, probe.port, probe.host, qc]);
  useEffect(() => {
    if (!connected) return;
    const key = `${way}:${saved}`;
    if (model.state === "checking" && checkedFor.current !== key && !check.running) {
      checkedFor.current = key;
      const t = setTimeout(() => void recheck(), 2500);
      return () => clearTimeout(t);
    }
    if (model.state !== "download") return;
    const id = setInterval(() => document.visibilityState === "visible" && void recheck(), 45_000);
    return () => clearInterval(id);
  }, [connected, model.state, way, saved, recheck, check.running]);

  // Opened by a refused run: once connected, that run starts (it is the first picture).
  useEffect(() => {
    if (!fromRun || !connected) return;
    const t = setTimeout(() => onStart?.(), 1200);
    return () => clearTimeout(t);
  }, [fromRun, connected, onStart]);

  // The tab's title says how far it is, so the person sees it from their AI's tab.
  const doneCount = steps.filter((s) => s.state === "done").length;
  useEffect(() => {
    const was = document.title;
    return () => {
      document.title = was;
    };
  }, []);
  useEffect(() => {
    document.title = done ? "Your GPU is ready - Fuobe" : `(${doneCount}/${steps.length}) Setting up your GPU - Fuobe`;
  }, [done, doneCount, steps.length]);

  // Stuck: nothing changed for four minutes.
  const stepsKey = steps.map((s) => s.state).join();
  const [changed, setChanged] = useState({ key: stepsKey, at: now });
  if (changed.key !== stepsKey) setChanged({ key: stepsKey, at: now });
  const stuck = !done && now - changed.at > STUCK_MS;
  // The guard: "Connect anyway" a minute after Fuobe was let in without it.
  const waitsForGuard = allowed && !guarded;
  const [guardWait, setGuardWait] = useState({ on: waitsForGuard, at: now });
  if (guardWait.on !== waitsForGuard) setGuardWait({ on: waitsForGuard, at: now });
  const allowedAt = guardWait.on ? guardWait.at : null;

  // The browser's one question comes first (Chrome closes it when its tab loses focus): the hand-offs wait for it.
  const handoffsLocked = way === "direct" && support === "ok" && probe.state.s === "start" && !(saved === "computer" && online);
  const finished = picture.state === "ok";
  const gpuName = probe.stats?.devices?.[0]?.name ? deviceLabel(probe.stats.devices[0].name) : viewerGpu?.device ? deviceLabel(viewerGpu.device) : undefined;

  // ---- The rows' own controls.
  const extras: Partial<Record<(typeof steps)[number]["id"], React.ReactNode>> = {};
  if (way === "direct") {
    const s = probe.state.s;
    if (s === "start")
      extras.comfyui = (
        <>
          <Button className="h-11 sm:h-9" onClick={() => void probe.look()}>
            <Search /> Let Fuobe look
          </Button>
          {probe.perm !== "granted" && <AllowNote />}
        </>
      );
    else if (s === "looking") extras.comfyui = <p className="flex items-center gap-2 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Looking for ComfyUI on this computer…</p>;
    else if (s === "blocked")
      extras.comfyui = (
        <>
          <p className="text-[12px] text-muted-foreground">{blockedSteps()}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              <RefreshCw /> Reload
            </Button>
            <Quiet onClick={() => setWay("address")}>Use a web address instead</Quiet>
          </div>
        </>
      );
    else if (s === "none") extras.comfyui = <NoComfy onLook={(port, host) => void probe.look({ ports: [{ port, host }] })} missed={probe.state.missed} notComfy={probe.state.notComfy} />;
    if (found && saved === "link" && !switchOk && allowed)
      extras.allowed = (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-[12px]">
          <span>Use this computer instead of your web address?</span>
          <Button size="sm" variant="secondary" className="h-8" onClick={() => setSwitchOk(true)}>
            Switch
          </Button>
        </div>
      );
    else if (probe.state.s === "needs-setting" && probe.install === "portable" && probe.port)
      extras.allowed = (
        <div className="space-y-1.5">
          <p className="text-[12px] text-muted-foreground">Your AI adds Fuobe&apos;s setting next. Or do it yourself in one click:</p>
          <GuardFix port={probe.port} install="portable" />
        </div>
      );
    if (allowed && !guarded && !skipGuard)
      extras.guard = (
        <p className="text-[12px] text-muted-foreground">
          Your AI adds it next. It keeps other websites out of your ComfyUI.{" "}
          {allowedAt && now - allowedAt > GUARD_WAIT_MS && <Quiet onClick={() => setSkipGuard(true)}>Connect anyway</Quiet>}
        </p>
      );
    if (auto.error) extras.guard = <p className="text-[12px] text-destructive">{auto.error}</p>;
  }
  if (way === "address" && !(saved === "link" && online && address.state !== "failed"))
    extras.address = <AddressForm saved={saved === "link"} state={address} onState={setAddress} onConnected={() => void check.start()} />;
  if (connected && !fromRun) {
    if (model.state === "download") extras.model = <ModelDownload model={model.model} gbTenths={model.gbTenths} os={os ?? "other"} onCheck={() => void recheck()} checking={check.running} />;
    else if (model.state === "none")
      extras.model = (
        <p className="text-[12px] text-muted-foreground">
          None of the small picture models fits this GPU.{" "}
          <a href="/connect" className="text-brand-text underline-offset-4 hover:underline">
            See what runs on it
          </a>
        </p>
      );
    if (model.state === "ready" && picture.state !== "running" && picture.state !== "ok")
      extras.picture = (
        <div className="space-y-1.5">
          {picture.state === "failed" && <p className="text-[12px] text-destructive">{picture.cause === "out-of-memory" ? "Your GPU ran out of memory. Close other apps that use it, then try again." : picture.error}</p>}
          <Button className="h-11 sm:h-9" onClick={() => void picture.start(model.model)}>
            {picture.state === "failed" ? "Try again" : "Make your first picture"}
          </Button>
        </div>
      );
    else if (picture.state === "running")
      extras.picture = (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {FIRST_MODEL_NAME[picture.model!]} is making it on your GPU…
        </p>
      );
    else if (picture.state === "no-model") extras.picture = <p className="text-[12px] text-muted-foreground">ComfyUI needs one more thing for this model. Fuobe shows what.</p>;
  }
  if (fromRun && connected) extras.picture = <p className="text-[12px] text-muted-foreground">Your run starts in a moment.</p>;

  const handoff = os && session.code ? { way, os, site, code: session.code, browser, phone } : null;
  const lead = phone ? "ComfyUI runs on your computer, so the steps run there." : "Your AI does the steps, after you say yes to each one. Fuobe checks every step here.";

  return (
    <div className="w-full min-w-0 space-y-4 sm:max-w-[36rem]">
      <div className="space-y-1">
        <button type="button" onClick={onBack} className="-ml-1 flex h-9 items-center gap-1 rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> Back
        </button>
        <h2 ref={heading} tabIndex={-1} className="text-[17px] font-semibold outline-none">
          Set it up with your AI
        </h2>
        <p className="text-[13px] text-muted-foreground">{lead}</p>
      </div>

      {/* What Fuobe picked for this browser, and the way to change it. */}
      {!phone && (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span>
              {way === "direct"
                ? `For ${OS_NAME[os ?? "other"] || "your computer"} and ${BROWSER_LABEL[browser]}, with ComfyUI on this computer.`
                : `For ComfyUI on your ${OS_NAME[os ?? "other"] ? `${OS_NAME[os ?? "other"]} ` : ""}computer, through a web address.`}
            </span>
            <Quiet onClick={() => setChanging((v) => !v)}>{changing ? "Done" : "Change"}</Quiet>
          </p>
          {changing && (
            <div className="flex flex-wrap items-center gap-2">
              <TabRow role="tablist" aria-label="Way to connect" fade={false} className="w-fit">
                {ways.map((w) => (
                  <button
                    key={w}
                    type="button"
                    role="tab"
                    aria-selected={w === way}
                    aria-disabled={off.includes(w)}
                    onClick={() => !off.includes(w) && setWay(w)}
                    className={cn(TAB_PILL, off.includes(w) && "opacity-50")}
                    {...onAttr(w === way)}
                  >
                    {WAY_LABEL[w]}
                  </button>
                ))}
              </TabRow>
              <Select value={os ?? undefined} onValueChange={(v) => setOsPicked(v as Os)}>
                <SelectTrigger className="h-9 w-36" aria-label="Computer">
                  <SelectValue placeholder="Computer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="windows">Windows</SelectItem>
                  <SelectItem value="mac">Mac</SelectItem>
                  <SelectItem value="linux">Linux</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {(changing || off.length > 0) && <p className="text-[12px] text-muted-foreground">{wayLine(way, support)}</p>}
        </div>
      )}

      {phone && <PhoneSend site={site} os={os} onOs={setOsPicked} />}

      {!session.mine && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted px-3 py-2.5 text-[13px]">
          <span>This setup goes on in another tab or device.</span>
          <Button size="sm" variant="secondary" onClick={session.takeOver}>
            Continue here
          </Button>
        </div>
      )}

      {!finished && !handoffsLocked && (
        <HandOffs
          input={handoff}
          waiting={!session.code && !session.failed && !session.ended}
          needOs={!os}
          locked={handoffsLocked}
          phone={phone}
          failed={session.failed}
          onRetry={session.retry}
          guideUrl={way && os ? `/api/setup/guide/${way}/${os}` : null}
          code={session.code}
          ended={session.ended}
          renewed={session.renewed}
          onEnd={() => void session.end()}
          onFresh={() => void session.fresh()}
        />
      )}

      {/* The checklist, or the finish in its place (the box keeps its height). Before the browser's question, the hand-offs come after it. */}
      <section aria-label="Fuobe checks as your AI works" className="min-h-[18rem] rounded-2xl bg-brand-faint/50 p-4">
        {finished ? (
          <FinishCard picture={picture} gpu={gpuName} cpu={probe.cpu} onClose={onBack} />
        ) : (
          <>
            <p className="mb-3 text-[13px] font-medium">Fuobe checks as your AI works</p>
            <SetupChecklist
              steps={steps}
              extras={extras}
              footer={
                <Presence
                  aiReadAt={session.aiReadAt}
                  offline={session.offline}
                  now={now}
                  stuck={stuck}
                  next={nextOf(viewNow, now)}
                  onSelf={onBack}
                  onAddress={way === "direct" ? () => setWay("address") : undefined}
                  code={session.code}
                />
              }
            />
          </>
        )}
      </section>
      {!finished && handoffsLocked && (
        <HandOffs
          input={handoff}
          waiting={!session.code && !session.failed && !session.ended}
          needOs={!os}
          locked
          phone={phone}
          failed={session.failed}
          onRetry={session.retry}
          guideUrl={way && os ? `/api/setup/guide/${way}/${os}` : null}
          code={session.code}
          ended={session.ended}
          renewed={session.renewed}
          onEnd={() => void session.end()}
          onFresh={() => void session.fresh()}
        />
      )}
      {fromRun && !connected && onNotNow && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onNotNow}>
            Not now
          </Button>
        </div>
      )}
    </div>
  );
}

/** One line about the way picked. */
function wayLine(way: Way, support: string): string {
  if (support === "safari") return "Safari can't reach ComfyUI from a website. In Chrome, Edge or Firefox, Fuobe uses ComfyUI right from the tab, with nothing public.";
  if (support === "http") return "Your browser marks this page as not secure, so it can't reach ComfyUI from here. A web address works.";
  if (way === "address") return "ComfyUI gets a web address. It works from Safari and phones, and runs go on with this tab closed.";
  if (way === "connect") return "Install Fuobe Connect once. It works in every browser and with this tab closed.";
  return "Fuobe uses ComfyUI right from this tab. Runs go while Fuobe is open here.";
}

/** Nothing answers: install it with the AI, or a port of its own. */
function NoComfy({ onLook, missed, notComfy }: { onLook: (port: number, host: string) => void; missed?: number; notComfy?: number }) {
  const [port, setPort] = useState(false);
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        No ComfyUI yet? Your AI can install it.{" "}
        <a href="https://www.comfy.org/download" target="_blank" rel="noopener noreferrer" className="text-brand-text underline-offset-4 hover:underline">
          Get ComfyUI Desktop
          <span className="sr-only"> (opens a new tab)</span>
        </a>
      </p>
      {port ? <OtherPort onLook={onLook} missed={missed} notComfy={notComfy} /> : <Quiet onClick={() => setPort(true)}>ComfyUI on another port?</Quiet>}
    </div>
  );
}

/**
 * The hand-offs: Open in ChatGPT, Open in Claude (each also copies the message, in case the chat opens empty), Copy the
 * steps for any other AI, and one command for a coding agent on this computer. Locked until the browser's one question
 * is answered (this browser's way), so the AI's first look at the status already says whether ComfyUI runs. After a
 * hand-off the box folds to one line, and the checklist is the main view.
 */
function HandOffs({
  input,
  waiting,
  needOs,
  locked,
  phone,
  failed,
  onRetry,
  guideUrl,
  code,
  ended,
  renewed,
  onEnd,
  onFresh,
}: {
  input: Parameters<typeof prefillText>[0] | null;
  waiting: boolean;
  needOs: boolean;
  locked: boolean;
  phone: boolean;
  failed: string | null;
  onRetry: () => void;
  guideUrl: string | null;
  code: string | null;
  ended: boolean;
  renewed: boolean;
  onEnd: () => void;
  onFresh: () => void;
}) {
  const [sent, setSent] = useState<string | null>(null);
  const [apps, setApps] = useState(false);
  const [agent, setAgentState] = useState<Agent>(readAgent);
  const setAgent = (a: Agent) => {
    setAgentState(a);
    try {
      localStorage.setItem(AGENT_KEY, a);
    } catch {}
  };
  const guide = useQuery({
    queryKey: ["ai-setup-guide", guideUrl],
    queryFn: async () => {
      const r = await fetch(guideUrl!);
      if (!r.ok) throw new Error("No guide");
      return r.text();
    },
    enabled: !!guideUrl,
    staleTime: 5 * 60_000,
  });
  const text = input ? prefillText(input) : "";
  let line = "";
  try {
    line = input ? agentLine(agent, input) : "";
  } catch {}
  const full = input && guide.data ? fullInstructions(input, guide.data) : null;
  const ready = !!input && !locked && !ended;

  const openChat = (t: AiTarget) => {
    // The message goes on the clipboard too: a chat that opens empty (a sign-in first, an app) takes it with a paste.
    void copyText(text).then((ok) => ok && toast("Message copied too", { description: "If the chat opens empty, paste it.", duration: 4000 }));
    setSent(AI_TARGETS[t].label);
  };
  const copyFull = async () => {
    if (full && (await copyWithToast(full, "Steps copied"))) setSent("your AI");
  };

  if (failed && !code)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border p-4 text-[13px]">
        <span>{failed}</span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      </div>
    );

  return (
    <div className="space-y-3 rounded-2xl border bg-background p-4">
      {sent && ready ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <span className="flex items-center gap-1.5 font-medium">
            <Check className="size-4 text-brand-text" /> Sent to {sent}.
          </span>
          <Quiet onClick={() => setSent(null)}>Use another AI</Quiet>
        </div>
      ) : (
        <>
          <p className="text-[13px] font-medium">Give your AI the steps</p>
          {locked && <p className="text-[12px] text-muted-foreground">These open once Fuobe has looked for ComfyUI above, so your AI&apos;s first check already knows what runs.</p>}
          {needOs && <p className="text-[12px] text-muted-foreground">Pick the computer that runs ComfyUI first.</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(AI_TARGETS) as AiTarget[])
              .filter((t) => AI_TARGETS[t].on)
              .map((t) =>
                ready ? (
                  <Button key={t} asChild className="h-11">
                    <a href={chatLink(t, text)} target="_blank" rel="noopener noreferrer" onClick={() => openChat(t)}>
                      <BotMessageSquare /> Open in {AI_TARGETS[t].label}
                      <span className="sr-only"> (opens a new tab)</span>
                    </a>
                  </Button>
                ) : (
                  <Button key={t} className="h-11" disabled>
                    {waiting ? <Loader2 className="animate-spin" /> : <BotMessageSquare />} Open in {AI_TARGETS[t].label}
                  </Button>
                ),
              )}
          </div>
          <p className="text-[12px] text-muted-foreground">
            Chat apps tell you what to paste. Apps on your computer do the steps after you say yes. Claude and ChatGPT may ask you to check the message first.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Quiet onClick={() => void copyFull()} className={cn((!ready || !full) && "pointer-events-none opacity-50")}>
              Copy the steps for another AI
            </Quiet>
            {!phone && (
              <button type="button" onClick={() => setApps((v) => !v)} aria-expanded={apps} className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground">
                <Terminal className="size-3.5" /> AI app on this computer? <ChevronDown className={cn("size-3.5 transition-transform", apps && "rotate-180")} />
              </button>
            )}
          </div>
          {apps && !phone && (
            <div className="space-y-2">
              <p className="text-[12px] text-muted-foreground">Paste this in a terminal. The app asks before each command.</p>
              <TabRow role="tablist" aria-label="Coding agent" fade={false} className="w-fit">
                {(Object.keys(AGENTS) as Agent[]).map((a) => (
                  <button key={a} type="button" role="tab" aria-selected={a === agent} onClick={() => setAgent(a)} className={TAB_PILL} {...onAttr(a === agent)}>
                    {AGENTS[a].label}
                  </button>
                ))}
              </TabRow>
              {ready && line ? <CopyLine text={line} label="the command" /> : <div className="h-11 rounded-lg bg-muted" />}
              <p className="text-[12px] text-muted-foreground">Cursor or another app? Copy the steps works with any AI.</p>
            </div>
          )}
        </>
      )}
      <CodeLine code={code} ended={ended} renewed={renewed} onEnd={onEnd} onFresh={onFresh} />
    </div>
  );
}

/** The setup code, with End this code in a small menu; after it ends, a new one. */
function CodeLine({ code, ended, renewed, onEnd, onFresh }: { code: string | null; ended: boolean; renewed: boolean; onEnd: () => void; onFresh: () => void }) {
  if (ended)
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-[12px] text-muted-foreground">
        <span>Your AI can&apos;t see Fuobe&apos;s checks now.</span>
        <Quiet onClick={onFresh}>Share again</Quiet>
      </div>
    );
  if (!code) return null;
  const shown = showCode(code);
  return (
    <div className="space-y-1.5 border-t pt-3">
      {renewed && <p className="text-[12px]">Fuobe made a new code. Tell your AI: My new setup code is {shown}.</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
          Setup code
          <span aria-label={`Setup code ${spokenCode(code)}`} className="font-mono text-[13px] tracking-widest text-foreground">
            {shown}
          </span>
          <button type="button" onClick={() => void copyWithToast(renewed ? `My new setup code is ${shown}` : shown, "Code copied")} className="grid size-8 place-items-center rounded-md hover:bg-muted hover:text-foreground" aria-label="Copy the setup code">
            <Copy className="size-3.5" />
          </button>
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="More about this code">
              <Ellipsis className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEnd}>End this code</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Whether the AI has checked in, and, when nothing moved for a while, what Fuobe sees and the ways out. */
function Presence({
  aiReadAt,
  offline,
  now,
  stuck,
  next,
  onSelf,
  onAddress,
  code,
}: {
  aiReadAt: number | null;
  offline: boolean;
  now: number;
  stuck: boolean;
  next: ReturnType<typeof nextOf>;
  onSelf: () => void;
  onAddress?: () => void;
  code: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ago = aiReadAt ? Math.max(1, Math.round((now - aiReadAt) / 1000)) : null;
  const forAi = [`Fuobe setup status${code ? ` for code ${showCode(code)}` : ""}:`, next.say, ...next.how.map((h) => `- ${h}`), `Guide: ${next.guide}`].join("\n");
  return (
    <div className="space-y-2 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 text-muted-foreground">
          <span className={cn("inline-flex size-2 shrink-0 rounded-full", ago !== null && !offline ? "bg-brand-text motion-safe:animate-live-dot" : "bg-muted-foreground/40")} />
          {offline ? "Fuobe can't reach its server right now. Retrying." : ago !== null ? `Your AI checked in ${ago < 60 ? `${ago} s` : `${Math.round(ago / 60)} min`} ago.` : "Your AI hasn't checked Fuobe yet. Fuobe still ticks each step."}
        </p>
        {stuck ? (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-1 font-medium text-brand-text">
            Stuck? <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        ) : (
          <p className="text-muted-foreground">Keep this tab open. You can switch to your AI.</p>
        )}
      </div>
      {stuck && open && (
        <div className="space-y-2 rounded-xl bg-background p-3">
          <p>Tell your AI: Check Fuobe&apos;s status again.</p>
          <p className="text-muted-foreground">
            What Fuobe sees now: <span className="text-foreground">{next.say}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Button size="sm" variant="secondary" onClick={() => void copyWithToast(forAi, "Copied for your AI")}>
              <Copy /> Copy for my AI
            </Button>
            <Quiet onClick={onSelf}>Do it myself instead</Quiet>
            {onAddress && <Quiet onClick={onAddress}>Try a web address instead</Quiet>}
          </div>
        </div>
      )}
    </div>
  );
}

/** The web address form: paste the address cloudflared made, and Fuobe tests it (the same check as Your GPU). */
function AddressForm({ saved, state, onState, onConnected }: { saved: boolean; state: { state: string; words?: string }; onState: (s: { state: "none" | "testing" | "ok" | "failed"; cause?: AddressCause; words?: string }) => void; onConnected: () => void }) {
  const qc = useQueryClient();
  const id = useId();
  const [url, setUrl] = useState("");
  const canPaste = typeof navigator !== "undefined" && !!navigator.clipboard?.readText;
  const value = url.trim();
  const local = !!value && isLocalAddress(/^[a-z]+:\/\//i.test(value) ? value : `http://${value}`);
  const connect = async () => {
    if (!value || local) return;
    onState({ state: "testing" });
    const res = await fetch("/api/account/gpu", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: value }) }).catch(() => null);
    const j = res ? ((await res.json().catch(() => ({}))) as { error?: string; trouble?: { cause?: string; words?: string } }) : {};
    if (res?.ok) {
      onState({ state: "ok" });
      setUrl("");
      for (const k of [["account-gpu"], ["status"], ["viewer"]]) void qc.invalidateQueries({ queryKey: k });
      onConnected();
      return;
    }
    // The check's own words under the box; the AI gets only the kind of problem.
    onState({ state: "failed", cause: res ? addressCauseOf(j.trouble?.cause) : "unknown", words: j.trouble?.words ?? j.error ?? "Fuobe can't reach its server right now. Try again." });
  };
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-url`} className="text-[12px]">
        {saved ? "Paste a new web address" : "Your ComfyUI's web address"}
      </Label>
      <div className="flex gap-2">
        <Input
          id={`${id}-url`}
          placeholder="https://your-address.trycloudflare.com"
          value={url}
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void connect()}
          aria-invalid={local || state.state === "failed"}
          className="h-11 min-w-0 flex-1 sm:h-9"
        />
        {canPaste && (
          <Button
            variant="secondary"
            className="h-11 sm:h-9"
            aria-label="Paste"
            onClick={async () => {
              try {
                setUrl((await navigator.clipboard.readText()).trim());
              } catch {}
            }}
          >
            <ClipboardPaste />
          </Button>
        )}
        <Button className="h-11 sm:h-9" onClick={() => void connect()} disabled={!value || local || state.state === "testing"}>
          {state.state === "testing" && <Loader2 className="animate-spin" />} Connect
        </Button>
      </div>
      {local && <p className="text-[12px] text-destructive">That address only works on your own computer or network. Paste the one that ends in trycloudflare.com.</p>}
      {!local && state.state === "failed" && state.words && (
        <p role="status" className="text-[12px] text-destructive">
          {state.words}
        </p>
      )}
      <p className="text-[12px] text-muted-foreground">Keep the address to yourself. Paste it here, not in your AI&apos;s chat.</p>
    </div>
  );
}

/** A model to download: its name and size, the commands to copy, and a fresh check once it is there. */
function ModelDownload({ model, gbTenths, os, onCheck, checking }: { model: FirstModel; gbTenths: number; os: Os; onCheck: () => void; checking: boolean }) {
  const plan = useGpuPlan(`model:${model}#t2i`).data;
  const commands = plan ? (os === "windows" ? plan.commands.powershell : plan.commands.bash) : null;
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-muted-foreground">
        ComfyUI has no picture model Fuobe can use yet. {FIRST_MODEL_NAME[model]} fits: one download of {(gbTenths / 10).toFixed(gbTenths >= 100 ? 0 : 1)} GB. Your AI can download it, or you can.
      </p>
      <div className="flex flex-wrap gap-2">
        {commands && (
          <Button size="sm" variant="secondary" onClick={() => void copyWithToast(commands, "Download commands copied")}>
            <Copy /> Copy download commands
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
        </Button>
      </div>
    </div>
  );
}

/** On a phone: the steps run on the computer. Send this page there, or use an AI app here with the computer's system picked. */
function PhoneSend({ site, os, onOs }: { site: string; os: Os | null; onOs: (os: Os) => void }) {
  const link = `${site}/connect?setup=ai`;
  const share = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="space-y-3">
      <Button
        className="h-11 w-full"
        onClick={async () => {
          if (share) {
            try {
              await navigator.share({ title: "Set up Fuobe on my computer", url: link });
              return;
            } catch {}
          }
          await copyWithToast(link, "Link copied");
        }}
      >
        <Send /> {share ? "Send to my computer" : "Copy link for my computer"}
      </Button>
      <div className="space-y-1.5">
        <p className="text-[12px] text-muted-foreground">Or use an AI app now. Its chats show on your computer too. Which computer runs ComfyUI?</p>
        <TabRow role="tablist" aria-label="Computer" fade={false} className="w-fit">
          {(["windows", "mac", "linux"] as Os[]).map((o) => (
            <button key={o} type="button" role="tab" aria-selected={o === os} onClick={() => onOs(o)} className={TAB_PILL} {...onAttr(o === os)}>
              {o === "mac" ? "Mac" : OS_NAME[o]}
            </button>
          ))}
        </TabRow>
      </div>
    </div>
  );
}
