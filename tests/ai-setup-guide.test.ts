import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { guideText, withCode, type GuideModel } from "@/lib/ai-setup/guide";
import { agentLine, agentText, AI_TARGETS, chatLink, fullInstructions, LINK_MAX, PREFILL_MAX, prefillText } from "@/lib/ai-setup/handoff";
import { MODEL_STEP } from "@/lib/ai-setup/next-step";
import { OSES, type Os, type Way } from "@/lib/ai-setup/ways";
import { GUARD_SHA256, GUARD_SOURCE } from "@/lib/comfy-guard";
import { LIVE_NODES_SHA256, LIVE_NODES_SOURCE } from "@/lib/comfy-live-nodes";

/**
 * "Set it up with my AI": the steps an AI follows and the hand-offs that carry them. Every guide is ASCII, names only
 * --enable-cors-header <this site>, keeps the safety rules, checks Fuobe's files by their SHA-256, and its Windows
 * commands run the same from PowerShell and through powershell.exe -Command (no $, no braces).
 */
const SITE = "https://fuobe.com";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const MODELS: GuideModel[] = [
  { name: "Z-Image Turbo", fits: "for a GPU with 12 GB or more", files: [{ file: "z_image_turbo_bf16.safetensors", folder: "diffusion_models", url: "https://huggingface.co/x/resolve/main/z.safetensors", sizeGb: 12.31 }] },
  { name: "SDXL", fits: "for a GPU with 8 GB or more", files: [{ file: "sd_xl_base_1.0.safetensors", folder: "checkpoints", url: "https://huggingface.co/y/resolve/main/s.safetensors?download=true", sizeGb: 6.94 }] },
];
const WAYS: Way[] = ["direct", "address"];
const guides = WAYS.flatMap((way) => OSES.map((os) => ({ way, os, text: guideText({ way, os, site: SITE, models: MODELS }) })));
const commands = (text: string) => text.split("\n").filter((l) => /^ {3}\S/.test(l));

describe("the guide", () => {
  it("checks Fuobe's files by the hash of the very files Fuobe serves", () => {
    expect(GUARD_SHA256).toBe(sha(GUARD_SOURCE));
    expect(LIVE_NODES_SHA256).toBe(sha(LIVE_NODES_SOURCE));
    for (const g of guides.filter((g) => g.way === "direct" && g.os !== "other")) {
      expect(g.text).toContain(GUARD_SHA256);
      expect(g.text).toContain(LIVE_NODES_SHA256);
      expect(g.text).toContain(`${SITE}/api/setup/files/fuobe_guard.py`);
    }
  });

  it("is ASCII, and every command names only this site's setting", () => {
    for (const g of guides) {
      expect(g.text, `${g.way}/${g.os}`).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
      for (const line of g.text.split("\n")) {
        if (!line.includes("--enable-cors-header")) continue;
        // The only lines that name the setting without this site: the rules that forbid it.
        if (/^\d\. (Never use --enable-cors-header \*|This way needs no new ComfyUI setting)/.test(line)) continue;
        expect(line, `${g.way}/${g.os}`).toMatch(new RegExp(`--enable-cors-header ${SITE.replace(/[.]/g, "[.]")}(\\s|$)`));
      }
    }
    const direct = guides.filter((g) => g.way === "direct" && g.os !== "other");
    for (const g of direct) expect(g.text).toContain(`2. Use exactly this setting: --enable-cors-header ${SITE}`);
  });

  it("keeps the safety rules: ask first, no --listen, no open ports, the address is a key", () => {
    for (const g of guides.filter((g) => g.os !== "other")) {
      expect(g.text).toContain("Before each command, show it and say in one line what it does. Wait for the person to say yes.");
      expect(g.text).toContain("Do not open ports in a firewall or a router.");
      expect(g.text).toContain("Never use --listen.");
      // --listen appears only in its rule.
      expect(g.text.split("\n").filter((l) => l.includes("--listen")).every((l) => /Never use --listen/.test(l))).toBe(true);
      expect(g.text).toContain("Use the setup code only with the status address.");
    }
    for (const g of guides.filter((g) => g.way === "address" && g.os !== "other")) {
      expect(g.text).toContain("The web address works like a key.");
      expect(g.text).toContain("Do not run cloudflared login");
      // The address is never printed or tested from the agent: it goes to the clipboard.
      expect(g.text).toMatch(/Set-Clipboard|pbcopy|xclip/);
      expect(g.text).not.toMatch(/<address>\/system_stats/);
      expect(g.text).toMatch(/Stop-Process -Id \(Get-Content fuobe-tunnel\.pid\)|pkill -f fuobe-tunnel\.log/);
      // Only this tunnel: never every cloudflared the person runs.
      expect(g.text).not.toMatch(/Stop-Process -Name cloudflared|pkill -f "cloudflared tunnel --url"/);
      // An old log can't give a dead address.
      expect(g.text).toMatch(/Remove-Item fuobe-tunnel\.log|rm -f \/tmp\/fuobe-tunnel\.log/);
    }
  });

  it("Windows commands have no $ and no braces, so they also run through powershell.exe -Command", () => {
    for (const g of guides.filter((g) => g.os === "windows")) {
      for (const line of commands(g.text)) {
        if (!/^ {3}(curl\.exe|Get-|Start-Process|Select-String|Remove-Item|Stop-Process|certutil|winget|cloudflared)/.test(line)) continue;
        expect(line.replace("%{http_code}", ""), line).not.toMatch(/[$`{}]/);
      }
      expect(g.text).toContain("winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements".repeat(g.way === "address" ? 1 : 0));
      expect(g.text).toContain("powershell.exe -NoProfile -Command");
    }
  });

  it("finds ComfyUI by its port on Windows, and starts a portable one with Fuobe's start file", () => {
    const g = guides.find((x) => x.way === "direct" && x.os === "windows")!.text;
    expect(g).toContain("Get-NetTCPConnection -LocalPort 8188 -State Listen | Select-Object -ExpandProperty OwningProcess");
    expect(g).toContain(`${SITE}/api/setup/files/start/8188`);
    expect(g).toContain("ask the person to answer Y");
    expect(g).not.toMatch(/Where-Object/);
  });

  it("has the steps the status points to, from installing ComfyUI to the first model", () => {
    for (const g of guides.filter((g) => g.os !== "other")) {
      expect(g.text).toContain("## Step 0:");
      expect(g.text).toContain("https://www.comfy.org/download".repeat(g.os === "linux" ? 0 : 1));
      expect(g.text).toContain(`## Step ${MODEL_STEP[g.way]}: Get a first picture model`);
      expect(g.text).toContain("sd_xl_base_1.0.safetensors");
      expect(g.text).toContain("--create-dirs");
      expect(g.text).toContain("check_again_url");
      expect(g.text).not.toMatch(/\?n=2/);
    }
    const other = guides.find((x) => x.way === "direct" && x.os === "other")!.text;
    expect(other).toContain(`${SITE}/api/setup/guide/direct/windows`);
  });

  it("fills in the code and keeps only the person's browser for Copy instructions", () => {
    const g = guideText({ way: "direct", os: "windows", site: SITE });
    const filled = withCode(g, "ABCDEFGHJKMN", SITE, "firefox");
    expect(filled).toContain(`Status: ${SITE}/api/setup/ABCD-EFGH-JKMN`);
    expect(filled).not.toContain("<setup code>");
    expect(filled).toContain("Firefox: click the icon");
    expect(filled).not.toContain("Chrome or Edge: click");
    expect(filled).not.toContain("Brave: click");
  });
});

describe("the hand-offs", () => {
  const longest = `https://${"a".repeat(63)}.${"b".repeat(40)}.example:65535`;
  it("keep the message under 900 characters and the link under 2,000, for a long site address", () => {
    for (const site of [SITE, longest])
      for (const way of WAYS)
        for (const os of OSES as Os[])
          for (const phone of [false, true]) {
            const text = prefillText({ way, os, site, code: "ABCDEFGHJKMN", browser: "chrome", phone });
            expect(text.length, `${site} ${way} ${os}`).toBeLessThanOrEqual(PREFILL_MAX);
            for (const t of Object.keys(AI_TARGETS) as (keyof typeof AI_TARGETS)[]) expect(chatLink(t, text).length).toBeLessThanOrEqual(LINK_MAX);
          }
  });

  it("carry the guide and status addresses and the code, and nothing of the account", () => {
    const text = prefillText({ way: "direct", os: "windows", site: SITE, code: "abcd-efgh-jkmn", browser: "edge" });
    expect(text).toContain(`Steps: ${SITE}/api/setup/guide/direct/windows`);
    expect(text).toContain(`Fuobe's status for it: ${SITE}/api/setup/ABCD-EFGH-JKMN`);
    expect(text).toContain("I use Edge.");
    expect(text).toMatch(/^[\x0a\x20-\x7e]*$/);
    expect(chatLink("chatgpt", text)).toMatch(/^https:\/\/chatgpt\.com\/\?q=/);
    expect(chatLink("claude", text)).toMatch(/^https:\/\/claude\.ai\/new\?q=/);
    const phone = prefillText({ way: "address", os: "mac", site: SITE, code: "ABCDEFGHJKMN", browser: "safari", phone: true });
    expect(phone).toContain("I am on my phone now");
    expect(phone).toContain("not into this chat");
  });

  it("give coding agents one line that runs the same in bash, zsh, PowerShell and cmd", () => {
    for (const agent of ["claude", "codex", "gemini"] as const)
      for (const os of OSES as Os[])
        for (const way of WAYS) {
          const line = agentLine(agent, { way, os, site: SITE, code: "ABCDEFGHJKMN" });
          expect(line).toMatch(/^(claude|codex|gemini -i) "[A-Za-z0-9 .,:/-]+"$/);
          expect(line).toContain(os === "windows" ? "curl.exe" : "curl ");
        }
    expect(() => agentText({ way: "direct", os: "windows", site: "https://x.example/$(rm -rf)", code: "ABCDEFGHJKMN" })).toThrow();
  });

  it("Copy instructions holds the first line, the way to go, and the whole guide with the code", () => {
    const guide = guideText({ way: "address", os: "mac", site: SITE });
    const text = fullInstructions({ way: "address", os: "mac", site: SITE, code: "ABCDEFGHJKMN", browser: "safari" }, guide);
    expect(text.split("\n")[0]).toMatch(/^Please help me give the ComfyUI on my macOS computer a web address/);
    expect(text).toContain("Guide me one step at a time.");
    expect(text).toContain("Setup code: ABCD-EFGH-JKMN");
    expect(text).toContain("## Step 3: Start the web address");
  });
});
