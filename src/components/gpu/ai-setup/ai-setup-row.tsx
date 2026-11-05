"use client";

import { BotMessageSquare, ChevronRight } from "lucide-react";
import Link from "next/link";
import { signInHref } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * "Set it up with my AI": the row above the ways to connect a GPU. An account opens the setup with its AI (`onOpen` in
 * place, or `href`: the /connect page); a guest signs up first and comes back to it. "Fix it with my AI" when a GPU is
 * saved but doesn't answer.
 */

/** Where the setup opens as a page of its own (a reload or a closed dialog never loses it). */
export const AI_SETUP_HREF = "/connect?setup=ai";

const ROW = "flex w-full items-center gap-3 rounded-2xl border bg-background p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

function Body({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-faint text-brand-text">
        <BotMessageSquare className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{title}</span>
        <span className="block text-[12px] text-muted-foreground">{sub}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </>
  );
}

export function AiSetupRow({ fix, onOpen, href, guest, className }: { fix?: boolean; onOpen?: () => void; href?: string; guest?: boolean; className?: string }) {
  const title = fix ? "Fix it with my AI" : "Set it up with my AI";
  if (guest)
    return (
      <Link href={signInHref("signup", AI_SETUP_HREF)} aria-label={title} className={cn(ROW, className)}>
        <Body title={title} sub="Sign up free, then your AI does the steps." />
      </Link>
    );
  const sub = "ChatGPT, Claude or a coding agent does the steps. Fuobe checks each one.";
  if (href)
    return (
      <Link href={href} aria-label={title} className={cn(ROW, className)}>
        <Body title={title} sub={sub} />
      </Link>
    );
  return (
    <button type="button" onClick={onOpen} aria-label={title} className={cn(ROW, className)}>
      <Body title={title} sub={sub} />
    </button>
  );
}
