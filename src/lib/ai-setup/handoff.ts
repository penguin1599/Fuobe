/**
 * The hand-offs of "Set it up with my AI": the short message that opens ChatGPT or Claude with it typed in, the one
 * command for a coding agent on this computer, and the full instructions to copy for any other AI. They carry only the
 * studio's address, the guide and status addresses, the system and browser names, and the setup code (read-only,
 * short-lived and revocable): never an email, a session, a key, a tunnel address, a port or a GPU name. Pure.
 */
import { SAFE_ORIGIN } from "@/lib/comfy-install";
import { showCode } from "./code";
import { withCode } from "./guide";
import { BROWSER_LABEL, onMyComputer, type BrowserName, type Os, type Way } from "./ways";

export interface HandoffInput {
  way: Way;
  os: Os;
  site: string;
  code: string;
  browser: BrowserName;
  /** The person is on a phone: every command runs on the computer. */
  phone?: boolean;
}

/** Where "Open in ChatGPT" and "Open in Claude" go. Either can be switched off here if its link stops working. */
export const AI_TARGETS = {
  chatgpt: { label: "ChatGPT", base: "https://chatgpt.com/", param: "q", on: true },
  claude: { label: "Claude", base: "https://claude.ai/new", param: "q", on: true },
} as const;
export type AiTarget = keyof typeof AI_TARGETS;

/** The longest message a link carries, and the longest link. */
export const PREFILL_MAX = 900;
export const LINK_MAX = 2000;

const hostOf = (site: string) => new URL(site).host;

/** The message a chat opens with. */
export function prefillText(i: HandoffInput): string {
  const code = showCode(i.code);
  const steps = `Steps: ${i.site}/api/setup/guide/${i.way}/${i.os}`;
  const first =
    i.way === "address"
      ? `Please help me give the ComfyUI ${onMyComputer(i.os)} a web address for Fuobe (${hostOf(i.site)}), so Fuobe can run on my own GPU.${i.phone ? " I am on my phone now, so every command runs on the computer." : ` I use ${BROWSER_LABEL[i.browser]}.`}`
      : `Please help me connect ComfyUI ${onMyComputer(i.os)} to Fuobe (${hostOf(i.site)}), so Fuobe can run on my own GPU. I use ${BROWSER_LABEL[i.browser]}.`;
  const core = [first, steps, `My setup code: ${code}`, `Fuobe's status for it: ${i.site}/api/setup/${code}`, "Read the steps first. Then guide me one step at a time. Show me each command and wait for my OK before it runs."];
  // Kept while the message stays short (a long studio address leaves less room).
  const extra = ["If you can't open links, tell me and I will paste the steps.", ...(i.way === "address" ? ["The web address cloudflared makes works like a key: help me put it into Fuobe, not into this chat."] : [])];
  let text = core.join("\n");
  for (const e of extra) if (text.length + 1 + e.length <= PREFILL_MAX) text += `${e.startsWith("If") ? " " : "\n"}${e}`;
  return text;
}

/** The link that opens a chat with the message typed in. */
export function chatLink(target: AiTarget, text: string): string {
  const t = AI_TARGETS[target];
  return `${t.base}?${t.param}=${encodeURIComponent(text)}`;
}

/** The coding agents with a one-line command. Cursor repeats a prompt given this way, so it gets Copy instructions. */
export const AGENTS = {
  claude: { label: "Claude Code", command: "claude" },
  codex: { label: "Codex", command: "codex" },
  gemini: { label: "Gemini CLI", command: "gemini -i" },
} as const;
export type Agent = keyof typeof AGENTS;
export const isAgent = (v: unknown): v is Agent => typeof v === "string" && Object.hasOwn(AGENTS, v);

/** What goes inside the command's quotes: only letters, digits, spaces and . , : / - (it runs the same in bash, zsh, PowerShell and cmd). */
export const AGENT_TEXT_CHARS = /^[A-Za-z0-9 .,:/-]+$/;

export function agentText(i: Omit<HandoffInput, "browser" | "phone">): string {
  if (!SAFE_ORIGIN.test(i.site)) throw new Error("That isn't a site address");
  const curl = i.os === "windows" ? "curl.exe" : "curl";
  const text = `Help me connect my ComfyUI to Fuobe. Use ${curl} to read ${i.site}/api/setup/guide/${i.way}/${i.os} and follow it. My setup code is ${showCode(i.code)}. Show me each command and ask before you run it.`;
  if (!AGENT_TEXT_CHARS.test(text)) throw new Error("The command can only hold plain characters");
  return text;
}

/** The one line for a coding agent: claude "…", codex "…" or gemini -i "…". */
export const agentLine = (agent: Agent, i: Omit<HandoffInput, "browser" | "phone">) => `${AGENTS[agent].command} "${agentText(i)}"`;

/** Copy instructions: the message's first line, how to go, then the whole guide with the code filled in. */
export function fullInstructions(i: HandoffInput, guide: string): string {
  const first = prefillText(i).split("\n")[0];
  return [first, "Guide me one step at a time. Show me each command and wait for my OK before it runs.", "", withCode(guide, i.code, i.site, i.browser)].join("\n");
}
