/**
 * Covers that belong to a studio rather than to a preset: one of the studio's own examples, cut into a cover by the
 * same pipeline as a preset's (pnpm eval:covers --from-masters, gen-preset-peaks, gen-preset-hd) and listed with them
 * under its own id (preset-covers.generated.ts, preset-previews.generated.ts). Home's card for the studio, its entry
 * in the menus, its next step under a result and the studio's own row of examples (studio-examples.ts) show it. Each
 * names its card as a preset's would; no preset has the same id. Pure data, so the server and the browser share it.
 */
export interface StudioCover {
  /** The card's name, as a preset card's (its alt text and tooltip). */
  name: string;
  /** What the clip shows, in a sentence. */
  description: string;
  /** The studio it belongs to. */
  category: string;
  /** A key of PRESET_ICONS (src/components/preset-icons.ts). */
  icon: string;
  /**
   * Where its card opens in a row of examples: its studio, in the mode that made it, with that example in view when it is
   * one of the studio's examples (src/lib/examples/plan.json).
   */
  href: string;
}

export const STUDIO_COVERS: Record<string, StudioCover> = {
  // Genjutsu's Character swap example (genjutsu-character.1): a couple on stone steps, both people swapped in one take.
  "genjutsu-group-swap": {
    name: "Group swap",
    description: "Two people swapped in one take: the kiss on the cheek, the laugh and the light stay as filmed.",
    category: "Genjutsu",
    icon: "Users",
    href: "/genjutsu?mode=character&example=genjutsu-character.1",
  },
  // Home's Genjutsu card: a character swap by a lake shown as it happens. The original take, then a divider sweeps the
  // swapped one in across it, the two in step frame for frame, with "Original" and "Swapped" in the picture either side
  // of the divider; it fades to dark before it loops, so two faces never blend. The clip of the first screen's Genjutsu
  // tile (scripts/gen-home-bento.mjs, "genjutsu-lakeside"), with its labels drawn into the frame.
  "genjutsu-lake-swap": {
    name: "Character swap",
    description: "One man swapped for another in the same take: the walk, the turn of the head and the lakeside light stay as filmed.",
    category: "Genjutsu",
    icon: "UserRound",
    href: "/genjutsu?mode=character",
  },
  // Home's and the menus' Kinetic Motion card: Runway Titles drawn by Kinetic itself at the card's own 4:3 shape (no
  // model, no GPU). It opens on the finished piece, "GOLDEN HOUR" with "Spring" in script over the gold gown in a
  // Marrakech courtyard; a light sweeps across the title, the words dissolve, then cut in again letter by letter as
  // the photo pushes in, and the script draws itself on. The loop ends on the frame it starts with.
  "kinetic-runway-titles": {
    name: "Runway Titles",
    description: "A giant title cuts in letter by letter over a full-bleed fashion photo, with a script word drawn on.",
    category: "Kinetic",
    icon: "LetterText",
    href: "/kinetic?scene=lookbook",
  },
};

/** Whether an id is a studio's cover (not a preset's). */
export const isStudioCover = (id: string) => Object.hasOwn(STUDIO_COVERS, id);
