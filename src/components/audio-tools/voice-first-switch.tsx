"use client";

import { useId } from "react";
import { OwnSetupChip } from "@/components/own-setup";
import { Switch } from "@/components/ui/switch";
import { useIsAccount, useIsGuest, useSoundLive } from "@/lib/api";
import { VOICE_FIRST_BED, VOICE_FIRST_FEATURE, VOICE_FIRST_HINT, VOICE_FIRST_LABEL, voiceFirstCost } from "@/lib/av/voice-first";
import type { Engine } from "@/lib/catalog/types";
import { ownSetupItem } from "@/lib/own-setup";
import { cn } from "@/lib/utils";

/**
 * "Clean the voice first" beside a transcript or a lip sync (src/lib/av/voice-first.ts): the switch, what it does on
 * this engine and what it adds (time on your GPU, a price in the cloud). Until it has passed a real run on this studio's
 * GPU it starts off, and shows for the owner and, where its run goes to the visitor's own GPU or key (`ownSetup`: Genjutsu,
 * Character Swap Studio), for everyone, marked with what it runs on (src/lib/own-setup.ts); once it has, it shows for
 * everyone, unmarked.
 */
export function useVoiceFirstLive(): boolean {
  return useSoundLive(VOICE_FIRST_FEATURE);
}

export function useVoiceFirstShown(ownSetup = false): boolean {
  const guest = useIsGuest();
  const account = useIsAccount();
  const live = useVoiceFirstLive();
  return live || ownSetup || (!guest && !account);
}

export function VoiceFirstSwitch({ engine, on, onChange, seconds, lip, className }: { engine: Engine; on: boolean; onChange: (on: boolean) => void; seconds?: number; lip?: boolean; className?: string }) {
  const id = useId();
  const cost = voiceFirstCost(engine, seconds);
  const guest = useIsGuest();
  const account = useIsAccount();
  const visitor = guest || account;
  const live = useVoiceFirstLive();
  return (
    <div className={cn("flex min-w-0 items-start gap-2", className)}>
      <Switch id={id} checked={on} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[13px] font-medium">
          {VOICE_FIRST_LABEL}
          {on && cost ? <span className="font-normal text-muted-foreground"> · {cost}</span> : null}
        </label>
        {visitor && !live && <OwnSetupChip setup={ownSetupItem("sound:clean-voice-first")} className="ml-1.5 align-[1px]" />}
        <p className="text-[12px] text-pretty text-muted-foreground">
          {VOICE_FIRST_HINT[engine]}
          {lip ? ` ${VOICE_FIRST_BED[engine]}` : ""}
        </p>
      </div>
    </div>
  );
}
