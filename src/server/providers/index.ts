import "server-only";
import type { ProviderId } from "@/lib/catalog/types";
import { comfyProvider } from "./comfyui";
import { falProvider } from "./fal";
import { llmProvider } from "./llm";
import { mockProvider } from "./mock";
import { replicateProvider } from "./replicate";
import { worldcastProvider } from "./worldcast";
import type { ProviderAdapter } from "./types";

const notImplemented = (id: ProviderId, label: string): ProviderAdapter => ({
  id,
  label,
  isConfigured: () => false,
  prepareFile: async () => {
    throw new Error(`${label} isn't available here. Pick another model`);
  },
  submit: async () => {
    throw new Error(`${label} isn't available here. Pick another model`);
  },
  poll: async () => ({ state: "failed", error: `${label} isn't available here. Pick another model` }),
});

/** Work done in the browser (colour grading) and recorded afterwards; never submitted or polled. */
const localProvider: ProviderAdapter = {
  id: "local",
  label: "In your browser",
  isConfigured: () => true,
  prepareFile: async () => {
    throw new Error("Runs in the browser");
  },
  submit: async () => {
    throw new Error("Runs in the browser");
  },
  poll: async () => ({ state: "failed", error: "Runs in the browser" }),
};

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  fal: falProvider,
  replicate: replicateProvider,
  comfyui: comfyProvider,
  mock: mockProvider,
  local: localProvider,
  openai: notImplemented("openai", "OpenAI"),
  google: notImplemented("google", "Google"),
  llm: llmProvider,
  worldcast: worldcastProvider,
};

/**
 * A job or training stored under a provider Fuobe no longer has (one removed since, e.g. by build plan O7): it
 * can't be submitted, polled or cancelled any more, so a poll fails it with a way forward instead of throwing on
 * every runner tick. Its outputs, if any were saved, stay in the Library.
 */
export const RETIRED_PROVIDER_ERROR = "This job ran on a provider Fuobe no longer uses, so its result can't be collected: run it again (Reuse picks the model that replaced it)";

const retiredProvider = (id: string): ProviderAdapter => ({
  id: id as ProviderId,
  label: "a retired provider",
  isConfigured: () => false,
  prepareFile: async () => {
    throw new Error(RETIRED_PROVIDER_ERROR);
  },
  submit: async () => {
    throw new Error(RETIRED_PROVIDER_ERROR);
  },
  poll: async () => ({ state: "failed", error: RETIRED_PROVIDER_ERROR }),
  cancel: async () => {},
});

/** The adapter for a provider id; one read from storage that Fuobe no longer has gets the retired stand-in. */
export function provider(id: ProviderId): ProviderAdapter {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : retiredProvider(id);
}
