/**
 * The one next step of a setup, in plain words for the person's AI: what Fuobe sees, what to do, and where the guide
 * shows it. The status (GET /api/setup/<code>) and the panel's "Stuck?" say the same. Every word comes from the tables
 * here; only fixed words, whole numbers and the studio's own address go into them. ASCII only. Pure.
 */
import { COMFY_PORTS } from "@/lib/local-comfy";
import { FIRST_MODEL_NAME } from "./first-picture";
import type { AddressCause, InstallKind, SetupView } from "./facts";
import { isConnected, isDone } from "./steps";
import type { BrowserName, Way } from "./ways";

export interface NextStep {
  id: string;
  /** What Fuobe sees and what to do, in one or two sentences. */
  say: string;
  /** How, line by line (may be empty). */
  how: string[];
  /** The guide's part that shows it. */
  guide: string;
}

/** The guide's step that gets a first picture model, and the one that stops the tunnel, by way. */
export const MODEL_STEP: Record<Way, number> = { direct: 6, address: 5, connect: 4 };
export const STOP_STEP = 6;

/** How long the tab may be quiet before the status says it isn't open (it reports at least every 25 s). */
export const TAB_QUIET_MS = 40_000;

const BLOCKED_HOW: Record<BrowserName, string> = {
  chrome: "Chrome: click the icon to the left of the address, turn on Apps on device, then reload the Fuobe tab.",
  edge: "Edge: click the icon to the left of the address, turn on Apps on device, then reload the Fuobe tab.",
  opera: "Opera: click the icon to the left of the address, allow apps on this device, then reload the Fuobe tab.",
  firefox: "Firefox: click the icon to the left of the address, allow apps and services on this device, then reload the Fuobe tab.",
  brave: "Brave: click the Brave icon next to the address, allow localhost access, then reload the Fuobe tab.",
  safari: "Safari can't reach ComfyUI from a website. Ask the person to choose A web address in Fuobe.",
  other: "Click the icon to the left of the address, allow apps on this device, then reload the Fuobe tab.",
};

const SETTING_HOW: Record<InstallKind, string> = {
  desktop: "ComfyUI Desktop: Settings (the gear, bottom left), then Server-Config. Put {site} in Enable CORS header, and nothing else. Restart when it asks.",
  portable:
    "Portable or Easy-Install: the easiest way is Fuobe's start file (guide Step 3). It adds the guard and the setting, keeps the other settings, and asks before it restarts ComfyUI. The person can also press Download start file in Fuobe.",
  "stability-matrix": "Stability Matrix: Packages, then ComfyUI's three-dot menu, then Launch Options. Add --enable-cors-header {site} to Extra Launch Arguments. Stop ComfyUI and launch it again.",
  terminal: "Started from a terminal: stop ComfyUI with Ctrl+C in its window, then start it with the same command plus --enable-cors-header {site}.",
};

const GUARD_HOW: Record<InstallKind, string | null> = {
  desktop: "Put fuobe_guard.py in the custom_nodes folder of the ComfyUI folder (Documents -> ComfyUI, unless the person chose another one).",
  portable: null,
  "stability-matrix": "Put fuobe_guard.py in ComfyUI's custom_nodes folder (ComfyUI's three-dot menu, then Open in Explorer or Open in Finder).",
  terminal: "Put fuobe_guard.py in ComfyUI's custom_nodes folder.",
};

const ADDRESS_SAY: Record<AddressCause, string> = {
  local: "That address only works on the person's own network. Use the address that ends in trycloudflare.com.",
  "not-found": "Fuobe couldn't find that address. Make sure that the person pasted the whole address that cloudflared made, and that cloudflared is still running.",
  "no-answer":
    "Nothing answered at that address. Make sure that ComfyUI and cloudflared are both running, and that the port in the cloudflared command is ComfyUI's port. A new address can take up to a minute to work.",
  "not-comfy": "That address isn't a ComfyUI. Make sure that the port in the cloudflared command is ComfyUI's port.",
  password: "Something in front of ComfyUI asks for a password. This way needs none. Start the tunnel straight to ComfyUI's port.",
  format: "Fuobe couldn't use that address. Ask the person what Fuobe says under the box.",
  unknown: "Fuobe couldn't use that address. Ask the person what Fuobe says under the box.",
};

const gb = (tenths: number) => `${(tenths / 10).toFixed(tenths >= 100 ? 0 : 1)} GB`;

/** The status words' site: the studio's own address (never a visitor's word). */
const fill = (s: string, site: string) => s.replaceAll("{site}", site);

export function nextOf(v: SetupView, now: number): NextStep {
  const { site, way, os } = v;
  const t = v.tab;
  const guide = (step?: number) => `${site}/api/setup/guide/${way}/${os}${step !== undefined ? `#step-${step}` : ""}`;
  const say = (id: string, words: string, how: string[] = [], step?: number): NextStep => ({ id, say: fill(words, site), how: how.map((h) => fill(h, site)), guide: guide(step) });

  // The Fuobe tab: its checks need it open.
  if (!t || now - v.tabAt > TAB_QUIET_MS) {
    if (t && !t.visible)
      return say("wake-fuobe", "The Fuobe tab is asleep in the background, so Fuobe can't check. Ask the person to click on the Fuobe tab once, then come back to you.");
    return way === "address"
      ? say("open-fuobe", "The Fuobe page isn't open. Ask the person to open {site}/connect?setup=ai in any browser, and to press Set it up with my AI. The setup code stays the same.")
      : say(
          "open-fuobe",
          "The Fuobe page isn't open. Ask the person to open {site}/connect?setup=ai in Chrome, Edge or Firefox on the computer that runs ComfyUI, and to press Set it up with my AI. The setup code stays the same.",
        );
  }

  if (isDone(v)) {
    const keep =
      way === "address"
        ? [
            "Keep cloudflared running while runs go. Each time cloudflared starts again, it makes a new address: paste the new one in Fuobe.",
            `When the person is done for the day, stop cloudflared (guide Step ${STOP_STEP}).`,
          ]
        : ["Keep a Fuobe tab open on this computer while runs go."];
    return say("done", "Done. Fuobe uses this GPU now. Nothing else to do.", keep);
  }

  const connected = isConnected(v);
  if (!connected) {
    if (way === "address") {
      const linked = v.server.gpu === "link";
      if (t.address === "testing") return say("address-testing", "Fuobe is testing the address. Wait a few seconds, then check again.");
      if (t.address === "failed") return say(`address-${t.addressCause ?? "unknown"}`, ADDRESS_SAY[t.addressCause ?? "unknown"], [], 3);
      if (linked && v.server.online === false)
        return say("link-offline", "Fuobe can't reach ComfyUI at the saved address. If cloudflared started again, it made a new address: the person pastes the new one in Fuobe.", [], 3);
      if (linked) return say("checking-link", "Fuobe is checking the saved address. Wait a few seconds, then check again.");
      return say(
        "start-tunnel",
        "Fuobe doesn't have ComfyUI's web address yet. Start cloudflared (guide Steps 2 and 3), then ask the person to paste the address into Fuobe and press Connect. Don't paste the address into this chat.",
        [],
        2,
      );
    }

    if (t.browser === "unsupported") return say("use-address", "This browser can't reach ComfyUI from a website. Ask the person to choose A web address in Fuobe.");
    if (t.browser === "ask")
      return say("allow-browser", "Fuobe needs the person's OK to look for ComfyUI on this computer. Ask them to press Let Fuobe look in Fuobe, then Allow when the browser asks.", [], 5);
    if (t.browser === "blocked")
      return say("unblock-browser", "The browser blocks Fuobe from reaching apps on this computer.", [BLOCKED_HOW[t.browserName ?? "other"], "Or the person switches to A web address in Fuobe."], 5);
    if (!t.comfy || t.comfy === "none")
      return say(
        "start-comfyui",
        "Fuobe doesn't see ComfyUI on this computer. If ComfyUI is installed, start it. If it isn't, install it first (guide Step 0).",
        [`Fuobe looks on ports ${COMFY_PORTS.slice(0, -1).join(", ")} and ${COMFY_PORTS[COMFY_PORTS.length - 1]}.`, "If ComfyUI uses another port, ask the person to type it under ComfyUI on another port? in Fuobe."],
        0,
      );
    if (t.comfy === "other") return say("wrong-app", `Another app answers on port ${t.port ?? 8188}, not ComfyUI. Find ComfyUI's port in its window or its settings.`, [], 1);
    if (t.comfy === "waiting") return say("restarting", "ComfyUI is restarting. Wait a few seconds, then check again.");
    if (way === "connect") {
      if (t.guard !== "connect") return say("install-connect", "Fuobe Connect isn't in ComfyUI yet. Install it (guide Step 2), then restart ComfyUI.", [], 2);
      return say("connecting", "Fuobe sees ComfyUI and is connecting. Wait a few seconds, then check again.");
    }
    if (t.comfy === "unreadable") {
      if (t.restarted)
        return say(
          "setting-not-taken",
          "ComfyUI restarted, but it still doesn't let Fuobe in. The setting didn't take.",
          [
            "The value must be exactly {site}: https, no www, no slash at the end and nothing after it.",
            "In ComfyUI Desktop, the Enable CORS header box holds only {site}.",
            "Make sure that ComfyUI was started with the new start file or command. An auto-restart window can start it again the old way.",
          ],
          3,
        );
      const install = t.install;
      const how = install ? [SETTING_HOW[install], ...(GUARD_HOW[install] ? [GUARD_HOW[install]!] : [])] : Object.values(SETTING_HOW);
      return say(
        "add-setting",
        `ComfyUI is running on port ${t.port ?? 8188}, but it doesn't let Fuobe in yet. Add Fuobe's guard to custom_nodes, then restart ComfyUI with --enable-cors-header {site}.`,
        how,
        2,
      );
    }
    // Found: Fuobe can read it.
    if (t.listen) return say("remove-listen", "ComfyUI listens on the network (--listen). Fuobe doesn't need that, and it lets other computers use ComfyUI. Restart ComfyUI without --listen.", [], 3);
    if (t.cors === "any") return say("fix-any", "ComfyUI lets every website in. Restart it with --enable-cors-header {site} in place of * or the empty setting.", [], 3);
    if (t.cors === "other") return say("fix-setting", "ComfyUI's --enable-cors-header names another site. Restart it with --enable-cors-header {site}.", [], 3);
    if (t.guard === "none" && !t.guardSkipped)
      return say(
        "add-guard",
        "Fuobe is allowed in, but Fuobe's guard is not in custom_nodes yet. Without it, other websites can use ComfyUI too. Add the guard, then restart ComfyUI once more.",
        [],
        2,
      );
    return say("connecting", "Fuobe sees ComfyUI and is connecting. Wait a few seconds, then check again.");
  }

  // Connected: a picture model, then the first picture.
  const cpu = t.cpu ? " ComfyUI runs on the processor, not a graphics card, so a picture takes minutes." : "";
  if (t.picture === "running") return say("picture-running", `Fuobe is making the first picture on this GPU. Wait, then check again.${cpu}`);
  if (t.picture === "failed")
    return t.pictureCause === "out-of-memory"
      ? say("picture-failed", "The first picture ran out of GPU memory. Close other apps that use the GPU, then ask the person to press Make your first picture again.")
      : say("picture-failed", "The first picture didn't finish. Ask the person what Fuobe says, then to press Make your first picture again.");
  if (t.model === "download")
    return say(
      "get-model",
      `ComfyUI is connected, but it has no picture model Fuobe can use yet. The one that fits is ${t.modelId ? FIRST_MODEL_NAME[t.modelId] : "Z-Image Turbo"}, a download of ${gb(t.modelGbTenths ?? 0)}. Ask the person first, then download it (guide Step ${MODEL_STEP[way]}).`,
      ["The person can also press Copy download commands in Fuobe and run them."],
      MODEL_STEP[way],
    );
  if (t.model === "none") return say("no-model-fits", "This GPU can't run the small picture models Fuobe starts with. Ask the person to open {site}/connect to see what runs on it.");
  if (t.model !== "ready") return say("checking-models", "ComfyUI is connected. Fuobe is checking which models it has. Wait a few seconds, then check again.");
  return say("make-picture", `ComfyUI is connected and has a picture model. Ask the person to press Make your first picture in Fuobe.${cpu}`);
}
