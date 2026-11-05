"use client";

import { Box } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useStatus } from "@/lib/api";
import { IMAGE_ASPECTS, planCinema, type CinemaPlan, type DirectorSettings } from "@/lib/catalog/cinema";
import type { Engine } from "@/lib/catalog/types";
import { formatCost } from "@/lib/format";
import type { CinemaGeneration } from "./hooks";
import { placeholdersOn } from "@/lib/demo-mode";

/**
 * Cinema Studio's 3D scene, the light half (the viewer and three.js load only when a scene opens): which takes
 * are scenes, what a step costs, and the "Create 3D scene" confirmation (Higgsfield asks the same, with
 * "Don't show this again").
 */

export type SceneSource = { kind: "mesh"; url: string } | { kind: "points"; photo: string; depth: string };

export interface SceneTake {
  generation: CinemaGeneration;
  /** The still the scene was built from: image 2 of every recomposition. */
  still: string;
  source: SceneSource;
  /** The frame starts on the still's ratio when it is one of the project's, else 16:9. */
  aspect: string;
}

/** A finished "Create 3D scene" take, ready for the viewer: MoGe's mesh (open) or the still + depth map (cloud). */
export function sceneTake(g: CinemaGeneration): SceneTake | null {
  if (g.feature !== "cinema-scene" || g.status !== "succeeded") return null;
  const still = g.request.inputs?.images?.[0];
  if (!still) return null;
  const mesh = g.outputs.find((o) => o.kind === "model3d");
  const depth = g.outputs.find((o) => o.kind === "image");
  const source: SceneSource | null = mesh ? { kind: "mesh", url: mesh.url } : depth ? { kind: "points", photo: still, depth: depth.url } : null;
  if (!source) return null;
  const ar = g.request.params?.aspectRatio;
  return { generation: g, still, source, aspect: ar && IMAGE_ASPECTS.includes(ar) ? ar : "16:9" };
}

/** What a plan costs here: "Placeholder · free" while placeholder results are on (Settings, for a tour). */
export function usePlanPrice(plan: CinemaPlan): { cost: number | null; label: string; demo: boolean } {
  const status = useStatus().data;
  const demo = placeholdersOn(status?.demoMode);
  const cost = demo ? 0 : plan.costUsd;
  // Free on the GPU says where it runs, like every other price on it.
  const free = plan.model.engine === "open" ? "Free · your GPU" : "Free";
  return { cost, demo, label: demo ? "Placeholder · free" : cost === 0 ? free : cost != null ? `≈ ${formatCost(cost)}` : "Price unknown" };
}

const SKIP_KEY = "fuobe.cinema.sceneConfirm";

/**
 * "Don't ask again" holds for the price it was ticked at (kept in this browser): another price (a different engine,
 * a key added, demo mode off) asks again, and the toast of a build that didn't ask offers "Ask first".
 */
export function skipSceneConfirm(price: string): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === `skip:${price}`;
  } catch {
    return false;
  }
}

export function askSceneConfirmAgain() {
  try {
    localStorage.removeItem(SKIP_KEY);
  } catch {}
}

export interface ScenePlanContext {
  engine: Engine;
  settings: DirectorSettings;
  context: { cloudAllowed: boolean; civitai?: boolean; worldcast?: boolean };
  brief: string;
}

/** The plan of "Create 3D scene" for one still (the menu shows its price, the dialog its notes). */
export function useScenePlan(still: string | null, aspect: string | undefined, p: ScenePlanContext): CinemaPlan {
  return useMemo(
    () =>
      planCinema(
        { engine: p.engine, mode: "image", action: "scene", prompt: "", settings: p.settings, brief: p.brief, aspectRatio: aspect, source: still ? { url: still, kind: "image" } : undefined },
        p.context,
      ),
    [still, aspect, p.engine, p.settings, p.brief, p.context],
  );
}

export function SceneCreateDialog({
  still,
  aspect,
  plan,
  onOpenChange,
  onConfirm,
}: {
  /** The still to build from (null = closed). */
  still: string | null;
  aspect?: string;
  plan: CinemaPlan;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const price = usePlanPrice(plan);
  const [skip, setSkip] = useState(false);
  const skipId = useId();
  const open = plan.model.engine === "open";
  return (
    <Dialog open={!!still} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-heading text-[22px] font-normal">
            <Box className="size-5 text-brand-text" /> Create a 3D scene?
          </DialogTitle>
          <DialogDescription>This turns your still into a 3D scene you can fly a camera through. Capture any view and it is re-rendered as a new take.</DialogDescription>
        </DialogHeader>
        {still && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={still} alt="The still to build from" className="max-h-48 w-full rounded-lg bg-muted object-contain" style={{ aspectRatio: aspect?.replace(":", "/") }} />
        )}
        <div className="space-y-1.5 rounded-lg bg-muted/60 p-3 text-[13px]">
          <p>{plan.notes[0]}</p>
          <p className="flex items-center justify-between gap-3 font-medium">
            <span>{open ? "Open source · MoGe 2" : "Cloud · Marigold V2 depth"}</span>
            <span className={price.cost === 0 ? "text-brand-text" : undefined}>{price.label}</span>
          </p>
          {!open && <p className="text-[12px] text-muted-foreground">Each re-render of a captured view is priced again before it runs.</p>}
        </div>
        <label htmlFor={skipId} className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Checkbox id={skipId} checked={skip} onCheckedChange={(v) => setSkip(v === true)} /> Don&apos;t ask again at this price
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!!plan.blocker}
            onClick={() => {
              if (skip)
                try {
                  localStorage.setItem(SKIP_KEY, `skip:${price.label}`);
                } catch {}
              onConfirm();
            }}
          >
            <Box /> Build 3D scene · {price.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
