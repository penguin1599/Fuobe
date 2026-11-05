"use client";

import { createElement } from "react";
import { navIcon } from "@/lib/nav-icons";
import type { MegaCover } from "@/lib/mega-menus";
import type { NavIconName } from "@/lib/nav-model";
import { cn } from "@/lib/utils";
import { useNavCover } from "./nav-ui";

/*
 * A nav cover: a real preset still in a box of fixed size, so nothing moves when the picture arrives. The box shows
 * the muted fill until then (and the entry's icon when the preset has no cover). Covers are decoration next to a
 * written name, so the image is alt="" and the box is hidden from assistive tech.
 */

export type CoverSize = "row" | "tile" | "lead" | "card" | "thumb" | "chip" | "pill" | "wide" | "tile16";

interface SizeSpec {
  /** The box (size, shape); a caller's className can override any of it. */
  box: string;
  /** The image's intrinsic size for its width/height attributes (posters are 512x384, thumbs 320x240). */
  w: number;
  h: number;
  /**
   * Which copy to load: the 96 px mini for the smallest boxes (the 320 px thumb where a cover has no mini), the 320 px
   * thumb for small boxes; fluid boxes pick by `sizes` between thumb and poster, or among the cover's larger copies
   * when it has them (MegaCover.hd).
   */
  src: "mini" | "thumb" | "both";
  /** The box's width for the srcset (a caller whose box is another width gives its own: CoverThumb's `sizes`). */
  sizes: string;
}

export const COVER_SIZES: Record<CoverSize, SizeSpec> = {
  /** 36x27: a launcher row, a search grid tile. */
  row: { box: "h-[27px] w-9 rounded-[6px]", w: 36, h: 27, src: "mini", sizes: "36px" },
  /** 56x56: the phone Studios sheet. */
  tile: { box: "size-14 rounded-[14px]", w: 56, h: 56, src: "mini", sizes: "56px" },
  /** 4:3, full width: a launcher column's lead card. */
  lead: { box: "aspect-[4/3] w-full rounded-[12px]", w: 512, h: 384, src: "both", sizes: "(min-width: 1024px) 272px, 72px" },
  /** 4:3, full width: a goal band's studio card. */
  card: { box: "aspect-[4/3] w-full rounded-[14px]", w: 512, h: 384, src: "both", sizes: "(min-width: 768px) 248px, 160px" },
  /** 64x48: a search result row. */
  thumb: { box: "h-12 w-16 rounded-[8px]", w: 64, h: 48, src: "thumb", sizes: "64px" },
  /** 56x42: a one-tap preset chip. */
  chip: { box: "h-[42px] w-14 rounded-[8px]", w: 56, h: 42, src: "thumb", sizes: "56px" },
  /** 40x40: a next-step pill. */
  pill: { box: "size-10 rounded-[10px]", w: 40, h: 40, src: "thumb", sizes: "40px" },
  /** 16:9, full width: the "next to try" card. */
  wide: { box: "aspect-video w-full rounded-[10px]", w: 512, h: 288, src: "both", sizes: "300px" },
  /** 16:9, full width: a ready-board tile (the Canvas menu's, 222 to 262 px; the phone sheet's): its caller gives `sizes`. */
  tile16: { box: "aspect-video w-full rounded-[10px]", w: 320, h: 180, src: "both", sizes: "262px" },
};

export function CoverThumb({
  id,
  cover: given,
  size,
  icon,
  eager,
  sizes: boxSizes,
  className,
}: {
  /** A preset id with a real cover (NavEntry.cover, a goal tap's preset); undefined shows the fallback. */
  id?: string;
  /** The cover itself, at its URLs (a fetched menu's), instead of a preset id. */
  cover?: MegaCover;
  size: CoverSize;
  /** Shown on the muted fill when there is no cover. */
  icon?: NavIconName;
  /** Load at once (a panel about to open) instead of when it comes near the screen. */
  eager?: boolean;
  /** A fluid box's width for the srcset, when it isn't its size's usual one (a lead card two tracks wide, a phone's tile). */
  sizes?: string;
  className?: string;
}) {
  const nav = useNavCover(given ? undefined : id);
  const cover: MegaCover | undefined = given ?? nav;
  const s = COVER_SIZES[size];
  const small = s.src === "mini" ? (cover?.mini ?? cover?.thumb) : cover?.thumb;
  const sizes = s.src === "both" ? (boxSizes ?? s.sizes) : undefined;
  // Its larger copies, where it has them (the Canvas menu's covers): AVIF first, else JPEG, the narrowest at least as
  // wide as the box on this screen, so a 2x or 3x screen never shows a copy stretched past its own pixels.
  const hd = sizes ? cover?.hd : undefined;
  // How the cover sits in a box of another shape (cover-framing.ts): a square keeps its top part by default, where faces are.
  const whole = cover?.framing?.fit === "whole";
  const still = cover && (
    // eslint-disable-next-line @next/next/no-img-element -- versioned static covers, sized by the box (no optimizer round trip)
    <img
      src={small}
      srcSet={hd ? hd.jpeg : sizes ? `${cover.thumb} 320w, ${cover.poster} 512w` : undefined}
      sizes={sizes}
      width={s.w}
      height={s.h}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      className="absolute inset-0 size-full object-cover"
      style={{ objectPosition: cover.framing?.focus ?? "50% 25%" }}
    />
  );
  const img = hd ? (
    <picture>
      <source type="image/avif" srcSet={hd.avif} sizes={sizes} />
      {still}
    </picture>
  ) : (
    still
  );
  return (
    <span aria-hidden data-cover={cover ? (id ?? "") : undefined} className={cn("relative block shrink-0 overflow-hidden bg-muted", s.box, className)}>
      {cover && whole ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- the same small copy, blurred behind the whole picture */}
          <img src={small} alt="" loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} className="absolute inset-0 size-full scale-125 object-cover blur-md brightness-[0.7] saturate-[1.3]" />
          <span className="absolute inset-0 grid place-items-center [container-type:size]">
            <span className="relative aspect-[4/3] w-[min(100cqw,133.334cqh)] overflow-hidden">{img}</span>
          </span>
        </>
      ) : cover ? (
        img
      ) : icon ? (
        <NavIcon name={icon} className="absolute inset-0 m-auto size-[42%] max-h-6 max-w-6 text-muted-foreground" />
      ) : null}
    </span>
  );
}

/** A model icon by name (NavEntry.icon), decorative. */
export function NavIcon({ name, className }: { name: NavIconName; className?: string }) {
  return createElement(navIcon(name), { "aria-hidden": true, className });
}
