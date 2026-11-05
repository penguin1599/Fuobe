import { candidateValues, isTestProvider, PROVIDER_SETTINGS, settingProblem } from "@/lib/connections";
import { testCivitaiKey, testHfToken } from "@/server/loras";
import { testAiToolkit } from "@/server/training";
import { PROVIDERS } from "@/server/providers";
import { hostedAddressRefusal } from "@/server/providers/comfy-address";
import { validateSetting, withCandidates, type SettingName } from "@/server/settings";

/**
 * Test a provider's connection. With `value` (the provider's main setting) or `values` (by setting
 * name), the test runs with those unsaved values instead of the saved ones, so Settings can check a
 * key or an address before saving it. `field` names the setting being checked (else the first
 * unsaved one), so a provider that reaches several servers tests that one: the Anthropic key is
 * checked with Anthropic even when text steps run on Ollama. Nothing is stored here. `place: "hosted"` (the page isn't
 * on this server's machine) refuses a ComfyUI address on this machine or its network without calling it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown; value?: unknown; values?: unknown; field?: unknown; place?: unknown };
  const provider = body.provider;
  // The civitai key and the Hugging Face token aren't a model provider's (they download LoRAs), nor is AI-Toolkit (it trains them).
  const adapter =
    provider === "civitai"
      ? { test: testCivitaiKey }
      : provider === "huggingface"
        ? { test: testHfToken }
        : provider === "ai-toolkit"
          ? { test: testAiToolkit }
          : isTestProvider(provider)
            ? PROVIDERS[provider as Exclude<typeof provider, "civitai" | "huggingface" | "ai-toolkit">]
            : undefined;
  if (!isTestProvider(provider) || !adapter?.test) return Response.json({ ok: false, detail: "Unknown provider" }, { status: 400 });
  const values = candidateValues(provider, body.values, body.value) as Partial<Record<SettingName, string>>;
  try {
    for (const [name, v] of Object.entries(values)) validateSetting(name as SettingName, v);
  } catch (e) {
    return Response.json({ ok: false, detail: (e as Error).message }, { status: 400 });
  }
  const settings: readonly string[] = PROVIDER_SETTINGS[provider];
  const focus = typeof body.field === "string" && settings.includes(body.field) ? body.field : Object.keys(values)[0];
  const check = adapter.test.bind(adapter);
  const test = () => check({ focus });
  // The page says it isn't on this server's machine: a ComfyUI address on this machine or its network is never called
  // for it (it would be the server's own, not the owner's computer). Only ever skips a test.
  if (provider === "comfyui" && body.place === "hosted") {
    const field = focus === "comfyIsolatedUrl" || focus === "worldcastUrl" ? focus : "comfyUrl";
    const refused = await hostedAddressRefusal(field, values[field]);
    if (refused) return Response.json(refused);
  }
  try {
    const res = await withCandidates(values, test);
    // A rejected key that doesn't look like one: say what it should look like.
    const hint = !res.ok && Object.entries(values).map(([n, v]) => settingProblem(n, v ?? "")).find(Boolean);
    return Response.json(hint && !res.detail.includes(hint) ? { ...res, detail: `${res.detail} — ${hint}` } : res);
  } catch (e) {
    return Response.json({ ok: false, detail: `Couldn't run the test: ${(e as Error).message}` });
  }
}
