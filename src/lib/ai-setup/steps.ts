/**
 * The setup's steps, as the open Fuobe tab ticks them off and as the person's AI reads them from the status: one pure
 * function, so both see the same list. Every label and detail comes from the tables here; only fixed words, whole
 * numbers and the studio's own address go into them.
 */
import { FIRST_MODEL_NAME } from "./first-picture";
import type { InstallKind, SetupView } from "./facts";

export type StepId = "comfyui" | "allowed" | "guard" | "connect" | "address" | "connected" | "model" | "picture";
export type StepState = "done" | "todo" | "working" | "warn";

export interface Step {
  id: StepId;
  label: string;
  state: StepState;
  detail?: string;
}

export const INSTALL_LABEL: Record<InstallKind, string> = {
  desktop: "ComfyUI Desktop",
  portable: "Portable or Easy-Install",
  "stability-matrix": "Stability Matrix",
  terminal: "Started from a terminal",
};

export const STEP_LABEL: Record<StepId, string> = {
  comfyui: "ComfyUI is running",
  allowed: "Fuobe is allowed in",
  guard: "The guard is in place",
  connect: "Fuobe Connect is in place",
  address: "Web address works",
  connected: "Fuobe is connected",
  model: "A picture model is ready",
  picture: "First picture made",
};

const hostOf = (site: string) => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};

const gb = (tenths: number) => `${(tenths / 10).toFixed(tenths >= 100 ? 0 : 1)} GB`;

/** Runs go to this setup's ComfyUI now. */
export function isConnected(v: SetupView): boolean {
  const t = v.tab;
  if (v.way === "address") return v.server.gpu === "link" && v.server.online === true;
  return !!t?.connected || (v.server.gpu === "computer" && v.server.online === true && t?.comfy === "found");
}

/** The setup is finished: the first picture is made, or (opened from a run) runs go to the GPU and that run starts. */
export const isDone = (v: SetupView): boolean => v.tab?.picture === "ok" || (!!v.tab?.fromRun && isConnected(v));

function step(id: StepId, state: StepState, detail?: string): Step {
  return { id, label: STEP_LABEL[id], state, ...(detail && { detail }) };
}

function modelStep(v: SetupView, connected: boolean): Step {
  const t = v.tab;
  if (t?.picture === "ok") return step("model", "done", t.modelId ? FIRST_MODEL_NAME[t.modelId] : undefined);
  if (!connected) return step("model", "todo");
  switch (t?.model) {
    case "ready":
      return step("model", "done", t.modelId && FIRST_MODEL_NAME[t.modelId]);
    case "download":
      return step("model", "todo", t.modelId && `${FIRST_MODEL_NAME[t.modelId]}: one download, ${gb(t.modelGbTenths ?? 0)}`);
    case "none":
      return step("model", "warn", "No small picture model fits this GPU");
    default:
      return step("model", "working", "Checking what ComfyUI has");
  }
}

function pictureStep(v: SetupView, connected: boolean): Step {
  const t = v.tab;
  if (t?.fromRun && connected) return step("picture", "done", "Your run starts");
  switch (t?.picture) {
    case "ok":
      return step("picture", "done", t.pictureSecs !== undefined ? `Made in ${t.pictureSecs} s` : undefined);
    case "running":
      return step("picture", "working", "Making it now");
    case "failed":
      return step("picture", "warn", t.pictureCause === "out-of-memory" ? "The GPU ran out of memory" : "It didn't finish");
    default:
      return step("picture", "todo");
  }
}

export function stepsOf(v: SetupView): Step[] {
  const t = v.tab;
  const connected = isConnected(v);
  const tail = (): Step[] => (t?.fromRun ? [pictureStep(v, connected)] : [modelStep(v, connected), pictureStep(v, connected)]);
  if (v.way === "address") {
    const linked = v.server.gpu === "link";
    const address =
      t?.address === "testing"
        ? step("address", "working", "Fuobe is testing it")
        : t?.address === "ok" || linked
          ? step("address", "done", "Fuobe tested it")
          : t?.address === "failed"
            ? step("address", "warn", "Fuobe couldn't use it")
            : step("address", "todo");
    const reach =
      linked && v.server.online === true
        ? step("connected", "done", "Fuobe reaches ComfyUI")
        : linked && v.server.online === false
          ? step("connected", "warn", "Fuobe can't reach it now")
          : linked
            ? step("connected", "working", "Checking")
            : step("connected", "todo");
    return [address, reach, ...tail()];
  }

  const running =
    t?.browser === "blocked"
      ? step("comfyui", "warn", "The browser blocks Fuobe")
      : t?.comfy === "found" || t?.comfy === "unreadable"
        ? step("comfyui", "done", t.port ? `Port ${t.port}${t.install ? `, ${INSTALL_LABEL[t.install]}` : ""}` : undefined)
        : t?.comfy === "waiting"
          ? step("comfyui", "working", "Restarting")
          : t?.comfy === "other"
            ? step("comfyui", "warn", t.port ? `Another app answers on port ${t.port}` : "Another app answers")
            : step("comfyui", "todo");

  if (v.way === "connect") {
    const guarded = t?.guard === "connect" ? step("connect", "done", "Other websites stay out") : step("connect", "todo");
    return [running, guarded, ...tail()];
  }

  const found = t?.comfy === "found";
  const allowed =
    found && t.listen
      ? step("allowed", "warn", "ComfyUI is open to the network")
      : found && t.cors === "any"
        ? step("allowed", "warn", "Every website is let in")
        : found && t.cors === "exact"
          ? step("allowed", "done", `${hostOf(v.site)} only`)
          : found && !t.cors && t.guard === "connect"
            ? step("allowed", "done", `${hostOf(v.site)} only`)
            : t?.comfy === "unreadable" && t.restarted
              ? step("allowed", "warn", "The setting didn't take yet")
              : step("allowed", "todo");
  const guard =
    t?.guard === "guard" || t?.guard === "connect"
      ? step("guard", "done", "Other websites stay out")
      : allowed.state === "done" && t?.guardSkipped
        ? step("guard", "warn", "Connected without the guard")
        : step("guard", "todo");
  return [running, allowed, guard, ...tail()];
}
