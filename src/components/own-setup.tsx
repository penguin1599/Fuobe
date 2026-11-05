"use client";

import { Cpu, KeyRound } from "lucide-react";
import { useCallback } from "react";
import { askToSignUp, CONNECT_GPU_EVENT, useIsOwner, useStatus, type ConnectGpuDetail } from "@/lib/api";
import { ownSetupAction, ownSetupDetail, ownSetupLabel, ownSetupOnly, ownSetupShort, ownSetupStep, type OwnSetup, type OwnSetupStep, type OwnSetupViewer } from "@/lib/own-setup";
import { Button } from "@/components/ui/button";
import { openAddKey } from "@/components/keys/your-keys";
import { cn } from "@/lib/utils";

/**
 * The "runs with your own setup" label and press (src/lib/own-setup.ts). Every surface that shows such an item (a
 * picker row, a tab, a choice, a menu item) puts `OwnSetupChip` next to its name and sends its press through
 * `useOwnSetupPress`: a guest gets "Create a free account", an account without the setup "Add your key" or "Connect
 * your GPU", and anyone with it (and the owner) the normal run.
 */

/**
 * The label: a small chip in the studios' badge style (the pickers' "Open source" and "Reads boxes" chips). `short`
 * uses the short words on a phone. Fixed height, so it never moves the row it sits in.
 */
export function OwnSetupChip({ setup, short = true, className }: { setup: OwnSetup | string | null | undefined; short?: boolean; className?: string }) {
  const o = typeof setup === "string" ? ownSetupOnly(setup) : setup;
  if (!o) return null;
  const Icon = o.need === "key" ? KeyRound : Cpu;
  const label = ownSetupLabel(o);
  return (
    <span
      data-slot="own-setup"
      title={ownSetupDetail(o)}
      className={cn(
        "inline-flex h-4 max-w-full shrink-0 items-center gap-1 overflow-hidden rounded-[4px] bg-brand-faint px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-brand-text",
        className,
      )}
    >
      <Icon className="size-2.5! shrink-0" aria-hidden />
      {short ? (
        <>
          <span className="truncate sm:hidden">{ownSetupShort(o)}</span>
          <span className="truncate max-sm:hidden">{label}</span>
        </>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </span>
  );
}

/**
 * The label as its icon alone, for a place with room for a word or two (a tab): the words are its tooltip and what a
 * screen reader says.
 */
export function OwnSetupMark({ setup, className }: { setup: OwnSetup | string | null | undefined; className?: string }) {
  const o = typeof setup === "string" ? ownSetupOnly(setup) : setup;
  if (!o) return null;
  const Icon = o.need === "key" ? KeyRound : Cpu;
  const label = ownSetupLabel(o);
  return (
    <span data-slot="own-setup" title={label} className={cn("inline-flex shrink-0 items-center text-brand-text", className)}>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">{`, ${label}`}</span>
    </span>
  );
}

/**
 * In place of a form a visitor can't run yet (a dialog, a panel): the item's label, one sentence on what it runs with
 * (or `children`), and the one button that sets it up ("Create a free account", "Add your fal.ai key", "Connect your
 * GPU"). Just the label for the owner, or a visitor who has the setup (its form shows instead, so this isn't used).
 */
export function OwnSetupNote({ setup, children, onOpen, className }: { setup: OwnSetup | string | null | undefined; children?: React.ReactNode; onOpen?: () => void; className?: string }) {
  const viewer = useOwnSetupViewer();
  const o = typeof setup === "string" ? ownSetupOnly(setup) : setup;
  if (!o) return null;
  const step = ownSetupStep(o, viewer);
  const action = ownSetupAction(step);
  return (
    <div data-slot="own-setup-note" className={cn("flex flex-col items-start gap-2 rounded-xl bg-muted p-3 text-[13px] text-muted-foreground", className)}>
      <OwnSetupChip setup={o} short={false} />
      <p>{children ?? ownSetupDetail(o)}</p>
      {action && (
        <Button
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => {
            onOpen?.();
            openOwnSetupStep(step);
          }}
        >
          {action}
        </Button>
      )}
    </div>
  );
}

/** Who is looking, as own-setup.ts reads it: null for the owner (and on the owner's own install). */
export function useOwnSetupViewer(): OwnSetupViewer | null {
  const owner = useIsOwner();
  const v = useStatus().data?.viewer;
  if (owner || !v) return null;
  return { kind: v.kind, gpu: v.gpu, keys: v.keys };
}

/** Opens what a step asks for. True when it opened something (the run waits); false for `run`. */
export function openOwnSetupStep(step: OwnSetupStep): boolean {
  switch (step.kind) {
    case "sign-up":
      askToSignUp("run");
      return true;
    case "add-key":
      openAddKey(step.provider);
      return true;
    case "connect-gpu":
      window.dispatchEvent(new CustomEvent<ConnectGpuDetail>(CONNECT_GPU_EVENT, { detail: { action: "run", ...(step.gpuOnly ? { gpuOnly: true, needs: "gpu" } : { needs: "any" }) } }));
      return true;
    default:
      return false;
  }
}

/**
 * The press for an item: `press(idOrSetup, run)` runs it when the viewer has the setup (or is the owner), and otherwise
 * opens the sign-up, "Add your key" or "Connect your GPU" card. Returns whether it ran.
 */
export function useOwnSetupPress(): (item: OwnSetup | string | null | undefined, run?: () => void) => boolean {
  const viewer = useOwnSetupViewer();
  return useCallback(
    (item, run) => {
      const o = typeof item === "string" ? ownSetupOnly(item) : (item ?? null);
      if (openOwnSetupStep(ownSetupStep(o, viewer))) return false;
      run?.();
      return true;
    },
    [viewer],
  );
}
