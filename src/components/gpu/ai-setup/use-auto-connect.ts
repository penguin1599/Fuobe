"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ReadinessView } from "@/hooks/use-gpu";
import { installFromStats, platformOf } from "@/lib/comfy-install";
import { checkThisComputer, sendCheck } from "@/lib/gpu/browser-check";
import type { SystemStats } from "@/lib/local-comfy";
import { computerState, rememberComfy, restartComputerRunner, store } from "../computer-runtime";

/**
 * "Set it up with my AI", this browser's way: once ComfyUI lets Fuobe in and Fuobe's guard is there (`ready`), the
 * account's runs go to this computer, with no click. The same steps as ThisComputer's connect (this-computer.tsx): the
 * account's GPU becomes "this computer", the browser remembers where ComfyUI is, the tab that runs the jobs moves there,
 * and the GPU check says what this ComfyUI has (the readiness badges the first picture reads).
 */

const nav = () => navigator as Navigator & { userAgentData?: { platform?: string } };

async function connectThisComputer(): Promise<void> {
  const res = await fetch("/api/account/gpu", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "computer" }) });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Something went wrong. Please try again.");
}

/** The GPU check from this browser: what this ComfyUI has, for the readiness board and the badges. */
export async function checkHere(qc: ReturnType<typeof useQueryClient>, port: number, host: string): Promise<void> {
  const board = await sendCheck<ReadinessView>(await checkThisComputer(port, { host }));
  qc.setQueryData(["gpu", "readiness"], board);
  void qc.invalidateQueries({ queryKey: ["gpu", "badges"] });
  void qc.invalidateQueries({ queryKey: ["gpu", "plan"] });
}

export function useAutoConnect(o: { ready: boolean; port?: number; host?: string; stats?: SystemStats; onConnected?: () => void }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const going = useRef<string | null>(null);
  const key = o.port && o.host ? `${o.host}:${o.port}` : null;

  useEffect(() => {
    if (!o.ready || !key || !o.port || !o.host || !o.stats || going.current === key) return;
    going.current = key;
    const { port, host, stats } = o;
    void (async () => {
      try {
        await connectThisComputer();
        rememberComfy(port, host);
        store("reached", "1");
        store("install", installFromStats(stats, port, platformOf(nav())));
        // The tab that runs the jobs goes there now (another port, or a browser that only listened until now).
        const running = computerState().view;
        if (running && (running.port !== port || running.access)) restartComputerRunner();
        setError(null);
        setConnected(key);
        o.onConnected?.();
        for (const k of [["viewer"], ["account-gpu"], ["status"]]) void qc.invalidateQueries({ queryKey: k });
        await checkHere(qc, port, host).catch(() => void qc.invalidateQueries({ queryKey: ["gpu", "badges"] }));
      } catch (e) {
        going.current = null;
        setError((e as Error).message);
      }
    })();
  }, [o, key, qc]);

  return { connected: !!key && connected === key, error };
}
