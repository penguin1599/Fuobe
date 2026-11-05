"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Cloud, Cpu, ExternalLink, Info, Layers, Link2, Loader2, RefreshCw, Scale } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConnectChoice, OwnerComfyWhere, WorldcastField } from "@/components/gpu/connect-choice";
import { WorkersChip } from "@/components/workers-admin";
import { usePagePlace } from "@/components/gpu/use-local-comfy";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PLACEHOLDER_SETTING, placeholdersOn } from "@/lib/demo-mode";
import { AccountsChip } from "@/components/accounts-admin";
import { ConnectField, useSettings, type PublicSetting } from "@/components/connect-field";
import { GetStarted } from "@/components/get-started";
import { AboutLinks } from "@/components/owner-settings";
import { LlmProviderSettings } from "@/components/llm-provider-settings";
import { LoraSettings } from "@/components/lora-settings";
import { useStatus, type StatusInfo } from "@/lib/api";
import { WORKFLOWS_ON_GITHUB } from "@/lib/comfy-install";
import { AI_TOOLKIT_REPO, connectionSummary, DEFAULT_AI_TOOLKIT_URL, ENGINE_MODE_LABEL, FAL_KEYS_URL, showFirstRun } from "@/lib/connections";
import { cn } from "@/lib/utils";
import { ConnectorSettings } from "@/components/assist/connectors-settings";
import { NotificationSettings } from "@/components/notification-settings";
import { SecuritySettings } from "@/components/security-settings";
import { radioKeys, radioTab } from "@/components/studio/radio-keys";

function Section({
  id,
  title,
  description,
  inactive,
  children,
}: {
  id: string;
  title: string;
  description: React.ReactNode;
  /** Shown when the current engine mode doesn't use this section. */
  inactive?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="grid scroll-mt-28 grid-cols-[minmax(0,1fr)] gap-6 border-b py-8 last:border-b-0 md:scroll-mt-20 md:grid-cols-[260px_minmax(0,1fr)]">
      <div className="min-w-0">
        <h2 id={`${id}-title`} className="group flex items-center gap-1.5 text-[15px] font-semibold">
          {title}
          <a href={`#${id}`} aria-label={`Link to ${title}`} className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100">
            <Link2 className="size-3.5" />
          </a>
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        {inactive && <p className="mt-2 inline-flex rounded-md bg-muted px-2 py-1 text-[12px] text-muted-foreground">{inactive}</p>}
      </div>
      <div className={cn("min-w-0 space-y-5", inactive && "opacity-55")}>{children}</div>
    </section>
  );
}

const ENGINE_MODES = [
  {
    value: "both",
    title: "Open source + paid APIs",
    icon: Layers,
    body: "Every studio gets a Cloud / Open source switch. Use frontier paid models when you want them, your own GPU when you don't.",
    needs: "A fal.ai or Replicate key and/or a ComfyUI server",
  },
  {
    value: "open",
    title: "Open source only",
    icon: Cpu,
    body: "Only open-weight models on your ComfyUI server. Paid models are hidden and blocked on the server, and nothing is sent to paid APIs.",
    needs: "A ComfyUI server",
  },
  {
    value: "cloud",
    title: "Paid APIs only",
    icon: Cloud,
    body: "Only hosted frontier models (Nano Banana, Seedance, Kling, Veo…). No GPU needed; open-source models are hidden.",
    needs: "A fal.ai or Replicate key",
  },
] as const;

function EngineModePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Engine mode" className="grid gap-2 lg:grid-cols-3">
      {ENGINE_MODES.map((m) => {
        const active = value === m.value;
        return (
          <button
            key={m.value}
            role="radio"
            aria-checked={active}
            onClick={() => !active && onChange(m.value)}
            className={cn(
              "flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-accent",
              active && "border-primary bg-brand-faint hover:bg-brand-faint",
            )}
          >
            <span className="flex items-center gap-2">
              <span className={cn("grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground", active && "bg-primary text-primary-foreground")}>
                <m.icon className="size-4" />
              </span>
              <span className="text-[14px] font-medium">{m.title}</span>
              {active && <CheckCircle2 className="ml-auto size-4 text-brand-text" />}
            </span>
            <span className="text-[13px] leading-relaxed text-muted-foreground">{m.body}</span>
            <span className="text-[12px] text-muted-foreground">Needs: {m.needs}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A select whose trigger stays short ("Automatic") at any width; what the picked option does is
 * the line under it, so nothing is cut off.
 */
function ChoiceField({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string; hint: string }[];
  onChange: (v: string) => void;
}) {
  const picked = options.find((o) => o.value === value) ?? options[0];
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      <Select value={picked.value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="w-full sm:w-auto sm:min-w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">
        {picked.hint}
      </p>
    </div>
  );
}

/**
 * What's connected, at a glance and always in view: one chip per connection (green when it works,
 * each a link to its field), the engine mode and, for the owner, the accounts. Also opens the setup guide again.
 */
function StatusStrip({ status, onGuide, guideOpen }: { status?: StatusInfo; onGuide: () => void; guideOpen: boolean }) {
  const place = usePagePlace();
  return (
    <div className="sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-10 -mx-4 border-b bg-background/90 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 md:top-chrome">
      <nav aria-label="Connections" className="scrollbar-none -my-1 flex items-center gap-1.5 overflow-x-auto py-1">
        {status ? (
          <>
            {connectionSummary(status, place).map((c) => (
              <a
                key={c.id}
                href={c.href}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border bg-background px-2.5 text-[12px] whitespace-nowrap transition-colors hover:bg-accent",
                  c.unused && "opacity-60",
                )}
              >
                <span aria-hidden className={cn("size-1.5 rounded-full", c.ok ? "bg-success" : "bg-muted-foreground/50")} />
                <span className="font-medium">{c.label}</span>
                <span className="text-muted-foreground">{c.unused ? "Not used" : c.text}</span>
              </a>
            ))}
            <a href="#engine" className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 text-[12px] whitespace-nowrap transition-colors hover:bg-accent">
              <span className="text-muted-foreground">Engine</span>
              <span className="font-medium">{ENGINE_MODE_LABEL[status.engineMode]}</span>
            </a>
            <AccountsChip />
            {!guideOpen && (
              <button type="button" onClick={onGuide} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap text-brand-text hover:bg-brand-faint">
                Setup guide
              </button>
            )}
          </>
        ) : (
          <Skeleton className="h-7 w-full max-w-xl rounded-full" />
        )}
      </nav>
    </div>
  );
}

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

type LocalKind = "ollama" | "lmstudio" | "unsloth" | "custom";

/** A local LLM server as GET /api/llm reports it (no keys). */
interface LocalServerStatus {
  kind: LocalKind;
  label: string;
  url: string;
  up: boolean;
  auth: "none" | "ok" | "missing" | "rejected";
  models: { id: string; name?: string; loaded?: boolean; context?: number | null; maxContext?: number | null }[];
  model: string | null;
  loaded: boolean | null;
  context: number | null;
  problem: string | null;
  warning: string | null;
  native?: boolean;
}

interface LocalLlmInfo {
  provider: "auto" | LocalKind;
  /** Settings' context, in tokens (0: the server's own). */
  context: number;
  /** The server text steps and Assist use now. */
  active: LocalKind | null;
  servers: LocalServerStatus[];
}

const LOCAL_SERVERS: { value: "auto" | LocalKind; title: string }[] = [
  { value: "auto", title: "Automatic" },
  { value: "ollama", title: "Ollama" },
  { value: "lmstudio", title: "LM Studio" },
  { value: "unsloth", title: "Unsloth Studio" },
  { value: "custom", title: "Other" },
];

const code = (s: string) => <code className="font-mono text-[11px]">{s}</code>;

/** Each server's settings and how to get it running. */
const LOCAL_FIELDS: Record<
  LocalKind,
  { url: string; urlPlaceholder: string; urlHint: string; model: string; modelPlaceholder?: string; modelHint: string; key?: string; keyLabel?: string; keyPlaceholder?: string; setup: React.ReactNode }
> = {
  ollama: {
    url: "ollamaUrl",
    urlPlaceholder: "http://127.0.0.1:11434",
    urlHint: "Test checks Ollama answers and has the model.",
    model: "ollamaModel",
    modelPlaceholder: "qwen3:8b",
    modelHint: "A model with tool calling for Assist, such as qwen3:8b. Pull it first: ollama pull qwen3:8b",
    setup: <>Install Ollama, then run {code("ollama pull qwen3:8b")}. Fuobe gives it the context below.</>,
  },
  lmstudio: {
    url: "lmstudioUrl",
    urlPlaceholder: "http://127.0.0.1:1234",
    urlHint: "Test checks LM Studio answers and has the model.",
    model: "lmstudioModel",
    modelHint: "Empty: the loaded model, else one trained for tool use. A model that isn't loaded is loaded with the context below.",
    key: "lmstudioToken",
    keyLabel: "API token (only with Require Authentication on)",
    setup: (
      <>
        In LM Studio, open Developer and start the server (or run {code("lms server start")}), and download a model in Discover (or {code("lms get qwen/qwen3-8b")}). Models without thinking (instruct models) answer faster. Without
        Require Authentication, anyone on your network can use LM Studio&apos;s server.
      </>
    ),
  },
  unsloth: {
    url: "unslothUrl",
    urlPlaceholder: "http://127.0.0.1:8888",
    urlHint: "Test checks Unsloth Studio answers and has a model loaded.",
    model: "unslothModel",
    modelHint: "Empty: the model loaded in Unsloth Studio.",
    key: "unslothKey",
    keyLabel: "API key",
    keyPlaceholder: "sk-unsloth-…",
    setup: (
      <>
        Start Unsloth Studio and load a model on its Chat page (Select model), then make a key: avatar → Settings → API → Create. Fuobe always turns Unsloth&apos;s server-side tools (Python, terminal, web search) off.
      </>
    ),
  },
  custom: {
    url: "llmUrl",
    urlPlaceholder: "http://127.0.0.1:8080/v1",
    urlHint: "Test checks the server answers with a model list.",
    model: "llmModel",
    modelHint: "Empty: the first model the server lists.",
    key: "llmKey",
    keyLabel: "API key (optional)",
    setup: <>Any OpenAI-compatible server: llama.cpp&apos;s llama-server, vLLM, Jan… Give its base URL as its docs do (it usually ends in {code("/v1")}).</>,
  },
};

const k = (n: number) => `${Math.round(n / 1024)}k`;

/** One line per server: the model it would use, or what's wrong. */
function serverLine(s: LocalServerStatus): string {
  if (!s.url) return "Not set up";
  if (s.problem) return s.up ? s.problem : `Not running at ${s.url}`;
  return [s.model, s.loaded ? "loaded" : s.loaded === false ? "loads on first use" : null, s.context ? `${k(s.context)} context` : null].filter(Boolean).join(" · ");
}

/** A tiny chat call to a local server (POST /api/llm), timed: proves the model answers, not only that the server is up. */
function TryReply({ kind }: { kind: LocalKind }) {
  const [res, setRes] = useState<{ ok: boolean; detail: string } | null>(null);
  const m = useMutation({
    mutationFn: async () =>
      (await (await fetch("/api/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test", kind }) })).json()) as { ok: boolean; detail: string },
    onSuccess: setRes,
    onError: (e: Error) => setRes({ ok: false, detail: e.message }),
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setRes(null);
          m.mutate();
        }}
        disabled={m.isPending}
      >
        {m.isPending && <Loader2 className="animate-spin" />} Send a test message
      </Button>
      <span role="status" aria-live="polite" className="min-w-0">
        {res && (
          <span className={cn("inline-flex items-start gap-1 text-[12px] break-words", res.ok ? "text-success" : "text-destructive")}>
            {res.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <CircleAlert className="mt-0.5 size-3.5 shrink-0" />}
            {res.detail}
          </span>
        )}
      </span>
    </div>
  );
}

/** Settings → AI helper → the local model server: pick one (or Automatic), see what each one answers, set its URL, model and key, and test it. */
function LocalLlmSettings({ get, set }: { get: (n: string) => PublicSetting | undefined; set: (n: string) => (v: string) => void }) {
  const qc = useQueryClient();
  const llm = useQuery({
    queryKey: ["llm"],
    queryFn: async () => (await (await fetch("/api/llm")).json()) as LocalLlmInfo,
    refetchInterval: 30_000,
  });
  const refresh = useMutation({
    mutationFn: async () => (await (await fetch("/api/llm?refresh=1")).json()) as LocalLlmInfo,
    onSuccess: (data) => qc.setQueryData(["llm"], data),
  });
  const reload = useMutation({
    mutationFn: async (model: string | null) =>
      (await (await fetch("/api/llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "load", model }) })).json()) as { ok: boolean; detail: string },
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail);
      else toast.error(r.detail);
      refresh.mutate();
    },
  });
  const provider = (get("llmProvider")?.value || "auto") as "auto" | LocalKind;
  const [picked, setPicked] = useState<LocalKind | null>(null);
  // Pinned: that server's settings. Automatic: the one clicked below, else the one in use.
  const editing: LocalKind = provider !== "auto" ? provider : (picked ?? llm.data?.active ?? "ollama");
  const status = llm.data?.servers.find((s) => s.kind === editing);
  const f = LOCAL_FIELDS[editing];
  const need = llm.data?.context ?? 0;
  // Compared with the model's most when that's less: a reload can't give more than it.
  const maxContext = status?.models.find((m) => m.id === status.model)?.maxContext;
  const want = Math.min(need, maxContext || need);
  const smallContext = editing === "lmstudio" && status?.native && status.loaded && !!status.context && !!want && status.context < want;
  const shown = llm.data?.servers.filter((s) => provider === "auto" || s.kind === provider) ?? [];

  return (
    <div className="min-w-0 space-y-4 rounded-xl border p-4">
      <div className="space-y-1.5">
        <p id="local-llm-label" className="text-[13px] font-medium">
          Local model server
        </p>
        <div role="radiogroup" aria-labelledby="local-llm-label" onKeyDown={radioKeys} className="flex flex-wrap gap-1 rounded-xl bg-muted p-1">
          {LOCAL_SERVERS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={provider === o.value}
              tabIndex={radioTab(provider === o.value)}
              onClick={() => provider !== o.value && set("llmProvider")(o.value)}
              className={cn("h-8 rounded-lg px-3 text-[13px] font-medium transition-colors", provider === o.value ? "bg-background text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}
            >
              {o.title}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {provider === "auto" ? "Uses the first server that answers with a model, in this order: Ollama, LM Studio, Unsloth Studio, then the Other server." : "Only this server is used; the others are ignored."}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-medium">Found on this machine</p>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Check again
          </Button>
        </div>
        {llm.isLoading && <Skeleton className="h-16 w-full rounded-lg" />}
        <ul className="space-y-0.5">
          {shown.map((s) => (
            <li key={s.kind}>
              <button
                type="button"
                onClick={() => setPicked(s.kind)}
                aria-pressed={editing === s.kind}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent", editing === s.kind && "bg-accent")}
              >
                <span className={cn("size-2 shrink-0 rounded-full", !s.problem ? "bg-success" : s.up ? "bg-warning" : "bg-subtle-foreground")} />
                <span className="shrink-0 font-medium">{s.kind === "custom" ? "Other" : s.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{serverLine(s)}</span>
                {llm.data?.active === s.kind && <span className="shrink-0 rounded-md bg-brand-faint px-1.5 py-0.5 text-[11px] text-brand-text">In use</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-4 border-t pt-4">
        <p className="text-[13px] font-medium">{editing === "custom" ? "Other server (OpenAI-compatible)" : (status?.label ?? LOCAL_SERVERS.find((o) => o.value === editing)?.title)}</p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">{f.setup}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <ConnectField key={`${editing}-url`} name={f.url} setting={get(f.url)} provider="llm" label="URL" placeholder={f.urlPlaceholder} hint={f.urlHint} />
          <ConnectField
            key={`${editing}-model`}
            name={f.model}
            setting={get(f.model)}
            provider="llm"
            label="Model"
            placeholder={f.modelPlaceholder}
            hint={f.modelHint}
            options={status?.models.map((m) => m.id)}
          />
        </div>
        {f.key && <ConnectField key={`${editing}-key`} name={f.key} setting={get(f.key)} provider="llm" label={f.keyLabel ?? "API key"} placeholder={f.keyPlaceholder} hint="Only sent to this server." />}
        {status?.problem && status.up && <p className="text-[12px] text-warning">{status.problem}</p>}
        {status?.problem && !status.up && <p className="text-[12px] text-muted-foreground">{status.problem}</p>}
        {status?.warning && !status.problem && <p className="text-[12px] text-warning">{status.warning}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <TryReply key={editing} kind={editing} />
          {smallContext && (
            <Button variant="outline" size="sm" onClick={() => reload.mutate(status?.model ?? null)} disabled={reload.isPending}>
              {reload.isPending && <Loader2 className="animate-spin" />} Reload with {k(want)} context
            </Button>
          )}
        </div>
      </div>

      <ConnectField
        name="llmContext"
        setting={get("llmContext")}
        provider="llm"
        saveOnly
        label="Context (tokens)"
        placeholder="16384"
        hint="How much text the local model reads at once: Ollama gets it as num_ctx, and LM Studio loads models with it. Assist needs about 16,384. 0 leaves it to the server."
      />
      <p className="text-[12px] text-muted-foreground">The local model shares the GPU with ComfyUI. A 4–8B model leaves room for generations.</p>
    </div>
  );
}

/** The studio's own ComfyUI on the server's machine or network: where it runs, then its address, token and isolated worker. */
function LocalComfy({ get, onWhere }: { get: (n: string) => PublicSetting | undefined; onWhere: (v: "server" | "computer") => Promise<unknown> }) {
  return (
    <>
      <OwnerComfyWhere value={get("comfyWhere")?.value || "server"} onChange={onWhere} />
      {get("comfyWhere")?.value === "workers" && <p className="text-[13px] text-muted-foreground">ComfyUI jobs run on your workers now.</p>}
      <WorkersChip />
      <ConnectField name="comfyUrl" setting={get("comfyUrl")} provider="comfyui" label="ComfyUI server URL" placeholder="http://127.0.0.1:8188" hint="Where ComfyUI listens; a local install is http://127.0.0.1:8188." />
      <ConnectField name="comfyToken" setting={get("comfyToken")} provider="comfyui" label="Auth token (optional)" hint="Sent as a Bearer token, for ComfyUI behind a proxy." />
      <ConnectField
        name="comfyIsolatedUrl"
        setting={get("comfyIsolatedUrl")}
        provider="comfyui"
        label="Isolated worker URL (optional)"
        placeholder="http://127.0.0.1:8189"
        hint="A second ComfyUI for LatentSync 1.6 and ThinkSound, whose node packs can't share the main install. scripts/comfy/README.md shows how to start one."
      />
      <WorldcastField get={get} />
    </>
  );
}

export function SettingsForm({ prices }: { prices?: string }) {
  const qc = useQueryClient();
  const settings = useSettings();
  const status = useStatus().data;
  const place = usePagePlace();
  // The setup guide on request: the strip's "Setup guide", or a link to /settings#get-started (Home's demo line).
  const [guide, setGuide] = useState<boolean | null>(null);
  const askedByLink = useSyncExternalStore(subscribeHash, () => window.location.hash === "#get-started", () => false);
  const save = useMutation({
    mutationFn: async (patch: Record<string, string>) =>
      (await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })).json(),
    onSuccess: (body: { error?: string }) => {
      if (body?.error) return toast.error(body.error);
      toast.success("Saved");
      void qc.invalidateQueries({ queryKey: ["settings"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
      void qc.invalidateQueries({ queryKey: ["llm"] });
    },
  });
  const get = (n: string) => settings.data?.find((s) => s.name === n);
  const set = (n: string) => (v: string) => save.mutate({ [n]: v });
  // Deep links (/settings#comfyui) arrive while the form is still a skeleton, so the browser finds
  // no anchor: scroll to it once the sections exist.
  const loaded = !settings.isLoading;
  useEffect(() => {
    if (!loaded || !window.location.hash) return;
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView({ block: "start" });
  }, [loaded]);

  if (settings.isLoading)
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading settings">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  const mode = get("engineMode")?.value || "both";
  // A hosted studio (this page isn't on the server's machine): the owner's GPU is first the ComfyUI on this computer.
  const hosted = place === "hosted" && mode !== "cloud";
  const onComputer = get("comfyWhere")?.value === "computer";
  // The guide opens by itself on a first run, and on request ("Setup guide") after that.
  const firstRun = showFirstRun(status);
  const guideOpen = !!status && (firstRun || (guide ?? askedByLink));

  return (
    <div>
      <StatusStrip status={status} guideOpen={guideOpen} onGuide={() => setGuide(true)} />
      {guideOpen && status && (
        <div id="get-started" className="scroll-mt-28 pt-6 md:scroll-mt-20">
          <GetStarted
            status={status}
            prices={prices}
            intents={false}
            onHide={() => {
              setGuide(false);
              if (window.location.hash === "#get-started") history.replaceState(null, "", window.location.pathname);
            }}
          />
        </div>
      )}

      <Section
        id="engine"
        title="Engine mode"
        description="Choose what this install runs: fully open source, only paid APIs, or both side by side. The mode is enforced on the server, so a locked engine can't be used from the API either."
      >
        <EngineModePicker value={mode} onChange={set("engineMode")} />
        <p className="text-[12px] text-muted-foreground">Also settable with the <code className="font-mono">FUOBE_ENGINE_MODE</code> environment variable (both · open · cloud).</p>
      </Section>

      <Section
        id="cloud"
        title="Paid API configuration"
        description="One fal.ai key runs the Fuobe Originals in the cloud (Soul, DoP, Genjutsu, Cinema: open weights with their LoRAs) and the partner models: Nano Banana, Seedream, GPT Image, FLUX, Kling, Seedance, Veo 3.1, Wan, MiniMax, avatars and more. Replicate hosts a subset and is used as a fallback (or first, if you prefer it). Save & test checks a key before saving it."
        inactive={mode === "open" ? "Not used in Open source only mode" : undefined}
      >
        <ConnectField
          id="fal"
          name="falKey"
          setting={get("falKey")}
          provider="fal"
          label="fal.ai API key"
          placeholder="key_id:key_secret"
          hint={
            <a href={FAL_KEYS_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
              Get a key <ExternalLink className="size-3" />
            </a>
          }
        />
        <ConnectField
          id="replicate"
          name="replicateToken"
          setting={get("replicateToken")}
          provider="replicate"
          label="Replicate API token"
          placeholder="r8_…"
          hint={
            <a href="https://replicate.com/account/api-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
              Get a token <ExternalLink className="size-3" />
            </a>
          }
        />
        <ChoiceField
          id="setting-cloud-provider"
          label="Preferred provider"
          value={get("cloudProvider")?.value || "auto"}
          onChange={set("cloudProvider")}
          options={[
            { value: "auto", label: "Automatic", hint: "Tries fal.ai, then Replicate when a model is on both. Models only one provider hosts always use that one." },
            { value: "fal", label: "fal.ai first", hint: "fal.ai whenever it hosts the model. Models only one provider hosts always use that one." },
            { value: "replicate", label: "Replicate first", hint: "Replicate whenever it hosts the model. Models only one provider hosts always use that one." },
          ]}
        />
      </Section>

      <Section
        id="comfyui"
        title="Open-source engine · ComfyUI"
        description={
          hosted ? (
            <>
              Run every open-source workflow on your own graphics card. See{" "}
              <a href={WORKFLOWS_ON_GITHUB} target="_blank" rel="noopener" className="text-brand-text underline-offset-2 hover:underline">
                the ComfyUI workflows
              </a>{" "}
              for the models each one needs.
            </>
          ) : (
            <>
              Run every open-source workflow on your own GPU (or a rented one). Fuobe talks to ComfyUI&apos;s HTTP API and uploads inputs for you. See{" "}
              <a href={WORKFLOWS_ON_GITHUB} target="_blank" rel="noopener" className="text-brand-text underline-offset-2 hover:underline">
                the ComfyUI workflows
              </a>{" "}
              for the models each one needs.
            </>
          )
        }
        inactive={mode === "cloud" ? "Not used in Paid APIs only mode" : undefined}
      >
        {hosted ? <ConnectChoice advanced /> : <LocalComfy get={get} onWhere={(v) => save.mutateAsync({ comfyWhere: v })} />}
      </Section>

      <Section
        id="loras"
        title="LoRAs · looks, motions, effects and adapters"
        description="Looks, camera moves and effects add LoRA files to open models, on your GPU and in the cloud; an adapter is the LoRA an Original always loads (Fuobe Try-On's). Fuobe fetches the pinned version a run needs and shows each file's licence; what may run where is your call in Models & licences."
      >
        {onComputer && (
          <p className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand-text" /> Your ComfyUI is on your computer: put LoRA files in its models/loras folder. Fuobe tells you which ones a run needs.
          </p>
        )}
        <LoraSettings folder={get("comfyLorasDir")} civitaiKey={get("civitaiKey")} hfToken={get("huggingfaceDownloadToken")} />
      </Section>

      <Section
        id="training"
        title="Training · AI-Toolkit"
        description={
          <>
            Train Soul IDs and Fuobe looks (LoRAs) on your own GPU with{" "}
            <a href={AI_TOOLKIT_REPO} target="_blank" rel="noreferrer" className="text-brand-text underline-offset-2 hover:underline">
              AI-Toolkit
            </a>
            : free, and the file stays yours. Without it, train in the cloud on fal.ai, or download a training kit from the Train dialog.
          </>
        }
        inactive={mode === "cloud" ? "Not used in Paid APIs only mode" : undefined}
      >
        <ConnectField
          name="aiToolkitUrl"
          setting={get("aiToolkitUrl")}
          provider="ai-toolkit"
          label="AI-Toolkit URL"
          placeholder={DEFAULT_AI_TOOLKIT_URL}
          hint="Where AI-Toolkit's UI listens (in ai-toolkit/ui: npm run build_and_start). Test checks it answers."
        />
        <ConnectField name="aiToolkitToken" setting={get("aiToolkitToken")} provider="ai-toolkit" label="Auth token (optional)" hint="The AI_TOOLKIT_AUTH the trainer was started with, if any." />
        <ConnectField
          name="aiToolkitDatasetDir"
          setting={get("aiToolkitDatasetDir")}
          provider="ai-toolkit"
          label="Photos folder (optional)"
          placeholder="/mnt/shared/datasets"
          hint="Where Fuobe writes the training photos. Blank: Fuobe's data folder, for an AI-Toolkit on this machine; on another machine, a folder both can read."
        />
      </Section>

      <Section
        id="text-ai"
        title="AI helper · models and providers"
        description="The LLMs that write for Fuobe. Use (below) picks the one for the Enhance toggle, storyboards, translations and scripts, ad copy and brand research: Claude, a local model (Ollama, LM Studio, Unsloth Studio or another OpenAI-compatible server: fully open source), or the built-in offline rewriter. The Assist agent can also plan with the providers you add a key for (OpenAI, Gemini, DeepSeek, Kimi, GLM, OpenRouter and more). In Open source only mode, Automatic skips Claude. Save & test checks a key or address before saving it."
      >
        <ChoiceField
          id="setting-enhancer"
          label="Use"
          // "ollama" is the old name of "local".
          value={(get("enhanceProvider")?.value || "auto").replace(/^ollama$/, "local")}
          onChange={set("enhanceProvider")}
          options={[
            { value: "auto", label: "Automatic", hint: "Claude when a key is set, then a local model, then the offline rewriter." },
            { value: "anthropic", label: "Claude", hint: "Claude through your Anthropic key (paid per use)." },
            { value: "local", label: "Local model only", hint: "A local, open-source model (Ollama, LM Studio, Unsloth Studio or your own server). Claude is never called." },
            { value: "none", label: "Offline rewriter", hint: "Built-in rules, no LLM. Text steps (translate, write) are off." },
          ]}
        />
        <ConnectField name="anthropicKey" setting={get("anthropicKey")} provider="llm" label="Anthropic API key" placeholder="sk-ant-…" hint="Test checks the key with a free model list call." />
        <div id="llm-providers" className="scroll-mt-28 md:scroll-mt-20">
          <LlmProviderSettings get={get} set={set} />
        </div>
        <LocalLlmSettings get={get} set={set} />
      </Section>

      <Section
        id="assist-connectors"
        title="Assist · connectors"
        description="Give Claude in Assist the tools of your other apps — docs, tasks, CRM, analytics — through their MCP servers (a URL and, usually, a token). Only Claude chats use them."
      >
        <ConnectorSettings claudeReady={!!get("anthropicKey")?.isSet} />
      </Section>

      <Section
        id="notifications"
        title="Notifications"
        description="Get a heads-up from your browser when something you started finishes while you're in another tab or app. Saved in this browser; nothing is sent anywhere."
      >
        <NotificationSettings />
      </Section>

      <Section
        id="security"
        title="Security"
        description="Protect this studio with a password, and create API tokens for scripts and agents. Off by default for local use."
      >
        <SecuritySettings />
      </Section>

      <Section
        id="demo"
        title="Placeholder results"
        description="Off unless you turn it on. For giving a tour of this studio without keys or a GPU: runs cost nothing and make stand-in media instead of the real thing."
      >
        <label htmlFor="setting-demo" className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border bg-background p-4">
          <span className="min-w-0 space-y-1">
            <span className="block text-[14px] font-medium">{PLACEHOLDER_SETTING}</span>
            <span className="block text-[13px] leading-relaxed text-muted-foreground">
              While it&rsquo;s on, every run makes a placeholder labelled &ldquo;Placeholder&rdquo;, even with keys or ComfyUI connected, and the top bar says
              &ldquo;Placeholders on&rdquo;. While it&rsquo;s off, a run with nothing connected asks you to connect ComfyUI or add a key.
            </span>
          </span>
          <Switch
            id="setting-demo"
            className="mt-0.5"
            checked={placeholdersOn(get("demoMode")?.value)}
            disabled={save.isPending}
            onCheckedChange={(on) => set("demoMode")(on ? "on" : "off")}
          />
        </label>
      </Section>

      <Section
        id="models"
        title="Models & licences"
        description="Every model, LoRA and node pack with its licence, as information. Everything is on: switch off a model, a whole kind of licence (say, all non-commercial ones), a provider or a node pack, and it leaves the pickers and is refused on the server."
      >
        <Link href="/settings/models" className="inline-flex items-center gap-2 rounded-xl border px-4 py-3 text-[13px] font-medium transition-colors hover:bg-accent">
          <Scale className="size-4 text-muted-foreground" /> Open Models &amp; licences
        </Link>
      </Section>

      <Section id="about" title="About" description="The open models, LoRAs and code Fuobe is built on, who made them and their licences, and Fuobe's own source code.">
        <AboutLinks owner />
      </Section>
    </div>
  );
}
