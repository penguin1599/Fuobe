"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Loader2, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSettings, testConnection, useViewer, type ConnectionTest } from "@/lib/api";
import { settingProblem, type TestProvider } from "@/lib/connections";
import { addressHost, addressKind, refusedLine, refusedOnHosted } from "@/lib/page-place";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/refusals";

export interface PublicSetting {
  name: string;
  value: string;
  secret: boolean;
  fromEnv: boolean;
  isSet: boolean;
}

/**
 * GET /api/settings: every setting, and whether the server may test a private address for a hosted page. Only the
 * studio's owner may read them, so it waits until the page knows who is looking and is never asked for anyone else
 * (a guest's Home still mounts the guide's GPU card, hidden, on a phone).
 */
function useSettingsQuery<T>(enabled: boolean, select: (d: { settings: PublicSetting[]; allowPrivate?: boolean }) => T) {
  const owner = !!useViewer().data?.owner;
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => (await (await fetch("/api/settings")).json()) as { settings: PublicSetting[]; allowPrivate?: boolean },
    enabled: enabled && owner,
    select,
  });
}

/** Every setting as the browser may see it (secrets masked). `enabled: false` waits (Home's guide, until the status says it's wanted). */
export function useSettings(enabled = true) {
  return useSettingsQuery(enabled, (d) => d.settings);
}

/** The server may call a private address (FUOBE_ALLOW_PRIVATE_URLS: a VPN such as Tailscale) for a hosted page. */
export function useAllowPrivate(enabled = true): boolean {
  return useSettingsQuery(enabled, (d) => d.allowPrivate === true).data ?? false;
}

interface Result extends ConnectionTest {
  /** The typed values that didn't connect and weren't saved ("Save anyway" saves them). */
  unsaved?: Record<string, string>;
  saved?: boolean;
}

const ADDRESS_FIELDS = new Set(["comfyUrl", "comfyIsolatedUrl", "worldcastUrl"]);

/**
 * A key or address field with one button that does what it says: "Save & test" tests the typed value
 * first and saves it once it connects (a value that doesn't connect is offered "Save anyway"); with
 * nothing typed it tests the saved one. Used by Settings and by Home's first-run guide. `saveOnly` is for a
 * value no server can test on its own (the local model's context): its button saves what was typed.
 */
export function ConnectField({
  name,
  setting,
  provider,
  label,
  hint,
  placeholder,
  id,
  idleLabel = "Test",
  onConnected,
  options,
  className,
  saveOnly = false,
  hideDefault = false,
  extraValues,
  place,
  trustSaved = false,
  refusal,
}: {
  name: string;
  setting?: PublicSetting;
  provider: TestProvider;
  label: string;
  hint?: React.ReactNode;
  placeholder?: string;
  /** Anchor for links to this field (/settings#fal). */
  id?: string;
  /** The button's words when nothing new was typed. */
  idleLabel?: string;
  /** After a green test (the first-run guide closes itself). */
  onConnected?: (r: ConnectionTest) => void;
  /** Suggestions to pick from (the models a local LLM server lists); any value can still be typed. */
  options?: string[];
  className?: string;
  /** Save the typed value without a test (nothing to connect to). */
  saveOnly?: boolean;
  /** Show the field empty while only the built-in default is there (a hosted studio's ComfyUI address): Connect waits for one typed. */
  hideDefault?: boolean;
  /** Tested with the typed value and saved with it after a green test (comfyWhere "server": a server address while ComfyUI runs on a computer). */
  extraValues?: Record<string, string>;
  /** "hosted": the page isn't on the server's machine (lib/page-place.ts). A ComfyUI address there on the server's own machine or network is refused, never sent. */
  place?: "hosted";
  /** The saved address works for the server (it connected): only a typed one is refused. */
  trustSaved?: boolean;
  /** How a refused address is shown: its one line, and what to do instead. */
  refusal?: (line: string) => React.ReactNode;
}) {
  const qc = useQueryClient();
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const secret = !!setting?.secret;
  // A hosted page: an address on the server's own machine or network is never sent to be tested (lib/page-place.ts).
  const allowPrivate = useAllowPrivate(place === "hosted");
  // Only the built-in default (127.0.0.1 on a hosted studio means its server), or an address set on the server that the
  // owner never typed and the server may not call from here: shown empty, nothing to test until typed.
  const envRefused = hideDefault && place === "hosted" && !trustSaved && !!setting?.fromEnv && !!setting.value && refusedOnHosted(addressKind(setting.value), allowPrivate);
  const onlyDefault = hideDefault && ((!setting?.isSet && !setting?.fromEnv) || envRefused);
  const saved = secret || onlyDefault ? "" : (setting?.value ?? "");
  const typed = draft !== null && draft.trim() !== saved.trim() ? draft.trim() : null;
  const shown = draft ?? saved;
  const problem = typed ? settingProblem(name, typed) : null;
  const canTest = saveOnly ? typed !== null && !problem : typed !== null || (!onlyDefault && (!!setting?.isSet || !!setting?.value));
  const checked = place === "hosted" && ADDRESS_FIELDS.has(name) && (typed !== null || !trustSaved) ? (typed ?? saved) : "";
  const kind = checked ? addressKind(checked) : null;
  const refusedHere = kind && refusedOnHosted(kind, allowPrivate) ? refusedLine(kind, addressHost(checked)) : null;
  const hostedTest = place === "hosted" && (typed !== null || !trustSaved);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["settings"] });
    void qc.invalidateQueries({ queryKey: ["status"] });
    // Settings → AI helper lists what each local LLM server answers with its saved URL, model and key.
    void qc.invalidateQueries({ queryKey: ["llm"] });
  };

  const run = async () => {
    if (busy || !canTest) return;
    setBusy(true);
    try {
      if (saveOnly) {
        await saveSettings({ [name]: typed ?? "" });
        setDraft(null);
        setResult(null);
        refresh();
        toast.success(`${label} saved`);
        return;
      }
      // Refused here, before any request: the line says why, and no "Save anyway".
      if (refusedHere) {
        setResult({ ok: false, detail: refusedHere, code: "on-your-computer" });
        return;
      }
      const values = typed !== null ? { [name]: typed, ...extraValues } : extraValues;
      const res = await testConnection(provider, values, name, { place: hostedTest ? "hosted" : undefined });
      if (res.ok) {
        // Connected: keep it. The first-run guide goes once the status sees a connection the engine
        // mode generates with (the server remembers that), not for Ollama or an unused provider.
        if (values) await saveSettings(values);
        setDraft(null);
        refresh();
        onConnected?.(res);
      }
      setResult({ ...res, saved: res.ok && !!values, unsaved: !res.ok && res.code !== "on-your-computer" && typed !== null ? { [name]: typed } : undefined });
    } catch (e) {
      setResult({ ok: false, detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveAnyway = async (values: Record<string, string>) => {
    try {
      await saveSettings(values);
      setDraft(null);
      setResult((r) => r && { ...r, unsaved: undefined, saved: true });
      refresh();
      toast.success("Saved — it didn't connect yet");
    } catch (e) {
      toastError(e);
    }
  };

  const clear = async () => {
    try {
      await saveSettings({ [name]: "" });
      setDraft(null);
      setResult(null);
      refresh();
      toast.success(`${label} cleared`);
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div id={id} className={cn("min-w-0 scroll-mt-28 space-y-1.5", className)}>
      <Label htmlFor={inputId} className="text-[13px]">
        {label}
      </Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          aria-describedby={`${inputId}-hint ${inputId}-result`}
          aria-invalid={!!problem || (result ? !result.ok : undefined)}
          autoComplete="off"
          spellCheck={false}
          type={secret ? "password" : "text"}
          value={shown}
          placeholder={secret && setting?.isSet ? setting.value : placeholder}
          list={options?.length ? `${inputId}-list` : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void run();
            }
          }}
          className="min-w-0 flex-1 basis-56 font-mono text-[13px]"
        />
        {!!options?.length && (
          <datalist id={`${inputId}-list`}>
            {options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
        <div className="flex shrink-0 gap-2">
          <Button size="sm" className="h-9" disabled={busy || !canTest} onClick={() => void run()} aria-label={`${saveOnly ? "Save" : typed !== null ? "Save and test" : idleLabel} ${label}`}>
            {busy && <Loader2 className="animate-spin" />}
            {saveOnly ? "Save" : typed !== null ? "Save & test" : idleLabel}
          </Button>
          {setting?.isSet && !setting.fromEnv && secret && typed === null && (
            <Button size="sm" variant="ghost" className="h-9" aria-label={`Clear ${label}`} onClick={() => void clear()}>
              Clear
            </Button>
          )}
        </div>
      </div>
      {/* An address refused here gets its own line instead (fixing its form wouldn't help). */}
      {problem && !refusedHere && (
        <p className="flex items-start gap-1.5 text-[12px] text-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" /> {problem}
        </p>
      )}
      <div id={`${inputId}-result`} role="status" aria-live="polite" className="empty:hidden">
        {/* A saved address the server must not call from here: said at once. A refusal shows its own way. */}
        {!result && typed === null && refusedHere && refusal?.(refusedHere)}
        {result?.code === "on-your-computer" && refusal ? (
          refusal(result.detail)
        ) : result && (
          <p className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]", result.ok ? "text-success" : "text-destructive")}>
            {result.ok ? <CheckCircle2 className="size-3.5 shrink-0" /> : <CircleAlert className="size-3.5 shrink-0" />}
            <span className="min-w-0 break-words">
              {result.ok ? `Connected${result.saved ? " and saved" : ""} · ${result.detail}` : result.saved ? `Saved, not connected yet · ${result.detail}` : result.detail}
            </span>
            {result.unsaved && (
              <button type="button" onClick={() => void saveAnyway(result.unsaved!)} className="font-medium text-foreground underline underline-offset-2 hover:no-underline">
                Save anyway
              </button>
            )}
          </p>
        )}
      </div>
      {hint !== undefined && (
        <p id={`${inputId}-hint`} className="text-[12px] text-muted-foreground">
          {setting?.fromEnv && !onlyDefault ? (place === "hosted" ? "Set on the server. A value saved here replaces it. " : "Set from an environment variable; a value saved here wins. ") : ""}
          {hint}
        </p>
      )}
    </div>
  );
}
