# Development

[← README](../README.md) · [Features](FEATURES.md) · [Setup and self-hosting](SELF-HOSTING.md) · [Architecture](ARCHITECTURE.md)

- [Checks and scripts](#checks-and-scripts)
- [Browser checks](#browser-checks)
- [Evaluation harness](#evaluation-harness)
- [Where things are](#where-things-are)
- [Tech](#tech)
- [Contributing](#contributing)

## Checks and scripts

```bash
pnpm typecheck && pnpm lint && pnpm test   # TypeScript, ESLint, Vitest (465 files, 6362 tests; with uv, also the harness's Python metric tests)
pnpm build                                  # production build
pnpm gen:catalog                            # regenerate cloud models, studio packs, LoRA map, LoRA library, AI Influencer options, Fuobe Soul's looks, Soul ID's trainers and icon map from docs/research/*.json
pnpm dev:clean                              # clear the Turbopack cache if the dev server gets stuck reloading or serves stale CSS
node scripts/gen-demo-3d.mjs                # regenerate the demo GLB and turntable (needs ffmpeg)
node scripts/gen-demo-splat.mjs             # regenerate demo mode's splat as .ply and .spz (public/samples/demo-splat.*); about a third of its Gaussians are faint haze
node scripts/model3d/finish-glb.mjs --in raw.glb --out web.glb          # the server's GLB finish, by hand
node scripts/model3d/render-turntable.mjs --glb web.glb --out spin.mp4  # the server's CPU turntable (needs ffmpeg and a Playwright Chromium: npx playwright-core install chromium-headless-shell)
node scripts/train/kit.mjs list             # the training kit for Fuobe's own LoRAs: each job spec, its data-licence log and its fal price (check, job, motions and publish: scripts/train/README.md; nothing trains or uploads unless asked)
bash docs/handoff/verify.sh <branch> <out-dir>  # a branch as it will land, in a throwaway worktree: install, typecheck, lint, Vitest, the eval cases, the build, the browser checks it lists in demo mode, prices with a fake fal key, the CPU ComfyUI runs and the workflow library (see docs/HANDOFF.md)
```

On a disk with less free space than public sign-up keeps for accounts (20 GB or a tenth of the disk), `tests/gpu-api.test.ts` gets 503s: run Vitest with `FUOBE_ACCOUNT_DISK_FREE_GB=1`, as `verify.sh` does.

## Browser checks

Browser checks (the app must be running; demo mode is fine; Playwright and Chromium are picked up from the repo, a global install or `$CHROMIUM_PATH`):

```bash
pnpm test:e2e:mobile [url] [--light|--dark]    # no route may scroll sideways at 390 px (every route, hub mode and sample id)
pnpm test:e2e:shell [url]                      # skip link and landmarks, ⌘K palette, phone drawer and Search, full-screen studios, settings deep links, keyboard Show more
pnpm test:e2e:library [url]                    # helper steps, pins, review status, nested folders, zips, upload delete, phone layout (cleans up after itself; --keep leaves its data)
pnpm test:e2e:comfyui [url]                    # the open engine against a live ComfyUI
node tests/e2e/composer-flows.mjs [url]        # first paint, typing before hydration, paste, upload cancel, phone toolbar and blocker line
node tests/e2e/notifications.mjs [url]         # job notifications and the running count in the tab title
node tests/e2e/clipboard.mjs [url]             # Copy buttons on a plain-http LAN address (no Clipboard API)
node tests/e2e/layers.mjs [url]                # Layers regressions
node tests/e2e/cinema-scene.mjs [url]          # 3D scene: ask first, point cloud, fly, Capture → re-render, 390 px
node tests/e2e/canvas-smoke.mjs [url] --perf=60  # Canvas save, rename, trash → re-run, keystroke timing
node tests/e2e/canvas-board.mjs [url]          # Canvas drawing, shapes, text, comments, groups and Run group, pages, Undo across pages
node tests/e2e/canvas-open-dub.mjs [url]       # Translate (video) on an open-source-only install (sets Engine mode for the run, then puts it back)
node tests/e2e/dop-flows.mjs [url]             # Fuobe DoP in the Video studio: prices, engine switch, grade hand-off, 390 px (any string as the fal key adds the cloud prices; nothing is sent)
node tests/e2e/cinema-shortcuts.mjs [url]      # Ctrl/Cmd+Enter only from Cinema's prompt bar; new project names, phone Director chip
node tests/e2e/assist-flows.mjs [url]          # skills, memory, projects, skill upload, modes, phone sheet (the Scheduled page too)
node tests/e2e/cinema-original.mjs [url]       # Fuobe Cinema at 1440 and 390 px, light and dark: the model menu, camera moves on LTX-2.3's camera LoRA, prices, stills on Fuobe Soul Cinema, Soul Cast and Soul Location on Fuobe Soul in the cloud
node tests/e2e/genjutsu-original.mjs [url]     # Genjutsu on the Originals at 1440 and 390 px, light and dark: Character swap's controls, limits and licences, a demo run, the open engine's clicks and GPU line, no Higgsfield
node tests/e2e/character-swap-studio.mjs [url] # Character Swap Studio's whole flow on the cloud engine in demo mode (shots, words, a mask, an anchor, a continued segment, takes, review, Export decisions, assembly), every stage at 1440 and 390 px, light and dark, the 24 fps copy on your GPU, an AVI's browser copy, the Genjutsu hand-off and a 404; needs ffmpeg
node tests/e2e/mixed-shorts-original.mjs [url] # Mixed Media and Shorts on their Originals at 1440 and 390 px, light and dark: the modes and model menus per engine, a preview, demo renders, then cloud prices with a (fake) fal key
node tests/e2e/marketing-originals.mjs [url]   # Marketing Studio, Ads Studio, the AI Influencer builder, Photodump and Fashion Factory start on the Originals, partners stay choices, the try-on LoRA's switch
node tests/e2e/open-tools.mjs [url]            # the Angles and Fuobe Angles apps, Fuobe Speak in Lipsync priced on the voice, Depth map's large model, PixeletedFace's face mosaic, the new LoRA rows
node tests/e2e/popcorn-evolution.mjs [url]     # Video tools → Evolution (direction, price, a demo run with before/after), Storyboard's looks and price, Canvas's Effects 2.0 chains
node tests/e2e/skills-run.mjs [url]            # a skill with a recipe: the free test run, a run from the form and three from CSV rows, Test again, a switched-off skill, ⌘K
node tests/e2e/skills-builder.mjs [url]        # a 3-step chain made in the composer, turned into a skill from the Library, checked, saved and run with new words
node tests/e2e/fixes-5.mjs [url]               # Settings → Training against a stand-in AI-Toolkit, the H3 packs' install commands, Edit video's clip price and window
node tests/e2e/split-soundtrack.mjs [url] [outDir] [--live]  # Audio → Split soundtrack: the cloud engine's "runs on your GPU" note, the open engine's options and price, then a split of an audio file and a video: the stem tiles, the mixer, a preset, Export mix and Put back on the video; needs ffmpeg
node tests/e2e/moss-image.mjs [url] [--fal|--live]  # MOSS-Image in the Image studio's model menu on both engines, Options → Quality from the keyboard, its Settings → Models & licences rows; prices follow what the server runs (--fal: $0.05 and a LoRA run's unknown price; --live: Free on your GPU)
node tests/e2e/cinema-path.mjs [url]           # Fly path in Cinema's 3D scene: + Keyframe and K, a move, Preview, Film on the cloud (an H3 Max take) and on your GPU (the path rendered in the browser, 81 frames), the Path sheet at 390 px
node tests/e2e/turnaround.mjs [url]            # Turnaround video from a Character Sheet, Fly around on a character's page (the cloud routes and the consent line) and Soul Cast's take in Cinema, with a demo run to the film
node tests/e2e/picker-covers.mjs [url]         # covers in the camera motion, Mix and Cinema move pickers: small posters only, a hovered clip stops when the pointer leaves, the picked clip goes on, the arrow keys play a move, Cinema loads the list when shown
node tests/e2e/kandinsky6.mjs [url] [--shots <dir>]  # Kandinsky 6.0 in the Video studio on both engines (Free on your GPU, fal's price, its Quality, the hint for spoken lines), Upscale → Video on Kandinsky VSR at 2.25x, Lipsync's link to it; with `FAL_KEY` set (below), the prices Pro · Best $1.35, Lite · Fast $0.08 and VSR $0.09
node tests/e2e/pika-flex.mjs [url] [--shots <dir>]   # MiniMax H3's "Fast · Pika Flex (6 steps)", the References tray (clips and voices named in order, a too-long voice refused), a Cinema take, "Talk from a voice clip" and its refusals; nothing is sent; needs ffmpeg
node tests/e2e/keying.mjs [url] [outDir]             # Video tools → Green screen (CorridorKey 2.0, Bria green screen) with its outputs and formats, Remove background with VRMBG 3.0, Layers → Remove background with FeyNoBg and Bria's guided cut-out
node tests/e2e/rtx-video.mjs [url] [outDir]          # Upscale → Video's "Quick · RTX" on an RTX, an AMD and an unknown card (the GPU check stubbed in the browser), FPS boost and SDR to HDR opening on their RTX choice
node tests/e2e/regenerate-more.mjs [url] [outDir]    # Faceless's "Regenerate to 1080p", Enhance in Shorts and Edit video, Cinema's 2K tier for MiniMax H3 and "Finish in 2K"
node tests/e2e/speech-edit.mjs [url] [outDir]        # Audio → Edit speech: a recording transcribed, a line changed, the price and the run, "How it sounds", the cloud engine's note, Captions' "Fix this line"
node tests/e2e/splat-viewer.mjs [url] [--shots=dir]  # splats on Image to 3D's cards and in the Library's 3D tab: the viewer's keyboard controls, Hide faint haze, and Spark fetched only when a splat opens
node tests/e2e/idol-final.mjs [url] [--shots=dir]    # "Build the final with TRELLIS.2" on an Idol 3D result, also on a second click of the same link
node tests/e2e/idol-views.mjs [url] [--shots=dir]    # "Make the other sides from the front (Idol 3D)" in Image to 3D and "Add side and back views" in Elements; no button on the cloud engine
node tests/e2e/make-3d.mjs [url] [--shots=dir]       # "Make it 3D (quick)" on a picture, which PR #16 leaves out for main's Make it 3D (see below)
node tests/e2e/cinema-props.mjs [url] [--shots=dir]  # Add a prop in Cinema's 3D scene: the prop in the filmed path (pixel checks), its handles and size, kept after a reload, the cloud's note; a few minutes on SwiftShader
node tests/e2e/cinema-world.mjs [url] [--shots=dir]  # World mode: the opening, a turn with a camera move, the path preview, Export of two turns, the cloud engine's note
node tests/e2e/worldcast.mjs [url] [--shots=dir]     # the WorldCast worker URL in Settings against a stand-in worker, then Fly around and Turnaround with it and without it
node tests/e2e/moss-sheets.mjs [url]                 # Storyboard's One sheet and Layers' Re-render from layers
```

`layers.mjs` and `cinema-scene.mjs` expect their open-engine step to run in demo mode: with a reachable ComfyUI they fail (demo stills are SVG placeholders ComfyUI can't read, and Layers needs the Qwen-Image-Layered weights). `cinema-original.mjs`, `genjutsu-original.mjs`, `character-swap-studio.mjs`, `mixed-shorts-original.mjs`, `marketing-originals.mjs`, `popcorn-evolution.mjs`, `skills-run.mjs` and `skills-builder.mjs` also expect demo mode with ComfyUI unreachable (`popcorn-evolution.mjs` Ollama too); `open-tools.mjs` reads whether the app reaches a ComfyUI and expects the matching open-engine price, and with any string as `FAL_KEY` shows fal's prices (nothing is sent). Since PR #13 a ComfyUI port that accepts connections counts as reachable at first, so for them point `COMFYUI_URL` at a closed port, such as `http://127.0.0.1:1`. The four new ones check each page at 1440 and 390 px, light and dark. `split-soundtrack.mjs` (without `--live`), `cinema-path.mjs` and `turnaround.mjs` expect demo mode with ComfyUI unreachable; `split-soundtrack.mjs --live` instead runs real splits on a ComfyUI with ComfyUI-DBS and its weights (about half a minute for its 6 s clip on a CPU). `moss-image.mjs` expects the hosted price, so start the app with `FAL_KEY=anything` (nothing is sent: Generate is never pressed), and "Free" on your GPU, which needs a reachable ComfyUI. PR #16's 14 checks (from `kandinsky6.mjs` on) expect demo mode with ComfyUI unreachable, and each checks its pages at 1440 and 390 px, light and dark (Layers' Re-render in `moss-sheets.mjs` at 1440 px only, as the editor is desktop only); `worldcast.mjs` also needs `FUOBE_ENGINE_MODE=open`, and starts its own stand-in worker. `kandinsky6.mjs` checks fal's prices only when `FAL_KEY` is set for both the app and the check (any string: nothing is sent). `rtx-video.mjs` and `regenerate-more.mjs` target buttons that are hidden while Regenerate on your GPU is held, and `make-3d.mjs` expects "Make it 3D (quick)", which PR #16 left out for main's Make it 3D (it opens Photo to 3D). None of the 14 is in `verify.sh`'s list yet: it names them as "not in verify.sh" in its summary.

## Evaluation harness

The Fuobe Originals evaluation harness (see [`scripts/eval/README.md`](../scripts/eval/README.md); `fuobe eval <command>` does the same from a checkout). `eval:run` needs a running Fuobe:

```bash
pnpm eval:validate                             # check every case file, and that the generated suites match the research
pnpm eval:run --suite selftest --engine demo   # about 30 s, free: submit, wait, download, score, report
pnpm eval:setup                                # the metrics venv (needs uv; CPU torch by default)
pnpm eval:review latest                        # rate a run's pairs blind, with the keyboard
pnpm eval:compare latest~1 latest              # wins, losses and mean gain per metric; exits 1 when a guarded metric regresses
pnpm eval:promote latest                       # does the recipe win? A person changes the default, in a reviewed commit
pnpm eval:covers <runId>                       # a run's promoted renders become the cards' covers (needs ffmpeg)
pnpm eval:covers --from-masters <dir> --run <name>   # rendered masters (<dir>/<preset id>/clip.mp4 or start.png) become covers, merged with the others
node tests/e2e/eval-review.mjs                 # the report and blind review pages at 1440 and 390 px, light and dark (no app needed)
pnpm eval:setup --asr                          # also Whisper base.en, for the separation suite's word error rate (optional)
python3 -I scripts/eval/fixtures/make-separation.py --speech <folder> --speech-licence "<source, licence>"   # the separation suite's test mixes, every stem known
pnpm eval:run --suite separation --engine open --variants bsrnn-mono,bsrnn-stereo,tiger-mono,tiger-stereo   # DBS on your ComfyUI (a CPU is enough)
pnpm eval:run --suite splat --engine open --variants idol-best,idol-quick,triposplat-today,idol-photo-crop --dry-run   # Idol 3D against TripoSplat; a real run needs an 8–16 GB GPU
```

PR #16 adds four suites. `separation` scores Split soundtrack, Remove dialogue, Clean up dialogue and the dub's voice split against mixes whose stems are known; its blind review plays the stems. `splat` (Idol 3D against TripoSplat, scored on the orbit video plus a haze metric read from the splat file), `mesh` (Idol 3D quick mesh) and `idol-views` (Idol 3D's other sides) need a GPU and your own pictures in `scripts/eval/local/`; their demo runs decide nothing. The rules each suite decides by are in [`scripts/eval/README.md`](../scripts/eval/README.md).

## Where things are

- `docs/ARCHITECTURE.md` — how requests flow from the composer to providers and back, pipelines, live updates, security, each studio's modules
- `docs/cli.md` — the `fuobe` command line: install, sign in, every command (`fuobe eval` included), MCP and skills for other agents
- `docs/research/` — the research this is built on (Higgsfield inventory, studios, image studios, marketing and agents, API, round-4 changes, in-house products; paid model APIs parts 1–4; ComfyUI equivalents parts 1–4; workflow library; the round-4 UX and speed audit; open recipes for Fuobe Originals; Openjutsu and Akatz Labs' H3 Character Swap; new models (Open-H3-Regenerate-2K, WorldCast, MOSS-Image Layout; then, as of 2026-11-01, Kandinsky 6.0, Pika H3 Flex, NVIDIA RTX Video, CorridorKey 2.0, VRMBG 3.0, AuK and Hy-Nomas), DBS soundtrack separation, Work2Skill, accounts (dropped for the owner's public sign-up, kept as background), Idol (one picture to a 3D splat) and Hi3D mesh refinement; which of their build plans are built and which are queued is in `docs/HANDOFF.md` and `docs/handoff/queue.json`; Liner UI language); [`docs/research/README.md`](research/README.md) says what each file covers
- `docs/HANDOFF.md` and `docs/handoff/` — how the build continues (HANDOFF's "Waiting on the owner" and "What's left" sections are of 11-04; its opening sections still describe 10-30): where things stand, the owner's rules and decisions, the queue of packages with their briefs (`queue.json`), how to run a package's stages, and how to check and describe a PR (`verify.sh`, `pr-describe.js`, `pr-docs.js`)
- `docs/workers/tribe-v2.md` — the optional, non-commercial TRIBE v2 worker contract for the Virality predictor
- `docs/workers/worldcast.md` and `workers/worldcast/` — the optional WorldCast worker: how Fuobe prepares a case, and a reference server to start on your own 48 GB+ GPU
- `scripts/comfy/` — the pipeline that exports and validates the ComfyUI workflow library
- `scripts/eval/` — the Fuobe Originals evaluation harness: suites, metrics, blind review and the promote rule
- `scripts/train/` — the training kit for Fuobe's own LoRAs: 13 job specs, their data-licence logs and `kit.mjs` (configs, fal requests and Hugging Face publishing; nothing is trained yet)
- `skills/` — Assist's built-in skills (`<name>/SKILL.md` in the Agent Skills format: name, description and compatibility, with Fuobe's own fields under `metadata`: title, when_to_use, icon, studio, tags, offline hints); a skill of your own can also carry a `recipe.json` that lets it run by itself (see [`skills/README.md`](../skills/README.md)); `.agents/skills/fuobe/` teaches another agent to drive Fuobe through MCP or the CLI

## Tech

Next.js 16 (App Router, Cache Components) · React 19 · Tailwind CSS v4 · shadcn/ui (Radix) · TanStack Query · SQLite (better-sqlite3) · zod · fal.ai queue API · Replicate predictions API · ComfyUI HTTP + WebSocket API · Anthropic SDK (Claude) · Ollama, LM Studio, Unsloth Studio and OpenAI-compatible chat APIs · @xyflow/react (Canvas) · @google/model-viewer + three (3D) · Spark (`@sparkjsdev/spark`, the splat viewer) · glTF Transform + meshoptimizer + sharp (the server's GLB finish) · headless Chromium through playwright-core (the CPU turntable) · unpdf (PDF text) · cmdk · WebGL · server-sent events · Vitest · Playwright · Python with uv (the evaluation harness's metrics).

## Contributing

Issues and pull requests are welcome. Before you open a pull request, run `pnpm typecheck && pnpm lint && pnpm test`, and run the browser checks for the pages you changed. Keep each pull request to one change, and say in its description what you checked.
