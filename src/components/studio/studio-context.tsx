"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Engine, GenParams, InputSlot, MediaKind, Operation, Preset } from "@/lib/catalog/types";
import type { FeedFilter } from "@/lib/api";
import type { Signature } from "@/lib/catalog/palettes";
import type { FrameAttachment } from "@/lib/composer";
import type { LayoutDraft } from "@/lib/layout-prompt";
import type { UpscaleFirstStep } from "@/lib/catalog/upscale-first";
import type { FinishChoice } from "@/lib/catalog/regenerate";
import type { SlotValue } from "./media-slot";

export type SlotKey = InputSlot["key"];

export interface StudioConfig {
  /** Stored on each generation; used for feed filtering. */
  feature: string;
  title: string;
  hero: string;
  /** Small line under the hero (e.g. which models an app runs on). */
  subtitle?: string;
  /**
   * A studio that does the job in more depth, linked under the hero (Edit video → Genjutsu). `models`: the model it opens on,
   * per engine (Lipsync → the Video studio on Kandinsky 6.0, a talking character from words), added as ?model=.
   */
  related?: { href: string; label: string; models?: Partial<Record<Engine, string>> };
  /** Steps a tool runs before this one, then this one after it, as one job (Upscale → Restore archive footage first). */
  firstSteps?: UpscaleFirstStep[];
  /** Open finishing models shown side by side above the toolbar (Upscale → Video: Restore · faithful, Regenerate · creative while it is offered). */
  finishChoices?: readonly FinishChoice[];
  placeholder: string;
  kind: MediaKind;
  /** Operations whose models appear in the picker. */
  ops: Operation[];
  /** Narrower than `ops` for the picker list: the Image studio lists text-to-image models; edit-only tools live in Edit. */
  pickerOps?: Operation[];
  feed: FeedFilter;
  slots: InputSlot[];
  /** Extra reference images (multi-reference edit / image prompt), or a list of clips (kind "video": join clips). */
  multiRef?: { label: string; max: number; kind?: MediaKind };
  /** Preset picker shown in the composer. */
  presetPicker?: "motion" | "effect";
  preset?: Preset;
  defaultModels: { cloud: string; open: string };
  /**
   * An app's models on each engine (withRecipe, src/lib/catalog/preset-recipes.ts): the one its preview was made with
   * first, then its own route's. With two on the engine the composer offers both in place of the model chip.
   */
  appModels?: Record<Engine, string[]>;
  /**
   * The default to open on instead where the server can't write the default's caption for this viewer (Ideogram 4 for an
   * account, a guest, or an install with no local model answering: writesCaptions in src/lib/composer.ts).
   */
  uncaptioned?: Partial<{ cloud: string; open: string }>;
  suggestions?: string[];
  /** Prompt is optional (e.g. motions, upscale). */
  promptOptional?: boolean;
  hidePrompt?: boolean;
  /**
   * The prompt box's placeholder for a model that reads an optional prompt in a studio that hides it
   * (Upscale: FLUX.3 Upscale's details to preserve or enhance); without it such a model gets no box either.
   */
  modelPrompt?: string;
  /** Paint tools offered on the first image: an inpaint mask and/or freehand drawing. */
  sketch?: ("mask" | "draw")[];
  /** Open the editor as soon as an image is attached (Inpaint). */
  sketchAutoOpen?: "mask" | "draw";
  /** Appended to the user prompt on submit (e.g. identity lock for characters). */
  promptSuffix?: string;
  /** Optional slots of which one is needed (Lipsync: a portrait or a video): Generate names the group. */
  anyOf?: SlotKey[][];
  /** Color signature + Moodboard chips (Image studio): a saved palette and a style, routed per model (src/lib/catalog/palettes.ts). */
  signature?: boolean;
  /** Models the studio can be moved to (by the signature chips), or runs as a later step, beyond its picker list and defaults: kept in its model slice. */
  extraModels?: string[];
  /**
   * Read the attached clip's header (length, size, frame rate): prices count its seconds and the composer
   * says what comes out ("24 → 60 fps", "1280×720 → 3840×2160"). Upscale hub video modes, and Edit video (a clip
   * edit that keeps the clip's length is billed on it, inside the model's window).
   */
  clipFacts?: boolean;
  /**
   * Read the voice track's length (Lipsync): a talking avatar is as long as its voice, so a per-second price counts its
   * seconds and the request carries them (params.sourceDuration). Not while a video is attached (lip re-sync).
   */
  voiceFacts?: boolean;
  /**
   * "Clean the voice first" beside the voice or recording (src/lib/av/voice-first.ts): the speech apart from the music and
   * effects before the model hears it (params.extra.cleanVoiceFirst); after a lip re-sync on your GPU, they go back.
   */
  voiceFirst?: boolean;
  /**
   * Video tools → Green screen: the picker lists only keyers for green-screen footage (ModelOptions.greenScreen); every
   * other Remove background studio leaves them out.
   */
  greenScreen?: boolean;
  /** Offer every output format of the studio's models on this engine; picking one another model writes moves the request there (SDR to HDR, Export). */
  formatPicker?: boolean;
  /** The models' enum settings chip ("Director" by default; "Options" for a tool's settings such as Topaz's model). */
  controlsTitle?: string;
  /**
   * Tools only ComfyUI runs (Export): what to say when none is connected or the install runs cloud APIs only,
   * and a cloud route to offer instead (`href` gets `&video=<the attached clip>`).
   */
  comfyOnly?: { note: string; alternative?: { label: string; href: string } };
  /** Frames mode (Video studio): up to 10 stills, each at its own time in the clip, instead of a start and an end frame. */
  frames?: boolean;
  /**
   * Layout mode (Image studio): boxes drawn on the picture, one row each (an object, a character or exact words),
   * compiled for the model at the size it renders (src/lib/layout-prompt.ts); the prompt is the whole picture's caption.
   */
  layout?: boolean;
  /** A Live switch in the header (Edit): the picture changes as you type, on the viewer's own GPU (Live edit). */
  live?: boolean;
}

export interface Draft {
  prompt: string;
  negativePrompt: string;
  modelId: string;
  params: GenParams;
  slots: Partial<Record<SlotKey, SlotValue | null>>;
  refs: SlotValue[];
  /** References mode (MiniMax H3 on your GPU, Pika H3 Flex): reference clips and voice or music clips, in order. */
  refClips?: SlotValue[];
  refAudios?: SlotValue[];
  presetId?: string;
  presetOptions: Record<string, string>;
  /** Motions/effects: strength of the preset, and an optional second one mixed in (Mix). */
  presetStrength?: number;
  mix?: { presetId: string; strength: number };
  /** The Color signature and Moodboard picked in the composer (studios with `signature`). */
  signature?: Signature;
  /** Frames mode is on (studios with `frames`): the stills in order, each at its place in the clip. */
  frames?: FrameAttachment<SlotValue>[];
  /** Layout mode is on (studios with `layout`): the boxes, as fractions of the picture (the prompt is its caption). */
  layout?: LayoutDraft;
  /** Song lyrics with section tags (Audio → Music): sent as params.extra.lyrics to a model that sings them (ModelOptions.lyrics). */
  lyrics?: string;
  /** The attached song is one of Mureka's own (a music result's meta.songId): its song tools take it by id, not as a file. */
  song?: { id: string; url: string };
}

interface Actions {
  config: StudioConfig;
  setDraft: (patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) => void;
  setSlot: (key: SlotKey, v: SlotValue | null) => void;
  /** Put an image somewhere sensible (first empty image slot, else references). */
  addImage: (v: SlotValue) => void;
}

interface Ctx extends Actions {
  draft: Draft;
}

// Two contexts: the draft changes on every keystroke, the config and actions never do, so the
// page shell and the feed (which only need actions) don't re-render while you type.
const ActionsCtx = createContext<Actions | null>(null);
const DraftCtx = createContext<Draft | null>(null);

/** Config and stable actions only: use this where the draft isn't needed (no re-render per keystroke). */
export function useStudioActions(): Actions {
  const c = useContext(ActionsCtx);
  if (!c) throw new Error("useStudioActions outside StudioProvider");
  return c;
}

/** Everything, including the draft (re-renders on every draft change). */
export function useStudio(): Ctx {
  const actions = useStudioActions();
  const draft = useContext(DraftCtx)!;
  return useMemo(() => ({ ...actions, draft }), [actions, draft]);
}

export function StudioProvider({
  config,
  initial,
  children,
}: {
  config: StudioConfig;
  initial: Draft;
  children: React.ReactNode;
}) {
  const [draft, setState] = useState<Draft>(initial);
  const setDraft = useCallback<Ctx["setDraft"]>((patch) => {
    setState((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) }));
  }, []);
  const setSlot = useCallback((key: SlotKey, v: SlotValue | null) => {
    setState((d) => ({ ...d, slots: { ...d.slots, [key]: v } }));
  }, []);
  const addImage = useCallback(
    (v: SlotValue) => {
      setState((d) => {
        const empty = config.slots.find((s) => s.accept === v.kind && !d.slots[s.key]);
        if (empty) return { ...d, slots: { ...d.slots, [empty.key]: v } };
        if (config.multiRef && v.kind === "image" && d.refs.length < config.multiRef.max) return { ...d, refs: [...d.refs, v] };
        const first = config.slots.find((s) => s.accept === v.kind);
        if (first) return { ...d, slots: { ...d.slots, [first.key]: v } };
        return d;
      });
    },
    [config],
  );
  const actions = useMemo(() => ({ config, setDraft, setSlot, addImage }), [config, setDraft, setSlot, addImage]);
  return (
    <ActionsCtx.Provider value={actions}>
      <DraftCtx.Provider value={draft}>{children}</DraftCtx.Provider>
    </ActionsCtx.Provider>
  );
}

/**
 * Home's Start (`?go=<token>`, the token this tab's Home issued): a count the composer runs its
 * draft for, once per increase, after the handed-over prompt is in place (HandoffSync raises it).
 * 0: nothing to start.
 */
export const StartRequestCtx = createContext(0);

export function useStartRequest(): number {
  return useContext(StartRequestCtx);
}

/**
 * Puts the camera motion or effect the composer shows into the address (`?preset=`, gone once cleared), so a reload or
 * a shared link opens on it. The studio page provides it; elsewhere it does nothing.
 */
export const PresetUrlCtx = createContext<(id: string | undefined) => void>(() => {});

export function usePresetUrl(): (id: string | undefined) => void {
  return useContext(PresetUrlCtx);
}

/** Replace a slot value by key, updating only when it's the same upload (async upload callbacks). */
export function slotUpdater(setSlot: Actions["setSlot"], key: SlotKey) {
  return (v: SlotValue | null) => setSlot(key, v);
}
