# scripts/comfy — Fuobe ComfyUI workflow pipeline

Produces the API-format workflow library in `workflows/comfyui/` (one `<id>.json` per workflow,
`manifest.json`, `object_info.subset.json`) from official ComfyUI templates, custom-node example
workflows and a few hand-built graphs, and validates every workflow against a real ComfyUI server.
No GPU and no model weights are needed (validation uses zero-byte placeholder model files).

Full write-up (what is in the library, validation results, models, quirks for app code):
[`docs/research/comfyui-workflow-library.md`](../../docs/research/comfyui-workflow-library.md).

## Files

| file | purpose |
|---|---|
| `install-comfyui.sh` | reproducible CPU install of ComfyUI + its custom node packs (pinned commits; `workflows/comfyui/packs.json` pins all 52 the library uses; Chatterbox, IndexTTS2 and Video-Depth-Anything added for the comfyui-oss-2 workflows — IndexTTS2's runtime deps only with `INDEXTTS_RUNTIME=1`; MelBandRoFormer, QwenASR and HunyuanVideo-Foley for comfyui-oss-3; ToSVG (VTracer) in round 4). Licences are information: the non-commercial ComfyUI-Whisper (CC-BY-NC-SA-4.0, only for `captions-whisper-burnin`) is installed too, and `NC_PACKS=0` leaves it out (Settings → Models & licences has a switch per node pack). Round 4 part 4 adds Akatz Labs' GPL-3.0 `h3_character_swap` for Genjutsu's Character swap (`H3_PACK=0` leaves it out; it needs `ffmpeg` and `ffprobe`), and H3 Relay 2.0 with `H3_RELAY=1` (the Relay swap, H3 Person Removal and, since round 4 part 5, the Character Swap Studio's two graphs). DBS D1 adds ComfyUI-DBS and its 23 MB of weights (`DBS_WEIGHTS=0` skips the weights). PR #16 adds ComfyUI-CorridorKey2, ComfyUI-Idol, ComfyUI-HyNomas and Kandinsky Lab's `kandinsky6` and `kandinsky6-sr` (`K6_PACKS=0` leaves those two out), the NVIDIA VFX nodes on an x86_64 machine whose `nvidia-smi` names an RTX card (`RTX_VIDEO=1` forces them, `RTX_VIDEO=0` skips them), and, on request, Hi3D (`HI3D=1`) and Tencent AuK (`AUK=1`); ComfyUI-RMBG moves to 3.3.0 (`a66a5e64`) |
| `install-isolated-worker.sh` | a second ComfyUI with its own code copy, base directory, `HOME` and virtualenv for LatentSync 1.6 and ThinkSound (below) |
| `start-comfyui.sh` / `stop-comfyui.sh` | run ComfyUI in the background on 127.0.0.1:8188 (log: `$COMFYUI_DIR/logs/comfyui.log`) |
| `export-templates.mjs` | Playwright: opens the ComfyUI frontend, `app.loadGraphData(ui)` → `app.graphToPrompt().output`, writes `build/raw/<key>.api.json` + `.meta.json` (embedded model URLs, missing node types) |
| `library.spec.mjs` | the curated list: id, title, capability, source, transforms, bindings, outputs, limits, VRAM, notes |
| `lib/graph.mjs` | API-graph transforms (resolve constant switches, set/delete inputs, insert nodes, prune, lint) |
| `hand-built/*.json` | API-format graphs written by hand from `/object_info` definitions (incl. the 20 comfyui-oss-2 workflows, transcribed from the live-validated graphs in `docs/research/comfyui-oss-2.json`) |
| `build-library.mjs` | spec + raw exports → `workflows/comfyui/<id>.json` + `manifest.json` (models, sizes via Hugging Face, custom-node packs, defaults) |
| `validate-workflows.mjs` | POSTs every workflow (bindings filled with sample values) to `/prompt`, requires HTTP 200 + `prompt_id` + no `node_errors`, then deletes it from the queue before it can run (a KJNodes `Sleep` "blocker" prompt keeps the worker busy meanwhile; final `POST /queue {"clear":true}` + `POST /interrupt`); updates `manifest.json`, `validation-state.json`, writes `object_info.subset.json` |
| `fixtures/` | tiny png / mask / wav / mp4 uploaded during validation |
| `validation-state.json` | sha256 of each validated workflow file → lets `build` keep `validated: true` when a file is unchanged |

## Exact commands used (2026-10-16, Linux, Python 3.13, Node 22, CPU only)

```bash
# 1. ComfyUI (outside the repo)
git clone https://github.com/comfyanonymous/ComfyUI /home/user/ComfyUI        # HEAD fc04da91 = v0.41.0-7
cd /home/user/ComfyUI
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python -r requirements.txt   # comfyui-frontend-package 1.55.17, comfyui-workflow-templates 0.11.86

# 2. custom node packs (git clone --depth 1 into custom_nodes/) + their deps — see install-comfyui.sh
#    (the script does all of 1+2 with pinned commits:  bash scripts/comfy/install-comfyui.sh)

# 3. start (background) — equivalent to: cd /home/user/ComfyUI && .venv/bin/python main.py --cpu --listen 127.0.0.1 --port 8188
bash scripts/comfy/start-comfyui.sh
curl -s http://127.0.0.1:8188/object_info | head -c 100

# 4. pipeline
cd scripts/comfy
npm install                      # playwright-core only; uses the preinstalled Chromium in /opt/pw-browsers
npm run export                   # all template/example sources referenced by library.spec.mjs
npm run build                    # needs outbound HTTPS to huggingface.co for model sizes (NODE_USE_ENV_PROXY=1 is set in the script)
npm run validate                 # needs ComfyUI running; never runs a model
# or: npm run all
```

Single items: `node export-templates.mjs video_wan2_2_14B_i2v`, `npm run build -- wan22-i2v-14b`,
`node validate-workflows.mjs wan22-i2v-14b`. `--shared` skips the final global queue clear/interrupt.
`node validate-workflows.mjs --keep-dummies` keeps the
zero-byte model placeholders (by default they are deleted after the run; real model files are never touched,
so the validator is safe to point at a real GPU server via `COMFYUI_URL` + `COMFYUI_DIR`/`COMFYUI_MODELS_DIR`).

Environment variables: `COMFYUI_URL` (default `http://127.0.0.1:8188`), `COMFYUI_DIR` (default `/home/user/ComfyUI`),
`COMFYUI_MODELS_DIR`, `CHROMIUM_PATH` (default: newest `/opt/pw-browsers/chromium-*/chrome-linux/chrome`).

**Always pass ids to `npm run build` in a checkout without `build/raw/`** (a fresh clone has none): entries
whose raw template export is missing are skipped, and the manifest is then rewritten without them. Hand-built
entries need no export. After a build, diff `manifest.json`: untouched ids must be byte-identical.

## Round-3 workflows (comfyui-oss-3, 2026-10-17)

31 entries from `docs/research/comfyui-oss-3.json` (29 researched graphs + `video-mux-audio-replace` +
`captions-burnin`), all hand-built, all `validated: true`:

```bash
npm run build -- <ids>                 # the 29 main-server ids of the "comfyui-oss-3" section of library.spec.mjs
node validate-workflows.mjs <ids>
```

- **Changes from the research graphs**: `captions-qwen3-asr` and `dub-prepare-separate-transcribe` read the speech
  with `LoadAudio` (it decodes the soundtrack of a video upload too, without decoding frames), so they take audio or
  video. Binding names follow Fuobe's canonical inputs (`startTime`, `numLayers`, `sourceLanguage`, `paletteImage`…,
  documented in the header of `library.spec.mjs`). The TRELLIS.2 graph's pass-through `PreviewImage` nodes are linked
  around by the build (they would otherwise write 4096² textures to `temp/` on every run).
- **`captions-burnin`** is Fuobe's own caption burn-in, core nodes only, built so memory does not grow with the
  clip: gaps between captions go to `Concatenate Video` as `Trim Video` windows (never decoded); captioned stretches
  are cut into chunks of at most ~384 MB of frames, and each chunk is decoded, gets a `Draw Text Overlay` and is
  encoded at once (`Create Video`, codec h264), so ComfyUI can drop its raw frames. `Concatenate Video` joins
  everything with the clip's own soundtrack (`LoadAudio`, dropped for silent clips). The library file holds a
  one-chunk + one-gap example; the provider rewrites it per request (`expand: "captions"`, `expandCaptionWorkflow()`
  in `src/lib/comfy.ts`) from what the upload's MP4 header says (duration, fps, size, audio). Every window holds at
  least 3 frames (`Concatenate Video` rejects a 2-frame clip followed by another one). Under RAM pressure
  (`--cache-ram 11` on the CPU box) a 20 s 640x360 30 fps clip with 18 s of captions peaks at +0.50 GB RSS and a 40 s
  one at +0.45 GB — the earlier one-batch graph needed +5.16 GB for the 20 s clip and grew with the length. Without
  pressure ComfyUI's RAM cache simply keeps the finished chunks (+2.64 GB for 20 s) until memory runs low.
- **`video-mux-audio` / `-replace`** put the new soundtrack on with `Concatenate Video` (`complete_audio`): the video
  stream is copied packet by packet (bit-identical, no decode), only the AAC soundtrack is encoded. The two-track
  graph mixes voice and background over `EmptyAudio` of the video's length (`AudioMerge` cuts its second track to
  the first one's length). A 900-frame clip muxes in ~5 s at +0.02 GB RSS.
- **`captions-whisper-burnin`** decodes the whole clip (VHS) and needs ComfyUI-Whisper (non-commercial code, installed unless `NC_PACKS=0`); the provider
  refuses clips that would need more than half the server's RAM and points to the chunked route.
- **New entry fields**: `worker: "isolated"` (below), `expand`, and on outputs `stem` (`voice` | `background`) and
  `role` (`cues`, `transcript`, `language`, `sheet`, `tiles`, `layers`, `first-frame`, `turntable`).

### Isolated worker (LatentSync 1.6, ThinkSound)

`lipsync-latentsync16` and `sfx-thinksound` are optional and never defaults. Their packs change process-wide state
(LatentSync overrides `TMPDIR` and `folder_paths` temp handling at import, `rmtree()`s a `temp` folder next to the
ComfyUI directory and pip-installs packages into whatever interpreter runs it when its node is created) or pin old
packages (ThinkSound's `requirements.txt` downgrades einops, PyWavelets, k-diffusion; LatentSync's runtime needs
mediapipe, which pins `protobuf<5`). So the worker gets **its own code copy, base directory, `HOME` and
virtualenv** — nothing is installed into the main ComfyUI's venv:

```bash
ISO_DIR=/srv/comfyui-isolated scripts/comfy/install-isolated-worker.sh
#  - copies ComfyUI's *code* only (tar with models/, input/, output/, user/, custom_nodes/ and .venv excluded —
#    never `cp -r` the whole install, models/ can be hundreds of GB)
#  - creates $ISO_DIR/.venv (Python 3.11: ThinkSound pins PyWavelets 1.4.1, which has no newer wheels), installs torch
#    (TORCH_INDEX=https://download.pytorch.org/whl/cu128 on a GPU server), ComfyUI's requirements, the two packs and
#    VHS + KJNodes at the pinned commits, ThinkSound's requirements and LatentSync's runtime deps — into that venv
#  - writes extra_model_paths.yaml so the worker reads the main install's model folders (shared, not copied)
cd /srv/comfyui-isolated/ComfyUI && HOME=/srv/comfyui-isolated/home /srv/comfyui-isolated/.venv/bin/python main.py --listen 127.0.0.1 --port 8189
```

Then set **Settings → Open-source engine · ComfyUI → Isolated worker URL** (or `COMFYUI_ISOLATED_URL`) to
`http://127.0.0.1:8189`: Fuobe sends these two workflows, their uploads and their polls there, and everything else
to the main ComfyUI (the Lipsync studio offers LatentSync 1.6 and Audio → Sound effects offers ThinkSound, marked
"Runs on the isolated ComfyUI worker"; without the setting, or when the worker doesn't answer, the job fails with a
message that names the setting). Build and validate them against that server (placeholder models go into the shared
main `models/` folder the worker reads):

```bash
COMFYUI_URL=http://127.0.0.1:8189 npm run build -- lipsync-latentsync16 sfx-thinksound
COMFYUI_URL=http://127.0.0.1:8189 COMFYUI_MODELS_DIR=/home/user/ComfyUI/models node validate-workflows.mjs lipsync-latentsync16 sfx-thinksound --shared
node validate-workflows.mjs video-trim     # then once on the main server, so object_info.subset.json comes from it
```

`validate-workflows.mjs` keeps the subset definitions of classes the current server lacks, so validating on either
server never drops the other's classes.

## Round-4 workflows (comfyui-oss-4, 2026-10-22)

17 hand-built entries from `docs/research/comfyui-oss-4.json` (the 14 researched graphs and the critic's 3), in the
"comfyui-oss-4" section of `library.spec.mjs`, all `validated: true` (132/132 in the manifest). No new node pack and no
worker: core nodes plus KJNodes' `GrowMaskWithBlur` and VHS's audio loader / `VHS_VideoCombine` / `VHS_LoadVideo`.
`capability` is the round-4 operation each one serves.

```bash
npm run build -- <the 17 ids>          # hand-built: no export needed
node export-templates.mjs video_wan_vace_14B_ref2v && npm run build -- wan21-vace-14b-ref2v
node validate-workflows.mjs <ids> wan21-vace-14b-ref2v --shared
```

| id | capability | what | ran for real here |
|---|---|---|---|
| `ocr-lines-qwen35` | ocr | text lines + boxes (OvisOCR3 0.8B, core `TextGenerate`) | research only (161-194 s per poster on CPU) |
| `video-inpaint-wan-vace` | remove-object | SAM 3.1 tracks `maskPrompt`, Wan 2.1 VACE 14B + lightx2v fills, pasted into the original frames | window + sound sub-path only |
| `video-inpaint-wan-vace-painted` | remove-object | same, the object painted on the first frame (`mask`) | no (GPU) |
| `video-erase-void` | remove-object | Netflix VOID, removes the object's shadows / reflections too (CogVideoX licence) | no (GPU) |
| `video-swap-wan-vace` | video-swap | tracked object replaced by a reference `image` | no (GPU) |
| `video-insert-wan-vace` | video-insert | reference `image` placed in a painted region (`mask`) | no (GPU) |
| `kenburns-still` | still-motion | pan + zoom over a still, core loops, chunk-encoded | yes: 2 s 320x180 25 fps in 7.6-11.2 s |
| `audio-loop-crossfade` | audio-loop | loop a bed to `duration` with equal-power seams | yes: 3 s → 10 s FLAC in 1.1-2.5 s, seams click-free |
| `audio-join-crossfade` | audio-join | two clips, `crossfade` seconds of overlap | yes: 3 s + 2 s → 4.5 s in 0.2-2.1 s |
| `video-export-pro` | export-video | ProRes HQ / 4444, H.265 10-bit, FFV1, H.264 (VHS) | yes: all five formats, ffprobe-checked |
| `video-sdr-to-hdr` | sdr-to-hdr | core `ImageSDRToHDR` → BT.2020 HLG 10-bit H.264 | yes: High 10, arib-std-b67 |
| `video-export-exr` | export-video | half-float scene-linear EXR per frame | yes: 16 frames → 16 `.exr` |
| `still-to-clip` | still-motion | a still held N s with a silent track | yes: 50 frames + AAC silence |
| `video-append-endcard` | concat | ad + end card, ad picture stream-copied, ad sound kept | yes: bit-identical ad frames, silence from 2.00 s; foreign H.264 fails (known limit) |
| `scene-mesh-moge` | scene-3d | whole-scene textured GLB + depth PNG (MoGe 2) | research only (42 s on CPU) |
| `image-to-splat-triposplat` | splat | subject Gaussian splat (`.spz`) + orbit MP4 (TripoSplat) | no |
| `image-to-splat-idol` | splat | one object as a Gaussian splat (`.spz`) + orbit MP4 (Idol 3D on the TripoSplat core nodes; Best / Quick look, looser photo crop) | no |
| `image-to-splat-idol-clean` | splat | the same with the ComfyUI-Idol pack: Idol's own crop (synthetic / real), the saved splat pruned of its haze (and optional spikes), the input-view still; not `/prompt`-checked with the pack yet (checked through `PACK_CLASSES`) | no |
| `image-to-mesh-idol` | image-to-3d | one object as a rough vertex-coloured GLB (Idol 3D's splat → core Extract Mesh from Splat, 384 grid, no textures) + orbit MP4 | no |
| `image-to-views-idol` | splat | four views of one object from one picture (front, left, back, right: the pruned Idol splat rendered from IdolCamera's predicted camera, 90° apart) for From several images and Elements; needs the ComfyUI-Idol pack. It passed `/prompt` on the CPU validation server once that had the pack, and stays unvalidated until a GPU run | no |
| `reference-brief-gemma4` | write | reference clip's frames + sound → JSON style brief (Gemma 4 E4B) | no |

- **Changes from the research graphs** (each also in the entry's notes): the painted / insert masks are read from the
  **red channel** (white = erase / the region, Fuobe's mask convention since `flux1-fill-inpaint`), not alpha; Ken Burns
  gained `easeInOut` (1 = the research's ease in-out, 0 = linear) for `params.easing`; both audio graphs name the
  crossfade curve upload `fadeCurve` (the research used `audio2` / `audio3`, which the provider fills with user audio);
  the brief binds `frames` / `startFrame` (canonical keys) and `frameWidth` (a canonical `width` would be resized by the
  provider) plus `seed`; TripoSplat's `seed` drives both the sampler and the decoder; outputs use kind `model3d`.
  The four VACE graphs and VOID take their window in **seconds** (`startTime`, `duration`): core `Video Slice` decodes
  only the window (at most 81 / 197 frames + half a frame at the clip's fps, read from a 0.1 s probe slice), the graph
  keeps the largest 4n+1 / 8n+5 frames it decoded and trims the sound to exactly those frames; `width` × `height` is a
  work-size budget the graph renders in the clip's own shape (scaled, never cropped, so the VACE paste-back lines up).
  The research graphs decoded the whole clip as float32 before cutting the window (`startFrame` / `frames`) and
  centre-cropped to `width` × `height`. MoGe resizes on the longer edge (the research tested the width only).
- **What the provider has to do** (feature packages): write the crossfade curve (a stereo WAV exactly `crossfade` seconds
  long, left = sin(π/2·t), right = cos(π/2·t), 8 kHz) and upload it as `fadeCurve`; parse the OCR JSON (strip fences,
  `bbox`/`text` or `bbox_2d`/`text_content`, boxes relative 0–1000); run VACE / VOID windows (`startTime` = k × 81 / fps,
  `duration` = 81 / fps; VOID 197; fps from the clip's header, `duration` 0 = the longest window) and join them; map Ken
  Burns and export params; set `meta.format` on the splat (and a content type for `.ksplat`, `.mkv` and `.exr`, which
  `storage.ts` has no extension for: they would be saved as `.bin`); for a silent ad
  drop nodes 2, 12 and 13 of the end card and node 14's `complete_audio` (`LoadAudio` stops on a clip with no sound),
  and fall back to `still-to-clip` + `video-concat-sound1-2` for clips other encoders made.
- **Build**: `OpticalFlowLoader` (folder `optical_flow`) and `LoadMoGeModel` (`geometry_estimation`) are known loaders;
  `KNOWN_MODELS` has the OvisOCR3, VACE, VOID, MoGe and TripoSplat files and the alternative checkpoints (Qwen3.5 0.8B / 2B,
  VACE 1.3B, MoGe 3). OvisOCR3 (`model.safetensors`) and Qwen3.5 0.8B (`model.safetensors-00001-of-00001.safetensors`) are
  single files upstream: save them under the manifest names. VOID's `t5xxl_fp16` and TripoSplat's `flux2-vae` are
  byte-identical to the library's FLUX files (same sha256). New output roles: `lines`, `frame`, `frames`, `scene`, `depth`, `splat`, `brief` (typed in `src/lib/comfy.ts`).
- **Licence fix (R4-15)**: `wan21-vace-14b-ref2v` shipped the template's CausVid LoRA, which is CC-BY-NC-4.0. Its spec
  entry now swaps it (transforms on nodes 115 / 108 / 110) for the Apache-2.0 `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64`
  at 1.0 with the round-4 VACE settings (4 steps, cfg 1, euler, shift 5; clip strength 0) and binds `loraStrength`
  (0 + steps 20 + cfg 6 = full quality). Re-validated; the pairing is inferred, not GPU-tested.
- **Real runs** used the fixtures plus tiny generated tones / noise, on the shared CPU server (own prompt ids only; the
  test inputs and outputs were deleted afterwards), in two sessions; every output was checked with ffprobe (and
  framemd5, silencedetect or numpy where it matters). Timings are in each entry's notes. The window, sound and work-size
  nodes of the VACE and VOID graphs (taken from the built graphs, the model replaced by the work-size frames scaled back)
  ran on a 9:16 30 fps clip with sound (81 frames and 2.700 s of sound from 1 s, rendered at 464×832 and back, lined up
  with the source frames), a 1 s window (29 frames), a silent clip (no sound track, no error), a 25 fps clip through
  VOID (197 frames, 7.880 s of picture and of sound, 672×376) and a window at 50 s of a 60 s clip (0.6 s instead of
  2.6 s with the whole-clip decode). MoGe's guard ran on 1536×3000, 3000×1536 and 1024×768 stills.
- **The Idol rows** came later and aren't among the 17: `image-to-splat-idol` (idol-1, on main) and, from PR #16,
  `image-to-splat-idol-clean` (idol-2: the provider runs it when the server reports `IdolPruneSplat`, and
  `image-to-splat-idol` otherwise), `image-to-mesh-idol` (idol-7) and `image-to-views-idol` (idol-8). The two that use
  Nynxz's ComfyUI-Idol (Apache-2.0, pinned at `4d3a4f67`, installed by `install-comfyui.sh`, not in the Comfy Registry)
  are `validated: false`: `image-to-splat-idol-clean` was sent before the validation server had the pack (it answered
  `missing_node_type`) and not since, and `image-to-views-idol` passed `/prompt` once the server had it but stays
  unvalidated until a GPU run. `image-to-mesh-idol` uses core nodes only and is `validated: true`. None has run on a GPU.

### Round-4 video finishing (r4/video-finish, 2026-10-23)

Five hand-built entries for the Upscale hub's FPS Boost, SDR to HDR and Export modes and for R4-38 (open video
upscaling decoded the whole film: about 38 GB of float frames for 30 s at 480p). No new node pack: core nodes plus
VHS's `VHS_LoadVideo` meta-batch, `VHS_BatchManager`, `VHS_SelectEveryNthImage` and `VHS_VideoCombine`.
`video-sdr-to-hdr` also binds `colorSpace` (HLG, or `HDR PQ` for HDR10), and `video-export-exr` saves a preview clip.

```bash
npm run build -- interpolate-rife-fps upscale-video-esrgan-chunked upscale-video-seedvr2-chunked video-export-pro-chunked video-sdr-to-hdr-exr video-sdr-to-hdr video-export-exr
node validate-workflows.mjs <the same ids> --shared
```

| id | capability | what | ran for real here |
|---|---|---|---|
| `interpolate-rife-fps` | interpolate | FrameInterpolate by m, keep every n-th: source fps × m / n = target × slowdown; output fps computed in the graph | yes: 24 → 60, 25 → 30 at 2× slow, 30 → 24 |
| `upscale-video-esrgan-chunked` | upscale-video | Real-ESRGAN in passes of `framesPerBatch` frames, scaled to `shortSide`, one H.264 encode across passes | yes: 30 s 144p → 1080p, 47 passes, +0.87 GB RSS |
| `upscale-video-seedvr2-chunked` | upscale-video | SeedVR2 3B in passes of 4n+1 frames (no context across passes: a seam is possible) | no (GPU); /prompt only |
| `video-export-pro-chunked` | export-video | ProRes 422 HQ / 4444, H.265 10-bit, FFV1, H.264 in passes, with the sound | yes: ProRes, H.265, FFV1 |
| `video-sdr-to-hdr-exr` | sdr-to-hdr | scene-linear Rec.2020 half-float EXR per frame + an HLG preview | yes: 60 frames + preview |

- **What the provider does** (`src/server/providers/comfyui.ts`, `src/lib/av/fps.ts`, `src/lib/av/video-finish.ts`): m and n
  from the clip's header frame rate (the cheapest exact pair, the nearest one for 29.97-style rates); FrameInterpolate
  linked out when m is 1; slow motion drops the sound link; params.format → VHS format / ProRes profile, CreateVideo's
  colour space, or the EXR graphs; EXR frames zipped one at a time onto the preview clip (`meta.artifacts.exr`);
  `framesPerBatch` sized from the clip so a pass holds about 1.5 GB of frames; each job tags its `VHS_BatchManager`
  (ComfyUI otherwise reuses a cached manager after a failed meta-batch run and silently loses frames: 32 of 48 seen
  here); a silent clip loses the `VHS_LoadVideo` audio link (VHS fails on it); graphs that still decode the whole clip
  (FPS Boost, HDR, EXR) refuse a clip that needs more than half the server's RAM, and the composer checks the same rule
  before Generate (`/api/status` reports the ComfyUI's RAM). They hold 2 frame-sized float copies of the clip (decoding
  stacks the frames; the tone map makes one more; encoders and the EXR writer take a frame at a time), FPS Boost 2 + m
  (`VHS_SelectEveryNthImage` is a view): measured here, SDR to HDR on 10 s of 640×360 at 30 fps peaked 1.57 GB above idle,
  2.04 copies. FPS Boost needs the clip's frame rate (header) and refuses without it rather than guess m and n.
- **Cancel**: VHS re-queues each pass under a new prompt id with a negative queue number (it runs before anything else),
  so cancelling a meta-batch job deletes every pending prompt carrying the job's filename prefix, interrupts the one
  running, and looks again for a few seconds (a pass that was already saving can still queue the next). Checked here on a
  38-pass ProRes 4444 export: cancelled during pass 4, nothing ran after it. VHS keeps that pass's ffmpeg encode open in
  the cached batch manager (a partial `.mov` without its moov atom stays in `output/`) until ComfyUI drops the cache; the
  same happens to any meta-batch run that fails or is interrupted.
- **Real runs**: through Fuobe's API on the dev server (the comfyui provider end to end: upload, bindings, meta-batch
  follow, EXR zip) and directly with a small runner, on the shared CPU server with own prompt ids only, every output
  ffprobe-checked. The model graphs ran with random-weight stand-ins (`vftest_rife_random.safetensors`,
  `vftest_esrgan_x4_random.safetensors`, removed afterwards), so they prove frame counts, sizes, rates, sound and memory,
  not picture quality. Chunked vs whole-clip ESRGAN: 30 s at 256×144 to 1920×1080 held 0.87 GB above idle in 47 passes;
  the whole-clip graph held 3.0 GB for 10 s of the same clip at only 1024×576.
- **Caveat**: VHS's ProRes `hq` profile leaves the pixel format to `prores_ks`, which picks `yuv444p10le` for RGB frames, so
  "ProRes 422 HQ" is the HQ tag (`apch`) carrying 4:4:4 samples (FFmpeg reads it). A strict 4:2:2 file needs a VHS format
  with `-pix_fmt yuv422p10le`, a change to the node pack (not made). Core ComfyUI has no H.265 encoder, so the open HDR
  is H.264 High 10 (HLG or PQ); HDR10 in H.265 comes from Topaz on the cloud.
- **FILM**: oss-rife's Model control can pick `film_net_fp16.safetensors`; the spec lists it under `optionalModels`, so
  the manifest carries it with `optional: true` (named with its download when it's missing, not counted as missing on
  the Workflows page). Its URL is the repo's current name, `Comfy-Org/Frame-Interpolation` (the old lowercase one redirects).

### Round-4 Image to 3D extras (r4/3d-plus, 2026-10-25)

One hand-built entry for Image to 3D's "From several images" on the open engine, from the official template
`3d_pixal3d_multi_views` (2026-09-09; core nodes only):

```bash
node export-templates.mjs 3d_pixal3d_multi_views          # build/raw/, then the hand-built graph was made from it
npm run build -- image-to-3d-trellis2-multiview image-to-3d-trellis2
node validate-workflows.mjs image-to-3d-trellis2-multiview image-to-3d-trellis2 --shared
```

| id | capability | what | ran for real here |
|---|---|---|---|
| `image-to-3d-trellis2-multiview` | image-to-3d | One upload per side (image = front, image2 = left, image3 = back, image4 = right) → BiRefNet cut-out and crop per side → `Pixal3DMultiViewConditioning` (a fixed orbit rig; its field of view measured on the front crop by MoGe 2) → TRELLIS.2 stages on `pixal3d_multiview_int8_convrot` (5.58 GB, MIT) → PBR GLB + a 36-view turntable (RotateMesh + RenderMesh, 12 fps), which the server replaces with its CPU turntable when it can | no (GPU); /prompt only (every side, and front + back / front + right pruned); the MoGe FOV subgraph ran on CPU |

- **What the provider does**: `SLOT_RULES` gives the workflow its sides; each photo goes to the side
  `params.extra.views` names (in order when unnamed), and a side with no photo is cut out of the graph
  (`dropBranch` in `src/lib/comfy.ts`: its loader, cut-out and crop go, and the rig loses that input). The front is needed.
- **Field of view**: the official multi-view template keeps the rig's 20° (right for rendered turnaround sheets). Photos are
  wider as framed, so the graph measures it as the single-view Pixal3D template does: `MoGeInference` on the front crop →
  `MoGeGeometryToFOV` (horizontal, degrees) → the rig's `fov` (+0.66 GB, `moge_2_vitl_normal_fp16`). `fovX` fixes MoGe's lens
  instead (0 = estimate; 20 for a generated sheet). On the CPU server two runs of the subgraph (resolution level 9, one estimating,
  one given 20°) took 137 s in all, model load included: 40.0° estimated on a test image, 20° passed through.
- **Sides**: the rig's left is the object's own left (camera at +90° azimuth): facing the front, walk to your right to photograph it.
- **Single view**: `image-to-3d-pixal3d` (Pixal3D with MoGe 2's camera, the default "From an image" route) and
  `image-to-3d-trellis2` (the fallback) remesh with `sign_mode` solid (fill 20) and decimate to 250,000 faces, and have no
  turntable in the graph: the Fuobe server finishes every open image-to-3D GLB (a meshopt + WebP web GLB as `meta.web`, the
  pivot at the bottom) and renders a 96-frame turntable on the CPU (`src/server/model3d-finish.ts`, `scripts/model3d/`).
  The multi-view graph still has the template's udf remesh, a 700,000-face decimate and its GPU turntable; moving it to the
  single-view settings needs a new /prompt validation.
- **Licences**: the TRELLIS.2 and Pixal3D graphs (single and multi-view) encode with DINOv3 ViT-L (`dino_v3_L_naf`), so their
  licence names the DINOv3 License and its "Built with DINOv3" notice, like TripoSplat's.
- **Not open**: rigging. UniRig (MIT) has no ComfyUI pack verified against v0.41, so Rig & animate is Meshy on fal only.
  SAM 3D Objects has no open route either (the core SAM 3D nodes are body only).

### Genjutsu Character swap (o/genjutsu-original, 2026-10-27)

Two hand-built entries for Genjutsu's Character swap on MiniMax H3, and one for Remove object's person removal on the same
model (docs/research/openjutsu-6.md):

```bash
npm run build -- video-character-swap-h3 video-character-swap-h3-relay video-person-remove-h3-relay
node validate-workflows.mjs video-character-swap-h3 video-character-swap-h3-relay video-person-remove-h3-relay --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `video-character-swap-h3` | video-character-swap | Openjutsu's `swap.api.json` (Akatz Labs' H3 Character Swap graph at `0670e4f` with a `Video Slice` in front): the part (start + length, 5–15 s, longer continues window by window), quality as the unpatched pack's string (`"480"` / `"768"`), H3 reference tags in the prompt, who to swap (SAM 3.1 words, largest / leftmost / rightmost / index, or clicks as JSON points on H3's canvas), the anchor first frame as `image2` (absent: its loader and fit are deleted and the shot's `use_anchor` is off), the swap LoRA release (V1.5, V1, or none: the Turbo LoRA alone) | no: `missing_node_type` (the `h3_character_swap` nodes are not on this server; its 22 core nodes are in `object_info.subset.json`) |
| `video-character-swap-h3-relay` | video-character-swap | H3 Relay 2.0's character-swap example (akatz-ai/h3-relay at `e2a7665b`) with a `Video Slice`: the same part, quality, words, seed and who; no anchor | no: `missing_node_type` (`H3RelayAppendWindow`) |
| `video-person-remove-h3-relay` | remove-object | H3 Relay 2.0's Person Removal example with Akatz Labs' Person Remover V1 LoRA (`akatz-ai/MiniMax-H3-Person-Remover-LoRA` at `fe136b3`): SAM 3.1 marks the person you name in green, H3 rebuilds the background in 22-frame windows from a clean first frame (`image`, fitted to the video's size by an added `ImageScale`). Remove object's "H3 Person Removal" eraser fits the part to 24 fps on the 32-pixel grid, makes the clean frame with Qwen-Image-Edit and puts the sound back | no: `missing_node_type` (`H3RelayAppendWindow`) |

- **Node packs**: `h3_character_swap` (GPL-3.0) is copied out of `akatz-labs/h3-character-swap-tool` at
  `0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b` by `install-comfyui.sh` (`H3_PACK=0` skips it; it needs FFmpeg and FFprobe on
  PATH). H3 Relay (GPL-3.0) registers HTTP routes and patches H3's layout in memory when it loads, so it is opt-in:
  `H3_RELAY=1` clones it at `e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220`. Neither pack is installed on the CPU server
  these graphs were built on, so both entries are recorded with `validated: false` and the missing node named.
- **Weights** (46.33 GB, pinned to Hugging Face revisions in `library.spec.mjs`): H3 Ref2VA int8, its video and audio VAEs and
  the NVFP4 Qwen3-VL text encoder (Comfy-Org/MiniMax-H3), lightx2v's FL2V Turbo 8-step LoRA, SAM 3.1, and Akatz Labs'
  Character Swap LoRA V1.5 (V1 optional). The provider downloads the two LoRAs before a run (`graphLoras`).
- **Licences, as information**: MiniMax H3 Community License (territory excludes the US, the EU, the UK and South Korea;
  over US$20M yearly revenue needs MiniMax's written authorization; show "MiniMax H3"), Meta's SAM License, Apache-2.0
  (Turbo LoRA), GPL-3.0 (both packs). The admin decides what runs (Settings → Models & licences).
- **Clicks**: the provider moves them into the frame the pack prepares (its `canvas_dimensions`: a 0.5 / 1.0 MP budget
  on the 32-pixel grid, the clip scaled to cover and the middle cropped) and sets SelectSubject to `index` 0, since
  `SAM3_Detect` returns the clicked mask first and the "person" detections after it. Person numbers (`index`) are SAM's
  detections in order of confidence, not left to right. A window and history the pack's `validate_settings` would
  refuse (history ≥ window) is brought below the window.
- **GPU**: tested by their authors on a 96 GB RTX PRO 6000 and on a 24 GB RTX 4090 with 128 GB RAM and offloading.
- **Comfy Developer Platform** (what Openjutsu deploys to): a deployment is not a plain ComfyUI server — it is driven by
  the v2 API (`@comfyorg/sdk`: upload, job, poll), not `/prompt` and `/history` — so Fuobe does not add a provider for it.
  Point `COMFYUI_URL` at a ComfyUI that has the packs installed instead.

### Character Swap Studio (o/h3-studio, 2026-10-27)

Two hand-built entries for the Character Swap Studio (`/character-swap`) on your GPU, on H3 Relay 2.0's nodes; the
segment graph is built from `video-character-swap-h3-relay`. They follow Akatz Labs' app (docs/research/openjutsu-6.md
§4.2):

```bash
npm run build -- video-character-swap-h3-segment video-mask-h3-relay
node validate-workflows.mjs video-character-swap-h3-segment video-mask-h3-relay --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `video-character-swap-h3-segment` | video-character-swap | One segment: a single H3 Relay 2.0 pass (its "segment" schedule, at most 362 frames) over the clip's 24 fps copy. The approved mask (a whole-shot mask from `video-mask-h3-relay`) replaces SAM's own chain, the anchor goes in as Picture 2 (Picture 3 after a history boundary), and the previous take's lossless master (16-bit FFV1, output role `master`) gives the history frames (`historyVideo`, `historyStart`, `historyLength`). Outputs: the segment (H.264) and its master for the next segment. The provider rewrites the graph per job (`src/lib/swap-studio-graphs.ts`). Limits 30 s / 703 frames; 24 GB | no: `missing_node_type` (`H3RelayAppendWindow`) |
| `video-mask-h3-relay` | person-mask | Who to swap in one shot, as a black-and-white mask video at H3's canvas size and 24 fps: SAM 3.1 detects on frame `keyFrame` from words or clicks, H3 Relay picks largest / leftmost / rightmost / #n, and SAM 3.1 tracks it for `spanFrames` (the rest of the shot for Track shot, 1 for Update frame). The new part is spliced into the version it corrects (`prevMask`, `tailStart`, `tailFrames`). Limits 150 s / 3,592 frames; 6 GB | no: `missing_node_type` (`H3RelayPrepareSource`) |

- **Node packs**: no new one. Both use H3 Relay (GPL-3.0, opt-in with `H3_RELAY=1`, pinned at
  `e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220`); the segment graph also uses ComfyUI-VideoHelperSuite and needs FFmpeg.
  `build-library.mjs` gains eight binding keys for them: `historyVideo`, `historyStart`, `historyLength`, `keyFrame`,
  `spanFrames`, `tailStart`, `tailFrames` and `prevMask`.
- **Weights**: no new files. The segment graph uses the same pinned MiniMax H3 files, Turbo LoRA, SAM 3.1 and swap LoRA
  as `video-character-swap-h3-relay`, and the provider downloads the LoRAs before a segment runs; the mask graph needs
  only SAM 3.1 (1.75 GB).
- **Uploads**: a continuation uploads the previous take's master, about 3 MB a frame at 1 MP. ComfyUI takes uploads up to
  100 MB unless started with a higher `--max-upload-size`, so more than about 30 frames of history needs a higher one.
  An upload ComfyUI refuses as too large now fails with a message that says this, for every feature.
- **Memory**: the provider refuses a mask shot too long for the server's RAM before it runs. That limit is an estimate,
  not a measurement, and may be too strict (on a 64 GB server, 1 MP corrections stop at shots of about 18 s).
- **Not run**: neither graph has loaded in a ComfyUI with H3 Relay, and nothing has run on a GPU.
  `tests/comfy-swap-studio.test.ts` checks the provider's rewrites on the library files.

### Round 5: open tools and Evolution (Originals O11 and O13, 2026-10-29)

Four hand-built entries and one rebuilt one, all `validated: true` (the library then: 154 workflows, 149 validated). No new
node pack and no new worker; ComfyUI stays at 0.41.0. Fuobe Mixed Media, Fuobe Shorts, Fuobe Marketing Image and
Fuobe Try-On (O9 and O10) run graphs that were already in the library.

```bash
npm run build -- qwen-image-edit-2509-angles image-face-mosaic-sam3 video-depth-vda-large video-evolution-wan22-fun-vace infinitetalk-wanwrapper
node validate-workflows.mjs qwen-image-edit-2509-angles image-face-mosaic-sam3 video-depth-vda-large video-evolution-wan22-fun-vace infinitetalk-wanwrapper --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `qwen-image-edit-2509-angles` | edit | Fuobe Angles on your GPU: the library's `qwen-image-edit-2509` (fp8, the Lightning 4-step LoRA) with dx8152's Multiple-angles LoRA after it at 1.25, 6 steps (fal's default for this LoRA; a guess until measured). The prompt is the LoRA's own camera words in Chinese with English, which `src/lib/catalog/open-tools.ts` writes from the app's controls. 24 GB | yes (/prompt only; no Qwen weights here) |
| `image-face-mosaic-sam3` | face-mosaic | Fuobe Soul's PixeletedFace look: SAM 3.1 finds every face from the words ("face" by default, `threshold` 0.4), the mask grows 12 px, and the picture is shrunk by `mosaicScale` (0.04: blocks of about 25 px) and blown back up only under the mask. No face: the picture comes back unchanged. Core nodes and SAM 3.1 (1.75 GB); 4 GB | yes |
| `video-depth-vda-large` | depth-video | `video-depth-vda-small` with Video Depth Anything's Large model. Its weights are CC-BY-NC-4.0 (information: Settings → Models & licences lists them as Non-commercial with a switch); Depth map's default stays the small model. It downloads about 1.5 GB on its first run (`autoDownloads`); 8 GB | yes |
| `video-evolution-wan22-fun-vace` | v2v | Fuobe Evolution, one segment of up to 81 frames at 16 fps: Wan 2.2 Fun VACE starts from the segment itself, noised to `denoise` (Low 0.45, Medium 0.65, High 0.85), with Depth Anything 3 depth on every frame as control and the direction frame (`image`, from `qwen-image-edit-2511`) as the reference. Any clip loads: `VHS_LoadVideo` resamples it to 16 fps and cuts it to 4n+1 frames. The graph computes the schedule so that the last 4 steps (the Lightx2v 4-step LoRAs) start within a few hundredths of the asked `denoise`, and Wan 2.2's high-noise expert only takes steps above its switch point. Same 45.49 GB of weights as `video-restyle-wan22-fun-vace`; 24 GB | yes |
| `infinitetalk-wanwrapper` (rebuilt) | lipsync | Now hand-built from the graph kijai's example 03 export gave, so it builds without a frontend export. New bindings `lora`, `loraStrength`, `cfg`, `shift`, `scheduler`, `motionFrame`, `colormatch` and `audioCfg` carry Fuobe Speak's settings (FusioniX at 1, 25 steps, cfg 5, audio cfg 5, shift 10, `unipc`, 15 motion frames, `reinhard` colour match); its defaults stay the fast lightx2v pass. FusioniX (0.37 GB) is an optional model; 16 GB | yes |

- **Weights**: two new files, both LoRAs Fuobe downloads into the LoRA folder before a run: dx8152's Multiple-angles LoRA
  (0.24 GB, renamed from `镜头转换.safetensors` to `qwen-edit-2509-multiple-angles-dx8152.safetensors`) and FusioniX
  (0.37 GB, optional). Both are pinned to a Hugging Face commit in `KNOWN_MODELS`.
- **Build**: `build-library.mjs` gains the binding keys `scheduler`, `motionFrame`, `colormatch`, `audioCfg`, `threshold`
  and `mosaicScale`.
- **Licences, as information**: Apache-2.0 (Qwen-Image-Edit 2509, the Multiple-angles and Lightning LoRAs, Wan 2.2 Fun
  VACE, lightx2v, Depth Anything 3 mono-large, InfiniteTalk); FusioniX has an Apache-2.0 card, but the LoRAs it merges
  weren't checked; Meta's SAM License; CC-BY-NC-4.0 (Video Depth Anything Large).
- **Not run**: the validator posts each graph to `/prompt` on the CPU server and never lets it run, so none of these has
  rendered anything. Nothing has run on a GPU: not the Lightning LoRA at 6 steps with the angles LoRA, not InfiniteTalk's
  colour correction as `reinhard`, and not the Evolution intensities. `tests/open-tools.test.ts` and
  `tests/evolution-comfy.test.ts` check the provider's bindings on the library files.

### Restore & colourise (2026-10-30)

One hand-built entry for Video tools → Restore & colourise and the Canvas Restore node: Lightricks' Restore IC-LoRA on
LTX-2.5 22B distilled with tiled latent fusion (docs/research/fuobe-originals-recipes-5.json, studio `archive-restore`):

```bash
npm run build -- video-restore-ltx25-tiled
node validate-workflows.mjs video-restore-ltx25-tiled --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `video-restore-ltx25-tiled` | restore-video | One window of up to 97 frames (`windowStart`, `windowFrames`) scaled with lanczos to the card's canvas (1440x1088 for 4:3, 1920x1088 for 16:9), restored by `LTXVTiledFusionSampler` in 960x544 tiles at 50% overlap with the card's 8-step sigmas (euler, cfg 1). A later window takes the last 17 restored frames of the one before through `LTXVAddGuide` at frame 0 (`video2`, `prefixFrom`, `prefixFrames`) and drops them from its output; a reference picture goes in at `frame_idx` -1; deinterlacing keeps one field (`fieldWidth`, `fieldHeight`). Stage 2 (Restore to 4K) is the same graph with the Detail Refine IC-LoRA and 1024x576 tiles at twice the canvas. A whole clip in one run streams past 97 frames up to 481. The provider removes the unused branches (`src/lib/restore-graph.ts`); the pipeline joins the windows packet by packet and puts the sound back. 24 GB | no: `missing_node_type` (the ComfyUI-LTXVideo classes) |

- **Node pack**: ComfyUI-LTXVideo (LTX-2 Community License, free below US$10M annual revenue: information, not a gate),
  pinned in `install-comfyui.sh` at `220e1d45`. It is not installed on the
  CPU validation server, so the build records its classes as unknown and the entry stays unvalidated.
- **Weights**: the LTX-2.5 22B distilled transformer (int8), its VAE and the Gemma text encoder, plus the Restore IC-LoRA
  (1.7 GB) and, for stage 2, the Detail Refine IC-LoRA (1.3 GB). Both LoRAs are gated on Hugging Face: accept the licence
  there, add a token in Settings → LoRAs, and the provider downloads the one a run loads before it submits. LoRA files
  are never committed.
- **Not run**: the graph has not loaded in a ComfyUI with ComfyUI-LTXVideo, and nothing has run on a GPU.
  `tests/restore-comfy.test.ts` checks the bindings and branch removal on the library file.

## DBS soundtrack separation (DBS D1)

PR #15 adds three hand-built graphs: this one, the fly path's and MOSS-Image's (below), all `validated: true` (the
library: 158 workflows, 153 validated; the five that aren't are the H3 graphs above, whose node packs the validation
server doesn't have). One new node pack, ComfyUI-DBS; the other two graphs use core nodes only. None of the three has
run on a GPU.

One hand-built graph splits a soundtrack into dialogue, music and effects (docs/research/dbs-separation-7.md §4.4, graph A):

```bash
npm run build -- separate-soundtrack-dbs
COMFYUI_URL=http://127.0.0.1:<port> COMFYUI_MODELS_DIR=<that ComfyUI>/models node validate-workflows.mjs separate-soundtrack-dbs --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `separate-soundtrack-dbs` | separate-audio | `LoadAudio` (audio, or a video's soundtrack) → `DBSLoader` (`separationModel`: DBS-BSRNN-DnR or DBS-TIGER-DnR) → `DBSSeparate` (`channels`: mono or each channel, `output_sample_rate` input) → stems `voice`, `music`, `effects` and `background` (the original minus the speech, `AudioMerge` subtract) as FLAC, plus the pack's JSON report | yes, on an isolated CPU worker with ComfyUI-DBS and the weights (the shared server does not have the pack); real CPU runs of 6–20 s clips there |

- **Node pack**: ComfyUI-DBS (MIT; vendored DBS code Apache-2.0 with MIT notices) pinned at
  `f656e53434b5485c148a2866fbd6ddc6b6152ed6` in `install-comfyui.sh`. The Comfy Registry flags its only version (0.1.0) with no
  public reason; the code was read at this commit. It needs only einops and safetensors, already installed.
- **Weights** (23 MB): `install-comfyui.sh` downloads `config.json` and `model.safetensors` of JusperLee/DBS-BSRNN-DnR and
  JusperLee/DBS-TIGER-DnR at pinned revisions into `models/dbs/<model>/` and checks them with `sha256sum -c` (`DBS_WEIGHTS=0`
  skips it). The manifest lists all four by their path under the folder (`requiredModels`: a CUDA host runs DBS-TIGER, so
  the Workflows page's install commands fetch both models), which is what `GET /models/dbs` answers, so the Workflows page
  knows when they are there.
- **Host pick**: the provider uses DBS-TIGER when `GET /system_stats` says the first device is `cuda` and DBS-BSRNN otherwise
  (about 3x faster on a CPU: 0.27x real time against 0.09x on a 4-CPU host), unless the run picks one; the other model when
  `GET /models/dbs` shows the pick isn't on disk, and a model asked for that isn't there is refused in words before the
  job is queued. `each channel` for stereo stems. ComfyUI saves audio as mono or stereo only (a 5.1 waveform is written as
  scrambled stereo three times as long), so a file with more than 2 channels is split in `mono` and its background is the
  music and effects stems added up (the provider rewires node 4 to `AudioMerge` add).
- **Validation**: the shared validation server doesn't have ComfyUI-DBS, so validate this graph on a ComfyUI that has it
  (the command above). A run of every id against the shared server records it as `missing_node_type`, not validated,
  like the H3 entries.

DBS D3 adds graph B, the open dub's first step with DBS for the split (Translate & dub's "Voice split"):

```bash
npm run build -- dub-prepare-dbs-transcribe
COMFYUI_URL=http://127.0.0.1:<port> COMFYUI_MODELS_DIR=<that ComfyUI>/models node validate-workflows.mjs dub-prepare-dbs-transcribe --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `dub-prepare-dbs-transcribe` | separate-audio | `LoadAudio` → `DBSLoader` (`separationModel`) → `DBSSeparate` (mono, input rate) → stems `voice` (speech) and `background` (the original minus the speech) as FLAC, plus `dub-prepare-separate-transcribe`'s Qwen3-ASR node 7 on the speech (bindings `sourceLanguage`, `asrModel`, `hints`, `maxChars`) → `cues`, `transcript`, `language`: the same outputs as the MelBand graph | yes, on the CPU ComfyUI with ComfyUI-DBS and the weights; a real CPU run of a 12 s clip (LibriSpeech speech + chords + noise bursts, Qwen3-ASR 0.6B) took 133 s with the ASR load, gave voice + background equal to the source within 3.0e-5 and a correct transcript |

The provider fills it like graph A (host pick, a model that isn't there refused in words, a surround source's background
from music + effects); it has no `channels` binding: the dub's split is always mono.

## Open-H3 Regenerate 2K (n7-3)

One hand-built graph for Upscale → Video's "Regenerate · creative", the "Regenerate in 2K" result action and the Canvas
Upscale node's "Regenerate (creative)" choice (docs/research/new-models-7.md §2.6):

```bash
npm run build -- video-regenerate-h3
node validate-workflows.mjs --subset-only video-regenerate-h3   # GET /object_info only; then node build-requirements.mjs
```

| id | capability | what | validated here |
|---|---|---|---|
| `video-regenerate-h3` | upscale-video | rdh9616's "Draft Video" example without the note, the PreviewAny nodes and `OpenH3VideoToPrompt` (the prompt goes straight into `CLIPTextEncode` 16), `curve_name` "none" (so the curve table is never read: `(model's own table)`), and `OpenH3SaveRefinedLatent` (24) kept so a failed decode can be redone from the saved latent. A `Video Slice` (29) in front cuts a 15 s window (`startTime`, `duration`). Bindings: `video`, `prompt`, `resolution` (the pack's strings: `1080p (1920x1080)`, `2k (2560x1440)`, `4k (3840x2160)`), `draftSize` (`768p (1344x768)` for H3 drafts, `576p (1024x576)` for the rest; `keep (snap to 32)` is never sent, since the pack's upscale always targets 16:9 or 9:16 and would stretch any other shape), `frames` (node 11's `max_frames`; 24 and 26 read 11's frame count), `startSigma`, `steps`, `seed`, `filenamePrefix`. 48 GB | no: `missing_node_type` (the packs are not on the CPU validation server) |

- **Node packs** (opt-in, `OPEN_H3_REGEN=1` in `install-comfyui.sh`): rdh9616/ComfyUI-Open-H3-Regenerate at `9b686c5`
  (Apache-2.0) and LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler at `40316cf` (MIT): `OpenH3RegenUpscale` looks up LBH's
  `MinimaxH3LatentUpscaler3D` class by name. ComfyUI core master merged its own H3 latent upscaler and a Sol-H3-VAE loader
  on 2026-10-28 (PRs #17411 / #17412); the pinned 0.41.0-7 and the CPU server here have neither, and the rdh pack would
  still need LBH's class, so the LBH pack stays.
- **Weights** (19.6 GB new, plus the 20.97 GB FL2VA base the H3 video graphs already pin): NVIDIA's merged refiner LoRA
  (12.45 GB), the fast H3 VAE decoder (6.47 GB) and the LBH latent upscaler (0.69 GB), pinned to the model card's revision
  `5809c33` with their SHA-256 in `workflows/comfyui/model-pins.json`. The Qwen3-VL encoder and the H3 video and audio VAEs
  are the ones already pinned. `sharp_curve_branches.safetensors` is left out (its tensors are zero in the blocks checked).
- **Not run**: nothing has run on a GPU, and the pack was tested by its author on ComfyUI 0.42.0. Validate on a disposable
  GPU ComfyUI with the packs: `node validate-workflows.mjs video-regenerate-h3`.

## Hi3D 1.0 refine (hi3d-refine)

One hand-built graph for Image to 3D's "Refine detail · Hi3D 1.0" (a switch, and "Refine this mesh" on a finished
model), the open image-to-3D models' "Refine detail" control on the Canvas 3D node, and Assist / MCP's `refine-3d`
(docs/research/hi3d-refine.json). Hi3D v1.0 refines a coarse mesh into finer geometry from a photo of the same object;
it does not make a mesh from nothing, and its output is geometry only, recentred at unit radius.

```bash
npm run build -- mesh-refine-hi3d
node validate-workflows.mjs mesh-refine-hi3d --shared   # missing_node_type here: the pack needs a CUDA GPU
node build-requirements.mjs
```

| id | capability | what | validated here |
|---|---|---|---|
| `mesh-refine-hi3d` | refine-3d | `LoadImage` (2) → core BiRefNet `RemoveBackground` (4) → `InvertMask` (8: Hi3D reads a mask's 1 as transparent, so the inverted mask keeps the subject) → `Hi3DRefine` (6) with the coarse GLB (`Hi3DLoadMesh` 5 reads it from ComfyUI's input folder, where Fuobe uploads it like any input) and `Hi3DModelLoader` (1: models/Hi3D, sequential CPU offload on, SDPA attention) → `SaveGLB` (7). Bindings: `image`, `model3d` (5's `mesh_file`), `meshResolution` (512 / 1024 / 1536: one, two or three passes), `steps` (25 a pass), `seed`, `cpuOffload`. The server finishes the GLB like any image-to-3D model (web GLB + CPU turntable). 24 GB (an estimate) | no: `missing_node_type` (the pack is not on the CPU validation server) |

- **Hardware**: an NVIDIA GPU of compute capability 8.0 or newer (RTX 30 series / A-series, Ada, Hopper, Blackwell) with
  CUDA 12, on Linux or Windows. There is no CPU path. The official stack is Python 3.10, CUDA 12.0-12.5, torch 2.5.0+cu124,
  flash-attn 2.7.4.post1 and spconv-cu120 2.3.6 (validated upstream on a 96 GB H20); T8's pack keeps ComfyUI's own torch,
  installs spconv-cu126 2.3.8 and triton, and offers SDPA attention. Fuobe's graph uses `attention: sdpa` on node 1, so no
  flash-attn build is needed (the install doesn't add one); set it to `flash` by hand only where flash-attn is already built. Its author ran 512 to 1536 on a 24 GB laptop RTX 5090 with CPU offload; smaller cards are not established.
- **Node pack** (opt-in, `HI3D=1` in `install-comfyui.sh`): T8mars/Comfyui-Hi3d-T8 at `7384849` (v0.5.1, MIT code; the
  Hi3D code it vendors is under the Hi3D Open License 1.0), with its `requirements.txt` installed into ComfyUI's Python.
  By hand: `git clone https://github.com/T8mars/Comfyui-Hi3d-T8 custom_nodes/Comfyui-Hi3d-T8 && git -C
  custom_nodes/Comfyui-Hi3d-T8 checkout 73848490976e6a9b0c735ce02984c03866a495e7 && python -m pip install -r
  custom_nodes/Comfyui-Hi3d-T8/requirements.txt`, then restart ComfyUI.
- **Weights** (10.66 GB, `HI3D_WEIGHTS=0` skips them): hi3d-official/Hi3Dv1.0 at `d502e93` (transformer_512 3.68 GB,
  transformer_1024 3.68 GB, vae 0.38 GB and their JSON) into models/Hi3D/hi3d/, facebook/dinov2-large at `47b73ee`
  (1.22 GB) into models/Hi3D/dino/ and openai/clip-vit-large-patch14 at `32bd642` (1.71 GB) into models/Hi3D/clip/, each
  checked against its SHA-256 (also in `workflows/comfyui/model-pins.json`; the same files t8star/Hi3d-Comfy repackages).
  ComfyUI doesn't list the Hi3D folder, so the GPU pre-flight reads these files as "unknown" rather than present.
- **Licence**: the Hi3D Open License Agreement 1.0 allows commercial use; above 200,000 monthly active users or USD
  1,000,000 monthly revenue, notify the licensor and apply for a separate licence; every result is shown with "Powered by
  Hi3D 1.0" linking to http://hi3d.ai/ (the app does this on the result cards and the switch).
- **Texture**: not on this graph. Core can bake TRELLIS.2's texture voxels onto another mesh (`BakeTextureFromVoxel`), but
  only inside the run that made them and only in their frame, and Hi3D's output is recentred at unit radius with no core
  node to move it back; see the research's `texture.ownerStep`.
- **Not run**: nothing has run on a GPU yet. Validate on a GPU ComfyUI with the pack: `node validate-workflows.mjs mesh-refine-hi3d`.

## Fly path (N7-5)

One hand-built graph films a still along a camera path keyframed in Cinema's 3D scene, on core nodes only
(docs/research/new-models-7.md §3.6):

```bash
npm run build -- wan21-i2v-uni3c-path
node validate-workflows.mjs wan21-i2v-uni3c-path --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `wan21-i2v-uni3c-path` | camera-path | `UNETLoader` (Wan 2.1 I2V 14B 720P fp8; `checkpoint` swaps in the 480P fp8 file) → `ModelSamplingSD3` (`shift`) → `ModelPatchLoader` (Uni3C) + `WanUni3CControlnetApply` (`strength`, 0–1) on the browser's render of the path (`video`: `LoadVideo` → `GetVideoComponents`; the node pads or cuts it to the latent's frames and centre-crops it to the size) → umt5 / CLIP vision H / Wan VAE → `WanImageToVideo` (the still as `image`, 81 frames) → `KSampler` (`steps` 30, `cfg` 5, uni_pc; a guess to tune on a GPU) → `VAEDecode` → `CreateVideo` (16 fps) → `SaveVideo` | `/prompt` only (no GPU here); a model-free `LoadVideo` run read the browser's render as 81 frames |

- **Weights**, pinned in `library.spec.mjs`: Kijai/WanVideo_comfy `Wan21_Uni3C_controlnet_fp16.safetensors` @ `8260d429`
  (1,997,314,376 B, in `models/model_patches`) and Comfy-Org/Wan-2.1 `wan2.1_i2v_720p_14B_fp8_scaled.safetensors` @
  `123acf1c` (16,401,356,938 B); optional: Kijai/WanVideo_comfy_fp8_scaled's 480P fp8 file @ `4d02bd37` (16,643,349,018 B).
  The 480P Q8 GGUF Fuobe pins for InfiniteTalk can't load here: core `UNETLoader` reads no GGUF (that needs city96's
  ComfyUI-GGUF pack). Loading Kijai's file through core `ModelPatchLoader` is inferred from its header keys, not run.
- **The render** comes from the browser (`src/components/cinema/scene-engine.ts` `recordPath`): 81 frames at 16 fps, black
  where nothing was seen, VP8 in WebM at exact frame times. Its hole mask is made only when asked for (core's Uni3C node
  has no mask input). WorldCast (N7-9) doesn't use this render: its case renders the path and the hole mask on the server
  from MoGe 2's depth (`src/server/worldcast-case.ts`).
- **Licences, as information**: Apache-2.0 (Wan 2.1; Uni3C, whose Kijai repack carries no licence field).
- **GPU**: Uni3C's own figures are 46–51 GB with offload; Fuobe's older 24 GB note is unverified.

## MOSS-Image (N7-1)

One hand-built graph on core nodes (MOSS-Image is native in the pinned ComfyUI; docs/research/new-models-7.md §4.6):

```bash
npm run build -- moss-image-t2i
node validate-workflows.mjs moss-image-t2i --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `moss-image-t2i` | t2i | `UNETLoader` (SFT int8; `unet`) → `CLIPLoader` qwen3.5-9b int8, type `moss_image` → `VAELoader` FLUX.2 small → `CLIPTextEncode` ×2 (the prompt: plain words or a compiled layout, verbatim) → `EmptyFlux2LatentImage` (`width` / `height`: the layout's canvas) → `SkipLayerGuidanceDiTSimple` (layer 22, first half) → `KSampler` (`steps`, `cfg`, `sampler`, `scheduler`) → `VAEDecode` → `SaveImage` | `/prompt` only with the w4a8 encoder (CPU, zero-byte model stand-ins); the int8 one is not checked by `/prompt` yet; no render here |

- **Weights** (15 GB): Comfy-Org/MOSS-Image at `530a4c94f92c35ef6818b1b035a983fe9dcf5f54` (diffusion model 5.41 GB, small VAE
  0.25 GB) and its int8 Qwen3.5-9B text encoder (9.75 GB, the row FIBO 2 shares), and, for the Fast setting only, Spectrallic's SFT
  with the 8-step DMD LoRA merged in (5.41 GB), for Base only MOSS-Image Base int8 (5.41 GB; both `optionalModels`). All Apache-2.0.
  Not the template's w4a8 encoder: in testing (2026-10-23), loading it after other model families faulted the NVIDIA driver;
  the preview pipeline then ran 23 MOSS renders on the int8 file with no fault. The Workflows page's install commands fetch them; nothing is downloaded at build time.
- **Settings**: Standard is the Comfy template's (25 steps, CFG 2.5, er_sde / simple), Best OpenMOSS's guide (50, 3, euler),
  Fast the DMD file at 8 steps and CFG 1, Base the Base file at 50 steps, CFG 3, euler (`ModelOptions.controls[].sets` on
  `oss-moss-image` writes them).
- **Canvas**: a size the request names (`params.extra.width` / `height`, a layout's canvas) is fitted to the 16-pixel grid
  and 2048 px a side with its shape kept (`fitCanvas` in `src/lib/comfy.ts`), as fal's `image_size` is, so both engines
  render one size (2560 × 1000 becomes 2048 × 800 on both).
- **Licences, as information**: all Apache-2.0, the optional Fast file's too; the small decoder is byte-identical to BFL's
  Apache-2.0 FLUX.2-small-decoder (the manifest's `license` says so, and Settings → Models & licences shows it).
- **Not installed on purpose**: LinXce's Comfyui-Moss-LayoutPrompt (its `MOSSImageLayoutPrompt` id collides with core's) and
  OpenMOSS's loader pack (core's native path is what its own README recommends). Fuobe compiles layouts itself
  (`src/lib/layout-prompt.ts`).
- **GPU**: no official VRAM figure (16 GB is a guess with ComfyUI's offloading). comfy-kitchen's int8 kernels need a
  PyTorch built for CUDA 13 (cu130); otherwise `comfy/quant_ops.py` turns them off with a warning.

## Owner's SOTA image families (2026-10-31)

Sixteen hand-built graphs for Ideogram 4, Qwen-Image 2.1, Krea 2 and FIBO 2 (MOSS-Image is the graph above). They are the
first picks on the open engine: the Image studio opens on Ideogram 4, Edit and Inpaint on Qwen-Image 2.1, and every
studio's "Best" list ranks the new models first (`src/lib/catalog/models.ts`, `tests/open-sota-studios.test.ts`). Each graph
comes from the owner's saved ComfyUI workflows or from a graph rendered in the preview pipeline, converted once to API
format; the UI-only nodes (notes, compares, previews, resolution pickers, switches) are removed.

They were built from a ComfyUI that was busy rendering, so nothing was posted to it:

```bash
npm run build -- <ids>                                  # GET /object_info only (+ Hugging Face sizes)
node validate-workflows.mjs --subset-only <ids>         # writes their classes to object_info.subset.json, posts nothing
node build-requirements.mjs
```

All sixteen are `validated: false` until `node validate-workflows.mjs <ids> --shared` runs on an idle ComfyUI 0.42.0 (the
library: 174 workflows, 153 validated). Proof: [P] rendered in the preview pipeline, [O] the owner's saved workflow, [I] built
from an example and not rendered yet.

| id | capability | source | proof |
|---|---|---|---|
| `ideogram4-t2i` | t2i | the owner's `image_ideogram4_t2i_int8`: conditional and unconditional int8 models (`DualModelGuider`, `CFGOverride`), the Quality / Default / Turbo table into `Ideogram4Scheduler` (`preset`); the prompt is a JSON caption written from the words (`src/lib/ideogram-caption.ts`) | [P] |
| `qwen-image-21-t2i` | t2i | the owner's default Qwen-Image 2.1 graph: 25 steps, cfg 1, euler / simple, up to 2048 px on the 32 grid | [O] |
| `qwen-image-21-edit` | edit | `TextEncodeQwenImage21` with up to 4 references (each scaled to 2048 px, lanczos), `QwenImage21Cache`, 25 steps | [P] |
| `qwen-image-21-turbo-edit` | edit | the Turbo model on its fixed 8-step `ManualSigmas`, the same 4-reference encoder | [P] |
| `qwen-image-21-inpaint` | inpaint | AusBoss's example: crop around the mask (red channel, white = change), 25 steps, stitched back | [I] |
| `qwen-image-21-outpaint` | outpaint | the owner's `qwenImage21Outpaint_v12`: AusBoss pad nodes (`padLeft`…`padBottom` on both), the outpaint-v2 LoRA, Qwen3-VL describes the canvas; the words only add what goes in the margins | [P] |
| `krea2-realism-t2i` / `krea2-turbo-t2i` | t2i | the owner's Krea 2 Turbo graph, with the Realism V2 LoRA (`loraStrength`) at 6 steps, or plain at 8 | [O]; the LoRA [I] |
| `krea2-edit-general` / `krea2-edit-identity` | edit | the owner's `Krea2 Image Edit` on comfyui-krea2edit (General or Identity Edit V2 LoRA, `ref_boost` 4 or 2, 8 steps); image 2 is an optional person | [O] |
| `krea2-turbo-i2i` | edit | the picture scaled to about 2 MP, then Krea 2 Turbo at `denoise` = `strength` | [I] |
| `krea2-inpaint` / `krea2-outpaint` | inpaint / outpaint | Cierpliwy's examples on ComfyUI-Krea2-Ostris-Edit: the area to paint made black, the inpaint-edit LoRA, 8 steps, euler_ancestral | [I] |
| `fibo2-dev-t2i` | t2i | the owner's FIBO 2 VGL graph: Qwen3.5 9B writes Bria's JSON prompt, 30 steps, cfg 5 | [O] |
| `fibo2-dev-edit` / `fibo2-edit-turbo-edit` | edit | the owner's FIBO 2 edit graphs with references 3 and 4 wired like 2: Dev 30 steps / cfg 5, Edit Turbo 4 steps / cfg 1 | [O] |

- **Optional references**: a reference the run doesn't have is left out of `TextEncodeQwenImage21`, `TextEncodeFibo2` and
  Krea 2's edit nodes (`OPTIONAL_REFERENCE_INPUTS` in `src/server/providers/comfyui.ts`).
- **Node packs** (`packs.json`; the GPU pre-flight lists them, `install-comfyui.sh` doesn't install them yet): ausboss-nodes
  @ `bce780f2` (MIT; Qwen-Image 2.1 inpaint and expand), comfyui-krea2edit @ `13ef60f2` (Apache-2.0; Krea 2 Edit and
  Identity Edit), ComfyUI-Krea2-Ostris-Edit @ `77565661` (MIT; Krea 2 Inpaint). A ComfyUI with comfyui-workflow-encrypt
  reports that pack as the module of other packs' nodes, so the build names a class's pack from `PACK_CLASSES` first
  (`packOfClass` in `build-requirements.mjs`).
- **Weights** (about 92 GB new, revisions, sizes and SHA-256 from the Hugging Face API in `model-pins.json`): the int8 builds
  of Comfy-Org's Ideogram-4, Qwen-Image-2.1, Fibo-2.0 and MOSS-Image (Qwen3.5 9B) repositories, AusBoss's outpaint LoRA and
  the Krea 2 LoRAs (Realism V2, General and Identity Edit V2, inpaint-edit v1 512). The Krea 2 graphs load Comfy-Org's fp8 Krea 2
  Turbo (`krea2_turbo_fp8_scaled`, 13.14 GB), the build the Krea 2 edit workflow loads. `variants` in
  `KNOWN_MODELS` names the same weights in another precision in the same repository (Krea 2 Turbo's bf16 build, …); nothing
  reads it yet, so a ComfyUI with only those builds still needs the pinned file.
- **Ideogram 4's safety card**: when its filter refuses a prompt, the graph saves a flat grey "Image blocked by safety filter"
  card. `src/server/safety-card.ts` (the preview pipeline's `blocked-check.mjs`) finds it in a finished run's picture: the card
  is deleted and the run fails with what to try.
- **Licences, as information**: Qwen-Image 2.1 and Ideogram 4 weights are non-commercial, FIBO 2 CC BY-NC 4.0, Krea 2 the
  Krea 2 Community License (the edit LoRAs non-commercial without their author's licence).
- **GPU**: 20–24 GB estimates (`vramGb`), none measured here. ComfyUI 0.42.0 or newer: `TextEncodeQwenImage21`,
  `QwenImage21Cache`, `Ideogram4Scheduler`, `DualModelGuider`, `CFGOverride` and `TextEncodeFibo2` came with it.

## NVIDIA RTX Video (ComfyUI Nvidia VFX Nodes)

Three hand-built graphs on Comfy-Org's ComfyUI Nvidia VFX Nodes 0.2.1 (`38d790d`, Apache-2.0, registry
`comfyui_nvidia_rtx_nodes`) and NVIDIA's `nvidia-vfx` 0.2.0.0 runtime (the RTX Video SDK and its models in one wheel from
pypi.nvidia.com; NVIDIA Software License Agreement). No model files: nothing downloads at run time.

```bash
npm run build -- upscale-video-rtx fps-rtx-framegen sdr-to-hdr-rtx
node validate-workflows.mjs --subset-only upscale-video-rtx fps-rtx-framegen sdr-to-hdr-rtx   # then node build-requirements.mjs
```

| id | capability | what | validated here |
|---|---|---|---|
| `upscale-video-rtx` | upscale-video | `upscale-video-esrgan-chunked`'s VHS meta-batch with `RTXVideoSuperResolution` (scale `min(4, max(1, shortSide / shorter edge))` from `VHS_VideoInfo`, then `ResizeImageMaskNode` to exactly `shortSide`); sound kept. Bindings `video`, `framesPerBatch`, `shortSide`, `rtxQuality` | no: `missing_node_type`. The graph with `ImageScaleBy` in the RTX node's place ran here: 3 s 320x180 25 fps with sound → 1280x720, 75 frames in 5 passes, AAC kept |
| `fps-rtx-framegen` | interpolate | `interpolate-rife-fps` with `RTXVideoFrameGeneration` (multiplier mode, shot changes detected) in `FrameInterpolate`'s place: N frames (+ the last held once) → N x m + 1. Bindings `video`, `multiplier`, `every`, `slowdown`, `rtxQuality` | no: `missing_node_type` |
| `sdr-to-hdr-rtx` | sdr-to-hdr | `RTXTrueHDR` (peak `peakNits`, 400-2000) → `CreateVideo` 10-bit with the same `colorSpace` (`HDR` = BT.2020 HLG, `HDR PQ` = PQ) → H.264 High 10 MP4. | no: `missing_node_type`. With `ImageSDRToHDR` in its place: High 10, yuv420p10le, bt2020 / arib-std-b67 (HLG) and smpte2084 (PQ), sound kept |

- `gpu` in the spec (`nvidia-rtx`, frame generation `nvidia-rtx-40`) goes to the manifest and `requirements.json`; the GPU
  pre-flight shows "Needs an NVIDIA RTX card" when the connected card isn't one.
- `install-comfyui.sh` clones the pack and installs `nvidia-vfx` only when `nvidia-smi` names an RTX card on an x86_64
  machine (`nvidia-vfx` 0.2.0.0 has no Linux arm64 wheel; `RTX_VIDEO=1` forces it, `RTX_VIDEO=0` skips it), and warns when
  PyTorch isn't a CUDA 13 (cu130) build, which the pack's README asks for.
- **Not run on a GPU.** Validate on a ComfyUI with an RTX card: `node validate-workflows.mjs upscale-video-rtx fps-rtx-framegen sdr-to-hdr-rtx`.

## Watermark Remover (ComfyUI-Qwen-Watermark)

Three hand-built graphs from overflowofedge's ComfyUI-Qwen-Watermark (MIT, pinned at `eef829d3`) for the Watermark Remover
app (`app-watermark-remover`, its own page in `src/components/watermark`). The page runs a scan, shows the marks it found,
and removes the ones the visitor didn't keep; a brush covers anything missed. Both steps are ordinary runs on the person's
own GPU (`POST /api/generations`).

| id | capability | what it does |
|---|---|---|
| `image-watermark-scan-qwen3vl` | watermark-scan | `QWMDetect` auto_qwen (Qwen3-VL 8B int8, one pass); the report (`PreviewAny`) is the only output: boxes in pixels with their type, a tight `source_bbox` and the less sure `rejected_boxes` |
| `image-watermark-remove-qwen21` | watermark-remove | `QWMDetect` manual_boxes with the kept marks (`boxes`, `detectMode`), a rectangle or a SAM ViT-B outline per mark, Qwen-Image 2.1 int8 repair at `maxSize`, a leftover check and at most one more pass; `QWMFinal` refuses to change any pixel outside the mask. Its report (role `quality`) is folded into the picture's meta |
| `image-watermark-remove-qwen21-brush` | watermark-remove | the same with a painted mask (`LoadImageMask`, red, white = remove) into `QWMDetect` manual_mask; `src/lib/comfy-variants.ts` runs it when a request carries a mask |

The provider fills `boxes` (checked and rebuilt by `src/lib/watermark.ts`, clamped to the picture), `detectMode` and `maxSize`
(1024; 1536 past 3000 px; 768 on a GPU under 16 GB) and draws both seeds at random. The GPU pre-flight checks the removal
along with a scan (`COMPANION_GRAPHS`), so nobody is stopped after the first step.

The pack's `requirements.txt` is not installed (its `opencv-contrib-python-headless` next to `opencv-python` can leave `cv2`
broken): `packs.json` names `pip: ["segment-anything==1.0"]` instead, which the setup commands install by name. SAM ViT-B
comes from a Hugging Face mirror (`ybelkada/segment-anything`) at a pinned revision whose SHA-256 is Meta's file's
(`ec2df627…`). ComfyUI lists `models/sams` only when a pack registers the folder, so its presence is `unobservable`.

They were built with a stand-in for `/object_info` (the committed subset) and are `validated: false` until
`node validate-workflows.mjs image-watermark-scan-qwen3vl image-watermark-remove-qwen21 image-watermark-remove-qwen21-brush --shared`
runs on a ComfyUI 0.42 with the pack installed.

## Round 5, part 3 (PR #16)

PR #16 adds 23 hand-built graphs; the library now has 268 workflows, 191 of them validated. Six were accepted by the CPU
validation server (`validated: true`): the four Pika H3 Flex graphs, `image-to-mesh-idol` and `image-person-mask-sam3`.
The other 17 are `validated: false`. Most need node packs that server doesn't have; the exception is
`image-to-views-idol`, which passed there once the server had ComfyUI-Idol but stays unvalidated until a GPU run. Each
section says how they were checked instead. None of the 23 has run on a GPU. Three Idol graphs are in the round-4 table above, and `mesh-refine-hi3d`
and the three RTX Video graphs have their own sections above; the rest follow. `workflows/comfyui/packs.json` now lists
52 node packs, 8 more, and the new ones are pinned by commit; the ComfyUI pin is unchanged.

### Pika H3 Flex (nm10-pika-flex)

Four hand-built graphs on core nodes (the references graph gets VideoHelperSuite's clip loaders per run) for MiniMax H3's
Quality → "Fast · Pika Flex (6 steps)", the References mode and "Talk from a voice clip", on your GPU only: no hosted
service runs Pika's adapters at its 6-step schedule (`src/lib/catalog/pika-flex.ts`).

```bash
npm run build -- minimax-h3-flex-t2v minimax-h3-flex-i2v minimax-h3-flex-flf2v minimax-h3-flex-ref2va
node validate-workflows.mjs minimax-h3-flex-t2v minimax-h3-flex-i2v minimax-h3-flex-flf2v minimax-h3-flex-ref2va --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `minimax-h3-flex-t2v` / `-i2v` / `-flf2v` | t2v / i2v / flf2v | Comfy-Org's `video_pika_h3_flex` templates: the pruned int8 FL2VA model with Pika's FL2VA adapter at 1.0 (`LoraLoaderModelOnly`), `KSamplerSelect` lcm, Pika's six steps as `ManualSigmas` and `BasicGuider` at CFG 1. Words, a first frame (`image`), or a first and a last frame (`endImage`); 480p or 768p, 24 fps, 5–15 s, with stereo sound made with the picture | yes (`/prompt` only) |
| `minimax-h3-flex-ref2va` | ref2v | Core `MiniMaxH3ReferenceToVideo` on the pruned int8 Ref2VA model with Pika's Ref2VA adapter. The graph holds one image; the provider adds the rest per run (`expandH3References` in `src/lib/h3-references.ts`): up to 9 images, 3 clips (VHS, at 24 fps) and 3 voice or music clips, 12 files in all, each clip 2–15 s. The prompt names them `<Picture N>`, `<Video N>` and `<Audio N>` | yes (`/prompt` only) |

- **Weights**: Pika's two adapters (1.96 GB each, at the model card's revision `3ff16644`, SHA-256 in
  `workflows/comfyui/model-pins.json`), which a run downloads when ComfyUI lacks them, on the MiniMax H3 files the
  library already pins (the 20.97 GB pruned int8 FL2VA and Ref2VA models, the 15.69 GB Qwen3-VL text encoder and the
  VAEs).
- **Licences, as information**: the MiniMax H3 Community License (its territory excludes the US, the EU, the UK and South
  Korea; show "MiniMax H3"). Pika's adapters are Model Derivatives under it, and Pika's NOTICE goes with them.
- **GPU**: `vramGb` 32 is recorded, not measured. Pika tested on an 80 GB H100 and says an end-to-end ComfyUI render
  wasn't verified with the upload. Another speed LoRA on top breaks the output, by Pika's account.
- **Not run**: the validator posts each graph to `/prompt` and never lets it run, so nothing has rendered.
  `tests/pika-flex.test.ts` checks the graphs and the reference expansion.

### Kandinsky 6.0 (nm10-kandinsky6)

Three hand-built graphs on Kandinsky Lab's own packs, each the `comfyui/` folder of its repository: `kandinsky6` (MIT,
pinned at `7ceeefad`, Registry 1.0.2, ComfyUI 0.38 or newer) and `kandinsky6-sr` (Apache-2.0, pinned at `b15e2aac`,
Registry 0.1.2). Core ComfyUI has no Kandinsky 6 nodes yet. The cloud half is Kandinsky 6.0 and Kandinsky VSR on fal.

```bash
npm run build -- kandinsky6-t2av kandinsky6-i2av video-upscale-kandinsky6-vsr
node validate-workflows.mjs kandinsky6-t2av kandinsky6-i2av video-upscale-kandinsky6-vsr --shared   # missing_node_type without the packs
```

| id | capability | what | validated here |
|---|---|---|---|
| `kandinsky6-t2av` / `kandinsky6-i2av` | t2v / i2v | 5 s clips with sound and dialogue: core loaders (`UNETLoader`, `DualCLIPLoader` kandinsky5 with Qwen2.5-VL 7B and CLIP-L, the HunyuanVideo VAE), the pack's audio VAE loader (MMAudio's `v1-44.pth` and the BigVGAN v2 vocoder) and its PiFlow sampler at 10 steps, CFG 1. `unet` is the Quality setting: Lite distilled (6.38 GB, the default) or Pro distilled (60.3 GB, optional). One caption feeds the picture and the sound: Fuobe puts quoted words between `<S>` and `<E>` and a closing `Sound:` line between `<AUDCAP>` and `<ENDAUDCAP>` (`src/lib/kandinsky-prompt.ts`). Node 20, the Prompt helper (Qwen3.5 9B, 19.3 GB), is taken out unless it is on. 121 frames at 24 fps, 848x480 for 16:9; the picture of image to video is cropped to the clip's size | no: the packs aren't on the CPU validation server; the graphs follow the packs' templates and are checked against the node definitions in their source at the pinned commits |
| `video-upscale-kandinsky6-vsr` | upscale-video | `Kandinsky6VSRUpscale` (the 2-step distilled VSR model, its K-VAE and its latent upscaler bank, tiled) at 2x, 2.25x (480p to 1080p) or 4x (`scale`, and `upscalerScale` for the bank entry), with the clip's own sound. The pack resamples to 24 fps and keeps at most 121 frames, so Fuobe refuses a longer clip rather than cut it | no: same |

- **Weights**, pinned in `model-pins.json`: the Lite and Pro distilled transformers and the VSR bundle (3.19 GB model,
  6.96 GB K-VAE, 7.31 GB upscaler bank, each file with its `config.json` beside it, since the loaders list nothing
  without one), saved under `diffusion_models/<repository>/` as the packs' README says; the bf16 Qwen2.5-VL 7B text
  encoder (16.58 GB, which World mode shares), the HunyuanVideo VAE, `v1-44.pth` (1.22 GB) and the vocoder (in
  `models/audio_vae/bigvgan_vocoder`). CLIP-L is the library's own.
- **Licences, as information**: the Kandinsky weights are MIT; the HunyuanVideo VAE is under the Tencent Hunyuan Community
  License (its territory excludes the EU, the UK and South Korea); the sound decoder `v1-44.pth` is CC BY-NC 4.0
  (non-commercial); the vocoder is MIT; Qwen2.5-VL 7B and Qwen3.5 9B are Apache-2.0.
- **Install**: `install-comfyui.sh` copies both packs' `comfyui/` folders at the pinned commits and installs their
  requirements (`safetensors>=0.8.0` among them); `K6_PACKS=0` leaves them out.
- **GPU**: nothing is published. `vramGb` 24 is an estimate for Lite (its 6.4 GB model, then the encoder and the VAE in
  turn) and for the VSR; Pro holds a 60.3 GB model, so it needs about an 80 GB GPU, or a lot of system RAM for ComfyUI
  to offload into.
- **Not run**: nothing has run on a GPU. `tests/kandinsky6.test.ts` checks the graphs and their bindings.

### Green screen and cut-outs (nm10-keying)

Three hand-built graphs on your GPU: CorridorKey 2.0 for Video tools → Green screen, Bria VRMBG 3.0 for Video tools →
Remove background, and FeyNoBg for Layers → Remove background. The cloud halves are Bria's own hosted models on fal (the
green-screen despill and the guided cut-out).

```bash
npm run build -- video-key-corridorkey video-matte-vrmbg3 image-matte-feynobg
node validate-workflows.mjs video-key-corridorkey video-matte-vrmbg3 image-matte-feynobg --shared   # missing_node_type without the packs
```

| id | capability | what | validated here |
|---|---|---|---|
| `video-key-corridorkey` | bg-remove-video | hashu786's `CorridorKey2` node (Corridor's CorridorKey 2.0 code, unchanged) in VHS passes of `framesPerBatch` frames (48 by default), so memory stays flat on a long clip. Each pass is keyed at native resolution with no hint; `despill` 0.5 is Corridor's default, and its despill takes out green only. Outputs: the cut-out as a transparent WebM with the clip's sound (ProRes 4444 for `params.format` `prores_4444`), the matte as an H.264 MP4, and half-float EXR frames from every pass for `exr`; `params.matteOutput` keeps the cut-out, the matte or the clean foreground | no: the pack isn't on the CPU validation server; its class is read from the pack's source at the pinned commit |
| `video-matte-vrmbg3` | bg-remove-video | ComfyUI-RMBG's `AILab_VRMBG`: Bria's VRMBG 3.0, the model behind fal's `bria/video/background-removal/v3`, each frame read at 1024x1024 with the previous frame's cut-out; the same three outputs. The whole clip is decoded at once, so RAM grows with its length | no: same |
| `image-matte-feynobg` | bg-remove | ComfyUI-RMBG's `AILab_FeyNoBg`: a matting model for hair, fur, glass and lace, with no trimap and the edge refinement on → an RGBA PNG | no: same |

- **Node packs**: ComfyUI-CorridorKey2 at `d1228b68` (Corridor Key Licence 2.0), installed by default. It downloads
  CorridorKey 2.0 and the three frozen models it builds on (about 5.1 GB, into `models/corridorkey2/`) the first time it
  runs, never at import; Corridor's own weights come from the repository's main revision, not a pinned one.
  `CORRIDORKEY2_NO_DOWNLOAD=1` turns the download off. ComfyUI-RMBG moves to 3.3.0 (commit `a66a5e64`; there is no tag)
  for `AILab_VRMBG` and `AILab_FeyNoBg`; FeyNoBg needs the `nobg` package from the pack's requirements.
- **Weights**: VRMBG 3.0 is gated, and Bria approves access by hand. Put `config.json`, `model.safetensors` (0.88 GB),
  `model.py` and `vrmbg3_config.py` (revision `59716e19`) in `models/RMBG/VRMBG-3.0/`: the node never downloads them.
  FeyNoBg downloads its files (1.05 GB) from `1038lab/FeyNobg` into `models/RMBG/FeyNoBg/` on its first run.
- **Licences, as information**: CorridorKey 2.0 may be used in commercial projects but may not be offered as a paid API
  or inference service; VRMBG 3.0 is non-commercial without an agreement with Bria; FeyNoBg's weights state no licence;
  ComfyUI-RMBG's code is GPL-3.0.
- **GPU**: CorridorKey 2.0 needs NVIDIA CUDA, an RTX 30-series card or newer (4 GB up to 1440p, 6 GB for 4K). VRMBG's
  6 GB and FeyNoBg's 4 GB are the entries' `vramGb`.
- **Not run**: nothing has run on a GPU. `tests/keying.test.ts` checks the graphs against the packs' source, the passes
  and the formats.

### Edit speech and AuK speech (nm10-speech-edit)

Two hand-built graphs on Tencent AuK's own nodes (ComfyUI-AuK, the `comfyui/ComfyUI-AuK` folder of Tencent-Hunyuan/AuK,
pinned at `0d40366b`, MIT) for Audio → Edit speech and AuK in Audio → Speech, on your GPU only: AuK is hosted on neither
fal nor Replicate.

```bash
npm run build -- speech-edit-auk speech-tts-auk
node validate-workflows.mjs speech-edit-auk speech-tts-auk --shared   # missing_node_type without ComfyUI-AuK
```

| id | capability | what | validated here |
|---|---|---|---|
| `speech-edit-auk` | speech-edit | A recording (or a video's soundtrack, through `LoadAudio`) and the edit windows Fuobe plans (`params.extra.speechWindows`). The provider rebuilds the graph for every window in one prompt (`expandSpeechEditWorkflow` in `src/lib/av/speech-edit-graph.ts`): each window is cut out, edited by `AuKGenerateEdit` (one shared `AuKModelLoader`) with the instruction Fuobe writes (replace, add or remove words; pitch, pace, volume, emotion, whisper, clean-up, keep one speaker), and crossfaded back over 0.12 s at each end with the fade Fuobe uploads (`fadeCurve`). A window keeps at least 1 s of untouched speech on each side, is cut at silences, and fits AuK's 30 s with its new audio. AuK-Flash at 4 steps by default, the base model at 32 steps for "best"; the Prompt Enhancer is off. FLAC | no: the pack isn't on the CPU validation server; the graphs are checked against the node list in its `nodes.py` at the pinned commit. The joins ran on the CPU ComfyUI with a stand-in for AuK |
| `speech-tts-auk` | tts | AuK text to speech: a voice sample and the line, or a voice made from its description when there is no sample; AuK-Flash, 4 steps. FLAC | no: same |

- **Node pack** (opt-in, `AUK=1` in `install-comfyui.sh`): the whole AuK repository is cloned into `$COMFYUI_DIR/AuK` at
  the pinned commit, installed editable with its `[comfyui]` extra, and its node folder is linked into `custom_nodes`, so
  its checkpoint paths (`ckpts/…`) resolve inside that checkout. `AUK_WEIGHTS=1` also downloads AuK-Flash and the
  Qwen2.5-Omni-3B encoder into `AuK/ckpts` at pinned revisions (the weights are about 19 GB); `AUK_BASE=1` adds the
  32-step base model.
- **Licences, as information**: AuK's code and weights are MIT; its Qwen2.5-Omni-3B encoder is under the Qwen Research
  License, which makes the whole non-commercial in practice.
- **GPU**: an NVIDIA GPU. AuK's README gives a peak of about 25 GiB, about 17 GiB with the loader's CPU offload
  (`vramGb` 24). English and Chinese.
- **Not run**: AuK itself has not run here. `tests/speech-edit-comfy.test.ts` checks the graphs and their expansion.

### World mode (nm10-hy-nomas-world)

One hand-built graph for Cinema's World mode on Nynxz's ComfyUI-HyNomas (Apache-2.0, pinned at `a89e0515`, no Python
dependencies, not in the Comfy Registry), installed by default. Importing it registers the Hy-Nomas model and its
PixelUMM decoder with the core loaders. Nobody hosts Hy-Nomas, so World mode is on your GPU only.

```bash
npm run build -- world-hy-nomas-turn
node validate-workflows.mjs world-hy-nomas-turn --shared   # missing_node_type without ComfyUI-HyNomas
```

| id | capability | what | validated here |
|---|---|---|---|
| `world-hy-nomas-turn` | world-turn | One turn of a world, from the pack's `nomas_world` example on core loaders (`UNETLoader` with the int8 distilled model, `CLIPLoader` qwen_image with Qwen2.5-VL 7B, `VAELoader` with the PixelUMM decoder). The provider rebuilds it for every run (`expandWorldWorkflow` in `src/lib/world.ts`): the opening (`Nomas World Prompt` → `Nomas World`, 1280x704, 8 Euler steps) and one `Nomas World Continue` per turn up to the one asked for, each flying that turn's camera move (`src/lib/world-path.ts`), then `TrimVideoLatent` keeps this turn's latents for the decode → a 24 fps clip. ComfyUI reuses the earlier turns' outputs while it still holds them, so only the new turn is made; after another job or a restart they are made again from the same seed. No sound and no image input | no: the pack isn't on the CPU validation server; checked against the node definitions in its source at the pinned commit |

- **Weights**, from nynxz/Hy-Nomas and pinned in `model-pins.json`: the int8 distilled model (8.97 GB) and the PixelUMM
  decoder (15.78 GB), with the bf16 Qwen2.5-VL 7B encoder Kandinsky 6.0 uses too (16.58 GB). The bf16 model (17.11 GB)
  is optional, a base for LoRA merges, never needed for a run.
- **Licences, as information**: the Hy-Nomas model and the pack are Apache-2.0; the PixelUMM decoder is under NVIDIA's
  One-Way Noncommercial License.
- **GPU**: the port's author measured about 21 s per 3 s turn, plus about 4 s of decode per 10-latent window, on an RTX
  5090 at 1280x704 in int8; plan on a 24 GB card (`vramGb` 24, not measured here).
- **Not run**: no turn has run on a GPU. `tests/world-mode.test.ts` checks the rebuilt graph.

### MiniMax H3 in 2K from a saved latent (n7-10)

Two hand-built graphs from rdh9616's "Prompt to 2K" and "Decode Saved Latent" examples, on rdh9616's pack (the finish
also on LBH's, like `video-regenerate-h3` above; both opt-in, `OPEN_H3_REGEN=1`): MiniMax H3's 2K on your GPU in the
Video studio and Cinema, and Cinema's Finish in 2K. Both are held with Regenerate: built, but not offered until
Regenerate has run on a card that fits it (`REGEN_OFFERED` in `src/lib/catalog/regenerate.ts`). The cloud's 2K takes
and Finish in 2K run on fal's MiniMax H3 and don't use them.

```bash
npm run build -- video-h3-t2v-2k video-regenerate-h3-latent
node validate-workflows.mjs video-h3-t2v-2k video-regenerate-h3-latent --shared   # missing_node_type without the packs
```

| id | capability | what | validated here |
|---|---|---|---|
| `video-h3-t2v-2k` | t2v | The draft half of "Prompt to 2K": MiniMax H3 text to video with sound at 768p (the pruned int8 FL2VA model with LightX2V's FL2V Turbo 4-step v1.2 LoRA, 6 steps, er_sde, CFG 1). Between the sampler and the decoder, `OpenH3SaveRefinedLatent` saves the 768p latent with its soundtrack to `output/open_h3_latents/<latentPrefix>_00001.safetensors`, named after the run. 32 GB | no: `missing_node_type` (the pack isn't on the CPU validation server) |
| `video-regenerate-h3-latent` | upscale-video | `video-regenerate-h3` started from that latent instead of a clip: `OpenH3LoadRefinedLatent` reads it by name (`latent`), so it runs on the ComfyUI that made the draft; the LBH upscaler puts it on the target grid (`resolution`), the refine re-noises it to `startSigma` and runs 3 steps with the prompt, the fast H3 decoder decodes it, and the draft's own sound goes back at 24 fps. No decode and re-encode in between. 48 GB | no: same |

- **The hand-off**: the draft keeps its latent only on a ComfyUI where files stay between jobs (not the owner's workers),
  and while its Turbo LoRA is switched on. The finish loads it only from the same account's draft (or the owner's) on
  that same ComfyUI; otherwise it runs `video-regenerate-h3` on the draft's clip (`tests/regenerate-latent.test.ts`).
- **Weights**: one new file, LightX2V's FL2V Turbo 4-step v1.2 LoRA (1.96 GB, Apache-2.0, at `3ec17a3`, pinned in
  `model-pins.json`); the rest are the H3 and Regenerate files above.
- **Not run**: nothing has run on a GPU. rdh measured about 2 minutes for a 5 s draft on a 72 GB RTX PRO 5000.

### WorldCast's person mask (N7-9)

One hand-built graph on core nodes for the WorldCast worker's cases (model `oss-person-mask`, hidden). WorldCast itself
doesn't run in ComfyUI: it runs on the optional worker (`workers/worldcast/`, `docs/workers/worldcast.md`), after
ComfyUI has made the still's depth (MoGe 2 by default, `scene-mesh-moge`) and these masks
(`src/lib/catalog/worldcast-plan.ts`).

```bash
npm run build -- image-person-mask-sam3
node validate-workflows.mjs image-person-mask-sam3 --shared
```

| id | capability | what | validated here |
|---|---|---|---|
| `image-person-mask-sam3` | bg-remove | `SAM3_Detect` finds the words (`prompt`, "person" by default; `threshold` 0.4; every match merged into one mask) → `MaskToImage`: white where the person is, the size of the picture. The worker cuts its tight crops of the still and of each view from it. SAM 3.1 (1.75 GB) only; 4 GB | yes (`/prompt` only) |

## Adding a workflow

1. Find the template name in `$COMFYUI_DIR/.venv/lib/python3.*/site-packages/comfyui_workflow_templates_json/templates/index.json`
   (or a custom-node `example_workflows/*.json`), run `node export-templates.mjs <name-or-path>`.
2. Inspect `build/raw/<key>.api.json` (node ids like `129:98` = subgraph instance 129, inner node 98).
3. Add an entry to `library.spec.mjs` (bindings must target literal widget inputs, not links — the build fails otherwise).
4. `npm run build -- <id> && node validate-workflows.mjs <id>`.

## Known environment issues

- `ComfyUI-SeedVR2_VideoUpscaler` (numz) does not register on CPU-only hosts: its loaders build the device
  combo from CUDA/MPS devices and crash with `list index out of range`. The library uses the **native**
  SeedVR2 nodes of core ComfyUI instead (official templates `utility_seedvr2_*`).
- `ComfyUI-RMBG` imports its SAM3 module eagerly; without `triton`, `decord` and `pycocotools` the whole
  pack fails to load (its error handler itself raises `NameError: module_name`). They are installed by `install-comfyui.sh`.
- `ComfyUI-Frame-Interpolation`: cupy is not installed (CPU); RIFE works without it.
- `ComfyUI-ReActor` downloads ~1 GB of face-restore weights into `models/facerestore_models` whenever that
  folder is empty, even on `GET /object_info`; `install-comfyui.sh` drops a zero-byte placeholder there (skip with `REAL_MODELS=1`).
  It also logs a harmless `KeyError: 'ultralytics_bbox'` for its unused `ReActorMaskHelper` node on `/object_info`.
- Some nodes download weights the moment they *execute* (ComfyUI-RMBG, RIFE VFI, WanVideoWrapper wav2vec, ReActor
  detectors). The validator therefore never lets a validation prompt reach the worker (see the blocker above). An
  earlier naive version (POST, then interrupt) let ComfyUI-RMBG start fetching BEN2; that file was deleted.
- Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` (set in `npm run build`).
