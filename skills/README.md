# Built-in Assist skills

Each folder holds one skill: a `SKILL.md` with YAML frontmatter and Markdown instructions, in the
[Agent Skills](https://agentskills.io/specification) format that Claude Code, Codex, Cursor and
other agents read. Assist lists them under **Assist → Skills → Built-in**, the agent
loads one with its `load_skill` tool when a request matches, and typing `/name` at the start of a
message loads it for that chat. MCP clients get them as prompts.

```markdown
---
name: product-photoshoot            # required: lowercase letters, numbers, hyphens (≤ 64); the folder's name
description: What it does …         # required (≤ 1024 characters): what it does and when to use it
compatibility: Needs a Fuobe server …   # optional (≤ 500 characters)
metadata:                           # Fuobe's own fields: one line each, strings only
  title: Product Photographer       # shown in the app
  when_to_use: When the agent should load it …
  icon: package                     # a lucide icon name the Skills page knows
  studio: /apps/app-packshot        # the Fuobe page that does the job by hand
  tags: product, ecommerce          # comma-separated
  offline_kind: image               # hints for the offline planner (no LLM): image | video | audio | text
  offline_aspect: "1:1"
  offline_outputs: "4"
  offline_style: words appended to the prompt
---

# Instructions the agent follows …

## Using Fuobe from an agent
Which Fuobe MCP tools another agent calls for this job.
```

The spec allows only `name`, `description`, `license`, `compatibility`, `allowed-tools` and a
string-to-string `metadata` map at the top level, so Fuobe's fields live under `metadata`. Fuobe
still reads files that have them at the top level (`title:`, `tags: [a, b]`, an `offline:` map),
as skills written before round 4 do. `tests/skills-spec.test.ts` checks every file here against
the spec and against Fuobe's parser.

Files are read from disk at run time (`src/server/skills.ts`), so editing one here changes Assist
on the next request. People add their own skills on the Skills page, by uploading a `.zip`,
`.skill` or `SKILL.md` file, or with `fuobe skills add`; those live in the database, not here.

## Skills that run by themselves (`recipe.json`)

A skill of your own can carry a `recipe.json` next to its `SKILL.md`. `SKILL.md` stays the playbook
people and agents read; the recipe is the part Fuobe runs by itself, with new inputs and no chat or
AI. The format is in `src/lib/recipe.ts` (and `docs/research/work2skill-7.md`):

- `fuobeRecipe: 1`, then `params`: up to 12 typed inputs (`image`, `video`, `audio`, `text`, `number`,
  `choice` or `element`), each with an id, a label and optional limits, options and a hint.
- `steps`: up to 24 `generate` steps (a generation request each, waiting for earlier steps with `after`
  and taking their results with `chain`), or one `tool` step that calls a studio's Assist tool
  (`dub_video`, `katana`, `add_captions`…). A string that is exactly `"{{id}}"` takes that input as it
  is; `{{id}}` inside longer text puts the input's text there. An unknown or unused placeholder is
  refused when the recipe is saved.
- `fuobeRecipe: 2` adds steps that span studios: a field that is exactly `"{{steps.<key>.output}}"`
  takes an earlier step's first result of the kind the field takes, so a studio step can feed later
  steps and the other way round ("dub, then captions, then a 9:16 cut"), with tool steps anywhere in
  the order. Each step starts by itself when the steps it takes from are done; the skill's dialog shows
  the run's progress. A dub that feeds a later step dubs in one go (`"review": false`).
- Optional `checks` per step (what it makes, how many, the shape, the length, sound, a sentence about
  the look) and `source` (where the recipe came from).

The easiest way to write one is not to: **Make a skill from this…** on a result, or **Make a skill**
in the Library, builds the recipe from the steps behind your results, and you pick which inputs change.

A recipe runs on an engine only after a free **Test run** has passed there: Fuobe plans and prices
every step. The test run also runs it once with placeholder results (not for a studio tool step on its
own, which is priced only; beside other steps a studio step runs as a demo too, and what it opened is
deleted after), so nothing runs for real and nothing is spent; a run doesn't wait for that part. A
retired, switched-off or repriced model asks for a new test run (**Test again**). Fuobe
writes the `verified` dates itself: an uploaded `recipe.json` loses them and starts unchecked, and a
downloaded `.zip` leaves out this install's checks (and, unless you ask, the examples and where the
recipe came from). The built-in skills here carry no recipe and can't be checked: duplicate one
first. `draft` is now a reserved skill name, as `upload` and `new` are. The Run form, runs of up to
50 CSV rows and ⌘K's "Run a skill" are in **Assist → Skills**; the recipe's routes are under
`/api/assist/skills/[name]/` (`recipe`, `estimate`, `run`, `verify`).

## Installing them in other agents

The open `skills` CLI finds these folders (and `.agents/skills/fuobe`, the skill that teaches an
agent to drive Fuobe) and copies or links them into an agent's skills directory:

```bash
npx skills add workingprototype/Fuobe --list          # what's here
npx skills add workingprototype/Fuobe --skill fuobe   # just the Fuobe skill
npx skills add workingprototype/Fuobe -a claude-code  # all of them, for Claude Code
```

The playbooks call Fuobe's MCP tools (`generate`, `check_generations`, `katana`…), so the agent
needs the Fuobe MCP server connected: `fuobe mcp` prints the command (see `docs/cli.md`).
