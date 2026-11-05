"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Cpu, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import { PreflightChecklist } from "@/components/gpu/preflight-checklist";
import { ReadinessBoard } from "@/components/gpu/readiness-board";
import { ConnectChoice } from "@/components/gpu/connect-choice";
import { AiSetupPanel } from "@/components/gpu/ai-setup/ai-setup-panel";
import { AI_SETUP_HREF } from "@/components/gpu/ai-setup/ai-setup-row";
import { PairWithCode } from "@/components/gpu/fuobe-connect";
import { useSettings } from "@/components/connect-field";
import { openFinder, useComputerSupport } from "@/components/gpu/open-connect";
import { usePagePlace } from "@/components/gpu/use-local-comfy";
import { KeyInstead } from "@/components/keys/your-keys";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useGpuCheck, useGpuReadiness } from "@/hooks/use-gpu";
import { signInHref, useStatus, useViewer } from "@/lib/api";
import { ownerSteer } from "@/lib/page-place";
import { safeNext } from "@/lib/safe-redirect";

/**
 * "Connect your GPU" (UX §4): where ComfyUI runs (an account's Your GPU form; the owner's is the studio's own
 * ComfyUI), the live check, then the readiness board. A board older than a minute checks again by itself.
 */
function Step({ n, of = 3, done }: { n: number; of?: number; done?: boolean }) {
  return <span className="text-[12px] text-muted-foreground">{done ? "Done" : `Step ${n} of ${of}`}</span>;
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border bg-background p-4 sm:p-6">{children}</div>;
}

export function ConnectGpu() {
  const params = useSearchParams();
  const router = useRouter();
  const welcome = params.get("welcome") === "1";
  // "Set it up with my AI" as a page of its own: a reload (or a tab the browser put to sleep) opens it again.
  const ai = params.get("setup") === "ai";
  // Fuobe Connect's pairing link (/connect?pair=1, or an older /connect?code=…): approve that ComfyUI first. The
  // person types the code their own ComfyUI shows: a code from the link isn't filled in, so a link that someone else
  // sends can't pair their ComfyUI with this account in one click.
  const pairing = params.get("pair") === "1" || params.has("code");
  const next = safeNext(params.get("next"), typeof window === "undefined" ? "http://localhost" : window.location.origin);
  const viewer = useViewer().data;
  const isAccount = !!viewer?.account;
  const guest = !!viewer && viewer.publicSignup && !viewer.signedIn;
  const r = useGpuReadiness(!!viewer && !guest);
  const check = useGpuCheck();
  const qc = useQueryClient();
  // The account's own address: when it changes (connected, edited), the board starts over.
  const gpu = useQuery({
    queryKey: ["account-gpu"],
    queryFn: async () => (await (await fetch("/api/account/gpu")).json()) as { gpu: { mode: "computer" } | { mode?: "link"; url: string } | null },
    enabled: isAccount,
  });
  const g = gpu.data?.gpu;
  const url = g ? (g.mode === "computer" ? "this computer" : g.url) : null;
  // The owner of a hosted studio with no ComfyUI connected: where it runs comes first (the server's own address would
  // be the server itself, never the owner's computer), and nothing is checked until then.
  const owner = !!viewer?.owner;
  const place = usePagePlace();
  const status = useStatus().data;
  const ownerSettings = useSettings(owner).data;
  const comfyWhere = ownerSettings?.find((s) => s.name === "comfyWhere")?.value;
  const steer = owner ? ownerSteer(place, status, ownerSettings ? comfyWhere || "server" : undefined) : null;
  const ownerSetup = steer === "hosted";
  const support = useComputerSupport();
  const lastUrl = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isAccount || gpu.isLoading) return;
    if (lastUrl.current !== undefined && lastUrl.current !== url) void qc.invalidateQueries({ queryKey: ["gpu"] });
    lastUrl.current = url;
  }, [url, isAccount, gpu.isLoading, qc]);
  // Check by itself when there's no check yet, or it's more than a minute old (once per visit).
  const view = r.data;
  const auto = useRef<string | null>(null);
  useEffect(() => {
    if (!view?.connected || check.running || (view.wait ?? 0) > 0 || ownerSetup || (owner && steer === null)) return;
    const old = view.checkedAt == null || view.stale || Date.now() - view.checkedAt > 60_000;
    const key = `${url ?? "install"}`;
    if (old && auto.current !== key) {
      auto.current = key;
      void check.start();
    }
  }, [view, check, url, ownerSetup, owner, steer]);

  const title = welcome && !guest ? "Welcome! Connect your GPU" : "Connect your GPU";
  const lead = "Make things on your own graphics card with ComfyUI. It's free, private and has no run limit. Fuobe checks what your ComfyUI has, and shows what each studio still needs.";
  // One way on, to where the person was going: "Not now" while nothing runs their work, "Start creating" once a GPU is
  // connected or a fal.ai or Replicate key is saved.
  const hasKey = !!useStatus().data?.viewer?.keys?.length;
  const done = (connected: boolean) => (
    <div className="flex justify-end">
      <Button asChild variant={connected ? "default" : "outline"} className="h-11 sm:h-9">
        <Link href={next}>{connected ? "Start creating" : "Not now"}</Link>
      </Button>
    </div>
  );

  if (!viewer)
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  const header = (step: number, finished?: boolean) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Cpu aria-hidden className="size-5" />
        </span>
        {!guest && <Step n={step} done={finished} />}
      </div>
      <h1 className="font-heading text-[30px] leading-tight">{title}</h1>
      <p className="max-w-2xl text-[15px] text-muted-foreground">{lead}</p>
    </div>
  );

  if (pairing)
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Cpu aria-hidden className="size-5" />
          </span>
          <h1 className="font-heading text-[30px] leading-tight">Connect your ComfyUI</h1>
          <p className="max-w-2xl text-[15px] text-muted-foreground">
            Type the code that your own ComfyUI shows, check the computer, then approve it. Approve only a code you see on your own screen.
          </p>
        </div>
        <Card>
          {guest ? (
            <div className="space-y-3">
              <p className="text-[14px]">Sign in to approve this ComfyUI. Its runs will be yours.</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild className="h-11 sm:h-9">
                  <Link href={signInHref("login", "/connect?pair=1")}>Log in</Link>
                </Button>
                <Button asChild variant="secondary" className="h-11 sm:h-9">
                  <Link href={signInHref("signup", "/connect?pair=1")}>Sign up free</Link>
                </Button>
              </div>
            </div>
          ) : (
            <PairWithCode />
          )}
        </Card>
        {done(false)}
      </div>
    );

  if (guest)
    return (
      <div className="space-y-6">
        {header(1)}
        <Card>
          <div className="flex items-start gap-3">
            <Sparkles aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-text" />
            <div className="min-w-0 space-y-3">
              <p className="text-[14px] font-medium">Run every studio on your own graphics card.</p>
              <p className="text-[13px] text-muted-foreground">
                Create a free account, then connect the ComfyUI on your computer. Fuobe checks your graphics card, models and add-ons, and shows which studios are ready,
                which need one more step, and which need a bigger GPU.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild className="h-11 sm:h-9">
                  <Link href={signInHref("signup", ai ? AI_SETUP_HREF : "/connect")}>Sign up free</Link>
                </Button>
                <Button asChild variant="secondary" className="h-11 sm:h-9">
                  <Link href={signInHref("login", ai ? AI_SETUP_HREF : "/connect")}>Log in</Link>
                </Button>
                <Button asChild variant="secondary" className="h-11 sm:h-9">
                  <Link href={signInHref("signup", AI_SETUP_HREF)}>Set it up with my AI</Link>
                </Button>
              </div>
            </div>
          </div>
        </Card>
      </div>
    );

  // An account's "Set it up with my AI": the panel alone (a card from sm up).
  if (ai && isAccount)
    return (
      <div className="mx-auto w-full max-w-[40rem] sm:rounded-2xl sm:border sm:bg-background sm:p-6">
        <AiSetupPanel
          onBack={() => {
            const q = new URLSearchParams(params.toString());
            q.delete("setup");
            const s = q.toString();
            router.replace(s ? `/connect?${s}` : "/connect", { scroll: false });
          }}
        />
      </div>
    );

  if (ownerSetup)
    return (
      <div className="space-y-6">
        {header(1)}
        <Card>
          <h2 className="mb-3 text-[16px] font-semibold">Where is ComfyUI running?</h2>
          <ConnectChoice className="sm:max-w-none" />
        </Card>
        {done(false)}
      </div>
    );

  const reason = view && !view.connected ? view.reason : undefined;
  if (reason === "off")
    return (
      <div className="space-y-6">
        {header(1)}
        {isAccount ? (
          <Card>
            <ConnectChoice className="sm:max-w-none" />
          </Card>
        ) : (
          <p className="text-[14px] text-muted-foreground">The GPU check is switched off on this studio (FUOBE_GPU_PREFLIGHT=0).</p>
        )}
      </div>
    );

  if (isAccount && (reason === "no-gpu" || reason === "refused" || (!view && !gpu.data?.gpu)))
    return (
      <div className="space-y-6">
        {header(1)}
        {/* Most people have no ComfyUI to hand: their own fal.ai or Replicate key runs paid models now. */}
        <KeyInstead className="bg-background" />
        <Card>
          <h2 className="mb-1 text-[16px] font-semibold">Where is ComfyUI running?</h2>
          {reason === "refused" && <p className="mb-3 text-[13px] text-destructive">Fuobe can&apos;t use this address. Connect your own ComfyUI.</p>}
          <ConnectChoice className="sm:max-w-none" />
        </Card>
        {done(hasKey)}
      </div>
    );

  const report = view?.report;
  const problem = view?.problem;
  const linesFailed = check.lines.some((l) => l.step === "found" && l.state === "fail");
  // A failed check that a later one (the finder's, once ComfyUI is back) put right is no longer shown.
  const showList = check.running || (check.lines.length > 0 && !(linesFailed && !problem));
  const foundFailed = showList && linesFailed;
  const computerFix =
    view?.target === "computer" && support === "ok"
      ? problem === "cors-off"
        ? { label: "Show me how", go: () => openFinder("setting") }
        : problem === "unreachable" || problem === "timeout"
          ? { label: "Find my ComfyUI", go: () => openFinder("find") }
          : null
      : null;
  return (
    <div className="space-y-6">
      {header(report && !check.running ? 3 : 2, !!report && !check.running)}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[16px] font-semibold">{check.running ? "Checking your setup" : "Your ComfyUI"}</h2>
          {isAccount ? (
            <Link href="/settings#your-gpu" className="text-[13px] text-brand-text underline-offset-2 hover:underline">
              {view?.target === "computer" ? "Change where it runs" : "Change the link"}
            </Link>
          ) : (
            <Link href="/settings#comfyui" className="text-[13px] text-brand-text underline-offset-2 hover:underline">
              {view?.target === "computer" ? "Change where it runs" : "The studio's ComfyUI"}
            </Link>
          )}
        </div>
        <div className="mt-3">
          {showList ? (
            <PreflightChecklist lines={check.lines} running={check.running} />
          ) : !view ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : view.checkedAt == null ? (
            <Button className="h-11 sm:h-9" onClick={() => void check.start()}>
              Check my GPU
            </Button>
          ) : (
            <p className="text-[13px] text-muted-foreground">{report ? "Checked. The board below says what runs." : ""}</p>
          )}
          {check.error && (
            <p className="mt-3 flex items-start gap-2 text-[13px]">
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /> {check.error}
            </p>
          )}
          {problem && !check.running && (
            <div className="mt-3 space-y-2 text-[13px]">
              {/* The checklist above says it already: one line, never two. */}
              {!foundFailed && (
                <p className="flex items-start gap-2">
                  <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <span>
                    {view?.problemText}
                    {view?.problemDetail && view.target !== "computer" && <span className="block text-[12px] text-muted-foreground">{view.problemDetail}</span>}
                  </span>
                </p>
              )}
              {/* ComfyUI on this computer without Fuobe's setting, or closed: the finder gives the one fix and goes on by itself. */}
              {computerFix && (
                <Button className="mr-2 h-11 sm:h-9" onClick={computerFix.go}>
                  {computerFix.label}
                </Button>
              )}
              <Button variant="secondary" className="h-11 sm:h-9" onClick={() => void check.start()}>
                Check again
              </Button>
            </div>
          )}
        </div>
      </Card>
      {report && <ReadinessBoard view={view!} owner={!isAccount} onCheck={() => void check.start()} checking={check.running} />}
      {done(true)}
    </div>
  );
}
