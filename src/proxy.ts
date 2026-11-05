import { NextResponse, type NextRequest } from "next/server";
import { APPS } from "@/lib/catalog/apps";
import { FORMER_HOME, modeHref, type HubKind } from "@/lib/hubs";
import { hiddenStarterPage, recordForPath, unknownHubMode, unknownStarterPage } from "@/lib/record-pages";
import { countsAsView, SHARE_VIEW_HEADER, shareRoute } from "@/lib/share";
import {
  ACCOUNT_LIBRARY_MESSAGE,
  accountGeneration,
  accountLive,
  CONNECT_GPU_MESSAGE,
  liveRoute,
  accountMayChange,
  accountOwnRead,
  accountProjectRoute,
  anyoneMayReport,
  ASSIST_OWNER_MESSAGE,
  CONNECT_GPU_HEADER,
  CONNECT_GPU_OR_KEY_MESSAGE,
  GUEST_HEADER,
  GUEST_LIBRARY_MESSAGE,
  GUEST_RUN_MESSAGE,
  guestRead,
  isAssistChange,
  isLibraryChange,
  isPriceCheck,
  LIBRARY_MESSAGE,
  OWN_GPU_TOOL_MESSAGE,
  ownerOnly,
  ownGpuRun,
} from "@/lib/guest-access";
import { ADMIN_BEARER, authEnabled, crossSite, hasCloudKey, hostAllowed, LoginGuard, publicSignup, sessionCookieOf, sessionViewer, validSession, validToken, type Account, type Viewer } from "@/server/auth";
import { fileAccount, generationAccount } from "@/server/account-library";
import { hit } from "@/server/rate";
import { accountRecordExists, installRecordExists } from "@/server/records";
import { findShare, shareGuard, shareTargetExists } from "@/server/share-access";
import { hostedRunsOn } from "@/server/hosted-switch";
import { authStoreFailed } from "@/server/auth-store";

/**
 * Paths that work signed out: the login page and its API (and share links: openShare). Sign-up and
 * "who am I" answer for themselves whether public sign-up is on.
 */
const OPEN = new Set(["/login", "/api/auth/login", "/api/auth/signup", "/api/auth/me", "/api/gpu/pair/start", "/api/gpu/pair/poll"]);

/**
 * A worker's token (src/server/computer/workers.ts) works only on the routes a computer runs jobs through; the route
 * checks the token itself. Anywhere else it is refused, whatever else the request carries.
 */
const WORKER_BEARER = /^Bearer\s+fuobe_wkr_/i;
const workerRoute = (pathname: string) => pathname.startsWith("/api/gpu/computer/");

/**
 * An admin token (src/server/admin-tokens.ts) works only on the admin API; the route checks the token and its scope
 * itself. Making, listing and revoking admin tokens is the owner's signed-in browser's only: /api/admin/tokens/self is
 * how a token reads its own name and scopes. Anywhere else it is refused, whatever else the request carries.
 */
const adminRoute = (pathname: string) => {
  const p = safeDecode(pathname);
  return p.startsWith("/api/admin/") && (!/^\/api\/admin\/tokens(\/|$)/i.test(p) || p === "/api/admin/tokens/self");
};

const APP_IDS = new Set(APPS.map((a) => a.id));

/**
 * Let the request through — except a page for something that doesn't exist (an unknown app or hub
 * mode, a project / canvas / channel… id that isn't stored), which gets a real 404. The page can't
 * send one itself: the studio's loading.tsx streams the shell (with a 200) before the page knows
 * the id is unknown. (The proxy can't tell a client-side navigation from a page load, so a link to
 * a deleted id reloads into the same 404 page.)
 */
function pass(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const app = /^\/apps\/([^/]+)\/?$/.exec(pathname)?.[1];
  if ((app && !APP_IDS.has(safeDecode(app))) || unknownHubMode(pathname) || unknownStarterPage(pathname)) return notFound(request);
  // The owner's and a guest's rule: an account's row in a tool's shared table is never theirs to open.
  const record = recordForPath(pathname);
  if (record && !installRecordExists(record)) return notFound(request);
  return NextResponse.next();
}

/**
 * A 404 page made here, for a request that reached the server through an HTTPS reverse proxy. Next builds the
 * proxy's request address from its own name for the server ("localhost") and the forwarded protocol, and the address
 * it routes by from the host it listens on (`next start -H 127.0.0.1`): when they differ, a rewrite to the app's own
 * 404 page goes out as a request to another server, which fails over HTTPS and answered 500. Plain HTTP (a local
 * install) keeps the rewrite to the app's own pages. It looks like the app's own 404 (NotFoundState in
 * src/components/empty-state.tsx): the Fuobe mark, the serif heading, the brand button, and the theme the visitor
 * chose (next-themes' "theme" key, read before the first paint).
 */
function plain404(title: string, text: string, back?: { href: string; label: string }, home = back ? "Home" : "Back to Home"): NextResponse {
  return new NextResponse(plainPage(title, text, `${back ? `<a class="back" href="${back.href}">${back.label}</a>` : ""}<a class="go" href="/">${home}</a>`, COMPASS), {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * What every visitor gets while the server can't use its sign-in data (src/server/auth-store.ts authStoreFailed): a calm
 * "back in a moment" in the same look, that tries again by itself; an API call gets the same in a sentence. Never why:
 * the server log tells the owner. Still a 503 (with Retry-After), so a new release in this state is never switched to.
 */
function backSoon(request: NextRequest): NextResponse {
  const headers = { "Cache-Control": "no-store", "Retry-After": "30" };
  if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Fuobe will be back in a moment. Please try again shortly." }, { status: 503, headers });
  const html = plainPage("Back in a moment", "Fuobe is getting ready. This page tries again by itself.", '<a class="go" href="">Try again</a>', CLOCK, 30);
  return new NextResponse(html, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
}

/** The page plain404 and backSoon show: the heading, a line, the buttons, and an icon; `refresh` reloads it after that many seconds. */
function plainPage(title: string, text: string, nav: string, icon: string, refresh?: number): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}<title>${title} · Fuobe</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><script>try{var t=localStorage.getItem("theme");if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.className="dark"}catch(e){}</script><style>
:root{color-scheme:light;--bg:#fff;--fg:#1e1e1f;--muted:#6e6e71;--line:#e8e8e9;--brand:#5d4bdb;--faint:#efedfc}
.dark{color-scheme:dark;--bg:#121213;--fg:#fafafb;--muted:#a9a9ab;--line:rgba(255,255,255,.14);--brand:#6a5ee7;--faint:#25223d}
body{margin:0;min-height:100svh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:16px}header a{display:inline-flex;align-items:center;gap:8px;color:inherit;text-decoration:none;font-weight:600;font-size:16px}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;box-sizing:border-box;width:100%;max-width:520px;margin:0 auto;padding:24px 24px 12vh;text-align:center}
h1{margin:20px 0 0;font:400 34px/1.15 "Instrument Serif",ui-serif,Georgia,"Times New Roman",serif;text-wrap:balance}
p{margin:8px 0 0;color:var(--muted);text-wrap:pretty}nav{margin-top:28px;display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
nav a{display:inline-flex;align-items:center;height:36px;padding:0 16px;border-radius:999px;text-decoration:none;font-weight:500;font-size:14px}
.go{background:var(--brand);color:#fff}.back{border:1px solid var(--line);color:var(--fg)}a:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.mark{display:grid;place-items:center;width:48px;height:48px;border-radius:16px;background:var(--faint);color:var(--brand)}
</style></head><body><header><a href="/">${LOGO}<span>Fuobe</span></a></header><main><span class="mark" aria-hidden="true">${icon}</span><h1>${title}</h1><p>${text}</p><nav>${nav}</nav></main></body></html>`;
}

/** The Fuobe mark (src/app/icon.svg), the 404's compass (lucide's Compass, as NotFoundState shows) and backSoon's clock (lucide's Clock). */
const LOGO =
  '<svg width="24" height="24" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#5d4bdb"/><g transform="translate(5.5 5.5) scale(0.875)" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="m12.296 3.464 3.02 3.956"/><path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3z"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m6.18 5.276 3.1 3.899"/></g></svg>';
const COMPASS =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/></svg>';
const CLOCK =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

const behindHttps = (request: NextRequest) => request.nextUrl.protocol === "https:";

/** A dead link's section: the way back to it, and what is missing when the link names a stored item. */
const SECTIONS: { prefix: string; label: string; missing?: string; why?: string }[] = [
  { prefix: "/apps", label: "Browse apps", missing: "This app isn’t here", why: "It may have a new name. Browse all apps to find it." },
  { prefix: "/canvas", label: "Back to Canvas", missing: "This canvas isn’t here" },
  { prefix: "/cinema", label: "Back to Cinema", missing: "This project isn’t here" },
  { prefix: "/shorts", label: "Back to Shorts", missing: "This session isn’t here" },
  { prefix: "/ads", label: "Back to Ads", missing: "This brand isn’t here" },
  { prefix: "/elements", label: "All elements", missing: "This element isn’t here" },
  { prefix: "/faceless", label: "Back to Faceless", missing: "This channel isn’t here" },
  { prefix: "/explainer", label: "Back to Explainer", missing: "This explainer isn’t here" },
  { prefix: "/content-factory", label: "Back to Content Factory", missing: "This series isn’t here" },
  { prefix: "/character-swap", label: "Back to Character Swap", missing: "This project isn’t here" },
  { prefix: "/layers", label: "Back to Layers", missing: "This project isn’t here" },
  { prefix: "/assist", label: "Back to Assist", missing: "This project isn’t here" },
  { prefix: "/audio", label: "Back to Audio" },
  { prefix: "/video-tools", label: "Back to Video tools" },
  { prefix: "/upscale", label: "Back to Upscale" },
];

const notFound = (request: NextRequest) => {
  if (!behindHttps(request)) return NextResponse.rewrite(new URL("/_fuobe-not-found", request.url), { status: 404 });
  const s = SECTIONS.find((x) => request.nextUrl.pathname.startsWith(`${x.prefix}/`));
  const back = s && { href: s.prefix, label: s.label };
  return s?.missing
    ? plain404(s.missing, s.why ?? "It may have been deleted, or the link is incomplete.", back)
    : plain404("This page isn’t here", "It may have moved. Head back and find it from there.", back);
};

const shareGone = (request: NextRequest) =>
  behindHttps(request)
    ? plain404("This link isn’t available", "It may have expired or been turned off, or what it shared was removed. Ask the person who sent it for a new link.", undefined, "Make your own with Fuobe")
    : NextResponse.rewrite(new URL("/s/gone", request.url), { status: 404 });

/** Share pages and their files: never indexed, and the token never leaks to another site in a Referer. */
const SHARE_HEADERS = { "X-Robots-Tag": "noindex, nofollow, noarchive", "Referrer-Policy": "no-referrer" };

/** The owner: the install password's session, or an API token. */
const signedIn = (request: NextRequest) => validSession(sessionCookieOf(request)) || validToken(request.headers.get("authorization"));

/** The owner, an account (only while public sign-up is on), or null (a guest). */
function viewerOf(request: NextRequest, open: boolean): Viewer | null {
  const session = sessionViewer(sessionCookieOf(request));
  if (session?.kind === "owner" || validToken(request.headers.get("authorization"))) return { kind: "owner" };
  return open && session?.kind === "account" ? session : null;
}

const guestHeaders = { [GUEST_HEADER]: "1", "Cache-Control": "no-store" };

/** Price checks a guest (per address) or an account may send a minute: free, but each one plans a run. A page sends far fewer. */
const PRICE_CHECKS_PER_MINUTE = 120;

/**
 * Without a trusted proxy (FUOBE_TRUST_PROXY) every guest is one shared key: they share a budget ten times larger, so
 * one busy page or script can't stop every other guest's prices, and the 429 says how to give each visitor their own.
 */
const SHARED_PRICE_CHECKS_PER_MINUTE = 10 * PRICE_CHECKS_PER_MINUTE;
const SHARED_GUEST = `guest:${LoginGuard.DIRECT}`;

/** A guest's or an account's price check, within its budget (the owner's are never counted). */
function priceCheck(request: NextRequest, who: string): NextResponse {
  const shared = who === SHARED_GUEST;
  const r = hit(`price:${who}`, shared ? SHARED_PRICE_CHECKS_PER_MINUTE : PRICE_CHECKS_PER_MINUTE, 60_000);
  if (r.ok) return pass(request);
  const hint = shared ? " Behind a reverse proxy? Set FUOBE_TRUST_PROXY=1 so each visitor gets their own limit." : "";
  return NextResponse.json({ error: `Too many price checks. Try again in a minute.${hint}` }, { status: 429, headers: { "Retry-After": String(r.retryAfterS), "Cache-Control": "no-store" } });
}

/**
 * A guest (public sign-up on, signed out): every page and the catalog reads, the owner's lists
 * empty, the rest of the library 401, and every change 401 (the client offers to sign up), but
 * where signing up wouldn't let it in: Assist (assistOwner) and the tools an account's own GPU or
 * key doesn't run (ownGpuTool) get the account's answer.
 */
function guest(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const { method } = request;
  // Live edit runs on a GPU of one's own: signing up is the next step (the node file's download is open).
  const live = liveRoute(pathname);
  if (live && live !== "nodes") return NextResponse.json({ error: GUEST_RUN_MESSAGE }, { status: 401, headers: guestHeaders });
  if (method === "GET" || method === "HEAD") return readAsGuest(request, false);
  if (isPriceCheck(method, pathname, search)) return priceCheck(request, `guest:${LoginGuard.clientKey(request.headers)}`);
  if (isAssistChange(method, pathname)) return assistOwner();
  if (anyoneMayReport(method, pathname)) return pass(request);
  // What an account may send, the library, the owner's settings and the studios' runs: signing up is the next step.
  if (!accountMayChange(method, pathname, search) && !isLibraryChange(method, pathname) && !ownerOnly(method, pathname) && !ownGpuRun(method, pathname) && !accountProjectRoute(pathname)) return ownGpuTool();
  return NextResponse.json({ error: GUEST_RUN_MESSAGE }, { status: 401, headers: guestHeaders });
}

/** A tool that doesn't run on an account's own GPU or key yet, for a guest or an account: one answer (no sign-up card). */
const ownGpuTool = () => NextResponse.json({ error: OWN_GPU_TOOL_MESSAGE, code: "own-gpu-tool" }, { status: 403, headers: { "Cache-Control": "no-store" } });

/** Any change to Assist by a visitor (a guest, or an account with or without a GPU): one answer, which the Assist pages also show. */
const assistOwner = () => NextResponse.json({ error: ASSIST_OWNER_MESSAGE, code: "assist-owner" }, { status: 403, headers: { "Cache-Control": "no-store" } });

/**
 * A read by a guest or an account: pages and catalog reads go through, the owner's lists come back
 * empty, and the rest of the owner's library is refused (401 for a guest, who can sign up; 403 for an account).
 */
function readAsGuest(request: NextRequest, isAccount: boolean): NextResponse {
  const read = guestRead(request.nextUrl.pathname);
  if (read.kind === "pass") return pass(request);
  if (read.kind === "filtered") {
    const headers = new Headers(request.headers);
    headers.set(GUEST_HEADER, "1");
    return NextResponse.next({ request: { headers } });
  }
  if (read.kind === "empty") return NextResponse.json(read.body, { headers: guestHeaders });
  // No content, not a 404: the browser logs no error, and the client looks again in 5 minutes (streamResponse).
  if (read.kind === "none") return new NextResponse(null, { status: 204, headers: guestHeaders });
  if (isAccount) return NextResponse.json({ error: ACCOUNT_LIBRARY_MESSAGE }, { status: 403, headers: { "Cache-Control": "no-store" } });
  return NextResponse.json({ error: GUEST_LIBRARY_MESSAGE }, { status: 401, headers: guestHeaders });
}

/**
 * An account sees the owner's studio as a guest does: every page, the catalog, and none of the
 * owner's library or projects (hidden, and every change to them refused). Its own runs are its own
 * (accountGeneration, accountOwnRead: only what it made). Install-wide settings, keys and tokens are
 * the owner's, and it never runs on the owner's cloud keys or GPU: with its own ComfyUI connected
 * ("Your GPU") or its own fal.ai or Replicate key ("Your keys") the studios' generations run there,
 * and anything else that would reach a model is refused ("Connect your GPU" until it has one).
 * Assist is the owner's (isAssistChange): a GPU or a key doesn't change that.
 */
const notYours = () => NextResponse.json({ error: ACCOUNT_LIBRARY_MESSAGE }, { status: 403, headers: { "Cache-Control": "no-store" } });

function account(request: NextRequest, who: Account): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (ownerOnly(request.method, pathname)) {
    return NextResponse.json({ error: "These settings aren't part of your account." }, { status: 403 });
  }
  // Live edit: only on its own GPU, its masters in its own files, no Library.
  const live = liveRoute(pathname);
  if (live) {
    const may = accountLive(live, who.gpu ? (who.gpu.mode === "computer" ? "computer" : "link") : null);
    if (may === "library") return NextResponse.json({ error: LIBRARY_MESSAGE, code: "library" }, { status: 403 });
    if (may === "connect-gpu") return NextResponse.json({ error: CONNECT_GPU_MESSAGE, code: "connect-gpu" }, { status: 403, headers: { [CONNECT_GPU_HEADER]: "1" } });
    return pass(request);
  }
  // Its own runs and their files: only what it made.
  const gen = accountGeneration(request.method, pathname);
  if (gen !== undefined) return generationAccount(gen) === who.id ? pass(request) : notYours();
  const file = request.method === "GET" || request.method === "HEAD" ? /^\/api\/files\/(.+)$/.exec(pathname)?.[1] : undefined;
  if (file !== undefined) return fileAccount(safeDecode(file)) === who.id ? pass(request) : notYours();
  // A tool's projects, kept per account: the route answers with its own only.
  if (accountProjectRoute(pathname)) return pass(request);
  // A tool's page for one of them (/shorts/<id>): its own, else a real 404 (never the owner's or another account's).
  const record = request.method === "GET" || request.method === "HEAD" ? recordForPath(pathname) : null;
  const own = record ? accountRecordExists(record, who.id) : null;
  if (own !== null) return own ? NextResponse.next() : notFound(request);
  if (request.method === "GET" || request.method === "HEAD") return accountOwnRead(pathname) ? pass(request) : readAsGuest(request, true);
  if (isPriceCheck(request.method, pathname, search)) return priceCheck(request, `account:${who.id}`);
  if (accountMayChange(request.method, pathname, search)) return pass(request);
  if (isAssistChange(request.method, pathname)) return assistOwner();
  if (isLibraryChange(request.method, pathname)) return NextResponse.json({ error: LIBRARY_MESSAGE, code: "library" }, { status: 403 });
  // A tool its own GPU or key wouldn't run says so first: "Connect your GPU" only for what a GPU or a key unlocks.
  if (!ownGpuRun(request.method, pathname)) return ownGpuTool();
  // Neither its own GPU nor its own key: nothing it could run on. (Which one a run needs, the route says.)
  // With hosted runs on (FUOBE_HOSTED_RUNS=1), a run in the studios may go to this install's GPUs: the route decides.
  const hosted = hostedRunsOn() && request.method === "POST" && pathname === "/api/generations";
  if (!who.gpu && !hasCloudKey(who) && !hosted) return NextResponse.json({ error: CONNECT_GPU_OR_KEY_MESSAGE, code: "connect-gpu" }, { status: 403, headers: { [CONNECT_GPU_HEADER]: "1" } });
  return pass(request);
}

const tooMany = (seconds: number) =>
  new NextResponse("Too many wrong links. Try again in a minute.", { status: 429, headers: { ...SHARE_HEADERS, "Retry-After": String(seconds) } });

/**
 * A share link (/s/<token>, /s/<token>/f/<file>): open without a session when the token is a live
 * share whose result, folder or project still exists, else a 404 (a "link unavailable" page). A
 * live link always opens: wrong tokens count against ShareGuard, which answers them 429 past its
 * budget and locks out only a client it can tell apart (never everyone, never the signed-in owner).
 * The page and the files route check the token again, and the files route serves only files that
 * page shows. A page view by a visitor (a browser's GET, not a prefetch, a HEAD or a link-preview
 * bot) is passed on to the page as SHARE_VIEW_HEADER, which the page counts.
 */
function openShare(request: NextRequest, token: string, file: boolean): NextResponse {
  const owner = authEnabled() && signedIn(request);
  const guard = shareGuard();
  const key = LoginGuard.clientKey(request.headers);
  if (!owner) {
    const wait = guard.blockedFor(key);
    if (wait > 0) return tooMany(Math.ceil(wait / 1000));
  }
  const row = findShare(token);
  let res: NextResponse;
  if (!row || !shareTargetExists(row)) {
    if (!row && !owner) {
      const spent = guard.saturated();
      guard.miss(key, token, key === LoginGuard.DIRECT);
      if (spent) return tooMany(60);
    }
    res = shareGone(request);
  } else {
    // Only the proxy says what counts as a view: a visitor can't send the header themselves.
    const headers = new Headers(request.headers);
    headers.delete(SHARE_VIEW_HEADER);
    if (!file && !owner && countsAsView(request.method, request.headers)) headers.set(SHARE_VIEW_HEADER, "1");
    res = NextResponse.next({ request: { headers } });
  }
  for (const [k, v] of Object.entries(SHARE_HEADERS)) res.headers.set(k, v);
  return res;
}

/**
 * An old `/audio?mode=music` link (any case: ?mode=Music too): that mode's own page, without the mode in its query.
 * An unknown mode lands on the hub's 404 (unknownHubMode). An old link to the mode the hub opened on before, known by
 * the params only that mode reads (`/audio?voice=…` is Speech's, FORMER_HOME), opens that mode with its whole query.
 */
function hubModeLink(request: NextRequest): URL | null {
  const kind = /^\/(audio|video-tools|upscale)\/?$/.exec(request.nextUrl.pathname)?.[1] as HubKind | undefined;
  const sp = request.nextUrl.searchParams;
  const former = kind ? FORMER_HOME[kind] : undefined;
  if (kind && former && !sp.has("mode") && former.params.some((k) => sp.has(k))) {
    const url = new URL(modeHref(kind, former.mode), request.url);
    url.search = request.nextUrl.search;
    return url;
  }
  const mode = kind && sp.get("mode")?.trim().toLowerCase();
  if (!kind || !mode || !/^[a-z0-9-]+$/.test(mode)) return null;
  const url = new URL(modeHref(kind, mode), request.url);
  for (const [k, v] of sp) if (k !== "mode") url.searchParams.append(k, v);
  return url;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function proxy(request: NextRequest) {
  // Sign-in data that can't be used (the database, or an auth.json that couldn't be moved into it): nothing is served,
  // not even /login, so a new release in this state is never switched to and the studio is never open by mistake.
  // Visitors get a calm "back in a moment" (503); the server log says why. An auth.json that turns up after the move is
  // not this: it is set aside and the site keeps serving.
  if (authStoreFailed()) return backSoon(request);
  // DNS rebinding: a page whose own name now points at this machine. Every method, reads too. With a
  // password set the sign-in check below already stops it (the session cookie belongs to the real name).
  if (!authEnabled() && !hostAllowed(request.headers.get("host") ?? request.nextUrl.host)) {
    const host = request.headers.get("host") ?? request.nextUrl.host;
    return NextResponse.json(
      { error: `Blocked a request for ${host}, which isn't a local address. If that's how you reach Fuobe, add it to FUOBE_ALLOWED_ORIGINS (or set a password).` },
      { status: 403 },
    );
  }
  // Before the sign-in check: a password-less install needs this most.
  if (crossSite(request, request.nextUrl.host)) {
    return NextResponse.json({ error: "Blocked a request from another website. Use Fuobe from its own address (or add it to FUOBE_ALLOWED_ORIGINS)." }, { status: 403 });
  }
  const { pathname, search } = request.nextUrl;
  if (ADMIN_BEARER.test(request.headers.get("authorization") ?? "")) {
    return adminRoute(pathname)
      ? NextResponse.next()
      : NextResponse.json({ error: "An admin token only works on the admin API." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  // Share links are read-only and public, password or not: exactly a share's page and its files.
  const read = request.method === "GET" || request.method === "HEAD";
  const share = read && shareRoute(pathname);
  if (share) return openShare(request, share.token, !!share.file);
  // Any other /s/ link is no share: the same "link unavailable" 404 as an unknown token.
  if (read && pathname.startsWith("/s/")) {
    const res = shareGone(request);
    for (const [k, v] of Object.entries(SHARE_HEADERS)) res.headers.set(k, v);
    return res;
  }
  const hub = read && hubModeLink(request);
  if (hub) return NextResponse.redirect(hub);
  if (WORKER_BEARER.test(request.headers.get("authorization") ?? "")) {
    return workerRoute(pathname) ? NextResponse.next() : NextResponse.json({ error: "A worker's token only runs jobs." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!authEnabled()) return pass(request);
  if (OPEN.has(pathname)) return NextResponse.next();
  const open = publicSignup(request.headers.get("host") ?? request.nextUrl.host);
  const viewer = viewerOf(request, open);
  if (viewer?.kind === "owner") return pass(request);
  // A starter with no real cover yet is the owner's: anyone else gets a real 404, not its words.
  if ((viewer || open) && read && hiddenStarterPage(pathname)) return notFound(request);
  if (viewer?.kind === "account") return account(request, viewer.account);
  if (open) return guest(request);
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in, or send an API token as Authorization: Bearer fuobe_…" }, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="fuobe"' } });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except build assets and the public folder's own files: the favicon and app icons,
  // the demo samples, the preset covers, the examples pages load (public/examples), vendored scripts (the 3D viewer's meshopt decoder), the
  // motion templates' own type faces (public/fonts) and the
  // SVGs at the root. Generated SVGs under /api/files stay behind sign-in. The routes that take a file in a form
  // (/api/uploads, a Soul finish, a Layers render, a skill upload, an Assist source, an explainer document), and Split
  // soundtrack's mix export (a WAV in parts of 16 MB), make the same checks themselves (src/server/direct-gate.ts): the
  // proxy would hold the whole file in memory first. So do a computer's report of a finished job and its results
  // (src/app/api/gpu/computer/tasks), and live edit's kept master from a tab on its own computer (src/app/api/live/masters).
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico$|apple-icon\\.png$|samples/|previews/|examples/|vendor/|fonts/|api/uploads$|api/generations/[^/]+/finish$|api/layers/renders$|api/assist/skills/upload$|api/assist/projects/[^/]+/sources$|api/explainer/document$|api/audio-tools/export$|api/gpu/computer/tasks/[^/]+/(?:report|outputs/[^/]+)$|api/live/masters$|[^/]+\\.svg$).*)",
  ],
};
