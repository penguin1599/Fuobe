"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Loader2, Unplug } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { gib, isLocalAddress, TunnelSteps } from "@/components/gpu/comfy-finder";
import { TroubleActions, TroubleDetails, autoCheckIn } from "@/components/gpu/trouble";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStatus, type GpuTroubleView } from "@/lib/api";
import { canSaveAnyway } from "@/lib/diagnose";
import { responseError, toastError } from "@/lib/refusals";
import { cn } from "@/lib/utils";

interface GpuState {
  /** A link, or the ComfyUI on this computer (connect-choice.tsx shows that one). */
  gpu: { mode?: "link"; url: string; hasToken: boolean } | { mode: "computer" } | null;
}
interface GpuInfo {
  device?: string;
  vramBytes?: number;
  version?: string;
}
/** A PUT's answer: the GPU and what it is, or (422, 429, or saved anyway) why not in plain words with what helps. */
type PutAnswer = GpuState & { info?: GpuInfo; note?: string; url?: string; offline?: true; error?: string; trouble?: GpuTroubleView };

class CheckError extends Error {
  constructor(
    message: string,
    readonly answer: PutAnswer,
    readonly retryAfterS?: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, body?: unknown, test = false): Promise<T> {
  const res = await fetch(`/api/account/gpu${test ? "?test=1" : ""}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string; trouble?: GpuTroubleView };
  if (!res.ok) {
    if (method === "PUT" && (j.trouble || res.status === 429)) throw new CheckError(j.trouble?.words ?? j.error ?? "Something went wrong. Please try again.", j as unknown as PutAnswer, Number(res.headers.get("retry-after")) || undefined);
    throw responseError(res, j.error ?? "Something went wrong. Please try again.");
  }
  return j;
}

/** A check that didn't pass, as shown under the field: its words, details and buttons, and when it checks again by itself. */
interface Failed {
  words: string;
  trouble?: GpuTroubleView;
  /** Checking again by itself at this time (a GPU that is off or starting up, too many checks). */
  againAt?: number;
  /** The check was a Connect (not a Test): "Save anyway" can keep the address. */
  connecting: boolean;
}

/**
 * "Your GPU" (public sign-up): an account's own ComfyUI, where its runs go (never this studio's keys
 * or GPU). The server calls it, so it needs a web address anyone can reach: cloudflared (or another tunnel) in front
 * of a local ComfyUI, or a RunPod pod's address. Nothing here looks for a ComfyUI on this device: it shows how to make
 * that address (TunnelSteps), in words a visitor needs no dictionary for. A check that doesn't pass says why in plain
 * words, with what helps; a GPU that is off or starting up is checked again by itself, and its address can be saved
 * anyway. The saved GPU's card says whether it answers now. 36rem wide at most from sm up, unless a wider page lifts
 * that (className, as ConnectChoice's).
 */
export function YourGpu({ className, onLinked }: { className?: string; onLinked?: () => void } = {}) {
  const qc = useQueryClient();
  const id = useId();
  const q = useQuery({ queryKey: ["account-gpu"], queryFn: () => call<GpuState>("GET") });
  const live = useStatus().data?.viewer?.gpu;
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "anyway" | "remove" | null>(null);
  const [info, setInfo] = useState<GpuInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<Failed | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // The self-check: when it started and how many checks it made (diagnose.ts retryPlan "check").
  const auto = useRef<{ startedAt: number; attempt: number; connecting: boolean } | null>(null);

  const local = !!url.trim() && isLocalAddress(/^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : `http://${url.trim()}`);
  const linked = () => {
    // Runs go to the link now, not to a Fuobe tab on this computer, and its own files are taken (the status says so).
    void qc.invalidateQueries({ queryKey: ["viewer"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
  };
  const send = async (mode: "test" | "save" | "anyway", again = false) => {
    setBusy(mode);
    if (!again) auto.current = null;
    try {
      const r = await call<PutAnswer>("PUT", { url: url.trim(), token: token.trim() || undefined, ...(mode === "anyway" && { anyway: true }) }, mode === "test");
      auto.current = null;
      setFailed(null);
      setInfo(r.info ?? null);
      setNote(r.note ?? null);
      if (r.url && mode === "test") setUrl(r.url);
      if (mode !== "test") {
        qc.setQueryData(["account-gpu"], { gpu: r.gpu });
        linked();
        if (r.offline) toast("Your address is saved. Your runs start as soon as your GPU answers.");
        else toast.success("Your GPU is connected. Runs go to your ComfyUI now.");
        setUrl("");
        setToken("");
        onLinked?.();
      }
    } catch (e) {
      setInfo(null);
      if (!(e instanceof CheckError)) {
        setFailed({ words: (e as Error).message, connecting: mode !== "test" });
        return;
      }
      // The address as the check made it whole (https:// added, a "?…" left out) goes back in the field, said below it.
      if (e.answer.url) setUrl(e.answer.url);
      setNote(e.answer.note ?? null);
      const trouble = e.answer.trouble;
      const connecting = mode !== "test";
      // A GPU that is off or starting up (or too many checks): checked again by itself, with a growing wait.
      const run = (auto.current ??= { startedAt: Date.now(), attempt: 0, connecting });
      run.attempt++;
      const wait = trouble ? (e.retryAfterS ? e.retryAfterS * 1000 : autoCheckIn(trouble.cause, run.attempt, run.startedAt)) : null;
      if (wait === null) auto.current = null;
      setFailed({ words: e.message, trouble, connecting, ...(wait !== null && { againAt: Date.now() + wait }) });
    } finally {
      setBusy(null);
    }
  };
  // The self-check's clock: a countdown on the page, then the same check again (a Connect stays a Test until it answers).
  const againAt = failed?.againAt;
  useEffect(() => {
    if (!againAt) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= againAt && auto.current) {
        clearInterval(t);
        void send(auto.current.connecting ? "save" : "test", true);
      }
    }, 1000);
    return () => clearInterval(t);
    // The check runs with the address and token in the fields now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [againAt]);
  const stopAuto = () => {
    auto.current = null;
    setFailed((f) => (f ? { ...f, againAt: undefined } : f));
  };
  const remove = async () => {
    setBusy("remove");
    try {
      qc.setQueryData(["account-gpu"], await call<GpuState>("DELETE"));
      void qc.invalidateQueries({ queryKey: ["status"] });
      setInfo(null);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  if (q.isError) return <p className="text-[13px] text-muted-foreground">{q.error.message}</p>;
  if (!q.data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const gpu = q.data.gpu?.mode === "computer" ? null : q.data.gpu;
  // The saved link's last status check (every 30 s while the page is open): online, or why not.
  const offline = gpu && live?.connected && live.mode === "link" && live.online === false;
  const seconds = againAt ? Math.max(0, Math.ceil((againAt - now) / 1000)) : 0;

  return (
    <div className={cn("w-full min-w-0 space-y-4 sm:max-w-[36rem]", className)}>
      <p className="text-[13px] text-muted-foreground">
        {gpu ? "Your runs go to your ComfyUI through this web address." : "Your runs reach your ComfyUI through a web address. Here's how to give it one:"}
      </p>
      {gpu ? (
        <div className={cn("space-y-2 rounded-xl px-3 py-2.5 text-[13px]", offline ? "border border-dashed" : "bg-brand-faint")}>
          <div className="flex items-start gap-2.5">
            <Cpu className={cn("mt-0.5 size-4 shrink-0", offline ? "text-muted-foreground" : "text-brand-text")} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{offline ? "Offline: your GPU isn't answering right now" : "Connected"}</p>
              <p className="truncate font-mono text-[12px] text-muted-foreground">
                {gpu.url}
                {gpu.hasToken ? " · with a token" : ""}
              </p>
            </div>
            <Button size="sm" variant="ghost" className="-my-1 h-7" onClick={() => void remove()} disabled={busy !== null}>
              {busy === "remove" ? <Loader2 className="animate-spin" /> : <Unplug />} Disconnect
            </Button>
          </div>
          {offline && (
            <div className="space-y-1.5 pl-6.5">
              {live.trouble && <p className="text-[12px] text-muted-foreground">{live.trouble.words}</p>}
              <TroubleDetails details={live.trouble?.details} />
              <TroubleActions
                actions={[
                  // Check now first, then what the check said helps (Start your pod…), without the address fields' own.
                  { kind: "check-gpu", label: "Check now" },
                  ...(live.trouble?.actions ?? []).filter((a) => a.kind !== "check-gpu" && a.kind !== "gpu-settings"),
                ]}
              />
            </div>
          )}
        </div>
      ) : (
        <TunnelSteps />
      )}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-url`} className="text-[13px]">
            {gpu ? "Connect another address" : "Your ComfyUI's web address"}
          </Label>
          <Input
            id={`${id}-url`}
            placeholder="https://your-address.trycloudflare.com"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setNote(null);
              stopAuto();
            }}
            aria-invalid={!!failed || local}
          />
          {local && (
            <p className="text-[12px] text-destructive">That address only works on your own computer or network. Paste the one cloudflared shows, ending in trycloudflare.com.</p>
          )}
          {note && <p className="text-[12px] text-muted-foreground">{note}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-token`} className="text-[13px]">
            Access token <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input id={`${id}-token`} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-describedby={`${id}-token-hint`} />
          <p id={`${id}-token-hint`} className="text-[12px] text-muted-foreground">
            Only if your ComfyUI or its web address asks for a password or token.
          </p>
        </div>
        {failed && (
          <div className="space-y-1.5" aria-live="polite">
            <p className={cn("text-[12px]", failed.trouble?.retryable ? "text-foreground" : "text-destructive")}>{failed.words}</p>
            <TroubleDetails details={failed.trouble?.details} />
            {failed.againAt && (
              <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {seconds > 0 ? `Waiting for your GPU · checking again in ${seconds} s` : "Checking again…"}
                <button type="button" onClick={stopAuto} className="underline underline-offset-2 hover:text-foreground">
                  Stop
                </button>
              </p>
            )}
            {failed.trouble && <TroubleActions actions={failed.trouble.actions.filter((a) => a.kind !== "gpu-settings" && a.kind !== "check-gpu")} />}
          </div>
        )}
        {info && (
          <p className="text-[12px] text-muted-foreground">
            ComfyUI answered{info.device ? `: ${info.device}` : ""}
            {gib(info.vramBytes) ? ` · ${gib(info.vramBytes)} VRAM` : ""}
            {info.version ? ` · ComfyUI ${info.version}` : ""}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void send("save")} disabled={!url.trim() || local || busy !== null}>
            {busy === "save" && <Loader2 className="animate-spin" />} Connect
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void send("test")} disabled={!url.trim() || local || busy !== null}>
            {busy === "test" && <Loader2 className="animate-spin" />} Test
          </Button>
          {/* A GPU that is off right now (a stopped pod, one starting up): keep the address, and runs wait for it. */}
          {failed?.trouble && canSaveAnyway(failed.trouble.cause) && !!url.trim() && !local && (
            <Button size="sm" variant="ghost" onClick={() => void send("anyway")} disabled={busy !== null}>
              {busy === "anyway" && <Loader2 className="animate-spin" />} Save anyway
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
