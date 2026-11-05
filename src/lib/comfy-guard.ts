/**
 * Fuobe's guard for ComfyUI: one small custom node file that keeps every other website out while ComfyUI runs with
 * Fuobe's setting (--enable-cors-header <this site>). ComfyUI replaces its own cross-site check with that setting, so
 * without the guard any website the browser lets reach this computer could queue work on it, upload into it or stop it
 * (it couldn't read the answers). The guard puts the check back for every site but the one the setting names: a request
 * from a web page gets in only when the page is ComfyUI's own (same host) or that site. A program (no browser headers)
 * gets in as before, and so does every page while ComfyUI runs without the setting (ComfyUI's own check is on then). It
 * also answers GET /fuobe/guard, so the Fuobe tab can tell it is there.
 *
 * The Windows start file writes it into ComfyUI's custom_nodes folder; the other installs download it from the card.
 * Plain ASCII (the start file carries it as base64). Pure: the card, the start file and the tests share it.
 */

export const GUARD_FILE_NAME = "fuobe_guard.py";

/** Its version, as GET /fuobe/guard answers it. */
export const GUARD_VERSION = 1;

/**
 * The SHA-256 of GUARD_SOURCE (hex): the steps for an AI ("Set it up with my AI") check the downloaded file against it.
 * tests/ai-setup-guide.test.ts makes sure that it matches.
 */
export const GUARD_SHA256 = "702ba491e91165d693f9665744925e2a8a619f4ef6bd4aa893b97e378191e701";

export const GUARD_SOURCE = `"""Fuobe's guard for ComfyUI.

Started with --enable-cors-header, ComfyUI lets the website it names use it from your browser, but it also stops
turning away requests from every other website. This file puts that check back: a request from a web page gets in only
when the page is ComfyUI's own or the site the setting names. Programs (no browser) get in as before, and nothing
changes while ComfyUI runs without the setting. It adds no nodes, reads no files and sends nothing anywhere.
To remove it, delete this file and restart ComfyUI.
"""
import logging
from urllib.parse import urlsplit

from aiohttp import web

import server
from comfy.cli_args import args

FUOBE_GUARD = ${GUARD_VERSION}
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_told = set()


def _allowed():
    value = (getattr(args, "enable_cors_header", None) or "").strip().rstrip("/").lower()
    return value if value and value != "*" else None


def _same_host(origin, host):
    try:
        o = urlsplit(origin)
        h = urlsplit("//" + (host or "").strip().lower())
        if not o.hostname or not h.hostname or o.hostname != h.hostname:
            return False
        return o.port is None or h.port is None or o.port == h.port
    except ValueError:
        return False


def _refuse(why):
    if why not in _told and len(_told) < 50:
        _told.add(why)
        logging.warning("[Fuobe guard] Turned away a request from %s", why)
    return web.Response(status=403)


@web.middleware
async def fuobe_guard(request, handler):
    allowed = _allowed()
    if allowed is not None:
        origin = request.headers.get("Origin")
        if origin is not None:
            o = origin.strip().rstrip("/").lower()
            if o != allowed and not _same_host(o, request.headers.get("Host")):
                return _refuse(origin[:120])
        elif request.headers.get("Sec-Fetch-Site", "").lower() in ("cross-site", "same-site"):
            return _refuse("another website")
    return await handler(request)


async def fuobe_guard_status(request):
    return web.json_response({"guard": FUOBE_GUARD})


def _install():
    instance = getattr(server.PromptServer, "instance", None)
    if instance is None:
        return
    app = instance.app
    if any(getattr(m, "__name__", "") == "fuobe_guard" for m in app.middlewares):
        return
    try:
        app.middlewares.insert(0, fuobe_guard)
    except RuntimeError:
        logging.warning("[Fuobe guard] ComfyUI had already started, so the guard is off. Restart ComfyUI.")
        return
    instance.routes.get("/fuobe/guard")(fuobe_guard_status)
    if _allowed():
        logging.info("[Fuobe guard] Only %s and ComfyUI's own page may use ComfyUI from a browser.", _allowed())


_install()
`;

/** The guard as base64 (the start file writes it with PowerShell). */
export function guardBase64(): string {
  if (!/^[\x00-\x7f]*$/.test(GUARD_SOURCE)) throw new Error("The guard must be plain ASCII");
  return btoa(GUARD_SOURCE);
}

/** Its answer at /fuobe/guard: there, and this version or newer. */
export const isGuard = (answer: unknown): boolean => !!answer && typeof answer === "object" && Number((answer as { guard?: unknown }).guard) >= GUARD_VERSION;
