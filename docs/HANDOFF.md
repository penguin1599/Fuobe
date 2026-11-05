# Handoff: continuing the build

Written on 2026-10-30, when PR #15 wrapped up the work so far, and revised the same day after the owner's decision on accounts (main wins). It is for whoever continues next: a new session or a person. Everything needed to pick up is in this file and in [`docs/handoff/`](handoff/).

## Start here

1. **Check that PR #15 is merged:** `git fetch origin && git log --oneline origin/main | grep -m1 'pull request #15'`.
   - While it is still open, use `origin/claude/fuobe-r5-batch-7` wherever this file says `origin/main`, but only once that branch is PR #15's final head: acc-1 and acc-2 removed, and this handoff on it. When this file was written, it still had both and an older handoff (head `c9cd489`). Check it; each line prints its answer:

     ```bash
     B=origin/claude/fuobe-r5-batch-7; git rev-parse -q --verify $B >/dev/null || echo "STOP: there is no $B"
     git grep -q better-auth $B -- package.json && echo "STOP: acc-1 is still on $B" || echo "ok: no acc-1"
     git cat-file -e $B:src/server/access/route.ts 2>/dev/null && echo "STOP: acc-2 is still on $B" || echo "ok: no acc-2"
     git grep -q accounts_10_30 $B -- docs/handoff/owner-decisions.json && echo "ok: this handoff" || echo "STOP: $B has an older handoff"
     git merge-base --is-ancestor origin/main $B && echo "ok: it holds main" || echo "behind main: setup step 4 brings main in"
     ```

   - On any STOP, don't build: PR #15's branch hasn't been rebuilt yet. Tell the owner and wait for it.
2. **See what main gained since this file was written:** `git log --first-parent --format='%h %ad %s' --date=short a5f841f..origin/main` and `git diff --stat a5f841f origin/main -- docs/public-signup.md`. When this was written, that was four commits, listed under "after this handoff" in "Where things stand". Where main says more than a brief, main wins. Note what changes a brief in its `wip` entry in `queue.json`.
3. **Set up the session** ("Setting up a new session" below). This includes rebuilding the base from main, moving the two branches with work in progress onto it, and bringing main's newer work into the base.
4. **Ask the owner** the questions under "Waiting on the owner". Record the answers in [`handoff/owner-decisions.json`](handoff/owner-decisions.json), then commit them to `claude/fuobe-parity-4` and push.
5. **Build.**
   - If the owner asks for a workflow, follow "Running the build".
   - Otherwise follow "Building without the Workflow tool": the same four stages, one package at a time, with the same prompts.
6. **Before the session ends**, follow "Before a session ends". Branches, reports and journals that aren't pushed are lost with the container.

## Where things stand

- **`main`** (after PR #15) holds:
  - all of round 4, the Fuobe Originals O1 to O11 and O13, and from PR #14 Skills W1 and W2, Fixes 5 and the research notes for DBS, new models, Work2Skill and accounts
  - from PR #15: DBS soundtrack separation (D1), MOSS-Image (N7-1), the fly path (N7-5), the turnaround video (N7-6), the research for Idol (research 9) and this handoff. PR #15's own routes and tools follow public sign-up (`tests/public-signup-tools.test.ts`), and its graphs are in the pre-flight index, with board rows for Split soundtrack, Fly path and Turnaround. PR #15 does **not** carry acc-1 and acc-2: the owner dropped them (below), and its branch reverts them.
  - the owner's own work from 10-30 up to this handoff (20 commits; read their messages with `git log dc51169..a5f841f`):
    - **public sign-up** (`docs/public-signup.md`), described under "Accounts" below.
    - **local LLMs:** `src/server/llm` and `/api/llm` cover Ollama, LM Studio, Unsloth Studio and any OpenAI-compatible server (Settings → AI helper).
    - **Pixal3D** is now the Image to 3D route for a photo, with the server's GLB finish and a CPU turntable (`scripts/comfy/hand-built/image-to-3d-pixal3d.json`). TRELLIS.2 is the fallback, and its graph was trimmed.
    - **premium preset covers:** 480 covers rendered on ComfyUI, in `public/previews/presets` (`pnpm eval:covers --from-masters`).
    - **the README is a product page.** The details moved to `docs/FEATURES.md`, `docs/SELF-HOSTING.md` and `docs/DEVELOPMENT.md`. Also new: the MIT licence, the tab icon and the demo video.
    - **the GPU pre-flight board at `/connect`.** It shows what the connected ComfyUI has, and every studio as Ready, One step away, Needs setup or Needs a bigger GPU. The same chips show on gallery cards, studio headers and the model picker. Its index is `workflows/comfyui/requirements.json`, which the library build writes.
  - **after this handoff** (late on 10-30, `b7f78e7` to `b5ca728`; "Start here" step 2 lists what came later):
    - accounts upload pictures, clips and sound (`POST /api/uploads`) and run the studios' input modes, camera motions, effects and input apps on their own ComfyUI. What an account's run may read is `src/server/tenant.ts`, and its inputs are checked in `src/server/account-inputs.ts`. One new migration (`assets.account_id`).
    - Image to 3D and every 3D model are closed to accounts for now. The 3D finish (`scripts/model3d/finish-glb.mjs`) refuses a GLB with external file references.
    - the sign-in proxy holds request bodies only up to 66 MB (`next.config.ts`). `/api/uploads` skips it and makes the same checks itself (`src/server/direct-gate.ts`).
    - before/after reveal clips on 42 apps' preset covers.
- **Accounts** are the owner's public sign-up on main. It is off by default, and `FUOBE_PUBLIC_SIGNUP=1` turns it on. With it on:
  - guests browse read-only
  - anyone can sign up with an email; accounts live in SQLite (`fuobe.db`, `auth_accounts`) with a scrypt hash; an older `auth.json` moves in on the first start
  - accounts see a guest view of the owner's library and can't touch settings, keys or tokens. They upload their own files and run only on their own ComfyUI (Settings → Your GPU, checked on `/connect`).

  The PR #15 packages acc-1 (the Better Auth identity base) and acc-2 (the actor context on every route, with its integration fix 4e8359f) are dropped. The 55 remaining packages of the old accounts lane (acc-3 to acc-57) are dropped from the queue. The next accounts work starts with a new plan written with the owner, around public sign-up. [`research/accounts-8.md`](research/accounts-8.md) is background research only.
- **`claude/fuobe-parity-4`** is the integration branch. Packages are merged into it one at a time, and a PR is cut from it as a snapshot branch when the owner asks for one. It still points at `f7c6d8e`, which carries acc-1 and acc-2, so rebuild it from main before building (see "Setting up a new session").
- **38 packages are queued** in two lanes ([`handoff/queue.json`](handoff/queue.json)):
  - lane R: 17 packages, new models and DBS audio
  - lane O: 21 packages, the owner's calls, Originals, Idol, skills and the training kit
- **Two packages have work on pushed branches.** `o/acc-3` on origin is dropped work. See "Work in progress".

## The owner's rules (binding)

The owner's own words on engines, SAM Audio, accounts and the PR #14 calls are in [`handoff/owner-decisions.json`](handoff/owner-decisions.json). The first two rules below have been the product direction since round 4, and every build prompt carries them. Every brief in the queue already carries the rules that apply to it:

- **No Higgsfield API, keys or models.** Fuobe Originals rebuild Higgsfield's own products from open-weight models plus LoRAs. Higgsfield's client code is used only as facts about behaviour; its code, prompts and media are never copied.
- **Licences are information, not gates.** Build every model: paid, proprietary, open, closed and non-commercial. Record each licence as data. The admin turns models on or off in Settings → Models & licences.
- **Each engine does all it can** (the owner, 10-30): "whatever is possible in cloud only in cloud, whatever possible in local can work on local… If we can do lora only in local, then we do that on local, not remove it from both."
  - The cloud only uses models that are hosted, with no substitute model, and only what the hosted endpoint supports.
  - The open engine keeps every capability it has: LoRAs, custom nodes, longer clips and references.
  - Say plainly in the UI what each engine does.
- **No SAM Audio stand-in in the cloud** (`samAudioCloud: false`, the owner's choice). DBS isn't hosted, so:
  - the DBS packages split soundtracks on the open engine only
  - today's cloud dub (Demucs) stays as it is
  - hosted speech cleaners (VEED, DeepFilterNet, ElevenLabs isolation) are used only under their own names
- **Accounts are the owner's public sign-up** (the owner, 10-30: "main wins"; key `accounts_10_30`). Every route, page and run a package adds follows it the way main's own routes do, and `docs/public-signup.md` at the base wins where it says more than a brief. Every brief ends with a PUBLIC SIGN-UP rule:
  - read `src/lib/guest-access.ts`, `src/proxy.ts`, `src/server/tenant.ts` and `tests/public-signup.test.ts`
  - price checks (estimate routes, `?preview=1` on run routes) go in `ESTIMATES` or `PREVIEWS` and run through `priceAs` (`src/server/visitor.ts`), so a visitor is priced for its own GPU, never a demo
  - changes to the library or projects go in `LIBRARY_CHANGES` (403 `code: "library"` for an account). Settings, keys and tokens stay the owner's. The owner's lists come back empty for a visitor, and a visitor is never told whether one of the owner's records exists.
  - only the owner's runs reach the install's keys or GPU. An account's studio generations run on its own ComfyUI through `POST /api/generations`; other runs answer `connect-gpu`, then `own-gpu-tool`. An account's run reads only its own files (`src/server/tenant.ts`, `src/server/account-inputs.ts`).
  - the sign-in proxy holds at most 4 MB of a request body (main, 10-31; `next.config.ts`), and a bigger one reaches the route cut short: a route that takes a large file takes an uploaded file's reference. A route that must take a file itself skips the proxy the way main's do (the matcher in `src/proxy.ts`, then `gateAsProxy` and `readBodyWithin` or `readFormWithin` from `src/server/direct-gate.ts`, and a row in `tests/request-body-limits.test.ts`), as Split soundtrack's Export mix does
  - a price check reads a stored file only through `storedMedia` (`src/server/storage.ts`): only its header, and in a visitor's price check only the visitor's own files. A visitor's price check never calls a GPU either (main allows the server to call an account's address a few times a minute): Split soundtrack's reads an account's device from its last status check (`lastGpuDevice` in `src/server/account-gpu.ts`), and the run checks the models on its disk
  - add new routes to those rules, and test them in the style of `tests/public-signup.test.ts`, `tests/public-signup-tools.test.ts` and `tests/account-*.test.ts`
  - new ComfyUI workflows and node packs go into the pre-flight's requirement index (`packs.json`, `model-pins.json`, then `node scripts/comfy/build-requirements.mjs`), and new studios and tools get a row on the `/connect` board (`STUDIO_ROWS` in `src/server/gpu/tools.ts`)

  The owner's earlier accounts answers of 10-29 (three modes, teams, plans, an admin panel, paid keys both ways, enterprise features) stay under the key `accounts`. They are background for the re-plan, to be confirmed with the owner.
- **The owner's calls from PR #14** are package `owner-calls-1`, first in lane O:
  - Evolution's cloud route moves onto fal's hosted Wan 2.2 Fun VACE.
  - "Fuobe Speak" keeps its name. The GPU runs FusioniX and the cloud runs without it, and the UI says so.
  - Fuobe DoP stays the default for DoP's 32 Mixed Media effects. The first evaluation run with paid keys does a blind A/B against Kling 2.5 Turbo. The default goes back only if Fuobe DoP clearly loses.

## Waiting on the owner

The owner's answers of 11-04 are in [`handoff/owner-decisions.json`](handoff/owner-decisions.json) under `owner_11_04`; its `openQuestions` list what is still open:

- **Best labels:** whether "no Best or recommended label for now" also covers the Video studio's Best list and other top or recommended badges (read so far as the Image studio's Best list; package `f1-no-best-label` asks first).
- **Pieces dropped when main's builds won on 11-04:** rebuild them on main's Skills and sound tools? A skill's History and suggestion cards, a run's step-by-step card, the Library's filter by run batch, the CLI's `--wait` over a skill's runs, Clean the voice first's extra steps in the price, and the Faceless rule that no skill step takes an episode's output.
- **Still open:** RTX Video "Quick" as the default upscaler on RTX machines; Clean up dialogue's −18 dB preset measures about −12.6 dB (relabel or lower after listening); accounts running Remove dialogue and Split soundtrack on their own GPU (with the accounts plan); a Hugging Face org and write token for the training kit; a texturing node for Hi3D's refined meshes.
- **Accounts beyond public sign-up:** nothing queued. A new plan needs the owner's word on which of the 10-29 answers still stand.
- **Two workflow files the owner shared** (`inbetweening/Animation5-In-Betweening.json`, `blockout/Horror_Scene_SD2.5.json`): never committed (origin and licence unknown). Both packages were built from their briefs; share them again only to check against the originals.
- **`o/acc-3` on origin:** the owner said to delete it (11-04). Sessions can't delete branches (GitHub answers 403), so the owner deletes it.

The integrator may remove merged worktrees (owner, 11-04): pass `--remove-worktrees`.

## What's left: the queue

Every package of lanes R, O and N (51) is merged into `claude/fuobe-parity-4` (11-01 to 11-03; their stage reports are in `docs/handoff/reports`). Main was merged in on 11-04 (`1c1336ea`); where main had built the same feature (Skills across studios, the sound tools, Make it 3D), main's build won.

Lanes run side by side; inside a lane, packages run in order, each from the integration branch with everything before it merged, through implement, adversarial review, fix and merge (one integrator at a time).

**Lane F (the owner's follow-ups of 11-04):**
- `f1-kandinsky6-audio-vae`: both of Kandinsky 6.0's audio VAEs, each with its licence, and the person picks (plus the Pro VRAM figure)
- `f1-idol-cloud`: Make it 3D on installs without a GPU, through fal's hosted Idol
- `f1-fal-worlds`: fal's world models under their own names
- `f1-h3-token-overage`: MiniMax H3 reference tokens past 4,096 are priced
- `f1-worldcast-token`: WorldCast's access token gets a Settings field
- `f1-comfyui-0431-moss`: ComfyUI v0.43.1, and MOSS one-sheets get colour and depth control
- `f1-no-best-label`: no Best or recommended label on model pickers for now, and an evaluation plan to decide when one comes back

The current state is what `make-workflow.mjs` prints: the packages it leaves out as merged, and the first package of each lane. Each package's full brief is in `queue.json` under `packages.<key>.brief` and ends with the PUBLIC SIGN-UP rule.

## Work in progress

Both branches with work are pushed to `origin`, cut from the old `claude/fuobe-parity-4` head `f7c6d8e`. That head carries the dropped acc-1 and acc-2. If the base is reset, the main session moves each branch onto it before any stage runs. If the base fast-forwards to a main that reverts them, the package's agent merges the base in (see "Setting up a new session"). Each package's full notes are in `queue.json` under `wip`: what is built, the next steps and the risks. `make-workflow.mjs` passes them to the package's agents.

| Branch | State | What the next run does |
|---|---|---|
| `o/n7-2-layout-mode` | 5 commits, head `492643b`. Implement and review are done; both reports are in `queue.json` under `done`. Nothing was committed after the review, so its 10 findings still apply. | The fix stage. Two majors: cloud layout runs lose fal's seed (`extractOutputs` in `payload.ts` keeps it only with an `actual_prompt`), and a second Edit layout on the same picture does nothing (`LayoutHandoff` never resets `opened.current`). Also a weak e2e check, and minors on keyboard resize, contrast and an admin-disabled model. |
| `o/archive-restore` | 6 commits, head `b84bc01`, from an implement stage that stopped before it reported (64 files). Built: both engines, the tiled-fusion graph (not validated: the CPU server lacks ComfyUI-LTXVideo), `/api/restore`, Video tools, Canvas, Shorts, the Explainer, Assist/MCP and tests. Missing: Faceless, and Upscale's "Restore archive footage first". | Implement again, resuming from the branch: <ul><li>rewrite its three routes without acc-2's `handler()` and to the public sign-up rules</li><li>fix the flaky `restore-api` test (`ORDER BY rowid`)</li><li>limit the gated-LoRA change: without a Hugging Face token, cloud runs with the gated Relight or Slow-Motion LoRAs now fail</li><li>finish the placements, then run the e2e and browser checks</li><li>then review and fix</li></ul> |
| `o/acc-3` | 1 WIP commit, head `3106848`, for the dropped accounts lane. | Nothing: dropped work. The owner may delete it. |

When both packages merge, they conflict in one place: the lucide import list in `src/components/studio/result-actions.tsx`. Keep both `LayoutDashboard` and `Palette`.

## Setting up a new session

The container starts fresh, so set up the following before building.

**1. The repository and the base.** First see where the base points: `cd /home/user/Fuobe && git fetch origin && git rev-parse --short origin/claude/fuobe-parity-4`.

- **Still `f7c6d8e`:** this is the first session after PR #15, and the base must be rebuilt from main. Main never got acc-1 and acc-2 (the owner dropped them), but `claude/fuobe-parity-4` still carries them:

  ```bash
  MAIN=origin/main                         # while PR #15 is still open ("Start here" step 1): MAIN=origin/claude/fuobe-r5-batch-7
  git checkout claude/fuobe-parity-4
  git log --oneline --no-merges $MAIN..origin/claude/fuobe-parity-4   # what the base has that main lacks
  ```

  Act on what the last command prints:
  - **Nothing:** `git merge --ff-only $MAIN && git push origin claude/fuobe-parity-4`. This is the expected case: PR #15's branch removes acc-1 and acc-2 by reverting them on top of `f7c6d8e`, so once it is merged with a merge commit (as PRs #10 to #14 were), main contains `f7c6d8e`.
  - **Only the dropped accounts work:** the "Accounts 1…" and "Accounts 2…" commits, plus 4e8359f "Turnaround routes go through handler()". Run `git reset --hard $MAIN && git push --force-with-lease origin claude/fuobe-parity-4`. This applies the owner's 10-30 decision; the old head was `f7c6d8e`.
  - **Anything else:** stop. Compare with `git diff --stat $MAIN origin/claude/fuobe-parity-4` and ask the owner.
- **Anything else:** an earlier session already rebuilt the base, and it holds the packages merged since. Compared with main (the `git log` above), it lists their commits; that is expected, not a reason to stop. Run `git checkout claude/fuobe-parity-4 && git merge --ff-only origin/claude/fuobe-parity-4`, and step 4 brings main's newer work in.

**2. The two branches with work in progress.** If you reset the base in step 1, move each branch's own commits onto it. Whether they are rebased here or the package's agent merges the base in, expect conflicts (test merges on 10-30):
- `o/n7-2-layout-mode`: `src/components/studio/composer.tsx`, `src/components/studio/model-picker.tsx` and `src/lib/catalog/plan.ts`
- `o/archive-restore`: `src/server/generations.ts` and `scripts/comfy/README.md`
- both, from main's later account work: `src/server/generations.ts` and `src/server/providers/comfyui.ts`; for `o/archive-restore` also `src/server/loras.ts` and `src/server/settings.ts`

Keep both sides.

```bash
git checkout -B o/n7-2-layout-mode origin/o/n7-2-layout-mode
git rebase --onto claude/fuobe-parity-4 f7c6d8e      # only the package's own commits move; on a conflict: fix, git add, git rebase --continue
git push --force-with-lease origin o/n7-2-layout-mode
# the same three commands for o/archive-restore, then:
git checkout claude/fuobe-parity-4
```

If the base was fast-forwarded instead, leave the branches as they are: each package's agent merges the base in. `make-workflow.mjs` refuses to write a script while a queued `o/<key>` branch still carries another package's merges, and names the branches.

**3. Tools and ComfyUI:**

```bash
pnpm install --frozen-lockfile && npx next typegen   # typegen before every typecheck in a fresh checkout
(cd scripts/comfy && npm install)                    # playwright-core: the ComfyUI pipeline and tests/comfy-dbs.test.ts
bash scripts/comfy/install-comfyui.sh                # CPU ComfyUI 0.41 + the pinned node packs, outside the repo; several minutes: run it in the background and wait
bash scripts/comfy/start-comfyui.sh                  # http://127.0.0.1:8188; waits up to 5 minutes; start it again after every container restart
mkdir -p /home/user/ext                              # the inputs folder below
```

**4. Main's newer work (every session).** Main moves every few hours. Before any package starts, and while no integrator is running, bring what main gained into the base, so packages build on the owner's current rules:

```bash
cd /home/user/Fuobe && git checkout claude/fuobe-parity-4 && git merge --ff-only origin/claude/fuobe-parity-4
git log --first-parent --format='%h %s' claude/fuobe-parity-4..origin/main   # main's commits the base lacks: read them
git merge --no-ff origin/main -m "Merge origin/main into claude/fuobe-parity-4" -m "$(cat /tmp/trailer.txt)"
npx next typegen && pnpm typecheck && pnpm lint && FUOBE_ACCOUNT_DISK_FREE_GB=1 pnpm vitest run --maxWorkers=2   # check each command's own exit code
git push origin claude/fuobe-parity-4
```

- When the second command prints nothing, skip the rest.
- `/tmp/trailer.txt` holds this session's commit attribution lines (see "Running the build").
- On a conflict, keep both sides. Where two behaviours can't both stay, main's wins; say so in the merge commit.
- In `MIGRATIONS` (`src/server/db.ts`), main's entries keep their places, and the packages' newer entries go after them: a migration is known by its place in the list, and the owner's installs have already run main's.
- Note in a package's `wip` entry anything main's new commits change for it.

**Inputs folder.** Some briefs read files kept outside the repo, in a folder the briefs call `@EXT@` (default `/home/user/ext`). Read them as data: never run or install them. Fetch them before their package starts (commands below):

| Path under `@EXT@` | Package | Source |
|---|---|---|
| `person-remover/` (README, LICENSE, examples) | `person-remover-plus` | https://huggingface.co/akatz-ai/MiniMax-H3-Person-Remover-LoRA |
| `ltx-restore/README.md` | `archive-restore` | https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Restore (the model card is public; the weights are gated and need a Hugging Face token) |
| `hi3d/README.md`, `hi3d/LICENSE` | `hi3d-refine`, `idol-7` | https://github.com/hi3d-official/Hi3Dv1.0 (the code repo's README, whose line numbers idol-7 cites; the weights are https://huggingface.co/hi3d-official/Hi3Dv1.0) |
| `moss-image/repo` (`skills/moss-image-prompt-enhancer/`) | `n7-8-layouts-everywhere` | https://github.com/OpenMOSS/MOSS-Image at `2b46b1e0` |
| `inbetweening/Animation5-In-Betweening.json` | `inbetweening` | the owner (see "Waiting on the owner") |
| `blockout/Horror_Scene_SD2.5.json` | `blockout-film` | the owner |

```bash
EXT=/home/user/ext && mkdir -p $EXT/person-remover $EXT/ltx-restore $EXT/hi3d
for f in README.md LICENSE examples/README.md examples/H3-Person-Removal-Relay-V2.api.json examples/Person-Remover-Window-Reroll-V1.json; do
  curl -fsSL "https://huggingface.co/akatz-ai/MiniMax-H3-Person-Remover-LoRA/resolve/main/$f" -o "$EXT/person-remover/${f//\//_}"
done
curl -fsSL https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Restore/resolve/main/README.md -o $EXT/ltx-restore/README.md
for f in README.md LICENSE; do curl -fsSL "https://raw.githubusercontent.com/hi3d-official/Hi3Dv1.0/main/$f" -o "$EXT/hi3d/$f"; done
git clone -q https://github.com/OpenMOSS/MOSS-Image $EXT/moss-image/repo && git -C $EXT/moss-image/repo checkout -q 2b46b1e0e13b5aaec253879e0d006a42564b8b27
```

Research notes cite `/home/user/ext/<name>` for the clones they read. Each note gives the repository and the commit, so clone again into `@EXT@/<name>` if a package needs one. `/home/user/ext/owner-decisions.json` is now [`handoff/owner-decisions.json`](handoff/owner-decisions.json).

## Running the build

The build runs as a workflow: several agents run with the Workflow tool. A new session runs one only after the owner says so there (for example "use a workflow"). [`handoff/make-workflow.mjs`](handoff/make-workflow.mjs) writes the workflow script from the queue and [`handoff/workflow.body.js`](handoff/workflow.body.js):

```bash
printf '%s\n' '<your session commit attribution line 1>' '<line 2>' > /tmp/trailer.txt   # one argument per line
node docs/handoff/make-workflow.mjs /tmp/fuobe-build.js --trailer-file /tmp/trailer.txt
# then: Workflow({ scriptPath: "/tmp/fuobe-build.js" })
```

- **Options:**
  - `--skip key,key` leaves out the packages you name. Packages already merged into the base, found by their "Merge branch 'o/<key>'" commits, drop out by themselves.
  - `--only R` or `--only O` runs one lane.
  - `--done results.json` brings in stages finished since the queue was written: `{ "<key>": { "impl"?: report, "review"?: report, "fix"?: report } }`, the reports as the agents returned them.
  - `--journal <journal.jsonl>` (repeatable, oldest first) reuses the stages a stopped run finished and leaves out what its integrator merged. A run's journal is in its transcript folder (`~/.claude/projects/<project>/<session>/subagents/workflows/wf_*/journal.jsonl`), so it only exists in the container that ran it.
  - Finished stages merge stage by stage: the queue's `done`, then the journals, then `--done`. A newer report of an earlier stage drops the older later stages.
  - `--save-done` also writes those stages into `queue.json` `done` (see "Before a session ends").
  - `--remove-worktrees` lets the integrator delete merged worktrees. Pass it only if the owner agrees.
- **Size limit.** Scripts must stay under 512 KB. Both lanes come to about 380 KB.
- **Usage limits and restarts.** A lane stops at the first package that fails a stage, so a relaunch picks up there. A stage can also stop as "blocked", for example on a branch cut from a rebuilt base; the log says why.
  - In the same session, resume with `resumeFromRunId`: finished agent calls are reused.
  - In a new session, regenerate the script. Merged packages drop out by themselves, and the finished stages come from `queue.json` `done`. Agents resume from what their pushed branch already holds.
- **One integrator at a time.** Only the integrator touches the main checkout. Every other agent works in `../wt/o-<key>`.
- **Disk.** The disk allowance is fixed per session. The PR #15 container had about 39 GB in all (35 GB used and 3.9 GB free at the end):
  - ComfyUI: 5.7 GB
  - `~/.cache`: uv 5.8 GB and the evaluation cache 2.6 GB
  - scratch and verify data: 5 to 7 GB
  - worktrees: 6.3 GB

  A worktree's `node_modules` are hardlinks into the pnpm store, so a worktree costs its sources (about 150 MB) plus its `.next` (up to 0.8 GB). Agents delete `.next` after browser checks. After a PR, remove verify.sh's `../wt/verify-*` worktree and its out folder. Check `df -h /` before each run, and ask the owner before deleting anything else.

## Building without the Workflow tool

Without the owner's go-ahead for a workflow, run the same stages yourself, one package at a time, in lane order:

1. **Write the script:** `node docs/handoff/make-workflow.mjs /tmp/fuobe-build.js --trailer-file /tmp/trailer.txt --done /tmp/done.json`. Leave out `--done` until that file exists.
2. **Print the package's next stage:** `node docs/handoff/next-prompt.mjs /tmp/fuobe-build.js <key>`. [`handoff/next-prompt.mjs`](handoff/next-prompt.mjs) prints the stage (impl, review, fix or merge), the fields of its report and the prompt. It runs nothing else.
3. **Run the stage.** Give the prompt to a subagent and ask for the report as JSON with those fields, or follow it yourself. The merge stage runs in the main checkout, one at a time.
4. **Record the report** in `/tmp/done.json` as `{ "<key>": { "<stage>": report } }`, keeping the earlier stages (the merge stage as `"merge"`). Then write the script again and print the next stage. A merged package drops out by itself.
5. **Push after each stage:** `git -C /home/user/Fuobe push -u origin o/<key>`. Before the session ends, save the stages ("Before a session ends", with `--done /tmp/done.json` in place of the journals).

## Before a session ends

Workflow journals, reports, worktrees and the inputs folder don't survive a new container. Only what is pushed does.

Run these in the main checkout on `claude/fuobe-parity-4`, while no integrator is running.

1. **Push every `o/<key>` branch** that has commits not in `claude/fuobe-parity-4`: `git push -u origin o/<key>`. WIP commits are fine; say so in the commit message.
2. **Save the reports of the packages merged this session**, for the next PR's description. Do this before step 3, which drops merged packages from `queue.json` `done`:

   ```bash
   node docs/handoff/save-reports.mjs docs/handoff/reports $(ls -tr ~/.claude/projects/*/*/subagents/workflows/*/journal.jsonl)
   ```

   [`handoff/save-reports.mjs`](handoff/save-reports.mjs) writes `docs/handoff/reports/<key>.json` as `{ key, impl, review, fix, merge }`, from `queue.json` `done` and the journals, oldest first. Without a workflow, pass `--done /tmp/done.json` in place of the journals.
3. **Save the finished stages** of packages that aren't merged:

   ```bash
   node docs/handoff/make-workflow.mjs /tmp/x.js --trailer-file /tmp/trailer.txt --journal <journal.jsonl> --save-done
   ```

   This writes them into `queue.json` `done` (`--done /tmp/done.json` without a workflow). Then update `wip` in `queue.json` and the "Work in progress" table here.
4. **Commit `queue.json` and `docs/handoff/reports`** to `claude/fuobe-parity-4`, and push.

## Cutting a PR

Only cut a PR when the owner asks for one. The steps that worked for PRs #12 to #15:

1. **Snapshot branch.** Branch `claude/fuobe-r5-batch-<n>` from `claude/fuobe-parity-4`, merge `origin/main` into it, and resolve docs conflicts by keeping both sides.
2. **Verify:** `bash docs/handoff/verify.sh claude/fuobe-r5-batch-<n> /tmp/verify-<n>` (needs ComfyUI running). It works from any folder: its throwaway worktree goes next to the main checkout. It runs:
   - typecheck, lint, Vitest, the evaluation cases and the production build
   - every browser check in demo mode
   - hosted prices with a fake fal key
   - the live CPU ComfyUI checks and the workflow library

   It lists any `tests/e2e` script it doesn't run yet. `comfy-validate` exits 1 by design on this server: its log should list only the graphs named under "Known gaps". Before fixing a failing check, reproduce it, then show it passing three times on fresh data.
3. **Describe** with [`handoff/pr-describe.js`](handoff/pr-describe.js), a Workflow script: area readers, then a writer, three fact-check lenses (accuracy, completeness, clarity) and a reviser. The session-specific values are its `args`, listed at the top of the file:

   ```js
   Workflow({ scriptPath: "docs/handoff/pr-describe.js", args: {
     repo: "/home/user/Fuobe", head: "claude/fuobe-r5-batch-<n>", base: "<main's commit the PR builds on>", pr: <n>,
     round: "Round 5, part 3", reports: "/home/user/Fuobe/docs/handoff/reports", out: "/tmp/pr-<n>",
     history: "<how the branch was made>", areas: [{ key, title, pkgs: [["<package>", "<merge commit>"]] }],
     notInPr: "<the queue's next packages>", handoff: "<what changed in the handoff>" } })
   ```

   - `reports` holds `<package>.json` per merged package, `{ key, impl, review, fix, merge }`: `docs/handoff/reports`, which each session fills before it ends. Save this session's merges there first ("Before a session ends", step 2).
   - It saves the title and body in `out`. Fill the body's `<!-- CHECKS -->` line from verify.sh's summary.
   - Then remove the folder on the snapshot branch (`git rm -r -q docs/handoff/reports` and commit), so main doesn't carry it. When main comes back into the base after the PR merges, the reports it covered leave the base too, and newer ones stay.
4. **Docs pass** with [`handoff/pr-docs.js`](handoff/pr-docs.js): writers per doc group, then accuracy and staleness checkers and a reviser. Its args are `worktree`, `docsBase`, `pr`, `round`, `summary`, `notYet` and `facts`: the folder with `body.md` and `reports/`, so copy the reports next to the description first (`cp -r /home/user/Fuobe/docs/handoff/reports /tmp/pr-<n>/` and pass `facts: "/tmp/pr-<n>"`).
   - Since the owner's 10-30 work, the docs live in [`README.md`](../README.md) (the product page, with "Upgrading from an earlier version"), `docs/FEATURES.md`, `docs/SELF-HOSTING.md`, `docs/DEVELOPMENT.md`, [`docs/STATUS.md`](STATUS.md) and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), plus `docs/public-signup.md`, [`docs/research/README.md`](research/README.md) and [`scripts/comfy/README.md`](../scripts/comfy/README.md) (library counts).
   - Review the diff it leaves, then commit it to the snapshot branch.
5. **Open the PR** against `main`, with the checks summary and what none of the checks cover (no GPU, no paid keys).

## Known gaps and gotchas

- **Next.js 16:** run `npx next typegen` before `pnpm typecheck` in a checkout without `.next`, and read `node_modules/next/dist/docs/` before writing Next-specific code.
- **Stopping servers:** the server process is named `next-server`, so `pkill -f "next start"` misses it. Stop servers by port with `fuser -k -n tcp <port>`. Ports 3399 to 3401 belong to verify.sh, and 8188 to ComfyUI.
- **Turbopack warnings:** dynamic `fs` paths need `/*turbopackIgnore: true*/`, or Turbopack traces the whole project.
- **ComfyUI on this kind of server:** it accepts all but a few library workflows. The rest need node packs it lacks:
  - `sfx-thinksound` and `lipsync-latentsync16`, which belong on the isolated worker (`install-isolated-worker.sh`)
  - the four H3 Relay graphs: `video-character-swap-h3-relay`, `video-person-remove-h3-relay`, `video-character-swap-h3-segment` and `video-mask-h3-relay` (install with `H3_RELAY=1`)
  - on a server installed before today's script: `captions-whisper-burnin`, `image-vectorize-vtracer`, `video-character-swap-h3` (h3_character_swap) and `separate-soundtrack-dbs` (ComfyUI-DBS)

  Never install packs or restart ComfyUI from a package agent. Say what's needed instead.
- **The pre-flight index:** PR #15 put its graphs into `workflows/comfyui/requirements.json` (with ComfyUI-DBS in `packs.json`) and gave Split soundtrack, Fly path and Turnaround rows in `STUDIO_ROWS` (`src/server/gpu/tools.ts`). A package that adds a graph or a studio does the same. After PR #15, check that they reached main: `git grep -c '/audio/split' origin/main -- src/server/gpu/tools.ts` (Split soundtrack's row in `STUDIO_ROWS`) and `git grep -c separate-soundtrack-dbs origin/main -- workflows/comfyui/requirements.json` must each print a count. If not, add them (`node scripts/comfy/build-requirements.mjs` rewrites the index).
- **Data folders that ran the old integration branch:** migrations are known by their place in `MIGRATIONS`, and on `claude/fuobe-parity-4` up to `f7c6d8e` places 23 and 24 were acc-1's identity tables and acc-2's audit-log trigger. On main they are the GPU pre-flight's tables and `assets.account_id`. PR #15's `open()` in `src/server/db.ts` forgets either place when main's work is missing and the dropped package's is there, so main's migration runs (`tests/dropped-branch-migrations.test.ts`). The dropped tables stay, unused. Never reuse a place in that list: only append.
- **Public sign-up** is off by default, and verify.sh's servers run without it. `tests/public-signup.test.ts`, `tests/public-signup-tools.test.ts` and `tests/account-*.test.ts` pin the guest and account answers.
- **Small free disk and Vitest:** accounts can't upload or run while the data disk has less free space than it keeps (`FUOBE_ACCOUNT_DISK_FREE_GB`, else 20 GB or a tenth of the disk, at least 2 GB). In a container with a few GB free, `POST /api/generations` then answers 503 where `tests/gpu-api.test.ts` expects 409, so run Vitest with `FUOBE_ACCOUNT_DISK_FREE_GB=1` (verify.sh and the build prompts do).
- **What none of the checks cover:** no GPU and no paid key have been used. Every Original is checked in demo mode, on the CPU ComfyUI (graphs accepted, no weights run) and by unit tests, but not for image quality or real bills.
- **The owner's workflow JSONs and downloaded repos:** never commit them, never run them.
