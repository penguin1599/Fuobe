import Link from "next/link";
import { Fragment } from "react";
import { ArrowRight, AudioLines, Box, CalendarClock, ImageIcon, ListChecks, Plug, ScanEye, Sparkles, TextCursorInput, Undo2, Video, Zap, type LucideIcon } from "lucide-react";
import { GitHubMark } from "@/components/github-mark";
import { BeforeAfter } from "@/components/home/before-after";
import {
  AssistAction,
  AssistExamples,
  AssistTag,
  CopyCommand,
  FadeRow,
  HomeRail,
  PausePreviews,
  StartSteps,
  StudioCard,
  StudioName,
  StudioPicture,
} from "@/components/home/home-islands";
import { PILL, PILL_ICON, PILL_TAP } from "@/components/home/pill";
import { ShowcaseTile } from "@/components/home/showcase-tile";
import { CountUp } from "@/components/ui/count-up";
import { IntentLink } from "@/components/intent-link";
import { LiveChatDemo } from "@/components/live/live-chat-demo";
import { LiveDemo } from "@/components/live/live-demo";
import { NAV } from "@/components/nav-items";
import { PresetCard } from "@/components/preset-gallery";
import { ASSIST_SUGGESTIONS } from "@/lib/assist";
import { WORKFLOWS_ON_GITHUB } from "@/lib/comfy-install";
import { FUOBE_REPO } from "@/lib/connections";
import { HOME_LIVE, presetHref, type HomeShowcase } from "@/lib/home-showcase";
import { area } from "@/lib/nav-areas";
import { studioCount } from "@/lib/nav-model";
import { staggered, type AutoPlay } from "@/lib/preview-playback";
import { cn } from "@/lib/utils";
import { plainTagline } from "@/lib/plain-tagline";
import type { PresetCardData } from "@/lib/preset-cards";

/*
 * Home's sections under the wall. Server components: their words, numbers and links ship as HTML, and only the
 * cards, the before/after, the Copy button, Assist's actions and the start steps hydrate (home-islands.tsx,
 * before-after.tsx).
 */

/** A card in a HomeRail: two-thirds of a phone's width (the next one peeks in), a grid cell from sm up. */
const RAIL_ITEM = "w-[64%] shrink-0 snap-start sm:w-auto";
/**
 * A section under the fold is laid out only once it comes near the screen (content-visibility), sized until then
 * by its height at that width (`cv`, measured; the browser keeps the real one after). Its box reaches 16 px past
 * the column and 8 px above and below it, so the rails, the cards' hover and focus rings aren't cut at its edge.
 */
const SECTION = "home-cv -mx-4 mt-8 -mb-2 px-4 py-2 sm:mt-12";
const H2 = "font-heading text-[24px] leading-tight sm:text-[28px]";
const H1 = "font-heading text-[34px] leading-tight";
const LINE = "mt-1 text-[15px] text-pretty text-muted-foreground";
/** How wide a row's picture shows: two-thirds of a phone, then a third, a quarter, a sixth of the screen. */
const CARD_SIZES = "(min-width: 1280px) 16vw, (min-width: 1024px) 25vw, (min-width: 640px) 33vw, 64vw";
const STUDIO_SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 64vw";
/** An area page's cards: two a row on a phone and a tablet, four from lg. */
const GRID_SIZES = "(min-width: 1024px) 25vw, 50vw";

const navIcon = (href: string) => NAV.flatMap((g) => g.items).find((i) => i.href === href)?.icon;

/**
 * A section's heading with its count and line, and a "See all" link. `as="h1"`: an area page's own heading (the
 * PageHeader's size), with its search or quick start beside it (`children`).
 */
export function SectionHead({
  id,
  title,
  count,
  all,
  allCount = count,
  allNoun = title.toLowerCase(),
  line,
  as: Heading = "h2",
  children,
}: {
  id: string;
  title: string;
  count?: number;
  all?: string;
  /** How many "See all" leads to, when the page it opens holds fewer than the heading counts (Home's studios). */
  allCount?: number;
  /** What "See all" names for a screen reader, and on screen too when `allCount` differs from `count`. */
  allNoun?: string;
  line: string;
  as?: "h1" | "h2";
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between gap-4">
        <Heading id={id} className={Heading === "h1" ? H1 : H2}>
          {title}
          {count !== undefined && (
            <span
              aria-hidden
              className="ml-2 inline-block rounded-full bg-muted px-2 align-[0.3em] font-sans text-[13px] leading-6 tracking-normal text-muted-foreground tabular-nums"
            >
              <CountUp value={count} id={id} />
            </span>
          )}
        </Heading>
        {children}
        {all && (
          <IntentLink
            href={all}
            aria-label={`See all ${allCount} ${allNoun}`}
            // 44 px to tap: its hit area reaches past the words.
            className="group relative inline-flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground transition-colors after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] hover:text-foreground"
          >
            See all {allCount}
            {allCount !== count && ` ${allNoun}`} <ArrowRight className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
          </IntentLink>
        )}
      </div>
      <p className={LINE}>{line}</p>
    </div>
  );
}

/**
 * Preset cards with a short line each: all of them in a phone's rail; as a grid, the first `xl` from xl, the first `lg`
 * from lg to xl and the first `sm` from sm to lg (a rail costs no height, a grid does), so each grid's rows are full.
 * The cards' own padding hangs outside the column, so each picture lines up with the heading and the wall, 12 px from
 * the next. `item`: more classes for the `i`th card (Apps places its cards beside and under the before/after).
 */
function Cards({
  items,
  className,
  xl = items.length,
  lg = xl,
  sm = lg,
  item,
}: {
  /** A card without a caption shows its description. */
  items: { card: HomeShowcase["effects"][number]["card"]; caption?: string }[];
  className: string;
  xl?: number;
  lg?: number;
  sm?: number;
  item?: (i: number) => string | false;
}) {
  return (
    <HomeRail className={cn("gap-0 scroll-px-2.5 max-sm:px-2.5 sm:-mx-1.5", className)}>
      {items.map(({ card, caption }, i) => (
        <div key={card.id} className={cn(RAIL_ITEM, i >= xl && "xl:hidden", i >= lg && "lg:max-xl:hidden", i >= sm && "sm:max-lg:hidden", item?.(i))}>
          <PresetCard preset={card} href={presetHref(card.id)} caption={caption} place={staggered(i)} sizes={CARD_SIZES} bare />
        </div>
      ))}
    </HomeRail>
  );
}

/** A preset row on Home: four full rows wherever it's a grid (six a row from xl, four from lg, three from sm). */
const ROWS = { xl: 24, lg: 16, sm: 12 };

/** Home's preset rows (Camera motions, Effects), for an area page that shows them the same way. */
export const PresetRail = Cards;

/**
 * The first pictures on the page: eight real covers, four on a phone. `label`: the section's name for screen readers;
 * `foot`: the line under it (Home's says where the previews were rendered; an area page has none).
 */
export function ShowcaseWall({
  wall,
  label = "What Fuobe makes",
  foot = true,
}: {
  wall: readonly { id: string; kind: string; caption: string; href: string; card: PresetCardData }[];
  label?: string;
  foot?: boolean;
}) {
  return (
    <section aria-label={label} className="mt-6 sm:mt-8">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:max-lg:grid-cols-2">
        {wall.map((t, i) => (
          <ShowcaseTile key={t.id} card={t.card} kind={t.kind} caption={t.caption} href={t.href} index={i} />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[12px] text-muted-foreground">
        <p className="min-w-0">
          {foot && (
            <>
              <span className="sm:hidden">Rendered locally on ComfyUI, on one RTX 5090.</span>
              <span className="max-sm:hidden">Every preview on this page was rendered locally on ComfyUI, on one RTX 5090.</span>
            </>
          )}
        </p>
        <PausePreviews />
      </div>
    </section>
  );
}

export function EffectsSection({ facts, effects }: Pick<HomeShowcase, "facts" | "effects">) {
  return (
    <section aria-labelledby="home-effects" data-reveal className={cn(SECTION, "[--cv:336px] sm:[--cv:951px] md:[--cv:1014px] lg:[--cv:1023px] xl:[--cv:930px]")}>
      <SectionHead
        id="home-effects"
        title="Effects"
        count={facts.effects}
        all="/effects"
        line="Add one photo and get the shot: storms, blooms, flares, floods."
      />
      <Cards items={effects} {...ROWS} className="sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" />
    </section>
  );
}

export function MotionsSection({ facts, motions }: Pick<HomeShowcase, "facts" | "motions">) {
  return (
    <section aria-labelledby="home-motions" data-reveal className={cn(SECTION, "[--cv:336px] sm:[--cv:935px] md:[--cv:1014px] lg:[--cv:1039px] xl:[--cv:930px]")}>
      <SectionHead
        id="home-motions"
        title="Camera motions"
        count={facts.motions}
        all="/motions"
        line="Moves a film crew would make: orbits, drone dives, crash zooms. Mix any two."
      />
      <Cards items={motions} {...ROWS} className="sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6" />
    </section>
  );
}

/**
 * Apps on Home: a before and after, and the apps whose clip wipes from one to the other. /apps opens on the same section
 * as its "Start here" (`start`): its own heading, no count and no "See all" (the page is all of them).
 *
 * From xl the cards take their places in the section's own grid of 36 columns (their row is `display: contents`
 * there): the before/after over 15 of them and two rows, three cards a row beside it (7 columns each), then a row of six
 * under both (6 each), as wide as the rows above and below the section. The cards' own padding sets the space between
 * them, so the grid has no gap of its own; the before/after keeps 16 px from the cards beside it. Under xl, the
 * before/after sits over the cards: four a row from lg, three from sm, a phone's rail.
 */
export function AppsSection({ facts, beforeAfter, reveals, start }: Pick<HomeShowcase, "facts" | "beforeAfter" | "reveals"> & { start?: { title: string; line: string } }) {
  const id = start ? "apps-start" : "home-apps";
  return (
    <section aria-labelledby={id} data-reveal className={cn(SECTION, "[--cv:676px] sm:[--cv:1384px] md:[--cv:1496px] lg:[--cv:1198px] xl:[--cv:719px]")}>
      {start ? (
        <SectionHead id={id} title={start.title} line={start.line} />
      ) : (
        <SectionHead id={id} title="Apps" count={facts.apps} all="/apps" line="One click changes one thing and keeps the rest." />
      )}
      <div className="grid grid-cols-1 gap-6 xl:-mx-1.5 xl:grid-cols-36 xl:gap-0">
        <div className="min-w-0 xl:col-span-15 xl:row-span-2 xl:pt-1.5 xl:pr-2.5 xl:pl-1.5">
          <BeforeAfter pairs={beforeAfter} />
        </div>
        <Cards
          items={reveals}
          className="self-start sm:grid-cols-3 lg:grid-cols-4 xl:contents"
          item={(i) => (i < 6 ? "xl:col-span-7" : "xl:col-span-6")}
        />
      </div>
    </section>
  );
}

/**
 * Live edit's moment: what it does and one way in, over a recorded session played as an editor with a rolling chat
 * (each change typed, sent and kept, its picture beside it). The player is the only island; it pauses off screen, and
 * nothing here reaches a GPU.
 */
export function LiveEditSection() {
  const points: [LucideIcon, string][] = [
    [Zap, "Live frames as you type, on your own GPU"],
    [TextCursorInput, "One sentence that keeps growing, always drawn on your original"],
    [Undo2, "Undo a change, or start fresh from the picture"],
  ];
  return (
    <section aria-labelledby="home-live" data-reveal className={cn(SECTION, "[--cv:1323px] sm:[--cv:1325px] md:[--cv:918px] lg:[--cv:987px] xl:[--cv:967px]")}>
      <div className="grid grid-cols-1 gap-x-10 gap-y-4 lg:grid-cols-12 lg:items-end">
        <div className="min-w-0 lg:col-span-5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-highlight px-2 py-0.5 text-[11px] font-semibold text-highlight-foreground">New · Live edit</span>
          <h2 id="home-live" className={cn(H2, "mt-3")}>
            {HOME_LIVE.title}
          </h2>
          <p className={LINE}>{HOME_LIVE.line}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between lg:col-span-7">
          <ul className="space-y-2 text-[14px]">
            {points.map(([Icon, t]) => (
              <li key={t} className="flex items-center gap-2.5">
                <Icon className="size-4 shrink-0 text-primary" />
                {t}
              </li>
            ))}
          </ul>
          <IntentLink href={HOME_LIVE.href} className="group inline-flex h-10 shrink-0 items-center gap-2 self-start rounded-full bg-primary px-5 text-[14px] font-medium text-primary-foreground transition hover:opacity-90 sm:self-end">
            Open Live edit <ArrowRight className="size-4 transition-transform duration-150 group-hover:translate-x-0.5" />
          </IntentLink>
        </div>
      </div>
      <LiveChatDemo className="mt-6" />
    </section>
  );
}

/** Heights of the Audio card's bars (0–1): a waveform drawn once, not a recording. */
const WAVE = [
  0.3, 0.45, 0.7, 0.5, 0.85, 1, 0.75, 0.55, 0.4, 0.6, 0.9, 0.7, 0.45, 0.3, 0.5, 0.8, 0.95, 0.65, 0.4, 0.55, 0.75, 0.5, 0.35, 0.6, 0.8, 0.55, 0.35, 0.25,
];
/** How many of the Audio card's tools it names where its card is narrowest (lg to xl, four cards a row). */
const AUDIO_NARROW = 3;

/**
 * Audio has no cover: its card shows a waveform that ripples on hover, and the studio's tools by name (each whole on
 * its line; fewer where the card is narrow). The link reads as its name and line, like its neighbours.
 */
function AudioCard({ href, label, line, tools }: { href: string; label: string; line: string; tools: HomeShowcase["audioTools"] }) {
  const total = tools.named.length + tools.more;
  return (
    <IntentLink href={href} className="group/studio flex min-w-0 flex-col gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <StudioPicture className="bg-media ring-1 ring-white/10">
        <div className="absolute inset-0 flex flex-col justify-center gap-[9%] px-[9%]">
          <div aria-hidden className="flex h-[38%] items-center gap-[2.5%]">
            {WAVE.map((h, i) => (
              <i
                key={i}
                className="flex-1 rounded-full bg-white/85 motion-safe:group-hover/studio:animate-wave-bar motion-safe:group-focus-visible/studio:animate-wave-bar"
                style={{ height: `${h * 100}%`, animationDelay: `${-i * 70}ms` }}
              />
            ))}
          </div>
          <p aria-hidden className="text-[12px] leading-snug text-white/70">
            {tools.named.map((t, i) => (
              <Fragment key={t}>
                <span className={cn("whitespace-nowrap", i >= AUDIO_NARROW && "lg:max-xl:hidden")}>{t}&nbsp;·</span>{" "}
              </Fragment>
            ))}
            <span className="whitespace-nowrap lg:max-xl:hidden">{tools.more} more</span>
            <span className="hidden whitespace-nowrap lg:max-xl:inline">{total - AUDIO_NARROW} more</span>
          </p>
        </div>
      </StudioPicture>
      <StudioName label={label} line={line} />
    </IntentLink>
  );
}

/**
 * A card with a picture drawn rather than a cover: Live edit's recorded session. Same frame,
 * name and line as a studio's card.
 */
function DrawnCard({ href, label, line, children }: { href: string; label: string; line: string; children: React.ReactNode }) {
  return (
    <IntentLink href={href} className="group/studio flex min-w-0 flex-col gap-2 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <StudioPicture className="bg-media ring-1 ring-white/10">{children}</StudioPicture>
      <StudioName label={label} line={line} />
    </IntentLink>
  );
}

/** A destination's card: a cover (a clip or a still), a drawn picture (Live edit's recorded session), or Audio's waveform. */
export interface Destination {
  href: string;
  label: string;
  line: string;
  card?: HomeShowcase["studios"][number]["card"];
  drawn?: "live";
}

/** A pill under the cards: its name, and its icon from the navigation. */
export interface DestinationPill {
  href: string;
  label: string;
  icon?: LucideIcon;
}

/**
 * Home's "Studios and tools" section, and each section of an area page (/create, /studios): a heading with its count,
 * one line, the cards (a phone's rail, two a row from sm, four from lg), then the rest as pills. More than eight pills
 * scroll sideways on a phone in a long row; eight or fewer wrap. `className`: the section's own spacing. `sm`: how
 * many of the rail's cards show from sm to lg (Home's: four rows of two), the rest on a phone and from lg.
 */
export function DestinationsSection({
  id,
  title,
  count,
  line,
  cards,
  audioTools,
  pills,
  pillsLabel,
  className,
  tap,
  grid,
  all,
  allCount,
  allNoun,
  after,
  auto,
  sm,
}: {
  id: string;
  title: string;
  count?: number;
  line: string;
  cards: Destination[];
  audioTools?: HomeShowcase["audioTools"];
  pills: DestinationPill[];
  pillsLabel: string;
  className?: string;
  /** Pills with a 44 px hit area (an area page; Home keeps its own). */
  tap?: boolean;
  /** Two cards a row on a phone instead of a rail (an area page, where every card should show at once). */
  grid?: boolean;
  /** "See all" beside the heading (SectionHead). */
  all?: string;
  allCount?: number;
  allNoun?: string;
  /** Pills only the viewer's island adds (the owner's), after the others. */
  after?: React.ReactNode;
  /** When the cards' clips play by themselves (StudioCard): Home's row, "always", like the preset rows above it. */
  auto?: AutoPlay;
  sm?: number;
}) {
  const items = cards.map((s, i) => (
    <div key={s.href} className={grid ? "min-w-0" : cn(RAIL_ITEM, sm !== undefined && i >= sm && "sm:max-lg:hidden")}>
      {s.card ? (
        <StudioCard
          href={s.href}
          label={s.label}
          line={s.line}
          card={s.card}
          zoom={!s.card.preview.video}
          place={staggered(i)}
          sizes={grid ? GRID_SIZES : STUDIO_SIZES}
          auto={auto}
        />
      ) : s.drawn === "live" ? (
        <DrawnCard href={s.href} label={s.label} line={s.line}>
          {/* A picture inside the link: its own controls stay out of reach (the card is one tap). */}
          <div inert className="absolute inset-0">
            <LiveDemo compact className="absolute inset-0 rounded-none" />
          </div>
        </DrawnCard>
      ) : audioTools ? (
        <AudioCard href={s.href} label={s.label} line={s.line} tools={audioTools} />
      ) : null}
    </div>
  ));
  return (
    <section aria-labelledby={id} className={className}>
      <SectionHead id={id} title={title} count={count} line={line} all={all} allCount={allCount} allNoun={allNoun} />
      {cards.length > 0 &&
        (grid ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-4 lg:grid-cols-4">{items}</div>
        ) : (
          <HomeRail className="gap-3 sm:grid-cols-2 sm:gap-x-3 sm:gap-y-4 lg:grid-cols-4">{items}</HomeRail>
        ))}
      {(pills.length > 0 || after) && (
        <>
          {/* A section of pills only needs no label of its own: its heading is it. */}
          {cards.length > 0 ? <h3 className="mt-6 mb-2 font-sans text-[13px] text-muted-foreground">{pillsLabel}</h3> : <h3 className="sr-only">{pillsLabel}</h3>}
          {/* A phone scrolls many pills sideways in three rows; a few wrap. */}
          <FadeRow>
            <ul className={cn("flex flex-wrap gap-1.5", pills.length > 8 && "max-sm:w-[72rem]")}>
              {pills.map((p) => {
                const Icon = p.icon;
                return (
                  <li key={p.href}>
                    <IntentLink href={p.href} className={cn(PILL, tap && PILL_TAP)}>
                      {Icon && <Icon className={PILL_ICON} />}
                      {p.label}
                    </IntentLink>
                  </li>
                );
              })}
              {after}
            </ul>
          </FadeRow>
        </>
      )}
    </section>
  );
}


export function StudiosSection({ facts, studios, audioTools, pills }: Pick<HomeShowcase, "facts" | "studios" | "audioTools" | "pills">) {
  return (
    <DestinationsSection
      id="home-studios"
      title="Studios and tools"
      count={facts.destinations}
      line="Whole productions, start to finish: films, ads, shoots and series. Open any of them to look around, no account needed."
      cards={studios}
      audioTools={audioTools}
      pills={pills.map((p) => ({ ...p, icon: navIcon(p.href) }))}
      pillsLabel="Also in Fuobe"
      all={area("studios").href}
      allCount={studioCount()}
      allNoun="studios"
      auto="always"
      sm={8}
      data-reveal className={cn(SECTION, "[--cv:529px] sm:[--cv:1526px] md:[--cv:1614px] lg:[--cv:1262px] xl:[--cv:1394px]")}
    />
  );
}

/**
 * Assist plans with the install's own AI, so only the studio's owner can use it (src/lib/guest-access.ts): everyone
 * else reads it as what they get on their own install, with the way to run one (AssistTag, AssistAction,
 * AssistExamples). Until the viewer is known, that's what shows.
 */
export function AssistSection({ facts, skills }: Pick<HomeShowcase, "facts" | "skills">) {
  const points: [LucideIcon, string][] = [
    [ListChecks, "Plans every step and prices it first"],
    [ScanEye, "Checks each result before the next step"],
    [Sparkles, `${facts.skills} built-in skills, projects and memory`],
    [CalendarClock, "Scheduled tasks, with a cost cap"],
    [Plug, "Works with your other tools"],
  ];
  return (
    <section aria-labelledby="home-assist" data-reveal className={cn(SECTION, "[--cv:912px] sm:[--cv:831px] md:[--cv:911px] lg:[--cv:562px] xl:[--cv:480px]")}>
      <div className="grid gap-8 rounded-2xl border bg-card p-5 sm:p-7 lg:grid-cols-2">
        <div className="min-w-0">
          <AssistTag />
          <h2 id="home-assist" className={H2}>
            Assist runs the whole job
          </h2>
          <p className={LINE}>
            Describe the job in one message. Assist picks the models, shows the plan and what it costs, and runs every step when you say go.
          </p>
          <ul className="mt-5 space-y-2.5">
            {points.map(([Icon, text]) => (
              <li key={text} className="flex items-center gap-2.5 text-[13px]">
                <Icon className="size-4 shrink-0 text-brand-text" />
                {text}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[12px] text-pretty text-muted-foreground">Plans with the AI you choose, online or on your own computer.</p>
          <AssistAction />
        </div>
        <AssistExamples prompts={[...ASSIST_SUGGESTIONS]} skills={skills} />
      </div>
    </section>
  );
}

const KIND_ICON: Record<string, LucideIcon> = { image: ImageIcon, video: Video, audio: AudioLines, model3d: Box };

export function OpenSourceSection({ facts, newModels }: Pick<HomeShowcase, "facts" | "newModels">) {
  const numbers = [
    { value: facts.openModels, label: "open-source models and tools", href: "/image" },
    { value: facts.workflows, label: "ComfyUI workflows to read, run and change", href: WORKFLOWS_ON_GITHUB, external: true },
    { value: facts.originals, label: "Fuobe Originals", href: "/apps" },
    { value: facts.presets, label: "presets: apps, camera motions and effects", href: "/effects" },
  ];
  return (
    <section aria-labelledby="home-open" data-reveal className={cn(SECTION, "[--cv:528px] sm:[--cv:494px] md:[--cv:571px] lg:[--cv:494px] xl:[--cv:363px]")}>
      <h2 id="home-open" className={H2}>
        Open source, all the way down
      </h2>
      <p className={cn(LINE, "max-w-[62ch]")}>
        The code is MIT-licensed. Every open model comes with its ComfyUI workflow, its files and its licence, and runs on your own GPU.
      </p>
      <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 rounded-2xl bg-muted/50 p-6 lg:grid-cols-4">
        {numbers.map((n) => {
          const inner = (
            <>
              <span className="block font-heading text-[34px] leading-none tabular-nums transition-colors group-hover:text-brand-text">{n.value}</span>
              <span className="mt-1.5 block text-[12px] leading-snug text-muted-foreground">{n.label}</span>
            </>
          );
          const cls = "group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring";
          return (
            <li key={n.label} className="min-w-0">
              {n.external ? (
                <a href={n.href} target="_blank" rel="noopener" className={cls}>
                  {inner}
                </a>
              ) : (
                <IntentLink href={n.href} className={cls}>
                  {inner}
                </IntentLink>
              )}
            </li>
          );
        })}
      </ul>
      {newModels.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 font-sans text-[13px] font-medium">Just added</h3>
          <FadeRow>
            <ul className="flex gap-1.5 max-sm:w-max sm:flex-wrap">
              {newModels.map((m) => {
                const Icon = KIND_ICON[m.kind] ?? Sparkles;
                return (
                  <li key={m.id}>
                    <IntentLink
                      href={m.href}
                      title={plainTagline(m.tagline)}
                      className="group inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors hover:bg-accent"
                    >
                      <Icon className="size-3.5 text-muted-foreground transition-colors group-hover:text-brand-text" />
                      {m.name}
                      <span className="text-muted-foreground">· {m.vendor}</span>
                    </IntentLink>
                  </li>
                );
              })}
            </ul>
          </FadeRow>
        </>
      )}
    </section>
  );
}

/** The README's own three lines. */
const COMMANDS = ["git clone https://github.com/workingprototype/fuobe.git && cd fuobe", "pnpm install", "pnpm dev"].join("\n");

export function StartSection() {
  return (
    <section aria-labelledby="home-start" data-reveal className={cn(SECTION, "[--cv:843px] sm:[--cv:726px] md:[--cv:748px] lg:[--cv:430px] xl:[--cv:427px]")}>
      <h2 id="home-start" className={H2}>
        Your GPU. Your models. Your files.
      </h2>
      <p className={LINE}>No account to look around. A free account to run. Your own server if you want all of it.</p>
      <div className="mt-6 grid gap-8 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <StartSteps />
        </div>
        <div className="min-w-0 rounded-2xl bg-media p-5 text-white ring-1 ring-white/10 lg:col-span-7">
          <p className="text-[15px] font-medium">Or run all of Fuobe yourself</p>
          <p className="mt-1 text-[13px] text-white/70">
            MIT licence. Your keys, settings and work stay on your machine.
          </p>
          <div className="mt-4 min-w-0 overflow-hidden rounded-xl bg-white/[0.04] ring-1 ring-white/10">
            <div className="flex items-center justify-between py-2 pr-2 pl-4">
              <span className="text-[12px] text-white/55">Terminal</span>
              <CopyCommand text={COMMANDS} />
            </div>
            {/* A phone wraps the lines, so the whole command shows; wider, a line too long scrolls, and a keyboard can reach it. */}
            <pre
              tabIndex={0}
              role="region"
              aria-label="Commands to run Fuobe"
              className="overflow-x-auto px-4 pb-4 font-mono text-[13px] leading-relaxed text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-inset max-sm:break-all max-sm:whitespace-pre-wrap"
            >
              <code>{COMMANDS}</code>
            </pre>
          </div>
          <p className="mt-3 text-[12px] text-white/70">
            On Windows, <code className="font-mono text-white/90">start.bat</code> installs and starts everything.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a
              href={FUOBE_REPO}
              target="_blank"
              rel="noopener"
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-4 text-[13px] font-medium text-black transition-colors hover:bg-white/90"
            >
              <GitHubMark className="size-3.5" /> View on GitHub
            </a>
            <a
              href={WORKFLOWS_ON_GITHUB}
              target="_blank"
              rel="noopener"
              className="inline-flex h-9 items-center rounded-full px-4 text-[13px] font-medium text-white ring-1 ring-white/20 transition-colors hover:bg-white/10"
            >
              ComfyUI workflows
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The footer's own pages; the code is on GitHub. */
const FOOTER_PAGES = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/settings/licences", label: "Thanks & licences" },
];

export function HomeFooter() {
  const link = "transition-colors hover:text-foreground";
  return (
    <footer className="mt-12 flex flex-wrap items-end justify-between gap-4 border-t pt-8 pb-4">
      <div>
        <p className="font-heading text-[22px] leading-none">Fuobe</p>
        <p className="mt-1.5 text-[12px] text-muted-foreground">Open source under the MIT licence.</p>
      </div>
      <nav aria-label="About Fuobe" className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
        {FOOTER_PAGES.map((i) => (
          <Link key={i.href} href={i.href} prefetch={false} className={link}>
            {i.label}
          </Link>
        ))}
        <a href={FUOBE_REPO} target="_blank" rel="noopener" className={link}>
          GitHub
        </a>
      </nav>
    </footer>
  );
}
