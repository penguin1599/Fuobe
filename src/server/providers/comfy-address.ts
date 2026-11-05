import "server-only";
import dns from "node:dns/promises";
import net from "node:net";
import { addressHost, addressKind, refusedLine, refusedOnHosted, resolvesPrivateLine, TYPE_AN_ADDRESS } from "@/lib/page-place";
import { blockedForAccounts, selfAddresses } from "../remote-fetch";
import { savedSetting, settingSource } from "../settings";

/**
 * The owner's ComfyUI address on a hosted studio (the page says it isn't on the server's machine: lib/page-place.ts).
 * There, an address on this machine, link-local, or on a private network (unless FUOBE_ALLOW_PRIVATE_URLS) would make
 * the server call itself or its own network, never the owner's computer: the test answers why, and makes no request.
 * A name that leads to such an address is refused the same way. This steers the owner's own Settings (the route is the
 * owner's only); it is not a security boundary, and a request without the page's word is tested as before.
 */

export interface AddressRefusal {
  ok: false;
  code: "on-your-computer";
  detail: string;
}

const allowPrivate = () => process.env.FUOBE_ALLOW_PRIVATE_URLS === "1";

const refusal = (detail: string): AddressRefusal => ({ ok: false, code: "on-your-computer", detail });

type Resolve = (host: string) => Promise<string[]>;

const lookup: Resolve = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Should the server not test this ComfyUI address for a hosted page? `field`: comfyUrl or comfyIsolatedUrl; `typed`:
 * the value typed for the test, if any. Null: go on and test it.
 *  - Nothing typed and only the built-in address: there is nothing of the owner's to test.
 *  - Nothing typed and the address comes from COMFYUI_URL: tested as before (a GPU box that runs both).
 *  - A loopback, link-local, private or LAN address (typed or saved): refused, no request.
 *  - A name: looked up; any loopback, link-local, private or this machine's own address refuses it. A name that
 *    doesn't resolve goes on, and the test says it can't reach it. The answer never shows what it resolved to.
 */
export async function hostedAddressRefusal(field: "comfyUrl" | "comfyIsolatedUrl" | "worldcastUrl", typed: string | undefined, o: { resolve?: Resolve } = {}): Promise<AddressRefusal | null> {
  let url = typed?.trim() ?? "";
  if (!url) {
    const source = settingSource(field);
    if (source === "env") return null;
    if (source === "default") return field === "comfyUrl" ? refusal(TYPE_AN_ADDRESS) : null;
    url = savedSetting(field);
  }
  const kind = addressKind(url);
  if (kind === "invalid") return null;
  const host = addressHost(url);
  if (refusedOnHosted(kind, allowPrivate())) return refusal(refusedLine(kind, host));
  const bare = host.replace(/^\[|\]$/g, "");
  // An address literal the server won't call: one of this machine's own, or a reserved or private range.
  if (net.isIP(bare)) return blockedForAccounts(bare) ? refusal(refusedLine(selfAddresses().has(bare) ? "loopback" : "private", host)) : null;
  let addrs: string[];
  try {
    addrs = await (o.resolve ?? lookup)(bare);
  } catch {
    return null;
  }
  return addrs.some(blockedForAccounts) ? refusal(resolvesPrivateLine(host)) : null;
}
