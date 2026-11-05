"use client";

import { Copy } from "lucide-react";
import { Fragment } from "react";
import { copyWithToast } from "@/lib/clipboard";
import { rememberedComfy } from "./computer-runtime";

/**
 * A ComfyUI's address for "Run from anywhere with a link" (Your GPU): the server calls it, so it needs a public one (a
 * tunnel in front of the ComfyUI on the person's computer), never one on their computer or network. Finding the
 * ComfyUI on this computer is the other option's job (this-computer.tsx); nothing here looks for one.
 */

/** On this computer or its network: the browser can reach it, the server can't. */
export function isLocalAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".lan") || !host.includes(".")) return true;
  if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const v4 = host.split(".").map(Number);
  if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n))) return false;
  const [a, b] = v4;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export const gib = (bytes?: number) => (bytes ? `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)} GB` : undefined);

/** The command that gives a ComfyUI on this computer a web address (a Cloudflare quick tunnel; nothing to sign up for). */
export const tunnelCommand = (port: number) => `cloudflared tunnel --url http://localhost:${port}`;

function CopyLine({ text, label }: { text: string; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-2">
      <code aria-label={label} className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap">
        {text}
      </code>
      <button
        type="button"
        onClick={() => void copyWithToast(text)}
        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
        aria-label={`Copy ${label}`}
      >
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

const RELEASES = "https://github.com/cloudflare/cloudflared/releases/latest/download";

/**
 * Where to get cloudflared, Cloudflare's free app that gives a program on a computer a web address: the Mac and Windows
 * installers (signed by Cloudflare; they put it where Terminal and Command Prompt find it), and Cloudflare's own page for
 * Linux. A file starts downloading in place; the page opens in a new tab.
 */
const CLOUDFLARED: { label: string; href: string; page?: boolean }[] = [
  { label: "Mac", href: `${RELEASES}/cloudflared-arm64.pkg` },
  { label: "Intel Mac", href: `${RELEASES}/cloudflared-amd64.pkg` },
  { label: "Windows", href: `${RELEASES}/cloudflared-windows-amd64.msi` },
  { label: "Linux", href: "https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/#linux", page: true },
];

/**
 * How to give a ComfyUI a web address, in three steps on the computer it runs on: install cloudflared, run its one
 * command (ComfyUI's usual port, or the one last found), paste the address it shows. No words a visitor has to look up.
 */
export function TunnelSteps() {
  const port = rememberedComfy()?.port ?? 8188;
  return (
    <div className="space-y-2 rounded-xl border p-3 text-[13px]">
      <p className="font-medium">Give your ComfyUI a web address</p>
      <p className="text-[12px] text-muted-foreground">Cloudflare&apos;s free app, cloudflared, gives it one. On the computer that runs ComfyUI:</p>
      <ol className="list-decimal space-y-2 pl-5 text-[12px] text-muted-foreground">
        <li>
          Install cloudflared for{" "}
          {CLOUDFLARED.map((d, i) => (
            <Fragment key={d.label}>
              {i > 0 && (i === CLOUDFLARED.length - 1 ? " or " : ", ")}
              <a href={d.href} {...(d.page && { target: "_blank", rel: "noreferrer" })} className="font-medium text-brand-text underline-offset-4 hover:underline">
                {d.label}
              </a>
            </Fragment>
          ))}
          .
        </li>
        <li className="space-y-1.5">
          <span className="block">Open Terminal (on Windows, Command Prompt), paste this and press Enter:</span>
          <CopyLine text={tunnelCommand(port)} label="the command" />
        </li>
        <li>Paste the web address it shows, ending in trycloudflare.com, in the box below. Keep that window open: the address works while it runs.</li>
      </ol>
      <p className="text-[11px] text-muted-foreground">
        Does your ComfyUI&apos;s own address end in a number other than {port}? Put that number in the command in place of {port}.
      </p>
    </div>
  );
}
