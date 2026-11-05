import type { LucideIcon } from "lucide-react";
import { navIcon } from "@/lib/nav-icons";
import { entry, type NavEntry } from "@/lib/nav-model";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shorter label for compact groups (the full one is the tooltip). */
  short?: string;
  /** Prefetched as soon as it's on screen (the rows most visits start from); the others wait for a hover or touch. */
  eager?: boolean;
  /** More words search matches ("tts" finds Audio). */
  keywords?: string;
}

export interface NavGroupDef {
  label: string;
  items: NavItem[];
  /** Can be folded away. */
  collapsible?: boolean;
  /** Two small items per row. */
  compact?: boolean;
}

/**
 * The places to create, the library, the studios and settings as four groups, in a fixed order (Home's
 * showcase reads Create and Studios). Labels, links and search words come from the navigation model
 * (src/lib/nav-model.ts); only the grouping and the order are kept here.
 */
const GROUPS: { label: string; ids: string[]; collapsible?: boolean }[] = [
  {
    label: "Create",
    ids: ["home", "assist", "image", "video", "edit", "live-edit", "layers", "inpaint", "color-grade", "motions", "effects", "storyboard", "canvas", "apps"],
  },
  { label: "Library", ids: ["library", "favorites"] },
  {
    label: "Studios",
    ids: [
      "cinema",
      "shorts",
      "mixed-media",
      "marketing",
      "ads",
      "kinetic",
      "moodboards",
      "photodump",
      "fashion-factory",
      "character-sheet",
      "influencer",
      "faceless",
      "content-factory",
      "explainer",
      "lipsync",
      "genjutsu",
      "character-swap",
      "motion-control",
      "video-edit",
      "extend",
      "reframe",
      "video-tools",
      "elements",
      "upscale",
      "audio",
      "katana",
      "image-to-3d",
      "virality",
    ],
    collapsible: true,
  },
  { label: "More", ids: ["settings"], collapsible: true },
];

/** A shorter label where a row is narrow ("Character swap"); the phone tiles use the model's own `short`. */
const ROW_SHORT: Record<string, string> = { "character-swap": "Character swap" };

const item = (e: NavEntry): NavItem => ({
  href: e.href,
  label: e.label,
  icon: navIcon(e.icon),
  ...(ROW_SHORT[e.id] && { short: ROW_SHORT[e.id] }),
  ...(e.eager && { eager: true }),
  keywords: e.keywords,
});

export const NAV: NavGroupDef[] = GROUPS.map((g) => ({
  label: g.label,
  items: g.ids.map((id) => {
    const e = entry(id);
    if (!e) throw new Error(`The navigation model has no ${id}`);
    return item(e);
  }),
  ...(g.collapsible && { collapsible: true }),
}));
