import "server-only";
import { z } from "zod";
// The studio modules behind the studio tools (tools.ts imports them too; named here so MCP never runs without them).
import "./assist/studio-routes";
import { apiSchema, executeTool, getTool, planFor, TOOLS, type ToolContext } from "./assist/tools";
import { engineMode } from "./settings";
import { recipeMarkdown } from "@/lib/recipe";
import { enabledSkills, getSkill, skillRecipe } from "./skills";

/**
 * Fuobe as an MCP server (Model Context Protocol, streamable HTTP transport, stateless):
 * other agents — Claude Desktop, Claude Code, any MCP client — can look up models, price a
 * plan, start generations and fetch results. Same tools as Assist; the client's own approval
 * prompt replaces Assist's plan card, so `estimate_cost` / `estimate_job` are offered for asking
 * first. Assist's skills are served as MCP prompts (and through list_skills / load_skill).
 */

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "fuobe", title: "Fuobe studio", version: "1.3.0" };
const INSTRUCTIONS =
  "Fuobe is an AI image, video and audio studio (paid cloud models and open-source ComfyUI workflows); it also transcribes, translates and writes text and turns images into 3D models. " +
  "Look up models with search_models (kinds image, video, audio, text, model3d), price a plan with estimate_cost and tell the user the cost before you call generate or create_storyboard. " +
  'Chain steps in one generate call with "after" (a still, then animate it). ' +
  "Whole studio jobs have their own tools (split_layers, restyle_footage, dub_video, faceless_episode, create_ads, add_captions, restore_video, split_soundtrack and remove_dialogue (a soundtrack's dialogue, music and effects, on the open engine only), edit_speech, which changes what was said in a recording on the user's GPU, and katana, which rebuilds a 1–30 s reference edit shot for shot with the user's own subject from 1–5 photos): price them with estimate_job first. " +
  "Each studio job opens in that Fuobe studio (a Layers project, a Shorts session, a dub to review, a Faceless episode, an Ads Studio batch, the Captions editor, Katana): the result's href is its page on this Fuobe server, so give the user that link; a call the studio can't take runs as plain steps and says why. " +
  "Skills are playbooks for kinds of jobs (product photos, UGC videos, thumbnails…): list_skills, then load_skill to read one — they're also offered as prompts. " +
  "A skill that runs by itself (list_skills marks it and names its inputs) runs with run_skill and values for those inputs, the same steps every time: price it with estimate_job first. " +
  "Generations run in the background: poll check_generations (wait_seconds up to 120) for output URLs; text results come back inline. Output URLs are paths on this Fuobe server.";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string; data?: unknown } });

const ok = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const ctx = (): ToolContext => ({ engine: engineMode() === "open" ? "open" : "cloud" });

const READ_ONLY = new Set(["search_models", "list_elements", "list_recent", "check_generations", "estimate_cost", "estimate_job", "list_skills", "load_skill", "read_source"]);

/** Gated tools other than generate and create_storyboard (priced with estimate_job). */
const jobTools = () => TOOLS.filter((t) => t.gated && t.plan && !["generate", "create_storyboard", "remember"].includes(t.name)).map((t) => t.name);

function describe(t: (typeof TOOLS)[number]): string {
  // Assist's approval card doesn't exist here: say what the call costs instead.
  const base = t.description.replace(/The app shows the user the plan[^.]*\.( so call this directly instead of asking for confirmation in text\.)?/, "").replace(/\s*Gated by the same approval card as generate\.|\s*In ask-first mode the user approves each memory\./, "").trim();
  if (!t.gated) return t.description;
  if (t.name === "remember") return `${base} Changes what Fuobe Assist remembers about the user in every chat: confirm with the user first.`;
  const how = t.name === "generate" || t.name === "create_storyboard" ? "price it with estimate_cost" : "price it with estimate_job";
  return `${base} Spends money on paid models (or GPU time on open ones): ${how} and confirm with the user first.`;
}

function toolList() {
  const tools: { name: string; title: string; description: string; inputSchema: unknown; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }[] = TOOLS.map((t) => ({
    name: t.name,
    title: t.name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    description: describe(t),
    inputSchema: apiSchema(t.schema),
    annotations: { readOnlyHint: READ_ONLY.has(t.name), openWorldHint: !!t.gated && t.name !== "remember" },
  }));
  const gen = getTool("generate")!;
  tools.push({
    name: "estimate_cost",
    title: "Estimate cost",
    description: "Price a generate call without running it: the model, operation, number of outputs and estimated USD for each job, and whether it would run as a demo (no provider connected). Call it before generate whenever the user hasn't already agreed to a price.",
    inputSchema: apiSchema(gen.schema),
    annotations: { readOnlyHint: true, openWorldHint: false },
  });
  const jobs = jobTools();
  tools.push({
    name: "estimate_job",
    title: "Estimate a studio job",
    description: `Price a studio tool call (${jobs.join(", ")}) without running it: every step with its model and estimated USD, and whether it would run as a demo. Pass the tool's name and the arguments you'd give it.`,
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", enum: jobs, description: "The studio tool to price." },
        arguments: { type: "object", description: "The arguments you'd pass to that tool." },
      },
      required: ["tool", "arguments"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  });
  return tools;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Tool output (Anthropic content blocks or a string) → MCP content. */
function toContent(content: unknown): Content[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: JSON.stringify(content ?? null) }];
  return content.flatMap((b: { type: string; text?: string; source?: { type: string; data?: string; media_type?: string } }): Content[] => {
    if (b.type === "text") return [{ type: "text", text: b.text ?? "" }];
    if (b.type === "image" && b.source?.type === "base64" && b.source.data) return [{ type: "image", data: b.source.data, mimeType: b.source.media_type ?? "image/png" }];
    return [];
  });
}

const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });
const JobParams = z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) });

async function call(params: unknown) {
  const p = CallParams.safeParse(params);
  if (!p.success) return null;
  const { name, arguments: args = {} } = p.data;
  if (name === "estimate_cost") {
    const plan = planFor("generate", getTool("generate")!.schema.parse(args), ctx());
    return { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: plan, isError: plan.jobs.every((j) => j.error) };
  }
  if (name === "estimate_job") {
    const j = JobParams.safeParse(args);
    if (!j.success || !jobTools().includes(j.data.tool)) return { content: [{ type: "text", text: `Pass tool (one of ${jobTools().join(", ")}) and its arguments.` }], isError: true };
    const plan = planFor(j.data.tool, j.data.arguments, ctx());
    const isError = !!plan.error || plan.jobs.every((x) => x.error);
    return { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: plan, isError };
  }
  if (!getTool(name)) return undefined;
  const out = await executeTool(name, args, ctx());
  return { content: toContent(out.content), isError: !!out.isError };
}

// ---------------------------------------------------------------------------
// Prompts: Assist's skills

function promptList() {
  return enabledSkills().map((s) => ({
    name: s.name,
    title: s.title,
    description: s.whenToUse ? `${s.description} Use when: ${s.whenToUse}` : s.description,
    arguments: [{ name: "request", description: "What to make (optional): the job the skill should guide.", required: false }],
  }));
}

function promptGet(params: unknown) {
  const p = z.object({ name: z.string(), arguments: z.record(z.string(), z.string()).optional() }).safeParse(params);
  if (!p.success) return null;
  const s = getSkill(p.data.name);
  if (!s || !s.enabled) return undefined;
  const request = p.data.arguments?.request?.trim();
  // A skill that runs by itself says how (its "Run it" section), after its instructions.
  const recipe = s.recipe ? skillRecipe(s.name) : null;
  const runs = recipe ? `\n\n${recipeMarkdown(recipe, { name: s.name })}` : "";
  return {
    description: s.description,
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Follow the “${s.title}” skill from Fuobe for this job, using Fuobe's tools (search_models, generate and the studio tools).\n\n${s.body}${runs}${request ? `\n\n---\n\nThe job: ${request}` : ""}`,
        },
      },
    ],
  };
}

/** Handle one JSON-RPC message; null for notifications (no response). */
export async function handleMcp(msg: unknown): Promise<JsonRpcResponse | null> {
  const m = msg as JsonRpcRequest;
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(null, -32600, "Invalid request");
  const isNotification = m.id === undefined;
  if (isNotification) return null;
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return ok(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, { tools: toolList() });
    case "tools/call": {
      try {
        const r = await call(m.params);
        if (r === null) return fail(m.id, -32602, "tools/call needs a name and arguments");
        if (r === undefined) return fail(m.id, -32602, `Unknown tool ${String(m.params?.name)}`);
        return ok(m.id, r);
      } catch (e) {
        // Bad arguments for estimate_cost and the like: a tool error the model can read.
        return ok(m.id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    case "resources/list":
      return ok(m.id, { resources: [] });
    case "prompts/list":
      return ok(m.id, { prompts: promptList() });
    case "prompts/get": {
      const r = promptGet(m.params);
      if (r === null) return fail(m.id, -32602, "prompts/get needs a name");
      if (r === undefined) return fail(m.id, -32602, `Unknown prompt ${String(m.params?.name)}`);
      return ok(m.id, r);
    }
    default:
      return fail(m.id, -32601, `Method not found: ${m.method}`);
  }
}
