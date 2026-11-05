/**
 * How a preset cover sits in a frame of another shape. Every preset cover is 4:3, and a few tiles aren't: the Mixed
 * Media looks are 4:5, the Canvas templates 16:9, the navigation's tiles and pills square. Such a tile fills its frame
 * from the cover's centre, which loses the edges; for a cover whose subject isn't centred, or spans the whole frame,
 * that cuts it. Hand-kept, keyed by the preset id whose cover it is (preset-covers.generated.ts): it holds wherever
 * that cover shows, the preset's own card, a template tile that shows its cover (peak/), a picker's small copy
 * (thumbs/) or a nav tile. A frame of the cover's own shape shows it whole, whatever is set here.
 *
 * - `focus`: the point of the cover kept in view (CSS object-position, "x% y%"), for a subject off centre.
 * - `fit: "whole"`: the whole cover, centred, over a blurred and darkened copy of itself filling the frame: for a
 *   picture whose content reaches its edges (a car crossing the frame, panels side by side), until it has a cover of
 *   the tile's shape.
 */
export interface CoverFraming {
  focus?: `${number}% ${number}%`;
  fit?: "whole";
}

export const COVER_FRAMING: Record<string, CoverFraming> = {
  // Mixed Media looks (4:5): the subject off centre.
  "effect-comic": { focus: "5% 50%" },
  "effect-akrill": { focus: "80% 50%" },
  "effect-paper": { focus: "40% 50%" },
  "effect-particles": { focus: "40% 50%" },
  // Mixed Media looks (4:5): content across the whole width.
  "effect-tracking": { fit: "whole" },
  "effect-windows": { fit: "whole" },
  "effect-multiverse": { fit: "whole" },
  // Canvas templates (16:9): the top of the subject.
  "effect-agamemnon": { focus: "50% 0%" },
  "effect-dolphin-ride": { focus: "50% 30%" },
  "effect-pearl-earring": { focus: "50% 0%" },
  // Canvas templates (16:9): the lower part (the person, the dog and both boards; the sky is let go).
  "effect-skatedog": { focus: "50% 80%" },
  // The navigation's square tiles and pills: a reference inset at the right, a lineup across the frame.
  "app-steal-the-look": { focus: "80% 25%" },
  "app-outfit-swap": { focus: "85% 25%" },
  "app-character-swap": { focus: "85% 25%" },
  "app-ai-influencer": { focus: "13% 25%" },
  // Kinetic Motion's square tile: the whole title at the left, with the model beside it.
  "kinetic-runway-titles": { focus: "0% 50%" },
};

/** The preset id of a preset cover's URL: its poster, peak frame or small copy (with or without its version). */
const PRESET_COVER = /^\/previews\/presets\/(?:peak\/)?(?:thumbs\/|mini\/)?([a-z0-9-]+)\.(?:jpg|mp4)(?:\?|$)/;

/** A cover's framing by its URL (a still or a clip), or undefined: a cover of the tile's shape, or one centred. */
export function coverFraming(url: string | undefined): CoverFraming | undefined {
  const id = url && PRESET_COVER.exec(url)?.[1];
  return id && Object.hasOwn(COVER_FRAMING, id) ? COVER_FRAMING[id] : undefined;
}
