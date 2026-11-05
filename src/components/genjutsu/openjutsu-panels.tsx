"use client";

import { Check, ChevronDown, MapPin, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, Segmented } from "@/components/shorts/ui";
import type { SlotValue } from "@/components/studio/media-slot";
import { roleFromPin, type CharacterOptions } from "@/lib/catalog/character-swap";
import { OPENJUTSU_LIMITS, SCENE_ACTIONS, type FeatureCheck, type FinishOptions, type GenjutsuFeature, type ObjectEdit, type PictureOptions, type SceneAction } from "@/lib/catalog/genjutsu";
import { LIGHT_LOOKS, type LookId } from "@/lib/openjutsu-graphs";
import { cn } from "@/lib/utils";

/**
 * Genjutsu's Openjutsu panels (Group swap's Who becomes who, Scene edit, From picture's light and steps, Finish): phone
 * first (44 px taps, wraps, no sideways scroll). What hasn't opened on this studio's GPU yet carries a mark: "Only you" for the owner, what it runs on for a visitor.
 */

/** The owner's mark on a tab, an action or a card nobody else sees yet. */
export function OnlyYou({ className }: { className?: string }) {
  return <span className={cn("inline-flex h-4 shrink-0 items-center rounded-[4px] bg-muted px-1 align-[1px] text-[10px] font-medium text-muted-foreground", className)}>Only you</span>;
}

/** A feature's mark while it hasn't opened on this studio's GPU (OnlyYou for the owner, OwnSetupChip for a visitor). */
export type FeatureMark = (f: GenjutsuFeature) => React.ReactNode;

/** Each character's colour: the number badge and the pin on the frame. */
export const PERSON_COLOURS = ["#e11d48", "#2563eb", "#16a34a", "#d97706"] as const;

/** A part of the panel that opens on a tap (More). */
export function More({ children, label = "More" }: { children: React.ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 w-full items-center justify-between px-3 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && <div className="space-y-3 border-t px-3 py-3">{children}</div>}
    </div>
  );
}

function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-[13px]">
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {hint && <span className="block text-[12px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

const EDGES = [
  { value: "tight" as const, label: "Tight" },
  { value: "normal" as const, label: "Normal" },
  { value: "loose" as const, label: "Loose" },
];

// ---------------------------------------------------------------------------
// Group swap: Who becomes who

export function WhoBecomesWho({
  refs,
  value,
  onChange,
  onTap,
  oneByOne,
  seed,
  onSeed,
}: {
  refs: SlotValue[];
  value: CharacterOptions;
  onChange: (c: CharacterOptions) => void;
  /** Opens the part's first frame for this character's tap (null while the frame can't be shown). */
  onTap: ((i: number) => void) | null;
  /** The Render choice shows (exactly 2 characters, and it is open to this viewer). */
  oneByOne: { show: boolean; mark?: React.ReactNode };
  seed: string;
  onSeed: (s: string) => void;
}) {
  const people = value.people ?? [];
  const setRole = (i: number, role: string) => {
    const next = refs.map((_, k) => people[k] ?? { role: "" });
    next[i] = { ...next[i], role: role.slice(0, OPENJUTSU_LIMITS.roleChars) };
    onChange({ ...value, people: next });
  };
  return (
    <div className="space-y-3">
      <Field label="Who becomes who">
        <ol className="space-y-2">
          {refs.map((r, i) => (
            <li key={r.id} className="flex items-center gap-2">
              <span className="relative size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {r.preview && <img src={r.preview} alt="" className="size-full object-cover" />}
                <span className="absolute top-0.5 left-0.5 grid size-5 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: PERSON_COLOURS[i] }}>
                  {i + 1}
                </span>
              </span>
              <Input
                aria-label={`Character ${i + 1} replaces`}
                value={people[i]?.role ?? ""}
                onChange={(e) => setRole(i, e.target.value)}
                maxLength={OPENJUTSU_LIMITS.roleChars}
                placeholder="Replaces…"
                className="h-11 min-w-0 flex-1 text-[13px]"
              />
              <Button type="button" variant="outline" className="h-11 shrink-0 rounded-full px-3" disabled={!onTap} onClick={() => onTap?.(i)}>
                <MapPin className="size-3.5" /> Tap them
              </Button>
            </li>
          ))}
        </ol>
        <p className="text-[12px] text-muted-foreground">Say where they stand or what they do. Clothes and hair words can carry over.</p>
      </Field>
      {oneByOne.show && (
        <Field label="Render" hint={oneByOne.mark}>
          <Segmented
            label="Render"
            value={value.onePerPerson ? "one" : "both"}
            onChange={(v) => onChange({ ...value, onePerPerson: v === "one" || undefined })}
            options={[
              { value: "both", label: "Both at once" },
              { value: "one", label: "One by one" },
            ]}
          />
          <p className="text-[12px] text-muted-foreground">One by one draws each person on their own pass. Sharper, about twice as long.</p>
        </Field>
      )}
      <More>
        <SwitchRow label="Hats and big hair" hint="A little slower" checked={!!value.hats} onChange={(on) => onChange({ ...value, hats: on || undefined })} />
        <SwitchRow
          label="Mouths follow the sound"
          hint="Off for music clips where nobody sings"
          checked={value.mouthsFollowSound !== false}
          onChange={(on) => onChange({ ...value, mouthsFollowSound: on ? undefined : false })}
        />
        <Field label="Edge">
          <Segmented label="Edge" value={value.edge ?? "normal"} onChange={(edge) => onChange({ ...value, edge: edge === "normal" ? undefined : edge })} options={EDGES} />
        </Field>
        <Field label="Motion detail">
          <Segmented
            label="Motion detail"
            value={value.motionDetail === 768 ? "high" : "standard"}
            onChange={(v) => onChange({ ...value, motionDetail: v === "high" ? 768 : undefined })}
            options={[
              { value: "standard", label: "Standard" },
              { value: "high", label: "High" },
            ]}
          />
        </Field>
        <SeedField seed={seed} onSeed={onSeed} />
      </More>
    </div>
  );
}

function SeedField({ seed, onSeed }: { seed: string; onSeed: (s: string) => void }) {
  return (
    <Field label="Seed" htmlFor="oj-seed" hint="Blank: a new one each time">
      <Input id="oj-seed" inputMode="numeric" value={seed} onChange={(e) => onSeed(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))} className="h-11 text-[13px]" />
    </Field>
  );
}

/** The words a tap writes, when the field is empty (the person can then edit them). */
export function roleForTap(current: string | undefined, pin: { x: number; y: number }): string {
  return current?.trim() ? current : roleFromPin(pin);
}

// ---------------------------------------------------------------------------
// Scene edit

export function SceneEditFields({
  value,
  onChange,
  action,
  onAction,
  open,
  mark,
  painted,
  target,
  seed,
  onSeed,
  removeLink,
}: {
  value: ObjectEdit;
  onChange: (o: ObjectEdit) => void;
  action: SceneAction;
  onAction: (a: SceneAction) => void;
  open: FeatureCheck;
  /** A feature that hasn't opened on this studio's GPU: its mark (OnlyYou for the owner, OwnSetupChip for a visitor). */
  mark: FeatureMark;
  painted: boolean;
  target: "type" | "paint" | "click" | undefined;
  seed: string;
  onSeed: (s: string) => void;
  /** "For a quick clean-up, Video tools → Remove object." (shown when that tool is the better one). */
  removeLink?: boolean;
}) {
  const actions = SCENE_ACTIONS.filter((a) => open(a.feature));
  const info = SCENE_ACTIONS.find((a) => a.id === action)!;
  const set = (o: Partial<ObjectEdit>) => onChange({ ...value, ...o, action });
  return (
    <div className="space-y-3">
      {actions.length > 1 && (
        <Field label="Action" hint={mark(info.feature)}>
          <Segmented label="Action" value={action} onChange={onAction} options={actions.map((a) => ({ value: a.id, label: a.label }))} />
        </Field>
      )}
      <p className="text-[12px] text-muted-foreground">{info.hint}</p>
      {(action !== "change" || target !== "paint") && (
        <Field label={action === "remove" ? "What goes" : action === "background" ? "What stays" : "What changes"} htmlFor="oj-target">
          <Input
            id="oj-target"
            value={value.target ?? ""}
            onChange={(e) => set({ target: e.target.value.slice(0, 120) })}
            maxLength={120}
            placeholder={action === "remove" ? "e.g. “the handbag”" : action === "background" ? "the people" : "e.g. “her coat”"}
            className="h-11 text-[13px]"
          />
        </Field>
      )}
      {action === "change" && target === "paint" && !painted && <p className="text-[12px] text-muted-foreground">Paint over what changes on the first frame.</p>}
      <Field label={action === "remove" ? "What shows there (optional)" : action === "background" ? "The new place" : "What it becomes"} htmlFor="oj-becomes">
        <Textarea
          id="oj-becomes"
          value={value.becomes ?? ""}
          onChange={(e) => set({ becomes: e.target.value.slice(0, 300) })}
          maxLength={300}
          rows={2}
          placeholder={action === "remove" ? "e.g. “the boulevard continues”" : action === "background" ? "e.g. “an Amalfi cliff terrace at golden hour”" : "e.g. “a crimson velvet tailored blazer”"}
          className="resize-none text-[13px]"
        />
      </Field>
      {action === "remove" && removeLink && <p className="text-[12px] text-muted-foreground">For a quick clean-up, Video tools → Remove object.</p>}
      {action === "change" && (
        <>
          <SwitchRow label="Only the biggest one" checked={!!value.biggestOnly} onChange={(on) => set({ biggestOnly: on || undefined })} />
          <SwitchRow label="Keep its shape" hint="The new one follows the old outline" checked={!!value.keepShape} onChange={(on) => set({ keepShape: on || undefined })} />
        </>
      )}
      <More>
        <Field label="Edge">
          <Segmented label="Edge" value={value.edge ?? "normal"} onChange={(edge) => set({ edge: edge === "normal" ? undefined : edge })} options={EDGES} />
        </Field>
        <Field label="Motion detail">
          <Segmented
            label="Motion detail"
            value={value.motionDetail === 768 ? "high" : "standard"}
            onChange={(v) => set({ motionDetail: v === "high" ? 768 : undefined })}
            options={[
              { value: "standard", label: "Standard" },
              { value: "high", label: "High" },
            ]}
          />
        </Field>
        <SeedField seed={seed} onSeed={onSeed} />
      </More>
    </div>
  );
}

// ---------------------------------------------------------------------------
// From picture

/** Each look's swatch until its preview picture is made (two colours of its light). */
const LOOK_SWATCH: Record<LookId, [string, string]> = {
  "cold-spotlight": ["#cbd5e1", "#0f172a"],
  "golden-halo": ["#fbbf24", "#7c2d12"],
  "red-and-blue": ["#dc2626", "#1d4ed8"],
  "magenta-club": ["#db2777", "#3b0764"],
  "teal-lasers": ["#22d3ee", "#0c1e3e"],
  "acid-green": ["#84cc16", "#052e16"],
  "lime-and-violet": ["#d9f99d", "#5b21b6"],
  "cyan-glow": ["#a5f3fc", "#020617"],
  "crimson-room": ["#991b1b", "#1c0606"],
  "venetian-blinds": ["#fcd34d", "#111827"],
  "phone-glow": ["#bfdbfe", "#000000"],
  firelight: ["#f97316", "#190a02"],
  "sunset-window": ["#fb923c", "#3f1d0b"],
  "evening-lamp": ["#fdba74", "#292524"],
  "rim-light": ["#f8fafc", "#0a0a0a"],
  "blue-night": ["#818cf8", "#0b1026"],
  "camera-flash": ["#ffffff", "#262626"],
};

export function PictureSteps({ stage }: { stage: "frame" | "video" }) {
  return (
    <ol className="flex items-center gap-2 text-[13px]" aria-label="Steps">
      <li className={cn(stage === "frame" ? "font-semibold text-foreground" : "text-muted-foreground")} aria-current={stage === "frame" ? "step" : undefined}>
        1 First frame
      </li>
      <li aria-hidden className="text-muted-foreground">
        ·
      </li>
      <li className={cn(stage === "video" ? "font-semibold text-foreground" : "text-muted-foreground")} aria-current={stage === "video" ? "step" : undefined}>
        2 Video
      </li>
    </ol>
  );
}

export function LightPicker({
  value,
  onChange,
  open,
  lightMark,
  ownMark,
}: {
  value: PictureOptions;
  onChange: (p: PictureOptions) => void;
  open: FeatureCheck;
  lightMark?: React.ReactNode;
  ownMark?: React.ReactNode;
}) {
  const light = value.light;
  const pick = (l: PictureOptions["light"]) => onChange({ ...value, light: l });
  const words = light && "words" in light;
  const card = (key: string, label: string, on: boolean, onClick: () => void, swatch?: [string, string]) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn("group flex min-w-0 flex-col items-stretch gap-1 rounded-xl p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", on && "bg-brand-faint")}
    >
      <span
        className={cn("relative grid aspect-square w-full place-items-center overflow-hidden rounded-lg border", on && "border-primary")}
        style={swatch ? { background: `radial-gradient(circle at 35% 30%, ${swatch[0]} 0%, ${swatch[1]} 75%)` } : undefined}
      >
        {on && <Check className="size-4 text-white drop-shadow" />}
      </span>
      <span className="truncate px-0.5 text-[12px] leading-tight">{label}</span>
    </button>
  );
  return (
    <div className="space-y-3">
      {open("picture-light") && (
        <Field label="Light" hint={lightMark}>
          <div role="radiogroup" aria-label="Light" className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
            {!value.ownPerson && card("none", "As in your picture", !light, () => pick(undefined))}
            {LIGHT_LOOKS.map((l) => card(l.id, l.name, !!light && "look" in light && light.look === l.id, () => pick({ look: l.id }), LOOK_SWATCH[l.id]))}
            {card("words", "Your own words", !!words, () => pick({ words: words ? (light as { words: string }).words : "" }))}
          </div>
          {light && "look" in light && <p className="text-[12px] text-muted-foreground">{LIGHT_LOOKS.find((l) => l.id === light.look)?.hint}.</p>}
          {words && (
            <Textarea
              aria-label="The light, in your words"
              value={(light as { words: string }).words}
              onChange={(e) => pick({ words: e.target.value.slice(0, OPENJUTSU_LIMITS.lightChars) })}
              maxLength={OPENJUTSU_LIMITS.lightChars}
              rows={2}
              placeholder="e.g. “soft pearl light from a high window, warm shadows”"
              className="resize-none text-[13px]"
            />
          )}
          <p className="text-[12px] text-muted-foreground">Pose and light are set in one pass, so the picture stays clean.</p>
        </Field>
      )}
      {open("picture-own-person") && (
        <div>
          <SwitchRow
            label="Keep the clip's own person"
            hint="Relights the person already in the clip instead of bringing in a character."
            checked={!!value.ownPerson}
            onChange={(on) => onChange({ ...value, ownPerson: on || undefined, ...(on ? {} : { keepCrop: undefined }) })}
          />
          {ownMark && <div className="ml-14">{ownMark}</div>}
          {value.ownPerson && <SwitchRow label="Keep the frame's crop" checked={!!value.keepCrop} onChange={(on) => onChange({ ...value, keepCrop: on || undefined })} />}
        </div>
      )}
    </div>
  );
}

/** The made first frame next to the clip's: a 2-up toggle on phones, side by side on wider screens. */
export function FrameCompare({ clip, made, busy, error, onAgain, onUse }: { clip?: string; made?: string; busy: boolean; error?: string; onAgain: () => void; onUse: () => void }) {
  const [show, setShow] = useState<"clip" | "made">("made");
  return (
    <div className="space-y-3">
      <div className="sm:hidden">
        <Segmented
          label="Compare"
          value={show}
          onChange={setShow}
          options={[
            { value: "clip", label: "The clip" },
            { value: "made", label: "Yours" },
          ]}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <figure className={cn("min-w-0", show === "made" && "hidden sm:block")}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {clip ? <img src={clip} alt="The clip's first frame" className="w-full rounded-xl bg-muted object-contain" /> : <div className="aspect-video rounded-xl bg-muted" />}
          <figcaption className="mt-1 text-[12px] text-muted-foreground">The pose</figcaption>
        </figure>
        <figure className={cn("min-w-0", show === "clip" && "hidden sm:block")}>
          {made ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={made} alt="Your first frame" className="w-full rounded-xl bg-muted object-contain" />
          ) : (
            <div className="grid aspect-video place-items-center rounded-xl bg-muted text-[13px] text-muted-foreground" aria-live="polite">
              {error ? error : busy ? "Making your first frame…" : null}
            </div>
          )}
          <figcaption className="mt-1 text-[12px] text-muted-foreground">Yours</figcaption>
        </figure>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-11 rounded-full" disabled={busy} onClick={onAgain}>
          <X className="size-4" /> Try again
        </Button>
        <Button type="button" className="h-11 rounded-full" disabled={busy || !made} onClick={onUse}>
          <Check className="size-4" /> Use this frame
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finish

export function FinishFields({
  value,
  onChange,
  open,
  mark,
  seed,
  onSeed,
}: {
  value: FinishOptions;
  onChange: (f: FinishOptions) => void;
  open: FeatureCheck;
  mark: FeatureMark;
  seed: string;
  onSeed: (s: string) => void;
}) {
  const tools = ([
    { value: "faces" as const, label: "Fix faces", feature: "finish-faces" as const },
    { value: "colours" as const, label: "Fix colours", feature: "finish-colours" as const },
  ]).filter((t) => open(t.feature));
  const set = (f: Partial<FinishOptions>) => onChange({ ...value, ...f });
  return (
    <div className="space-y-3">
      {tools.length > 1 && (
        <Field label="Tool" hint={mark(value.tool === "faces" ? "finish-faces" : "finish-colours")}>
          <Segmented label="Tool" value={value.tool} onChange={(tool) => onChange({ tool })} options={tools.map(({ value: v, label }) => ({ value: v, label }))} />
        </Field>
      )}
      {value.tool === "faces" ? (
        <>
          <p className="text-[12px] text-muted-foreground">Redraws small or soft faces so they match your character&apos;s photo.</p>
          <Field label="Style">
            <Segmented
              label="Style"
              value={value.faceStyle ?? "mouth"}
              onChange={(faceStyle) => set({ faceStyle })}
              options={[
                { value: "photo", label: "Match the photo" },
                { value: "mouth", label: "Follow the mouth" },
              ]}
            />
          </Field>
          <More>
            <Field label="Section length">
              <Segmented
                label="Section length"
                value={String(value.chunkSeconds ?? 6.5)}
                onChange={(v) => set({ chunkSeconds: Number(v) as 4 | 6.5 | 10 })}
                options={[
                  { value: "4", label: "4 s" },
                  { value: "6.5", label: "6.5 s" },
                  { value: "10", label: "10 s" },
                ]}
              />
            </Field>
            <SeedField seed={seed} onSeed={onSeed} />
          </More>
        </>
      ) : (
        <>
          <p className="text-[12px] text-muted-foreground">A soft film finish: gentler contrast, smoother detail, rich blacks.</p>
          <Field label="Finish">
            <Segmented
              label="Finish"
              value={value.finish ?? "soft"}
              onChange={(finish) => set({ finish })}
              options={[
                { value: "soft", label: "Soft film" },
                { value: "filmic", label: "Filmic" },
                { value: "rich", label: "Rich" },
                { value: "off", label: "Off" },
              ]}
            />
          </Field>
          <Slider label="Strength" value={value.strength ?? 0.4} onChange={(strength) => set({ strength })} />
          <Slider label="Soften detail" value={value.soften ?? 0.33} onChange={(soften) => set({ soften })} />
        </>
      )}
    </div>
  );
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = `oj-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <Field label={label} htmlFor={id} hint={`${Math.round(value * 100)}%`}>
      <input id={id} type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} className="h-11 w-full accent-primary" />
    </Field>
  );
}
