"use client";

import { useQuery } from "@tanstack/react-query";
import { Brush, Download, Info, Loader2, RotateCcw, Sparkles, Undo2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { nanoid } from "nanoid";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { StepList, type StepRow } from "@/components/av/step-list";
import { Panel, ToolHero, ToolShell } from "@/components/av/tool-shell";
import { useGenerationList } from "@/components/av/use-generation";
import { FrameStage, frameFromBlob, type Frame } from "@/components/remove-object/frame-stage";
import { VideoCompare } from "@/components/remove-object/video-compare";
import { useSubmitGuard } from "@/components/shorts/hooks";
import { ClipBar, ClipDrop, costText, Field, Segmented, tabKeys } from "@/components/shorts/ui";
import { clipDuration, clipSize, useSourceClip } from "@/components/shorts/use-source-clip";
import { Feed } from "@/components/studio/feed";
import { fileToList, MediaSlot, type SlotValue } from "@/components/studio/media-slot";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";
import { SketchEditor, type Stroke } from "@/components/studio/sketch-editor";
import { VideoTrimmer, type TrimRange, type VideoTrimmerHandle } from "@/components/studio/video-trimmer";
import { openInStudio } from "@/components/swap-studio/hooks";
import { limitMb, useClipLimit } from "@/lib/clip-limit";
import { ExampleRow } from "@/components/studio/example-row";
import { onAttr, TAB_PILL, TabRow } from "@/components/ui/tab-row";
import { useEngine, useGenerations, useIsOwner, useModelAccess, useSoundLive, useStatus } from "@/lib/api";
import { CHARACTER_SWAP, cutsInPart, cutWarning, partWords, seedProblem, type CharacterChoice, type CharacterOptions } from "@/lib/catalog/character-swap";
import {
  chooseMaker,
  decodeSetup,
  GENJUTSU,
  GENJUTSU_FEATURE_KEYS,
  GENJUTSU_FEATURES,
  GENJUTSU_MODES,
  modeOpen,
  requestFeatures,
  type FeatureCheck,
  type FinishOptions,
  type GenjutsuFeature,
  type ObjectEdit,
  type PictureOptions,
  type SceneAction,
  genjutsuProblem,
  getMode,
  makerOffered,
  makersFor,
  qualityFor,
  MODE_TARGETS,
  modeHint,
  OPEN_TARGET_PROBLEM,
  resolutionWords,
  SCENE_ACTIONS,
  SOURCE_LABELS,
  TARGET_LABELS,
  type GenjutsuLook,
  type GenjutsuMode,
  type GenjutsuQuality,
  type GenjutsuSetup,
  type GenjutsuTarget,
  type GenjutsuTier,
  type Maker,
} from "@/lib/catalog/genjutsu";
import { chainState } from "@/lib/catalog/shorts";
import type { Generation, PixelPoint } from "@/lib/catalog/types";
import { downloadHref, downloadName } from "@/lib/library";
import { keepOffered, offered } from "@/lib/model-access";
import type { ExampleRowData } from "@/lib/examples/types";
import { againWhere, placeholdersOn } from "@/lib/demo-mode";
import { cn } from "@/lib/utils";
import { refusalShown, toastError } from "@/lib/refusals";
import { cleanDescription } from "@/lib/character-description";
import { CharacterControls, CharacterFacts, qualityOff } from "./character-panel";
import { voiceFirstDefault } from "@/lib/av/voice-first";
import { useVoiceFirstLive, useVoiceFirstShown } from "@/components/audio-tools/voice-first-switch";
import { ORIGINAL_SOUND_FEATURE, originalSoundDefault, originalSoundOn, type OriginalSound } from "@/lib/av/original-sound";
import { OriginalSoundPicker } from "@/components/av/original-sound-picker";
import { useDescribeCharacter, useDescribeScene, useGenjutsuEstimate, useGenjutsuRun, useTranscribeClip, waitForGeneration, type GenjutsuBody } from "./hooks";
import { FinishFields, FrameCompare, LightPicker, More, OnlyYou, PERSON_COLOURS, PictureSteps, roleForTap, SceneEditFields, WhoBecomesWho } from "./openjutsu-panels";
import { OwnSetupChip, OwnSetupMark, useOwnSetupPress } from "@/components/own-setup";
import { ownSetupItem } from "@/lib/own-setup";
import { LookPicker, type LookSource } from "./look-picker";
import { SetupCode } from "./setup-code";
import { useClipCuts } from "./use-cuts";
import { ModeExample, ModeExampleRow } from "./mode-example";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { exampleFor, MARKED_NOTE, OWN_CHARACTER_FIELDS, partLimits, sameRecipe, toRecipe, type GenjutsuExampleCard, type ModeExamples } from "@/lib/examples/genjutsu";

/** The upload box's line: the mode's own window (Character swap: 5–15 s of one shot), and the clip size the viewer may upload. */
const limits = (mode: GenjutsuMode, maxBytes: number) =>
  `MP4, MOV or WebM · ${mode === "character" ? `${CHARACTER_SWAP.minSeconds}–${CHARACTER_SWAP.maxSeconds}` : mode === "picture" ? "2–15" : mode === "finish" ? "up to 60" : `${GENJUTSU.minSeconds}–${GENJUTSU.maxSeconds}`} s are used · ${limitMb(maxBytes)} MB`;

interface Paint {
  mask: string;
  overlay: string;
  strokes: Stroke[];
}

interface Run {
  final: string;
  ids: string[];
  /** The original the result is compared with (the uploaded file, not the browser's copy), and where the selection starts. */
  before: string;
  start: number;
  ratio?: number;
  /** What it was asked with: Run again sends this again (a new seed), whatever the form says now. */
  body: GenjutsuBody;
}

const isMode = (v: string | null): v is GenjutsuMode => !!v && GENJUTSU_MODES.some((m) => m.id === v);
const asSlot = (ref: string): SlotValue => ({ id: nanoid(8), ref, preview: ref, kind: "image" });
const ready = (xs: SlotValue[]) => xs.filter((x) => !x.uploading).map((x) => x.ref);

/** A seed typed in the form (blank is random). */
const seedOf = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));

/**
 * Genjutsu: keep a clip's motion, camera and framing and change what is in it — Motion transfer, Character swap,
 * Object swap, Restyle or Insert. Pick the mode, add the clip (4–30 s, trimmed here; Character swap: a 5–15 s part)
 * and your references, say what changes, see the price (or "Free" on your ComfyUI), get the result with a before /
 * after wipe. Fuobe's Originals run by default on both engines; open weights and partners are labelled alternatives.
 * Setups copy and paste as a short code. The plan: src/lib/catalog/genjutsu.ts; the server: src/server/genjutsu.ts.
 * examples: "More to try" (exampleRow(), from the page), under the clip drop until there is a run of one's own; and each
 * mode's own example under its title (modeExamples: a before → after loop, and Use this example, which loads its recipe).
 */
export function GenjutsuStudio({ examples, modeExamples, live }: { examples?: ExampleRowData | null; modeExamples?: ModeExamples; live?: Partial<Record<GenjutsuFeature, boolean>> }) {
  const [engine, setEngine, engineMode] = useEngine();
  // The Openjutsu modes open one by one on this studio's GPU, each after its GPU test (src/server/genjutsu-live.ts).
  // Until then everyone sees them: the owner with an "Only you" mark, a visitor with what it runs on (its own GPU,
  // src/lib/own-setup.ts). The mark leaves by itself once the feature's test passes.
  const owner = useIsOwner();
  const open: FeatureCheck = useCallback((f) => owner || !!live?.[f] || !!ownSetupItem(`genjutsu:${f}`), [owner, live]);
  const liveOpen: FeatureCheck = useCallback((f) => owner || !!live?.[f], [owner, live]);
  const mark = (f: GenjutsuFeature): React.ReactNode => (live?.[f] ? undefined : owner ? <OnlyYou /> : <OwnSetupChip setup={ownSetupItem(`genjutsu:${f}`)} />);
  const press = useOwnSetupPress();
  // A mode that hasn't opened (From picture; Finish until one of its tools has): the setup of its first such feature.
  const modeSetup = (m: GenjutsuMode) => {
    const f = GENJUTSU_FEATURE_KEYS.find((k) => GENJUTSU_FEATURES[k].mode === m && !live?.[k] && ownSetupItem(`genjutsu:${k}`));
    return f ? ownSetupItem(`genjutsu:${f}`) : null;
  };
  // The page sends only the mode examples open to everyone; the owner's are fetched (never in a visitor's page).
  const ownerExamples = useQuery({
    queryKey: ["genjutsu-examples"],
    queryFn: async () => {
      const res = await fetch("/api/genjutsu/examples");
      if (!res.ok) throw new Error(String(res.status));
      return ((await res.json()) as { examples: ModeExamples }).examples;
    },
    enabled: owner,
    staleTime: Infinity,
  });
  const shownExamples = owner && ownerExamples.data ? ownerExamples.data : modeExamples;
  const access = useModelAccess();
  const [mode, setModeState] = useState<GenjutsuMode>("motion");
  // The clip size this viewer may upload: an account's is smaller than the studio's own (src/lib/clip-limit.ts).
  const clipMax = useClipLimit(GENJUTSU.maxBytes);
  const source = useSourceClip(clipMax);
  const clip = source.clip;
  const trimmer = useRef<VideoTrimmerHandle>(null);
  const [range, setRange] = useState<TrimRange | null>(null);
  const [refs, setRefs] = useState<SlotValue[]>([]);
  const [targets, setTargets] = useState<Partial<Record<GenjutsuMode, GenjutsuTarget>>>({});
  const [subject, setSubject] = useState("");
  const [prompts, setPrompts] = useState<Partial<Record<GenjutsuMode, string>>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [tier, setTier] = useState<GenjutsuTier>("standard");
  const [quality, setQuality] = useState<GenjutsuQuality>(GENJUTSU.defaultQuality);
  const [lookChoice, setLookSource] = useState<LookSource>("fuobe");
  const [look, setLook] = useState<GenjutsuLook | null>(null);
  const [custom, setCustom] = useState<SlotValue[]>([]);
  const [words, setWords] = useState("");
  const [points, setPoints] = useState<PixelPoint[]>([]);
  const [pointLabel, setPointLabel] = useState<"positive" | "negative">("positive");
  const [paint, setPaint] = useState<Paint | null>(null);
  // Character swap: its quality (H3's 480p / 768p, or 1080p / 2K / 4K from the 768p swap), its settings, the seed.
  const [charQuality, setCharQuality] = useState<CharacterChoice>(CHARACTER_SWAP.defaultQuality);
  const [character, setCharacter] = useState<CharacterOptions>({});
  const [seed, setSeed] = useState("");
  const [longPart, setLongPart] = useState(false);
  const [painting, setPainting] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  // Scene edit, From picture, Finish and Group swap's taps.
  const [action, setAction] = useState<SceneAction>("change");
  const [objectEdit, setObjectEdit] = useState<ObjectEdit>({ action: "change" });
  const [picture, setPicture] = useState<PictureOptions>({ stage: "frame" });
  const [frameTry, setFrameTry] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [scene, setScene] = useState("");
  const [describing, setDescribing] = useState(false);
  const [finish, setFinish] = useState<FinishOptions>({ tool: "colours" });
  const [tapFor, setTapFor] = useState<number | null>(null);
  // A mode's example in the form: which one, the part's length it asks for until a clip is in, and its words that came
  // from its own clip (a note under those fields).
  const [exampleIn, setExampleIn] = useState<string | null>(null);
  // The length asks for the mode (and model) it came with: another mode's part limits don't take it.
  const [pendingLength, setPendingLength] = useState<{ length: number; mode: GenjutsuMode; model?: string } | null>(null);
  // The mode whose seed field a pasted setup or an example filled (only that mode shows and sends it).
  const [seedFor, setSeedFor] = useState<GenjutsuMode | null>(null);
  // The form's words right after an example went in: words that still match it aren't the viewer's own.
  const [exampleWords, setExampleWords] = useState("");
  const [marked, setMarked] = useState<{ subject?: boolean; target?: boolean }>({});
  const [askReplace, setAskReplace] = useState<GenjutsuExampleCard | null>(null);
  const [dropRing, setDropRing] = useState(false);
  const runMutation = useGenjutsuRun();
  const sceneMutation = useDescribeScene();
  const guard = useSubmitGuard();
  const history = useGenerations({ features: [GENJUTSU.feature], limit: 24 });

  // The ways of pointing this engine has a model for (the open graphs: swap by name, insert by paint).
  const supported = MODE_TARGETS[mode].filter((t) => makersFor(engine, mode, t, open).length > 0);
  const wanted = targets[mode] ?? MODE_TARGETS[mode][0];
  const target = MODE_TARGETS[mode].length ? (supported.includes(wanted) ? wanted : (supported[0] ?? wanted)) : undefined;
  const prompt = prompts[mode] ?? "";
  const duration = clipDuration(clip);
  const size = clipSize(clip);

  const lookSource: LookSource = lookChoice;
  const isCharacter = mode === "character";
  const modeMax = mode === "picture" ? 15 : mode === "finish" ? 60 : null;
  const partMax = isCharacter ? (longPart ? CHARACTER_SWAP.maxContinued : CHARACTER_SWAP.maxSeconds) : (modeMax ?? GENJUTSU.maxSeconds);
  const partMin = isCharacter ? CHARACTER_SWAP.minSeconds : mode === "picture" ? 2 : mode === "finish" ? 1 : GENJUTSU.minSeconds;

  const setMode = (m: GenjutsuMode) => {
    setModeState(m);
    // A seed or a length that came with another mode's setup stays with that mode.
    if (seedFor && seedFor !== m) {
      setSeed("");
      setSeedFor(null);
    }
    if (pendingLength && pendingLength.mode !== m) setPendingLength(null);
    // Character swap takes a 5–15 s part: a longer selection is cut back to its first 15 s (From picture: 15 s too).
    const most = m === "character" || m === "picture" ? CHARACTER_SWAP.maxSeconds : null;
    if (most && range && range.endTime - range.startTime > most + 0.05) {
      setLongPart(false);
      setRange({ ...range, endTime: Math.round((range.startTime + most) * 100) / 100 });
    }
    const url = new URL(window.location.href);
    url.searchParams.set("mode", m);
    window.history.replaceState(null, "", url);
  };

  // Restyle's look as it is now (a custom look's images while they upload don't count yet).
  const effLook: GenjutsuLook | undefined =
    mode !== "restyle"
      ? undefined
      : lookSource === "custom"
        ? { kind: "custom", images: ready(custom), ...(words.trim() ? { words: words.trim() } : {}) }
        : look && look.kind === (lookSource === "fuobe" ? "preset" : "soul")
          ? look
          : undefined;
  const lookKind = mode === "restyle" ? lookSource : "";
  const choiceKey = `${engine}:${mode}:${target ?? ""}:${lookKind}`;
  // Models switched off in Settings → Models & licences leave the list, and the pick falls back to one that is on.
  const isOn = (id: string) => offered(access, id, engine);
  const readyRefs = ready(refs).length;
  const ask = {
    engine,
    mode,
    target,
    tier,
    look: effLook ?? (mode === "restyle" ? lookPlaceholder(lookSource) : undefined),
    offered: isOn,
    refs: readyRefs,
    action: mode === "swap" ? action : undefined,
    tool: mode === "finish" ? finish.tool : undefined,
  };
  // Nothing picked yet: start on a model open on this studio's GPU where there is one; the own-setup ones are a pick away.
  const livePick = chooseMaker({ ...ask, open: liveOpen });
  const choice = chooseMaker({ ...ask, modelId: picked[choiceKey] ?? ("maker" in livePick ? livePick.maker.id : undefined), open });
  const maker: Maker | null = "maker" in choice ? choice.maker : null;
  const options = keepOffered(makersFor(engine, mode, target, open), (m) => makerOffered(m, isOn)).filter((m) => mode !== "finish" || m.tool === finish.tool);
  const group = isCharacter && !!maker?.group;
  const sceneEdit = mode === "swap" && !!maker?.actions;
  // Scene edit with only some of its actions open to this viewer: start on one that is.
  const actionOpen = open(SCENE_ACTIONS.find((a) => a.id === action)!.feature);
  const firstOpenAction = SCENE_ACTIONS.find((a) => open(a.feature))?.id;
  if (sceneEdit && !actionOpen && firstOpenAction && firstOpenAction !== action) {
    setAction(firstOpenAction);
    setObjectEdit((o) => ({ ...o, action: firstOpenAction }));
  }
  const fresh = !!(maker?.group || maker?.actions || maker?.review || maker?.tool);
  const references = mode === "restyle" || (sceneEdit && action === "remove") || (mode === "picture" && picture.ownPerson) || (mode === "finish" && finish.tool === "colours") ? [] : ready(refs);
  const showRefs = mode !== "restyle" && !(sceneEdit && action === "remove") && !(mode === "picture" && picture.ownPerson) && !(mode === "finish" && finish.tool === "colours");
  // Two characters or more move the swap to Group swap on your GPU (once it is open to this viewer).
  const groupOn = isCharacter && engine === "open" && makersFor(engine, "character", target, open).some((m) => m.group);
  const maxRefs = isCharacter ? Math.max(1, maker?.refs.max ?? 1, groupOn ? 4 : 1) : mode === "picture" || mode === "finish" || sceneEdit ? 1 : GENJUTSU.maxReferences;
  const needsFrame = ((mode === "swap" || isCharacter) && target === "click") || ((mode === "swap" || mode === "insert") && target === "paint") || group || mode === "picture";
  // Character swap: the clip's hard cuts (found in the browser), for the "one continuous shot" warning.
  const cuts = useClipCuts(clip?.preview, isCharacter && !!clip && !clip.error);
  const partCuts = isCharacter && range ? cutsInPart(cuts ?? undefined, { start: range.startTime, end: range.endTime }) : [];
  const cut = cutWarning(partCuts);
  const seedNumber = seedOf(seed);
  // Modes with no seed field of their own show one once a seed is set (an example's or a pasted setup's).
  const seedShown = !isCharacter && !fresh && seed.trim() !== "" && seedFor === mode;
  // Character swap's H3 makers take H3's two qualities; the other makers (Recast, P-Video…) Genjutsu's own.
  // A size this engine can't make worth it (your GPU's 4K) is asked as 2K, as the picker shows it.
  const askedQuality = isCharacter && maker?.h3 ? (qualityOff(engine, charQuality) ? "2K" : charQuality) : quality;

  // "Describe my character" (the engine's text model) and "Use the clip's words" (one transcription of the clip; any
  // part takes its own lines from it, so it is kept per clip).
  const router = useRouter();
  const [opening, setOpening] = useState(false);
  // "Open in Character Swap Studio": the whole clip and the character go to a new studio project on this engine.
  const openStudio = async () => {
    setOpening(true);
    try {
      const r = await openInStudio({
        engine,
        clip: clip && !clip.uploading && clip.url ? { url: clip.url, name: clip.name, ...(clip.size ? { size: clip.size } : {}), duration: clip.info?.duration ?? clip.browserDuration, width: clip.info?.width ?? clip.browserWidth, height: clip.info?.height ?? clip.browserHeight } : null,
        image: refs.find((x) => !x.uploading)?.ref ?? null,
        description: character.description,
      });
      if (r.problem) toast.error(r.problem, { description: "The project is open: add the clip there." });
      router.push(`/character-swap/${encodeURIComponent(r.id)}`);
    } catch (e) {
      toastError(e);
      setOpening(false);
    }
  };
  const describeMutation = useDescribeCharacter();
  const transcribeMutation = useTranscribeClip();
  const [clipWords, setClipWords] = useState<{ url: string; clean: boolean; g: Generation } | null>(null);
  // "Clean the voice first" for the clip's words: off until the chain has passed a real run, then on (the switch is under
  // "Use the clip's words").
  const voiceFirstShown = useVoiceFirstShown(true);
  const voiceFirstLive = useVoiceFirstLive();
  const [voiceFirst, setVoiceFirst] = useState<boolean | null>(null);
  const cleanFirst = voiceFirstShown && (voiceFirst ?? (engine === "open" && voiceFirstDefault("video", voiceFirstLive)));
  const [listening, setListening] = useState(false);
  const alive = useRef<AbortController | null>(null);
  useEffect(() => () => alive.current?.abort(), []);
  // "Describe my character": the site's AI helper answers at once (the owner's cloud engine); otherwise the GPU describer
  // runs and its text fills the field when it is done. A guest gets the sign-up card, an account without a GPU "Connect
  // your GPU".
  const describeGuard = useSubmitGuard();
  const [describingCharacter, setDescribingCharacter] = useState(false);
  const describeAlive = useRef<AbortController | null>(null);
  useEffect(() => () => describeAlive.current?.abort(), []);
  const describeCharacter = async () => {
    const image = refs.find((r) => !r.uploading)?.ref;
    if (!image) return;
    describeAlive.current?.abort();
    const ctl = new AbortController();
    describeAlive.current = ctl;
    setDescribingCharacter(true);
    try {
      const r = await describeGuard(`${engine} ${image}`, (requestId) => describeMutation.mutateAsync({ engine, image, requestId }));
      if (!r) return;
      const text = "description" in r ? r.description : cleanDescription((await waitForGeneration(r.id, { signal: ctl.signal })).outputs.find((o) => o.kind === "text")?.text);
      if (text) setCharacter((c) => ({ ...c, description: text }));
      else toast("Couldn't describe this picture", { description: "Describe your character in your own words." });
    } catch (e) {
      if (!ctl.signal.aborted && !refusalShown(e as Error)) toast.error(friendly((e as Error).message));
    } finally {
      if (describeAlive.current === ctl) setDescribingCharacter(false);
    }
  };
  const fillClipWords = async () => {
    if (!clip?.url || !range) return;
    const url = clip.url;
    const part = { start: range.startTime, end: range.endTime };
    setListening(true);
    alive.current?.abort();
    const ctl = new AbortController();
    alive.current = ctl;
    try {
      let g = clipWords?.url === url && clipWords.clean === cleanFirst ? clipWords.g : null;
      if (!g) {
        // The clip's speech apart from its music and effects first, when "Clean the voice first" is on.
        const { id } = await transcribeMutation.mutateAsync({ engine, source: { url, ...(duration ? { duration } : {}) }, ...(cleanFirst && { cleanVoiceFirst: true }) });
        g = await waitForGeneration(id, { signal: ctl.signal });
        setClipWords({ url, clean: cleanFirst, g });
      }
      const out = g.outputs.find((o) => o.kind === "text");
      const cues = Array.isArray(out?.meta?.cues) ? (out.meta.cues as { start: number; end: number; text: string }[]) : undefined;
      const text = cues ? partWords(cues, part) : (out?.text ?? "").trim().slice(0, 2000);
      if (text) setCharacter((c) => ({ ...c, dialogue: text }));
      else toast("Nobody speaks in this part of the clip", { description: "Pick “No dialogue”, or type the words." });
    } catch (e) {
      if (!ctl.signal.aborted) toast.error(friendly((e as Error).message));
    } finally {
      if (alive.current === ctl) setListening(false);
    }
  };

  // The selection's first frame, grabbed by the browser: what points and paint are made on.
  const startAt = range ? Math.round(range.startTime * 100) / 100 : null;
  const previewSrc = clip?.preview;
  useEffect(() => {
    if (!needsFrame || !previewSrc || startAt === null) return;
    let alive = true;
    const t = setTimeout(async () => {
      const blob = await trimmer.current?.grabFrame(startAt, 1280);
      if (!alive) return;
      if (!blob) return setFrameError(true);
      const f = await frameFromBlob(blob).catch(() => null);
      if (!alive || !f) return;
      setFrameError(false);
      setFrame((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return f;
      });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [needsFrame, previewSrc, startAt]);
  // A new first frame: points and paint made on the old one no longer line up.
  const [frameAt, setFrameAt] = useState<string | null>(null);
  const frameKey = `${previewSrc}|${startAt}`;
  if (frameKey !== frameAt) {
    setFrameAt(frameKey);
    if (points.length || paint) {
      setPoints([]);
      setPaint(null);
    }
  }

  const pictureKey = mode === "picture" ? JSON.stringify([previewSrc, startAt, range?.endTime, references, picture.light, picture.ownPerson, picture.keepCrop]) : "";
  const [pictureAt, setPictureAt] = useState(pictureKey);
  if (pictureKey !== pictureAt) {
    setPictureAt(pictureKey);
    if (frameUrl && pictureAt) {
      setFrameUrl(null);
      setScene("");
    }
  }
  const pictureStage: "frame" | "video" = frameUrl ? "video" : "frame";

  const apply = (s: GenjutsuSetup, example?: GenjutsuExampleCard) => {
    // Through setMode: the URL's ?mode= follows (a reload keeps the pasted mode).
    setMode(s.mode);
    const e = s.engine && engineMode === "both" ? s.engine : engine;
    if (s.engine && engineMode === "both") setEngine(s.engine);
    if (s.tier) setTier(s.tier);
    if (s.mode === "character") {
      if (s.quality && ([...CHARACTER_SWAP.qualities, ...CHARACTER_SWAP.finishes] as string[]).includes(s.quality)) setCharQuality(s.quality as CharacterChoice);
      if (s.quality && (GENJUTSU.qualities as string[]).includes(s.quality)) setQuality(s.quality);
      setCharacter(s.character ?? {});
    } else if (s.quality) setQuality(s.quality);
    const t = s.target ?? MODE_TARGETS[s.mode][0];
    if (s.target) setTargets((x) => ({ ...x, [s.mode]: s.target }));
    setSubject(s.subject ?? "");
    setPrompts((x) => ({ ...x, [s.mode]: s.prompt ?? "" }));
    if (s.look?.kind === "custom") {
      setLookSource("custom");
      setCustom(s.look.images.map(asSlot));
      setWords(s.look.words ?? "");
    } else if (s.look) {
      setLookSource(s.look.kind === "preset" ? "fuobe" : "soul");
      setLook(s.look);
    }
    const kind = s.mode === "restyle" ? (s.look?.kind === "custom" ? "custom" : s.look?.kind === "soul" ? "soul" : "fuobe") : "";
    if (s.model) setPicked((x) => ({ ...x, [`${e}:${s.mode}:${t ?? ""}:${kind}`]: s.model! }));
    if (s.object) {
      setAction(s.object.action);
      setObjectEdit(s.object);
    }
    if (s.picture) setPicture({ ...s.picture, stage: "frame" });
    if (s.finish) setFinish(s.finish);
    if (s.references?.length) setRefs(s.references.map(asSlot));
    // gj2 and examples: the seed, the part's length and the sound too (an example with no seed: a new one each time).
    if (s.seed !== undefined || example) {
      setSeed(s.seed !== undefined ? String(s.seed) : "");
      setSeedFor(s.seed !== undefined ? s.mode : null);
    }
    if (s.originalSound) setOriginalSound(s.originalSound);
    if (s.length !== undefined) partLength(s.length, s.mode, s.model);
    if (!example) toast("Setup pasted", { description: clip ? "Check the references and press Generate." : "Add a clip to run it on." });
  };

  /** The part becomes this long from where it starts (the clip's end at most, and the mode's longest part). */
  const partLength = (length: number, m: GenjutsuMode, model?: string) => {
    const most = partLimits(m, model).max;
    if (!range || !duration) return setPendingLength({ length: Math.min(length, most), mode: m, model });
    setPendingLength(null);
    const end = Math.min(duration, range.startTime + Math.min(length, most));
    setRange({ ...range, endTime: Math.round(end * 1000) / 1000 });
    if (duration - range.startTime < length - 0.05) toast(`Your clip is ${Math.round((duration - range.startTime) * 10) / 10} s from there. The example used ${Math.round(length * 10) / 10} s.`, { id: "gj-example-length" });
  };
  // A clip added after an example: its part takes the example's length once the clip is read.
  if (pendingLength && range && duration) {
    setPendingLength(null);
    const end = Math.min(duration, range.startTime + Math.min(pendingLength.length, partLimits(pendingLength.mode, pendingLength.model).max));
    if (Math.abs(range.endTime - end) > 0.001) setRange({ ...range, endTime: Math.round(end * 1000) / 1000 });
  }

  // Hand-offs: ?mode=swap, ?video=/api/files/…, ?image=/api/files/… (a reference), ?setup=gj1.…. Read as they change, so
  // "Use in Genjutsu" on a result in this page's own feed (a link to /genjutsu?video=…) loads that clip too. Each value
  // is applied once; ?image and ?setup leave the URL then (a reload doesn't paste them over what you changed).
  const [params, setParams] = useState<string | null>(null);
  const seen = useRef<Record<string, string | null>>({});
  useEffect(() => {
    if (params === null) return;
    const p = new URLSearchParams(params);
    const arrived = "video" in seen.current;
    const fresh = (k: string) => {
      const v = p.get(k);
      const was = seen.current[k];
      seen.current[k] = v;
      return v !== null && v !== was ? v : null;
    };
    const m = fresh("mode");
    if (isMode(m) && modeOpen(m, open)) setModeState(m);
    const tool = fresh("tool");
    if ((tool === "faces" && open("finish-faces")) || (tool === "colours" && open("finish-colours"))) setFinish({ tool });
    const fr = fresh("frame");
    if (fr?.startsWith("/api/files/") && open("picture")) {
      setFrameUrl(fr);
      setPicture((p) => ({ ...p, stage: "video" }));
    }
    const image = fresh("image");
    if (image?.startsWith("/api/files/")) setRefs([asSlot(image)]);
    const code = fresh("setup");
    if (code) {
      const s = decodeSetup(code, open);
      if (s) apply(s);
      else toast.error("That setup code didn't read — ask for it again");
    }
    // ?example=<id>: its mode, with the example in view (nothing is loaded until Use this example).
    const ex = fresh("example");
    const exMode = ex ? GENJUTSU_MODES.find((g) => shownExamples?.[g.id]?.some((c) => c.id === ex))?.id : undefined;
    if (exMode && modeOpen(exMode, open)) {
      setModeState(exMode);
      requestAnimationFrame(() => document.querySelector("[data-mode-example]")?.scrollIntoView({ block: "center" }));
    }
    const video = fresh("video");
    if (video?.startsWith("/api/files/")) {
      clearMarks();
      setRange(null);
      source.adopt(video, video.split("/").pop());
      // A later hand-off comes from this page itself (its feed): back up to the clip.
      if (arrived) backToTop();
    }
    if (p.has("image") || p.has("setup")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("image");
      url.searchParams.delete("setup");
      window.history.replaceState(null, "", url);
    }
    // Only a new URL counts; the handlers read the state of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // The owner is known after the first render (after hydration): a link to a mode or tool only the owner has opens it then.
  const [ownerLinked, setOwnerLinked] = useState(false);
  if (owner && !ownerLinked) {
    setOwnerLinked(true);
    const p = new URLSearchParams(window.location.search);
    const m = p.get("mode");
    if (isMode(m) && (m === "picture" || m === "finish")) setModeState(m);
    const tool = p.get("tool");
    if (tool === "faces" || tool === "colours") setFinish({ tool });
    const fr = p.get("frame");
    if (fr?.startsWith("/api/files/")) {
      setFrameUrl(fr);
      setPicture((x) => ({ ...x, stage: "video" }));
    }
  }

  const setup: GenjutsuSetup = {
    mode,
    engine,
    ...(maker ? { model: maker.id } : {}),
    ...(maker?.tier ? { tier: maker.tier } : {}),
    quality: askedQuality,
    ...(target ? { target } : {}),
    ...(mode === "swap" && subject.trim() ? { subject: subject.trim() } : {}),
    ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    ...(effLook ? { look: effLook } : {}),
    ...(references.length ? { references } : {}),
    ...(isCharacter && Object.keys(character).length ? { character } : {}),
    ...(sceneEdit ? { object: { ...objectEdit, action } } : {}),
    ...(mode === "picture" ? { picture: { ...(picture.light ? { light: picture.light } : {}), ...(picture.ownPerson ? { ownPerson: true } : {}), ...(picture.keepCrop ? { keepCrop: true } : {}), ...(picture.adjust ? { adjust: picture.adjust } : {}) } } : {}),
    ...(mode === "finish" ? { finish } : {}),
  };

  function clearMarks() {
    setFrame(null);
    setFrameError(false);
    setPoints([]);
    setPaint(null);
  }

  const reset = () => {
    source.clear();
    setRange(null);
    setPendingLength(null);
    clearMarks();
    // The clip is gone: a later hand-off of the same video loads it again.
    if (new URLSearchParams(window.location.search).has("video")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("video");
      window.history.replaceState(null, "", url);
    }
  };

  const uploaded = !!clip?.url && !clip.uploading && !clip.error && !!duration && !!range;
  const clicks = points.filter((p) => p.label !== "negative").length;
  const problem =
    uploaded && maker
      ? genjutsuProblem({
          mode,
          maker,
          source: { url: clip.url!, duration, fps: clip.info?.fps, width: size.width, height: size.height, hasAudio: clip.info?.hasAudio },
          range: { start: range.startTime, end: range.endTime },
          references: references.length,
          target,
          subject,
          prompt,
          points: clicks,
          mask: !!paint,
          look: effLook,
          ...(isCharacter ? { seed: seedNumber, character } : {}),
          ...(sceneEdit ? { object: { ...objectEdit, action } } : {}),
          ...(mode === "picture" ? { picture: { ...picture, stage: pictureStage, ...(frameUrl ? { frame: frameUrl } : {}) } } : {}),
          ...(mode === "finish" ? { finish } : {}),
        })
      : null;
  // What of the clip's sound goes back where it's put back: Everything until the split has passed a real run, then Music & effects only when a character is swapped on your GPU.
  const [soundAsked, setOriginalSound] = useState<OriginalSound | null>(null);
  const soundEngine = maker?.engine ?? engine;
  const soundLiveNow = useSoundLive(ORIGINAL_SOUND_FEATURE);
  const originalSound = originalSoundOn(soundAsked ?? originalSoundDefault({ replacesPerson: isCharacter, engine: soundEngine, live: soundLiveNow }), soundEngine);
  // The whole setup, as the header copies it (gj2: with the seed, the part's length and the sound) and as an example compares.
  const partNow = range ? Math.round((range.endTime - range.startTime) * 1000) / 1000 : (pendingLength?.length ?? undefined);
  const fullSetup: GenjutsuSetup = { ...setup, ...(seedNumber !== undefined && !seedProblem(seedNumber) ? { seed: seedNumber } : {}), ...(partNow ? { length: partNow } : {}), originalSound };
  // This mode's example for this viewer (none: no card), and whether the form still holds it.
  const example = exampleFor(shownExamples, mode, open);
  const exampleInUse = !!example && exampleIn === example.id && sameRecipe(toRecipe(fullSetup), example.load.recipe);
  const exampleOnlyYou = !!example && owner && !example.load.needs.every((f) => !!live?.[f]);
  const body: GenjutsuBody | null =
    uploaded && maker && !problem && !refs.some((r) => r.uploading) && !custom.some((r) => r.uploading)
      ? {
          engine,
          mode,
          modelId: maker.id,
          ...(maker.tier ? { tier: maker.tier } : {}),
          quality: askedQuality,
          ...(target ? { target } : {}),
          ...(mode === "swap" && subject.trim() ? { subject: subject.trim() } : {}),
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
          ...(target === "click" ? { points } : {}),
          ...(target === "paint" && paint ? { mask: paint.mask } : {}),
          ...(needsFrame && frame ? { frame: { width: frame.width, height: frame.height } } : {}),
          references,
          ...(effLook ? { look: effLook } : {}),
          source: { url: clip.url!, name: clip.name, duration, fps: clip.info?.fps, width: size.width, height: size.height, hasAudio: clip.info?.hasAudio },
          range: { start: range.startTime, end: range.endTime },
          ...(isCharacter ? { character, ...(seedNumber !== undefined ? { seed: seedNumber } : {}), ...(cuts?.length ? { cuts } : {}) } : {}),
          // A seed field shows for every mode once a seed is set (an example's, a pasted setup's): what shows, runs.
          ...(!isCharacter && seedNumber !== undefined && (fresh || seedShown) ? { seed: seedNumber } : {}),
          ...(sceneEdit ? { object: { ...objectEdit, action } } : {}),
          ...(mode === "picture" ? { picture: { ...picture, stage: pictureStage, ...(frameUrl ? { frame: frameUrl } : {}), ...(scene.trim() ? { scene: scene.trim() } : {}) } } : {}),
          ...(mode === "finish" ? { finish } : {}),
          ...(originalSound !== "everything" && { originalSound }),
        }
      : null;
  const estimate = useGenjutsuEstimate(body);
  const est = estimate.data && !estimate.isError ? estimate.data : undefined;
  // What Generate needs of a visitor's own setup: the first feature of this run that hasn't opened on this studio's GPU.
  const needFeature = body && maker && !owner ? requestFeatures({ mode: body.mode, maker, character: body.character, object: body.object, picture: body.picture, finish: body.finish }).find((f) => !live?.[f]) : undefined;
  const setupNeed = needFeature ? ownSetupItem(`genjutsu:${needFeature}`) : null;

  const blocker = !clip
    ? "Add a clip"
    : clip.error
      ? clip.error
      : clip.uploading
        ? clip.progress < 1
          ? `Uploading… ${Math.round(clip.progress * 100)}%`
          : "Reading the clip…"
        : !range || !duration
          ? "Reading the clip…"
          : "problem" in choice
            ? choice.problem
            : problem
              ? problem
              : refs.some((r) => r.uploading) || custom.some((r) => r.uploading)
                ? "Uploading your images…"
                : estimate.isError
                  ? friendly((estimate.error as Error).message)
                  : null;

  /** Generate (the form as it is), or Run again (`again`: that run's own request, with a new seed). */
  const start = (again?: Run, newSeed = false) => {
    if (!again && (blocker || !body)) return void toast(blocker ?? "Not ready yet", { id: "genjutsu-blocker" });
    const base = again?.body ?? body!;
    const b = again || newSeed ? { ...base, seed: Math.floor(Math.random() * 2 ** 31) } : base;
    if (!again && base.mode === "picture" && base.picture?.stage === "frame") {
      void guard(JSON.stringify(b), (requestId) => runMutation.mutateAsync({ ...b, requestId }))
        .then((r) => r && setFrameTry(r.final.id))
        .catch((e: Error) => !refusalShown(e) && toast.error(friendly(e.message)));
      return;
    }
    const ratio = again ? again.ratio : size.width && size.height ? size.width / size.height : undefined;
    const before = again?.before ?? clip!.url!;
    const at = again?.start ?? range!.startTime;
    void guard(JSON.stringify(b), (requestId) => runMutation.mutateAsync({ ...b, requestId }))
      .then((r) => {
        if (!r) return;
        setRun({ final: r.final.id, ids: r.items.map((g) => g.id), before, start: at, ratio, body: base });
        toast("Genjutsu is on it", { description: "Follow it below — it lands in your Library too." });
      })
      .catch((e: Error) => !refusalShown(e) && toast.error(friendly(e.message)));
  };

  const pickFrame = async (url: string) => {
    setFrameUrl(url);
    setPicture((p) => ({ ...p, stage: "video" }));
    const u = new URL(window.location.href);
    u.searchParams.set("frame", url);
    window.history.replaceState(null, "", u);
    if (!clip?.url || !range) return;
    setDescribing(true);
    try {
      const { id } = await sceneMutation.mutateAsync({ engine: "open", source: { url: clip.url, ...(duration ? { duration } : {}) }, range: { start: range.startTime, end: range.endTime }, ...(picture.ownPerson ? { ownPerson: true } : { frame: url }) });
      const g = await waitForGeneration(id);
      const text = g.outputs.find((o) => o.kind === "text")?.text?.trim();
      if (text) setScene(text.slice(0, 2000));
    } catch (e) {
      if (!refusalShown(e as Error)) toast(friendly((e as Error).message), { description: "Write what happens in your own words, or leave it empty." });
    } finally {
      setDescribing(false);
    }
  };
  // From picture: another first frame (a new seed), from step 1 again even after one was picked.
  const retryFrame = () => {
    if (!body?.picture) return void toast(blocker ?? "Not ready yet", { id: "genjutsu-blocker" });
    setFrameUrl(null);
    setScene("");
    const { light, ownPerson, keepCrop, adjust } = body.picture;
    const b: GenjutsuBody = { ...body, picture: { stage: "frame", light, ownPerson, keepCrop, adjust }, seed: Math.floor(Math.random() * 2 ** 31) };
    void guard(JSON.stringify(b), (requestId) => runMutation.mutateAsync({ ...b, requestId }))
      .then((r) => r && setFrameTry(r.final.id))
      .catch((e: Error) => !refusalShown(e) && toast.error(friendly(e.message)));
  };
  // A tap on the part's first frame places a character's pin and writes the words when the field is empty.
  const placePin = (x: number, y: number) => {
    if (tapFor === null) return;
    const people = refs.map((_, k) => character.people?.[k] ?? { role: "" });
    const pin = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
    people[tapFor] = { role: roleForTap(people[tapFor]?.role, pin), pin };
    setCharacter({ ...character, people });
    setTapFor(null);
  };

  /**
   * Use this example: the form's own words and seed are replaced only after a yes. Words that came with the last
   * example loaded (and are unchanged) aren't the viewer's: switching to another example asks nothing. The character's
   * description and who is who stay the viewer's either way, so they never count.
   */
  const wordsList = [prompt, subject, objectEdit.target ?? "", objectEdit.becomes ?? "", picture.adjust ?? "", words, isCharacter || fresh || seedShown ? seed : ""].map((w) => w.trim());
  const wordsNow = wordsList.some(Boolean) ? JSON.stringify(wordsList) : "";
  if (exampleInUse && wordsNow !== exampleWords) setExampleWords(wordsNow);
  const ownWords = wordsNow !== "" && wordsNow !== exampleWords;
  const pickExample = (card: GenjutsuExampleCard) => (ownWords && !exampleInUse ? setAskReplace(card) : loadExample(card));
  const loadExample = (card: GenjutsuExampleCard) => {
    const snap = { mode, engine, tier, quality, charQuality, targets, subject, prompts, lookChoice, look, custom, words, picked, character, action, objectEdit, picture, finish, seed, seedFor, range, soundAsked, pendingLength, marked, exampleIn, points, paint };
    const r = card.load.recipe;
    apply(r, card);
    // Who is who, the character's description and the clicks and paint describe the viewer's own clip and photos: kept.
    if (r.mode === "character") {
      const own = Object.fromEntries(OWN_CHARACTER_FIELDS.flatMap((k) => (character[k] !== undefined ? [[k, character[k]]] : [])));
      setCharacter({ ...own, ...(r.character ?? {}) });
    }
    setMarked({ subject: !!r.subject, target: !!r.object?.target });
    setExampleIn(card.id);
    // What the form still needs, said as the next steps: the clip, then the photos the example used.
    const photos = card.inputs.filter((i) => i.slot.startsWith("photo")).length;
    const missingPhotos = Math.max(0, photos - ready(refs).length);
    const photoWords = missingPhotos ? (r.mode === "character" ? (missingPhotos === 1 ? "a character photo" : `${missingPhotos} character photos`) : missingPhotos === 1 ? "a photo" : `${missingPhotos} photos`) : "";
    const steps = [!clip && "your clip", photoWords].filter(Boolean).join(" and ");
    toast("Example loaded", {
      id: "gj-example",
      description: steps ? `Add ${steps}, then Generate.` : "Check the settings, then Generate.",
      duration: 10_000,
      action: {
        label: "Undo",
        onClick: () => {
          setMode(snap.mode);
          if (engineMode === "both") setEngine(snap.engine);
          setTier(snap.tier);
          setQuality(snap.quality);
          setCharQuality(snap.charQuality);
          setTargets(snap.targets);
          setSubject(snap.subject);
          setPrompts(snap.prompts);
          setLookSource(snap.lookChoice);
          setLook(snap.look);
          setCustom(snap.custom);
          setWords(snap.words);
          setPicked(snap.picked);
          setCharacter(snap.character);
          setAction(snap.action);
          setObjectEdit(snap.objectEdit);
          setPicture(snap.picture);
          setFinish(snap.finish);
          setSeed(snap.seed);
          setSeedFor(snap.seedFor);
          if (snap.range) setRange(snap.range);
          setOriginalSound(snap.soundAsked);
          setPendingLength(snap.pendingLength);
          setMarked(snap.marked);
          setExampleIn(snap.exampleIn);
          setPoints(snap.points);
          setPaint(snap.paint);
        },
      },
    });
    // Next, with the focus there (the example's button no longer acts): the clip (no clip yet), else the photos still
    // missing, else the first empty field, else Generate.
    requestAnimationFrame(() => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const shown = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled;
      const first = (sel: string) => [...document.querySelectorAll(sel)].find(shown);
      const emptyField = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#gj-side input:not([type]), #gj-side input[type=text], #gj-side textarea")].find((el) => shown(el) && !el.value.trim());
      const target = !clip
        ? first("#gj-clip-drop button, #gj-clip-drop [role=button], #gj-clip-drop input:not([type=file])")
        : (missingPhotos ? first("#gj-refs button") : undefined) ?? emptyField ?? first("#gj-generate");
      const area = document.getElementById(clip ? (missingPhotos ? "gj-refs" : "gj-generate") : "gj-clip-drop");
      (target ?? area)?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      target?.focus({ preventScroll: true });
      if (!clip) {
        setDropRing(true);
        setTimeout(() => setDropRing(false), 2000);
      }
    });
  };

  const modeInfo = getMode(mode);
  const hint = modeHint(mode, open);
  const tabs = <ModeTabsRow modes={GENJUTSU_MODES.filter((m) => modeOpen(m.id, open))} mode={mode} onMode={setMode} mark={(m) => (modeOpen(m, (f) => !!live?.[f]) ? undefined : owner ? <OnlyYou /> : <OwnSetupMark setup={modeSetup(m)} />)} />;

  return (
    <ToolShell title="Genjutsu" tabs={tabs} fadeKey={mode} header={<SetupCode setup={fullSetup} onPaste={(s) => apply(s)} />} wide>
      {!clip && (
        <ToolHero title={modeInfo.label} subtitle={`${hint} Free on your own ComfyUI.`}>
          {isCharacter && (
            <Link href="/character-swap" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-brand-text hover:underline">
              Whole clips, shot by shot? Open in Character Swap Studio
            </Link>
          )}
        </ToolHero>
      )}
      {!clip && example && (
        <ModeExample key={example.id} card={example} owner={owner} canUse inUse={exampleInUse} onlyYou={exampleOnlyYou} onUse={() => pickExample(example)} className="mt-6" />
      )}
      <div id="gj-clip-drop" className={cn("mx-auto scroll-mt-24 rounded-2xl transition-shadow", clip ? "pt-4" : "mt-8 max-w-[640px]", dropRing && "ring-2 ring-primary ring-offset-4 ring-offset-background")}>
        {!clip ? (
          <ClipDrop
            accept={GENJUTSU.accept}
            limits={limits(mode, clipMax)}
            onFile={(f) => {
              const err = source.pick(f);
              if (err) toast.error(err);
              else setRange(null);
            }}
            onLibrary={(url, name) => {
              source.adopt(url, name);
              setRange(null);
            }}
          />
        ) : (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-4">
              <Panel>
                <div className="space-y-3">
                  <ClipBar clip={clip} onRemove={reset} />
                  <VideoTrimmer
                    ref={trimmer}
                    src={clip.preview}
                    value={range}
                    onChange={setRange}
                    min={maker?.part ? Math.min(partMin, maker.part.min) : partMin}
                    max={maker?.part ? (isCharacter ? maker.part.max : Math.min(partMax, maker.part.max)) : partMax}
                    duration={clip.info?.duration}
                    label={isCharacter ? "The part to swap" : "Part of the clip to use"}
                    hint={
                      isCharacter
                        ? longPart
                          ? `${CHARACTER_SWAP.minSeconds}–${CHARACTER_SWAP.maxContinued} s; past 15 s it continues window by window`
                          : `${CHARACTER_SWAP.minSeconds}–${CHARACTER_SWAP.maxSeconds} s of one continuous shot, the person in its first frame`
                        : mode === "motion" && maker?.part
                          ? duration && duration > maker.part.max
                            ? `Pick up to ${maker.part.max} s — only that part comes out`
                            : `${maker.part.min}–${maker.part.max} s; the whole clip, or just the part you need`
                          : duration && duration > GENJUTSU.maxSeconds
                            ? `Pick up to ${GENJUTSU.maxSeconds} s — only that part comes out`
                            : `${GENJUTSU.minSeconds}–${GENJUTSU.maxSeconds} s; the whole clip, or just the part you need`
                    }
                    onMeta={source.setBrowserMeta}
                  />
                  {isCharacter && duration !== undefined && duration > CHARACTER_SWAP.maxSeconds && (
                    <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
                      <Switch
                        checked={longPart}
                        onCheckedChange={(on) => {
                          setLongPart(on);
                          if (!on && range && range.endTime - range.startTime > CHARACTER_SWAP.maxSeconds) setRange({ ...range, endTime: Math.round((range.startTime + CHARACTER_SWAP.maxSeconds) * 100) / 100 });
                        }}
                        aria-label="A longer part, up to 30 seconds"
                      />
                      A longer part, up to {CHARACTER_SWAP.maxContinued} s (continued past 15 s; beyond H3&apos;s trained range)
                    </label>
                  )}
                </div>
              </Panel>

              {group && (
                <Panel title="First frame" aside={tapFor !== null ? <span className="text-[12px] text-muted-foreground">Tap character {tapFor + 1}&apos;s person</span> : undefined}>
                  {frame ? (
                    <PinStage frame={frame.url} pins={(character.people ?? []).map((p) => p.pin)} active={tapFor} onTap={placePin} />
                  ) : (
                    <div className="grid aspect-video place-items-center rounded-xl bg-muted text-[13px] text-muted-foreground">{frameError ? "This browser can't show the clip's frames — say where each person stands in words." : <Loader2 className="size-5 animate-spin" aria-label="Reading the first frame" />}</div>
                  )}
                  <p className="mt-2 text-[12px] text-muted-foreground">Press “Tap them” next to a character, then tap the person they replace.</p>
                </Panel>
              )}

              {needsFrame && !group && mode !== "picture" && (
                <Panel
                  title="First frame"
                  aside={
                    target === "click" ? (
                      <Segmented
                        label="What a click marks"
                        value={pointLabel}
                        onChange={setPointLabel}
                        className="w-auto"
                        options={[
                          { value: "positive", label: "Swap" },
                          { value: "negative", label: "Keep" },
                        ]}
                      />
                    ) : null
                  }
                >
                  {frame ? (
                    <FrameStage
                      frame={frame}
                      points={target === "click" ? points : []}
                      onPoints={target === "click" ? setPoints : undefined}
                      pointLabel={pointLabel}
                      overlay={target === "paint" ? paint?.overlay : undefined}
                      clickable={target === "click"}
                      maxPoints={GENJUTSU.maxPoints}
                    />
                  ) : (
                    <div className="grid aspect-video place-items-center rounded-xl bg-muted text-[13px] text-muted-foreground">
                      {frameError ? (
                        <p className="max-w-xs px-4 text-center">
                          This browser can&apos;t show the clip&apos;s frames (an H.265 or ProRes file?).{" "}
                          {supported.includes("type") ? "Saying it in words works without them." : "Save it as an MP4 (H.264) and add it again — or say where in words on the cloud engine."}
                        </p>
                      ) : (
                        <Loader2 className="size-5 animate-spin" aria-label="Reading the first frame" />
                      )}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {target === "paint" ? (
                      <>
                        <Button size="sm" className="rounded-full" variant={paint ? "outline" : "default"} disabled={!frame} onClick={() => setPainting(true)}>
                          <Brush className="size-3.5" /> {paint ? "Touch up the paint" : mode === "insert" ? "Paint the spot" : "Paint over it"}
                        </Button>
                        {paint && (
                          <Button size="sm" variant="ghost" className="rounded-full" onClick={() => setPaint(null)}>
                            <RotateCcw className="size-3.5" /> Clear
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" className="rounded-full" disabled={!points.length} onClick={() => setPoints(points.slice(0, -1))}>
                        <Undo2 className="size-3.5" /> Undo
                      </Button>
                    )}
                    <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">{frameHint(mode, target, points.length, !!paint)}</p>
                  </div>
                </Panel>
              )}

              {mode === "picture" && (frameTry || frameUrl) && (
                <Panel title={frameUrl ? "Your first frame" : "Check the first frame"}>
                  <FrameReview id={frameTry} approved={frameUrl} clipFrame={frame?.url} onAgain={retryFrame} onUse={(u) => void pickFrame(u)} />
                </Panel>
              )}

              {mode === "restyle" && (
                <Panel title="Look">
                  <LookPicker look={look} onLook={setLook} source={lookSource} onSource={setLookSource} custom={custom} onCustom={setCustom} words={words} onWords={setWords} />
                </Panel>
              )}

              {showRefs && (
                <Panel
                  id="gj-refs"
                  className="scroll-mt-24"
                  title={sceneEdit ? (action === "background" ? "The new place (optional)" : "What goes in (optional)") : modeInfo.refs}
                  aside={<span className="text-[12px] text-muted-foreground tabular-nums">{refs.length}/{maxRefs}</span>}
                >
                  <div className={cn("flex flex-wrap gap-2", isCharacter && maxRefs > 1 && "grid grid-cols-2 sm:flex")}>
                    {refs.slice(0, maxRefs).map((r) => (
                      <MediaSlot key={r.id} label="Reference" kind="image" value={r} onChange={(v) => setRefs((xs) => (v ? xs.map((x) => (x.id === r.id ? { ...v, id: r.id } : x)) : xs.filter((x) => x.id !== r.id)))} size="lg" />
                    ))}
                    {refs.length < maxRefs && (
                      <MediaSlot
                        label={refs.length ? "Add another" : REF_CTA[mode]}
                        kind="image"
                        value={null}
                        onChange={(v) => v && setRefs((xs) => [...xs, { ...v, id: v.id ?? nanoid(8) }])}
                        onFile={(f) => fileToList(f, setRefs, "image")}
                        size="lg"
                        required
                      />
                    )}
                  </div>
                  <p className="mt-2 text-[12px] text-muted-foreground">
                    {group ? "Up to four characters, each taking over one person in the clip — same moves, same scene, same sound." : REF_HINT[mode]}
                    {maker && maker.refs.max > 0 && maker.refs.max < maxRefs && ` ${maker.label} uses ${maker.refs.max === 1 ? "the first one" : `up to ${maker.refs.max}`}.`}
                  </p>
                </Panel>
              )}
            </div>

            <Panel id="gj-side" className="space-y-4 lg:sticky lg:top-[calc(var(--chrome-top)+1rem)]">
              {mode === "picture" && <PictureSteps stage={pictureStage} />}
              {example && <ModeExampleRow key={example.id} card={example} owner={owner} canUse inUse={exampleInUse} onlyYou={exampleOnlyYou} onUse={() => pickExample(example)} />}
              <p className="text-[13px] text-pretty text-muted-foreground">{hint}</p>

              {mode === "finish" && <FinishFields value={finish} onChange={setFinish} open={open} mark={mark} seed={seed} onSeed={setSeed} />}

              {mode === "picture" && pictureStage === "frame" && (
                <>
                  <LightPicker value={picture} onChange={setPicture} open={open} lightMark={mark("picture-light")} ownMark={mark("picture-own-person")} />
                  <Field label="Adjust (optional)" htmlFor="gj-adjust">
                    <Input id="gj-adjust" value={picture.adjust ?? ""} onChange={(e) => setPicture({ ...picture, adjust: e.target.value.slice(0, 300) || undefined })} maxLength={300} placeholder="e.g. “arms crossed, chin up”" className="h-11 text-[13px]" />
                  </Field>
                </>
              )}
              {mode === "picture" && pictureStage === "video" && (
                <>
                  <Field label="What happens" htmlFor="gj-scene" hint={describing ? "Writing…" : undefined}>
                    <Textarea
                      id="gj-scene"
                      value={scene}
                      onChange={(e) => setScene(e.target.value.slice(0, 2000))}
                      maxLength={2000}
                      rows={5}
                      disabled={describing}
                      placeholder="What the person does, moment by moment"
                      className={cn("resize-none text-[13px]", describing && "animate-pulse")}
                    />
                  </Field>
                  <More>
                    <Field label="Motion detail">
                      <Segmented
                        label="Motion detail"
                        value={String(picture.motionDetail ?? 0)}
                        onChange={(v) => setPicture({ ...picture, motionDetail: (Number(v) || undefined) as PictureOptions["motionDetail"] })}
                        options={[
                          { value: "0", label: "Match the video" },
                          { value: "512", label: "512" },
                          { value: "768", label: "768" },
                        ]}
                      />
                    </Field>
                    <Field label="Renderer" hint={mark("picture-h3-renderer")}>
                      <Segmented
                        label="Renderer"
                        value={picture.renderer ?? "solar"}
                        onChange={(renderer) => setPicture({ ...picture, renderer: renderer === "solar" ? undefined : renderer })}
                        options={[
                          { value: "solar", label: "Standard" },
                          { value: "h3", label: "H3" },
                        ]}
                      />
                    </Field>
                    <Field label="Seed" htmlFor="gj-pic-seed" hint="Blank: a new one each time">
                      <Input id="gj-pic-seed" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))} className="h-11 text-[13px]" />
                    </Field>
                  </More>
                </>
              )}

              {MODE_TARGETS[mode].length > 0 && !group && (
                <Field label={TARGET_QUESTION[mode]}>
                  <Segmented
                    label={TARGET_QUESTION[mode]}
                    value={target!}
                    onChange={(t) => setTargets((x) => ({ ...x, [mode]: t }))}
                    options={MODE_TARGETS[mode].map((t) => ({
                      value: t,
                      label: TARGET_LABELS[mode][t]!.label,
                      disabled: !supported.includes(t),
                      title: supported.includes(t) ? TARGET_LABELS[mode][t]!.hint : engine === "open" ? "On the cloud engine" : "On your GPU (the open engine)",
                    }))}
                  />
                  {supported.length < MODE_TARGETS[mode].length && (
                    <p className="text-[12px] text-muted-foreground">{engine === "open" ? (mode === "swap" && supported.includes("paint") ? "Clicking is on the cloud engine" : OPEN_TARGET_PROBLEM[mode]) : CLICK_ON_GPU}.</p>
                  )}
                </Field>
              )}

              {sceneEdit && (
                <SceneEditFields
                  value={objectEdit}
                  onChange={setObjectEdit}
                  action={action}
                  onAction={(a) => {
                    setAction(a);
                    setObjectEdit((o) => ({ ...o, action: a }));
                  }}
                  open={open}
                  mark={mark}
                  painted={!!paint}
                  target={target}
                  seed={seed}
                  onSeed={setSeed}
                />
              )}
              {sceneEdit && marked.target && objectEdit.target && <p className="-mt-2 text-[12px] text-muted-foreground">{MARKED_NOTE}</p>}

              {group && (
                <WhoBecomesWho
                  refs={refs.filter((r) => !r.uploading)}
                  value={character}
                  onChange={setCharacter}
                  onTap={frame ? (i) => setTapFor(i) : null}
                  oneByOne={{ show: refs.length === 2 && open("group-swap-one-by-one"), mark: mark("group-swap-one-by-one") }}
                  seed={seed}
                  onSeed={setSeed}
                />
              )}

              {mode === "swap" && !sceneEdit && (
                <Field label={target === "type" && !maker?.promptOptional ? "What to swap" : "What to swap (optional)"} htmlFor="gj-subject">
                  <Input
                    id="gj-subject"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    maxLength={300}
                    placeholder={maker?.people ? "e.g. “the presenter”" : "e.g. “the red car”, “her jacket”"}
                    className="text-[13px]"
                  />
                  {marked.subject && subject.trim() && <p className="text-[12px] text-muted-foreground">{MARKED_NOTE}</p>}
                </Field>
              )}

              {isCharacter && !group && (
                <CharacterControls
                  engine={engine}
                  maker={maker}
                  target={target}
                  value={character}
                  onChange={setCharacter}
                  quality={charQuality}
                  onQuality={setCharQuality}
                  seed={seed}
                  onSeed={setSeed}
                  seedProblem={seedProblem(seedNumber)}
                  // Everyone sees it: an account describes on its own GPU, a guest is offered the free account first.
                  describe={{ run: () => void describeCharacter(), busy: describingCharacter, blocked: refs.some((r) => !r.uploading) ? null : "Add your character's picture to describe it" }}
                  words={{ run: () => void fillClipWords(), busy: listening, blocked: clip?.url && !clip.uploading && range ? null : "Add the clip first" }}
                  voiceFirst={voiceFirstShown ? { on: cleanFirst, onChange: setVoiceFirst, seconds: duration } : undefined}
                />
              )}

              {/* The looks are words of their own: Restyle takes no prompt (nor do the Openjutsu modes: they have fields of their own). */}
              {mode !== "restyle" && !fresh && (
                <Field label={PROMPT_LABEL[mode](target)} htmlFor="gj-prompt">
                  <Textarea
                    id="gj-prompt"
                    value={prompt}
                    onChange={(e) => setPrompts((x) => ({ ...x, [mode]: e.target.value }))}
                    maxLength={isCharacter ? CHARACTER_SWAP.maxDirectionChars : GENJUTSU.maxPromptChars}
                    rows={2}
                    placeholder={PROMPT_PLACEHOLDER[mode]}
                    className="resize-none text-[13px]"
                  />
                </Field>
              )}

              {maker && options.length > 1 && (
                <Field label="Model">
                  <MakerList
                    options={options}
                    value={maker.pair && maker.tier === "high" ? maker.pair : maker.id}
                    onChange={(id) => {
                      setPicked((p) => ({ ...p, [choiceKey]: id }));
                      // Another model than Scene edit: back to swapping (Remove it and New background are Scene edit's).
                      if (mode === "swap" && !options.find((m) => m.id === id)?.actions) setAction("change");
                      // Motion transfer's MiniMax H3 takes up to 15 s: a longer selection is cut back to its first 15 s.
                      const most = mode === "motion" ? options.find((m) => m.id === id)?.part?.max : undefined;
                      if (most && range && range.endTime - range.startTime > most + 0.05) setRange({ ...range, endTime: Math.round((range.startTime + most) * 100) / 100 });
                    }}
                    mark={(m) => (m.features && !m.features.some((f) => !!live?.[f]) ? mark(m.features[0]) : undefined)}
                  />
                </Field>
              )}
              {maker && options.length <= 1 && (
                <p className="text-[12px] text-muted-foreground">
                  <SourceBadge source={maker.source} /> <span className="font-medium text-foreground">{maker.label}</span> · {maker.note}
                </p>
              )}

              {maker?.pair && (
                <Field label="Quality" hint={(maker.tier ?? tier) === "standard" ? "Standard: the cheaper, faster tier" : "High: the full Original"}>
                  <Segmented
                    label="Quality"
                    value={maker.tier ?? tier}
                    onChange={setTier}
                    options={[
                      { value: "standard" as const, label: "Standard" },
                      { value: "high" as const, label: "High" },
                    ]}
                  />
                </Field>
              )}

              {(!isCharacter || !maker?.h3) && mode !== "finish" && !(mode === "picture" && pictureStage === "frame") && (
                <Field label="Resolution" hint={maker ? upFirst(resolutionWords(maker, quality)) : undefined}>
                  {/* What renders is what shows as picked: a model that stops at 480p shows 480p, not the 720p asked for. */}
                  <Segmented
                    label="Resolution"
                    value={(maker && GENJUTSU.qualities.find((q) => q === qualityFor(maker, quality))) || quality}
                    onChange={setQuality}
                    options={GENJUTSU.qualities.map((q) => ({ value: q, label: q }))}
                  />
                </Field>
              )}

              {seedShown && (
                <Field label="Seed" htmlFor="gj-any-seed" hint="Blank: a new one each time">
                  <Input id="gj-any-seed" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, "").slice(0, 15))} className="h-11 text-[13px]" />
                </Field>
              )}

              {clip?.info?.hasAudio !== false && mode !== "picture" && <OriginalSoundPicker engine={soundEngine} value={originalSound} onChange={setOriginalSound} />}

              <div className="space-y-3 border-t pt-3">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1" aria-live="polite">
                    {blocker ? (
                      <p className="text-[13px] text-muted-foreground">{blocker}</p>
                    ) : (
                      <>
                        <p className="flex items-center gap-1.5 text-[15px] font-semibold tabular-nums">
                          {costText(est, engine)}
                          {estimate.isFetching && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label="Updating the price" />}
                        </p>
                        {est && (
                          <p className="text-[12px] leading-snug text-muted-foreground">
                            {est.modelName} · {est.seconds} s{est.pieces > 1 ? ` in ${est.pieces} ${mode === "restyle" ? "segments" : engine === "open" ? "windows" : "pieces"}` : ""}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  <Button id="gj-generate" className="rounded-full" onClick={() => press(setupNeed, () => start())} disabled={!!blocker || runMutation.isPending || describing}>
                    {runMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} {mode === "picture" ? (pictureStage === "frame" ? "Make the first frame" : "Make the video") : "Generate"}
                  </Button>
                </div>
                {est && est.notes.length > 0 && !blocker && (
                  <ul className="space-y-1 text-[12px] leading-snug text-muted-foreground">
                    {est.notes.map((n) => (
                      <li key={n} className="flex gap-1.5">
                        <Sparkles className="mt-0.5 size-3 shrink-0 text-brand-text" />
                        <span>{n}.</span>
                      </li>
                    ))}
                  </ul>
                )}
                {isCharacter && !group && <CharacterFacts
                    engine={engine}
                    maker={maker}
                    cut={cut}
                    onOpenStudio={() => void openStudio()}
                    opening={opening}
                    waiting={clip?.uploading || refs.some((x) => x.uploading) ? "waiting for the upload" : null}
                  />}
              </div>
            </Panel>
          </div>
        )}
      </div>

      {examples && !clip && !run && history.isSuccess && !history.data.length && <ExampleRow row={examples} layout="column" maxColumns={2} maxWidth={640} className="mt-12" />}

      {run && (
        <RunPanel
          run={run}
          onAgain={() => start(run)}
          finish={[...(open("finish-faces") ? (["faces"] as const) : []), ...(open("finish-colours") ? (["colours"] as const) : [])]}
          onFinish={(tool, url) => {
            const q = new URLSearchParams({ mode: "finish", tool, video: url });
            const photo = run.body.references?.length === 1 && run.body.mode !== "finish" ? run.body.references[0] : null;
            if (tool === "faces" && photo) q.set("image", photo);
            setRun(null);
            router.push(`/genjutsu?${q}`);
          }}
        />
      )}

      {(history.data?.length ?? 0) > 0 && (
        <section className="mt-10" aria-labelledby="genjutsu-history">
          <h3 id="genjutsu-history" className="mb-3 font-heading text-[22px]">
            Your Genjutsu
          </h3>
          <Feed items={history.data!} />
        </section>
      )}

      {frame && (
        <SketchEditor
          open={painting}
          onOpenChange={setPainting}
          image={frame.url}
          mode="mask"
          initialStrokes={paint?.strokes}
          onDone={(r) => r.mask && setPaint({ mask: r.mask, overlay: r.overlay, strokes: r.strokes })}
        />
      )}
      <Suspense fallback={null}>
        <UrlParams onChange={setParams} />
      </Suspense>
      <AlertDialog open={!!askReplace} onOpenChange={(o) => !o && setAskReplace(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your settings with the example&apos;s?</AlertDialogTitle>
            <AlertDialogDescription>Your words and settings change to the example&apos;s. Your clip and photos stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep mine</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (askReplace) loadExample(askReplace);
                setAskReplace(null);
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ToolShell>
  );
}

/** Reports the URL's query as it changes. It reads the URL, so it sits under its own Suspense (the static shell renders without it). */
function UrlParams({ onChange }: { onChange: (search: string) => void }) {
  const search = useSearchParams().toString();
  useEffect(() => onChange(search), [search, onChange]);
  return null;
}

/**
 * A hand-off from this page's own feed: back up to the clip it now works on. The result's ⋯ menu gives focus back to
 * its button as it closes, which scrolls down to the feed again (after the router's own scroll to the top), so once
 * more after that.
 */
function backToTop() {
  window.scrollTo({ top: 0 });
  const again = () => requestAnimationFrame(() => window.scrollTo({ top: 0 }));
  window.addEventListener("focusin", again, { once: true });
  setTimeout(() => window.removeEventListener("focusin", again), 1500);
}

const upFirst = (t: string | undefined) => (t ? t[0].toUpperCase() + t.slice(1) : undefined);

/** A dropped connection in words (the browser says "Failed to fetch"). */
const friendly = (msg: string) => (/failed to fetch|networkerror|load failed/i.test(msg) ? "Couldn't reach Fuobe — check that it's running, then try again" : msg);

/** Restyle before a look is picked: the kind of look the tab stands for (so the model list matches it). */
function lookPlaceholder(s: LookSource): GenjutsuLook {
  return s === "soul" ? { kind: "soul", id: "" } : s === "custom" ? { kind: "custom", images: [] } : { kind: "preset", id: "" };
}

const CLICK_ON_GPU = "Clicking runs on your GPU (SAM 3.1 marks them) — on the cloud, pick who in words";

const TARGET_QUESTION: Record<GenjutsuMode, string> = { motion: "", restyle: "", character: "Who gets swapped?", swap: "What gets swapped?", insert: "Where does it go?", picture: "", finish: "" };

const REF_CTA: Record<GenjutsuMode, string> = {
  motion: "Add your character",
  character: "Add your character",
  swap: "Add what goes in",
  insert: "Add what to add",
  restyle: "Add a character",
  picture: "Add your character",
  finish: "Add the character photo",
};

const REF_HINT: Record<GenjutsuMode, string> = {
  motion: "A clear, full-body picture of the character who takes over the performance. More angles help Genjutsu.",
  character: "One clear picture of your character, head to toe, facing the camera — PNG, JPEG or WebP. They take the person's place.",
  swap: "The thing, person or outfit that goes in — cut out on a plain background works best.",
  insert: "The object or character to add — cut out on a plain background works best.",
  restyle: "Optional: characters who should appear in the look.",
  picture: "One picture gives both the look and the setting. Full body, in the place you want them.",
  finish: "The face to match: a clear, front-facing photo of your character.",
};

const PROMPT_LABEL: Record<GenjutsuMode, (t?: GenjutsuTarget) => string> = {
  motion: () => "Describe your character (optional)",
  character: () => "Direction (optional)",
  swap: () => "Describe the result (optional)",
  insert: (t) => (t === "type" ? "Where it goes" : "What appears there (optional)"),
  restyle: () => "Anything to keep (optional)",
  picture: () => "Adjust (optional)",
  finish: () => "",
};

const PROMPT_PLACEHOLDER: Record<GenjutsuMode, string> = {
  motion: "e.g. “a knight in silver armour, in a stone hall”",
  character: "e.g. “keep the hand on the railing; she smiles at the end”",
  swap: "e.g. “a white horse trotting at the same pace”",
  insert: "e.g. “on the table, next to the cup”",
  restyle: "e.g. “keep her pink hair the same in every shot”",
  picture: "e.g. “arms crossed, chin up”",
  finish: "",
};

function frameHint(mode: GenjutsuMode, target: GenjutsuTarget | undefined, points: number, painted: boolean): string {
  if (target === "click" && mode === "character") return points ? "Add points on the same person, or mark someone to leave with Keep." : "Click the person to swap. Keyboard: arrows move the crosshair, Enter adds a point.";
  if (target === "click") return points ? "Add points on the same thing, or mark what stays with Keep." : "Click what to swap. Keyboard: arrows move the crosshair, Enter adds a point.";
  if (mode === "insert") return painted ? "Red is where it goes. It stays there for the whole shot." : "Paint where it should appear — it stays there for the whole shot, so a still camera works best.";
  return painted ? "Red is what gets swapped. Touch up the paint, or clear it." : "Paint over what to swap — it only needs to cover it on this frame.";
}

/** The modes as tabs under the header (the selected one is in the URL as ?mode=); only the ones open to this viewer. */
function ModeTabsRow({ modes, mode, onMode, mark }: { modes: typeof GENJUTSU_MODES; mode: GenjutsuMode; onMode: (m: GenjutsuMode) => void; mark: (m: GenjutsuMode) => React.ReactNode }) {
  // The selected tab stays in view on a phone, where the row scrolls (only the row: the page stays put).
  return (
    <div className="border-b">
      <TabRow role="tablist" aria-label="Genjutsu modes" onKeyDown={tabKeys} follow className="m-0 px-4 py-1.5 sm:px-6">
        {modes.map((m) => {
          const on = m.id === mode;
          return (
            <button key={m.id} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1} onClick={() => onMode(m.id)} className={TAB_PILL} {...onAttr(on)}>
              {m.label}
              {mark(m.id)}
            </button>
          );
        })}
      </TabRow>
    </div>
  );
}

/** Where a model comes from, as a small badge: a Fuobe Original, open weights, or a partner's closed model. */
function SourceBadge({ source }: { source: Maker["source"] }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[4px] px-1 align-[1px] text-[10px] font-medium",
        source === "original" ? "bg-brand-faint text-brand-text" : source === "open" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
  );
}

/** The models for this mode and engine, one line each (where it comes from, what it's good at, its limits). */
function MakerList({ options, value, onChange, mark }: { options: Maker[]; value: string; onChange: (id: string) => void; mark?: (m: Maker) => React.ReactNode }) {
  return (
    <div role="radiogroup" aria-label="Model" onKeyDown={radioKeys} className="space-y-1.5">
      {options.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          tabIndex={radioTab(value === m.id)}
          onClick={() => onChange(m.id)}
          className={cn(
            "flex w-full min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
            value === m.id && "border-primary bg-brand-faint hover:bg-brand-faint-hover",
          )}
        >
          <span className={cn("mt-1 size-3 shrink-0 rounded-full border-2", value === m.id ? "border-primary bg-primary" : "border-border-strong")} />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
              {m.label} <SourceBadge source={m.source} />
              {mark?.(m)}
            </span>
            <span className="block text-[12px] leading-snug text-muted-foreground">{m.note}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/** What a run's steps are doing, then the result with a before / after wipe, Download and Run again. */
function RunPanel({ run, onAgain, finish = [], onFinish }: { run: Run; onAgain: () => void; finish?: ("faces" | "colours")[]; onFinish?: (tool: "faces" | "colours", url: string) => void }) {
  const list = useGenerationList(run.ids).data;
  const byId = useMemo(() => new Map((list ?? []).map((g) => [g.id, g])), [list]);
  const final = byId.get(run.final);
  const placeholders = placeholdersOn(useStatus().data?.demoMode);
  // Run again sends the run's own request again (a new seed): on the cloud it says that request's price, from the same
  // estimate the Generate button showed ("· paid" until it's known, or when it can't be priced).
  const priced = !!final && final.engine !== "open" && final.place !== "pool" && !placeholders;
  const againEst = useGenjutsuEstimate(priced ? run.body : null);
  const againCost = againEst.data && !againEst.isError && !againEst.data.demo ? againEst.data.costUsd : null;
  const rows: StepRow[] = run.ids.map((id) => {
    const g = byId.get(id);
    return { key: id, label: g?.request.step?.label ?? "A step", g };
  });
  const state = chainState(rows.map((r) => ({ g: r.g, label: r.label })).sort((a, b) => (a.g?.id === run.final ? 1 : b.g?.id === run.final ? -1 : 0)));
  const out = final?.status === "succeeded" ? final.outputs.find((o) => o.kind === "video") : undefined;
  // A step that fell back (the first frame couldn't be made) says so on the result.
  const notices = [...new Set(rows.flatMap((r) => (r.g?.request.notice ? [r.g.request.notice] : [])))];
  return (
    <section className="mt-6" aria-labelledby="gj-run-title">
      <Panel
        title={<span id="gj-run-title">{final?.request.title ?? "Your Genjutsu"}</span>}
        aside={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {out && final && (
              <Button asChild size="sm" variant="outline" className="rounded-full">
                <a href={downloadHref(out.url, downloadName(final, out, 0))}>
                  <Download className="size-3.5" /> Download
                </a>
              </Button>
            )}
            {out &&
              onFinish &&
              finish.map((tool) => (
                <Button key={tool} size="sm" variant="outline" className="h-11 rounded-full sm:h-8" onClick={() => onFinish(tool, out.url)}>
                  <Sparkles className="size-3.5" /> {tool === "faces" ? "Fix faces" : "Fix colours"}
                </Button>
              ))}
            {(out || state.status === "failed") && (
              <Button size="sm" variant="outline" className="rounded-full" onClick={onAgain}>
                <RotateCcw className="size-3.5" /> {state.status === "failed" ? "Try again" : "Run again"}
                {againWhere(final, { placeholders }, againCost)}
              </Button>
            )}
          </div>
        }
      >
        {notices.length > 0 && (
          <p role="status" className="mb-3 flex gap-1.5 rounded-lg bg-muted p-2 text-[12px] text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{notices.join(" · ")}.</span>
          </p>
        )}
        {out ? (
          <VideoCompare before={run.before} after={out.url} start={run.start} ratio={run.ratio} />
        ) : (
          <div className="space-y-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)} aria-label="Progress">
              <div className={cn("h-full origin-left transition-transform duration-(--motion-slow) ease-standard", state.status === "failed" ? "bg-destructive" : "bg-primary")} style={{ transform: `scaleX(${(Math.max(4, state.progress * 100)) / 100})` }} />
            </div>
            <p className={cn("text-[13px]", state.status === "failed" ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
              {state.status === "failed" ? `${state.label}: ${state.error}` : state.label}
            </p>
            {rows.length > 1 && <StepList steps={rows} />}
          </div>
        )}
      </Panel>
    </section>
  );
}

/** Group swap's taps: the part's first frame with each character's numbered pin; a tap places the active one. */
function PinStage({ frame, pins, active, onTap }: { frame: string; pins: ({ x: number; y: number } | undefined)[]; active: number | null; onTap: (x: number, y: number) => void }) {
  return (
    <div
      role="button"
      tabIndex={active === null ? -1 : 0}
      aria-label={active === null ? "The part's first frame" : `Tap the person character ${active + 1} replaces`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onTap((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onTap(0.5, 0.5);
      }}
      className={cn("relative overflow-hidden rounded-xl bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring", active !== null && "cursor-crosshair ring-2 ring-primary")}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={frame} alt="" className="block w-full" draggable={false} />
      {pins.map((p, i) =>
        p ? (
          <span
            key={i}
            className="absolute grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white text-[12px] font-semibold text-white shadow"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, background: PERSON_COLOURS[i] }}
          >
            {i + 1}
          </span>
        ) : null,
      )}
    </div>
  );
}

/** From picture's first frame: the try being made (or the approved one) next to the clip's, with Try again / Use this frame. */
function FrameReview({ id, approved, clipFrame, onAgain, onUse }: { id: string | null; approved: string | null; clipFrame?: string; onAgain: () => void; onUse: (url: string) => void }) {
  const list = useGenerationList(id ? [id] : []).data;
  const g = id ? list?.find((x) => x.id === id) : undefined;
  const made = approved ?? (g?.status === "succeeded" ? g.outputs.find((o) => o.kind === "image")?.url : undefined);
  const failed = g?.status === "failed" ? friendly(g.error ?? "It didn't finish") : undefined;
  return <FrameCompare clip={clipFrame} made={made} busy={!approved && !!id && !made && !failed} error={failed} onAgain={onAgain} onUse={() => made && onUse(made)} />;
}
