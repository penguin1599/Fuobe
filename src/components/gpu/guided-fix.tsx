"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, Circle, Cpu, Download, Layers, Loader2, Wrench } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CommandTabs } from "@/components/gpu/command-block";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { GPU_SETUP_EVENT, takeGpuRetry, useGpuCheck, useGpuPlan, type GpuSetupDetail } from "@/hooks/use-gpu";
import { useIsMobile } from "@/hooks/use-mobile";
import { useEngine } from "@/lib/api";
import { formatBytes } from "@/lib/gpu/requirements";
import type { FixPlan, FixStep, Need, WhyCode } from "@/lib/gpu/types";
import { cn } from "@/lib/utils";

/**
 * The guided fix (UX §7): a tool's plan where the user is stuck — on Generate, on a chip, on a board row, on a
 * failed run. P1 sets nothing up by itself: state A shows what the tool needs and the exact commands (Windows and
 * Mac / Linux), E says why it's by hand, F is "needs a bigger GPU", and once a check finds it all, D offers "Try
 * again" with the prompt still in the box. The sheet opens with focus on its title, so Enter can't run anything.
 */

const DOWNLOAD_KINDS = new Set<Need["kind"]>(["model", "model-replace", "lora"]);

/** One plain sentence: why this is by hand. */
const WHY: Partial<Record<WhyCode, string>> = {
  "no-manager": "Your ComfyUI doesn't have ComfyUI-Manager, the add-on that installs things for Fuobe. Run these in a terminal instead:",
  "manual-only": "Run these in a terminal, then check again:",
};

const VERB: Record<string, string> = { image: "draw", video: "animate", audio: "speak", text: "listen", model3d: "build" };

function itemLine(n: Need): string {
  if (n.kind === "model-replace") return "to download again";
  if (DOWNLOAD_KINDS.has(n.kind)) return "to download";
  if (n.kind === "pack-install") return "to install";
  if (n.kind === "pack-update") return "to update";
  if (n.kind === "pack-repair") return "to repair";
  if (n.kind === "comfy-update") return "to update";
  return "to do";
}

function intro(plan: FixPlan, kind?: string): string {
  const downloads = plan.steps.filter((s) => DOWNLOAD_KINDS.has(s.kind));
  const packs = plan.steps.filter((s) => s.kind.startsWith("pack-"));
  if (plan.steps.some((s) => s.kind === "comfy-update")) return "Your ComfyUI is older than this tool needs. Updating it keeps your models and add-ons.";
  if (plan.steps.some((s) => s.kind === "core-missing")) return "Some of ComfyUI's built-in nodes didn't load on your machine. The ComfyUI window says why.";
  if (downloads.length && !packs.length) return `The model has to be on your computer before Fuobe can ${VERB[kind ?? ""] ?? "make things"} with it. You only download it once.`;
  if (packs.length && !downloads.length) return `${plan.name} uses a free ComfyUI add-on. You only add it once.`;
  return "Here's what it needs on your ComfyUI. You only do this once.";
}

function StepRow({ n, done }: { n: Need; done?: boolean }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5 text-[13px]">
      {done ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1">{n.label}</span>
      {n.sizeBytes ? <span className="shrink-0 tabular-nums text-muted-foreground">{formatBytes(n.sizeBytes)}</span> : null}
      <span className="w-28 shrink-0 text-right text-[12px] text-muted-foreground">{done ? "already there" : itemLine(n)}</span>
    </li>
  );
}

function Details({ steps }: { steps: FixStep[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-data-[state=open]:rotate-90" /> Details (file names, folders, sources)
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 space-y-2 text-[12px] text-muted-foreground">
          {steps.map((s) => (
            <li key={s.id} className="break-words">
              <span className="text-foreground">{s.label}</span>: {s.detail}
              {s.link && (
                <>
                  {" "}
                  <a href={s.link} target="_blank" rel="noreferrer" className="text-brand-text underline underline-offset-2">
                    Open its page
                  </a>
                </>
              )}
              {/* Text from the viewer's ComfyUI (a traceback): plain text only. */}
              {s.remote && <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">{s.remote}</pre>}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The studio's cloud engine (the owner's only: accounts never run on the studio's keys, so plans never offer it to them). */
function UseCloud({ close, variant }: { close: () => void; variant?: "secondary" }) {
  const [, setEngine] = useEngine();
  return (
    <Button variant={variant} className="h-11 sm:h-9" onClick={() => (setEngine("cloud"), close())}>
      Use the cloud version
    </Button>
  );
}

interface Actions {
  retry?: () => void;
  skip?: () => void;
  close: () => void;
}

function PlanState({ plan, kind, actions, checking, onCheck, checkError }: { plan: FixPlan; kind?: string; actions: Actions; checking: boolean; onCheck: () => void; checkError: string | null }) {
  const real = plan.steps.filter((s) => s.kind !== "restart" && s.kind !== "hf-licence" && s.kind !== "civitai-key");
  const shown = real.length ? real : plan.steps;
  const why = WHY[plan.why] ?? WHY["manual-only"]!;
  const [lo, hi] = plan.etaMin;
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">{intro(plan, kind)}</p>
      <ul className="divide-y rounded-lg border px-3">
        {shown.map((s) => (
          <StepRow key={s.id} n={s} />
        ))}
        {plan.have.slice(0, 6).map((h) => (
          <StepRow key={h.key} n={h} done />
        ))}
      </ul>
      {plan.downloadBytes > 0 && (
        <p className="text-[13px]">
          {formatBytes(plan.downloadBytes)} from Hugging Face · about {lo === hi ? lo : `${lo}–${hi}`} min on fast internet.{" "}
          <span className="text-muted-foreground">Make sure you have {formatBytes(plan.downloadBytes)} free. It stays on your computer.</span>
        </p>
      )}
      {plan.restart && <p className="text-[13px] text-muted-foreground">ComfyUI loads new add-ons when it starts, so restart it once they&apos;re in. It doesn&apos;t touch your files.</p>}
      {plan.firstRun.length > 0 && <p className="text-[13px] text-muted-foreground">The first run also downloads a small model by itself, so it takes a minute longer.</p>}
      {plan.unobservable.length > 0 && <p className="text-[13px] text-muted-foreground">Fuobe can&apos;t check {plan.unobservable.length === 1 ? "one file" : `${plan.unobservable.length} files`} this tool reads by itself.</p>}
      <Details steps={plan.steps} />
      <div className="space-y-2 border-t pt-4">
        <h3 className="text-[14px] font-semibold">Let&apos;s do this one by hand</h3>
        <p className="text-[13px] text-muted-foreground">{why}</p>
        <CommandTabs bash={plan.commands.bash} powershell={plan.commands.powershell} windowsFirst={plan.os ? plan.os === "nt" : undefined} />
      </div>
      {checkError && <p className="text-[12px] text-destructive">{checkError}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Button onClick={onCheck} disabled={checking} className="h-11 sm:h-9">
          {checking ? <Loader2 className="animate-spin" /> : <CheckCircle2 />} I&apos;ve done it. Check again
        </Button>
        {plan.alternatives.cloud && <UseCloud close={actions.close} variant="secondary" />}
        {actions.skip && (
          <Button variant="ghost" className="h-11 text-muted-foreground sm:h-9" onClick={() => (actions.close(), actions.skip!())}>
            Run anyway
          </Button>
        )}
      </div>
    </div>
  );
}

function GpuState({ plan, actions }: { plan: FixPlan; actions: Actions }) {
  const { needGb, haveGb, fit } = plan.vram;
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        {plan.name} uses about {needGb} GB of graphics memory.{" "}
        {haveGb ? `Your ${plan.gpu ?? "graphics card"} has ${haveGb} GB.` : "Fuobe didn't find a graphics card it can use on your ComfyUI."}
      </p>
      {plan.alternatives.fits?.length ? (
        <div className="space-y-1">
          <p className="text-[13px] font-medium">These fit your GPU:</p>
          <ul className="text-[13px] text-muted-foreground">
            {plan.alternatives.fits.map((f) => (
              <li key={f.ref} className="flex items-center gap-2">
                <CheckCircle2 aria-hidden className={cn("size-3.5", f.state === "ready" ? "text-success" : "text-warning")} />
                {f.name} · {f.state === "ready" ? "Ready" : "One step away"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {plan.alternatives.cloud && <UseCloud close={actions.close} />}
        {actions.skip && (
          <Button variant={plan.alternatives.cloud ? "ghost" : "secondary"} className="h-11 sm:h-9" onClick={() => (actions.close(), actions.skip!())}>
            Try anyway
          </Button>
        )}
        <Button variant="ghost" className="h-11 sm:h-9" onClick={actions.close}>
          Close
        </Button>
      </div>
      {actions.skip && <p className="text-[12px] text-muted-foreground">{fit === "tight" ? "It may be slow: ComfyUI borrows ordinary memory." : "It may be very slow, or stop with “out of memory”."}</p>}
    </div>
  );
}

function titleOf(plan: FixPlan | undefined, name: string): { text: string; Icon: typeof Download } {
  if (!plan) return { text: name, Icon: Wrench };
  if (plan.state === "ready") return { text: `${plan.name} is ready`, Icon: CheckCircle2 };
  if (plan.state === "gpu") return { text: `${plan.name} needs a bigger graphics card`, Icon: Cpu };
  if (plan.state === "unsupported" && plan.gpuNeed) return { text: `${plan.name} needs ${plan.gpuNeed === "nvidia-rtx-40" ? "an NVIDIA RTX 40 series card or newer" : "an NVIDIA RTX card"}`, Icon: Cpu };
  if (plan.state === "unsupported") return { text: `${plan.name} needs a second ComfyUI`, Icon: Layers };
  const n = plan.steps.filter((s) => s.kind !== "restart" && s.kind !== "hf-licence" && s.kind !== "civitai-key").length || 1;
  return { text: n === 1 ? `${plan.name} needs one more thing` : `${plan.name} needs ${n} things`, Icon: Download };
}

function Body({ detail, actions, titleRef }: { detail: GpuSetupDetail; actions: Actions; titleRef: React.RefObject<HTMLHeadingElement | null> }) {
  const qc = useQueryClient();
  const q = useGpuPlan(detail.ref);
  const check = useGpuCheck();
  const [checked, setChecked] = useState(false);
  // A plan handed over with the event shows at once; the query refreshes it.
  const plan = q.data ?? (q.isFetching || !checked ? detail.plan : undefined);
  const mobile = useIsMobile();
  const { text, Icon } = titleOf(plan, detail.name ?? plan?.name ?? "Set up this tool");
  const recheck = async () => {
    await check.start();
    setChecked(true);
    await qc.invalidateQueries({ queryKey: ["gpu", "plan", detail.ref] });
  };
  const T = mobile ? SheetTitle : DialogTitle;
  const D = mobile ? SheetDescription : DialogDescription;
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-4">
      <div className="flex items-start gap-3 pr-8">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", plan?.state === "ready" ? "bg-success/15 text-success" : "bg-brand-faint text-brand-text")}>
          <Icon aria-hidden className="size-4.5" />
        </span>
        <div className="min-w-0">
          <T ref={titleRef} tabIndex={-1} className="font-sans text-[16px] font-semibold outline-none">
            {text}
          </T>
          <D className="text-[12px] text-muted-foreground">{plan?.gpu ? `On your ${plan.gpu}` : "On your ComfyUI"}</D>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {check.running ? "Checking your GPU" : plan ? text : ""}
      </div>
      {!plan && (q.isLoading || q.isFetching) && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
      {!plan && q.isError && (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted-foreground">{(q.error as Error).message}</p>
          <Button asChild className="h-11 sm:h-9">
            <Link href="/connect" onClick={actions.close}>
              Check your GPU
            </Link>
          </Button>
        </div>
      )}
      {plan?.state === "ready" && (
        <div className="space-y-4">
          <p className="animate-pop-in text-[13px] text-muted-foreground">{actions.retry ? "Your prompt is still here." : "Everything it needs is on your ComfyUI."}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {actions.retry ? (
              <Button className="h-11 sm:h-9" onClick={() => (actions.close(), actions.retry!())}>
                Try again
              </Button>
            ) : (
              <Button className="h-11 sm:h-9" onClick={actions.close}>
                Done
              </Button>
            )}
            <Button asChild variant="ghost" className="h-11 sm:h-9">
              <Link href="/connect" onClick={actions.close}>
                Back to the board
              </Link>
            </Button>
          </div>
        </div>
      )}
      {plan?.state === "gpu" && <GpuState plan={plan} actions={actions} />}
      {plan?.state === "unsupported" && (
        <div className="space-y-3 text-[13px] text-muted-foreground">
          <p>
            {plan.gpuNeed
              ? `It runs on NVIDIA's RTX video engine, which only ${plan.gpuNeed === "nvidia-rtx-40" ? "RTX 40 series cards and newer" : "NVIDIA RTX cards"} have${plan.gpu ? `, and your ${plan.gpu} isn't one` : ""}. Pick another choice in this tool for this clip.`
              : "This one needs its own ComfyUI, so it can't run next to your other add-ons."}
          </p>
          <Button variant="secondary" className="h-11 sm:h-9" onClick={actions.close}>
            Close
          </Button>
        </div>
      )}
      {plan && (plan.state === "almost" || plan.state === "setup") && (
        <PlanState plan={plan} kind={undefined} actions={actions} checking={check.running} onCheck={() => void recheck()} checkError={check.error} />
      )}
      {plan?.state === "unknown" && (
        <div className="space-y-3 text-[13px] text-muted-foreground">
          <p>Fuobe couldn&apos;t check your ComfyUI this time.</p>
          <Button className="h-11 sm:h-9" disabled={check.running} onClick={() => void recheck()}>
            {check.running && <Loader2 className="animate-spin" />} Check again
          </Button>
        </div>
      )}
    </div>
  );
}

/** Mounted once (Providers): opens on the "fuobe:gpu-setup" event, a Dialog on desktop and a bottom Sheet on phones. */
export function GuidedFixHost() {
  const [detail, setDetail] = useState<GpuSetupDetail | null>(null);
  const [actions, setActions] = useState<{ retry?: () => void; skip?: () => void }>({});
  const opener = useRef<Element | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const mobile = useIsMobile();
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<GpuSetupDetail>).detail;
      if (!d?.ref) return;
      opener.current = document.activeElement;
      const r = takeGpuRetry();
      setActions(r ? { retry: r.retry, skip: r.skip } : {});
      setDetail((cur) => (cur && cur.ref === d.ref ? { ...cur, ...d } : d));
    };
    window.addEventListener(GPU_SETUP_EVENT, on);
    return () => window.removeEventListener(GPU_SETUP_EVENT, on);
  }, []);
  const close = () => setDetail(null);
  const focusTitle = (e: Event) => {
    e.preventDefault();
    titleRef.current?.focus();
  };
  const restore = (e: Event) => {
    e.preventDefault();
    (opener.current as HTMLElement | null)?.focus?.();
  };
  const body = detail && <Body key={detail.ref} detail={detail} actions={{ ...actions, close }} titleRef={titleRef} />;
  if (mobile)
    return (
      <Sheet open={!!detail} onOpenChange={(o) => !o && close()}>
        <SheetContent side="bottom" onOpenAutoFocus={focusTitle} onCloseAutoFocus={restore} className="max-h-[85svh] gap-0 overflow-y-auto rounded-t-2xl px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))]">
          {body}
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open={!!detail} onOpenChange={(o) => !o && close()}>
      <DialogContent onOpenAutoFocus={focusTitle} onCloseAutoFocus={restore} className="max-h-[90svh] grid-cols-[minmax(0,1fr)] overflow-y-auto rounded-[var(--radius-sheet,1rem)] sm:max-w-[560px]">
        {body}
      </DialogContent>
    </Dialog>
  );
}
