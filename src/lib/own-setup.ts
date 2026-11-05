/**
 * "Runs with your own setup": the models, modes and options that a guest or an account sees and runs only on its own
 * GPU or its own fal.ai / Replicate key, never on this studio's GPUs or keys. One table for every surface: a picker row,
 * a tab, a choice or a menu item shows `ownSetupLabel` next to it, and a press goes through `ownSetupStep`
 * (components/own-setup.tsx does both). The words say only what the visitor needs, never why.
 *
 * Who decides what:
 * - Static items are here: a card bigger than this studio's (Open-H3 Regenerate, WorldCast, Kandinsky 6.0 Pro), a step
 *   that needs nodes or files this studio's GPU doesn't have, a feature that opens on this studio's GPU once a real
 *   render passes (`passes`: gpu-tested.json), and the hosted routes no live call has passed yet (hosted-untested.ts).
 * - The dynamic cases (no worker holds the model right now, a lane not served) are the hosted-run rules' (pool-rules.ts),
 *   which answer in this same shape.
 *
 * Pure (client and server): no server imports. Catalog files must not import this file (it reads the catalog): they
 * call `ownSetupFor(model)` from here instead, or are read by id.
 */
import GPU_TESTED from "../../workflows/comfyui/gpu-tested.json";
import { getModel } from "./catalog";
import { isHostedUntested } from "./catalog/hosted-untested";
import type { Engine, ModelDef } from "./catalog/types";

/** fal.ai or Replicate (your-keys.ts CloudProvider). */
type KeyProvider = "fal" | "replicate";

/**
 * What a visitor needs to run an item.
 * - `gpu`: its own GPU (Fuobe Connect). `vramGb`: the card's memory it needs. `linux`: a Linux computer. `files`: it
 *   needs extra nodes or files on that computer first (Settings → Your GPU sets them up). `orKey`: a key of that
 *   provider runs it too.
 * - `key`: its own key of that provider (fal.ai or Replicate).
 */
export type OwnSetup = { need: "gpu"; vramGb?: number; linux?: true; files?: true; orKey?: KeyProvider } | { need: "key"; provider: string };

interface Entry {
  setup: OwnSetup;
  /** A feature that opens on this studio's GPU once its real render passes (workflows/comfyui/gpu-tested.json). */
  passes?: string;
  /**
   * The ComfyUI graphs that run it on this studio's GPU: its label leaves once the manifest marks each one validated
   * (ownSetupNow in src/server/own-setup-live.ts; a page passes the answer to its client).
   */
  graphs?: readonly string[];
}

const gpu = (vramGb?: number, more: Omit<Extract<OwnSetup, { need: "gpu" }>, "need" | "vramGb"> = {}): OwnSetup => ({ need: "gpu", ...(vramGb && { vramGb }), ...more });

/**
 * The static items, by the id a surface asks with: a model id, or `<studio>:<feature>` for a mode, an option or a step
 * that has no model of its own. Genjutsu's features use their keys in genjutsu.ts (`genjutsu:<key>`).
 */
const ITEMS: Record<string, Entry> = {
  // Open-H3 Regenerate (a 48 GB card) and everything that finishes with it.
  "oss-h3-regenerate": { setup: gpu(48, { files: true }) },
  "regenerate:upscale": { setup: gpu(48, { files: true }) },
  "regenerate:h3-2k": { setup: gpu(48, { files: true }) },
  "regenerate:cinema-finish": { setup: gpu(48, { files: true }) },
  "regenerate:enhance": { setup: gpu(48, { files: true }) },
  "regenerate:faceless": { setup: gpu(48, { files: true }) },
  "regenerate:swap-sharpen": { setup: gpu(48, { files: true }) },
  // MiniMax H3's fast decoder: a newer ComfyUI and its decoder file.
  "h3:fast-decode": { setup: gpu(undefined, { files: true }) },
  // Genjutsu's modes and options, until each passes on this studio's GPU.
  "genjutsu:group-swap-one-by-one": { setup: gpu(24, { files: true }), passes: "group-swap-one-by-one" },
  "genjutsu:object-change": { setup: gpu(24, { files: true }), passes: "object-change" },
  "genjutsu:object-remove": { setup: gpu(24, { files: true }), passes: "object-remove" },
  "genjutsu:object-background": { setup: gpu(24, { files: true }), passes: "object-background" },
  "genjutsu:picture": { setup: gpu(24, { files: true }), passes: "picture" },
  "genjutsu:picture-light": { setup: gpu(24, { files: true }), passes: "picture-light" },
  "genjutsu:picture-own-person": { setup: gpu(24, { files: true }), passes: "picture-own-person" },
  "genjutsu:picture-h3-renderer": { setup: gpu(24, { files: true }), passes: "picture-h3-renderer" },
  "genjutsu:finish-faces": { setup: gpu(24, { files: true }), passes: "finish-faces" },
  "genjutsu:motion-h3": { setup: gpu(24, { files: true }), passes: "motion-h3" },
  // Genjutsu's makers that only those features use.
  "oss-h3-scene-edit": { setup: gpu(24, { files: true }), passes: "object-change" },
  "oss-from-picture": { setup: gpu(24, { files: true }), passes: "picture" },
  "oss-from-picture-frame": { setup: gpu(24, { files: true }), passes: "picture" },
  "oss-h3-fix-faces": { setup: gpu(24, { files: true }), passes: "finish-faces" },
  "oss-h3-motion": { setup: gpu(24, { files: true }), passes: "motion-h3" },
  // "Clean the voice first": a light voice split on any GPU, or a fal.ai key.
  "sound:clean-voice-first": { setup: gpu(undefined, { orKey: "fal" }), passes: "clean-voice-first" },
  // WorldCast filming: a Linux computer with a 48 GB card.
  "oss-worldcast": { setup: gpu(48, { linux: true, files: true }) },
  "worldcast:film": { setup: gpu(48, { linux: true, files: true }) },
  // Exact orbit (Fly around's camera path): a 48 GB card, or a fal.ai key.
  "oss-uni3c-path": { setup: gpu(48) },
  "fly-around:exact-orbit": { setup: gpu(48, { orKey: "fal" }) },
  // Kandinsky 6.0 (open) at Pro quality: an 80 GB card.
  "oss-kandinsky6:pro": { setup: gpu(80) },
  // Image to 3D's extra steps on a GPU.
  "image-to-3d:hi3d-refine": { setup: gpu(24, { files: true }), graphs: ["mesh-refine-hi3d"] },
  "image-to-3d:trellis-final": { setup: gpu(24), graphs: ["image-to-3d-trellis2"] },
  "image-to-3d:idol-other-sides": { setup: gpu(8, { files: true }), graphs: ["image-to-views-idol"] },
  "image-to-3d:idol-clean": { setup: gpu(8, { files: true }), graphs: ["image-to-splat-idol-clean"] },
  // Tools whose steps run on a GPU of the visitor's own.
  "audio:edit-speech": { setup: gpu(24, { files: true }), graphs: ["speech-edit-auk"] },
  // On the visitor's own GPU only: the cloud engine carries the gated Restore IC-LoRA, which never goes with a visitor's
  // own key (src/server/loras.ts prepareCloudLoras), so an account's cloud run is refused before it starts.
  "video-tools:restore": { setup: gpu(24, { files: true }), graphs: ["video-restore-ltx25-tiled"] },
  // Removing a person with H3 and VOID's removal open on this studio's GPU once a real render passes there (`passes`).
  // Their graphs' manifest `validated` only says ComfyUI accepted the graph (scripts/comfy/validate-workflows.mjs
  // queues it with placeholder model files and takes it back before it runs): VOID's two passes and the H3 removal
  // have never rendered on this studio's GPU, so that flag can't lift their label.
  "video-tools:remove-person": { setup: gpu(24), passes: "remove-person" },
  "video-tools:remove-object-void": { setup: gpu(40), passes: "remove-object-void" },
  "cinema:world": { setup: gpu(24, { files: true }) },
  "oss-hy-nomas-world": { setup: gpu(24, { files: true }) },
};

const passed = (GPU_TESTED as { features?: Record<string, { passed?: boolean }> }).features ?? {};

const KEY_PROVIDERS: readonly KeyProvider[] = ["fal", "replicate"];
const isHostedRoute = (r: { provider: string }) => KEY_PROVIDERS.includes(r.provider as KeyProvider);

/**
 * A model's own setup from its routes: a cloud model (or an Original's cloud engine, `engine` "cloud") whose every
 * hosted route is one no live call has passed yet runs on the visitor's own key of that route's provider. Its other
 * engine, if any, is untouched. Null for everything else.
 */
export function ownSetupFor(m: Pick<ModelDef, "id" | "engine" | "engines" | "routes">, engine?: Engine): OwnSetup | null {
  const hosted = m.routes.filter(isHostedRoute);
  if (!hosted.length || !hosted.every((r) => isHostedUntested(m.id, r))) return null;
  const cloudOnly = m.routes.every(isHostedRoute) && !(m.engines && m.engines.length > 1);
  if (!cloudOnly && engine !== "cloud") return null;
  const provider = KEY_PROVIDERS.find((p) => hosted.some((r) => r.provider === p)) ?? "fal";
  return { need: "key", provider };
}

/**
 * What an item needs to run on a visitor's own setup, or null when it runs as any other. `engine`: the side of a Fuobe
 * Original asked for. Never null for an item here until it passes (`passes`) or leaves the untested list. It can't read
 * the manifest (it runs in the browser too), so an item with `graphs` keeps its setup here even once they are
 * validated: a server check (the hosted runs' pool gate) asks ownSetupOnlyNow in src/server/own-setup-live.ts, which
 * reads them. Nothing in the pool enforces this table yet: hosted runs are off (FUOBE_HOSTED_RUNS), and the gate is the
 * hosted runs' to add.
 */
export function ownSetupOnly(modelOrAppId: string, engine?: Engine): OwnSetup | null {
  const item = ITEMS[modelOrAppId];
  if (item) return item.passes && passed[item.passes]?.passed === true ? null : item.setup;
  const m = getModel(modelOrAppId);
  return m ? ownSetupFor(m, engine) : null;
}

/**
 * An item's setup whatever its test says: for a surface that already knows, from the same flags, whether the item has
 * opened on this studio's GPU (Genjutsu's live features, genjutsu-live.ts) and shows the label only until then. Null for
 * an id this table doesn't hold.
 */
export function ownSetupItem(id: string): OwnSetup | null {
  return ITEMS[id]?.setup ?? null;
}

/** The graphs whose validation opens an item on this studio's GPU (none: the label stays, or follows `passes`). */
export function ownSetupGraphs(id: string): readonly string[] {
  return ITEMS[id]?.graphs ?? [];
}

/** Every id this table holds (tests, and the hosted runs' checks). */
export const OWN_SETUP_IDS: readonly string[] = Object.keys(ITEMS);

const KEY_NAME: Record<string, string> = { fal: "fal.ai", replicate: "Replicate" };
const keyName = (p: string) => KEY_NAME[p] ?? p;

/**
 * The label next to an item: "Runs on your own GPU · 48 GB", "Set up on your computer", "Use your own
 * fal.ai key". Plain and positive: what to use, never why.
 */
export function ownSetupLabel(o: OwnSetup): string {
  if (o.need === "key") return `Use your own ${keyName(o.provider)} key`;
  const gb = o.vramGb ? ` · ${o.vramGb} GB` : "";
  if (o.linux) return `Runs on your own Linux GPU${gb}`;
  if (o.orKey) return `Runs on your own GPU${gb} or ${keyName(o.orKey)} key`;
  if (!o.vramGb && o.files) return "Set up on your computer";
  return `Runs on your own GPU${gb}`;
}

/** The short label where a phone has no room: "Your GPU · 48 GB", "Your fal.ai key". */
export function ownSetupShort(o: OwnSetup): string {
  if (o.need === "key") return `Your ${keyName(o.provider)} key`;
  if (o.orKey) return `GPU or ${keyName(o.orKey)} key`;
  return `Your GPU${o.vramGb ? ` · ${o.vramGb} GB` : ""}`;
}

/** One sentence for a tooltip or a card: what the visitor sets up, and where. */
export function ownSetupDetail(o: OwnSetup): string {
  if (o.need === "key") return `Runs with your own ${keyName(o.provider)} key, billed to your ${keyName(o.provider)} account. Add it in Settings → Your keys.`;
  const card = o.vramGb ? `a GPU with ${o.vramGb} GB of memory` : "a GPU";
  const on = o.linux ? `on a Linux computer with ${card}` : `on your own computer with ${card}`;
  const files = o.files ? " Fuobe Connect sets up the files it needs." : "";
  const key = o.orKey ? ` Or use your own ${keyName(o.orKey)} key.` : "";
  return `Runs ${on}. Connect it in Settings → Your GPU.${files}${key}`;
}

/** Who presses: what /api/status says of a guest or an account (StatusInfo.viewer); none for the owner. */
export interface OwnSetupViewer {
  kind: "guest" | "account";
  gpu?: { connected: boolean };
  keys?: readonly string[];
}

/**
 * What a press does:
 * - `run`: the owner (today's behaviour), or an account with the setup: the normal run, on its own GPU or key.
 * - `sign-up`: a guest: "Create a free account to run this".
 * - `add-key`: an account without the key: "Add your key" for that provider.
 * - `connect-gpu`: an account without a GPU: "Connect your GPU" (`gpuOnly`: no key runs it).
 * Never a refusal.
 */
export type OwnSetupStep = { kind: "run" } | { kind: "sign-up" } | { kind: "add-key"; provider: KeyProvider } | { kind: "connect-gpu"; gpuOnly: boolean };

export function ownSetupStep(o: OwnSetup | null, viewer: OwnSetupViewer | null | undefined): OwnSetupStep {
  if (!viewer) return { kind: "run" };
  if (viewer.kind === "guest") return { kind: "sign-up" };
  if (!o) return { kind: "run" };
  const keys = viewer.keys ?? [];
  if (o.need === "key") {
    const p = (KEY_PROVIDERS.includes(o.provider as KeyProvider) ? o.provider : "fal") as KeyProvider;
    return keys.includes(p) ? { kind: "run" } : { kind: "add-key", provider: p };
  }
  if (viewer.gpu?.connected || (o.orKey && keys.includes(o.orKey))) return { kind: "run" };
  return { kind: "connect-gpu", gpuOnly: !o.orKey };
}

/** The words on the button that opens a step: "Create a free account", "Add your fal.ai key", "Connect your GPU"; none for `run`. */
export function ownSetupAction(step: OwnSetupStep): string | null {
  switch (step.kind) {
    case "sign-up":
      return "Create a free account";
    case "add-key":
      return `Add your ${keyName(step.provider)} key`;
    case "connect-gpu":
      return "Connect your GPU";
    default:
      return null;
  }
}
