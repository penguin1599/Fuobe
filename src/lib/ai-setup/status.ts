/**
 * The public status of one setup (GET /api/setup/<code>), as JSON and as plain text: the steps, the port and the kind of
 * install, and the next step. It never holds the account, its email, a run, a key, an address, a token, a file name or
 * the GPU's name: only the keys below, filled from fixed tables, fixed words and whole numbers (a test enforces it).
 * The text form is ASCII. Pure.
 */
import { showCode } from "./code";
import type { InstallKind, SetupView } from "./facts";
import { nextOf, TAB_QUIET_MS, type NextStep } from "./next-step";
import { isDone, stepsOf, type Step } from "./steps";
import { OS_NAME, type Os, type Way } from "./ways";

export const STATUS_ABOUT = "Fuobe's view of one ComfyUI setup. Check each step with the person before you run anything.";

export interface PublicStatus {
  fuobe_setup: 1;
  about: string;
  code: string;
  state: "working" | "done";
  way: Way;
  computer: Os;
  fuobe_open: boolean;
  /** Seconds since the Fuobe tab last looked (null: it hasn't yet). */
  fuobe_looked_s_ago: number | null;
  steps: Step[];
  port: number | null;
  install: InstallKind | "unknown";
  next: NextStep;
  check_again: string;
  /** The status again, with a part no cache has seen: an AI's web tool may open it, because this answer gave it. */
  check_again_url: string;
  expires_in_s: number;
}

/** The only keys a status may have (tests/ai-setup-status.test.ts). */
export const PUBLIC_KEYS = [
  "fuobe_setup",
  "about",
  "code",
  "state",
  "way",
  "computer",
  "fuobe_open",
  "fuobe_looked_s_ago",
  "steps",
  "port",
  "install",
  "next",
  "check_again",
  "check_again_url",
  "expires_in_s",
] as const;

export interface StatusInput extends SetupView {
  code: string;
  expiresAt: number;
  /** A few random characters for check_again_url. */
  fresh: string;
}

export function toPublic(s: StatusInput, now: number): PublicStatus {
  const t = s.tab;
  const open = !!t && now - s.tabAt <= TAB_QUIET_MS;
  const code = showCode(s.code);
  return {
    fuobe_setup: 1,
    about: STATUS_ABOUT,
    code,
    state: isDone(s) ? "done" : "working",
    way: s.way,
    computer: s.os,
    fuobe_open: open,
    fuobe_looked_s_ago: t ? Math.max(0, Math.round((now - s.tabAt) / 1000)) : null,
    steps: stepsOf(s),
    port: s.way !== "address" && t?.port ? t.port : null,
    install: (s.way !== "address" && t?.install) || "unknown",
    next: nextOf(s, now),
    check_again: "Open check_again_url after each step. Each answer gives a new one, so no cache shows an old answer.",
    check_again_url: `${s.site}/api/setup/${code}?r=${s.fresh}`,
    expires_in_s: Math.max(0, Math.round((s.expiresAt - now) / 1000)),
  };
}

const WAY_WORDS: Record<Way, string> = { direct: "this browser (direct)", address: "a web address (address)", connect: "Fuobe Connect (connect)" };

/** Non-ASCII from a shared table (an arrow, a typographic quote) as plain ASCII. */
export const ascii = (s: string) =>
  s
    .replaceAll("→", "->")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replaceAll("…", "...")
    .replace(/[–—]/g, "-")
    .replace(/[^\x00-\x7f]/g, "");

export function toText(p: PublicStatus): string {
  const lines = [
    `Fuobe setup status for code ${p.code}. ${p.about}`,
    `Way: ${WAY_WORDS[p.way]}, on ${OS_NAME[p.computer] ? `a ${OS_NAME[p.computer]} computer` : "a computer"}`,
    p.fuobe_looked_s_ago === null ? "Fuobe tab: not seen yet" : `Fuobe tab: ${p.fuobe_open ? "open" : "not seen lately"}, looked ${p.fuobe_looked_s_ago} s ago`,
    ...p.steps.map((s) => `[${s.state}] ${s.label}${s.detail ? `: ${s.detail}` : ""}`),
    `Next step: ${p.next.say}`,
    ...(p.next.how.length ? ["How:", ...p.next.how.map((h) => `- ${h}`)] : []),
    `Guide: ${p.next.guide}`,
    `Check again: open ${p.check_again_url} after each step. Each answer gives a new address, so no cache shows an old answer.`,
    `This code ends in ${Math.max(1, Math.round(p.expires_in_s / 60))} min unless the Fuobe tab stays open.`,
  ];
  return ascii(lines.join("\n")) + "\n";
}

/** Every code that isn't active (unknown, ended, stopped): one answer, so nothing can be learnt from it. */
export const NOT_ACTIVE = {
  fuobe_setup: 1,
  state: "not_active",
  next: { id: "new-code", say: "This setup code is not active. It ended, or the person stopped it. Ask the person for the code Fuobe shows now." },
} as const;

export const notActiveText = () => `Fuobe setup status: ${NOT_ACTIVE.next.say}\n`;

/** A code in the wrong shape. */
export const BAD_CODE = "A setup code has 12 letters and digits, like ABCD-EFGH-JKMN.";
