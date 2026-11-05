# Training Fuobe's own LoRAs

This kit covers everything up to the training run for the LoRAs Fuobe trains itself (research §6, build plan O12), and for
the motion library. **None of these LoRAs has been trained yet.** Each one is a *planned* entry in the LoRA library
(`PLANNED_LORAS` in `src/lib/catalog/lora-library.generated.ts`), and no preset uses it until its file is published.

| Where | What |
|---|---|
| `specs/<id>.json` | The job spec: dataset size and caption rules, steps, rank, learning rate, trigger, the fal trainer and the AI-Toolkit model, and the file it becomes |
| `data-logs/<id>.json` | The data-licence log: every image or clip, where it comes from, its licence or proof of ownership, and a release wherever people appear |
| `src/lib/catalog/motion-library.json` | The motion library: driving clips for the 13 sports moves |
| `src/lib/training-kit.ts` | The checks and the configs (pure logic, tested in `tests/training-kit.test.ts`) |
| `kit.mjs` | The command line |

## The LoRAs

First wave: `fuobe-soul-core`, `fuobe-cctv`, `fuobe-ultrawide-05`. Then the Wan 2.2 I2V motion LoRAs: `fuobe-push-in`
(Eyes In, Mouth In, Eating Zoom), `fuobe-timelapse` and `fuobe-drone-reveal`. The other seven §6 looks have specs too.
`node scripts/train/kit.mjs list` shows each one with its log count and its fal price.

`fuobe-beauty-details` stands for four small concept LoRAs (grillz, bleached brows, long legs, creatures). Copy its spec
once per concept and add each concept to the research's `fuobeTrainedLoras` before the first run.

## 1. Collect the data and log it

Train only on what Fuobe shot itself, licensed with AI-training rights, or took from CC0 or public-domain sources.
Never use another service's generated outputs, preview media or prompts (research §2). They fit none of the four sources the checker accepts.

Put the dataset in one folder: `001.jpg` with its caption `001.txt` (clips: `001.mp4` with `001.txt`). Follow the caption
rules in the spec, and put the trigger where the rules say. Then fill in `data-logs/<id>.json`:

```json
{
  "lora": "fuobe-cctv",
  "version": 1,
  "reviewedBy": "who checked the log against the files",
  "reviewedAt": "2026-11-20",
  "items": [
    {
      "file": "001.jpg",
      "sha256": "…64 hex…",
      "source": "own-shoot",
      "licence": "Fuobe's own",
      "proof": "call sheet 2026-11-12, raw folder cctv/2026-11-12",
      "author": "who shot it",
      "date": "2026-11-12",
      "people": true,
      "consent": { "form": "release-2026-11-12-03", "date": "2026-11-12", "scope": ["ai-training"], "adults": true }
    }
  ]
}
```

- `source` is one of `own-shoot`, `licensed`, `cc0` or `public-domain`. A `licensed` file also needs `"aiTraining": true`,
  and only when its licence actually says it allows training.
- `people: true` needs a signed release from each person that covers AI training, from adults only. Keep the release
  forms themselves outside the repository. The log only names them. If the release references must stay private, keep
  the log elsewhere and point `FUOBE_TRAIN_LOGS` at that folder.

Check the log against the folder:

```bash
node scripts/train/kit.mjs check fuobe-cctv --dataset ~/datasets/fuobe-cctv
```

The check fails when the log has fewer or more files than the spec allows, when an entry is incomplete, when a file is in
the folder but not in the log (or the other way round), when a file changed after it was logged (its SHA256), when a
file's caption is missing, empty or without the trigger, or when the folder holds anything else (another kind of file,
such as a `.mkv` clip or a still in a clip dataset, which the trainer would read too, or a sub-folder). A job does not
start while any of these fails.

## 2. Make the job

```bash
node scripts/train/kit.mjs job fuobe-cctv --dataset ~/datasets/fuobe-cctv
# upload .train/fuobe-cctv/fuobe-cctv.dataset.zip, then:
node scripts/train/kit.mjs job fuobe-cctv --dataset ~/datasets/fuobe-cctv --zip-url https://…/fuobe-cctv.dataset.zip
```

This writes these files to `.train/fuobe-cctv/`, which git ignores:

- `fuobe-cctv.aitk.json`: the AI-Toolkit job for your own GPU (free). Run it with `python run.py <file>` in an
  [ostris/ai-toolkit](https://github.com/ostris/ai-toolkit) checkout. Z-Image Turbo trains with ostris's training
  adapter v2 (every Z-Image spec trains on Turbo here); Z-Image base and Wan 2.2 I2V 14B use AI-Toolkit's own defaults for those models (4-bit Wan with its
  accuracy recovery adapter, both experts). Wan 2.2 14B needs a 24 GB card.
- `fuobe-cctv.dataset.zip`: exactly the checked files (the logged images or clips and their captions), for the fal
  trainer. Upload it anywhere fal can read and pass its URL as `--zip-url`.
- `fuobe-cctv.fal.json` (with `--zip-url`): the request for the fal trainer, with only the fields that trainer's schema
  has (`trainers.generated.ts`, from the research), and the zip's SHA256. The kit downloads the URL first and writes
  the request only when it is the zip it built, byte for byte. fal bills per step. `kit.mjs list` shows the price.

The kit does not submit anything: that takes a GPU or a fal key, and a person deciding to spend it.

Notes to check on the first run:
- fal's `fal-ai/z-image-trainer` trains on Z-Image base. Whether a base-trained LoRA behaves the same on Z-Image Turbo
  (the model Soul runs on) is unverified, so compare it with the AI-Toolkit run, which trains on Turbo.
- fal's Wan 2.2 I2V trainer returns one file. Whether loading it on both experts works as intended is unverified.

## 3. Publish the file

Trained files go to Fuobe's Hugging Face organisation (`fuobe` by default; set `--org` or `FUOBE_HF_ORG` to change it),
one model repo per LoRA, with the public half of the data-licence log next to the file. The public half keeps each
file's hash, source, licence and date, and says a release exists, but leaves out the release reference, the proof and
the author (receipts, contracts, call sheets, people's names). A CC0 or public-domain original keeps its public page and
author as a credit.

```bash
node scripts/train/kit.mjs publish fuobe-cctv --file output/fuobe-cctv/fuobe-cctv.safetensors --route ai-toolkit   # dry run
HF_TOKEN=… node scripts/train/kit.mjs publish fuobe-cctv --file … --route ai-toolkit --upload --write-research     # publish
pnpm gen:catalog
```

`--route` says which trainer made the file (`fal` or `ai-toolkit`). The model card's `base_model` is the Hugging Face
repo that route trained on: `Tongyi-MAI/Z-Image` (fal's `z-image-trainer`), `Tongyi-MAI/Z-Image-Turbo` (fal's Turbo
trainer, AI-Toolkit's `zimage:turbo`) or `Wan-AI/Wan2.2-I2V-A14B`.

The licence is recorded, not assumed. Data that is all Fuobe's own, CC0 or public domain defaults to Apache-2.0 (the
base models' licence), outputs may be sold and hosts may run it. With any `licensed` file in the log, say all three:
`--licence <spdx id or name> --commercial yes|no --hosted-ok yes|no`, as the stock licence allows. Either way the
snapshot names the data's sources and licences, and that is what Settings → Models & licences shows.

A dry run uploads nothing. It prints what would be uploaded and the `trained` block for the research entry. `--upload`
needs a write token and the `hf` command (`pip install huggingface_hub`). It uploads the file, `data-licence-log.json`
and a model card, then reads the commit the upload made. `--write-research` writes the `trained` block into
`docs/research/fuobe-originals-recipes-5.json` (`fuobeTrainedLoras[<id>].trained`).

After that, `pnpm gen:catalog` (`scripts/gen-lora-library.py`) moves the entry from `PLANNED_LORAS` into `LORA_LIBRARY`.
The entry is pinned to that commit and SHA256, carries its licence snapshot, and downloads like any other library LoRA
(`src/server/loras.ts`). Only then can a preset use it. Point the preset's LoRA at it in the research, regenerate, and
let the evaluation harness (`scripts/eval`) compare it with the current recipe before it becomes a default.

## The motion library

The 13 sports moves (Baseball Kick … Snowboard Powder) work better as motion transfer than as a LoRA. Each move needs
a short driving clip (2–10 s, at least 480 px) that is CC0, public domain or shot by Fuobe, with the same licence fields
as a data-licence log entry (a release where people appear). Add clips to `src/lib/catalog/motion-library.json`
under the move:

```json
{ "url": "https://huggingface.co/fuobe/motion-library/resolve/<commit>/boxing-01.mp4", "sha256": "…", "seconds": 5, "fps": 24,
  "width": 1080, "height": 1920, "source": "own-shoot", "licence": "Fuobe's own", "proof": "…", "author": "…",
  "date": "2026-11-20", "people": true, "consent": { "form": "…", "date": "…", "scope": ["ai-training"], "adults": true } }
```

`node scripts/train/kit.mjs motions` checks them. `motionLibraryClip(presetId)` in `src/lib/training-kit.ts` returns a
move's first clip that passes. Until a move has one, it keeps its current route (Fuobe DoP on the move's words). The
step that runs a move from its clip (Fuobe Genjutsu motion transfer, `maker` in the manifest) is not wired yet.
