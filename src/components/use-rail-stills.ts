"use client";

import { useEffect, type RefObject } from "react";

/** How near the screen a row is when its stills start loading: a screen's height above or below it. */
export const RAIL_STILLS_MARGIN = "100% 0px";

/**
 * A row of cards that scrolls sideways on a phone (HomeRail): every card's still loads once the row comes within a
 * screen of view, not one by one as each card slides in. A browser loads a lazy picture only when the picture nears the
 * screen, and a card waiting at the side of a row is cut off by the row, so its still was asked for only once the card
 * was already showing, blank. A card hidden at this width (display: none) loads nothing; one shown later (the screen
 * turned or grew) loads then, as the row's size changes. Where the row is a grid (from sm up: it doesn't scroll), each
 * still loads as its own card nears the screen, so the lower rows of a tall grid wait until they're reached.
 */
export function useRailStills(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const rail = ref.current;
    if (!rail || typeof IntersectionObserver === "undefined") return;
    let near = false;
    const load = () => {
      if (!near || getComputedStyle(rail).overflowX === "visible") return;
      for (const img of rail.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')) if (img.getClientRects().length) img.loading = "eager";
    };
    const io = new IntersectionObserver(
      (entries) => {
        near = entries[entries.length - 1].isIntersecting;
        load();
      },
      { rootMargin: RAIL_STILLS_MARGIN },
    );
    io.observe(rail);
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(load);
    ro?.observe(rail);
    return () => {
      io.disconnect();
      ro?.disconnect();
    };
  }, [ref]);
}
