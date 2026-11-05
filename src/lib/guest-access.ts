/**
 * What guests (signed-out visitors) and accounts (people who signed up) may do while public sign-up
 * is on (src/server/auth.ts publicSignup). Path rules only: src/proxy.ts applies them.
 *
 * - A guest opens every page and the catalog and status reads the pages need. The owner's library
 *   comes back empty (or 401 "Sign up to see this"), and every change is a 401 that the
 *   client turns into "Create a free account" (src/components/guest-prompt.tsx).
 * - An account sees what a guest sees of the owner's studio: the owner's library and projects stay
 *   hidden (empty lists, 403) and can't be changed (403, LIBRARY_CHANGES). It never runs on the
 *   owner's cloud keys or GPU ("Connect your GPU"), and never changes install-wide settings, keys or
 *   tokens (owner only).
 */

import { SETUP_CODE_PATH } from "./ai-setup/code";

/** Set by the proxy on a guest's request to a route that answers guests itself (GUEST_FILTERED), and on its 401s. */
export const GUEST_HEADER = "x-fuobe-guest";

/** A guest's request, as the proxy marks it for GUEST_FILTERED routes (a client that sends the header itself only gets less). */
export const isGuest = (request: Request) => request.headers.get(GUEST_HEADER) === "1";

export const GUEST_LIBRARY_MESSAGE = "Sign up to see this.";
export const GUEST_RUN_MESSAGE = "Create a free account to run this.";

/** Catalog and status reads that hold nothing of the owner's library: a guest gets the real answer. */
const GUEST_READS = new Set(["/api/status", "/api/examples", "/api/models", "/api/search-index", "/api/comfyui", "/api/settings/models", "/api/gpu/requirements", "/api/live/nodes"]);

/** Catalogs mixed with the owner's own items: the route leaves the owner's part out for a guest (GUEST_HEADER). */
const GUEST_FILTERED = new Set(["/api/moodboards", "/api/palettes", "/api/assist", "/api/assist/skills"]);

/** One skill, its recipe and its download: the route answers a guest for a built-in skill only (404 for the owner's own). */
const GUEST_SKILL = /^\/api\/assist\/skills\/[^/]+(\/recipe|\/download)?$/;

/** The owner's lists ({ items }): a guest gets them empty. */
const EMPTY_LISTS = [
  "/api/generations",
  "/api/generations/trash",
  "/api/assets",
  "/api/folders",
  "/api/elements",
  "/api/canvases",
  "/api/cinema/projects",
  "/api/layers",
  "/api/content-factory/series",
  "/api/dub",
  "/api/explainer",
  "/api/faceless/channels",
  "/api/faceless/episodes",
  "/api/katana",
  "/api/marketing/runs",
  "/api/products",
  "/api/brands",
  "/api/shorts/sessions",
  "/api/shorts/presets",
  "/api/swap-studio/projects",
  "/api/ads/creatives",
  "/api/assist/projects",
  "/api/assist/schedules",
  "/api/assist/memory",
  // Chains the owner made often enough to offer as skills (the owner's runs).
  "/api/skill-suggestions",
];

/** The Library's counts with nothing in it (a guest's). */
export const NO_FACETS = { models: [], kinds: {}, total: 0, favorites: 0, failed: 0, trash: 0, pinned: 0, steps: 0, reviews: {} };

const EMPTY: Record<string, unknown> = {
  ...Object.fromEntries(EMPTY_LISTS.map((p) => [p, { items: [] }])),
  "/api/shares": { items: [], signIn: true },
  "/api/photodump": { packs: [] },
  "/api/photodump/packs": { packs: [] },
  "/api/photodump/characters": { items: [] },
  "/api/generations/facets": NO_FACETS,
  // GPU pre-flight: a guest has no GPU (Connect your GPU), so no board and no chips.
  "/api/gpu/readiness": { connected: false, reason: "guest" },
  "/api/gpu/badges": { connected: false, models: {}, presets: {} },
};

export type GuestRead =
  /** A page, or a catalog read: let it through. */
  | { kind: "pass" }
  /** Let it through with GUEST_HEADER: the route answers without the owner's items. */
  | { kind: "filtered" }
  /** Answer this body (the owner's list, empty). */
  | { kind: "empty"; body: unknown }
  /** No such endpoint for a guest (204, no content: the live-updates stream, so the client looks again much later). */
  | { kind: "none" }
  /** The owner's data: 401. */
  | { kind: "closed" };

/**
 * "Set it up with my AI" (src/app/api/setup): a setup's status by its code, the steps for an AI, and Fuobe's files those
 * steps download. Open to everyone, with no session: the person's AI reads them. They hold nothing of an account.
 */
export const SETUP_PUBLIC_READ = new RegExp(
  `^/api/setup/(?:${SETUP_CODE_PATH}|guide/(?:direct|address|connect)/(?:windows|mac|linux|other)|files/(?:fuobe_guard\\.py|start/\\d{1,5}))$`,
  "i",
);
/** An account's own setup code: End this code, its tab's report, and its tab's wait. The routes take its own code only. */
const SETUP_OWN = new RegExp(`^/api/setup/session/${SETUP_CODE_PATH}$`, "i");
const SETUP_REPORT = new RegExp(`^/api/setup/session/${SETUP_CODE_PATH}/report$`, "i");
const SETUP_WAIT = new RegExp(`^/api/setup/session/${SETUP_CODE_PATH}/wait$`, "i");

/** What a guest's GET or HEAD gets. Anything not named here under /api stays closed. */
export function guestRead(pathname: string): GuestRead {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return { kind: "pass" };
  if (GUEST_READS.has(pathname) || SETUP_PUBLIC_READ.test(pathname)) return { kind: "pass" };
  if (GUEST_FILTERED.has(pathname) || GUEST_SKILL.test(pathname)) return { kind: "filtered" };
  if (Object.hasOwn(EMPTY, pathname)) return { kind: "empty", body: EMPTY[pathname] };
  if (pathname === "/api/generations/stream") return { kind: "none" };
  return { kind: "closed" };
}

/**
 * The run routes whose `?preview=1` only plans and prices (any other route would ignore the flag and run). AI
 * Influencer, Fashion Factory and Character Sheet price on load, with synchronous price functions.
 */
const PREVIEWS = [/^\/api\/(generations|audio-tools|dub|katana|turnaround|fly-around|influencer|photodump|photodump\/fashion|photodump\/character)$/, /^\/api\/dub\/[^/]+\/voice$/];

/** The estimate routes (named: a dynamic segment called "estimate" on another route must not pass for one). */
const ESTIMATES =
  /^\/api\/(ads|ads\/multiplier|assist\/skills\/[^/]+|content-factory|evolution|faceless|genjutsu|influencer|marketing|marketing\/click-to-ad|mixed-media|remove-object|restore|shorts|storyboards|turnaround)\/estimate$/;

/** A POST that only plans and prices a run (an estimate route, or ?preview=1 where PREVIEWS honours it): free, and open to guests. */
export function isPriceCheck(method: string, pathname: string, search: string): boolean {
  if (method !== "POST") return false;
  if (ESTIMATES.test(pathname)) return true;
  return new URLSearchParams(search).get("preview") === "1" && PREVIEWS.some((r) => r.test(pathname));
}

/**
 * Changes to the studio's library and projects (create, rename, move, share, delete, upload). The
 * library is the owner's, and accounts don't have one of their own yet, so an account is refused
 * them with LIBRARY_MESSAGE. Everything else an account sends (a run, an AI helper, a connector,
 * the MCP endpoint…) is refused with "Connect your GPU": it never spends the owner's keys or GPU.
 */
const LIBRARY_CHANGES: [methods: string, path: RegExp][] = [
  ["POST", /^\/api\/folders$/],
  ["PATCH DELETE", /^\/api\/folders\/[^/]+$/],
  ["PATCH DELETE", /^\/api\/generations\/[^/]+$/],
  // (POST /api/generations/bulk goes to the route, which takes an account's likes, pins and reviews of its own runs only.)
  ["POST", /^\/api\/generations\/[^/]+\/(cancel|finish)$/],
  ["DELETE", /^\/api\/generations\/trash$/],
  ["DELETE", /^\/api\/assets\/[^/]+$/],
  ["POST", /^\/api\/shares$/],
  ["PATCH DELETE", /^\/api\/shares\/[^/]+$/],
  ["POST", /^\/api\/(canvases|cinema\/projects|layers|elements|palettes|products|brands|swap-studio\/projects|shorts\/presets|photodump\/packs|assist\/projects|assist\/memory)$/],
  [
    "PATCH DELETE",
    /^\/api\/(canvases|cinema\/projects|layers|elements|palettes|products|brands|moodboards|swap-studio\/projects|content-factory\/series|faceless\/channels|faceless\/episodes|dub|shorts\/presets|shorts\/sessions|assist|assist\/projects|assist\/memory|assist\/schedules|assist\/skills|ads\/creatives)\/[^/]+$/,
  ],
  ["DELETE", /^\/api\/(katana|marketing\/runs|photodump\/packs)\/[^/]+$/],
  ["POST", /^\/api\/canvases\/[^/]+\/duplicate$/],
  // A Kinetic node's run (rendered in the owner's browser) kept on the canvas.
  ["PUT", /^\/api\/canvases\/[^/]+\/runs\/[^/]+$/],
  // A ready-made starter (a channel, a brand kit with its product) is saved to the owner's library.
  ["POST", /^\/api\/starters\/[^/]+$/],
  ["POST", /^\/api\/assist\/skills\/[^/]+\/duplicate$/],
  ["POST", /^\/api\/ads\/creatives\/[^/]+\/save$/],
  ["POST", /^\/api\/cinema\/projects\/[^/]+\/folders$/],
  ["PATCH DELETE", /^\/api\/cinema\/projects\/[^/]+\/(items|folders\/[^/]+)$/],
  ["PUT", /^\/api\/cinema\/projects\/[^/]+\/items\/[^/]+\/tiles$/],
  ["POST", /^\/api\/layers\/[^/]+\/versions$/],
  ["PATCH DELETE", /^\/api\/layers\/[^/]+\/jobs\/[^/]+$/],
  ["DELETE", /^\/api\/assist\/projects\/[^/]+\/sources\/[^/]+$/],
];

/** A generation's own path (/api/generations/<id>), not one of the collection's routes. */
const GENERATION = /^\/api\/generations\/(?!(?:facets|trash|stream|zip|bulk|local)$)([^/]+)$/;

/** The generation an account's request is about (its own runs: the proxy checks it made it), or undefined. */
export function accountGeneration(method: string, pathname: string): string | undefined {
  // Cancel, and Fuobe Soul's finished picture for its own result.
  const step = /^\/api\/generations\/([^/]+)\/(cancel|finish)$/.exec(pathname);
  if (method === "POST" && step) return step[1];
  const one = GENERATION.exec(pathname);
  // PATCH: a like, a pin or a review status (all the route changes).
  return one && (method === "GET" || method === "HEAD" || method === "PATCH" || method === "DELETE") ? one[1] : undefined;
}

/**
 * A read of an account's own things, which the route (or the proxy, by accountGeneration) scopes to it:
 * the list of its runs, a stored file (the proxy checks whose it is), its GPU, its keys (never a key: their last 4).
 */
export function accountOwnRead(pathname: string): boolean {
  if (ACCOUNT_LISTS.has(pathname)) return true;
  return (
    pathname === "/api/generations" ||
    pathname === "/api/account/gpu" ||
    pathname === "/api/account/keys" ||
    ACCOUNT_CANVASES.test(pathname) ||
    GPU_READS.has(pathname) ||
    COMPUTER_READ.test(pathname) ||
    PAIRING_READS.has(pathname) ||
    SETUP_WAIT.test(pathname)
  );
}

/** An account's own canvases (src/app/api/account/canvases): the routes read and change its own boards only. */
const ACCOUNT_CANVASES = /^\/api\/account\/canvases(\/[^/]+)?$/;

/**
 * The Library's counts, its Uploads (its stored files), a zip of its runs (the Library's Download, a result's
 * Download all, Shorts' Download parts), its own dubs (src/server/dub.ts) and its own Photodump packs (GET /api/photodump,
 * the same list as /api/photodump/packs): each route answers an account with its own only.
 */
const ACCOUNT_LISTS = new Set(["/api/generations/facets", "/api/assets", "/api/generations/zip", "/api/dub", "/api/photodump"]);

/**
 * A signed-in account's zip of its own runs (/api/generations/zip; src/server/account-files.ts ACCOUNT_LIMITS): at most
 * this many runs and this many bytes in one zip, one zip at a time. The Library sends at most this many.
 */
export const ACCOUNT_ZIP_MAX_RUNS = 200;
export const ACCOUNT_ZIP_MAX_BYTES = 2 ** 30;

/**
 * "Use the ComfyUI on this computer": the routes the person's own Fuobe tab runs their jobs through. Each takes whose
 * jobs from the session, and only that person's (src/server/computer/http.ts principalOf).
 */
const COMPUTER_READ = /^\/api\/gpu\/computer\/tasks\/[^/]+\/(inputs|outputs)\/[^/]+$/;
/** Pairing a ComfyUI with Fuobe Connect: the code's computer, and the person's paired ComfyUIs (src/app/api/gpu/pair). */
const PAIRING_READS = new Set(["/api/gpu/pair", "/api/gpu/paired"]);
const COMPUTER_CHANGES: [method: string, path: RegExp][] = [
  ["POST", /^\/api\/gpu\/computer\/(beat|claim)$/],
  ["POST", /^\/api\/gpu\/computer\/tasks\/[^/]+\/(report|release)$/],
  ["PUT", /^\/api\/gpu\/computer\/tasks\/[^/]+\/outputs\/[^/]+$/],
];

/** GPU pre-flight reads: each answers for the account's own GPU only (src/server/gpu/target.ts). */
const GPU_READS = new Set(["/api/gpu/readiness", "/api/gpu/badges", "/api/gpu/plan"]);

/**
 * A change an account may send: signing out, its own GPU and its check, its own fal.ai and Replicate keys, price checks
 * (reads go by guestRead, as a guest's), an upload (the route checks it: src/app/api/uploads, which the proxy's matcher
 * leaves out), a look at its own clip's header (the route reads only its own files), and a result it made in its
 * browser (POST /api/generations/local: a Kinetic Motion clip, a colour grade or a Relight blend of its own files;
 * POST /api/audio-tools/export: Split soundtrack's Export mix), kept as its own run.
 */
export function accountMayChange(method: string, pathname: string, search: string): boolean {
  if (method === "POST" && pathname === "/api/auth/logout") return true;
  if ((method === "PUT" || method === "DELETE") && pathname === "/api/account/gpu") return true;
  if ((method === "PUT" || method === "DELETE") && /^\/api\/account\/keys\/(fal|replicate)$/.test(pathname)) return true;
  // GPU pre-flight: checking its own ComfyUI (reads only; the routes check the target and the request themselves).
  if ((method === "POST" && pathname === "/api/gpu/check") || (method === "PUT" && pathname === "/api/gpu/inventory")) return true;
  // Running its own jobs on its own computer, and pairing (or unpairing) its own ComfyUI.
  if (COMPUTER_CHANGES.some(([m, p]) => m === method && p.test(pathname))) return true;
  if ((method === "POST" && pathname === "/api/gpu/pair") || (method === "DELETE" && /^\/api\/gpu\/paired\/[^/]+$/.test(pathname))) return true;
  // "Set it up with my AI": its own setup code (make or update it, its tab's report, End this code). The routes take the
  // account's own setup only.
  if (method === "POST" && (pathname === "/api/setup/session" || SETUP_REPORT.test(pathname))) return true;
  if (method === "DELETE" && SETUP_OWN.test(pathname)) return true;
  if (method === "POST" && (pathname === "/api/uploads" || pathname === "/api/media/probe")) return true;
  // Its own canvases: save a board, rename it, save its pages, delete it (the routes take its own boards only).
  if ((method === "POST" && pathname === "/api/account/canvases") || ((method === "PATCH" || method === "DELETE") && /^\/api\/account\/canvases\/[^/]+$/.test(pathname))) return true;
  // "Report this result", and a click on an offer the billing service sent (each route checks the rest).
  if (method === "POST" && (pathname === "/api/reports" || pathname === "/api/billing/interest")) return true;
  // Like, pin or review many of its own runs at once (the route checks each is its own, and refuses the rest).
  if (method === "POST" && pathname === "/api/generations/bulk") return true;
  // A result it made in its browser and uploaded (a Kinetic Motion clip, a colour grade, a Relight blend), recorded as
  // its own run (the route checks the files are its own, its run rate and the studio's checks). No model runs, so it
  // needs no GPU or key of its own.
  if (method === "POST" && pathname === "/api/generations/local") return true;
  // Split soundtrack's Export mix, sent in parts and kept as its own run (the route checks its room, its run rate and
  // the studio's checks; the proxy's matcher leaves this route out, which runs the proxy itself).
  if (method === "POST" && pathname === "/api/audio-tools/export") return true;
  return isPriceCheck(method, pathname, search);
}

/**
 * Live edit (src/app/api/live): the route a path names, or null. "nodes" is the node file's download (open to anyone);
 * every other route runs or stores live edits.
 */
export type LiveRoute = "session" | "inputs" | "render" | "cancel" | "events" | "masters" | "save" | "nodes";
const LIVE_ROUTE = /^\/api\/live\/(session|inputs|render|cancel|events|masters|save|nodes)$/;
export const liveRoute = (pathname: string): LiveRoute | null => (LIVE_ROUTE.exec(pathname)?.[1] as LiveRoute | undefined) ?? null;

/**
 * What an account gets on a live edit route, by its own GPU: it renders only there (a linked GPU through the server, or
 * its own computer from its tab), keeps its masters in its own files, and has no Library to save to. A guest gets
 * GUEST_RUN_MESSAGE on all of them but the node download.
 */
export function accountLive(route: LiveRoute, gpu: "link" | "computer" | null): "pass" | "connect-gpu" | "library" {
  if (route === "nodes") return "pass";
  if (route === "save") return "library";
  return gpu ? "pass" : "connect-gpu";
}

/** Assist (chats, skills, memory, projects, schedules): any change to it, which only the owner may make on a public studio. */
export function isAssistChange(method: string, pathname: string): boolean {
  return method !== "GET" && method !== "HEAD" && (pathname === "/api/assist" || pathname.startsWith("/api/assist/"));
}

/**
 * Assist plans with the install's own AI helpers and keeps the owner's chats, memory and projects, so an account gets
 * this one answer to any change there (code "assist-owner"; price checks still go through), with or without its own
 * GPU. A guest gets it too, not the 401 that offers to sign up: an account couldn't use Assist either. The Assist
 * pages say the same to both (src/components/assist/visitor-note.tsx).
 */
export const ASSIST_OWNER_MESSAGE = "Assist isn't available here. Make anything in the Image, Video and Audio studios, or with an app, effect or camera motion.";

/** A change to the studio's library or projects (refused for an account with LIBRARY_MESSAGE, not "Connect your GPU"). */
export function isLibraryChange(method: string, pathname: string): boolean {
  return LIBRARY_CHANGES.some(([methods, path]) => methods.split(" ").includes(method) && path.test(pathname));
}

export const ACCOUNT_LIBRARY_MESSAGE = "We can't find that.";
export const LIBRARY_MESSAGE = "Saving here isn't available. Download what you make from your runs.";

/** A report anyone may send, signed in or not ("Report this result" on a shared link). */
export const anyoneMayReport = (method: string, pathname: string): boolean => method === "POST" && pathname === "/api/reports";

/**
 * The tools an account runs on its own GPU or key, beside the studios' generations. Each route makes an account's checks
 * itself (src/server/account-tool-run.ts: its own files, its limits, its GPU or key for every step) and refuses a guest
 * with the sign-up card. Genjutsu's "Describe my character" runs its GPU describer on the account's own GPU.
 */
export const ACCOUNT_TOOL_RUNS: readonly RegExp[] = [
  /^\/api\/genjutsu(\/(scene|transcribe))?$/,
  // Storyboard: a board, and its film (the route reads the account's own board only).
  /^\/api\/storyboards(\/[^/]+\/film)?$/,
  // Image to 3D's runs (a model, a splat, a rig, a retexture): the model is finished on this server under the account's limits.
  /^\/api\/image-to-3d$/,
  // Genjutsu's "Describe my character": the GPU describer on the account's own GPU.
  /^\/api\/genjutsu\/describe$/,
  // Character Swap Studio's jobs on an account's own project (src/server/swap-studio-account.ts).
  /^\/api\/swap-studio\/projects\/[^/]+\/(anchors|assemble|clips|masks|prepare|queue|sharpen|transcribe)$/,
  // Cinema Studio: a take in the account's own project, a retry and a 2K finish of one of its takes.
  /^\/api\/cinema\/projects\/[^/]+\/(generate|items\/[^/]+\/(retry|finish))$/,
  // The photo apps: Photodump, Fashion Factory, Character Sheet, AI Influencer, and a retry of its own photo.
  /^\/api\/(photodump(\/(fashion|character|retry))?|influencer)$/,
  // Video tools: Remove object (a mask preview, and "Redo from here" on its own removal), Evolution (its direction is
  // Fuobe's offline writer's), Mixed Media (a preview frame, and "Try again" on its own render), Turnaround video and
  // Fly around (Image to 3D's "Film it photoreal"), and Katana (a retry or Run again of its own run).
  /^\/api\/remove-object(\/(preview|reroll))?$/,
  /^\/api\/evolution(\/direction)?$/,
  /^\/api\/mixed-media(\/(preview|retry))?$/,
  /^\/api\/(turnaround|fly-around)$/,
  /^\/api\/katana(\/[^/]+\/retry)?$/,
  // Audio's tools (Split soundtrack, Clean up dialogue, Remove dialogue, Edit speech, Loop, Join, Clean up voice), and
  // Translate & dub: a dub, and voicing one language of the account's own dub (src/server/dub.ts).
  /^\/api\/audio-tools$/,
  /^\/api\/dub(\/[^/]+\/voice)?$/,
  // Restore & colourise: its windows or pieces and their join on the account's own GPU or fal.ai key, with Fuobe's
  // offline template for the words when none are given (the studio's AI helper stays the owner's: /api/restore/prompt).
  /^\/api\/restore$/,
];

/**
 * A tool's project routes that keep each account's projects apart (src/server/account-projects.ts): the proxy lets an
 * account's reads and changes through, and the route answers with its own projects only (another's reads as not found).
 * A guest's change gets the sign-up card; its reads go by guestRead. A tool adds its routes here when it opens to
 * accounts.
 */
export const ACCOUNT_PROJECT_ROUTES: RegExp[] = [
  // Character Swap Studio: the list, a project, its prices, its decisions, and stopping its jobs.
  /^\/api\/swap-studio\/projects(\/[^/]+(\/(decisions|estimate|stop|takes\/stop))?)?$/,
  // Shorts Studio: its own sessions (start one, a new take, Enhance a take on its own GPU, stitch again, pick a take,
  // rename, delete) and its own presets.
  /^\/api\/shorts\/sessions(\/[^/]+(\/stitch|\/segments\/[^/]+(\/(primary|enhance))?)?)?$/,
  /^\/api\/shorts\/presets(\/[^/]+)?$/,
  // Cinema Studio: its projects, folders, takes, grid tiles and AI Director chat (the Director's built-in breakdown:
  // no AI helper, GPU or key), and a ready film made as its own project (src/server/cinema.ts).
  /^\/api\/cinema\/projects(\/[^/]+(\/(director|folders|items|folders\/[^/]+|items\/[^/]+\/tiles))?)?$/,
  /^\/api\/starters\/cinema\.[^/]+$/,
  // Photodump and Fashion Factory: its own packs and its own characters (src/server/photodump.ts).
  /^\/api\/photodump\/(packs|characters)(\/[^/]+)?$/,
  // Katana: its own runs (the list, one run, forgetting one), and how far its own Mixed Media render's frames are.
  /^\/api\/katana(\/[^/]+)?$/,
  /^\/api\/mixed-media\/progress$/,
  // Translate & dub: one of its own dubs (open it, save its reviewed lines, forget it). Its list is ACCOUNT_LISTS', and
  // starting one is a tool run (ACCOUNT_TOOL_RUNS), so its price check is counted as every other.
  /^\/api\/dub\/[^/]+$/,
  // Faceless Studio, the Explainer and Content Factory: their own channels, episodes, explainers and series, their topic
  // ideas, documents and narrator samples, and their runs (renders, retries, changes, upscales, avatars, readings), each
  // checked by the route on its own GPU or key (src/server/faceless.ts, content-factory.ts). "Generate in Claude" isn't
  // here (it hands the brief to the studio's own MCP server), nor reading a link (the server never fetches a link for an
  // account: it uploads the file or pastes the words). "Regenerate to 1080p" runs on the account's own GPU only.
  /^\/api\/faceless\/(channels(\/[^/]+(\/avatar)?)?|episodes(\/[^/]+(\/(render|retry|rewrite|undo|upscale|regenerate|change))?)?|topics|voices\/preview)$/,
  /^\/api\/explainer(\/document)?$/,
  /^\/api\/content-factory\/series(\/[^/]+(\/(episodes|generate|read))?)?$/,
  /^\/api\/starters\/faceless\.[^/]+$/,
];

export const accountProjectRoute = (pathname: string): boolean => ACCOUNT_PROJECT_ROUTES.some((r) => r.test(pathname));

/**
 * Runs an account may start once it has connected its own ComfyUI ("Your GPU") or added its own fal.ai or Replicate key
 * ("Your keys"): the studios' generations, camera motions, effects and apps, which the route sends to that ComfyUI or
 * that key only, with only its own uploaded files (src/app/api/generations/route.ts, generations.ts accountRun), and
 * the tools in ACCOUNT_TOOL_RUNS. Other tools plan with the install's AI helpers or its own ComfyUI, so they stay refused.
 */
export function ownGpuRun(method: string, pathname: string): boolean {
  return method === "POST" && (pathname === "/api/generations" || ACCOUNT_TOOL_RUNS.some((r) => r.test(pathname)));
}

/** The code on an account's run refused because its runs going are at the limit: the next one may wait for a place and send again. */
export const ACTIVE_RUNS_CODE = "active-runs";

export const OWN_GPU_TOOL_MESSAGE = "This tool isn't available here. Try the Image, Video or Audio studio, or an app, effect or camera motion.";

/** Set on an account's refused run: the client shows "Connect your GPU to run this". */
export const CONNECT_GPU_HEADER = "x-fuobe-connect-gpu";
/** Beside it on the owner's refused run (Demo mode off, nothing connected): what would run it, "gpu", "key" or "any". */
export const CONNECT_NEEDS_HEADER = "x-fuobe-connect-needs";
export const CONNECT_GPU_MESSAGE = "Connect your GPU to run this. It's free.";
/** An account's upload with neither a GPU nor a key of its own: its files are kept for runs on its own ComfyUI or key. */
export const CONNECT_GPU_UPLOAD_MESSAGE = "Connect your GPU, or add a fal.ai or Replicate key, to add your own files.";
/** The same, on a studio with paid models off (no keys). */
export const CONNECT_GPU_UPLOAD_OPEN_MESSAGE = "Connect your GPU to add your own files.";
/**
 * Sent with the upload of a result rendered in the browser (a Kinetic Motion clip or its poster, a colour grade, a
 * Relight blend), set to "1". Saving one needs no model, so an account with neither its own GPU nor its own key may
 * upload it too: an MP4 or WebM clip, or a PNG picture, within the account's space and upload limits
 * (src/app/api/uploads).
 */
export const KINETIC_UPLOAD_HEADER = "x-fuobe-kinetic";
/** An account with neither its own GPU nor its own key (the proxy's answer to a run): the card it opens offers both. */
export const CONNECT_GPU_OR_KEY_MESSAGE = CONNECT_GPU_MESSAGE;

/** Install-wide settings, keys and tokens: changes are the owner's (403 for an account). */
const OWNER_WRITES = new Set(["/api/settings", "/api/settings/models", "/api/loras", "/api/llm", "/api/providers/test", "/api/auth/public", "/api/skill-suggestions"]);
/**
 * Owner only, reads included: the password, the API tokens, signing everyone out, the assistant's connectors, the MCP
 * endpoint and the accounts admin.
 */
const OWNER_ALL = [/^\/api\/auth\/(password|tokens|sessions)$/, /^\/api\/assist\/connectors(\/|$)/, /^\/api\/mcp$/, /^\/api\/admin(\/|$)/];

export function ownerOnly(method: string, pathname: string): boolean {
  if (OWNER_ALL.some((r) => r.test(pathname))) return true;
  return method !== "GET" && method !== "HEAD" && OWNER_WRITES.has(pathname);
}
