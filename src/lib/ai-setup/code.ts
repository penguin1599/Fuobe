/**
 * The setup code of "Set it up with my AI": 12 letters and digits in three groups (ABCD-EFGH-JKMN), from the 31
 * characters that can't be mistaken for each other (no I, L, O, 0 or 1). 31^12 is about 7.9e17 codes. Its three groups
 * keep it apart from Fuobe Connect's pairing code (two groups of four). Pure.
 */

export const SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const SETUP_CODE_LENGTH = 12;

/** One group of the code, for the path rules (src/lib/guest-access.ts). */
const G = "[A-HJKMNP-Z2-9]{4}";
/** A code as it may appear in a path: dashes or none, any case. */
export const SETUP_CODE_PATH = `${G}-?${G}-?${G}`;

/** A new code, without dashes. `randomInt(n)`: a whole number from 0 to n - 1 (crypto.randomInt on the server). */
export function newSetupCode(randomInt: (n: number) => number): string {
  let s = "";
  for (let i = 0; i < SETUP_CODE_LENGTH; i++) s += SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)];
  return s;
}

/** "abcd efgh-jkmn" → "ABCDEFGHJKMN" (the stored form), or null when it isn't a whole code. */
export function setupCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return new RegExp(`^[${SETUP_ALPHABET}]{${SETUP_CODE_LENGTH}}$`).test(s) ? s : null;
}

/** "ABCDEFGHJKMN" → "ABCD-EFGH-JKMN" (any form in: it is read with setupCode first). */
export function showCode(code: string): string {
  const s = setupCode(code) ?? code;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

/** What a screen reader says: "A B C D, E F G H, J K M N". */
export const spokenCode = (code: string) =>
  showCode(code)
    .split("-")
    .map((g) => g.split("").join(" "))
    .join(", ");
