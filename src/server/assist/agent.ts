import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { getModel, MODELS as CATALOG_MODELS } from "@/lib/catalog";
import { filterModels, studioBest } from "@/lib/composer";
import { AUDIO_STUDIO, EDIT_STUDIO, IMAGE_STUDIO, MUSIC_STUDIO, VIDEO_STUDIO } from "@/lib/studios";
import {
  ASSIST_EFFORTS,
  CLAUDE_MODELS,
  contextUpdate,
  DECLINED,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_EFFORT,
  factMap,
  guessCategory,
  normalizeAgent,
  renderContext,
  REPLIED_INSTEAD,
  slashSkills,
  threadTitle,
  type AssistAgent,
  type AssistAvailability,
  type AssistLocal,
  type AssistEffort,
  type AssistItem,
  type AssistMode,
  type AssistModeChoice,
  type AssistThread,
  type AssistThreadSummary,
  type AssistThreadView,
  type SkillMeta,
} from "@/lib/assist";
import { freePick, manualGroups, smartPick, toOption, choices, type Choice, type ConnectedProvider, type World } from "@/lib/assist-models";
import { getLlmModel, getLlmProvider, LLM_REGISTRY_CHECKED } from "@/lib/catalog/llm-providers";
import type { Engine, Generation, MediaKind } from "@/lib/catalog/types";
import { isMediaType, RECIPE_LIMITS, type Recipe } from "@/lib/recipe";
import { db } from "../db";
import { getGeneration } from "../generations";
import { activeLocal, aiHelper, chatLocal, emptyReply, localLabel, localProblem, localSoon, pinnedKind, toChatMessages, type Ready } from "../llm";
import { chatHosted, connectedHosted, endpointFor, freePlanOn, freeSpent, isRejected, markFreeSpent, openRouterKey } from "../llm/hosted";
import { FreeLimitError } from "../llm/hosted-errors";
import { toHostedMessages } from "../llm/hosted-messages";
import type { Replay } from "../llm/types";
import { offeredDefault } from "../model-access";
import { engineMode, getSetting } from "../settings";
import { getSkill, skillRecipe } from "../skills";
import { readRef } from "../storage";
import { spendOf, withinCap } from "@/lib/assist-schedule";
import { activeConnectors, connectorName, MCP_BETA, mcpParams, withoutMissingServers, type Connector } from "./connectors";
import { canUseSkill, chatFacts } from "./context";
import { getProject, touchProject } from "./projects";
import { apiTools, cardTitle, executeTool, getTool, planFor, validateInput, type ToolContext } from "./tools";

/**
 * The Assist agent loop. History is kept exactly as the API returned it (append-only, thinking
 * included) so later turns stay valid; generations that cost money stop the loop with an approval
 * card, and the user's answer resumes it with the matching tool results.
 *
 * Each chat's system prompt is frozen when it starts: the fixed instructions plus the chat's
 * context (date, engine, approval mode, project, memory, skills). What changes later — a memory
 * saved, a skill loaded, auto-run switched on — reaches the model as an appended
 * `role: "system"` "Context update" message, never by rewriting earlier text, so the prompt cache
 * and earlier thinking blocks stay valid.
 */

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type UserBlock = Exclude<MessageParam["content"], string>[number];

export interface ModelRequest {
  /** stable: the fixed instructions; turn: this chat's frozen context. */
  system: { stable: string; turn: string };
  messages: MessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  ctx: ToolContext;
  /** The chat's model: a Claude model id, a hosted provider and its model, or a local model's name; and the effort. */
  settings?: { model?: string | null; effort?: AssistEffort | null; provider?: string | null };
  /** The chat's id (hosted providers that cache by conversation get a hash of it). */
  threadId?: string;
  /** Skills loaded in the chat (the offline planner uses their hints). */
  skills?: SkillMeta[];
  /** The skills the person's latest message named (/name): the offline planner runs one of those, never an earlier one. */
  named?: string[];
  /** Custom MCP connectors (Settings → Assist): Claude gets them through the MCP connector; other agents can't use them. */
  connectors?: Connector[];
}
/** A reply: Claude's shape, plus what a hosted provider needs back on this turn and a one-time notice about the chat's price. */
export type ModelReply = Anthropic.Beta.BetaMessage & { replay?: Replay; priceNote?: string };
export type ModelCall = (req: ModelRequest) => Promise<ModelReply>;

/** A stored turn: Claude's shape, with a hosted provider's replay data on its own assistant turns. */
type Stored = MessageParam & { replay?: Replay };

const MAX_STEPS = 16;
const MAX_IMAGE_BYTES = 3_500_000;

// ---------------------------------------------------------------------------
// Storage

interface Pending {
  approvalItemId: string;
  /** Results of the turn's tools that already ran (read-only ones). */
  results: ToolResult[];
  /** The gated calls waiting for the user. */
  gated: { id: string; name: string; input: unknown }[];
  /** tool_use ids in the order the model sent them. */
  order: string[];
}

interface Row {
  id: string;
  title: string;
  status: AssistThread["status"];
  agent: AssistThread["agent"];
  engine: Engine;
  auto_approve: number;
  messages_json: string;
  items_json: string;
  pending_json: string | null;
  created_at: number;
  updated_at: number;
}

interface StateRow {
  thread_id: string;
  project_id: string | null;
  mode: AssistMode | null;
  model: string | null;
  effort: AssistEffort | null;
  provider: string | null;
  skills_json: string;
  context: string | null;
  sent_json: string | null;
  schedule_id: string | null;
  cap_usd: number | null;
  spent_usd: number | null;
  connectors: number | null;
}

/** Per-chat state beside the transcript (assist_thread_state). */
interface Ext {
  projectId: string | null;
  mode: AssistMode | null;
  model: string | null;
  effort: AssistEffort | null;
  /** A hosted model's provider (null: Claude, a local model or the offline planner). */
  provider: string | null;
  skills: string[];
  /** The chat's frozen context block (null until the first model call). */
  context: string | null;
  /** The facts the model has seen, to send only what changed. */
  sent: Record<string, string> | null;
  /** The scheduled task that started this chat. */
  scheduleId: string | null;
  /** With auto-run on: the most generations may cost without asking (USD), and what they have cost. */
  capUsd: number | null;
  spentUsd: number;
  /** Whether Claude gets the custom MCP connectors here (every chat, except a scheduled run whose task leaves them off). */
  connectors: boolean;
}

interface State {
  thread: AssistThread;
  messages: MessageParam[];
  pending: Pending | null;
  ext: Ext;
}

declare global {
  var __fuobeAssistRuns: Set<string> | undefined;
}
const runs = (globalThis.__fuobeAssistRuns ??= new Set());

function loadExt(id: string): Ext {
  const r = db().prepare("SELECT * FROM assist_thread_state WHERE thread_id = ?").get(id) as StateRow | undefined;
  return {
    projectId: r?.project_id ?? null,
    mode: r?.mode ?? null,
    model: r?.model ?? null,
    effort: r?.effort ?? null,
    provider: r?.provider ?? null,
    skills: r ? (JSON.parse(r.skills_json) as string[]) : [],
    context: r?.context ?? null,
    sent: r?.sent_json ? (JSON.parse(r.sent_json) as Record<string, string>) : null,
    scheduleId: r?.schedule_id ?? null,
    capUsd: r?.cap_usd ?? null,
    spentUsd: r?.spent_usd ?? 0,
    connectors: r?.connectors !== 0,
  };
}

function withExt(t: AssistThread, e: Ext): AssistThread {
  return {
    ...t,
    projectId: e.projectId,
    mode: e.mode ?? (t.agent === "claude" ? "smart" : "free"),
    model: e.model,
    effort: e.effort,
    provider: e.provider,
    skills: e.skills,
    ...(e.scheduleId && { scheduleId: e.scheduleId }),
    ...(e.capUsd !== null && { capUsd: e.capUsd, spentUsd: e.spentUsd }),
  };
}

function load(id: string): State | null {
  const r = db().prepare("SELECT * FROM assist_threads WHERE id = ?").get(id) as Row | undefined;
  if (!r) return null;
  const ext = loadExt(id);
  const s: State = {
    thread: withExt(
      {
        id: r.id,
        title: r.title,
        status: r.status,
        // Chats from before LM Studio and Unsloth Studio support say "ollama".
        agent: normalizeAgent(r.agent) ?? "offline",
        engine: r.engine,
        autoApprove: !!r.auto_approve,
        items: JSON.parse(r.items_json) as AssistItem[],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
      ext,
    ),
    messages: JSON.parse(r.messages_json) as MessageParam[],
    pending: r.pending_json ? (JSON.parse(r.pending_json) as Pending) : null,
    ext,
  };
  // A run that died with the server (restart, crash) leaves the thread "running": reopen it.
  if (s.thread.status === "running" && !runs.has(id)) {
    s.thread.status = "idle";
    push(s, { role: "notice", tone: "error", text: "This reply was interrupted. Send a message to carry on." });
    save(s);
  }
  return s;
}

function save(s: State): void {
  s.thread.updatedAt = Date.now();
  Object.assign(s.thread, withExt(s.thread, s.ext));
  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO assist_threads (id, title, status, agent, engine, auto_approve, messages_json, items_json, pending_json, created_at, updated_at)
         VALUES (@id, @title, @status, @agent, @engine, @auto_approve, @messages_json, @items_json, @pending_json, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET title = @title, status = @status, agent = @agent, auto_approve = @auto_approve, messages_json = @messages_json,
           items_json = @items_json, pending_json = @pending_json, updated_at = @updated_at`,
      )
      .run({
        id: s.thread.id,
        title: s.thread.title,
        status: s.thread.status,
        agent: s.thread.agent,
        engine: s.thread.engine,
        auto_approve: s.thread.autoApprove ? 1 : 0,
        messages_json: JSON.stringify(s.messages),
        items_json: JSON.stringify(s.thread.items),
        pending_json: s.pending ? JSON.stringify(s.pending) : null,
        created_at: s.thread.createdAt,
        updated_at: s.thread.updatedAt,
      });
    db()
      .prepare(
        `INSERT INTO assist_thread_state (thread_id, project_id, mode, model, effort, provider, skills_json, context, sent_json, schedule_id, cap_usd, spent_usd, connectors)
         VALUES (@thread_id, @project_id, @mode, @model, @effort, @provider, @skills_json, @context, @sent_json, @schedule_id, @cap_usd, @spent_usd, @connectors)
         ON CONFLICT(thread_id) DO UPDATE SET project_id = @project_id, mode = @mode, model = @model, effort = @effort, provider = @provider,
           skills_json = @skills_json, context = @context, sent_json = @sent_json, schedule_id = @schedule_id, cap_usd = @cap_usd, spent_usd = @spent_usd,
           connectors = @connectors`,
      )
      .run({
        thread_id: s.thread.id,
        project_id: s.ext.projectId,
        mode: s.ext.mode,
        model: s.ext.model,
        effort: s.ext.effort,
        provider: s.ext.provider,
        skills_json: JSON.stringify(s.ext.skills),
        context: s.ext.context,
        sent_json: s.ext.sent ? JSON.stringify(s.ext.sent) : null,
        schedule_id: s.ext.scheduleId,
        cap_usd: s.ext.capUsd,
        spent_usd: s.ext.spentUsd,
        connectors: s.ext.connectors ? 1 : 0,
      });
  })();
}

type NewItem = AssistItem extends infer T ? (T extends AssistItem ? Omit<T, "id"> : never) : never;
function push(s: State, item: NewItem | AssistItem): AssistItem {
  const full = { ...item, id: ("id" in item && item.id) || nanoid(10) } as AssistItem;
  s.thread.items.push(full);
  return full;
}

/** Chats, newest first. `project`: one project's chats; null: chats outside projects; omitted: all. `q` searches titles and messages. */
export function listThreads(f: { project?: string | null; q?: string } = {}): AssistThreadSummary[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.project === null) where.push("s.project_id IS NULL");
  else if (f.project) {
    where.push("s.project_id = ?");
    args.push(f.project);
  }
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(t.title LIKE ? ESCAPE '\\' OR t.items_json LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const sql = `SELECT t.id, t.title, t.status, t.updated_at, s.project_id FROM assist_threads t LEFT JOIN assist_thread_state s ON s.thread_id = t.id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.updated_at DESC LIMIT 100`;
  return (db().prepare(sql).all(...args) as (Pick<Row, "id" | "title" | "status" | "updated_at"> & { project_id: string | null })[]).map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    updatedAt: r.updated_at,
    projectId: r.project_id,
  }));
}

export function getThread(id: string): AssistThreadView | null {
  const s = load(id);
  if (!s) return null;
  const ids = s.thread.items.flatMap((i) => (i.role === "generations" ? i.ids : []));
  const generations = ids.map((g) => getGeneration(g)).filter((g): g is Generation => !!g);
  return { thread: s.thread, generations };
}

/** What a project's chats made (its Assets tab): their finished generations, newest first, with the chat each came from. */
export function projectAssets(projectId: string, limit = 120): { generation: Generation; chatId: string; chatTitle: string }[] {
  const rows = db()
    .prepare("SELECT t.id, t.title, t.items_json FROM assist_threads t JOIN assist_thread_state s ON s.thread_id = t.id WHERE s.project_id = ? ORDER BY t.updated_at DESC")
    .all(projectId) as { id: string; title: string; items_json: string }[];
  const seen = new Set<string>();
  const out: { generation: Generation; chatId: string; chatTitle: string }[] = [];
  for (const r of rows) {
    for (const item of JSON.parse(r.items_json) as AssistItem[]) {
      if (item.role !== "generations") continue;
      for (const gid of item.ids) {
        if (seen.has(gid)) continue;
        seen.add(gid);
        const g = getGeneration(gid);
        if (g?.status === "succeeded" && g.outputs.length) out.push({ generation: g, chatId: r.id, chatTitle: r.title });
      }
    }
  }
  return out.sort((a, b) => b.generation.createdAt - a.generation.createdAt).slice(0, limit);
}

export function deleteThread(id: string): void {
  db().transaction(() => {
    db().prepare("DELETE FROM assist_threads WHERE id = ?").run(id);
    db().prepare("DELETE FROM assist_thread_state WHERE thread_id = ?").run(id);
  })();
}

export class AssistBusyError extends Error {}

export interface ThreadPatch {
  autoApprove?: boolean;
  title?: string;
  /** Move the chat into a project (or out, with null). */
  projectId?: string | null;
  mode?: AssistModeChoice;
}

export async function updateThread(id: string, patch: ThreadPatch): Promise<AssistThread | null> {
  const s = load(id);
  if (!s) return null;
  if (patch.autoApprove !== undefined) s.thread.autoApprove = patch.autoApprove;
  if (patch.title) s.thread.title = patch.title;
  if (patch.projectId !== undefined) {
    if (s.thread.status === "running" || runs.has(id)) throw new AssistBusyError("Wait for this reply to finish, then move the chat");
    if (patch.projectId && !getProject(patch.projectId)) throw new Error("That project doesn't exist anymore");
    s.ext.projectId = patch.projectId;
    // Skills the new project doesn't offer are unloaded.
    s.ext.skills = s.ext.skills.filter((n) => canUseSkill(n, s.ext.projectId));
  }
  if (patch.mode) {
    if (s.thread.status === "running" || runs.has(id)) throw new AssistBusyError("Wait for this reply to finish, then switch");
    applyMode(s, await resolveMode(patch.mode));
    connectorNote(s);
  }
  save(s);
  return s.thread;
}

// ---------------------------------------------------------------------------
// Which LLM runs a chat: modes

/** Why the local model can't take a chat, and what to do: the server's own reason, or which servers to start. */
function localDownNote(): string {
  const why = localProblem();
  if (why) return `${why.replace(/\.$/, "")} — or pick another mode.`;
  return `No local model server is answering (${pinnedKind() ? localLabel() : "Ollama, LM Studio or Unsloth Studio"}) — start one, or pick another mode.`;
}

/**
 * Which LLM drives new chats by default: the agent of the default mode (resolveMode with no choice): Smart's
 * planner when that is a paid model, else Free's pick, else the offline planner.
 */
export async function resolveAgent(): Promise<AssistThread["agent"]> {
  return (await resolveMode()).agent;
}

const claudeAllowed = () => !!getSetting("anthropicKey") && (engineMode() !== "open" || aiHelper() === "anthropic");

/** The local server for the mode picker: its models (Unsloth only answers with the loaded one), or why it can't run. */
function localInfo(ready: Ready | null): AssistLocal {
  if (!ready) return { kind: pinnedKind(), label: localLabel(), ok: false, models: [], model: null, ...(localProblem() && { problem: localProblem()! }) };
  const { server, status } = ready;
  const models = status.models.filter((m) => server.kind !== "unsloth" || m.loaded || m.id === status.model).map((m) => m.id);
  return { kind: server.kind, label: server.label, ok: true, models: models.slice(0, 50), model: status.model };
}

/** How long the panel waits for OpenRouter's key check (an older answer is used meanwhile). */
const KEY_WAIT_MS = 1500;

/**
 * What the owner has connected, for the model picks (src/lib/assist-models.ts): the providers with a key (Anthropic's,
 * the hosted ones'), the local server that answers, and Settings. No call is made to a paid API.
 */
async function world(ready?: Ready | null): Promise<World> {
  const local = ready === undefined ? await localSoon() : ready;
  const providers: ConnectedProvider[] = [];
  if (getSetting("anthropicKey")) providers.push({ id: "anthropic" });
  for (const ep of connectedHosted()) {
    const c: ConnectedProvider = { id: ep.provider.id, ...(ep.cny && { cny: true }), ...(freePlanOn(ep.provider) && { freeTick: true }), ...(isRejected(ep) && { rejected: true }) };
    if (ep.provider.id === "openrouter") {
      const k = await openRouterKey(false, KEY_WAIT_MS);
      if (k) Object.assign(c, { freeTier: k.freeTier, freeLeft: k.left, freeLimit: k.limit });
    }
    providers.push(c);
  }
  const info = local ? localInfo(local) : null;
  return {
    providers,
    local: info ? { kind: info.kind ?? "custom", label: info.label, ok: info.ok, model: info.model, models: info.models.map((id) => ({ id })) } : null,
    openOnly: engineMode() === "open",
    helper: aiHelper(),
    smartPlan: getSetting("smartPlan") || "auto",
    freeOrder: getSetting("freeOrder") === "local" ? "local" : "best",
    today: new Date().toISOString().slice(0, 10),
    checker: false,
    spent: freeSpent(),
  };
}

export async function availability(): Promise<AssistAvailability> {
  const ready = await localSoon();
  const w = await world(ready);
  const aiOff = w.helper === "none";
  const smart = smartPick(w);
  const free = freePick(w);
  const manual = manualGroups(w);
  const opt = (c: Choice | null) => (c ? toOption(c) : null);
  return {
    claude: claudeAllowed(),
    local: localInfo(ready),
    aiOff,
    defaultMode: !aiOff && smart.plan && !smart.plan.free && w.helper !== "local" ? "smart" : "free",
    smart: { plan: opt(smart.plan), check: opt(smart.check), text: smart.text },
    free: { pick: opt(free.pick), text: free.text, ...(free.pick?.caveat && { caveat: free.pick.caveat }) },
    manual: { groups: manual.groups.map((g) => ({ ...g, models: g.models.map(toOption) })), missing: manual.missing },
    openOnly: w.openOnly,
    checked: LLM_REGISTRY_CHECKED,
  };
}

export interface ResolvedMode {
  mode: AssistMode;
  agent: AssistAgent;
  /** A hosted model's provider (null otherwise). */
  provider: string | null;
  model: string | null;
  effort: AssistEffort | null;
  /** Why the chat didn't get what was asked (no key, AI helper off…). */
  note?: string;
}

/** A local model's name: Ollama's "qwen3:8b", LM Studio's "qwen/qwen3-8b@q4_k_m", Unsloth's "unsloth/Qwen3-8B-GGUF:Q4_K_M". */
const LOCAL_NAME = /^[\w.:/@+-]{1,200}$/;

/** A pick as the chat stores it. The local model stays the server's default (null), so a model swapped on the server is used. */
function fromChoice(mode: AssistMode, c: Choice, effort: AssistEffort | null | undefined, note?: string): ResolvedMode {
  if (c.local) return { mode, agent: "local", provider: null, model: null, effort: null, ...(note && { note }) };
  const e = effort && c.efforts.includes(effort) ? effort : c.efforts.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : (c.efforts[0] ?? null);
  return { mode, agent: c.agent, provider: c.agent === "hosted" ? c.provider : null, model: c.model, effort: e, ...(note && { note }) };
}

/**
 * Supercomputer's modes on Fuobe's agents: Smart = the best model the owner has connected (Claude, OpenAI, Gemini,
 * DeepSeek, OpenRouter… or the local model; src/lib/assist-models.ts); Free = free models only (OpenRouter's free
 * models, Z.ai's free GLM Flash, free plans the owner ticked, the local model; the offline planner when none);
 * Manual = the model and effort you pick, when it can run here. Without a choice, the default mode.
 */
export async function resolveMode(choice?: Partial<AssistModeChoice>): Promise<ResolvedMode> {
  if (aiHelper() === "none") {
    return {
      mode: choice?.mode ?? "free",
      agent: "offline",
      provider: null,
      model: null,
      effort: null,
      ...(choice?.mode && choice.mode !== "free" && { note: "The AI helper is off in Settings, so this chat uses the offline planner." }),
    };
  }
  const w = await world();
  const free = (note?: string): ResolvedMode => {
    const f = freePick(w);
    return f.pick ? fromChoice("free", f.pick, null, note) : { mode: "free", agent: "offline", provider: null, model: null, effort: null, ...(note && { note }) };
  };
  const smart = smartPick(w);
  if (!choice?.mode) return smart.plan && !smart.plan.free && w.helper !== "local" ? fromChoice("smart", smart.plan, DEFAULT_EFFORT) : free();
  if (choice.mode === "smart") return smart.plan ? fromChoice("smart", smart.plan, DEFAULT_EFFORT) : free(`${smart.text} Using Free instead.`);
  if (choice.mode === "free") return free();
  // Manual
  const agent = normalizeAgent(choice.agent) ?? "claude";
  if (agent === "claude" || agent === "hosted") {
    const provider = agent === "claude" ? "anthropic" : (choice.provider ?? "");
    const model = agent === "claude" && !CLAUDE_MODELS.some((m) => m.id === choice.model) ? DEFAULT_CLAUDE_MODEL : choice.model;
    const c = choices(w).find((x) => x.provider === provider && x.model === model && !x.local);
    const label = getLlmProvider(provider)?.label ?? "That provider";
    if (!c) return free(agent === "claude" ? "Claude needs an Anthropic API key (Settings → AI helper) — using Free instead." : `${label} isn't connected (Settings → AI helper) — using Free instead.`);
    if (c.disabled) return free(`${c.name} can't run here: ${c.disabled.replace(/\.$/, "")} — using Free instead.`);
    const effort = ASSIST_EFFORTS.some((e) => e.id === choice.effort) ? choice.effort! : DEFAULT_EFFORT;
    return { ...fromChoice("manual", c, effort), ...(agent === "claude" && { effort }) };
  }
  if (agent === "local") {
    const model = choice.model && LOCAL_NAME.test(choice.model) ? choice.model : null;
    return { mode: "manual", agent: "local", provider: null, model, effort: null, ...(!(await localSoon()) && { note: localDownNote() }) };
  }
  return { mode: "manual", agent: "offline", provider: null, model: null, effort: null };
}

/** The chat takes a resolved mode (and says why it isn't what was asked, when it isn't). */
function applyMode(s: State, r: ResolvedMode): void {
  s.thread.agent = r.agent;
  s.ext.mode = r.mode;
  s.ext.provider = r.provider;
  s.ext.model = r.model;
  s.ext.effort = r.effort;
  if (r.note) push(s, { role: "notice", tone: "info", text: r.note });
}

/** What a chat's model is called in a notice: "GPT-6.1 Sol (OpenAI)", "qwen3.8:27b (Ollama)", "the offline planner". */
function modelName(agent: AssistAgent, provider: string | null, model: string | null): string {
  if (agent === "offline") return "the offline planner";
  if (agent === "local") return model ? `${model} (${localLabel()})` : `the local model (${localLabel()})`;
  if (agent === "claude") return CLAUDE_MODELS.find((m) => m.id === (model ?? DEFAULT_CLAUDE_MODEL))?.label ?? "Claude";
  return `${getLlmModel(provider, model)?.name ?? model} (${getLlmProvider(provider)?.short ?? provider})`;
}

/**
 * Smart and Free keep the model they picked; when its provider's key is gone (or a hosted model can't run here any
 * more), the next message picks again and says so. Manual keeps the model the person picked.
 */
async function repick(s: State): Promise<void> {
  if (s.ext.mode === "manual" || s.thread.agent !== "hosted") return;
  const c = choices(await world()).find((x) => x.provider === s.ext.provider && x.model === s.ext.model && !x.local);
  if (c && !c.disabled) return;
  const was = getLlmProvider(s.ext.provider)?.short ?? "Its provider";
  const mode = s.ext.mode ?? "smart";
  const r = await resolveMode({ mode });
  applyMode(s, { ...r, note: undefined });
  push(s, { role: "notice", tone: "info", text: `${mode === "free" ? "Free" : "Smart"} now uses ${modelName(r.agent, r.provider, r.model)} (${c ? `${c.name} can't run here now` : `${was}'s key was removed`}).` });
}

/** The connectors Claude gets in this chat: none on other agents, or in a scheduled run that leaves them off. */
const chatConnectors = (s: State): Connector[] => (s.thread.agent === "claude" && s.ext.connectors ? activeConnectors() : []);

/** Connectors need Claude: a chat on a local model or the offline planner (that would otherwise use them) says so once. */
function connectorNote(s: State): void {
  if (s.thread.agent === "claude" || !s.ext.connectors || s.thread.items.some((i) => i.role === "notice" && i.text.startsWith(CONNECTOR_NOTE))) return;
  const names = activeConnectors().map((c) => c.name);
  if (!names.length) return;
  const on = s.thread.agent === "local" ? "a local model" : s.thread.agent === "hosted" ? modelName("hosted", s.ext.provider, s.ext.model) : "the offline planner";
  push(s, { role: "notice", tone: "info", text: `${CONNECTOR_NOTE} (${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}); this chat runs on ${on}, so it can't use them.` });
}
const CONNECTOR_NOTE = "Connectors work in Claude chats";

export function createThread(opts: {
  engine: Engine;
  /** "ollama" is the local agent's old name. */
  agent: AssistThread["agent"] | "ollama";
  autoApprove?: boolean;
  title?: string;
  projectId?: string | null;
  mode?: AssistMode | null;
  /** A hosted model's provider. */
  provider?: string | null;
  model?: string | null;
  effort?: AssistEffort | null;
  /** A scheduled run: the task that started it, and auto-run's cost cap for it. */
  scheduleId?: string | null;
  capUsd?: number | null;
  /** false: Claude doesn't get the custom MCP connectors here (a scheduled run that leaves them off). */
  connectors?: boolean;
  /** A quiet line at the top of the chat (a scheduled run says which task it is). */
  note?: string;
}): AssistThread {
  const now = Date.now();
  if (opts.projectId && !getProject(opts.projectId)) throw new Error("That project doesn't exist anymore");
  const s: State = {
    thread: { id: nanoid(12), title: opts.title ?? "New chat", status: "idle", agent: normalizeAgent(opts.agent) ?? "offline", engine: opts.engine, autoApprove: !!opts.autoApprove, items: [], createdAt: now, updatedAt: now },
    messages: [],
    pending: null,
    ext: {
      projectId: opts.projectId ?? null,
      mode: opts.mode ?? null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      provider: opts.provider ?? null,
      skills: [],
      context: null,
      sent: null,
      scheduleId: opts.scheduleId ?? null,
      capUsd: opts.capUsd ?? null,
      spentUsd: 0,
      connectors: opts.connectors !== false,
    },
  };
  if (opts.note) push(s, { role: "notice", tone: "info", text: opts.note });
  connectorNote(s);
  save(s);
  if (opts.projectId) touchProject(opts.projectId);
  return s.thread;
}

// ---------------------------------------------------------------------------
// Messages

/** User content goes into the last user turn when there is one (after a refusal or an error). */
function appendUser(messages: MessageParam[], blocks: UserBlock[]): void {
  const last = messages.at(-1);
  if (last?.role === "user") {
    const prior = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    last.content = [...prior, ...blocks];
  } else {
    messages.push({ role: "user", content: blocks });
  }
}

/** Tool calls left without results (a crash mid-tool) would make every later request invalid. */
function closeDanglingToolUses(messages: MessageParam[]): void {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || typeof last.content === "string") return;
  const uses = last.content.filter((b) => b.type === "tool_use");
  if (uses.length) {
    messages.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: (u as { id: string }).id, is_error: true, content: "Interrupted before this ran." })) });
  }
}

const FILE_KIND = (url: string) =>
  /\.(mp4|webm|mov|mkv)$/i.test(url) ? "video" : /\.(mp3|wav|ogg|m4a|flac|aac)$/i.test(url) ? "audio" : /\.(txt|srt|vtt|json)$/i.test(url) ? "text" : /\.(glb|gltf)$/i.test(url) ? "model3d" : "image";

function userBlocks(text: string, attachments: string[]): UserBlock[] {
  const blocks: UserBlock[] = [];
  const lines = attachments.map((a, i) => `- ${FILE_KIND(a)} ${i + 1}: ${a}`);
  blocks.push({ type: "text", text: attachments.length ? `${text}\n\nAttached files (pass these URLs as inputs):\n${lines.join("\n")}` : text });
  // Local images are stored by URL and sent as base64 at request time (see hydrate).
  for (const a of attachments.filter((x) => FILE_KIND(x) === "image").slice(0, 4)) blocks.push({ type: "image", source: { type: "url", url: a } });
  return blocks;
}

/** Turn stored local image URLs into base64 (the API can't reach this machine). */
async function hydrate(messages: MessageParam[]): Promise<MessageParam[]> {
  const cache = new Map<string, UserBlock>();
  const one = async (b: UserBlock): Promise<UserBlock> => {
    if (b.type !== "image" || b.source.type !== "url" || !b.source.url.startsWith("/api/files/")) return b;
    const url = b.source.url;
    if (!cache.has(url)) {
      try {
        const { data, contentType } = await readRef(url);
        if (data.length > MAX_IMAGE_BYTES || !/^image\/(png|jpeg|webp|gif)$/.test(contentType)) throw new Error("too big");
        cache.set(url, { type: "image", source: { type: "base64", media_type: contentType as "image/png", data: data.toString("base64") } });
      } catch {
        cache.set(url, { type: "text", text: `[image ${url} can't be shown]` });
      }
    }
    return cache.get(url)!;
  };
  return Promise.all(
    messages.map(async (m) => {
      if (m.role !== "user" || typeof m.content === "string") return m;
      const content = await Promise.all(
        m.content.map(async (b) =>
          b.type === "tool_result" && Array.isArray(b.content) ? { ...b, content: (await Promise.all(b.content.map((c) => one(c as UserBlock)))) as typeof b.content } : one(b),
        ),
      );
      return { ...m, content };
    }),
  );
}

// ---------------------------------------------------------------------------
// System prompt

const STABLE_SYSTEM = `You are Fuobe Assist, the creative assistant inside Fuobe — an AI image, video and audio studio. You plan and run generations for the user with the tools you have.

How you work:
- Understand the brief. If something essential is missing (what the subject is, or which of their files to use) ask one short question; otherwise make sensible creative choices and go.
- Look up models with search_models before you generate, and pick the model that best fits the job, the user's engine preference and their budget. Prefer connected models. Mention the model you picked and why in one line.
- Write rich, specific prompts: subject, setting, light, lens and composition; for video, the motion and camera move in time order. Keep any text the user wants rendered exactly.
- Call generate (or create_storyboard) directly. The app shows the user a plan card with the cost and runs it when they approve — never ask "shall I go ahead?" in text.
- For multi-step work (an image, then animate it; transcribe, translate, then voice it), put the steps in one generate call and set "after" on each later job: it starts by itself when the earlier job finishes and gets its result as input. When you need to judge a result before deciding the next step, wait with check_generations instead (look=true to see images) and pass the output URL into the next call.
- Besides images, video and audio, models can transcribe speech, translate or write text (scripts, captions, ad copy), split images into layers, separate voice from background, trim, caption or re-sound clips, and turn an image into a 3D model: search_models with kind "text" or "model3d" finds the text and 3D ones.
- Whole studio jobs have their own tools, and each job opens in its studio, where the user can carry on: split_layers (a Layers project), restyle_footage (a Shorts Studio session), dub_video (a dub the user reviews line by line in Translate & dub), faceless_episode (a Faceless Studio episode), create_ads (an Ads Studio batch), add_captions (the Captions editor), restore_video (old or black-and-white footage restored and colourised, in Restore & colourise), remove_person (a person removed from a video and the scene rebuilt behind them, on the user's own GPU, in Remove a person), blockout_film (a grey-box 3D blockout from Blender or any 3D app filmed from reference stills and timed beats, as Cinema's Blockout does; in the Library), split_soundtrack (a soundtrack split into dialogue, music and effects, or remixed at set levels; on the open engine only), remove_dialogue (a video's talking taken out or kept alone, the picture copied; open engine only), fly_around (a still filmed along an exact camera path: an orbit by its degrees, direction, tilt and pulse, or a ready move; in the Library), edit_speech (a word, the pitch, pace, mood or noise of a recording or video changed without re-recording it, on the user's GPU; pass the transcript's timed lines), world_film (a world walk-through: a world described once, then steered turn by turn with words and camera moves, joined into one film, on the user's GPU; "a 60 s walk-through" is the opening and four 12 s turns; in the Library) and katana (a reference edit — a 1–30 s video — rebuilt shot for shot with the user's own subject from 1–5 photos, when they want "this edit, but with me / my product"). Use them instead of chaining those steps by hand; once one starts, say which studio it's in (the chat links to it).
- Use the user's files by the URLs listed in their message. Earlier outputs are found with list_recent. Saved characters and products are Elements: check list_elements and write their @handle in prompts.
- Results show up in the chat by themselves, so don't repeat URLs back. After starting jobs, say briefly what's coming; after they finish, give a short take and suggest a next step.
- Be brief and friendly. Plain sentences, no headings. Prices are estimates in USD; open-source models run free on the user's own GPU.

Skills, memory and projects (your context below lists them):
- Skills are playbooks for whole kinds of jobs. When the request matches one under "Skills you can load", call load_skill with its name before planning, then follow it. A message that starts with /name has already loaded that skill. Follow every skill under "Skills in use".
- A skill marked "runs by itself" is a saved recipe: when one fits the request, call run_skill with its name and values for its inputs (files from the user's attachments, words from their message) instead of planning the steps again. Ask only for a required input you can't fill.
- Memory is what you know about the user. Follow it without mentioning it. When the user states something lasting — a preference, their style, a convention, their setup, a fix that worked — save it with remember: one short sentence, no secrets, nothing about only the current job. Correct an outdated memory with remember and its id as "replaces".
- In a project, follow its instructions. Its sources are listed with ids: read one in full with read_source when it matters; image, video and audio sources are inputs by URL.
- "Context update" messages from the system later in the chat replace the matching parts of your context.`;

// ---------------------------------------------------------------------------
// Models

/** Models that take server-side fallbacks on a refusal ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

/**
 * Output room per reply: thinking plus a large generate or studio call. Extra and Max effort think
 * longest, so they get the most; the cap only bounds a reply, it isn't spent.
 */
export const maxTokensFor = (effort: AssistEffort): number => (effort === "xhigh" || effort === "max" ? 64_000 : 32_000);

export const claude: ModelCall = async ({ system, messages, tools, settings, connectors }) => {
  const client = new Anthropic({ apiKey: getSetting("anthropicKey") });
  const model = settings?.model && CLAUDE_MODELS.some((m) => m.id === settings.model) ? settings.model : DEFAULT_CLAUDE_MODEL;
  const fallback = FALLBACK_MODELS.has(model);
  const effort = settings?.effort ?? DEFAULT_EFFORT;
  // Custom MCP connectors: Anthropic's servers call them; their tools come after Fuobe's own. Under
  // mcp-client-2025-11-20 each request lists the servers' tools again; a connector switched on, off or
  // deleted mid-chat changes `tools` (and a deleted one's history is rewritten below), so Claude's
  // earlier thinking in that chat is dropped (drop_block) and re-done — a cost, not an error.
  const mcp = mcpParams(connectors ?? []);
  const history = withoutMissingServers(forAnthropic(messages), new Set(mcp?.mcp_servers.map((m) => m.name)));
  // Streamed, so long thinking at high effort never runs into an HTTP timeout; only the final
  // message is used (the UI shows the reply once it's complete).
  const stream = client.beta.messages.stream({
    model,
    max_tokens: maxTokensFor(effort),
    // drop_block: a thinking block the API can't replay (a chat that switched models, or one from
    // before contexts were frozen) is dropped instead of failing the request.
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort },
    betas: [...(fallback ? (["server-side-fallback-2026-07-01"] as const) : []), "thinking-binding-controls-2026-08-01", ...(mcp ? [MCP_BETA] : [])],
    ...(fallback && { fallbacks: "default" as const }),
    // The fixed instructions and the chat's frozen context are cached; so is the conversation so far.
    cache_control: { type: "ephemeral" },
    system: [
      { type: "text", text: system.stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: system.turn, cache_control: { type: "ephemeral" } },
    ],
    tools: mcp ? [...tools, ...mcp.toolsets] : tools,
    ...(mcp && { mcp_servers: mcp.mcp_servers }),
    messages: await hydrate(history),
  });
  return stream.finalMessage();
};

/** The history without the replay data hosted providers keep on their turns: Anthropic refuses fields it doesn't know. */
export function forAnthropic(messages: Stored[]): MessageParam[] {
  return messages.map((m) => {
    if (!("replay" in m)) return m;
    const rest = { ...m };
    delete rest.replay;
    return rest;
  });
}

/** Claude's reply shape for a model that answered through another wire. */
function reply(r: { text: string; toolCalls: { id: string; name: string; input: unknown }[]; stop: "end" | "tool_use" | "length"; model: string }, id: string): Anthropic.Beta.BetaMessage {
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  if (r.text) content.push({ type: "text", text: r.text, citations: null } as Anthropic.Beta.BetaTextBlock);
  for (const c of r.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input } as unknown as Anthropic.Beta.BetaToolUseBlock);
  const stop: Anthropic.Beta.BetaStopReason = r.toolCalls.length ? "tool_use" : r.stop === "length" ? "max_tokens" : "end_turn";
  if (!content.length) content.push({ type: "text", text: "…", citations: null } as Anthropic.Beta.BetaTextBlock);
  return { id, type: "message", role: "assistant", model: r.model, content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: null } as unknown as Anthropic.Beta.BetaMessage;
}

/**
 * A hosted model on the owner's key (OpenAI, Gemini, xAI, DeepSeek, Kimi, GLM, Qwen, OpenRouter…; src/server/llm/hosted.ts),
 * answering in Claude's shape. The history goes out shaped for that provider (hosted-messages.ts), with what it needs back
 * on its own turns (`replay`), and the reply's replay comes back for step() to keep on the stored turn.
 */
export const hosted: ModelCall = async ({ system, messages, tools, settings, threadId }) => {
  const id = settings?.provider ?? "";
  const p = getLlmProvider(id);
  const ep = endpointFor(id);
  if (!p || !ep) throw new Error(`${p?.label ?? "That provider"} isn't connected any more — add its key in Settings → AI helper, or pick another mode.`);
  const model = p.models.find((m) => m.id === settings?.model);
  if (!model) throw new Error(`${p.label} has no model ${settings?.model ?? "set"} in Fuobe's list — pick another in Manual.`);
  const r = await chatHosted(ep, model, {
    messages: toHostedMessages(system, (await hydrate(messages as MessageParam[])) as Stored[], { provider: p, model }),
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
    effort: settings?.effort ?? DEFAULT_EFFORT,
    ...(threadId && { threadKey: threadId }),
  });
  if (!r.text && !r.toolCalls.length && r.stop === "length") throw new Error(`${model.name} spent its whole reply thinking and ran out of room. Try a lower effort, or another model.`);
  const over = model.longContext && (r.usage?.input ?? 0) > model.longContext.above;
  return {
    ...reply(r, `msg_${p.id}_${nanoid(8)}`),
    replay: r.replay,
    ...(over && { priceNote: `This chat is now long enough to cost more on ${model.name}: ${model.longContext!.text.charAt(0).toLowerCase()}${model.longContext!.text.slice(1)}. A new chat costs less.` }),
  };
};

/**
 * A local model through its server's tool calling (Ollama, LM Studio, Unsloth Studio or another
 * OpenAI-compatible server; qwen3, llama3.x, mistral, gemma…), answering in the same shape as Claude.
 * The history goes out as chat messages shaped for the server (src/server/llm/messages.ts).
 */
export const local: ModelCall = async ({ system, messages, tools, settings }) => {
  const ready = await activeLocal();
  if (!ready) throw new Error(localDownNote());
  const { server, status } = ready;
  // A model picked for this chat on another server gives way to this one's default.
  const want = settings?.model;
  const model = want && (!status.models.length || status.models.some((m) => m.id === want || m.id === `${want}:latest`)) ? want : null;
  const r = await chatLocal(ready, {
    messages: toChatMessages(system, messages, server.kind),
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })),
    model,
    timeoutMs: 300_000,
  });
  // A thinking model that ran out of room says so, rather than "the reply was cut short".
  if (!r.text && !r.toolCalls.length && r.stop === "length") throw emptyReply(server, r);
  return reply(r, `msg_local_${nanoid(8)}`);
};

/** A rule-based planner with the same shape as a model reply, for installs without an LLM. */
export const offline: ModelCall = async ({ messages, ctx, skills, named }) => {
  // Context updates (system messages) aren't the user's words.
  const last = messages.findLast((m) => m.role !== "system");
  const blocks = last && typeof last.content !== "string" ? last.content : [];
  const reply = (content: Anthropic.Beta.BetaContentBlock[], stop: Anthropic.Beta.BetaStopReason): Anthropic.Beta.BetaMessage =>
    ({ id: `msg_offline_${nanoid(8)}`, type: "message", role: "assistant", model: "offline", content, stop_reason: stop, stop_sequence: null, stop_details: null, usage: null }) as unknown as Anthropic.Beta.BetaMessage;
  const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.Beta.BetaTextBlock;

  const results = blocks.filter((b): b is ToolResult => b.type === "tool_result");
  const said = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
  if (results.length && !said.trim()) {
    const body = results.map((r) => (typeof r.content === "string" ? r.content : "")).join(" ");
    if (results.some((r) => r.is_error)) return reply([text(/declined/i.test(body) ? "Okay, I won't run that. Tell me what to change." : `That didn't start: ${body.replace(/^.*"error":"([^"]+)".*$/, "$1")}`)], "end_turn");
    if (/"saved":/.test(body)) return reply([text("Saved to memory — every chat will follow it from now on.")], "end_turn");
    // A pick-the-best plan started its stills: say again how to choose the one that moves.
    const planned = messages.findLast((m) => m.role === "assistant" && typeof m.content !== "string" && m.content.some((b) => b.type === "tool_use"));
    const use = planned && typeof planned.content !== "string" ? planned.content.find((b) => b.type === "tool_use") : undefined;
    if (String((use?.input as { summary?: unknown } | undefined)?.summary ?? "").startsWith(PICK_SUMMARY)) {
      return reply([text(`On it. When the stills are in, ${PICK_ASK}: reply "animate 2" (they're numbered in order), or open one and press Animate.`)], "end_turn");
    }
    return reply([text(`On it — the results will appear here as they finish. ${FOLLOW_UP[startedKind(body)]}`)], "end_turn");
  }
  // "animate 2" after a set of stills (or a bare "2" when asked which one): animate that take.
  const picked = pickedTake(said);
  if (picked && (picked.animate || askedToPick(messages))) {
    const { stills, waiting } = latestStills(messages);
    // 1-based; "the last one" is the last, and "animate it" the only one.
    const index = picked.take === -1 ? stills.length : picked.take === 0 ? (stills.length === 1 && !waiting ? 1 : 0) : picked.take;
    const chosen = index > 0 ? stills[index - 1] : undefined;
    if (chosen) {
      const plan = animateTake(chosen, index, ctx.engine, said);
      return reply(
        [text(plan.say), { type: "tool_use", id: `toolu_offline_${nanoid(10)}`, name: plan.tool, input: plan.input, caller: { type: "direct" } } as unknown as Anthropic.Beta.BetaToolUseBlock],
        "tool_use",
      );
    }
    if (waiting) return reply([text("They're still rendering — tell me which one to animate once they're in.")], "end_turn");
    if (stills.length && picked.take === 0) return reply([text(`There are ${stills.length} stills — ${PICK_ASK}: reply "animate 2" (they're numbered in order).`)], "end_turn");
    if (stills.length) return reply([text(`Pick a number from 1 to ${stills.length}.`)], "end_turn");
    // No stills in this chat: read it as a new request.
  }
  // A skill this message named that runs by itself (the last one named): its inputs filled from the message, one
  // run_skill card. A skill loaded earlier in the chat stays a hint, so a new request isn't read as its inputs.
  for (const s of (skills ?? []).filter((k) => named?.includes(k.name)).reverse()) {
    const recipe = (s as { recipe?: boolean }).recipe ? skillRecipe(s.name) : null;
    if (!recipe) continue;
    const r = offlineSkillRun(said, s.name, s.title, recipe);
    if (!("tool" in r)) return reply([text(r.say)], "end_turn");
    return reply(
      [text(r.say), { type: "tool_use", id: `toolu_offline_${nanoid(10)}`, name: r.tool, input: r.input, caller: { type: "direct" } } as unknown as Anthropic.Beta.BetaToolUseBlock],
      "tool_use",
    );
  }
  const hint = skills?.find((s) => s.offline)?.offline;
  const plan = offlinePlan(said, ctx.engine, hint);
  if (!plan) return reply([text("Tell me what to make — an image, a video, a voice-over or a storyboard — and attach any photos to use.")], "end_turn");
  // step() adds OFFLINE_NOTE as a quiet line under the plan card.
  return reply(
    [text(plan.say), { type: "tool_use", id: `toolu_offline_${nanoid(10)}`, name: plan.tool, input: plan.input, caller: { type: "direct" } } as unknown as Anthropic.Beta.BetaToolUseBlock],
    "tool_use",
  );
};

const TYPE_NAMES: Record<string, string> = { image: "an image", video: "a video", audio: "an audio file", text: "words", number: "a number", choice: "a choice", element: "an element" };

/**
 * A saved skill that runs by itself, from a message (no LLM): its media inputs from the attached files by kind and
 * order, its first text input from the words, the rest from their defaults or the values it was made with. A required
 * input still empty (a file that wasn't attached) is asked for by name instead.
 */
export function offlineSkillRun(message: string, name: string, title: string, recipe: Recipe): { tool: "run_skill"; input: Record<string, unknown>; say: string } | { say: string } {
  const [body, attached = ""] = message.split(/\n\nAttached files[^\n]*\n/);
  const files = [...attached.matchAll(/^- (image|video|audio|text|model3d) \d+: (\S+)$/gm)].map((m) => ({ kind: m[1], url: m[2] }));
  // A lone "/name" (with files) gets words written for it: those aren't the person's.
  const words = /^Use the .+ skills?(?: with the attached files)?\.$/.test(body.trim()) ? "" : body.trim();
  const values: Record<string, string | number> = {};
  const taken = new Set<number>();
  let wordsUsed = false;
  const filled: string[] = [];
  for (const p of recipe.params) {
    if (isMediaType(p.type)) {
      const i = files.findIndex((f, k) => !taken.has(k) && f.kind === p.type);
      if (i >= 0) {
        taken.add(i);
        values[p.id] = files[i].url;
        filled.push(`your ${p.type}`);
        continue;
      }
      // A file the person didn't attach is theirs to give: only a default stands in, never the one it was made with.
      if (p.default !== undefined && p.default !== "") values[p.id] = p.default;
      continue;
    }
    if (p.type === "text" && !wordsUsed && words) {
      wordsUsed = true;
      values[p.id] = words.slice(0, p.max ?? RECIPE_LIMITS.text);
      filled.push(`“${words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words}”`);
      continue;
    }
    const v = p.default ?? p.example;
    if (v !== undefined && v !== null && v !== "") values[p.id] = v;
  }
  const missing = recipe.params.filter((p) => p.required && values[p.id] === undefined);
  if (missing.length) {
    const need = missing.map((p) => `${p.label} (${TYPE_NAMES[p.type] ?? p.type})`);
    const media = missing.some((p) => isMediaType(p.type));
    return { say: `${title} needs ${need.length > 1 ? `${need.slice(0, -1).join(", ")} and ${need.at(-1)}` : need[0]}. ${media ? "Attach it and send /" + name + " again." : `Send /${name} with it.`}` };
  }
  return {
    tool: "run_skill",
    input: { name, values },
    say: `I'll run your ${title} skill${filled.length ? ` with ${filled.join(" and ")}` : ""}: the same steps it was saved with, priced below.`,
  };
}

/** Under every offline plan: the rule-based planner is a fallback, not the assistant. */
export const OFFLINE_NOTE = "Offline planner — connect a model in Settings → AI helper (Anthropic, OpenAI, Google, OpenRouter… or a local model) for better plans.";

/** What to offer next, by what was just started. */
const FOLLOW_UP: Record<MediaKind, string> = {
  image: "Want variations, a different look, or to animate one?",
  video: "Want another take, a different camera move, or a longer cut?",
  audio: "Want another voice, a different pace, or to put it on a video?",
  text: "Want it shorter, in another tone, or voiced?",
  model3d: "Want another take, or a model from a different photo?",
};

/**
 * The generation ids a tool result started, in order: every id of each `"started": [...]` list (on
 * the open engine 4 takes are 4 generations of one job) and each `"id": "..."`.
 */
const startedIds = (body: string) =>
  [...body.matchAll(/"started":\s*\[([^\]]*)\]|"(?:started|id)":\s*"([\w-]+)"/g)].flatMap((m) => (m[2] ? [m[2]] : [...m[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1])));

/** The kind of the last generation a tool result started (the end of a chain), image when unknown. */
function startedKind(body: string): MediaKind {
  for (const id of startedIds(body).reverse()) {
    const g = getGeneration(id);
    if (g) return g.kind;
  }
  return "image";
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NUM = "(\\d|one|two|three|four|five|six|seven|eight)";
const num = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s);

/** Nouns a count can come before ("4 portraits", "three vertical videos", "a 6-frame heist"). */
const COUNTED = "images?|pictures?|photos?|portraits?|headshots?|avatars?|stills?|posters?|thumbnails?|logos?|icons?|looks?|renders?|versions?|takes?|variations?|options?|videos?|clips?|frames?|panels?|scenes?";
const COUNT = new RegExp(`\\b${NUM}(?:-|\\s+(?:([\\w-]+)\\s+)?)(${COUNTED})\\b`, "i");
const COUNTS = new RegExp(COUNT.source, "gi");
/** Nouns that only ever count takes ("4 versions", "two takes"), wherever they are in a request. */
const TAKE_NOUN = /^(?:takes?|versions?|variations?|options?)$/i;
/** Words that start a phrase about what's in the picture: a count after one ("a card with 3 icons", "a collage of 3 photos") is part of it. */
const CONTENT_WORD = /\b(?:with|of|showing|featuring|containing|including|holding|having|and|plus|from|in|on)\b/i;
/** What a still can be called, singular or plural, before "then animate it". */
const STILL = /\b(stills?|photos?|pictures?|images?|portraits?|headshots?|posters?|frames?|shots?|renders?|key ?visuals?)\b/i;
/** "… then pick the best and animate it": the person chooses which take moves. */
const PICK_WORDS = /\b(best|favou?rite|pick|choose|select|strongest|one of them)\b/;

const singular = (noun: string) => noun.replace(/([^s])s$/i, "$1");

/**
 * The count that says how many takes to make: "4 portraits of …", "make three posters", "a fox,
 * 2 versions". A count inside the description ("a birthday card with 3 icons", "a collage of 3
 * photos") is what the picture shows: it stays in the prompt and makes no extra takes.
 */
function takeCount(text: string): RegExpExecArray | null {
  for (const m of text.matchAll(COUNTS)) {
    if (TAKE_NOUN.test(m[3]) || !CONTENT_WORD.test(text.slice(0, m.index))) return m as RegExpExecArray;
  }
  return null;
}

/**
 * One take's prompt: "Make 4 moody portraits of a keeper" → "Moody portrait of a keeper". The take
 * count (takeCount) goes to `outputs`; left in the prompt, each image could come back as a grid of
 * four. Other numbers stay as written.
 */
function oneTake(text: string, take: RegExpExecArray | null): string {
  // "4 moody portraits" → "moody portrait"; "3 versions of a logo" → "a logo".
  const meta = !!take && TAKE_NOUN.test(take[3]);
  const after = take ? text.slice(take.index + take[0].length) : "";
  const counted = take ? `${text.slice(0, take.index)}${meta ? "" : `${take[2] ? `${take[2]} ` : ""}${singular(take[3])}`}${meta ? after.replace(/^\s+of\b/i, "") : after}` : text;
  const s = counted
    .replace(/^\s*(?:please\s+)?(?:make|create|generate|give me|draw|shoot|render|design)(?:\s+me)?\s+/i, "")
    .replace(new RegExp(`\\b${NUM}[- ]shots?\\s*`, "i"), "")
    .replace(/\s+([,;.])/g, "$1")
    .replace(/([,;])(?:\s*[,;])+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;:—–-]+$/, "")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "a 10-second video", "into a 5 s clip": the length asked for, in seconds. */
function secondsAsked(t: string): number | undefined {
  const m = /\b(\d{1,3})\s*-?\s*(?:s|secs?|seconds?)\b/.exec(t);
  return m ? Number(m[1]) : undefined;
}

/** The model's own length closest to the one asked for (a model that lists none takes it as it is). */
function fitDuration(modelId: string, seconds: number | undefined): number | undefined {
  if (!seconds) return undefined;
  const listed = getModel(modelId)?.options.durations;
  if (!listed?.length) return seconds;
  return listed.reduce((best, d) => (Math.abs(d - seconds) < Math.abs(best - seconds) ? d : best), listed[0]);
}

/** Whether a model can make its own soundtrack ("with sound"). */
const makesSound = (modelId: string) => !!getModel(modelId)?.routes.some((r) => r.map?.generateAudio);

/** How every pick-the-best plan's card title starts (the follow-up reply reads it back). */
const PICK_SUMMARY = "Pick the best";
/** The question a pick-the-best plan asks; a bare "2" answers it. */
const PICK_ASK = "tell me which one to animate";

const engineFor = (preferred: Engine): Engine => {
  const mode = engineMode();
  return mode === "both" ? preferred : mode;
};

const TALK = "(?:dialogue|dialog|talking|speech|voices?|speaking|narration)";
const REMOVE_TALK = new RegExp(`\\b(?:remove|take out|strip|cut|get rid of|mute|drop|delete|without)\\b[^.?!]*\\b${TALK}\\b|\\bno ${TALK}\\b`);
const ONLY_TALK = new RegExp(`\\b(?:just|only|isolate|extract|keep)\\b[^.?!]*\\b${TALK}\\b|\\b${TALK} only\\b`);
const ONLY_MUSIC = /\b(?:just|only|isolate|extract|keep)\b[^.?!]*\bmusic\b|\bmusic only\b/;
const AND_EFFECTS = /\b(?:and|&|plus)\s+(?:the\s+)?(?:effects|sfx|sound effects)\b/;
const LOWER_MUSIC = /\b(?:lower|turn down|duck|quieter|reduce)\b[^.?!]*\b(?:music|background|score)\b/;
/**
 * Another studio's job owns the sentence ("dub this and keep the music", "restyle it as anime, keep the music", "transcribe
 * just the speech", "cut it down to 10 seconds and keep the speech"): the sound words describe that job, not a split.
 */
const OTHER_JOB =
  /\b(?:dub(?:bed|bing)?|translate|restyle|anime|cartoon|style|transcri(?:be|ption|pt)|subtitles?|captions?|lip ?sync|trim|shorten|upscale|animate|extend|loop)\b|\bcut\b[^.?!]*\bdown\b|\b\d+(?:\.\d+)?\s*(?:s|secs?|seconds?|minutes?|mins?)\b/;
/** A recording's own faults (noise, echo, hiss, hum, a clean-up) are Clean up voice's, not a split's. */
const VOICE_REPAIR = /\b(?:noise|noisy|echo|reverb|hiss|hum|crackle|clean(?:er|ed|up)?|denoise|muffled)\b/;
const SPLIT_SOUND = /\b(?:split|separate)\b[^.?!]*\b(?:soundtrack|audio|sound|stems?|dialogue|music|effects)\b|\bstems\b/;

/**
 * An attached clip's sound taken apart (split_soundtrack, remove_dialogue): the talking taken out or kept alone, just the
 * music, the music lowered, or the four stems. Null when the words ask for none of that or no audio or video is attached.
 */
export function soundPlan(t: string, files: { kind: string; url: string }[]): { tool: string; input: Record<string, unknown>; say: string } | null {
  const media = files.find((f) => f.kind === "video") ?? files.find((f) => f.kind === "audio");
  if (!media) return null;
  if (OTHER_JOB.test(t) || VOICE_REPAIR.test(t)) return null;
  const video = media.kind === "video";
  const removeTalk = REMOVE_TALK.test(t);
  const onlyTalk = ONLY_TALK.test(t);
  const db = /(-?\d{1,2})\s*db\b/.exec(t);
  const by = db ? -Math.min(30, Math.abs(Number(db[1]))) : -12;
  if (LOWER_MUSIC.test(t) && !removeTalk) {
    if (video) return { tool: "remove_dialogue", input: { video: media.url, keep: "dialogue", music_db: by }, say: `I'll keep the talking and lower the music and effects by ${-by} dB under it. The picture stays exactly as it is.` };
    return { tool: "split_soundtrack", input: { media: media.url, levels_db: { music: by, effects: by } }, say: `I'll remix it with the music and effects ${-by} dB lower under the talking.` };
  }
  if (removeTalk && !onlyTalk) {
    if (video) return { tool: "remove_dialogue", input: { video: media.url, keep: "bed" }, say: "I'll take the talking out and keep the music and sound effects. The picture stays exactly as it is." };
    return { tool: "split_soundtrack", input: { media: media.url, keep: ["music", "effects"] }, say: "I'll take the talking out and keep the music and sound effects." };
  }
  if (ONLY_MUSIC.test(t) && !AND_EFFECTS.test(t)) return { tool: "split_soundtrack", input: { media: media.url, keep: ["music"] }, say: "I'll pull out just the music." };
  if (onlyTalk) {
    if (video) return { tool: "remove_dialogue", input: { video: media.url, keep: "dialogue" }, say: "I'll keep only the talking: the music and effects go. The picture stays exactly as it is." };
    return { tool: "split_soundtrack", input: { media: media.url, keep: ["dialogue"] }, say: "I'll keep just the talking." };
  }
  if (SPLIT_SOUND.test(t)) return { tool: "split_soundtrack", input: { media: media.url }, say: "I'll split it into dialogue, music, effects and music & effects." };
  return null;
}

/**
 * Read a request into one tool call: counts ("3 vertical videos", "4 portraits"), formats, lengths,
 * attachments, multi-shot ("a 3-shot ad"), a still that is then animated (two chained jobs), several
 * stills to pick the best from before animating, storyboards, music and voice-overs, translations and
 * scripts, and "remember that …". A loaded skill's offline hints (its kind, format, count and style)
 * fill in what the words leave open.
 */
export function offlinePlan(message: string, preferred: Engine, hint?: SkillMeta["offline"]): { tool: string; input: Record<string, unknown>; say: string } | null {
  const [body, attached = ""] = message.split(/\n\nAttached files[^\n]*\n/);
  const text = body.trim();
  if (!text) return null;
  const files = [...attached.matchAll(/^- (image|video|audio|text|model3d) \d+: (\S+)$/gm)].map((m) => ({ kind: m[1], url: m[2] }));
  const images = files.filter((f) => f.kind === "image").map((f) => f.url);
  const t = text.toLowerCase();
  const engine = engineFor(preferred);

  // "Remember that I always want 9:16" → a memory (approved like a plan in ask-first mode).
  const memory = /^(?:please\s+)?(?:remember|note|keep in mind)(?:\s+that)?[:,]?\s+(.{4,})$/is.exec(text);
  if (memory) {
    const what = memory[1].trim().replace(/\.$/, "");
    const sentence = `${what.charAt(0).toUpperCase()}${what.slice(1)}.`;
    return { tool: "remember", input: { text: sentence, category: guessCategory(what) }, say: "I'll remember that for every chat." };
  }

  // Any count: a storyboard's frames ("a 6-frame heist"). The take count: how many pictures to make.
  const counted = COUNT.exec(t);
  const count = counted ? num(counted[1]) : hint?.outputs;
  const take = takeCount(text);
  const takes = take ? num(take[1]) : hint?.outputs;
  // "a 3-shot ad", "in 4 shots": one clip cut into shots, not several clips.
  const shots = (() => {
    const m = new RegExp(`\\b${NUM}[- ]shots?\\b`).exec(t) ?? new RegExp(`\\bin\\s+${NUM}\\s+shots\\b`).exec(t);
    return m ? Math.max(2, Math.min(6, num(m[1]))) : undefined;
  })();
  const aspect = /\b(vertical|portrait|9:16|reels?|tiktok|stories|story format)\b/.test(t) ? "9:16" : /\b(square|1:1)\b/.test(t) ? "1:1" : /\b(wide|landscape|16:9|widescreen)\b/.test(t) ? "16:9" : hint?.aspect;
  const seconds = secondsAsked(t);
  const withSound = /\b(with|plus|and) (sound|audio|sfx|sound effects)\b/.test(t);
  // A studio's default, or the next model that is on when Settings → Models & licences switched it off.
  const pick = (d: { cloud: string; open: string }) => offeredDefault(engine === "open" && d.open ? d.open : d.cloud, engine === "open" && d.open ? "open" : "cloud")!;
  // A clip cut into shots ("a 3-shot ad") runs on the Video studio's default when it makes shots, else on the next model in
  // the studio's Best list that does (MiniMax H3 makes one shot a clip: Seedance 2.5 in the cloud, LTX-2.5 on your GPU).
  const videoModel = () => {
    const id = pick(VIDEO_STUDIO.defaultModels);
    if (!shots || getModel(id)?.options.multiShot) return id;
    const ops = VIDEO_STUDIO.pickerOps ?? VIDEO_STUDIO.ops;
    const best = studioBest(filterModels(CATALOG_MODELS, { kind: "video", ops }), engine, id, ops);
    return best.find((b) => b !== id && getModel(b)?.options.multiShot && offeredDefault(b, engine) === b) ?? id;
  };
  const textModel = engine === "open" ? "oss-text-llm" : "text-llm";
  const styled = (p: string) => (hint?.style ? `${p}. ${hint.style}` : p);
  // The video settings a clip takes from the words: its length (one the model lists) and its own sound.
  const clipParams = (modelId: string) => {
    const duration = shots ? undefined : fitDuration(modelId, seconds);
    return { ...(duration && { duration }), ...(withSound && makesSound(modelId) && { generate_audio: true }) };
  };

  // "… hero still, then animate it": the image first, then a video made from it (one plan, two chained jobs).
  const thenAnimate = /\bthen\b[^.?!]*\b(animate|animated|animation|bring (it|them) to life|make (it|them) move|turn (it|them) into an? (video|clip))\b/.test(t);
  const [beforeThen, ...rest] = text.split(/[,;]?\s*\bthen\b/i);
  const afterThen = rest.join(" then ").toLowerCase();
  if (thenAnimate && STILL.test(beforeThen)) {
    const stills = takeCount(beforeThen);
    const subject = oneTake(beforeThen, stills);
    const n = Math.max(1, Math.min(4, stills ? num(stills[1]) : 1));
    const stillModel = pick(images.length ? EDIT_STUDIO.defaultModels : IMAGE_STUDIO.defaultModels);
    const clipModel = videoModel();
    const still = { model_id: stillModel, prompt: styled(subject), ...(images.length && { images: images.slice(0, 4) }), ...(aspect && { aspect_ratio: aspect }) };
    const motion = `${subject}. The still comes to life: smooth, cinematic camera motion, natural movement.`;
    const clip = (after: number) => ({ model_id: clipModel, prompt: motion, after, ...(shots && { shots }), ...(aspect && { aspect_ratio: aspect }), ...clipParams(clipModel) });
    // Several stills: the person picks the one to animate ("animate 2"), unless they asked to animate them all.
    const all = /\b(them all|all of them|each|every one|both)\b/.test(afterThen) || (/\bthem\b/.test(afterThen) && !PICK_WORDS.test(afterThen));
    if (n > 1 && all) {
      const pairs = Math.min(3, n);
      return {
        tool: "generate",
        input: { summary: `${pairs} stills, each animated: ${subject.slice(0, 60)}`, jobs: Array.from({ length: pairs }, (_, i) => [still, clip(i * 2)]).flat() },
        say: `I'll make ${pairs} stills and animate each one — every video starts by itself as soon as its still is ready.`,
      };
    }
    if (n > 1 || PICK_WORDS.test(afterThen)) {
      const takes = Math.max(2, n);
      return {
        tool: "generate",
        input: { summary: `${PICK_SUMMARY} of ${takes} stills, then animate it: ${subject.slice(0, 60)}`, jobs: [{ ...still, outputs: takes }] },
        say: `I'll make ${takes} stills first. Once they're in, ${PICK_ASK} — reply "animate 2" (they're numbered in order), or open one and press Animate.`,
      };
    }
    return {
      tool: "generate",
      input: { summary: `Still, then animated: ${subject.slice(0, 70)}`, jobs: [still, clip(0)] },
      say: `I'll make the still first, then animate it${shots ? ` as a ${shots}-shot clip` : ""} — the video starts by itself as soon as the still is ready.`,
    };
  }

  if (/\b(storyboard|comic|panels|shot list)\b/.test(t) || (count && /\b(frames|scenes|panels)\b/.test(t)) || (counted && /^(frame|scene|panel)s?$/i.test(counted[3]))) {
    const frames = Math.max(1, Math.min(8, count ?? 4));
    return {
      tool: "create_storyboard",
      input: { story: text, frames, ...(images.length && { references: images.slice(0, 4) }), ...(aspect && { aspect_ratio: aspect }), ...(hint?.style && { style: hint.style }) },
      say: `I'll split that into ${frames} frames with the same characters and look, each made from the one before.`,
    };
  }

  // Text steps: translations and scripts run on the LLM (demo text when none is connected).
  const lang = /\btranslat\w*\b[^:]*?\b(?:into|to)\s+([a-z]+(?:\s\([^)]*\))?)/i.exec(text)?.[1];
  if (lang && /\btranslat/.test(t)) {
    const language = lang.charAt(0).toUpperCase() + lang.slice(1);
    const source = /["“]([^"”]+)["”]/.exec(text)?.[1] ?? (text.includes(":") ? text.slice(text.indexOf(":") + 1).trim() : text);
    return {
      tool: "generate",
      input: { summary: `Translate into ${language}`, jobs: [{ model_id: textModel, op: "translate", prompt: source, target_language: language }] },
      say: `I'll translate that into ${language}.`,
    };
  }
  // A soundtrack taken apart (DBS on the open engine): "remove the dialogue from this video", "just the music".
  const sound = soundPlan(t, files);
  if (sound) return sound;
  const isMusic = /\b(music|song|soundtrack|beat|jingle)\b/.test(t);
  const isWriting =
    !isMusic &&
    ((/^(please\s+)?(write|draft|come up with|give me)\b/.test(t) && /\b(script|scripts|copy|captions?|taglines?|slogans?|hooks?|outline|story|poem|email|description|post|blog|headlines?|lines)\b/.test(t)) ||
      (hint?.kind === "text" && !files.length));
  if (isWriting) {
    return {
      tool: "generate",
      input: { summary: `Write: ${text.slice(0, 80)}`, jobs: [{ model_id: textModel, op: "write", prompt: text }] },
      say: "I'll write that for you.",
    };
  }
  const isSpeech = !isMusic && (/\b(voice ?over|narrat\w*|read (this|it|out)|say|speak|text to speech|tts)\b/.test(t) || hint?.kind === "audio");
  const isVideo =
    !isMusic && !isSpeech && (files.some((f) => f.kind === "video") || !!shots || /\b(videos?|clips?|animate|animation|motion|films?|footage|movies?|trailers?|commercials?|ads?)\b/.test(t) || hint?.kind === "video");
  if (isMusic || isSpeech) {
    const quoted = /["“]([^"”]+)["”]/.exec(text)?.[1] ?? text.replace(/^.*?:\s*/, "");
    return {
      tool: "generate",
      input: { summary: isMusic ? "A music track" : "A voice-over", jobs: [{ model_id: pick(isMusic ? MUSIC_STUDIO.defaultModels : AUDIO_STUDIO.defaultModels), prompt: isMusic ? text : quoted }] },
      say: isMusic ? "Here's a track for that." : "I'll record that as a voice-over.",
    };
  }
  const studio = isVideo ? VIDEO_STUDIO : images.length ? EDIT_STUDIO : IMAGE_STUDIO;
  const n = Math.max(1, Math.min(4, takes ?? (isVideo ? 1 : 2)));
  const multi = isVideo && shots ? shots : undefined;
  const modelId = isVideo ? videoModel() : pick(studio.defaultModels);
  const job = {
    model_id: modelId,
    prompt: styled(take ? oneTake(text, take) : text),
    ...(images.length && { images: images.slice(0, isVideo ? 1 : 4) }),
    ...(aspect && { aspect_ratio: aspect }),
    ...(n > 1 && { outputs: n }),
    ...(multi && { shots: multi }),
    ...(isVideo && clipParams(modelId)),
  };
  const what = isVideo
    ? `${images.length ? "animate your image" : `make ${n > 1 ? `${n} videos` : "the video"}`}${multi ? ` as ${multi} shots` : ""}`
    : images.length
      ? "edit your image"
      : `make ${n} take${n === 1 ? "" : "s"}`;
  return { tool: "generate", input: { summary: `${isVideo ? "Video" : images.length ? "Edit" : "Image"}: ${text.slice(0, 80)}`, jobs: [job] }, say: `I'll ${what} with the default ${isVideo ? "video" : "image"} model.` };
}

// ---------------------------------------------------------------------------
// Picking a take to animate ("animate 2")

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, last: -1 };
const ORDINAL = /(?:#|\b)(\d)(?:st|nd|rd|th)?\b|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|last)\b/;

/** "animate it", "now bring that one to life": motion for the still, without naming which. */
const ANIMATE_IT = /^(?:(?:now|ok|okay|great|nice|please|cool)[,!]?\s+)*(?:animate (?:it|that|this)|bring (?:it|that|this)(?: one)? to life|make (?:it|that|this)(?: one)? move)\b/;

/**
 * Which take a short reply names: "animate 2", "the second one", "#3", "go with the last one".
 * 1-based; -1 is the last; 0 is "animate it" (the only still, or a question when there are more).
 * `animate` says the reply asked for motion itself; a bare "2" only answers a pick-the-best plan's
 * question. Lengths, formats and times aren't take numbers ("for 5 seconds", "in 9:16", "at 24
 * fps"). Null for anything else, a new request included.
 */
export function pickedTake(message: string): { take: number; animate: boolean } | null {
  const t = message.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!t || t.length > 60 || COUNT.test(t)) return null;
  const animate = /\b(animate|bring (it|that one|this one) to life|make (it|that one|this one) move)\b/.test(t);
  const numbers = t
    .replace(/\b\d+\s*:\s*\d+\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*-?\s*(?:s|secs?|seconds?|mins?|minutes?|fps|k|p|x|%)(?![\w])/g, " ")
    .replace(/\b(?:for|in|at|to|by|of|under|over)\s+\d+\b/g, " ");
  const m = ORDINAL.exec(numbers);
  if (!m) return animate && ANIMATE_IT.test(t) ? { take: 0, animate } : null;
  const take = m[1] ? Number(m[1]) : ORDINALS[m[2]];
  if (!take) return null;
  const bare = new RegExp(
    `^(?:(?:let'?s|i'?ll|i'?d)\\s+)?(?:(?:go with|use|pick|choose|take|like|want|prefer|animate)\\s+)?(?:the\\s+)?(?:number\\s+|no\\.?\\s*|take\\s+|image\\s+|still\\s+)?(?:${ORDINAL.source})(?:\\s+(?:one|image|still|take|pic(?:ture)?|photo))?(?:,?\\s+please)?$`,
  ).test(t);
  return animate || bare ? { take, animate } : null;
}

type MessageList = MessageParam[];

/** The words of a message (its text blocks). */
const wordsOf = (c: MessageParam["content"]) => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : "")).join("\n"));

/** Did the assistant's last words ask which take to animate? */
function askedToPick(messages: MessageList): boolean {
  const last = messages.findLast((m) => m.role === "assistant" && wordsOf(m.content).trim());
  return !!last && wordsOf(last.content).includes(PICK_ASK);
}

/**
 * The stills of the latest tool result that made images, numbered as the chat shows them (each
 * generation's outputs in order). `waiting`: some are still rendering.
 */
function latestStills(messages: MessageList): { stills: { url: string; g: Generation }[]; waiting: boolean } {
  for (const m of [...messages].reverse()) {
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (const b of [...m.content].reverse()) {
      if (b.type !== "tool_result" || typeof b.content !== "string") continue;
      const gens = startedIds(b.content)
        .map((id) => getGeneration(id))
        .filter((g): g is Generation => !!g && g.kind === "image");
      if (!gens.length) continue;
      const stills = gens.flatMap((g) => (g.status === "succeeded" ? g.outputs.filter((o) => o.kind === "image").map((o) => ({ url: o.url, g })) : []));
      return { stills, waiting: gens.some((g) => g.status === "queued" || g.status === "running") };
    }
  }
  return { stills: [], waiting: false };
}

/** Animate one picked still with the default video model. */
function animateTake(still: { url: string; g: Generation }, take: number, preferred: Engine, said: string): { tool: string; input: Record<string, unknown>; say: string } {
  const engine = engineFor(preferred);
  const modelId = offeredDefault(engine === "open" ? VIDEO_STUDIO.defaultModels.open : VIDEO_STUDIO.defaultModels.cloud, engine)!;
  const subject = (still.g.request.prompt ?? "").trim().replace(/[.\s]+$/, "") || "The picture";
  const duration = fitDuration(modelId, secondsAsked(said.toLowerCase()));
  return {
    tool: "generate",
    input: {
      summary: `Animate take ${take}: ${subject.slice(0, 70)}`,
      jobs: [{ model_id: modelId, prompt: `${subject}. The still comes to life: smooth, cinematic camera motion, natural movement.`, images: [still.url], ...(duration && { duration }) }],
    },
    say: `I'll animate take ${take} with the default video model.`,
  };
}

// ---------------------------------------------------------------------------
// The loop

function toolCtx(s: State): ToolContext {
  return {
    engine: s.thread.engine,
    thread: {
      id: s.thread.id,
      projectId: s.ext.projectId,
      get skills() {
        return s.ext.skills;
      },
      loadSkill: (name) => {
        if (!s.ext.skills.includes(name)) s.ext.skills = [...s.ext.skills, name];
      },
    },
  };
}

/** A call's generations remember the call (Save as skill matches each call to what it made, whatever its result says). */
const madeBy = (it: AssistItem, use: string): AssistItem => (it.role === "generations" ? { ...it, use } : it);

async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ result: Omit<ToolResult, "tool_use_id">; items: AssistItem[] }> {
  const out = await executeTool(name, input, ctx);
  return { result: { type: "tool_result", content: out.content, ...(out.isError && { is_error: true }) }, items: out.items ?? [] };
}

function ordered(results: ToolResult[], order: string[]): ToolResult[] {
  return [...results].sort((a, b) => order.indexOf(a.tool_use_id) - order.indexOf(b.tool_use_id));
}

/**
 * The chat's system prompt and, when something changed since the model last looked, the
 * "Context update" message to append. The first call freezes the context into the system prompt.
 */
function contextFor(s: State, connectors: Connector[]): { system: ModelRequest["system"]; update: MessageParam | null; sent: Record<string, string> } {
  const facts = chatFacts({
    engine: s.thread.engine,
    autoApprove: s.thread.autoApprove,
    projectId: s.ext.projectId,
    skills: s.ext.skills,
    capUsd: s.ext.capUsd,
    scheduleId: s.ext.scheduleId,
    connectors: connectors.map((c) => c.name),
  });
  const sent = factMap(facts);
  if (!s.ext.context) {
    s.ext.context = renderContext(facts);
    s.ext.sent = sent;
    return { system: { stable: STABLE_SYSTEM, turn: s.ext.context }, update: null, sent };
  }
  // A system message must follow a user turn (the user's words or tool results).
  const text = s.messages.at(-1)?.role === "user" ? contextUpdate(s.ext.sent ?? {}, facts) : null;
  return { system: { stable: STABLE_SYSTEM, turn: s.ext.context }, update: text ? { role: "system", content: text } : null, sent };
}

/** "Notion · search_pages": each connector tool Claude used in a reply, marked when it failed. */
function connectorItems(s: State, content: Anthropic.Beta.BetaContentBlock[]): void {
  const shown = new Map<string, AssistItem>();
  for (const b of content) {
    if (b.type === "mcp_tool_use") {
      const name = connectorName(b.server_name);
      shown.set(b.id, push(s, { role: "tool", text: `${name} · ${b.name}`, connector: name }));
    } else if (b.type === "mcp_tool_result" && b.is_error) {
      const item = shown.get(b.tool_use_id);
      if (item?.role === "tool") item.failed = true;
    }
  }
}

async function step(s: State, model: ModelCall): Promise<"continue" | "stop"> {
  const ctx = toolCtx(s);
  const connectors = chatConnectors(s);
  const { system, update, sent } = contextFor(s, connectors);
  const active = s.ext.skills.map((n) => getSkill(n)).filter((x): x is NonNullable<typeof x> => !!x);
  const latest = s.thread.items.findLast((i) => i.role === "user");
  const res = await model({
    system,
    messages: update ? [...s.messages, update] : s.messages,
    tools: apiTools(),
    ctx,
    settings: { model: s.ext.model, effort: s.ext.effort, provider: s.ext.provider },
    threadId: s.thread.id,
    skills: active,
    named: latest?.role === "user" ? (latest.skills ?? []) : [],
    ...(connectors.length && { connectors }),
  });

  if (res.stop_reason === "refusal") {
    // Nothing is appended: the user's turn stays last and their next message joins it.
    push(s, { role: "notice", tone: "error", text: res.stop_details?.explanation || "Claude declined this request. Try rephrasing it." });
    return "stop";
  }
  if (res.stop_reason === "model_context_window_exceeded") {
    push(s, { role: "notice", tone: "error", text: "This chat is too long to continue. Start a new one." });
    return "stop";
  }
  // The update is now part of the conversation the model answered.
  if (update) {
    s.messages.push(update);
    s.ext.sent = sent;
  }
  // A hosted provider's replay data stays on its turn (it goes back only to that provider; forAnthropic strips it).
  s.messages.push({ role: "assistant", content: res.content, ...(res.replay && { replay: res.replay }) } as MessageParam);
  if (res.priceNote && !s.thread.items.some((i) => i.role === "notice" && i.text === res.priceNote)) push(s, { role: "notice", tone: "info", text: res.priceNote });
  connectorItems(s, res.content);
  const text = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
  if (text) push(s, { role: "assistant", text });
  if (res.stop_reason === "pause_turn") return "continue";

  const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  if (res.stop_reason === "max_tokens") {
    if (!uses.length) {
      push(s, { role: "notice", tone: "info", text: "The reply was cut short." });
      return "stop";
    }
    // A cut-off tool call may be incomplete: don't run it, ask for a shorter one.
    s.messages.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, is_error: true, content: "Your reply hit the output limit before this call was complete. Make the call again, shorter." })) });
    return "continue";
  }
  if (!uses.length) return "stop";

  const results: ToolResult[] = [];
  const gated: Pending["gated"] = [];
  // Why auto-run left a plan for the user: it would pass this chat's cost cap.
  const held: string[] = [];
  // The rule-based planner says so in a quiet line under its plan (or under the jobs it started).
  const offlineNote = () => {
    if (model === offline) push(s, { role: "notice", tone: "info", text: OFFLINE_NOTE });
  };
  for (const u of uses) {
    let price: number | null = null;
    if (getTool(u.name)?.gated) {
      let ask = !s.thread.autoApprove;
      // Auto-run with a cap (a scheduled run): what fits starts on its own, the rest waits for the user.
      if (!ask && s.ext.capUsd !== null) {
        price = spendOf(planFor(u.name, u.input, ctx).jobs);
        const fits = withinCap(s.ext.capUsd, s.ext.spentUsd, price);
        if (!fits.ok) {
          ask = true;
          held.push(fits.reason);
        }
      }
      if (ask) {
        // Malformed arguments (common from small local models) go straight back as an error the model can fix, not onto an approval card.
        const invalid = validateInput(u.name, u.input, ctx);
        if (invalid) {
          results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: invalid });
          continue;
        }
        gated.push({ id: u.id, name: u.name, input: u.input });
        continue;
      }
    }
    const { result, items } = await runTool(u.name, u.input, ctx);
    results.push({ ...result, tool_use_id: u.id });
    if (price && !result.is_error) s.ext.spentUsd = Math.round((s.ext.spentUsd + price) * 1000) / 1000;
    for (const it of items) push(s, madeBy(it, u.id));
  }
  const order = uses.map((u) => u.id);
  if (gated.length) {
    const plans = gated.map((g) => planFor(g.name, g.input, ctx));
    const jobs = plans.flatMap((p) => p.jobs);
    const total = plans.some((p) => p.total === null) ? null : plans.reduce((n, p) => n + (p.total ?? 0), 0);
    const summary = [...new Set(gated.map((g) => cardTitle(g.name, g.input)))].join(" · ");
    const opens = [...new Set(plans.flatMap((p) => (p.studio ? [p.studio] : [])))];
    // Two calls that fall back for the same reason say it once.
    const notes = [...new Set(plans.flatMap((p) => (p.fallback ? [`${p.fallback}.`] : [])))];
    const item = push(s, { role: "approval", summary, jobs, totalUsd: total, status: "pending", ...(opens.length && { opens }), ...(notes.length && { notes }) });
    if (held.length) push(s, { role: "notice", tone: "info", text: `Waiting for you: ${[...new Set(held)].join("; ")}. Auto-run only starts what fits the cap.` });
    offlineNote();
    s.pending = { approvalItemId: item.id, results, gated, order };
    s.thread.status = "waiting";
    return "stop";
  }
  offlineNote();
  s.messages.push({ role: "user", content: ordered(results, order) });
  return "continue";
}

const MODELS: Record<AssistThread["agent"], ModelCall> = { claude, hosted, local, offline };

/**
 * A free model's limit ran out mid-chat (Free, or a Smart pick that was free): the chat moves to the next free choice
 * (never a paid one) and says so. A limit shared by all of a provider's free models (OpenRouter's) skips them all.
 * True when the step should be tried again.
 */
async function nextFree(s: State, e: FreeLimitError): Promise<boolean> {
  markFreeSpent(e.provider, e.span);
  const was = modelName(s.thread.agent, s.ext.provider, s.ext.model);
  const r = await resolveMode({ mode: "free" });
  applyMode(s, { ...r, mode: s.ext.mode === "manual" ? "free" : (s.ext.mode ?? "free"), note: undefined });
  const p = getLlmProvider(e.provider)?.short ?? e.provider;
  const when = e.span === "day" ? "for today" : "for the moment";
  push(s, { role: "notice", tone: "info", text: `${p}'s free requests are used up ${when}, so this chat goes on with ${modelName(r.agent, r.provider, r.model)} instead of ${was}.` });
  return r.agent !== "offline";
}

/**
 * Run the agent until it ends its turn or waits for approval. Call it right after addMessage or
 * answerApproval: it claims the thread synchronously, so the "running" status they saved stays valid.
 */
export async function run(id: string, model?: ModelCall): Promise<void> {
  if (runs.has(id)) return;
  runs.add(id);
  try {
    const s = load(id);
    if (!s) return;
    if (!model) await repick(s).catch(() => {});
    let call = model ?? MODELS[s.thread.agent];
    s.thread.status = "running";
    save(s);
    let moved = false;
    for (let i = 0; i < MAX_STEPS; i++) {
      let next: "continue" | "stop";
      try {
        next = await step(s, call);
      } catch (e) {
        // A free limit that ran out: once per run, the chat moves to the next free model and the step is tried again.
        if (e instanceof FreeLimitError && !model && !moved && (await nextFree(s, e))) {
          moved = true;
          call = MODELS[s.thread.agent];
          save(s);
          i--;
          continue;
        }
        push(s, { role: "notice", tone: "error", text: errorText(e) });
        next = "stop";
      }
      if (next === "stop") break;
      refreshFlags(s);
      save(s);
      if (i === MAX_STEPS - 1) push(s, { role: "notice", tone: "info", text: "Paused after many steps. Send a message to keep going." });
    }
    if (s.thread.status === "running") s.thread.status = "idle";
    refreshFlags(s);
    save(s);
  } finally {
    runs.delete(id);
  }
}

/** Keep what the user changed while the agent worked (the Ask-first switch, a rename). */
function refreshFlags(s: State): void {
  const r = db().prepare("SELECT title, auto_approve FROM assist_threads WHERE id = ?").get(s.thread.id) as { title: string; auto_approve: number } | undefined;
  if (!r) return;
  s.thread.autoApprove = r.auto_approve === 1;
  s.thread.title = r.title;
}

function errorText(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected. Check it in Settings → AI helper.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is rate-limited right now. Try again in a minute.";
  if (e instanceof Anthropic.BadRequestError && /\bmcp\b|connector/i.test(e.message)) return `A connector didn't work: ${e.message}. Check it in Settings → Assist connectors, or switch it off.`;
  if (e instanceof Anthropic.APIError) return `Claude returned an error (${e.status ?? "network"}): ${e.message}`;
  if (e instanceof DOMException && e.name === "TimeoutError") return "The model took too long to answer. Try again, or pick a smaller model.";
  return (e as Error).message || "Something went wrong";
}

/**
 * Add the user's message; a pending plan they didn't approve is declined with their message as feedback.
 * Leading `/name` tokens load those skills into the chat first.
 */
export function addMessage(id: string, text: string, attachments: string[] = []): AssistThread {
  const s = load(id);
  if (!s) throw new Error("Not found");
  if (s.thread.status === "running" || runs.has(id)) throw new AssistBusyError("Still working on the last message");
  const slash = slashSkills(text, (n) => canUseSkill(n, s.ext.projectId));
  for (const n of slash.skills) if (!s.ext.skills.includes(n)) s.ext.skills = [...s.ext.skills, n];
  const titles = slash.skills.map((n) => getSkill(n)?.title ?? n);
  // With only "/katana" (and files), the model still needs words to act on.
  const words = slash.text || (slash.skills.length ? `Use the ${titles.join(" and ")} skill${titles.length > 1 ? "s" : ""}${attachments.length ? " with the attached files" : ""}.` : text);
  // The first message names the chat, unless it was started with a name (a scheduled run's).
  if (!s.thread.items.some((i) => i.role === "user") && s.thread.title === "New chat") s.thread.title = threadTitle(slash.text || titles.join(", ") || text);
  // Tool results first: they answer the assistant's last turn.
  const results = s.pending ? decline(s, REPLIED_INSTEAD) : [];
  if (!results.length) closeDanglingToolUses(s.messages);
  appendUser(s.messages, [...results, ...userBlocks(words, attachments)]);
  push(s, { role: "user", text: slash.skills.length ? slash.text : text, ...(attachments.length && { attachments }), ...(slash.skills.length && { skills: slash.skills }) });
  s.thread.status = "running";
  save(s);
  if (s.ext.projectId) touchProject(s.ext.projectId);
  return s.thread;
}

function settle(s: State, approved: boolean): Pending {
  const p = s.pending!;
  const item = s.thread.items.find((i) => i.id === p.approvalItemId);
  if (item?.role === "approval") item.status = approved ? "approved" : "declined";
  s.pending = null;
  return p;
}

function decline(s: State, why = DECLINED): ToolResult[] {
  const p = settle(s, false);
  return ordered([...p.results, ...p.gated.map((g) => ({ type: "tool_result" as const, tool_use_id: g.id, is_error: true, content: why }))], p.order);
}

async function runApproved(s: State, p: Pending): Promise<ToolResult[]> {
  const results = [...p.results];
  const ctx = toolCtx(s);
  for (const g of p.gated) {
    const { result, items } = await runTool(g.name, g.input, ctx);
    results.push({ ...result, tool_use_id: g.id });
    for (const it of items) push(s, madeBy(it, g.id));
  }
  return ordered(results, p.order);
}

/** The user's answer on the approval card. */
export async function answerApproval(id: string, ok: boolean): Promise<AssistThread> {
  const s = load(id);
  if (!s) throw new Error("Not found");
  if (!s.pending || s.thread.status !== "waiting" || runs.has(id)) throw new AssistBusyError("Nothing is waiting for approval");
  if (!ok) {
    s.messages.push({ role: "user", content: decline(s) });
    s.thread.status = "running";
    save(s);
    return s.thread;
  }
  // Claim the thread before the first await: a second approval (another tab, a retry) or a new
  // message now finds it busy instead of running the same paid plan twice or being overwritten.
  runs.add(id);
  try {
    const p = settle(s, true);
    s.thread.status = "running";
    save(s);
    const results = await runApproved(s, p);
    s.messages.push({ role: "user", content: results });
    // Keep a toggle the user flipped meanwhile.
    s.thread.autoApprove = (db().prepare("SELECT auto_approve FROM assist_threads WHERE id = ?").get(id) as { auto_approve: number } | undefined)?.auto_approve === 1;
    save(s);
  } finally {
    runs.delete(id);
  }
  return s.thread;
}
