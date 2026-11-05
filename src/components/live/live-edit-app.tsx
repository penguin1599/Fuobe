"use client";

import { Cpu, LogIn, Sparkles, Zap } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { OTHER_BROWSERS, openConnect, useComputerSupport } from "@/components/gpu/open-connect";
import { rememberedComfy } from "@/components/gpu/computer-runtime";
import { PhoneNavButton } from "@/components/nav/phone-nav-button";
import { Button } from "@/components/ui/button";
import { signInHref, useHydrated, useStatus, useViewer } from "@/lib/api";
import { cn } from "@/lib/utils";
import { LiveDemo } from "./live-demo";
import { LiveEditor } from "./live-editor";
import { ChannelTransport, ServerTransport, type LiveTransport } from "./live-transport";

/** Where a link may start live edit from: a Fuobe file only (anything else is ignored). */
const fileParam = (v: string | null) => (v && /^\/api\/files\/[\w./%-]{1,300}$/.test(v) ? v : undefined);

/**
 * The Live edit page: who is looking decides what it shows. A guest sees the recorded session playing and an offer to
 * sign up; an account without a GPU sees it with "Connect your GPU". The owner, and an account with its own GPU, get
 * the editor: through the server (a local install, or a linked GPU), or straight from this tab to the ComfyUI on this
 * computer.
 */
export function LiveEditApp() {
  const sp = useSearchParams();
  const image = fileParam(sp.get("image"));
  const text = sp.get("text")?.slice(0, 600) ?? undefined;
  const from = sp.get("from")?.slice(0, 20) ?? undefined;
  const lab = sp.get("lab") === "1";
  const live = useLiveTransport();
  if (live.s !== "ready") return live.s === "loading" ? <LiveSkeleton /> : <LiveShowcase kind={live.s} />;
  return <LiveEditor variant="app" transport={live.transport} image={image} text={text} from={from} canSave={live.owner} lab={live.owner && lab} />;
}

export type LiveAccess = { s: "loading" | "guest" | "connect" | "unsupported" } | { s: "ready"; transport: LiveTransport; owner: boolean };

/** Who is looking, and the way to their ComfyUI: one transport per page. */
export function useLiveTransport(): LiveAccess {
  const viewer = useViewer().data;
  const status = useStatus().data;
  const support = useComputerSupport();
  const mounted = useHydrated();

  const who = !viewer ? null : viewer.publicSignup && !viewer.signedIn ? "guest" : viewer.owner ? "owner" : "account";
  const gpu = status?.viewer?.gpu;
  const computer = !!viewer?.computer;
  const noGpu = who === "account" && status !== undefined && !gpu?.connected;
  const unsupported = computer && support !== "ok";
  const statusKnown = status !== undefined;

  const transport = useMemo<LiveTransport | null>(() => {
    if (!mounted || !who || who === "guest" || noGpu || unsupported) return null;
    if (who === "account" && !statusKnown) return null;
    if (computer) {
      const at = rememberedComfy();
      return new ChannelTransport(at?.port ?? viewer?.comfyPort ?? 8188, at?.host ?? "127.0.0.1");
    }
    return new ServerTransport();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one transport per page
  }, [mounted, who, noGpu, unsupported, computer, statusKnown]);

  if (!mounted || !viewer) return { s: "loading" };
  if (who === "guest") return { s: "guest" };
  if (noGpu) return { s: "connect" };
  if (unsupported) return { s: "unsupported" };
  if (!transport) return { s: "loading" };
  return { s: "ready", transport, owner: who === "owner" };
}

/**
 * Live edit inside the Edit studio (its Live switch): the same editor, seeded with the composer's picture. "Use in
 * Edit" hands the picture on screen (full quality) back to the composer, so the full model can finish the job.
 */
export function LiveEditPanel({ image, text, onUse, onClose }: { image?: string; text?: string; onUse: (url: string) => void; onClose: () => void }) {
  const live = useLiveTransport();
  if (live.s === "ready") return <LiveEditor variant="embedded" transport={live.transport} image={fileParam(image ?? null)} text={text} from="edit" canSave={live.owner} onUse={onUse} onClose={onClose} />;
  return (
    <div className="grid h-full place-items-center rounded-2xl border p-2 sm:p-4" data-live-panel>
      {live.s === "loading" ? (
        <span className="text-[13px] text-muted-foreground">Starting Live edit…</span>
      ) : (
        <div className="grid w-full max-w-5xl items-center gap-5 md:grid-cols-[1.3fr_1fr]">
          <LiveDemo className="aspect-[4/3] w-full" />
          <div>
            <p className="font-heading text-[24px] leading-tight">Change it as you type</p>
            <p className="mt-1.5 text-[13.5px] text-muted-foreground">
              {live.s === "guest" ? "Sign up free to run Live edit on your own GPU." : live.s === "connect" ? "Live edit runs on your own GPU. Connect it to start." : <CantReach />}
            </p>
            <div className="mt-3 flex gap-2">
              {live.s === "guest" ? (
                <Button asChild>
                  <Link href={signInHref("signup", "/edit")}>Sign up free</Link>
                </Button>
              ) : live.s === "connect" || live.s === "unsupported" ? (
                <Button onClick={() => openConnect()}>
                  <Cpu className="size-4" />
                  Connect your GPU
                </Button>
              ) : null}
              <Button variant="ghost" onClick={onClose}>
                Back to Edit
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function LiveSkeleton() {
  return (
    <div className="flex h-content flex-col gap-3 p-3 sm:p-4" aria-busy>
      <div className="h-8 w-48 animate-pulse rounded-lg bg-muted" />
      <div className="min-h-0 flex-1 animate-pulse rounded-2xl bg-muted" />
      <div className="h-11 animate-pulse rounded-2xl bg-muted" />
    </div>
  );
}

/**
 * Live edit with "this computer" in a browser that can't reach it (Safari, a phone or tablet, a page marked not secure):
 * why, in the person's terms, then the way that works from here (a web address; "Connect your GPU" beside these words
 * opens it). Never "open Fuobe in…": Fuobe is open.
 */
const CANT_REACH: Record<"safari" | "phone" | "http", string> = {
  safari: "Safari doesn't let a website talk to programs on your Mac. Give your ComfyUI a web address, and Live edit works from Safari.",
  phone: "A phone or tablet can't talk to programs on your computer from a website. Give your ComfyUI a web address, and Live edit works from here.",
  http: "Your browser marks this page as not secure, so it doesn't let the page talk to programs on this computer. Give your ComfyUI a web address, and Live edit works from here.",
};

function CantReach() {
  const support = useComputerSupport();
  const why = support === "ok" ? "http" : support;
  return (
    <>
      {CANT_REACH[why]}
      {why === "safari" && <span className="mt-1 block text-[12px]">{OTHER_BROWSERS}</span>}
    </>
  );
}

/** Guests, accounts without a GPU, and browsers that can't reach this computer: the recorded session, and the next step. */
function LiveShowcase({ kind }: { kind: "guest" | "connect" | "unsupported" }) {
  const [nudge, setNudge] = useState(false);
  return (
    <div className="flex min-h-content flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4 sm:px-6">
        <h1 className="flex items-center gap-2 font-heading text-[22px] leading-none">
          <Zap className="size-4 text-primary" />
          Live edit
        </h1>
        <span className="ml-1 rounded-full bg-highlight px-2 py-0.5 text-[11px] font-semibold text-highlight-foreground">New</span>
        <PhoneNavButton className="ml-auto" />
      </header>
      <div className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-6 px-4 pb-6 sm:px-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:gap-10">
        <LiveDemo className="aspect-[4/3] w-full shadow-strong" onTypeAttempt={() => setNudge(true)} />
        <div className="max-w-md">
          <p className="font-heading text-[34px] leading-[1.08] text-balance sm:text-[40px]">Change a picture as you type</p>
          <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground text-pretty">
            Type a change and watch the picture follow, then keep adding to the same words. Every frame renders all of them on your original, so nothing blurs, however many changes you make.
          </p>
          <ul className="mt-4 space-y-1.5 text-[13.5px]">
            {["Live frames as you type, on your own GPU", "One prompt that keeps growing", "Undo a change, or start fresh from the picture", "Paint a region to change only that"].map((t) => (
              <li key={t} className="flex items-center gap-2">
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                {t}
              </li>
            ))}
          </ul>
          <div className={cn("mt-6 rounded-2xl border p-4 transition-shadow", nudge && "ring-3 ring-primary/30")} data-live-cta>
            {kind === "guest" ? (
              <>
                <p className="font-medium">{nudge ? "Create a free account to run this." : "Sign up free to run Live edit on your own GPU"}</p>
                <p className="mt-1 text-[13px] text-muted-foreground">Free accounts run it on their own ComfyUI: this computer, or a GPU you link.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild>
                    <Link href={signInHref("signup", "/live-edit")}>Sign up free</Link>
                  </Button>
                  <Button asChild variant="secondary">
                    <Link href={signInHref("login", "/live-edit")}>
                      <LogIn className="size-4" />
                      Log in
                    </Link>
                  </Button>
                </div>
              </>
            ) : kind === "connect" ? (
              <>
                <p className="font-medium">Connect your GPU to run this</p>
                <p className="mt-1 text-[13px] text-muted-foreground">Live edit runs on your own ComfyUI: the one on this computer, or one you link.</p>
                <Button className="mt-3" onClick={() => openConnect()}>
                  <Cpu className="size-4" />
                  Connect your GPU
                </Button>
              </>
            ) : (
              <>
                <p className="font-medium">Live edit can&apos;t reach your ComfyUI from here</p>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  <CantReach />
                </p>
                <Button className="mt-3" onClick={() => openConnect()}>
                  <Cpu className="size-4" />
                  Connect your GPU
                </Button>
              </>
            )}
          </div>
          <p className="mt-4 text-[12px] text-muted-foreground">Runs on your own GPU</p>
        </div>
      </div>
    </div>
  );
}
