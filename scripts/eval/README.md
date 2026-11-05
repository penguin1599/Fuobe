# Fuobe evaluation harness

`scripts/eval` measures the Fuobe Originals. You give it a suite of cases. It runs each case through a
running Fuobe's REST API, downloads what comes back, scores it and writes a report. The report holds
timing, cost, memory, metrics and a blind A/B review page. Runs are kept, so you can compare them.

The rule it serves: **an Original's recipe becomes a default only after the harness has measured
it** (see [The promote rule](#the-promote-rule)). The harness never changes a default by itself. A
person does that in a reviewed commit.

It works against any Fuobe, on three engines:

| `--engine` | What runs | Cost |
| --- | --- | --- |
| `demo` | The demo provider's media. It checks the harness itself, with no keys and no GPU. | Free |
| `open` | Your ComfyUI (the open engine), with the recipe's LoRAs. | Free (your GPU) |
| `cloud` | Hosted open models on fal / Replicate that take LoRA URLs. Partner models run where a suite asks. | Priced before anything starts, under a spend cap (default $5) |

## Quick start

```bash
pnpm dev                                              # or any running Fuobe
pnpm eval:run --suite selftest --engine demo          # about 30 s, free: submit, wait, download, score, report
pnpm eval:report latest                               # score again and rewrite the report
open scripts/eval/results/<runId>/report.html          # the contact sheet
```

A real look on your GPU, A/B against the same words without LoRAs and at half strength:

```bash
pnpm eval:run --suite soul --engine open --looks v1-general,v2-y2k-studio \
  --variants recipe,prompt-only,half-strength --dry-run   # lists the jobs, the LoRAs and the spend; starts nothing
pnpm eval:run --suite soul --engine open --looks v1-general,v2-y2k-studio --variants recipe,prompt-only,half-strength
pnpm eval:review latest                               # rate the pairs blind, with the keyboard
pnpm eval:promote latest                              # does the recipe win?
```

`fuobe eval <command>` runs the same commands from the `fuobe` CLI (from a Fuobe checkout). It finds
the server and token the way every `fuobe` command does, so the token `fuobe login` saved goes only to
the server it was saved for, even when `--url` names another one.

### Which Fuobe it talks to

The harness finds its server the way `bin/fuobe.mjs` does: `--url` / `--token`, then `FUOBE_URL` /
`FUOBE_TOKEN`, then what `fuobe login` saved. A Fuobe with a password needs an API token from
**Settings → Security → API tokens**. The token goes only to that server. Everything goes through
the public API (`/api/generations`, `/api/uploads`, `/api/elements`, the studio routes), so the
harness measures what a user gets.

- `--engine demo` needs **Settings → Placeholder results** turned on. A job that would run for real is
  skipped.
- `--engine open` / `cloud` refuse a server whose engine mode excludes them. A job that would come
  back as demo media is skipped and says why: placeholder results are on, no ComfyUI is connected, or there is
  no cloud key.
- **The model it names.** A job the server would run on another model than the one the case names
  (a studio's default maker, or a retired model the server runs on the Original that replaced it) is
  skipped, since it wouldn't measure that model.
- **Your Library stays yours.** Every generation the harness starts has the feature `eval`, a helper
  like a studio's steps: the Library and Home feeds leave it out unless **Show steps** is on. A studio
  route's steps (Genjutsu, Mixed Media) carry that studio's feature instead. `pnpm eval:trash <runId>`
  moves a run's generations, studio steps included, to that Fuobe's Trash.
- On the open engine the harness also reads ComfyUI directly (`--comfy-url`, default `COMFYUI_URL`
  or `http://127.0.0.1:8188`). It uses three read-only endpoints: `/system_stats` for memory,
  `/history` for ComfyUI's own timings, and `/object_info/LoraLoader` to name the LoRAs ComfyUI
  doesn't have yet. It never queues or cancels anything there.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm eval:run --suite <s> --engine demo\|open\|cloud` | Runs a suite, then scores it and writes the report (`--no-metrics`, `--no-report` to stop earlier) |
| `pnpm eval:report <runId\|latest>` | Scores again (only what changed) and rewrites `summary.json`, `report.html` and the history lines |
| `pnpm eval:review <runId>` | Serves the blind A/B page and saves ratings next to the run |
| `pnpm eval:compare <runA> <runB>` | Wins, losses and mean gain per metric. Exits 1 when a guarded metric regresses |
| `pnpm eval:promote <runId>` | Applies the promote rule. `--record` writes the verdicts into the research JSON; `--apply-strengths` also lowers over-cooked strengths there |
| `pnpm eval:covers <runId>` | Turns each promoted case's best render into its preset's cover (`public/previews/`, `src/lib/preset-previews.generated.ts`) |
| `pnpm eval:covers --from-masters <dir> --run <name>` | Turns rendered masters (one folder per preset id) into covers, merged into the same file |
| `pnpm eval:history` | Lists runs, newest first, and the per-case scores of one case (`--case soul/v1-general`) |
| `pnpm eval:validate` | Checks every case file, and that the generated suites match the research |
| `pnpm eval:setup` | Creates the metrics venv with uv (`--identity`, `--asr`, `--download`, `--dinov2`, `--torch-backend`) |
| `pnpm eval:trash <runId>` | Moves the run's generations to the Trash of the Fuobe it ran on (`--dry-run` counts them). The run's folder here keeps its outputs and scores |

Every command takes `--json`. Runs are named by id, by path, or as `latest`, `latest~1` (the run
before) and so on. `pnpm eval:<command> --help` lists each command's options.

Useful `run` options:

- `--looks v1-general,"Flash editorial"`: looks by slug, name or id.
- `--cases dop/motion-*`, `--tags v1,civitai`, `--limit 5`, `--prompts 1`, `--seeds 1,2`: run fewer
  jobs.
- `--variants recipe,prompt-only` or `all`: the recipe variants to run. Each suite has a default.
- `--model <id>`: one model id for every job, instead of the suite's targets.
- `--max-usd 2`: the cloud spend cap. The run is priced first, training included. It refuses to start
  over the cap, and it starts no job that would go over it: each job reserves its price before it
  starts, and its real cost replaces the reservation when it ends. A resumed run counts what its earlier
  attempts spent (every attempt that reached the server, and any training).
- A cloud job or training the server can't price is skipped, because the cap can't cover it.
  `--allow-unpriced` runs it anyway: it holds whatever is left of the cap while it runs, so nothing
  starts beside it, and its cost counts once the server reports it. Such a job can take the run over
  the cap by its own cost.
- `--concurrency`: open 1, others 4.
- `--resume <runId>`: runs only the failed and missing jobs again. Ctrl+C stops new jobs from
  starting; the jobs already running finish on the server.
- `--allow-fixtures`: uses the synthetic fixtures where your own inputs are missing.
- `--label "after the LoRA strength change"`: a note kept with the run.

## Suites

One JSON file per Original in `cases/`. Later Original packages add their own files here.

| Suite | Measures | Cases | Variants (default first) | Main metrics |
| --- | --- | --- | --- | --- |
| `selftest` | the harness itself | 5 small tools (trim, palette lock, join, frame, image) | — | temporal, clip |
| `soul` | Fuobe Soul, the 139 looks | 139 looks × 3 subjects, pinned seeds | `recipe`, `prompt-only`, `half-strength`, `plain`, `original` | clip, aesthetic, style |
| `soul-cinema` | Soul Cinema's one film look | 6 scenes, pinned seeds | `recipe`, `prompt-only`, `plain`, `original` | clip, aesthetic, style |
| `soul-hex` | Soul HEX palettes | 3 Fuobe palettes × 2 subjects | `words`, `lock` (open), `base`, `palette-model` (open), `plain` | palette, clip, aesthetic |
| `soul-id` | character and look training | your photos → train per family (Fuobe Soul, Soul Cinema, Soul HD, FLUX.1 [dev]) → scenes; a moodboard → a look | `trained`, `half-strength`, `references` | identity (style for the look), clip, aesthetic |
| `dop` | Fuobe DoP motions and effects | the 69 the research gives a LoRA, and the 20 camera moves it gives a Fun Camera pose or an LTX camera LoRA | `catalog`, `prompt-only`, `research` (the candidate), `partner` (cloud) | temporal, clip |
| `dop-mix` | Fuobe DoP's Mix | 5 move + effect pairs | `mix` (the candidate), `first` (the move alone) | temporal, clip |
| `dop-mixed-media` | DoP's Mixed Media effects in the cloud, blind (**run it first once you have paid keys**: [the rule](#dops-mixed-media-effects-the-first-run-with-paid-keys)) | 8 of the 32 (Sketch, Noir, Vintage, Paper, Hand Paint with a look LoRA; Comic, Two Color, Broken Mirror on their words) on your start frame, 2 seeds | `original` (the candidate: Fuobe Mixed Media draws the still in the look, then Fuobe DoP animates it), `partner` (cloud: the preset's words on Kling 2.5 Turbo, the default before O9) | temporal, clip |
| `genjutsu` | Genjutsu move / swap / restyle / Character swap | 7: Motion transfer and Object swap (each also on the Lite tier), Restyle, and Character swap with and without the first frame (through `/api/genjutsu`) | `original`, `partner` (cloud: each mode's own partner on fal) | temporal, clip |
| `mixed-media` | Fuobe Mixed Media (O9) | 7 looks on one clip, 3 s at 8 fps (through `/api/mixed-media`): 3 with a look LoRA, 4 on their words | `studio` (the Original frame by frame), `smooth` (its first frame, then Wan 2.2 Fun VACE), `words` (open: the per-frame model before O9), `partner-frames` (cloud: Nano Banana 2 per frame), `fast` (cloud: LTX-2.3 Reference Restyle) | temporal, style |
| `shorts` | Fuobe Shorts (O9) | 2: one segment from its first frame (`/api/generations`), and a 6 s session (`/api/shorts/sessions`) | `restyle` (Fuobe Shorts), `partner` (cloud: Gemini Omni Flash) | temporal, style, clip |
| `speak` | Fuobe Speak and Speak · Motion (O11) | 1 portrait + voice | `infinitetalk` (Fuobe Speak: InfiniteTalk with the FusioniX recipe on your GPU, fal's InfiniteTalk in the cloud), `s2v` (Fuobe Speak · Motion: Wan 2.2 speech to video) | lipsync, temporal, identity |
| `angles` | Fuobe Angles (O11) | 1: your photo with the camera turned 45° to the left, 2 seeds | `recipe` (Fuobe Angles: Qwen-Image-Edit 2509 + the Multiple-angles LoRA), `today-open` (open: the Angles app's 2511 recipe), `today-cloud` (cloud: fal's Qwen Multiple Angles) | identity, clip, aesthetic |
| `evolution` | Fuobe Evolution (O13) | 4 (through `/api/evolution`): Low, Medium and High on one clip with the same direction and 2 references, and one whose direction the writer makes from 3 references | `original` | temporal, style, clip |
| `popcorn` | Storyboards in Fuobe Soul's looks (O13) | 4 four-frame boards (through `/api/storyboards`): 3 looks and the same board without one | `original` | clip, continuity, aesthetic |
| `cinema` | Fuobe Cinema (O6) | 3 Director scenes (the prompt Cinema compiles), 4 camera moves as LTX-2.3's `camera_lora` (cloud), 2 films of 3 shots | `original`, `words` (no camera LoRA), `expansion` (fal's prompt expansion on), `wan` (Wan 2.2 A14B hosted), `partner` (Seedance 2.5); all but `original` cloud only | clip, temporal, continuity |
| `marketing` | Fuobe Marketing Image, Fuobe Try-On, the AI Influencer sheet and Instadump (O10) | 7: a Standalone product shot (the product-shot graph on your GPU; hosted Qwen-Image-Edit in the cloud), an ad's picture, a poster without a product, a try-on, the builder's sheet (through `/api/influencer`), an Instadump photo from a selfie | `original`, `partner` (cloud: GPT Image 2.5, Nano Banana Pro, Ideogram 3.0, FASHN) | clip, aesthetic, style (the product), identity (try-on, Instadump) |
| `relight` | Relight's looks | 12 portraits of your own (`local/relight/<id>.png`: 8 editorial portraits and 4 more) × the four named looks, and Golden hour and Studio rim with their softness said once | `viggle` (Generate lighting as the tool runs it), `turbo-today` (Qwen-Image 2.1 Turbo, the same words), `edit-2509-relight` (Qwen-Image-Edit 2509 with its Relight LoRA); run one variant at a time | identity, clip, aesthetic |
| `relight-placement` | Where Relight's placed light lands | the same 12 portraits × one white and one teal light at each of the 9 side × height spots | `viggle` only | identity, clip, aesthetic |
| `turnaround` | Turnaround video (N7-6) | 4 through `/api/turnaround`: four views, the front and the back (sides drawn by the Angles app), the front alone, a sheet alone (a front drawn from it) | `default` (Frames on your GPU, H3 Max references in the cloud), `keyframes` (cloud: FLUX 3 Max), `camera` (cloud: H3 Max camera controls) | identity of 8 sampled frames against the views, temporal, clip |
| `idol-views` | Idol 3D's other sides (idol-8) | 6 pictures in `local/idol-views/`: a figurine, a generated character, a photo of a consenting person, a product, a mug with its handle on its own left (view 1 must show the handle: the side check) and a glass, 2 seeds | `best` (the candidate: what the buttons run), `quick` (Quick look's settings) | identity, clip, aesthetic; look at the four views of every case, the people above all, before offering the buttons on characters |
| `separation` | Soundtrack separation (DBS D4): Split soundtrack, Remove dialogue, the dub's voice split | 7 synthetic 12 s mixes with known stems (dialogue centred and panned left, a mains hum, tape hiss, a master at −0.1 dBFS, a loud master whose music and effects reach full scale, the same mix inside a video) and your own clip for the blind review | `bsrnn-mono` (DBS-BSRNN, the fast stereo bed), `bsrnn-stereo`, `tiger-mono`, `tiger-stereo` (each channel), `dbs-dub` and `melband` (the dub's first step, Qwen3-ASR 0.6B), `demucs` (cloud), and Clean up dialogue: `clean-dialogue` (open, the bed at −18 dB), `clean-veed` and `clean-deepfilternet` (cloud) | separation, wer |
| `mesh` | Idol 3D quick mesh (idol-7): Idol's splat meshed by core Extract Mesh from Splat, in From an image on your GPU | 4 of your pictures: a rendered product, a product photo and a figurine (photo crop on), a generated character | `idol-mesh` (the 384 grid), `fine-grid` (512), `trellis2` (TRELLIS.2 for reference) | style against the picture, temporal, aesthetic; score the server's turntable of the GLB (Chromium and ffmpeg on the server) and open the GLBs too |
| `splat` | Image to 3D → Splat on your GPU: Idol 3D against TripoSplat ([the rule](#the-splat-suite-splat-modes-defaults)) | 11 single objects from one picture each (product renders, product photos, a figurine, a stylised character, a person, thin parts, glass and chrome), 3 seeds | `idol-best` (the candidate), `idol-quick`, `triposplat-today`, `idol-photo-crop` (the photo cases only), `triposplat-cloud` (cloud: fal's TripoSplat, a reference for the haze and the price) | style (DINOv2, the orbit against the input picture), temporal, aesthetic, splat |

`soul.json`, `soul-cinema.json`, `soul-hex.json`, `dop.json`, `dop-mix.json`, `dop-mixed-media.json` and `separation.json` are **generated** from the research. They come from
`docs/research/higgsfield-image-studios.json` (the look ids),
`docs/research/fuobe-originals-recipes-5.json` (recipes, LoRAs, Soul Cinema's recipe, the motion map) and
`docs/research/dbs-separation-7.json` (the DBS models' licences in the separation suite).
`soul-hex`'s palettes are Fuobe's own. Run
`node scripts/eval/gen-cases.mjs` after the research changes, and don't edit the generated files by
hand. `pnpm eval:validate` fails when they are out of date. The subject prompts are Fuobe's own. No
Higgsfield prompt or preview is used anywhere.

Soul variants, all on the same subjects and seeds:

- **recipe**: the look's template, its LoRA triggers, and its LoRAs at the listed strengths.
- **prompt-only**: the same words without LoRAs. Does each LoRA earn its slot?
- **half-strength**: every LoRA at half strength. This is the over-cooking check.
- **plain**: the base model with the subject alone.
- **original**: the shipped `fuobe-soul` Original (O2), which applies the look on the server. The look
  goes as its Fuobe id in `presetId` (`v1-general`, the slug `--looks` takes); a Higgsfield look id never
  leaves the harness. A lettering look (Graffiti) runs on `fuobe-soul-hd`. Every request names the engine
  the run is on (`engine`), so an Original that runs on both takes that one. Its grade and overlay are
  applied in the browser after generation, so the scores are of the raw picture.

Soul Cinema's variants are the same idea for its one look: **recipe** (the research's LoRAs with their
triggers, then the `cine` tail), **prompt-only** (the tail alone), **plain** and **original**
(`fuobe-soul-cinema`). Soul HEX's: **words** (the palette sentence the Color signature adds, on Fuobe
Soul: the cloud's HEX), **lock** (the same, then `POST /api/palettes/lock`: the open engine's HEX),
**base** (the words on today's base), **palette-model** (Z-Image Turbo · Palette) and **plain** (no
palette words, the control). A variant can carry fixed `words` after the prompt and its own `submit`
route; `{{request}}` in a route body is the job's own request.

DoP variants, on your start frame with two seeds:

- **catalog**: the preset as it ships, with today's open LoRA if it has one.
- **prompt-only**: preset strength 0, so the preset's words without its LoRAs. The server leaves the
  LoRA's trigger word out too, since it means nothing without the LoRA.
- **research**: the research's LoRA map at the listed strengths, its trigger words in front of the
  words (`trigger, prompt`, as a Soul look's).
- **partner**: the preset's words on Kling 2.5 Turbo (cloud only).

A variant that would send the server the same request as an earlier variant of the same case, prompt
and seed (model, route, final prompt, LoRAs, settings and inputs) is skipped and names the one it
repeats. Most DoP presets have no open LoRA in today's catalog, so their prompt-only run would repeat
the catalog run.

### Licence rules in the runs

The recipe's licence flags go with every job, following the research's "Licence rules for
Originals":

- Licences are information (Settings → Models & licences): a LoRA licensed for the GPU only goes to the
  cloud engine like any other, unless the install keeps such LoRAs on the GPU there.
- A civitai link is left out on the cloud until a mirrored copy exists, because civitai answers 401
  without your token.
- A non-commercial LoRA is noted on the verdict; with `--licence-hold`, a recipe that uses one isn't
  promoted.
- A LoRA link (your own variant's included) must be on Hugging Face, civitai, fal or Replicate: the API
  refuses other hosts, since the server may download an unknown file from it before a ComfyUI run.

A job records which LoRAs it asked for, which ones the route actually loaded, and which ones were
left out and why.

## Your own inputs: `scripts/eval/local/`

Inputs the repo can't ship live in `scripts/eval/local/`, which is git-ignored and never committed.
That covers photos of people, reference clips, licensed style references and voices. Cases name them
as `local/…`. A job whose local input is missing is skipped and names the file. Demo runs use the
small synthetic files in `fixtures/` instead.

```
scripts/eval/local/
  references/soul/<look-slug>/*.jpg   # style references per look (your own or licensed images; never Higgsfield previews)
  references/mixed-media/<look>/*     # what each Mixed Media look should look like
  references/shorts/claymation/*      # what the Shorts session's look should look like
  characters/default/*.jpg            # 20+ photos (80 at most) of ONE consenting person (soul-id)
  styles/default/*.jpg                # 20+ images in one style, a moodboard (soul-id/look)
  dop/start.png, dop/end.png          # a start frame (a person on a bridge fits the prompts), an end frame for transitions
  genjutsu/dance.mp4, character.png, style.png
  genjutsu/street.mp4, object.png     # street.mp4 at least 720 px on each side (Kling O3's edit, the cloud partner)
  mixed-media/clip.mp4                # 4–10 s
  shorts/clip.mp4, shorts/frame0.png  # clip.mp4 at least 6 s (the session case); frame0.png its first frame in the new look
  speak/portrait.png, speak/voice.wav
  marketing/product.png, person.png   # a product photo on a plain background; a full-body photo of a consenting person
  marketing/garment.png, selfie.jpg   # a garment on its own or flat-lay; a consenting person's selfie
  angles/subject.png                  # a person or a product in a scene
  idol-views/figurine.png, character.png, person.png, product.png, mug.png, glass.png  # one object each; person.png a consenting person, full body; mug.png its handle on its own left
  evolution/walk.mp4                  # 4–30 s of someone walking, your own footage
  evolution/ref-1.png … ref-3.png     # characters, places or a style you own (never Higgsfield previews)
  turnaround/front.png, right.png     # one consenting person or a made-up character, full body on a plain background;
  turnaround/back.png, left.png       #   right and left are their own (facing them, their right side is on your left)
  turnaround/sheet.png                # a turnaround sheet of the same character
  splat/bottle.png, sneaker.png, headphones.png      # generated product renders, one object each
  splat/photo-mug.jpg, photo-bag.jpg, figurine.jpg   # photos of one object (the photo crop runs on these)
  splat/character.png, person.png                    # a stylised character; a made-up person or one who agreed, full body
  splat/chair.png, plant.png, glass-chrome.png       # thin parts; glass with chrome
```

The `popcorn` suite needs no inputs of its own: its boards start from words. The `turnaround` suite's cases with
views send Soul ID's consent line for a real person (`"consent": true` in `cases/turnaround.json`), so use pictures of
someone who agreed, or of a made-up character.

**Training needs consent.** `soul-id.json` ships with `"consent": false`, so a character's training
refuses to start. Copy the file to `local/soul-id.json`. In your copy, set `"consent": true` only
when the person in the photos agreed: the runner then sends Fuobe the consent line with the training,
as the Train dialog does. A look (`"kind": "style"`) needs no consent. Then run it with
`--suite scripts/eval/local/soul-id.json`. To reuse a character you already trained, put its element
id in `"element"` instead of training again. Each case trains its own element (a Soul ID runs on the
models of the base it was trained on), so a full cloud run trains five times: about $1.70 + $1.70 +
$1.50 + $6.00 for the four character cases (Soul Cinema trains Fuobe Soul's family again unless its
`"element"` names the character case's element) and $3.39 for the look, priced before anything
starts. A training the server would run as a demo (no fal.ai key or AI-Toolkit connected, or Demo
mode On) is skipped with its case, so a "trained" result is always a trained LoRA. The look case runs
the trained style as the board's own look (`"presetId": "own-style"`), as a trained moodboard does in
the app.

## The case format

A suite file follows `cases/case.schema.json`, which editors use for completion. The schema is
written from `lib/schema.mjs`.

```jsonc
{
  "$schema": "./case.schema.json",
  "suite": "my-original",
  "title": "Fuobe Something",
  "description": "What it measures and what it needs.",
  "original": "fuobe-something",                  // the Original(s) measured
  "kind": "image",                                // image | video | audio
  "recipe": "none",                               // soul-look | motion | none: where a case's recipe comes from
  "targets": {                                    // model ids per engine, in order of preference:
    "open":  { "models": ["fuobe-something", "oss-z-image-turbo"] },   // the first one this Fuobe has is used
    "cloud": { "models": ["z-image-turbo-cloud"], "extra": { "num_inference_steps": 8 } },
    "demo":  { "models": ["oss-z-image-turbo"] }
  },
  "defaults": { "seeds": [1001], "metrics": ["clip", "aesthetic"], "timeoutSeconds": 1800 },
  "variants": {
    "recipe": { "description": "The recipe as researched", "loras": "recipe" },
    "half":   { "description": "Half strength", "loras": "recipe", "loraScale": 0.5 },
    "mine":   { "loras": [{ "file": "my-lora.safetensors", "url": "https://huggingface.co/…", "strength": 0.8, "trigger": "myword" }] },
    "partner": { "models": { "cloud": ["kling-2-5-turbo"] }, "engines": ["cloud"] }   // engines: where the variant runs
  },
  "cases": [
    {
      "id": "my-original/portrait",
      "title": "A portrait",
      "prompts": [{ "id": "p1", "text": "a woman reading by a window", "seed": 1001 }],
      "references": "local/references/my-original/portrait",   // a folder or a list of files
      "inputs": { "images": ["local/my-original/face.png"] },  // images, video, videos, audio, endImage, mask…
      "demoInputs": { "images": ["fixtures/start-frame.png"] },
      "params": { "aspectRatio": "3:4" }
    }
  ]
}
```

Other case fields:

- `look` / `motion`: a Soul look id, or a motion or effect name. The recipe comes from the
  research.
- `presetId`: a catalog preset.
- `models` / `op`: per-case models, and the operation.
- `variantModels`: a variant's models for this case (`{"partner": {"cloud": ["kling-o3"]}}`), over
  the variant's own. Each Genjutsu mode names its own partner this way.
- `shots`: a film's shots. Continuity is measured across them.
- `train`: photos, a target per engine, `kind` (`character` or `style`), `consent`, and `minPhotos`.
- `submit`: a studio route and its body, with `{{inputs.video}}`, `{{source:inputs.video}}`,
  `{{prompt}}`, `{{seed}}`, `{{engine}}` and `{{requestId}}` filled in. `pnpm eval:validate` refuses a
  body that names an input (`{{inputs.images.1}}`, say) the case's `inputs` or `demoInputs` don't have.
- `engines`: the engines the case runs on.
- `tags`, `metrics` and `note`.

A variant can also name `tags`: it runs only on the cases with one of them, and the others skip it (the splat
suite's photo crop runs on the cases tagged `photo`). `defaults.styleModel` (`clip` or `dinov2`) is the style
metric's embedder for the suite's runs; it is kept in `run.json`, and `--style-model` overrides it.

Paths can start with:

- `local/…`: your own inputs.
- `fixtures/…`: the synthetic fixtures.
- `samples/…`: `public/samples`.
- Anything else is a path relative to the case file, an absolute path, or a link.

Run `pnpm eval:validate` after editing.

## What a run records

Everything goes to `scripts/eval/results/` (git-ignored; move it with `--out` or `FUOBE_EVAL_RESULTS`):

```
results/
  history.jsonl                 # one line per run × case × variant: mean scores (pnpm eval:history)
  <runId>/
    run.json                    # suite, engine, filters, variants and the candidate, the server and ComfyUI it ran on,
                                #   git commit, the research files' hashes, spend cap, the training estimate and the spend
    elements.json               # training cases: the element made or trained, its training and what it cost
    jobs.jsonl                  # one row per job, appended as each one ends (see below)
    outputs/<jobId>/…           # the downloaded results
    metrics.json                # scores per job (and per film), which model made them, at which revision, under which licence
    summary.json                # means per variant, variant-against-variant wins, blind ratings, failures
    report.html                 # the contact sheet: every case × variant with its scores (light and dark, phone-friendly)
    review/index.html           # the blind A/B page; review/key.json (which side was which) is never served
    review/ratings.json         # your ratings
    promote.json                # the promote verdicts
```

Each row in `jobs.jsonl` records:

- the case, prompt, seed and variant;
- the model id asked for and the one that ran;
- the route (`provider`, `endpoint`) and the final prompt;
- the recipe: look or motion, template, the LoRAs with their strengths, which LoRAs the route loaded
  and which it dropped and why, the sampler settings, and the licence flags;
- the generation ids and the downloaded files;
- the time: submitted, finished, wall clock;
- the cost: the estimate before running and the cost after;
- on the open engine: peak memory from `/system_stats` (CPU ComfyUIs are marked as RAM, not VRAM)
  and ComfyUI's own execution time from `/history`;
- notes and errors.

## Metrics

The metrics are written in Python (`metrics/fuobe_metrics`). Each metric is a small module with
tests on tiny fixtures. They run on the CPU by default (`--device cuda|mps|auto` to change that).
`pnpm eval:setup` creates the venv with [uv](https://docs.astral.sh/uv/) from the pinned
`metrics/requirements.txt`, which is compiled from `requirements.in` with CPU torch.
`--download` fetches the weights now; otherwise they download on first use. Every weight is pinned
to a Hugging Face revision, and its licence is recorded with every result. Without Python, a run
still has its timing and cost, and the report says why the scores are missing.

| Metric | Key(s) | Better | How | Model and licence |
| --- | --- | --- | --- | --- |
| Prompt adherence | `clip` | higher | CLIPScore (100·cos) between the output and the case's own words. Clips are sampled at 4 frames | open_clip ViT-B/32 laion2B, **MIT** (`--clip-model clip-l14`: OpenAI ViT-L/14, MIT) |
| Aesthetic | `aesthetic` | higher | LAION improved aesthetic predictor v2 on CLIP ViT-L/14 embeddings, about 1–10 | head **Apache-2.0** (christophschuhmann/improved-aesthetic-predictor), CLIP MIT |
| Style vs references | `style`, `styleNearest` | higher | cosine of the output's embedding to the centroid of the look's reference set, and to the nearest reference | CLIP (default), or `--style-model dinov2`: DINOv2 ViT-S/14 via timm, **Apache-2.0** |
| Identity | `identity`, `faceRate` | higher | ArcFace-style face embeddings of the output against the person's photos; the share of frames with a face | **AuraFace v1**'s recognition model (fal, **Apache-2.0**, trained for commercial use), with faces found and aligned by **YuNet** (OpenCV Zoo, **MIT**). The SCRFD detector AuraFace's repo ships comes from insightface's model zoo (released for non-commercial research; the licence is unclear), so it runs only with `--face-detector scrfd`. insightface's `buffalo_l` is **non-commercial research only** (recorded with the result): pick it with `--identity-model buffalo_l`; `--commercial-only` refuses it |
| Temporal consistency | `drift`, `driftMax`, `warp` | lower | frame-to-frame CLIP embedding drift (mean and worst jump), and a warp error: Farneback optical flow with a forward-backward occlusion mask | CLIP, OpenCV (Apache-2.0) |
| Lip-sync | `lipsync`, `lipsyncOffset` | higher | a proxy: mouth-region motion against the voice's loudness, with the best lag as the A/V offset | the identity metric's face detector for the face box when identity is installed, else a fixed lower-centre region |
| SyncNet (optional) | `syncnet` | higher | runs only when `FUOBE_EVAL_SYNCNET_CMD` points at your own SyncNet. It isn't bundled because its weights' licence isn't stated | yours |
| Shot continuity | `continuity` | higher | CLIP similarity between consecutive shots of a film | CLIP |
| Palette | `paletteFit`, `paletteCover` | lower, higher | the mean ΔE (CIE76, Lab) from each pixel to the nearest colour of the palette the request sent (`params.palette`, or the palette lock's colours), and the share of the palette's colours that are nearest for at least 3% of the pixels | none (numpy) |
| Separation | `voiceSiSdr`, `remixSiSdr`, `musicSiSdr`, `effectsSiSdr`, `backgroundSiSdr`, `voiceSdr`, `backgroundSdr`, `mixError`, `bedLevel`, `bedPeak`, `bedScale`, `stereoCorrGap`, `noiseInVoice`, `speedX` | see each | each stem against the mix's known part (SI-SDR, and SDR where the level counts; a mono stem is scored against the reference's mono mean); voice + bed against the input (dB under it); the bed's level and peak against the known bed, and its gain against input − voice (`bedScale`: AudioMerge scales a bed that peaks over full scale down); Clean up dialogue's one file against the voice plus the known bed at the level asked (`remixSiSdr`, `bedLevel` = the bed's gain in it); the bed's left/right correlation against the known bed's; the share of a known hum or hiss left in the dialogue; times real time from ComfyUI-DBS's report (all passes), else from ComfyUI's time for the graph | none (numpy) |
| Word error rate | `wer`, `werInput`, `werTranscript` | lower | the dialogue stem heard by Whisper against the words spoken; `werInput` is the same on the input as it is (what "Clean the voice first" changes); `werTranscript` is the job's own transcript (Qwen3-ASR in the dub's first step) | **Whisper base.en** (OpenAI, **MIT**; the card says Apache-2.0) through transformers (Apache-2.0): `pnpm eval:setup --asr` |
| Splat haze | `haze`, `gaussians` | lower, — | reads the job's splat file (`.spz` versions 1–3, or a binary 3DGS `.ply`, by its content) and gives the share of Gaussians under opacity 0.05 and their count. A GLB (the demo's) is noted, not scored | none (numpy) |
| Time, cost, memory | `seconds`, `costUsd`, `vramGb` | lower | from the runner | — |

Identity needs `pnpm eval:setup --identity`, which installs insightface and onnxruntime (MIT
libraries). `metrics.json` records the face detector apart from the recognition model, each with its
licence, and compare warns when two runs used different detectors. Re-scoring is incremental: a job whose outputs and settings haven't changed keeps its
scores. `--metrics clip,style` re-scores only those families and keeps the others. `--force`
re-scores everything.

The metrics are signals, not verdicts. CLIP rewards literal prompt matches. The aesthetic predictor
has its own taste. Style needs references that really show the look. That is why promotion also
needs people's ratings.

## Blind A/B review

`pnpm eval:review <runId>` writes `review/index.html` and serves it at `http://127.0.0.1:4173`. The
page shows two results side by side. Their order comes from a hash, and nothing on the page names
the variant, model or file.

- `--against variants` is the default when the run has two or more variants. It pairs the run's
  candidate (see [the promote rule](#the-promote-rule)) with each of the others on the same case,
  prompt and seed.
- `--against references` is the default otherwise. It pairs each output with one of your references
  from `local/references/…`.
- `--against <otherRunId>` pairs the same jobs across two runs, for example before and after a
  change.

Use **←** / **1** for the left result, **→** / **2** for the right one, **↓** / **0** / **Space**
for "about the same", **S** to skip and **U** / **Backspace** to undo. Space and Enter on a focused
button press that button. On a phone, use the three buttons. The server answers only on 127.0.0.1 /
localhost, and saves ratings only from its own page. Ratings save to `review/ratings.json` as you go. Opened as a plain file, the page keeps
them in the browser and offers a download. `pnpm eval:report` unblinds the ratings with
`review/key.json` and adds the preference per variant pair to `summary.json`.

## Comparing runs and catching regressions

```bash
pnpm eval:compare latest~1 latest                                  # wins / losses / ties and mean gain per metric
pnpm eval:compare base-run new-run --fail-on clip,style --threshold 5%   # exit 1 when either mean drops by more than 5 %
pnpm eval:compare run:prompt-only run:recipe --fail-on style       # two variants of one run
pnpm eval:compare a b --fail-on warp --per-case                    # also fail on any single case's regression
```

Compare matches jobs on case, prompt, seed and variant. `--threshold` can be an absolute amount in
the metric's units, or a percentage of A's mean. Without it, each metric's own noise band applies
(`lib/metric-info.mjs`). A guarded metric with no scores in both runs counts as a failure, so the
check can't pass just because the metric never ran. Every report appends its per-case means to
`results/history.jsonl`, and `pnpm eval:history --case soul/v1-general` shows a case over time.

## The promote rule

The candidate is the variant a suite names in `defaults.candidate` (DoP: `research`), else `recipe`
when the run has it, else the run's first variant; `--candidate` picks another. It is **eligible** to
become the default only when one run, on the same prompts and seeds, shows all of the following for
the case:

1. **Complete**: none of the recipe's LoRAs was left out on that engine. Its licences are information:
   a non-commercial LoRA (or one licensed for the GPU only, on a cloud run) is a note on the verdict, and
   holds the recipe only with `--licence-hold`.
2. **Enough results**: at least 3 for the case.
3. **Metrics**: against every alternative in the run (prompt only, half strength, the bare base,
   today's default), it scores at least as well on the case's main metric: the first of style (a look
   with references), lip-sync, identity, aesthetic, CLIP (a DoP motion's words) and warp error that the
   case has scores for. It also gives up no more than 1.0 CLIP, 0.15 aesthetic, and on clips 0.002 warp
   error and 0.004 drift.
4. **People**: at least 6 blind ratings of this case's own pairs against the alternatives (every pair
   the review offered, when it offered fewer), with at least 55 % of the non-tie ratings going to the
   candidate. Ratings of other looks don't count.

If half strength wins, the verdict is **lower strengths**, not another recipe: the LoRAs over-cook,
so lower them in the research JSON and run again. When the candidate and an alternative ran on
different endpoints (fal's Z-Image runs LoRAs on `/lora`), the verdict says so. Demo runs never
promote anything. A run on one engine says to check the other engine too.

`pnpm eval:promote <runId>` writes `promote.json`. `--record` also writes each case's verdict into
the research JSON (`docs/research/fuobe-originals-recipes-5.json`). The verdict goes in the `eval`
list of the entry it measured: a Soul look's `presets[]` entry, or a motion's `motionsEffects[]`
entry. Each record holds:

- the run, the engine and the date;
- the verdict and the reasons for it;
- the main metric against each alternative;
- the LoRAs it ran, and the strengths to try when half strength won.

A newer record for the same engine and case replaces the older one. The file keeps its format, so
the diff shows only the records. Recording alone never changes a recipe, a strength or a default.

`--record --apply-strengths` does lower strengths that over-cook: where half strength won, the entry's
LoRAs take the strengths that variant ran, and the record lists each change (`appliedStrengths`). It
still lands as a diff for a person to review. Defaults stay code changes that a person reviews:

1. Review the research JSON's diff (or edit it).
2. Regenerate the catalog (`pnpm gen:catalog`).
3. Measure both engines again.

### DoP's Mixed Media effects: the first run with paid keys

Since build plan O9, DoP's 32 Mixed Media effects run on Fuobe DoP in the cloud (Fuobe Mixed Media draws your
still in the look, then Fuobe DoP animates it); before, they ran on their words on Kling 2.5 Turbo. Fuobe DoP
stayed the default on 2026-10-30, on one condition: the first evaluation run with paid keys compares
the two blind. The suite says so (`"runFirst": "paid-keys"`; `pnpm eval:validate` marks it), and its `decides`
field holds the rule:

```bash
pnpm eval:run --suite dop-mixed-media --engine cloud --variants original,partner --dry-run   # the jobs and the spend
pnpm eval:run --suite dop-mixed-media --engine cloud --variants original,partner
pnpm eval:review latest                                                                    # rate every pair blind
pnpm eval:report latest                                                                    # the preference per case
```

**The rule.** Fuobe DoP stays the default unless it clearly loses: in one cloud run with at least 6 blind
ratings per case, Kling 2.5 Turbo takes at least two thirds of all non-tie ratings, and more than half of them
in at least 6 of the 8 cases. Then the default for all 32 effects goes back to Kling 2.5 Turbo in a reviewed code
change (the `mixed-media-route` branch of `src/lib/catalog/dop.ts`), and `docs/STATUS.md` records the run.
Anything less keeps Fuobe DoP. The metrics are shown beside the ratings but don't decide this one: the two
models' clips differ in look by design (the still is redrawn first), so the people decide.

### The separation suite: defaults with numbers

The separation suite chooses the soundtrack split's defaults (doc `docs/research/dbs-separation-7.md`, §2.4 and §9 D4).
Its test mixes are built here, so every stem is known exactly:

```bash
pnpm eval:setup --asr                                             # Whisper for the word error rate (optional)
python3 -I scripts/eval/fixtures/make-separation.py --speech <folder> --speech-licence "<source, licence>"   # local/separation/<mix>/: mix, voice, music, effects, background, noise, meta.json
pnpm eval:run --suite separation --engine open --variants bsrnn-mono,bsrnn-stereo,tiger-mono,tiger-stereo
pnpm eval:run --suite separation --engine open --cases separation/centre,separation/hum,separation/video --variants bsrnn-mono,dbs-dub,melband
pnpm eval:run --suite separation --engine open --cases separation/centre,separation/hum,separation/hiss,separation/loud-bed --variants clean-dialogue,bsrnn-mono
pnpm eval:review latest                                           # your own clip in local/separation/real/clip.mp4, blind
```

`--speech` takes a folder of speech files with their words (`<name>.flac` and `<name>.txt`, or an `index.json`):
Fuobe's own TTS lines are the intended source. Its licence is required (`--speech-licence`, or a `licence.txt` in the folder). The music, effects, hum and hiss are synthesized by the script from
fixed seeds (Fuobe's own, CC0). Each mix's `meta.json` records the words, the levels and every source's licence. The
blind review pairs the dialogue stems and the music & effects stems of two variants as separate questions, with
players instead of pictures, both sides served as FLAC so the file type doesn't say which model made it. Clean up dialogue's
open run gives one file; it is scored against the voice plus the known bed at the level asked (`remixSiSdr`), with the
bed's gain in it (`bedLevel`), the noise left in it and its WER. The cloud runs Demucs (as today's cloud dub does); DBS isn't hosted, and SAM Audio
isn't offered on the cloud engine. The suite's `decides` field holds the rule; a person changes a default, in a
reviewed commit.

### The splat suite: Splat mode's defaults

The splat suite chooses three defaults in Image to 3D → Splat ([`docs/research/idol-9.md`](../../docs/research/idol-9.md),
§9 idol-3, and its Results section): which open model comes first (TripoSplat or Idol 3D), Idol's Quick look settings,
and whether the photo crop starts on for photos. It needs a GPU with 8–16 GB and both models' weights; the CPU ComfyUI
can't run it.

```bash
pnpm eval:run --suite splat --engine open --variants idol-best,idol-quick,triposplat-today,idol-photo-crop --dry-run
pnpm eval:run --suite splat --engine open --variants idol-best,idol-quick,triposplat-today,idol-photo-crop --label "<GPU>, driver <x>, ComfyUI <v>"
pnpm eval:review latest                                           # the orbits, blind: Idol Best against each of the others
pnpm eval:report latest                                           # the ratings per pair
pnpm eval:compare latest:triposplat-today latest:idol-best --per-case
pnpm eval:promote latest --against triposplat-today              # decision 1: Idol Best against TripoSplat today only
pnpm eval:run --suite splat --engine cloud --variants triposplat-cloud   # optional: fal's TripoSplat, about $0.05 a job
```

The orbit video is what is scored and reviewed; the `.spz` stays with each job and the `splat` metric reads it. Style
uses DINOv2 (the suite's `styleModel`), so it compares the orbit's frames with the input picture without words. The
photo crop runs on the three cases tagged `photo`. Where ComfyUI has the ComfyUI-Idol pack, Idol runs its clean graph,
whose saved file is pruned at opacity 0.05, so Idol's haze there is near zero by design and the number that matters is
TripoSplat's. The cloud has no Idol run here; `triposplat-cloud` is labelled TripoSplat and gives the haze, the time and
the price only (a `.ply` without an orbit). The suite's `decides` field holds the rules; a person changes each default
in a reviewed commit.

## Covers: the renders become the preview media

`pnpm eval:covers <runId>` takes the best render of each **promoted** case (best on the case's main
metric) and makes it that preset's cover. A still becomes a JPEG of at most 768 px; a clip becomes its
first 4 seconds, muted, at most 512 px, with its first frame as the poster. They go to
`public/previews/<suite>/`, and `src/lib/preset-previews.generated.ts` lists them by preset id (a
DoP preset, `effect-thunder-god`) or look id (`v1-general`). The gallery cards play a listed cover
instead of their procedural preview. Next to it, `src/lib/preset-covers.generated.ts` says only which
presets have a cover and a clip: the pickers (camera motions, Mix, Cinema Studio's moves) read that in
the browser. Their tiles show each poster's small copy (320 px wide) from `thumbs/` next to it, which
every run makes where it's missing or older than its poster.

Every URL in both files ends in its file's content version: `?v=` and the first 8 hex digits of the
sha256 of its bytes (a poster's with its small copy's, whose URL keeps the poster's version). So a
cover made again under its old name gets a new URL, and the site serves versioned covers for a year
(`next.config.ts`). Each run versions the whole manifest after making its files.
`pnpm eval:covers --versions` does only that: it hashes the files as they are. The only thing it
encodes is a poster's small copy that's missing or older than its poster (a poster copied in by hand),
which it makes first, so the copy never keeps the old picture under the new version. `--dry-run` says
how many URLs would change and which copies it would make, and fails while any copy is due.
`node scripts/gen-preset-peaks.mjs` versions Home's peak frames the same way (`--versions` alone
does only that). So does `node scripts/gen-before-after.mjs --masters <dir>`, which makes the HD before
and after (1280 and 512 px) of every app whose cover is a reveal clip, for Home's before/after slider,
from the clips' masters (start.png, end.png and any donor.png): it checks each pair against the app's
poster and clip and writes nothing when one doesn't match. Run it again when a reveal clip is made again.

- `--variant catalog` takes that variant's renders for every case instead, such as what ships today.
- `--dry-run` lists what it would pick.
- Only Fuobe's own renders become covers: a demo run never does. A render whose LoRAs aren't commercial
  becomes one with its licence noted (`licence` in the result); `--commercial-only` leaves it out. No
  Higgsfield preview is used anywhere.
- It needs ffmpeg. Look at the media and the generated file's diff before committing them.

### Covers from rendered masters

Preview renders made outside a run (the gallery renders made in ComfyUI) become covers the same way:

```sh
pnpm eval:covers --from-masters <dir> --run comfyui-previews-2026-10 --engine comfyui --model ideogram4 --video-model minimax-h3 --variant lean-json
```

- `<dir>` has one folder per preset id (`effect-set-on-fire/`). A folder's `clip.mp4` becomes a clip
  cover (first 4 seconds, its first frame as the poster). The cards play a clip in a loop, so its last 6
  frames are crossfaded into its first ones and the loop has no jump (every clip cover is made this way,
  also `eval:covers` from a run). A folder without a clip uses its `start.png` as a still cover (a 4:2:0
  JPEG at most 768 px). A folder with neither is skipped.
- The covers go to `public/previews/presets/` (`--suite` names another folder).
- Each cover records the run, the engine, the model and the variant: `--model` for stills, `--video-model`
  for clips. A folder's `meta.json` can name its own `model` and `variant`.
- A folder's `meta.json` with `"length": "full"` keeps the clip's whole length (at most 8 seconds) instead
  of its first 4 seconds, for an effect whose end matters. Every frame of the clip shows clean: 6 frames
  are added after its last one, dissolving back to its first, so the loop has no jump and the end is not
  blended away. Its first frame is the poster. The cards play a clip of any length. A change to
  `meta.json` makes the cover again on the next run, as a new master does.
- The manifest is merged. Covers that other runs wrote stay, and only the ids found in `<dir>` are
  replaced. An id whose cover another run made in another folder (a measured `eval:covers` cover) is
  skipped and listed, so re-running the masters never undoes a measured cover; `--replace` takes it over
  and removes its old files. A manifest that can't be read stops the run instead of being overwritten.
- Run it again as new masters land. A cover that is newer than its master is kept, so only new or
  changed masters are encoded (`--force` encodes all of them). `--only id,id` limits the run to those
  presets. A preset whose cover changes from a clip to a still loses its old clip.
- `--dry-run` lists what it would make. Review the media and the manifest diff before committing them.

## Tests

- `tests/eval-harness.test.ts` (Vitest) covers several areas:
  - The runner runs end to end against Fuobe's real route handlers, served over HTTP, with the demo
    provider: plan, price, upload, submit, wait, download and record.
  - Studio routes (Genjutsu, a Shorts session, the Evolution suite), and a training case.
  - The engine checks, the spend cap, `--resume` and the dry run.
  - Case-file validation.
  - Report, blind review, compare (with its exit codes), promote and `--record`.
- `tests/eval-api.test.ts` covers the API seams the harness needs: a recipe's LoRAs on
  `POST /api/generations`, and a preview that says which LoRAs the route loads.
- `tests/eval-metrics.test.ts` runs the Python tests (`metrics/tests`, pytest) in the metrics venv,
  or through uv. Without either, they are skipped. The maths tests use numpy only. The media tests
  need ffmpeg. The model tests run when their weights are cached.
- `tests/e2e/eval-review.mjs` checks the report and review pages in a browser at 1440 and 390 px,
  light and dark, and rates every pair with the keyboard.

```bash
pnpm vitest run tests/eval-harness.test.ts tests/eval-api.test.ts tests/eval-metrics.test.ts
cd scripts/eval/metrics && .venv/bin/python -m pytest -q tests
```

## Adding an Original's cases

1. Add `cases/<original>.json`. Use `selftest.json` or `genjutsu.json` as a model, depending on
   whether the Original runs through `/api/generations` or through a studio route.
2. Name targets per engine. Put the Original's model id first and today's base model after it, so
   the suite runs now and switches to the Original once it exists.
3. Put inputs the repo can't ship under `local/…`, with small `demoInputs` from `fixtures/`.
4. Choose metrics. Add references if style or identity matter.
5. Run `pnpm eval:validate`, then `pnpm eval:run --suite <original> --engine demo`.
