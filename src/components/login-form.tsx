"use client";

import { Eye, EyeOff, Loader2, Lock, LogOut, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { announceAuthChange, rememberViewer, signOut, useStatus, useViewer } from "@/lib/api";
import { safeNext } from "@/lib/safe-redirect";
import { cn } from "@/lib/utils";

/** "signup" and "login" are accounts (public sign-up); "owner" is the install password. */
type Mode = "signup" | "login" | "owner";

/** On a public site the owner's sign-in isn't advertised: production builds open it at /login?owner=1. */
const OWNER_LINK = process.env.NODE_ENV !== "production";

const COPY: Record<Mode, { title: string; lead: string; button: string }> = {
  signup: { title: "Create your free account", lead: "Just an email and a password. You're in within seconds.", button: "Sign up" },
  login: { title: "Welcome back", lead: "Log in with your email and password.", button: "Log in" },
  owner: { title: "Welcome back", lead: "This Fuobe studio is password protected.", button: "Sign in" },
};

export function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const viewer = useViewer();
  const status = useStatus();
  const open = !!viewer.data?.publicSignup;
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = !open ? "owner" : (chosen ?? (params.get("owner") === "1" ? "owner" : params.get("signup") === "1" ? "signup" : "login"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The email is taken (409): offer to log in with it instead.
  const [taken, setTaken] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get("next"), typeof window === "undefined" ? "http://localhost" : window.location.origin);

  // Sign up and log in have their own tab title (the page's metadata says "Sign in" for both).
  useEffect(() => {
    if (!viewer.isPending) document.title = `${mode === "signup" ? "Sign up" : mode === "login" ? "Log in" : "Sign in"} · Fuobe`;
  }, [mode, viewer.isPending]);

  /** The other form; the URL says which (?signup=1), so a reload or a shared link opens the same one. */
  const choose = (m: Mode) => {
    setChosen(m);
    setError(null);
    setTaken(false);
    if (m === "owner") return;
    const q = new URLSearchParams(params.toString());
    if (m === "signup") q.set("signup", "1");
    else q.delete("signup");
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };

  // Hosted runs (this studio's GPUs take an account's runs): a new account isn't sent to connect a GPU first.
  const hosted = !!status.data?.viewer?.hosted;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const url = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const body = mode === "owner" ? { password } : { email, password };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      // Only a page on this site: never bounce to another origin after signing in.
      const after = safeNext(params.get("next"), window.location.origin);
      // A new account connects its GPU first (the pre-flight board), then goes on to where it was headed. Not back to
      // Settings' Your GPU (its Sign up free): the welcome page is that same choice.
      const q = new URLSearchParams({ welcome: "1" });
      if (after !== "/" && !after.startsWith("/connect") && !after.startsWith("/settings#your-gpu")) q.set("next", after);
      // "Set it up with my AI" (a guest's sign-up from it): the welcome page opens with it.
      const nextUrl = new URL(after, window.location.origin);
      if (nextUrl.pathname === "/connect" && nextUrl.searchParams.get("setup") === "ai") q.set("setup", "ai");
      // With hosted runs on, a GPU of its own is optional: straight back to where it was.
      const dest = mode === "signup" && !hosted ? new URL(`/connect?${q}`, window.location.origin).toString() : after;
      rememberViewer(mode === "owner" ? "owner" : "account");
      announceAuthChange();
      window.location.assign(dest);
      return;
    }
    setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? (mode === "signup" ? "Something went wrong. Try again in a moment." : "We couldn't log you in. Try again in a moment."));
    setTaken(mode === "signup" && res.status === 409);
    setBusy(false);
  };

  if (viewer.isPending) {
    return (
      <div className="grid h-72 w-full max-w-sm place-items-center rounded-2xl border bg-background shadow-soft">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Already signed in as an account: say so, rather than a form that would sign in again.
  const account = viewer.data?.signedIn && !viewer.data.owner ? viewer.data.account : undefined;
  if (account && params.get("owner") !== "1") {
    return (
      <div className="w-full max-w-sm animate-fade-up rounded-2xl border bg-background p-7 shadow-soft">
        <div className="mb-5 grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
          <Sparkles className="size-5" />
        </div>
        <h1 className="font-heading text-[28px] leading-tight">You&apos;re signed in</h1>
        <p className="mt-1 text-[13px] break-words text-muted-foreground">As {account.email}.</p>
        <Button asChild className="mt-5 h-11 w-full">
          <Link href={next}>Continue</Link>
        </Button>
        <Button variant="ghost" className="mt-2 h-10 w-full text-muted-foreground" onClick={() => void signOut()}>
          <LogOut /> Sign out
        </Button>
      </div>
    );
  }

  const copy = COPY[mode];
  const short = mode === "signup" && password.length > 0 && password.length < 8;
  return (
    <form onSubmit={submit} className="w-full max-w-sm animate-fade-up rounded-2xl border bg-background p-7 shadow-soft">
      <div className="mb-5 grid size-11 place-items-center rounded-xl bg-primary text-primary-foreground">
        {mode === "signup" ? <Sparkles className="size-5" /> : <Lock className="size-5" />}
      </div>
      <h1 className="font-heading text-[28px] leading-tight">{copy.title}</h1>
      <p className="mt-1 text-[13px] text-muted-foreground">{copy.lead}</p>
      {mode !== "owner" && (
        <Input
          type="email"
          id="login-email"
          name="email"
          aria-label="Email"
          autoFocus
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-5 h-11"
          aria-invalid={!!error}
        />
      )}
      <div className={cn("relative", mode === "owner" ? "mt-5" : "mt-2.5")}>
        <Input
          type={shown ? "text" : "password"}
          id="login-password"
          name="password"
          aria-label="Password"
          autoFocus={mode === "owner"}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder={mode === "signup" ? "Password (at least 8 characters)" : "Password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-11 pr-11"
          aria-invalid={!!error || short}
          aria-describedby={short ? "pw-hint" : undefined}
        />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label="Show password"
          aria-pressed={shown}
          className="absolute top-1/2 right-1.5 grid size-8 -translate-y-1/2 place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {short && (
        <p id="pw-hint" className="mt-2 text-[13px] text-destructive">
          Use at least 8 characters ({8 - password.length} more)
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {taken ? error.replace(/\s*Log in instead\.?$/, "") : error}
          {taken && (
            <>
              {" "}
              <button type="button" className="font-medium text-foreground underline underline-offset-4" onClick={() => choose("login")}>
                Log in instead
              </button>
            </>
          )}
        </p>
      )}
      <Button type="submit" className="mt-4 h-11 w-full" disabled={!password || (mode !== "owner" && !email) || (mode === "signup" && password.length < 8) || busy}>
        {busy && <Loader2 className="animate-spin" />} {copy.button}
      </Button>
      {mode === "signup" && (
        <p className="mt-3 text-center text-[12px] text-muted-foreground">
          By signing up you agree to our{" "}
          <Link href="/terms" className="underline underline-offset-2 hover:text-foreground">
            Terms
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
            Privacy Policy
          </Link>
          .
        </p>
      )}
      {open && (
        <div className="mt-4 space-y-1.5 text-center text-[13px] text-muted-foreground">
          {mode === "signup" ? (
            <p>
              Have an account?{" "}
              <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => choose("login")}>
                Log in
              </button>
            </p>
          ) : (
            <p>
              New here?{" "}
              <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => choose("signup")}>
                Create a free account
              </button>
            </p>
          )}
          <p>
            <Link href={next} className="underline-offset-4 hover:underline">
              Keep browsing as a guest
            </Link>
            {OWNER_LINK && mode !== "owner" && (
              <>
                {" · "}
                <button type="button" className="underline-offset-4 hover:underline" onClick={() => choose("owner")}>
                  Studio owner
                </button>
              </>
            )}
          </p>
        </div>
      )}
    </form>
  );
}
