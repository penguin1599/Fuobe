import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { exampleRow } from "@/lib/examples/catalog";
import {
  AUDIO_STUDIO,
  DIALOGUE_STUDIO,
  FOLEY_STUDIO,
  FPS_BOOST_STUDIO,
  JOIN_CLIPS_STUDIO,
  MUSIC_STUDIO,
  SDR_TO_HDR_STUDIO,
  SFX_STUDIO,
  SONG_TOOLS_STUDIO,
  TRANSCRIBE_STUDIO,
  TRANSLATE_STUDIO,
  UPSCALE_STUDIO,
  VIDEO_COLOR_MATCH_STUDIO,
  VIDEO_DEPTH_STUDIO,
  VIDEO_EXPORT_STUDIO,
  VIDEO_KEY_STUDIO,
  VIDEO_MATTE_STUDIO,
  VIDEO_RELIGHT_STUDIO,
  VIDEO_UPSCALE_STUDIO,
  VOICE_CHANGE_STUDIO,
} from "@/lib/studios";
import { studioCatalog } from "@/lib/studio-catalog";
import { HUB_MODES, HUB_TITLE, type HubKind } from "@/lib/hubs";
import { CaptionsStudio } from "@/components/captions/captions-studio";
import { DubStudio } from "@/components/dub/dub-studio";
import { TrimTool } from "@/components/av/trim-tool";
import { RemoveObjectTool } from "@/components/remove-object/remove-object-tool";
import { EvolutionTool } from "@/components/evolution/evolution-tool";
import { RestoreTool } from "@/components/restore/restore-tool";
import { AudioJoinTool, AudioLoopTool } from "@/components/audio-tools/audio-tools";
import { SplitSoundtrackTool } from "@/components/audio-tools/split-tool";
import { RemoveDialogueTool } from "@/components/audio-tools/remove-dialogue-tool";
import { CleanVoiceTool } from "@/components/audio-tools/clean-voice-tool";
import { DesignVoiceTool } from "@/components/audio-tools/design-voice-tool";
import { SpeechEditTool } from "@/components/audio-tools/speech-edit-tool";
import { ownSetupsNow } from "@/server/own-setup-live";
import { HubBodySkeleton } from "@/components/skeletons";
import { StudioPage } from "./studio-page";
import type { StudioConfig } from "./studio-context";

const CONFIGS: Record<HubKind, Record<string, StudioConfig>> = {
  upscale: { image: UPSCALE_STUDIO, video: VIDEO_UPSCALE_STUDIO, fps: FPS_BOOST_STUDIO, hdr: SDR_TO_HDR_STUDIO, export: VIDEO_EXPORT_STUDIO },
  audio: {
    speech: AUDIO_STUDIO,
    dialogue: DIALOGUE_STUDIO,
    "voice-change": VOICE_CHANGE_STUDIO,
    translate: TRANSLATE_STUDIO,
    transcribe: TRANSCRIBE_STUDIO,
    sfx: SFX_STUDIO,
    music: MUSIC_STUDIO,
    song: SONG_TOOLS_STUDIO,
    video: FOLEY_STUDIO,
  },
  "video-tools": {
    matte: VIDEO_MATTE_STUDIO,
    "green-screen": VIDEO_KEY_STUDIO,
    relight: VIDEO_RELIGHT_STUDIO,
    depth: VIDEO_DEPTH_STUDIO,
    join: JOIN_CLIPS_STUDIO,
    colors: VIDEO_COLOR_MATCH_STUDIO,
  },
};

/** Modes that are their own tool rather than a composer studio (Translate & dub, Loop / extend, Join, Split soundtrack, Clean up voice, Design a voice, Edit speech, Remove object, Remove dialogue, Evolution, Restore & colourise, Captions, Trim). */
const TOOLS: Partial<Record<HubKind, Record<string, () => React.ReactNode>>> = {
  audio: {
    translate: () => <DubStudio />,
    loop: () => <AudioLoopTool />,
    join: () => <AudioJoinTool />,
    split: () => <SplitSoundtrackTool />,
    clean: () => <CleanVoiceTool />,
    design: () => <DesignVoiceTool />,
    // Their labels follow the GPU's validated graphs (ownSetupsNow): read when the page is made.
    "edit-speech": () => <SpeechEditTool setup={ownSetupsNow(["audio:edit-speech"])["audio:edit-speech"]} />,
  },
  "video-tools": {
    "remove-object": () => <RemoveObjectTool />,
    "remove-person": () => <RemoveObjectTool person />,
    "remove-dialogue": () => <RemoveDialogueTool />,
    evolution: () => <EvolutionTool />,
    restore: () => <RestoreTool setup={ownSetupsNow(["video-tools:restore"])["video-tools:restore"]} />,
    captions: () => <CaptionsStudio />,
    trim: () => <TrimTool />,
  },
};

/**
 * One mode of a hub (Audio → /audio/music, Video tools, Upscale). Server component: the page is prerendered with that
 * mode's hero and composer, and ships only that mode's models. The hub's title bar and tabs are its layout's
 * (HubFrame). `mode` omitted = the first mode (the hub's own URL).
 */
export function ModeSwitchStudio({ kind, mode }: { kind: HubKind; mode?: string }) {
  const current = mode ?? HUB_MODES[kind][0].id;
  const Tool = TOOLS[kind]?.[current];
  if (Tool) return <Tool />;
  const config = CONFIGS[kind][current];
  if (!config) notFound();
  // A composer mode's own examples ("hub:upscale", "hub:upscale/video"…), else the hub's covers that fit it. The hub's
  // first composer mode has the hub's own row (Audio's Speech: its first mode, Clean up voice, is a tool of its own).
  const home = HUB_MODES[kind].find((m) => !TOOLS[kind]?.[m.id])?.id;
  const examples = exampleRow(current === home ? `hub:${kind}` : `hub:${kind}/${current}`);
  return <StudioPage config={config} catalog={studioCatalog(config)} examples={examples} />;
}

/** `generateStaticParams` for /<hub>/[mode]: every mode is prerendered. */
export function hubParams(kind: HubKind): { mode: string }[] {
  return HUB_MODES[kind].map((m) => ({ mode: m.id }));
}

export function hubMetadata(kind: HubKind, mode: string): Metadata {
  const m = HUB_MODES[kind].find((x) => x.id === mode);
  return { title: !m || m.id === HUB_MODES[kind][0].id ? HUB_TITLE[kind] : `${m.label} · ${HUB_TITLE[kind]}` };
}

/**
 * The /<hub>/[mode] page body. `params` is URL data, so the shared App Shell of the route holds only the fallback (the
 * hub's tabs prefetch each mode's whole page, so a tap rarely sees it); it is the body's skeleton under the hub's bar.
 */
export function HubModePage({ kind, params }: { kind: HubKind; params: Promise<{ mode: string }> }) {
  return <Suspense fallback={<HubBodySkeleton />}>{params.then(({ mode }) => <ModeSwitchStudio kind={kind} mode={mode} />)}</Suspense>;
}
