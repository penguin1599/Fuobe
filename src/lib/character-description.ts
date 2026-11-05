/**
 * "Describe my character" (Genjutsu's Character swap): a describer's answer made into the character's description. The
 * site's AI helper answers at once; the GPU describer (Qwen3-VL 8B in ComfyUI, workflow character-describe-qwen3vl) is a
 * run whose text the page reads when it is done. Both go through the same tidy-up here, in the server and the browser.
 */
import { CHARACTER_SWAP } from "@/lib/catalog/character-swap";

/** The GPU describer's catalog model (src/lib/catalog/models.ts) and its workflow. */
export const CHARACTER_DESCRIBER = "oss-character-describe";
export const CHARACTER_DESCRIBE_WORKFLOW = "character-describe-qwen3vl";

/** Files the describer reads by their name: a picture. Anything else is refused before it runs. */
export const DESCRIBE_PICTURE = /\.(png|jpe?g|webp)$/i;

/** A part of the sentence that only says what isn't there ("no visible jewellery", "without a hat"). */
const NOTHING = /^(?:(?:and|with|but)\s+)*(?:no|without)\s/i;
/** The same at the end of a part: "a square face with dark eyes and no beard". */
const NOTHING_AFTER = /\s+(?:and|with|but)\s+(?:no|without)\s[^,;]*$/i;

/**
 * One plain line: the first paragraph, no label ("Description:"), Markdown, quotes or closing full stop, nothing said
 * about what the character doesn't have (a prompt names only what it wants), starting lower case so it reads inside the
 * swap's sentences ("The character: a woman in her late twenties…"), at most the field's length. Empty when nothing is
 * left.
 */
export function cleanDescription(answer: string | null | undefined, max: number = CHARACTER_SWAP.maxDescriptionChars): string {
  const first = (answer ?? "")
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/^["“'\s]+|["”'\s]+$/g, "")
    .replace(/^(?:the\s+)?(?:character(?:\s+description)?|description)\s*:\s*/i, "")
    .replace(/[.\s]+$/, "");
  const parts = first
    .split(/\s*[,;]\s*/)
    .map((p) => p.replace(NOTHING_AFTER, "").trim())
    .filter((p) => p && !NOTHING.test(p));
  const text = parts.join(", ").replace(/^(an?)\s/i, (_, a: string) => `${a.toLowerCase()} `);
  return text.slice(0, max).replace(/[,.\s]+$/, "").trim();
}
