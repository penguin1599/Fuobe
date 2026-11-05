// Curated definition of every workflow Fuobe ships for its open-source (ComfyUI) engine.
//
// Each entry starts from either
//   export:    a source exported to API format by export-templates.mjs (official template
//              name, or a custom-node example workflow path relative to COMFYUI_DIR), or
//   handBuilt: an API-format JSON in scripts/comfy/hand-built/
// then applies `transforms` (see lib/graph.mjs), and declares bindings/outputs/etc.
//
// build-library.mjs turns this into workflows/comfyui/<id>.json + manifest.json.
// Node ids in bindings refer to the FINAL workflow (after transforms). Ids like "129:98"
// are subgraph-instance ids produced by the frontend's graphToPrompt (subgraph 129, inner node 98).
//
// Binding vocabulary (manifest "bindings" keys):
//   prompt, negativePrompt, image, image2, image3, image4, mask, endImage, video, audio,
//   width, height, frames, fps, seed, steps, cfg, guidance, denoise, shift,
//   loraHigh, loraLow, lora, loraStrength, upscaleModel, scale, duration, lyrics, tags
// Extra keys introduced by this library (documented in docs/research/comfyui-workflow-library.md):
//   padLeft, padTop, padRight, padBottom  (outpaint padding, px, multiples of 8)
//   cameraMotion                          (Wan Fun Camera preset name)
//   multiplier                            (frame-interpolation factor, int)
//   bpm                                   (ACE-Step tempo)
//   filenamePrefix                        (every output node's filename_prefix; optional)
// Keys added with the comfyui-oss-2 workflows (docs/research/comfyui-oss-2.md):
//   audio2                                (second audio upload: dialogue speaker B / voice-change target voice)
//   video2, video3, video4                (further video uploads: shots 2..4 of video-concat-*)
//   language                              (Chatterbox Multilingual language, combo string e.g. "German (de)")
//   exaggeration, temperature             (Chatterbox emotion exaggeration 0.25-2 / sampling temperature 0.05-2)
//   contextFrames                         (video-extend: known tail frames of the source fed as context, multiple of 4)
//   tracks                                (Wan-Move motion paths: JSON string [[{"x":px,"y":px}, ... one per frame], ...])
//   motionStrength                        (Wan-Move track conditioning strength, float, default 1)
//   strength                              (ColorTransfer strength 0-10, default 0.8)
// Keys added with the comfyui-oss-3 workflows (docs/research/comfyui-oss-3.md). The provider fills the ones marked *
// from Fuobe's canonical request; every other key is a model slider/control (params.extra[key]):
//   startTime*                            (trim start, seconds: params.startTime)
//   startFrame*                           (frames to skip after resampling: round(params.startTime * fps))
//   numLayers*                            (Qwen-Image-Layered: how many RGBA layers, params.numLayers)
//   maxSize                               (longest side the input is scaled to, px)
//   paletteText*, paletteImage*           (Soul HEX: "Color palette: #..." and the swatch PNG rendered from params.palette)
//   method                                (ColorTransfer method: mkl_lab | reinhard_lab | histogram)
//   controlStrength                       (ControlNet / VACE control strength)
//   framesPerBatch                        (VHS meta-batch size: frames per re-queued pass)
//   checkpoint                            (checkpoint file name, e.g. Stable Audio 3 small vs medium)
//   description                           (ThinkSound chain-of-thought sound description)
//   instruction*                          (LLM instruction; "{language}" is replaced with params.targetLanguage)
//   maxTokens                             (TextGenerate max_length)
//   sourceLanguage*                       (ASR language combo, e.g. "English"; params.sourceLanguage, "auto" = detect)
//   asrModel, hints, maxChars             (Qwen3-ASR model id, context hotwords, max characters per caption cue)
//   backgroundVolumeDb                    (mux: background stem gain in dB)
//   startStep, audioScale                 (InfiniteTalk V2V: first re-denoised step, audio conditioning scale)
//   lengthMode, lipsExpression            (LatentSync VideoLengthAdjuster mode, lips expression strength)
//   whisperModel                          (ComfyUI-Whisper model name)
//   fontSize, fontColor, captionPosition  (caption style: % of the frame height / Whisper px, colour, top | bottom)
//   textureSize, turntableFps             (TRELLIS.2 baked texture size, turntable video fps)
//   octreeResolution                      (Hunyuan3D 2.1 mesh resolution)
//   columns, rows                         (ImageGridtoBatch: how the sheet is cut into tiles)
//   gridPrompt, sheetPrompt               (contact-sheet / turnaround framing text placed before the prompt)
// Keys added with the nm10-flux3-klein workflows (research #10 §6.3):
//   image5 … image10                      (further reference images: FLUX 3 Image Klein's edit takes up to 10)
// Keys added with the full-song workflows (new-models-10 §6.6). * = the provider fills it from the canonical request:
//   tiledDecode*                          (MiniMax Music 3: decode the song in tiles, less VRAM; on for songs over 2 minutes)
// Keys added with the av-tools workflows (Wave B):
//   frameIndex                            (Extract frame: which frame of the Trim Video window, -1 = its last, 0 = its first)
// Keys added with the comfyui-oss-4 workflows (docs/research/comfyui-oss-4.md). * = the provider fills it from the
// canonical request (params.*), the rest are model sliders/controls (params.extra[key]):
//   maskPrompt*                           (SAM 3.1 text prompt: what to remove / replace in a video)
//   maskGrow                              (px the tracked mask is grown by: covers edges and contact shadows)
//   skipPass2                             (VOID: pass 1 only, half the time)
//   zoomStart*, zoomEnd*                  (Ken Burns zoom, 1 = the widest crop with the output's shape: params.zoomFrom / zoomTo)
//   panStartX*, panStartY*, panEndX*, panEndY* (Ken Burns crop centre, 0-1 of the still: params.panFrom / panTo {x, y})
//   easeInOut*                            (Ken Burns: 1 = ease in-out, 0 = linear: params.easing)
//   supersample, chunkFrames              (Ken Burns: still upscale before cropping, frames per encoded chunk)
//   crossfade*, headroomDb                (audio loop / join: crossfade seconds; dB taken off before the seams are summed)
//   fadeCurve*                            (audio loop / join: the crossfade curve WAV the provider writes and uploads)
//   format*, profile*                     (VideoHelperSuite format and ProRes profile: params.format)
//   peakNits                              (SDR to HDR: target peak white)
//   resolutionLevel, fovX, decimation     (MoGe: inference detail 0-9, horizontal field of view in degrees (0 = estimate), mesh decimation)
//   cutout, numGaussians, splatFormat     (TripoSplat: BiRefNet cut-out on/off, number of Gaussians, ply | ksplat | spz)
//   photoCrop                             (Idol 3D, idol-9 §5.5: true = the looser photo crop, a core-node branch after TripoSplatPreprocessImage)
//   cropMode, minOpacity, maxScale        (Idol 3D with ComfyUI-Idol, idol-9 §5.6: IdolPreprocessImage synthetic | real; IdolPruneSplat's opacity floor and longest axis, 0 = off)
//   orbitFrames                           (TripoSplat orbit preview length in frames)
//   frameWidth                            (reference brief: width the clip's frames are scaled to, px)
// Keys added with round 4 (engine seams):
//   curveMode, filterSpeckle, colorPrecision (VTracer: spline | polygon | none curves, specks dropped (px), colour precision bits)
// Keys added by the remove-object package (round 4):
//   colormap*                             (Video Depth Anything's colour map: gray | inferno; params.colormap grayscale → gray)
//   sideBySide                            (depth maps: the original clip next to the depth map)
// Keys added with the round-4 video-finish workflows (FPS Boost, chunked upscaling, HDR formats). * = the provider fills it:
//   every*                                (FPS Boost: keep every n-th interpolated frame; source fps x multiplier / every = the target)
//   slowdown*                             (FPS Boost: slow-motion factor, params.slowdown; the output fps is divided by it)
//   shortSide*                            (chunked upscalers: the output's shorter edge in px, params.resolution: 1080p -> 1080)
//   colorSpace*                           (SDR to HDR: CreateVideo color space, "HDR" = BT.2020 HLG, "HDR PQ" = BT.2020 PQ (HDR10): params.format)
// Keys added with Fuobe Soul (Originals O2):
//   megapixels*                           (image to image: the picture scaled to about this many megapixels, Soul's tier: 1 = 720p, 2 = 1080p)
// Output fields beyond {node, kind}: stem ("voice" | "background"), role ("cues" | "transcript" | "language" |
// "sheet" | "tiles" | "layers" | "first-frame" | "turntable" | "lines" | "frame" | "frames" | "scene" | "depth" | "splat" |
// "brief" | "mask" (a painted eraser's last tracked frame, white = the object) | "cutout" | "matte" (a matte graph's transparent
// and black-and-white videos: params.matteOutput keeps one)). Entry fields: worker "isolated" (needs its own ComfyUI, see README), expand "captions" (the provider writes one
// segment per caption cue before submitting), "timeline", "videos" / "audios" (one loader per clip in inputs.videos / audios),
// optionalModels (files a model control can pick instead of the graph's own,
// listed in the manifest with optional: true so missing-model help can name their download),
// runtimeNodes (classes the app adds per run, e.g. expandH3References' clip loaders, counted as the graph's for its packs), packs (node packs the validation server lacks, see PACK_CLASSES; listed in customNodes), modelUrls (a file's
// download at a pinned revision for this workflow, over KNOWN_MODELS).
// Keys added with Genjutsu's Character swap (O5, docs/research/openjutsu-6.md). * = the provider fills it:
//   quality*                              (H3 PrepareVideo resolution "480" | "768": params.resolution 480p / 768p)
//   selection, subjectIndex               (who to swap: largest | leftmost | rightmost | index, and the index)
//   positiveCoords*, negativeCoords*      (SAM3_Detect clicks: JSON [{"x","y"}] in the prepared first frame's pixels: params.points)
//   audioGuide, useMask                   (H3 audio guide; masked regeneration off = the whole frame)
//   windowFrames, historyFrames           (H3 window plan: "124" / "18", strings of the pack's combos)
// Keys added with the rebranded open tools and Speak (Originals O11). Model settings (params.extra) or a route's own graph
// defaults (ModelRoute.extra), except * which the provider fills:
//   scheduler, motionFrame, colormatch    (kijai's InfiniteTalk: WanVideoSampler solver, motion frames, colour match method)
//   audioCfg                              (MultiTalkWav2VecEmbeds audio guidance)
//   threshold, mosaicScale                (face mosaic: SAM3_Detect threshold; the mosaic's scale, 0.04 = blocks of 25 px)
//   prompt*                               (face mosaic: what SAM 3.1 pixelates, "face" when the run gives no words)
// Keys added with DBS soundtrack separation (docs/research/dbs-separation-7.md §4). * = the provider fills it:
//   separationModel*                      (DBSLoader model: DBS-BSRNN-DnR (fast) | DBS-TIGER-DnR (best); params.extra.separationModel,
//                                          else the host's pick: TIGER when /system_stats says the device is cuda, BSRNN on a CPU)
//   channels*                             (DBSSeparate channels: mono | each channel; params.extra.channels, "mono" for inputs with
//                                          more than 2 channels, which ComfyUI can't save, with node 4 rewired to music + effects)
// Keys added with MOSS-Image (docs/research/new-models-7.md §4.6). Model settings (params.extra; MOSS-Image's Quality control writes them):
//   sampler, scheduler                    (KSampler sampler_name / scheduler)
//   unet                                  (UNETLoader file: the Fast tier's drop-in 8-step DMD file, listed in optionalModels)
// Keys added with Design a voice. * = the provider fills it:
//   voiceDescription*                     (the voice in words: params.voiceDescription, op voice-design)
//   voiceTranscript*                      (what the voice sample says: params.voiceTranscript, or a saved voice's line)
//   device*                               (VoxCPM2's device combo: the server's first torch device, cuda | mps | cpu)
// Keys added with Kandinsky 6.0 (nm10-kandinsky6). * = the provider fills it:
//   upscalerScale*                        (Kandinsky VSR's latent upscaler bank entry: "4x" for 4x, "2x" for 2x and 2.25x; scale* is params.resolution)
// Keys added with Hi3D mesh refinement (hi3d-refine). * = the provider fills it:
//   model3d*                              (Hi3DLoadMesh: the coarse GLB, uploaded like any input: inputs.model3d)
//   meshResolution                        (Hi3DRefine resolution 512 | 1024 | 1536: params.extra.meshResolution)
//   cpuOffload                            (Hi3DModelLoader sequential CPU offload, on by default)
// Entry field requiredModels: files a loader reads by a name with no extension (DBSLoader's model folder), listed in the
// manifest like any model (KNOWN_MODELS keys are the path under the folder, e.g. 'DBS-BSRNN-DnR/model.safetensors'), so the
// Workflows page's presence check and its install commands cover them.
// Keys added with Green screen (nm10-keying). * = the provider fills it:
//   despill                               (CorridorKey2 despill_strength 0-1, 0.5 = Corridor's default; params.extra.despill)
//   format*, profile*                     (the cut-out's VHS_VideoCombine: video/webm + yuva420p, or video/ProRes + 4444 for params.format prores_4444)
// Keys added with Clean up voice (NVIDIA RE-USE, ComfyUI-RE-USE). * = the provider fills it:
//   reuseModel*                           (REUSELoader model: the file for params.extra.reuseModel voice | laughter, refused in words when
//                                          GET /models/reuse doesn't list it)
//   rate*                                 (REUSEEnhance rate: source | source up to 24000 | source up to 16000 | 8000-48000; params.extra.rate,
//                                          "auto" = the host's pick: the source's rate on CUDA, at most 24 kHz on a CPU, 16 kHz past 2 minutes)
//   roomToneDb, level, bedDb              (REUSEEnhance room_tone_db (-60 = off), level match input | -16 LUFS | off, bed_db)
//   channels*                             (REUSEEnhance channels, and DBSSeparate's in the bed graph: the DBS rules)
// Keys added with Clean up dialogue (DBS D5, docs/research/dbs-separation-7.md §4.4 graph C), params.extra:
//   voiceDb, musicDb, effectsDb          (AudioAdjustVolume volume on the speech, music and sfx stems: whole dB, -100..100, 0 = as is)
// Keys added with the owner's SOTA image families (2026-10-31), model controls (params.extra):
//   preset                                (Ideogram 4's sampling preset by name: Quality | Default | Turbo, the graph's own table)
// Keys added with Open-H3 Regenerate (n7-3, docs/research/new-models-7.md §2.6). * = the provider fills it:
//   resolution*                           (OpenH3RegenUpscale's output size as the pack's string: params.resolution 1080p / 1440p / 2160p
//                                          -> "1080p (1920x1080)" | "2k (2560x1440)" | "4k (3840x2160)")
//   draftSize*                            (OpenH3RegenPrepareDraft's size: "768p (1344x768)" for H3 drafts, "576p (1024x576)" for other
//                                          models, whatever the shape: the pack upscales to 16:9 or 9:16 only; regenerate.ts draftSizeFor)
//   startSigma                            (OpenH3RegenSigmas start noise: the Creativity control, 0 = the release 0.909 grid)
// Keys added with the NVIDIA RTX Video nodes (nm10-rtx-video, docs/research/new-models-10.md §6), a model control (params.extra):
//   rtxQuality                            (RTX Video Super Resolution quality: ULTRA | HIGHBITRATE_ULTRA …; Frame Generation mode: LOW | MEDIUM | HIGH)
// Entry field gpu: the card a graph's nodes need, which the GPU pre-flight checks by the card's name: "nvidia-rtx" (an NVIDIA
// RTX card) or "nvidia-rtx-40" (RTX 40 series or later). The manifest and requirements.json carry it.
// Keys added with Any Angle (any-angle-3d, any-angle-shot), each angle's camera from src/lib/catalog/any-angle.ts (params.extra):
//   splatFile*                            (Load3D model_file: the 3D build's .spz, uploaded like any input; Load3D's own check
//                                          takes any file in the input folder. The provider points its image entry at the photo)
//   cameraYaw, cameraPitch, cameraDistance, cameraFov (CreateCameraInfo orbit: degrees, degrees, splat units, degrees)
//   targetX, targetY, targetZ             (CreateCameraInfo look-at point: a close-up aims at the face's height)
// Output roles added with Any Angle: "sweep" and "sweep-mask" (the turntable at 192 px as lossless animated WebP, colour and
// coverage, that the server measures the photo's front view on), "mesh" (a GLB made from a splat, for the 3D viewer).
// Keys added with Head Swap, model controls (params.extra):
//   maskBlur                              (GrowMaskWithBlur blur radius of a paste-back edge, px)
//   pasteBack                             (true: only the masked area comes from the edit, the rest is the input's pixels)
// Keys added with the Outfit Swap app. Model settings (params.extra; the app's Shoes choice writes it):
//   request                               (the sentence after the swap: "Replace everything they wear." | "Keep their own shoes and legwear.")
// Keys added with the Watermark Remover (ComfyUI-Qwen-Watermark). * = the provider fills it:
//   boxes*                                (QWMDetect boxes_json: the marks the visitor kept, params.extra.boxes, checked and rebuilt
//                                          by src/lib/watermark.ts: pixels, 1-32 boxes clamped to the picture, known types only)
//   detectMode*                           (QWMDetect mode: manual_boxes with boxes, manual_mask on the brush graph, else auto_qwen)
//   detectExpand*                         (QWMDetect expand: 0 for the kept marks, whose boxes carry the scan's margin; 20 in auto_qwen)
//   maxSize*                              (here QWMPrepare max_side on both passes: 1024; 1536 past 3000 px; 768 on a GPU under 16 GB)
// Output role "quality": a node's JSON verdict on the run (QWMFinal), folded into the image outputs' meta.quality.
// Output role "scan-tile": a tile's QWMDetect report (the scan's four quarters, in scanTiles order), merged by the provider
// into the "report" output (mergeScanReports in src/lib/watermark.ts), never a result of its own.

import fs from 'node:fs';

const b = (node, input) => ({ node, input });
// A literal input of a hand-built graph (instructions the provider writes back through defaults.instruction).
const handBuiltInput = (file, node, input) => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'))[node].inputs[input];

export const CUSTOM_NODE_REPOS = {
  'ComfyUI-WanVideoWrapper': 'https://github.com/kijai/ComfyUI-WanVideoWrapper',
  'ComfyUI-VideoHelperSuite': 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite',
  'ComfyUI-KJNodes': 'https://github.com/kijai/ComfyUI-KJNodes',
  'ComfyUI-Frame-Interpolation': 'https://github.com/Fannovel16/ComfyUI-Frame-Interpolation',
  'ComfyUI-RMBG': 'https://github.com/1038lab/ComfyUI-RMBG',
  'ComfyUI-ReActor': 'https://github.com/Gourieff/ComfyUI-ReActor',
  'ComfyUI-MMAudio': 'https://github.com/kijai/ComfyUI-MMAudio',
  'ComfyUI_Fill-ChatterBox': 'https://github.com/filliptm/ComfyUI_Fill-ChatterBox',
  'ComfyUI-IndexTTS2': 'https://github.com/snicolast/ComfyUI-IndexTTS2',
  'ComfyUI-Video-Depth-Anything': 'https://github.com/yuvraj108c/ComfyUI-Video-Depth-Anything',
  // comfyui-oss-3 packs (pinned in install-comfyui.sh)
  'ComfyUI-MelBandRoFormer': 'https://github.com/kijai/ComfyUI-MelBandRoFormer',
  'ComfyUI-QwenASR': 'https://github.com/1038lab/ComfyUI-QwenASR',
  'ComfyUI-HunyuanVideo-Foley': 'https://github.com/phazei/ComfyUI-HunyuanVideo-Foley',
  'ComfyUI-Whisper': 'https://github.com/yuvraj108c/ComfyUI-Whisper',
  // round 4 (engine seams): VTracer image → SVG
  'ComfyUI-ToSVG': 'https://github.com/Yanick112/ComfyUI-ToSVG',
  // isolated worker only (process-wide side effects / old pins), see scripts/comfy/README.md
  'ComfyUI-LatentSyncWrapper': 'https://github.com/ShmuelRonen/ComfyUI-LatentSyncWrapper',
  'ComfyUI-ThinkSound_Wrapper': 'https://github.com/ShmuelRonen/ComfyUI-ThinkSound_Wrapper',
  // Genjutsu's Character swap (docs/research/openjutsu-6.md): Akatz Labs' H3 nodes, GPL-3.0. Not installed on the
  // validation server (entries list them with `packs`); install-comfyui.sh pins both.
  h3_character_swap: 'https://github.com/akatz-labs/h3-character-swap-tool/tree/0670e4fdf95adf2262caa4b81afed2a9c4ae4b7b/worker_nodes/h3_character_swap',
  'h3-relay': 'https://github.com/akatz-ai/h3-relay/tree/e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220',
  // DBS soundtrack separation (docs/research/dbs-separation-7.md §4): pinned in install-comfyui.sh, not on the validation server.
  'ComfyUI-DBS': 'https://github.com/hiroki-abe-58/ComfyUI-DBS/tree/f656e53434b5485c148a2866fbd6ddc6b6152ed6',
  // Restore & colourise (package archive-restore): Lightricks' LTX nodes, pinned in install-comfyui.sh, not on the validation server.
  'ComfyUI-LTXVideo': 'https://github.com/Lightricks/ComfyUI-LTXVideo/tree/220e1d45aa0469f518e982102fca4dca92a61862',
  // Owner's SOTA image families (2026-10-31): AusBoss's crop, pad and stitch nodes (Qwen-Image 2.1 inpaint and expand), MIT.
  'ausboss-nodes': 'https://github.com/ausboss/ComfyUI-AusBoss',
  // Krea 2 edits (the owner's SOTA families, 2026-10-31): the Krea 2 Identity Edit nodes, and Ostris' edit nodes that
  // Krea 2 Inpaint needs (not installed on the validation server: krea2-inpaint / krea2-outpaint list it with `packs`).
  'comfyui-krea2edit': 'https://github.com/lbouaraba/comfyui-krea2edit',
  'ComfyUI-Krea2-Ostris-Edit': 'https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit',
  // MiniMax H3 video (minimax-h3-t2v / i2v / flf2v): larryvrh's turbo LoRA loader and sampler (Apache-2.0, v1.2.3) and
  // PlagueKind's SLA attention and AdaLN LoRA fix (MIT, v1.5.6; the SLA kernel needs Triton). Pinned in install-comfyui.sh.
  'ComfyUI-MiniMax-H3-Turbo': 'https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo/tree/77bfa67575b14e3be6214f1747732e540c68b5dd',
  'plaguekind-nodes': 'https://github.com/PlagueKind/ComfyUI-PlagueKind-Nodes/tree/d58d006a4ea32c25c06499f2ff104f0852a045a6',
  // Open-H3 Regenerate 2K (Upscale → Video's Regenerate · creative, docs/research/new-models-7.md §2.6): rdh9616's refine
  // nodes (Apache-2.0) and the H3 latent upscaler they call by class name (LBH-123-AI, MIT). Opt-in in install-comfyui.sh
  // (OPEN_H3_REGEN=1); not on the validation server (video-regenerate-h3 lists both with `packs`).
  'ComfyUI-Open-H3-Regenerate': 'https://github.com/rdh9616/ComfyUI-Open-H3-Regenerate/tree/9b686c5ffd380e9d1351f9b8beef6d20d703ca3e',
  Comfyui_Minimax_h3_latent_Upscaler: 'https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/tree/40316cf008b2fd8663263270669eb4da23f89d2c',
  // Clean up voice (NVIDIA RE-USE): Fuobe's own pack, in this repository (comfy-nodes/ComfyUI-RE-USE), pinned at the commit
  // that last changed it (tests/reuse-pack-pin.test.ts checks it). install-comfyui.sh copies it from the checkout.
  'ComfyUI-RE-USE': 'https://github.com/workingprototype/Fuobe/tree/8cc0417b5cb8a603f06502d97d5c6d8c6035ea0d/comfy-nodes/ComfyUI-RE-USE',
  // Hi3D 1.0 mesh refinement (hi3d-refine, docs/research/hi3d-refine.json): T8star's nodes (MIT code, vendored Hi3D code under
  // the Hi3D Open License 1.0), v0.5.1. Opt-in in install-comfyui.sh (HI3D=1): it needs an Ampere-or-newer NVIDIA GPU and
  // CUDA kernels (spconv, triton), so it is not on the validation server (mesh-refine-hi3d lists it with `packs`).
  'Comfyui-Hi3d-T8': 'https://github.com/T8mars/Comfyui-Hi3d-T8/tree/73848490976e6a9b0c735ce02984c03866a495e7',
  // Live edit: Fuobe's own node file (src/lib/comfy-live-nodes.ts), shipped with Fuobe rather than cloned from a repo.
  'fuobe-live': 'https://github.com/workingprototype/Fuobe',
  // Qwen-Image 2.1 on a 16 GB card: recoilme's Zen Image Edit nodes (Qwen3.5-0.8B encoder + fusion adapter),
  // Apache-2.0 code, release v2 (adapter_v12). Not on the validation server (needs transformers >= 5.17; the pinned
  // ComfyUI's venv has 5.22.1).
  'zen-image-edit-comfyui': 'https://github.com/recoilme/zen-image-edit-comfyui/tree/7a29e58c973b84798df926e3251727884fdacc2d',
  // NVIDIA RTX Video: Comfy-Org's NVIDIA VFX nodes 0.2.1 (Apache-2.0; registry comfyui_nvidia_rtx_nodes) over NVIDIA's
  // nvidia-vfx runtime (RTX Video SDK, NVIDIA Software License Agreement). An NVIDIA RTX card only (frame generation: RTX 40
  // or later) and a CUDA PyTorch: install-comfyui.sh adds it on an NVIDIA RTX host only; never on the validation server.
  ComfyUI_Nvidia_VFX_Nodes: 'https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes/tree/38d790ded00650681fa3645362efe28c8560cf40',
  // Design a voice: 1038lab's Qwen3-TTS nodes (GPL-3.0 code, Apache-2.0 weights) and Saganaki22's VoxCPM2
  // nodes (Apache-2.0). Neither is on the validation server; both download their weights from Hugging Face on first run.
  'ComfyUI-QwenTTS': 'https://github.com/1038lab/ComfyUI-QwenTTS/tree/d8122a8ba835b65fd65c113d2b273b1ad1579293',
  'ComfyUI-VoxCPM2': 'https://github.com/Saganaki22/ComfyUI-VoxCPM2/tree/0e52a6cd006769e030d0e1ae907ffebbbfac4f5f',
  'ComfyUI-CorridorKey2': 'https://github.com/hashu786/ComfyUI-CorridorKey2/tree/d1228b68796786acee92b6497f72a60d70d1a844',
  // nm10-speech-edit: Tencent AuK's own ComfyUI nodes (MIT), the comfyui/ComfyUI-AuK folder of its repository. Not on the
  // validation server (the auk package and ~19 GB of weights): its graphs are checked against the node list read from
  // nodes.py at this commit (tests/speech-edit-comfy.test.ts).
  'ComfyUI-AuK': 'https://github.com/Tencent-Hunyuan/AuK/tree/0d40366b1039e37c6cad008ab4713f6ad6d954b7/comfyui/ComfyUI-AuK',
  // idol-2 (docs/research/idol-9.md §5.1-5.2): Nynxz's Idol nodes (crop modes, predicted camera, splat pruning), Apache-2.0,
  // no Python dependencies and no model code. Pinned in install-comfyui.sh; not on the validation server.
  'ComfyUI-Idol': 'https://github.com/Nynxz/ComfyUI-Idol/tree/4d3a4f671028f0e062d9f004cda1a2dd73360d35',
  // Kandinsky 6.0 (nm10-kandinsky6): Kandinsky Lab's own packs, on the Comfy Registry as kandinsky6 and kandinsky6-sr (the
  // comfyui/ folder of each repository). Neither is on the validation server; core ComfyUI has no Kandinsky 6 nodes yet (PR #16825).
  kandinsky6: 'https://github.com/kandinskylab/kandinsky-6/tree/7ceeefad7fb625011f7db602c43893a989f19c15/comfyui',
  'kandinsky6-sr': 'https://github.com/kandinskylab/kandinsky-6-sr/tree/b15e2aac526519c51f59dfec2b848355bb8902de/comfyui',
  // World mode (nm10-hy-nomas-world): Nynxz's native Hy-Nomas port (Apache-2.0, no Python dependencies; it registers the
  // DiT and the PixelUMM decoder with the core loaders). Read at this commit (2026-10-24); not on the validation server.
  'ComfyUI-HyNomas': 'https://github.com/Nynxz/ComfyUI-HyNomas/tree/a89e0515619924da71093aa3fe52dbb7104cb06e',
  // Relight (qwen-image-21-relight): Viggle's speed-LoRA loader and step schedule, one file in the model repo itself
  // (comfyui/viggle_turbo.py), pinned at a revision. The address
  // is the file: it is downloaded as custom_nodes/viggle_turbo/__init__.py, never cloned (the repo holds the weights).
  // Qwen Research License (a Qwen-Image 2.1 derivative). Not on the validation server: the entry lists it with `packs`.
  viggle_turbo: 'https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/009a44a895ef85f7e643c80fdca9543795248867/comfyui/viggle_turbo.py',
  // Genjutsu's Openjutsu modes (D3voz/openjutsu @ 7fe118bb): pinned in install-comfyui.sh (OPENJUTSU_MODES=1), not on the
  // validation server (the entries list them with `packs`). H3-FaceRefine, Impact Pack and controlnet_aux are registry packs.
  'ComfyUI-MiniMaxH3-Context-Loop': 'https://github.com/ethanfel/ComfyUI-MiniMaxH3-Context-Loop/tree/43afeffcc570beb5f7382593e79e4b211c7e02f6',
  'ComfyUI-Fantastic-MiniMaxH3-PromptBuilder': 'https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder/tree/22e719fe89336c628383363182a4da3cb58d4f9b',
  'comfyui-h3-oneclick-swap': 'https://github.com/D3voz/comfyui-h3-oneclick-swap/tree/e44a56e92920000e675d14be484aea0d7498d63e',
  'comfyui-image-detail-contrast': 'https://github.com/D3voz/comfyui-image-detail-contrast/tree/485a5e246424ce012b998862b45f06d21e8d63b2',
  Orion4D_FXMax: 'https://github.com/orion4d/Orion4D_FXMax/tree/7048e8423ad7d1a6a52119d0d4870c2b7fc2885f',
  SolarRenderer: 'https://github.com/Enderfga/SolarRenderer/tree/0ca4f5e45b062cc9e9aee506de46aabdc22e4c3d',
  'ComfyUI-H3-FaceRefine': 'https://github.com/Carasibana/ComfyUI-H3-FaceRefine',
  'ComfyUI-Impact-Pack': 'https://github.com/ltdrdata/ComfyUI-Impact-Pack',
  comfyui_controlnet_aux: 'https://github.com/Fannovel16/comfyui_controlnet_aux/tree/a587a4c1594524c1d2de5cd1a86cd868ff448e1c',
  // Watermark Remover: overflowofedge's Qwen watermark nodes (MIT), read at this commit: no network, subprocess, eval or
  // file writes. Not on the validation server (the image-watermark-* entries list it with `packs`); pinned in install-comfyui.sh.
  'ComfyUI-Qwen-Watermark': 'https://github.com/overflowofedge/ComfyUI-Qwen-Watermark/tree/eef829d34d6e9d0d2ae0c1386fab7371a864cf34',
};

// Node classes of the packs entries list in `packs` (packs the validation server doesn't have installed): the build
// expects them instead of reporting "not installed", and the entry's customNodes name the pack. A class listed here
// belongs to that pack whatever module the server reports for it (packOfClass in build-requirements.mjs).
export const PACK_CLASSES = {
  h3_character_swap: /^H3CharacterSwap/,
  'h3-relay': /^(H3Relay|LabsH3)/,
  'ComfyUI-DBS': /^DBS(Loader|Separate)$/,
  'ComfyUI-LTXVideo': /^(LTXICLoRALoaderModelOnly|LTXAddVideoICLoRAGuide|LTXVTiledFusionSampler)$/,
  'ausboss-nodes': /^AUSBOSS_NODES_/,
  // Installed on the validation server, but a ComfyUI with comfyui-workflow-encrypt names that pack as these classes' module.
  'comfyui-krea2edit': /^Krea2Edit(ModelPatch|GroundedEncode)$/,
  'ComfyUI-Krea2-Ostris-Edit': /^(TextEncodeKrea2OstrisEdit|Krea2OstrisEditModelPatch)$/,
  // MiniMax H3 video. The turbo classes need naming here: a ComfyUI with comfyui-workflow-encrypt reports that pack as their module.
  'ComfyUI-MiniMax-H3-Turbo': /^MiniMaxH3Turbo(LoRA|Sampler)$/,
  'plaguekind-nodes': /^H3(SLAAttention|AdaLNLoRAFix)$/,
  'Comfyui-Hi3d-T8': /^Hi3D(ModelLoader|LoadMesh|Refine)$/,
  'ComfyUI-Open-H3-Regenerate': /^OpenH3(Regen(Lora|Sigmas|PrepareDraft|Upscale|RefineLatent|FastVAEDecode|Finish)|SaveRefinedLatent|LoadRefinedLatent|VideoToPrompt)$/,
  Comfyui_Minimax_h3_latent_Upscaler: /^(MinimaxH3LatentUpscaler(3D|Node2D)|MMH3(TemporalSplitParamsV10|SpatialSplitParamsV10|SplitUpscale))$/,
  'ComfyUI-RE-USE': /^REUSE(Loader|Enhance)$/,
  // Live edit's nodes (fuobe_live.py), which Fuobe writes into custom_nodes itself.
  'fuobe-live': /FuobeLive$/,
  'zen-image-edit-comfyui': /^ZenImage21(AdapterLoader|TextEncode)$/,
  ComfyUI_Nvidia_VFX_Nodes: /^RTX(VideoSuperResolution|TrueHDR|VideoFrameGeneration)$/,
  'ComfyUI-QwenTTS': /^AILab_Qwen3TTS(VoiceDesign|VoiceClone|CustomVoice)(_Advanced)?$/,
  'ComfyUI-VoxCPM2': /^VoxCPM2_(TTS|Clone)$/,
  // Green screen and fine hair (nm10-keying): hashu786's CorridorKey 2.0 nodes, and ComfyUI-RMBG 3.3.0's new nodes (neither
  // is on the validation server at these commits, so their definitions come from the packs' source at the pinned commits).
  'ComfyUI-CorridorKey2': /^CorridorKey2(RenderToDisk)?$/,
  'ComfyUI-RMBG': /^AILab_(VRMBG|FeyNoBg)$/,
  'ComfyUI-AuK': /^AuK(ModelLoader|GenerateEdit)$/,
  'ComfyUI-Idol': /^Idol(PreprocessImage|Camera|PruneSplat)$/,
  kandinsky6: /^Kandinsky6(BeautifyPrompt|Sampler|EmptyLatent|ImageToVideoAudio|RemoveReferenceLatent|AudioVAELoader|AudioVAEDecode|TextEncode|MagCache)$/,
  'kandinsky6-sr': /^Kandinsky6(SRVAELoader|LatentUpscalerLoader|VSRUpscale)$/,
  'ComfyUI-HyNomas': /^Nomas(WorldPrompt|PromptJSON|CameraPath|WorldGenerate|WorldContinue|Explore)$/,
  viggle_turbo: /^ViggleTurbo(Lora|Sigmas)$/,
  // Genjutsu's Openjutsu modes.
  'ComfyUI-MiniMaxH3-Context-Loop': /^MiniMaxH3(GenerationProfile|ChainPlanModern|SourceTimeline|ChainLoopStart|ChainCurrent|ChainContext|ContexMaskedTarget|ContexMaskGridPreview|ContexLoopMaskSlice|LoopTrim|ChainSegmentSave|ChainReview|ChainLoopEnd|ChainAssemble)$/,
  'ComfyUI-Fantastic-MiniMaxH3-PromptBuilder': /^MiniMaxH3FantasticVideoEditLatent$/,
  'comfyui-h3-oneclick-swap': /^H3(OneClickSwapPlan|AdvancedSwapPlan|ObjectSwapPlan|SourceSlice|ClipShots|FillShots|PeopleMask|GreyMannequins|TrackCrops|TrackRoles|RoleMask|SubjectPrompt|Montage(People|Tracks|Picks|Plan|Pass)|FaceChunks|FaceJoin|AddFitCheck|SoundtrackOrSilence|ObjectPlacementMask|AddMovingArea|PaintedEditArea|RelightPass)$/,
  'comfyui-image-detail-contrast': /^ImageDetailContrast$/,
  Orion4D_FXMax: /^Orion4D_FXMax_/,
  SolarRenderer: /^SolarRenderer(Model|LoraLoader|Conditioning|Sigmas)$/,
  'ComfyUI-H3-FaceRefine': /^H3Face(TrackCrop|MaskSAM|Stitch)$/,
  'ComfyUI-Impact-Pack': /^SAMLoader$/,
  comfyui_controlnet_aux: /^Metric3D-NormalMapPreprocessor$/,
  'ComfyUI-KJNodes': /^VRAM_Debug$/,
  'ComfyUI-Qwen-Watermark': /^QWM(Detect|ResidualDetect|RefineMask|Prepare|Composite|Final)$/,
};

// Model download locations for files that the source workflow does not annotate
// (UI templates usually carry node.properties.models; custom-node examples do not).
export const KNOWN_MODELS = {
  // World mode (nm10-hy-nomas-world): nynxz/Hy-Nomas, Tencent's Hy-Nomas converted for ComfyUI's core loaders, at the
  // revision read on 2026-11-03. The DiT is Apache-2.0; the PixelUMM decoder is NVIDIA One-Way Noncommercial (its card).
  'nomas_dit_distilled_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/nynxz/Hy-Nomas/resolve/e8ddc4bfa664d69213930552493c220c3af56f41/nomas_dit_distilled_int8_convrot.safetensors' },
  'nomas_dit_distilled_bf16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/nynxz/Hy-Nomas/resolve/e8ddc4bfa664d69213930552493c220c3af56f41/nomas_dit_distilled_bf16.safetensors' },
  'nomas_pixelumm_vae_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/nynxz/Hy-Nomas/resolve/e8ddc4bfa664d69213930552493c220c3af56f41/nomas_pixelumm_vae_bf16.safetensors' },
  // Kandinsky 6.0 (nm10-kandinsky6): Kandinsky Lab's distilled transformers (MIT) at the revisions read on 2026-11-02, saved
  // where the pack's README puts them (diffusion_models/<repo>/transformer/…); the encoders, VAE and vocoder its templates load;
  // and the VSR bundle, whose loaders list a file only with its config.json beside it.
  'Kandinsky-6.0-Lite-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-Lite-distill-5s-Diffusers/resolve/4c487e8b4aeeb9059e5a77905aa2ddb59ec28f81/transformer/diffusion_pytorch_model.safetensors' },
  'Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-Pro-distill-5s-Diffusers/resolve/80d5e6c7f646c5f512b684e2da0765618d805894/transformer/diffusion_pytorch_model.safetensors' },
  'clip_l.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors' },
  'qwen_2.5_vl_7b.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Qwen-Image/resolve/1f12b17be14c89b026c51a91d67c32f84bb047bc/split_files/text_encoders/qwen_2.5_vl_7b.safetensors' },
  'hunyuan_video_vae_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Hunyuan-Video/resolve/533a43813f01517d9e624f9e824a85bb94094120/split_files/vae/hunyuan_video_vae_bf16.safetensors' },
  'qwen3.5_9b_bf16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Qwen3.5/resolve/5d50a2252bf1bcd49e5fee9b5f296986d442682b/text_encoders/qwen3.5_9b_bf16.safetensors' },
  'v1-44.pth': { folder: 'audio_vae', url: 'https://huggingface.co/hkchengrex/MMAudio/resolve/eb13a1a98fdbec91753775c57b074ccdfc60587c/ext_weights/v1-44.pth' },
  'bigvgan_vocoder/bigvgan_generator.pt': { folder: 'audio_vae', url: 'https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x/resolve/95a9d1dcb12906c03edd938d77b9333d6ded7dfb/bigvgan_generator.pt' },
  'bigvgan_vocoder/config.json': { folder: 'audio_vae', url: 'https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x/resolve/95a9d1dcb12906c03edd938d77b9333d6ded7dfb/config.json' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/transformer/diffusion_pytorch_model.safetensors' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/transformer/config.json': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/transformer/config.json' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/vae/diffusion_pytorch_model.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/vae/diffusion_pytorch_model.safetensors' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/vae/config.json': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/vae/config.json' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/latent_upscaler/diffusion_pytorch_model.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/latent_upscaler/diffusion_pytorch_model.safetensors' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/latent_upscaler/config.json': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/latent_upscaler/config.json' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/model_index.json': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/model_index.json' },
  'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/scheduler/scheduler_config.json': { folder: 'diffusion_models', url: 'https://huggingface.co/kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/resolve/3d6672923a4dfcd387961864654e123dd53b8ee4/scheduler/scheduler_config.json' },
  // MiniMax Music 3 and YuE2 as Comfy-Org repacked them (the files the core templates audio_minimax_music_3,
  // audio_yue2_text2music and audio_yue2_music_cover load), pinned in model-pins.json at the revisions read on 2026-11-01.
  'minimax_music3_dit_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_int8_convrot.safetensors' },
  'minimax_music3_text_encoder_pruned_int8_convrot.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors' },
  'minimax_music3_dav.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors' },
  'yue2_3b_int8_convrot.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/YuE2/resolve/main/checkpoints/yue2_3b_int8_convrot.safetensors' },
  'sheetsage2_bf16.safetensors': { folder: 'audio_encoders', url: 'https://huggingface.co/Comfy-Org/YuE2/resolve/main/audio_encoders/sheetsage2_bf16.safetensors' },
  // Watermark Remover: Meta's SAM ViT-B (Apache-2.0), the file ComfyUI-Qwen-Watermark's QWMRefineMask loads. Meta hosts it
  // outside Hugging Face, so this is ybelkada's mirror at a pinned revision: its LFS SHA-256 (ec2df627…) is Meta's file's, and
  // the setup commands check it (a .pth can run code when it loads).
  'sam_vit_b_01ec64.pth': { folder: 'sams', url: 'https://huggingface.co/ybelkada/segment-anything/resolve/7790786db131bcdc639f24a915d9f2c331d843ee/checkpoints/sam_vit_b_01ec64.pth' },
  // archive-restore: Lightricks' Detail Refine IC-LoRA (stage 2 of Restore & colourise), gated, at the researched commit.
  'ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors': { folder: 'loras', url: 'https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Refine-Details/resolve/4912c478b35dd96b6cdcc5f7c7ff9d72c2c57929/ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors' },
  // Live edit: linoyts' 2-step DMD2 LoRA for Qwen-Image 2.1 (pytorch_lora_weights.safetensors upstream, kept under a
  // name of its own), pinned at the revision whose file was measured.
  'Qwen-Image-2.1-DMD2-2steps.safetensors': { folder: 'loras', url: 'https://huggingface.co/linoyts/Qwen-Image-2.1-DMD2-2steps/resolve/5bae28369ecea3232405c17a53c04d35d15796b8/pytorch_lora_weights.safetensors' },
  // Relight: Viggle's 6-step speed LoRA for Qwen-Image 2.1 (v0.2.1, rank 256, alpha 256; the r128 cut for smaller GPUs),
  // pinned at a revision (file hashes r256 2a0148f5…, r128 bafb91d0…).
  'Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256.safetensors': { folder: 'loras', url: 'https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/009a44a895ef85f7e643c80fdca9543795248867/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r256.safetensors' },
  'Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors': { folder: 'loras', url: 'https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo/resolve/009a44a895ef85f7e643c80fdca9543795248867/Qwen-Image-2.1-viggle-turbo-v0.2.1-6step-lora-r128.safetensors' },
  'ltx-2.3-22b-distilled-fp8.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Lightricks/LTX-2.3-fp8/resolve/main/ltx-2.3-22b-distilled-fp8.safetensors' },
  'gemma_3_12B_it_fp4_mixed.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors' },
  'RealESRGAN_x4plus.safetensors': { folder: 'upscale_models', url: 'https://huggingface.co/Comfy-Org/Real-ESRGAN_repackaged/resolve/main/RealESRGAN_x4plus.safetensors' },
  'birefnet.safetensors': { folder: 'background_removal', url: 'https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors' },
  'film_net_fp16.safetensors': { folder: 'frame_interpolation', url: 'https://huggingface.co/Comfy-Org/Frame-Interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors' },
  'rife_v4.26.safetensors': { folder: 'frame_interpolation', url: 'https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/frame_interpolation/rife_v4.26.safetensors' },
  'inswapper_128.onnx': { folder: 'insightface', url: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/inswapper_128.onnx' },
  'GFPGANv1.4.pth': { folder: 'facerestore_models', url: 'https://huggingface.co/datasets/Gourieff/ReActor/resolve/main/models/facerestore_models/GFPGANv1.4.pth' },
  'mmaudio_large_44k_v2_fp16.safetensors': { folder: 'mmaudio', url: 'https://huggingface.co/Kijai/MMAudio_safetensors/resolve/main/mmaudio_large_44k_v2_fp16.safetensors' },
  'mmaudio_vae_44k_fp16.safetensors': { folder: 'mmaudio', url: 'https://huggingface.co/Kijai/MMAudio_safetensors/resolve/main/mmaudio_vae_44k_fp16.safetensors' },
  'mmaudio_synchformer_fp16.safetensors': { folder: 'mmaudio', url: 'https://huggingface.co/Kijai/MMAudio_safetensors/resolve/main/mmaudio_synchformer_fp16.safetensors' },
  'apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors': { folder: 'mmaudio', url: 'https://huggingface.co/Kijai/MMAudio_safetensors/resolve/main/apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors' },
  'wan2.1-i2v-14b-480p-Q8_0.gguf': { folder: 'diffusion_models', url: 'https://huggingface.co/city96/Wan2.1-I2V-14B-480P-gguf/resolve/main/wan2.1-i2v-14b-480p-Q8_0.gguf' },
  'Wan2_1-InfiniteTalk_Single_Q8.gguf': { folder: 'diffusion_models', url: 'https://huggingface.co/Kijai/WanVideo_comfy_GGUF/resolve/main/InfiniteTalk/Wan2_1-InfiniteTalk_Single_Q8.gguf' },
  'lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors' },
  'Wan2_1_VAE_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Wan2_1_VAE_bf16.safetensors' },
  'umt5-xxl-enc-bf16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/umt5-xxl-enc-bf16.safetensors' },
  'wan2.1_infiniteTalk_single_fp16.safetensors': { folder: 'model_patches', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/model_patches/wan2.1_infiniteTalk_single_fp16.safetensors' },
  'clip_vision_h.safetensors': { folder: 'clip_vision', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors' },
  // comfyui-oss-2 additions (hand-built graphs carry no template model metadata)
  'umt5_xxl_fp8_e4m3fn_scaled.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors' },
  'wan_2.1_vae.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors' },
  'wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_fun_vace_high_noise_14B_fp8_scaled.safetensors' },
  'wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors' },
  // Keyframe animation (wan22-inbetween-anisora): the Wan 2.2 I2V experts, the lightx2v 4-step low-noise LoRA, and AniSora 3.2's
  // high-noise LoRA (bilibili Index-AniSora V3.2, Apache-2.0; Kijai's rank-64 extraction, model-pins.json pins its commit).
  'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors' },
  'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors' },
  'wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors' },
  'Wan2_2_I2V_AniSora_3_2_HIGH_rank_64_fp16.safetensors': { folder: 'loras', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/LoRAs/AniSora/Wan2_2_I2V_AniSora_3_2_HIGH_rank_64_fp16.safetensors' },
  'wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors' },
  'wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors' },
  'qwen_image_edit_2509_fp8_e4m3fn.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors' },
  'qwen_2.5_vl_7b_fp8_scaled.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors' },
  'qwen_image_vae.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors' },
  'Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors' },
  // Originals O11: dx8152's Multiple-angles LoRA for Qwen-Image-Edit 2509 (镜头转换.safetensors upstream, kept under an ASCII name; the
  // LoRA library pins the same commit and SHA256) and FusioniX for Wan 2.1 I2V 14B (Fuobe Speak's InfiniteTalk recipe). Fuobe downloads both.
  'qwen-edit-2509-multiple-angles-dx8152.safetensors': { folder: 'loras', url: 'https://huggingface.co/dx8152/Qwen-Edit-2509-Multiple-angles/resolve/c342b0e746c3a3275af1a4a0c6ae78e0e4802531/%E9%95%9C%E5%A4%B4%E8%BD%AC%E6%8D%A2.safetensors' },
  'Wan2.1_I2V_14B_FusionX_LoRA.safetensors': { folder: 'loras', url: 'https://huggingface.co/vrgamedevgirl84/Wan14BT2VFusioniX/resolve/b9793a1f84727f2f69bdffecc2f50f0abfa746a6/FusionX_LoRa/Wan2.1_I2V_14B_FusionX_LoRA.safetensors' },
  'Qwen-Image-Edit-2509-Relight.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/loras/Qwen-Image-Edit-2509-Relight.safetensors' },
  // av-tools (Wave B): Product shot's open route
  'Qwen-Image-Edit-2509-White_to_Scene.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/loras/Qwen-Image-Edit-2509-White_to_Scene.safetensors' },
  'Qwen-Image-Edit-2509-Light-Migration.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/loras/Qwen-Image-Edit-2509-Light-Migration.safetensors' },
  'next-scene_lora-v2-3000.safetensors': { folder: 'loras', url: 'https://huggingface.co/lovis93/next-scene-qwen-image-lora-2509/resolve/main/next-scene_lora-v2-3000.safetensors' },
  'wan2.2_bernini_r_high_noise_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Bernini-R/resolve/main/diffusion_models/wan2.2_bernini_r_high_noise_fp8_scaled.safetensors' },
  'wan2.2_bernini_r_low_noise_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Bernini-R/resolve/main/diffusion_models/wan2.2_bernini_r_low_noise_fp8_scaled.safetensors' },
  'lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors' },
  'Wan21-WanMove_fp8_scaled_e4m3fn_KJ.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Kijai/WanVideo_comfy_fp8_scaled/resolve/main/WanMove/Wan21-WanMove_fp8_scaled_e4m3fn_KJ.safetensors' },
  'sam3.1_multiplex_fp16.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors' },
  // MiniMax H3 for the Character swap, at the revisions docs/research/openjutsu-6.md §6 read (sizes and SHA-256 there).
  'minimax_h3_ref2va_pruned_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/1c41cfca8ebba91d0af792a05c5761fb2c3a7975/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors' },
  'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/1c41cfca8ebba91d0af792a05c5761fb2c3a7975/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' },
  'minimax_h3_video_vae_fp16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/1c41cfca8ebba91d0af792a05c5761fb2c3a7975/vae/minimax_h3_video_vae_fp16.safetensors' },
  'minimax_h3_audio_vae_fp32.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/1c41cfca8ebba91d0af792a05c5761fb2c3a7975/vae/minimax_h3_audio_vae_fp32.safetensors' },
  'minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/3ec17a324ced54151364f24f8b5fb6bf7e26414f/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors' },
  // Regenerate in Cinema (n7-10): LightX2V's FL2V Turbo 4-step v1.2 (Apache-2.0 in its card at 3ec17a3), the 768p draft of rdh's "Prompt to 2K".
  'minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/lightx2v/Minimax-h3-Turbo/resolve/3ec17a324ced54151364f24f8b5fb6bf7e26414f/minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors' },
  'h3_character_swap_v1.5.safetensors': { folder: 'loras', url: 'https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/d06323b7c8e70e97cdab48b78a1e05f786c8cba9/h3_character_swap_v1.5.safetensors' },
  'h3_character_swap_pro4500_1000.safetensors': { folder: 'loras', url: 'https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/a665bb7e3bb9804e487d2925f67744f554c8ad49/h3_character_swap_pro4500_1000.safetensors' },
  'H3-Person-Remover-V1.safetensors': { folder: 'loras', url: 'https://huggingface.co/akatz-ai/MiniMax-H3-Person-Remover-LoRA/resolve/fe136b3dc93aea993b9f194d48ea9859fdc2de14/H3-Person-Remover-V1.safetensors' },
  // Open-H3 Regenerate 2K (video-regenerate-h3; docs/research/new-models-7.md §2.4, sizes and SHA-256 there and in
  // workflows/comfyui/model-pins.json): NVIDIA's merged refiner LoRA (refiner + LightX2V Turbo v1.2 + LMS Sharp, 12.45 GB),
  // the fast H3 VAE decoder and the LBH latent upscaler (the same bytes as LBH-123-AI/Minimax_h3_latent_Upscaler at
  // 3f941d5d), all at the model card's revision. The curve-branch file is left out: its tensors are zero (§2.3).
  'open_h3_regenerate_2k_lora.safetensors': { folder: 'loras', url: 'https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K/resolve/5809c33730c18b6b1c827b40974855a4288641b3/lora/open_h3_regenerate_2k_lora.safetensors' },
  'fast_h3_vae_noncausal_24l.safetensors': { folder: 'vae', url: 'https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K/resolve/5809c33730c18b6b1c827b40974855a4288641b3/vae_fast/fast_h3_vae_noncausal_24l.safetensors' },
  'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors': { folder: 'latent_upscale_models', url: 'https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K/resolve/5809c33730c18b6b1c827b40974855a4288641b3/latent_upsampler/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors' },
  // MiniMax H3 video (minimax-h3-*): the first+last-frame model (pruned int8), Kijai's int8 video VAE (the file
  // the H3 preview clips were rendered with), larryvrh's turbo v4 LoRA (Apache-2.0) and pablodawson's 360 Orbit LoRA, each at a pinned revision.
  'minimax_h3_fl2va_pruned_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/1c41cfca8ebba91d0af792a05c5761fb2c3a7975/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors' },
  'minimax_h3_video_vae_int8_convrot.safetensors': { folder: 'vae', url: 'https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/f5c3b1d5a63e008a691fca1b6096fd57a5307536/minimax_h3_video_vae_int8_convrot.safetensors' },
  'minimax_h3_turbo_v4_step600_ema.safetensors': { folder: 'loras', url: 'https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/resolve/43a74557ac3f6539db8e0f2a959d03feb7a81480/minimax_h3_turbo_v4_step600_ema.safetensors' },
  // Pika H3 Flex (nm10-pika-flex): Pika's two Comfy-format BF16 adapters (1.96 GB each; MiniMax H3 Community License, Model Derivatives,
  // Copyright 2026 Mellis, Inc.; keep Pika's NOTICE), at the model card's revision 3ff16644. SHA-256 in workflows/comfyui/model-pins.json.
  'pika_h3_flex_fl2va_comfy_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/Pika-Labs/Pika-H3-Flex/resolve/3ff166447d5edb1406107ab8370c42000ce173e4/comfy/loras/pika_h3_flex_fl2va_comfy_bf16.safetensors' },
  'pika_h3_flex_ref2va_comfy_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/Pika-Labs/Pika-H3-Flex/resolve/3ff166447d5edb1406107ab8370c42000ce173e4/comfy/loras/pika_h3_flex_ref2va_comfy_bf16.safetensors' },
  'minimax_h3_flf2v_lora_v1.safetensors': { folder: 'loras', url: 'https://huggingface.co/pablodawson/MiniMax-H3-360-Orbit-LoRA/resolve/5ddbc2dbbe95edbbdaf5017c3e934b1d01791697/minimax_h3_flf2v_lora_v1.safetensors' },
  // Genjutsu's Openjutsu modes: Kijai's rank-39 DMAD 4-step LoRA (from ZhengmingYu/DMAD), mdevoz's rank-64 SolarRenderer
  // pair (same speed and VRAM as rank 384, a sixth of the size) and BFL's int8 FLUX 3 prompt upsampler, at pinned revisions.
  'minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/f5c3b1d5a63e008a691fca1b6096fd57a5307536/loras/minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors' },
  'solarrenderer_4step_lora_rank64.safetensors': { folder: 'loras', url: 'https://huggingface.co/mdevoz/SolarRendererRank64/resolve/984a10b7c167bbb94614f9644d5fedbb93a8c6e6/solarrenderer_4step_lora_rank64.safetensors' },
  'solarrenderer_control_lora_rank64.safetensors': { folder: 'loras', url: 'https://huggingface.co/mdevoz/SolarRendererRank64/resolve/984a10b7c167bbb94614f9644d5fedbb93a8c6e6/solarrenderer_control_lora_rank64.safetensors' },
  'qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/text_encoders/qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors' },
  // MiniMax H3 on 8-31 GB cards (new-models-10 §6.4): FastVideo's FastH3 V2 (8-step DMD2, int8 22.1 GB or
  // NVFP4 13.6 GB for Blackwell) and FastH3 Trim (42 of 50 blocks, experimental; NVFP4 11.9 / fp8 19.7 / int8 ConvRot 18.9 GB),
  // each at the revision read on 2026-11-02. MiniMax H3 Community License (the repos' cards).
  'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Comfy/resolve/ec1e3aa374a91c57b0b94a1623b7e657c0498cf2/diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors' },
  'fastvideo_fasth3_8step_v2_pruned_nvfp4.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-8-Step-V2-NVFP4-Comfy/resolve/994a40beb8c8f15739e4f0fad96aec101bb7123c/diffusion_models/fastvideo_fasth3_8step_v2_pruned_nvfp4.safetensors' },
  'fastvideo_fasth3_trim_8step_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Trim-Comfy/resolve/f66c13dc17391dd4da99242a407918b92bf7d5fc/diffusion_models/fastvideo_fasth3_trim_8step_int8_convrot.safetensors' },
  'fastvideo_fasth3_trim_8step_fp8.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Trim-Comfy/resolve/f66c13dc17391dd4da99242a407918b92bf7d5fc/diffusion_models/fastvideo_fasth3_trim_8step_fp8.safetensors' },
  'fastvideo_fasth3_trim_8step_nvfp4.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/FastVideo/FastVideo-FastH3-Trim-Comfy/resolve/f66c13dc17391dd4da99242a407918b92bf7d5fc/diffusion_models/fastvideo_fasth3_trim_8step_nvfp4.safetensors' },
  // Fast decode: Sol-H3-VAE (Efficient-Large-Model, distilled from the H3 VAE decoder; weights under the MiniMax H3 licence per
  // its card, code Apache-2.0) as Comfy-Org repacked it for the core loader (ComfyUI #17411, master from 2026-10-28).
  'minimax_h3_sol_vae_int8_convrot.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/912b6e38b2092ec4d2e86d24183e0d59ea059d48/vae/minimax_h3_sol_vae_int8_convrot.safetensors' },
  'depth_anything_3_mono_large.safetensors': { folder: 'geometry_estimation', url: 'https://huggingface.co/Comfy-Org/Depth-Anything-3/resolve/main/geometry_estimation/depth_anything_3_mono_large.safetensors' },
  // comfyui-oss-3 additions (docs/research/comfyui-oss-3.json, sizes from the Hugging Face tree API)
  // MOSS-Image (research #7 §4.4): Comfy-Org's int8 / w4a8 set (the Comfy template's) at a pinned commit, and Spectrallic's SFT with the
  // 8-step DMD LoRA merged in, a drop-in UNET for the Fast tier (Apache-2.0 throughout; the small VAE is byte-identical to BFL's FLUX.2-small-decoder).
  // The graph loads the int8 Qwen3.5-9B (its row is with FIBO 2's below), not the w4a8 one: that build faulted the NVIDIA driver here (2026-10-23).
  'moss_image_sft_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54/diffusion_models/moss_image_sft_int8_convrot.safetensors' },
  // MOSS-Image Base, the model before its SFT (the owner's image_moss_image_base_t2i): Quality → Base swaps it in (unet).
  'moss_image_base_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54/diffusion_models/moss_image_base_int8_convrot.safetensors' },
  'qwen3.5_9b_w4a8_gptq.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54/text_encoders/qwen3.5_9b_w4a8_gptq.safetensors' },
  'flux2-vae_small.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/530a4c94f92c35ef6818b1b035a983fe9dcf5f54/vae/flux2-vae_small.safetensors' },
  'moss_image_sft_8stepdmd_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Spectrallic/MOSS-Image-SFT-8step-DMD-int8-convrot/resolve/8fdeb392c6322418687fc2519a7958c954497a22/moss_image_sft_8stepdmd_int8_convrot.safetensors' },
  'z_image_turbo_bf16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors' },
  'qwen_3_4b.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors' },
  'ae.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors' },
  'Z-Image-Turbo-Fun-Controlnet-Union.safetensors': { folder: 'model_patches', url: 'https://huggingface.co/alibaba-pai/Z-Image-Turbo-Fun-Controlnet-Union/resolve/main/Z-Image-Turbo-Fun-Controlnet-Union.safetensors' },
  'qwen_image_layered_fp8mixed.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Layered_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_layered_fp8mixed.safetensors' },
  'qwen_image_layered_control_bf16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/DiffSynth-Studio/Qwen-Image-Layered-Control/resolve/main/qwen_image_layered_control_bf16.safetensors' },
  'qwen_image_layered_vae.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Layered_ComfyUI/resolve/main/split_files/vae/qwen_image_layered_vae.safetensors' },
  'qwen_image_edit_2511_fp8mixed.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors' },
  'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors' },
  'flux-2-klein-4b-fp8.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8/resolve/main/flux-2-klein-4b-fp8.safetensors' },
  'flux2-vae.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors' },
  'tryon-klein-4b.safetensors': { folder: 'loras', url: 'https://huggingface.co/xocialize/tryon-FLUX.2-klein-4B-lora/resolve/main/tryon-klein-4b.safetensors' },
  'krea2_turbo_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_int8_convrot.safetensors', variants: ['krea2_turbo_fp8_scaled.safetensors', 'krea2_turbo_bf16.safetensors'] },
  'qwen3vl_4b_fp8_scaled.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors', variants: ['qwen3vl_4b_int8_convrot.safetensors', 'qwen3vl_4b_bf16.safetensors'] },
  'krea2_style_reference.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/loras/krea2_style_reference.safetensors' },
  'flux1-dev-fp8.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors' },
  'uso-flux1-dit-lora-v1.safetensors': { folder: 'loras', url: 'https://huggingface.co/Comfy-Org/USO_1.0_Repackaged/resolve/main/split_files/loras/uso-flux1-dit-lora-v1.safetensors' },
  'uso-flux1-projector-v1.safetensors': { folder: 'model_patches', url: 'https://huggingface.co/Comfy-Org/USO_1.0_Repackaged/resolve/main/split_files/model_patches/uso-flux1-projector-v1.safetensors' },
  'sigclip_vision_patch14_384.safetensors': { folder: 'clip_vision', url: 'https://huggingface.co/Comfy-Org/sigclip_vision_384/resolve/main/sigclip_vision_patch14_384.safetensors' },
  'stable_audio_3_small_sfx.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_small_sfx.safetensors' },
  't5gemma_b_b_ul2.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors' },
  'stable-audio-open-1.0.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/stable-audio-open-1.0_repackaged/resolve/main/stable-audio-open-1.0.safetensors' },
  't5-base.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/ComfyUI-Wiki/t5-base/resolve/main/t5-base.safetensors' },
  'hunyuanvideo_foley_xl_fp8_e4m3fn.safetensors': { folder: 'foley', url: 'https://huggingface.co/phazei/HunyuanVideo-Foley/resolve/main/hunyuanvideo_foley_xl_fp8_e4m3fn.safetensors' },
  'vae_128d_48k_fp16.safetensors': { folder: 'foley', url: 'https://huggingface.co/phazei/HunyuanVideo-Foley/resolve/main/vae_128d_48k_fp16.safetensors' },
  'synchformer_state_dict_fp16.safetensors': { folder: 'foley', url: 'https://huggingface.co/phazei/HunyuanVideo-Foley/resolve/main/synchformer_state_dict_fp16.safetensors' },
  'thinksound_light.ckpt': { folder: 'thinksound', url: 'https://huggingface.co/FunAudioLLM/ThinkSound/resolve/main/thinksound_light.ckpt' },
  'vae.ckpt': { folder: 'thinksound', url: 'https://huggingface.co/FunAudioLLM/ThinkSound/resolve/main/vae.ckpt' },
  'synchformer_state_dict.pth': { folder: 'thinksound', url: 'https://huggingface.co/FunAudioLLM/ThinkSound/resolve/main/synchformer_state_dict.pth' },
  'MelBandRoformer_fp16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Kijai/MelBandRoFormer_comfy/resolve/main/MelBandRoformer_fp16.safetensors' },
  'qwen3.5_4b_bf16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Qwen3.5/resolve/main/text_encoders/qwen3.5_4b_bf16.safetensors' },
  'gemma4_e4b_it_fp8_scaled.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/gemma-4/resolve/main/text_encoders/gemma4_e4b_it_fp8_scaled.safetensors' },
  'trellis_2_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/TRELLIS.2/resolve/main/diffusion_models/trellis_2_int8_convrot.safetensors' },
  'pixal3d_multiview_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/diffusion_models/pixal3d_multiview_int8_convrot.safetensors' },
  'trellis_2_shape_vae_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_shape_vae_bf16.safetensors' },
  'trellis_2_texture_vae_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/vae/trellis_2_texture_vae_bf16.safetensors' },
  'dino_v3_L_naf_fp32.safetensors': { folder: 'clip_vision', url: 'https://huggingface.co/Comfy-Org/Pixal3D/resolve/main/clip_vision/dino_v3_L_naf_fp32.safetensors' },
  'hunyuan_3d_v2.1.safetensors': { folder: 'checkpoints', url: 'https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged/resolve/main/hunyuan_3d_v2.1.safetensors' },
  // comfyui-oss-4 additions (docs/research/comfyui-oss-4.json). OvisOCR3 and Qwen3.5 0.8B are a single safetensors file
  // upstream (the URLs below): save them under these names. Qwen3.5 0.8B / 2B, VACE 1.3B and MoGe 3 are alternative checkpoints (bindings).
  'ovisocr3_0.8b_bf16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/ATH-MaaS/OvisOCR3/resolve/main/model.safetensors' },
  'qwen3.5_0.8b_bf16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Qwen/Qwen3.5-0.8B/resolve/main/model.safetensors-00001-of-00001.safetensors' },
  'qwen3.5_2b_bf16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Qwen3.5/resolve/main/text_encoders/qwen3.5_2b_bf16.safetensors' },
  'wan2.1_vace_14B_fp16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_vace_14B_fp16.safetensors' },
  'wan2.1_vace_1.3B_fp16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_vace_1.3B_fp16.safetensors' },
  't5xxl_fp16.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/void-model/resolve/main/text_encoders/t5xxl_fp16.safetensors' },
  'cogvideox_vae.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/void-model/resolve/main/vae/cogvideox_vae.safetensors' },
  'void_pass1.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/void-model/resolve/main/diffusion_models/void_pass1.safetensors' },
  'void_pass2.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/void-model/resolve/main/diffusion_models/void_pass2.safetensors' },
  'raft_large_C_T_SKHT_V2-ff5fadd5.safetensors': { folder: 'optical_flow', url: 'https://huggingface.co/Comfy-Org/void-model/resolve/main/optical_flow/raft_large_C_T_SKHT_V2-ff5fadd5.safetensors' },
  'moge_2_vitl_normal_fp16.safetensors': { folder: 'geometry_estimation', url: 'https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_2_vitl_normal_fp16.safetensors' },
  'moge_3_vitl_fp16.safetensors': { folder: 'geometry_estimation', url: 'https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_3_vitl_fp16.safetensors' },
  'moge_3_vitg_fp16.safetensors': { folder: 'geometry_estimation', url: 'https://huggingface.co/Comfy-Org/MoGe/resolve/main/geometry_estimation/moge_3_vitg_fp16.safetensors' },
  'dino_v3_vit_h.safetensors': { folder: 'clip_vision', url: 'https://huggingface.co/VAST-AI/TripoSplat/resolve/main/clip_vision/dino_v3_vit_h.safetensors' },
  'triposplat_vae_decoder_fp16.safetensors': { folder: 'vae', url: 'https://huggingface.co/VAST-AI/TripoSplat/resolve/main/vae/triposplat_vae_decoder_fp16.safetensors' },
  'triposplat_fp16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/VAST-AI/TripoSplat/resolve/main/diffusion_models/triposplat_fp16.safetensors' },
  // Any Angle: lilylilith's AnyAngle LoRA for Qwen-Image 2.1 (Apache-2.0, rank 24, ComfyUI keys), at the revision whose file
  // was measured (119,590,312 bytes).
  'QI2.1_AnyAngle.safetensors': { folder: 'loras', url: 'https://huggingface.co/lilylilith/QI_2.1_AnyAngle/resolve/5c8b4c8e05ba6328d54bf8d34ec724fef5a414ae/QI2.1_AnyAngle.safetensors' },
  // Idol 3D (docs/research/idol-9.md §4.1): Speridlabs' Idol for the core TripoSplat nodes. A third-party conversion (ComfyUI-Idol
  // scripts/convert.py at 4d3a4f6) of speridlabs/idol @ 2731c229 (Apache-2.0): pos_pe dropped (ComfyUI recomputes it), cast to fp16,
  // the two decoders merged under octree./gs., and spot-checked as faithful on 10 tensor prefixes (idol-9 §3, §4.1). Pinned to
  // nynxz/Idol @ c718f2b1: idol_fp16 741,107,210 B, sha256 cf452146f78e23a0d34be8f9f79bcde642b9a40ef493046c8e9d5f79096f6dd0;
  // idol_decoder_fp16 576,148,658 B, sha256 c511d99eb668ec4b06d883cb6e43770bc35e3864e16e7058e8d6211ba5c509aa. dino_v3_vit_h,
  // flux2-vae and birefnet are shared with TripoSplat, so 1.32 GB is new.
  'idol_fp16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/nynxz/Idol/resolve/c718f2b1b95b353edd07d17e845719fc10880a44/diffusion_models/idol_fp16.safetensors' },
  'idol_decoder_fp16.safetensors': { folder: 'vae', url: 'https://huggingface.co/nynxz/Idol/resolve/c718f2b1b95b353edd07d17e845719fc10880a44/vae/idol_decoder_fp16.safetensors' },
  // round 4 (r4/video-finish): the chunked SeedVR2 graph is hand-built, so its files are named here (same files as the template).
  'seedvr2_3b_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors' },
  'seedvr2_ema_vae_fp16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors' },
  // N7-5 (Fly path, docs/research/new-models-7.md §3.4 / §3.6): Uni3C's ControlNet for core ModelPatchLoader and the Wan 2.1 I2V
  // 720P it was trained on, at the revisions the research read (1,997,314,376 B and 16,401,356,938 B); the 480P fp8 file
  // InfiniteTalk's native graph already uses is the drop-in to try on a smaller GPU (`checkpoint`), pinned at the commit
  // that uploaded it (16,643,349,018 B, SHA-256 2ff92228…; InfiniteTalk's own entry keeps its template's URL).
  'Wan21_Uni3C_controlnet_fp16.safetensors': { folder: 'model_patches', url: 'https://huggingface.co/Kijai/WanVideo_comfy/resolve/8260d429d19fd7a72304cad059160b95d843913f/Wan21_Uni3C_controlnet_fp16.safetensors' },
  'wan2.1_i2v_720p_14B_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Wan-2.1/resolve/123acf1cc74bccbb9bfff8ac1ee72edc08c2341d/split_files/diffusion_models/wan2.1_i2v_720p_14B_fp8_scaled.safetensors' },
  'Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Kijai/WanVideo_comfy_fp8_scaled/resolve/4d02bd37ce7d852ae45a4c2841956db727b480b4/I2V/Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors' },
  // DBS (docs/research/dbs-separation-7.md §3.1): DBSLoader reads models/dbs/<model>/{config.json, model.safetensors}, so the
  // keys are paths under the folder (what GET /models/dbs lists). Pinned revisions; install-comfyui.sh checks the SHA-256.
  'DBS-BSRNN-DnR/model.safetensors': { folder: 'dbs', url: 'https://huggingface.co/JusperLee/DBS-BSRNN-DnR/resolve/5af343f57f106fbb95efe8a60f1a3999eeb0aef8/model.safetensors' },
  'DBS-BSRNN-DnR/config.json': { folder: 'dbs', url: 'https://huggingface.co/JusperLee/DBS-BSRNN-DnR/resolve/5af343f57f106fbb95efe8a60f1a3999eeb0aef8/config.json' },
  'DBS-TIGER-DnR/model.safetensors': { folder: 'dbs', url: 'https://huggingface.co/JusperLee/DBS-TIGER-DnR/resolve/22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b/model.safetensors' },
  'DBS-TIGER-DnR/config.json': { folder: 'dbs', url: 'https://huggingface.co/JusperLee/DBS-TIGER-DnR/resolve/22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b/config.json' },
  // Hi3D 1.0 (hi3d-refine): T8's Hi3DModelLoader reads models/Hi3D/{hi3d,dino,clip}/ (the official layout, plus the two image
  // encoders Hi3D loads on first use), so the keys are paths under that folder. Pinned revisions; the same files (identical SHA-256)
  // as t8star/Hi3d-Comfy at 6ae7235d. install-comfyui.sh (HI3D=1) downloads them.
  'hi3d/model_index.json': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/model_index.json' },
  'hi3d/scheduler/scheduler_config.json': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/scheduler/scheduler_config.json' },
  'hi3d/vae/config.json': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/vae/config.json' },
  'hi3d/vae/model.safetensors': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/vae/model.safetensors' },
  'hi3d/transformer_512/config.json': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/transformer_512/config.json' },
  'hi3d/transformer_512/model.safetensors': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/transformer_512/model.safetensors' },
  'hi3d/transformer_1024/config.json': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/transformer_1024/config.json' },
  'hi3d/transformer_1024/model.safetensors': { folder: 'Hi3D', url: 'https://huggingface.co/hi3d-official/Hi3Dv1.0/resolve/d502e938cbedc6e87aba8884614c5ca6d177a4b6/transformer_1024/model.safetensors' },
  'dino/config.json': { folder: 'Hi3D', url: 'https://huggingface.co/facebook/dinov2-large/resolve/47b73eefe95e8d44ec3623f8890bd894b6ea2d6c/config.json' },
  'dino/model.safetensors': { folder: 'Hi3D', url: 'https://huggingface.co/facebook/dinov2-large/resolve/47b73eefe95e8d44ec3623f8890bd894b6ea2d6c/model.safetensors' },
  'clip/config.json': { folder: 'Hi3D', url: 'https://huggingface.co/openai/clip-vit-large-patch14/resolve/32bd64288804d66eefd0ccbe215aa642df71cc41/config.json' },
  'clip/model.safetensors': { folder: 'Hi3D', url: 'https://huggingface.co/openai/clip-vit-large-patch14/resolve/32bd64288804d66eefd0ccbe215aa642df71cc41/model.safetensors' },
  // Bria VRMBG 3.0 (nm10-keying): gated with manual approval, placed by hand in models/RMBG/VRMBG-3.0/ (the node never downloads
  // it). Only the weights file is listed (GET /models lists .safetensors); config.json, model.py and vrmbg3_config.py go beside it.
  'VRMBG-3.0/model.safetensors': { folder: 'RMBG', url: 'https://huggingface.co/briaai/VRMBG-3.0/resolve/59716e19a6cc97f91311edea190938219c097b76/model.safetensors' },
  // RE-USE (Clean up voice): the NemotronLabs repositories only (OpenMDW-1.1; the older nvidia/RE-USE is non-commercial), at
  // pinned revisions, named so both fit in models/reuse. install-comfyui.sh checks the SHA-256.
  'NemotronLabs-RE-USE.safetensors': { folder: 'reuse', url: 'https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE/resolve/31f82f2efad1095034492f236e8dac9239ba713b/model.safetensors' },
  'NemotronLabs-RE-USE-laughter.safetensors': { folder: 'reuse', url: 'https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE-laughter/resolve/1b1521dd659608e1e063ada83e0acfe1da473a8b/model.safetensors' },
  // owner's SOTA families (2026-10-31): Qwen-Image 2.1. `variants`: the same weights in another precision in the same repo.
  'qwen_image_2.1_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors', variants: ['qwen_image_2.1_bf16.safetensors'] },
  'qwen_image_2.1_turbo_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors', variants: ['qwen_image_2.1_turbo_bf16.safetensors'] },
  'qwen3vl_8b_int8_convrot.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors', variants: ['qwen3vl_8b_bf16.safetensors'] },
  'qwen_image_2.1_vae_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors' },
  'qwen-image-2.1-outpaint-v2.safetensors': { folder: 'loras', url: 'https://huggingface.co/ausboss/Qwen-Image-2.1-Outpaint-LoRA/resolve/main/qwen-image-2.1-outpaint-v2.safetensors' },
  // Qwen-Image 2.1 speed tiers, the clean decoder and the 2.1 Next-Scene LoRA, each pinned at the revision
  // its card was read at (2026-11-01) and renamed where upstream uses a name many LoRAs share (pytorch_lora_weights).
  'Qwen-Image-2.1-DMD2-2steps-v1.5.safetensors': { folder: 'loras', url: 'https://huggingface.co/linoyts/Qwen-Image-2.1-DMD2-2steps/resolve/5bae28369ecea3232405c17a53c04d35d15796b8/pytorch_lora_weights_v1_5.safetensors' },
  'Qwen-Image-2.1-Lightning-4steps.safetensors': { folder: 'loras', url: 'https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning/resolve/6b0a1176327c01522a44276c5da67331a025b6fc/pytorch_lora_weights.safetensors' },
  'p_q_image_2.1_6_steps_upsampled_v0.2_comfyui_bf16.safetensors': { folder: 'loras', url: 'https://huggingface.co/PrunaAI/P-Q-Image-2.1-Comfy/resolve/aa7dcecb1767e220e31a55706e33fd057c9a3fca/p_q_image_2.1_6_steps_upsampled_v0.2_comfyui_bf16.safetensors' },
  'Qwen-Image-2.1-Next-Scene-step2500.safetensors': { folder: 'loras', url: 'https://huggingface.co/akhaliq/Qwen-Image-2.1-Next-Scene-LoRA/resolve/67ce88cd413fe177758af5d91e25eb3a334aa06f/next_scene_step2500.safetensors' },
  // The QMA camera-angles LoRA by gribbliest for Qwen-Image 2.1 (96 views), pinned to 13007eec.
  'qwen-image-2.1-qma-camera-angles.safetensors': { folder: 'loras', url: 'https://huggingface.co/gribbliest/qwen-image-2.1-qma-camera-angles/resolve/13007eec2648c09529e930164c2ccc9c8c12428c/qwen-image-2.1-qma-camera-angles.safetensors' },
  // Zen Image Edit's fusion adapter: a GitHub release asset of recoilme/zen-image-edit-comfyui (release v2,
  // sha256 and size in model-pins.json), kept in models/text_encoders; the loader is given its full path at run time.
  'adapter_v12.safetensors': { folder: 'text_encoders', url: 'https://github.com/recoilme/zen-image-edit-comfyui/releases/download/v2/adapter_v12.safetensors' },
  'texture_fix_vae_for_qwen_image_2.1_bf16.safetensors': { folder: 'vae', url: 'https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/resolve/9a10df811f183323e4e94d255c18add1924ce340/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors' },
  // Restore (restore-qwen-image-21): AusBoss's Restore LoRA (step 1,500, the card's "start here" file; revision, size and
  // SHA-256 in model-pins.json), and the SeedVR2 7B int8 its hand-built graph enlarges with (the same file as the template's).
  'qwen-image-2.1-restore.safetensors': { folder: 'loras', url: 'https://huggingface.co/ausboss/Qwen-Image-2.1-Restore-LoRA/resolve/main/qwen-image-2.1-restore.safetensors' },
  'seedvr2_7b_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_7b_int8_convrot.safetensors' },
  // Outfit Swap (the card's main file, step 1,000): holds the person picture in place, so only the clothes change.
  'qwen-image-2.1-outfit-swap.safetensors': { folder: 'loras', url: 'https://huggingface.co/ausboss/Qwen-Image-2.1-Outfit-Swap-Consistency-LoRA/resolve/main/qwen-image-2.1-outfit-swap.safetensors' },

  // owner's SOTA families (2026-10-31): Ideogram 4 (Comfy-Org/Ideogram-4; its flux2-vae is the flux2-dev row above). `variants`:
  // the same weights in another precision in the same repository, which a ComfyUI may list instead of the pinned file.
  'ideogram4_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_int8_convrot.safetensors', variants: ['ideogram4_fp8_scaled.safetensors'] },
  'ideogram4_unconditional_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/diffusion_models/ideogram4_unconditional_int8_convrot.safetensors', variants: ['ideogram4_unconditional_fp8_scaled.safetensors'] },
  'qwen3vl_8b_fp8_scaled.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Ideogram-4/resolve/main/text_encoders/qwen3vl_8b_fp8_scaled.safetensors' },
  // owner's SOTA families (2026-10-31): Krea 2. The base files are the Comfy-Org/Krea-2 rows above; these are the LoRAs of
  // the owner's workflows (revisions, sizes and SHA-256 in model-pins.json, from the Hugging Face API).
  'Krea2-realism-V2.safetensors': { folder: 'loras', url: 'https://huggingface.co/RudySen/Krea2-realism-V2/resolve/main/Krea2-realism-V2.safetensors' },
  'krea2_general_edit_v2.safetensors': { folder: 'loras', url: 'https://huggingface.co/conradlocke/krea2-identity-edit/resolve/main/krea2_general_edit_v2.safetensors' },
  'krea2_identity_edit_v2.safetensors': { folder: 'loras', url: 'https://huggingface.co/conradlocke/krea2-identity-edit/resolve/main/krea2_identity_edit_v2.safetensors' },
  'krea2_inpaint_edit.safetensors': { folder: 'loras', url: 'https://huggingface.co/Cierpliwy/krea2-inpaint-edit/resolve/main/v1_512/krea2_inpaint_edit.safetensors' },
  // Krea 2 Turbo in fp8, the same weights as the int8 row above: the file the owner's "Krea2 Image Edit.json" loads and his PC has,
  // so the new Krea 2 graphs run it (Krea 2 Style Reference keeps the int8 file).
  'krea2_turbo_fp8_scaled.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors' },
  // owner's SOTA families (2026-10-31): FIBO 2. The VAE is the existing flux2-vae row. The text-to-image graph's prompt writer is
  // Qwen3.5 9B int8 from Comfy-Org's MOSS-Image repository (MOSS-Image's own encoder too). `variants`: the same
  // weights in another precision in the same repo.
  'fibo2_dev_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/diffusion_models/fibo2_dev_int8_convrot.safetensors', variants: ['fibo2_dev_bf16.safetensors'] },
  'fibo2_edit_turbo_int8_convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/diffusion_models/fibo2_edit_turbo_int8_convrot.safetensors', variants: ['fibo2_edit_turbo_bf16.safetensors'] },
  'qwen3vl_4b_int8_convrot.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/Fibo-2.0/resolve/main/text_encoders/qwen3vl_4b_int8_convrot.safetensors' },
  'qwen3.5_9b_int8_convrot.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/text_encoders/qwen3.5_9b_int8_convrot.safetensors', variants: ['qwen3.5_9b_bf16.safetensors'] },
  // FLUX 3 Image Klein (research #10 §6.3, nm10-flux3-klein): BFL's ComfyUI repack, gated "auto" (accept the FLUX Kommunity
  // License on Hugging Face, then a token downloads it), pinned to the revision read on 2026-11-01. Its Qwen3-VL-4B int8 encoder and
  // flux2-vae are the same names and sizes as the FIBO 2 and flux2-dev rows above, which download without a token. `variants`:
  // the same weights in another precision in the same repo (nvfp4 for Blackwell GPUs, bf16).
  'flux3-image-klein-int8-convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/diffusion_models/flux3-image-klein-int8-convrot.safetensors', variants: ['flux3-image-klein-nvfp4.safetensors', 'flux3-image-klein-bf16.safetensors'] },
  'flux3-image-klein-nvfp4.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/diffusion_models/flux3-image-klein-nvfp4.safetensors' },
  'flux3-image-klein-bf16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/diffusion_models/flux3-image-klein-bf16.safetensors' },
  'flux3-image-klein-base-int8-convrot.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/diffusion_models/flux3-image-klein-base-int8-convrot.safetensors', variants: ['flux3-image-klein-base-nvfp4.safetensors', 'flux3-image-klein-base-bf16.safetensors'] },
  'flux3-image-klein-base-nvfp4.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/diffusion_models/flux3-image-klein-base-nvfp4.safetensors' },
  'flux3-image-klein-base-bf16.safetensors': { folder: 'diffusion_models', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/diffusion_models/flux3-image-klein-base-bf16.safetensors' },
  // BFL's prompt upsampler (Qwen3.5 9B fine-tune, Apache-2.0): the Prompt helper. The w4a8 file is the Comfy templates' (the card's
  // download line names the int8 one, 9.75 GB).
  'qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors': { folder: 'text_encoders', url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/feef60b0aaf63a4773ace96636ebbcf43b881312/text_encoders/qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors', variants: ['qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors', 'qwen3.5_9b_flux3_prompt_upsampler_bf16.safetensors'] },
};

// FLUX 3 Image Klein (flux3-klein-*): every file's licence, as information (never a gate).
const KLEIN_LICENSE =
  'FLUX Kommunity License v1.0 (FLUX 3 Image Klein and Klein Base: non-commercial use, plus commercial outputs for Qualifying Users under US$5M gross ' +
  'annual revenue; other commercial use needs a BFL licence; not blanket permission for commercial fine-tuning or distribution); Qwen3-VL-4B-Instruct ' +
  'encoder and the FLUX 3 prompt upsampler (Qwen3.5 9B fine-tune) Apache-2.0; FLUX.2 VAE Apache-2.0';

// MiniMax H3 video (minimax-h3-*): licence and note text the seven graphs share.
const H3_LICENSE =
  'MiniMax H3 Community License (the H3 FL2VA model, its video and audio VAEs, the packaged Qwen3-VL text encoder): territory EXCLUDES the US, the EU, the UK and South Korea; ' +
  'commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface; no outputs used to improve other AI models · ' +
  'Qwen3-VL-32B base Apache-2.0';
const H3_LICENSE_FAST = `${H3_LICENSE} · turbo v4 LoRA Apache-2.0 (larryvrh) · ComfyUI-MiniMax-H3-Turbo nodes Apache-2.0 · PlagueKind nodes MIT`;
// Pika H3 Flex (minimax-h3-flex-*): the H3 licence plus Pika's adapters and their NOTICE.
const H3_FLEX_LICENSE =
  `${H3_LICENSE} · Pika H3 Flex FL2VA and Ref2VA adapters: Model Derivatives of MiniMax H3 under the MiniMax H3 Community License, ` +
  'Copyright © 2026 Mellis, Inc. (keep Pika\'s NOTICE and LICENSE with the files) · Pika\'s example code Apache-2.0';
const H3_FLEX_NOTES =
  'Pika H3 Flex\'s sampling contract, as Comfy-Org\'s video_pika_h3_flex templates: the adapter at a fixed 1.0 (LoraLoaderModelOnly), KSamplerSelect lcm ' +
  '(fresh noise at every step), ManualSigmas 1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0 (the knots 1000/750/500/250/100/40/0 at video shift 12, ' +
  'so no MiniMaxH3SigmaShift node; audio shift 3 is the model\'s own), BasicGuider (CFG 1). 6 steps; Pika: generic 6-step Euler is not equivalent, and ' +
  'stacking another speed LoRA (Turbo, Lightning) breaks the output. Native 480p or 768p in 11 aspect ratios (21:9 to 9:21), 24 fps, 5-15 s on the 17n+5 grid ' +
  '(124 frames = 5.17 s, 362 = 15.08 s), 32 kHz stereo. Pika: "an end-to-end ComfyUI render has not been verified as part of this upload"; ' +
  'tested by Pika on an H100 80 GB (consumer VRAM unpublished). The file names are Pika\'s (comfy/loras at 3ff16644); Comfy-Org\'s templates name a ' +
  'repack (pika_h3_flex_*_v1_bf16, 128 bytes larger) of the same adapters.';
const H3_NOTES_FIRST_FRAME =
  'The first frame is resized to width x height with no crop, so the canvas should have the still\'s shape (an "auto" aspect ratio sizes it from the still).';
const H3_NOTES_SIZE = 'Canvas: 768 px on the short side, at most 768 x 1344, multiples of 32 (16:9 1344x768, 4:3 1024x768, 1:1 768x768, 9:16 768x1344).';
const H3_NOTES_CANVAS =
  `${H3_NOTES_SIZE} frames = length at 24 fps on the 17n+5 grid (73 = 3.04 s, 124 = 5.17 s, 243 = 10.13 s, 362 = 15.08 s; trained on 5-15 s).`;
const H3_NOTES_LAYOUT =
  'The prompt reads best in MiniMax\'s layout: an alignment line for the reference frames, then integrated_multimodal_description, overall_soundscape ' +
  'and non_diegetic_music. The sound is generated with the picture (stereo) and saved with it.';
const H3_NOTES_FILES =
  'Files: fl2va pruned int8 (20.97 GB), the Qwen3-VL 32B NVFP4 text encoder (15.69 GB; native on compute capability 10+), the int8 video VAE (3.17 GB) ' +
  'and the audio VAE (0.61 GB).';
// Options → Decoder "Fast decode": Sol-H3-VAE in the decode loader (136, binding vae); the stock VAE
// still encodes the frames. Needs ComfyUI master from 2026-10-28 (#17411); not loadable by an older core.
const H3_SOL_VAE = 'minimax_h3_sol_vae_int8_convrot.safetensors';
const H3_NOTES_SOL =
  'Fast decode (vae = minimax_h3_sol_vae_int8_convrot, 1.99 GB, optional): Sol-H3-VAE, a 24-layer whole-clip decoder distilled from the H3 VAE ' +
  '(its card: 12.5 s -> 5.0 s for a 5 s 768p clip on an RTX 5090, 45.4 dB PSNR against the stock decoder); the core VAELoader reads it from ComfyUI master ' +
  '0df1646a (2026-10-28, #17411) on, and its memory grows with the clip (about 24 GiB at 720p for 5 s, the card).';
// Sol-H3-VAE's licence as recorded (the full graphs carry it as an optional file): its model page has no licence tag.
const H3_LICENSE_SOL =
  ' · Sol-H3-VAE (Efficient-Large-Model; the optional fast decoder): licence unconfirmed, no licence tag on its model page; its card says code Apache-2.0 ' +
  'and weights under the MiniMax H3 Community License';
// The FastH3 tiers: FastVideo's distills carry the MiniMax H3 Community License (their cards).
const H3_LICENSE_FASTH3 = `${H3_LICENSE} · FastH3 V2 and FastH3 Trim (FastVideo): MiniMax H3 Community License`;
const H3_NOTES_FASTH3_FILES =
  'Files: the FastH3 diffusion file, the Qwen3-VL 32B NVFP4-AWQ text encoder (15.69 GB; every FastH3 template pairs it with every diffusion file; offloaded ' +
  'after encoding), the int8 video VAE (3.17 GB) and the audio VAE (0.61 GB).';
const H3_NOTES_COMMON = `${H3_NOTES_CANVAS} ${H3_NOTES_LAYOUT} ${H3_NOTES_FILES} ${H3_NOTES_SOL}`;
const H3_NOTES_TIME = 'With the turbo v4 LoRA (0.78 GB). Tested on an RTX 5090 (32 GB): about 2-3 min for a 124-frame clip at 1024x768.';

const WAN_NEG_EN =
  'bright colors, overexposed, static, blurry details, subtitles, style, artwork, painting, still image, overall gray, worst quality, low quality, JPEG artifacts, ugly, deformed, extra fingers, poorly drawn hands, poorly drawn face, malformed, disfigured, fused fingers, motionless, cluttered background, three legs, crowded background, walking backwards';

// ---------------------------------------------------------------------------
// Wan 2.2 14B text/image-to-video: base + official lightx2v 4-step variant
// ---------------------------------------------------------------------------
function wanT2V(lightx2v) {
  return {
    id: lightx2v ? 'wan22-t2v-14b-lightx2v' : 'wan22-t2v-14b',
    title: lightx2v ? 'Wan 2.2 14B Text to Video (lightx2v 4-step)' : 'Wan 2.2 14B Text to Video',
    capability: 't2v',
    export: 'video_wan2_2_14B_t2v',
    transforms: [
      { op: 'resolveSwitches', booleans: { '128:129': lightx2v } },
      // frames = floor(duration*fps)+1 in the template; we expose frames directly.
      { op: 'set', node: '128:74', input: 'length', value: 81 },
    ],
    bindings: {
      prompt: [b('128:89', 'text')],
      negativePrompt: [b('128:72', 'text')],
      width: [b('128:74', 'width')],
      height: [b('128:74', 'height')],
      frames: [b('128:74', 'length')],
      fps: [b('128:125', 'value')],
      seed: [b('128:81', 'noise_seed'), b('128:78', 'noise_seed')],
      steps: [b(lightx2v ? '128:117' : '128:114', 'value')],
      cfg: [b(lightx2v ? '128:119' : '128:116', 'value')],
      shift: [b('128:82', 'shift'), b('128:86', 'shift')],
    },
    outputs: [{ node: '80', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes:
      'Two-expert MoE: high-noise model runs the first half of the steps, low-noise model the rest. ' +
      `The high/low split step is a separate primitive (${lightx2v ? '2 of 4' : '10 of 20'}); if you change steps, keep it roughly at steps/2 (not exposed as a binding). ` +
      'Default 640x640, 81 frames @16 fps (5 s); 1280x720 works on 24 GB+ with offloading. ' +
      (lightx2v ? 'Uses the official Wan2.2 lightx2v 4-step LoRAs (cfg 1): ~5x faster, less motion.' : 'Template default 20 steps, cfg 3.5.'),
  };
}

function wanI2V(variant) {
  const light = variant === 'lightx2v';
  const lora = variant === 'lora';
  const id = light ? 'wan22-i2v-14b-lightx2v' : lora ? 'wan22-i2v-14b-lora' : 'wan22-i2v-14b';
  const transforms = [
    { op: 'resolveSwitches', booleans: { '129:131': light } },
    { op: 'set', node: '129:98', input: 'length', value: 81 },
  ];
  if (lora) {
    transforms.push(
      { op: 'prune' },
      {
        op: 'insertAfter',
        source: ['129:95', 0], // high-noise UNETLoader
        id: '1001',
        node: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'wan22_i2v_effect_high_noise.safetensors', strength_model: 1.0 }, _meta: { title: 'LoRA (high noise)' } },
        input: 'model',
      },
      {
        op: 'insertAfter',
        source: ['129:96', 0], // low-noise UNETLoader
        id: '1002',
        node: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'wan22_i2v_effect_low_noise.safetensors', strength_model: 1.0 }, _meta: { title: 'LoRA (low noise)' } },
        input: 'model',
      },
    );
  }
  const bindings = {
    prompt: [b('129:93', 'text')],
    negativePrompt: [b('129:89', 'text')],
    image: [b('97', 'image')],
    width: [b('129:98', 'width')],
    height: [b('129:98', 'height')],
    frames: [b('129:98', 'length')],
    fps: [b('129:162', 'value')],
    seed: [b('129:86', 'noise_seed'), b('129:85', 'noise_seed')],
    steps: [b(light ? '129:118' : '129:128', 'value')],
    cfg: [b(light ? '129:122' : '129:126', 'value')],
    shift: [b('129:104', 'shift'), b('129:103', 'shift')],
  };
  if (lora) {
    bindings.loraHigh = [b('1001', 'lora_name')];
    bindings.loraLow = [b('1002', 'lora_name')];
    bindings.loraStrength = [b('1001', 'strength_model'), b('1002', 'strength_model')];
  }
  return {
    id,
    title: light ? 'Wan 2.2 14B Image to Video (lightx2v 4-step)' : lora ? 'Wan 2.2 14B Image to Video + LoRA (camera/VFX)' : 'Wan 2.2 14B Image to Video',
    capability: lora ? 'vfx' : 'i2v',
    export: 'video_wan2_2_14B_i2v',
    transforms,
    bindings,
    outputs: [{ node: '108', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes:
      (lora
        ? 'Derived from the official template: LoraLoaderModelOnly inserted after BOTH the high-noise (node 1001) and low-noise (node 1002) UNETLoader. ' +
          'Wan 2.2 effect/camera LoRAs ship as high/low pairs; loraHigh and loraLow must both name files present in models/loras (the default names are placeholders, not downloadable). ' +
          'For a LoRA that only has one file, pass the same file for both (or use wan22-i2v-14b if no LoRA is wanted); loraStrength applies to both. '
        : '') +
      `High/low split step fixed at ${light ? '2 of 4' : '10 of 20'} (not a binding). Default 640x640, 81 frames @16 fps. ` +
      (light ? 'Official lightx2v 4-step LoRAs, cfg 1.' : 'Template default 20 steps, cfg 3.5.'),
  };
}

// Options → Decoder "Clean" on every Qwen-Image 2.1 graph picks madebyollin's Texture-Fix VAE (the vae binding).
const QWEN21_CLEAN_VAE = 'texture_fix_vae_for_qwen_image_2.1_bf16.safetensors';
const QWEN21_LICENCE = 'Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only';
const QWEN21_CLEAN_NOTE = ' Options → Decoder "Clean" sets vae to the Texture-Fix VAE (madebyollin, a finetuned Qwen-Image 2.1 decoder, Qwen Research License; optional file, which the GPU pre-flight asks for when Clean is picked).';
const QWEN21_CLEAN_LICENCE = '; Texture-Fix VAE (madebyollin @ 9a10df81, optional: Options → Decoder Clean): Qwen Research License (card: license_name qwen-research)';
// Zen Image Edit (the 16 GB route): its adapter, encoder and nodes, each with its licence and pin.
const ZEN_LICENCE = '; Zen Image Edit fusion adapter adapter_v12 (AiArtLab / recoilme, release v2 of zen-image-edit-comfyui, sha256 85578cd0): Qwen Research License; Qwen3.5-0.8B (Qwen @ 2fc06364): Apache-2.0; zen-image-edit-comfyui nodes @ 7a29e58c: Apache-2.0';
const ZEN_FIRST_RUN = [
  'Qwen3.5-0.8B (1.7 GB, Apache-2.0), the text encoder: Fuobe uses the pinned copy in models/text_encoders/qwen3.5_0.8b when it is there (hf download Qwen/Qwen3.5-0.8B --revision 2fc06364715b967f1860aea9cf38778875588b17 --local-dir models/text_encoders/qwen3.5_0.8b); otherwise the loader downloads it from Hugging Face on first run',
];
// The speed tiers' LoRAs (cards read 2026-11-01): file, licence, what the card says.
const QWEN21_TIERS = {
  draft: {
    title: '2 steps, DMD2 LoRA v1.5',
    license: "linoyts' DMD2 2-step LoRA v1.5, a derivative of Qwen-Image 2.1 under the same Qwen Research License (card and NOTICE)",
    notes: "linoyts/Qwen-Image-2.1-DMD2-2steps @ 5bae2836, pytorch_lora_weights_v1_5 (2026-10-30: better prompt adherence and edit fidelity than v1, same settings): rank 32, attention only, trained on fixed sigmas [1.0, 0.5] with no shift, CFG 1. ManualSigmas \"1.0, 0.5, 0.0\" as the card says (resolution independent).",
  },
  fast: {
    title: '4 steps, LightX2V Lightning LoRA',
    license: 'LightX2V Lightning LoRA: no licence in the repository (no LICENSE file, empty card tag; comfyui-wiki says Apache-2.0); a Qwen-Image 2.1 adapter, so the base\'s Qwen Research License applies to what it runs on',
    notes: 'lightx2v/Qwen-Image-2.1-Lightning @ 6b0a1176 (DMD, trained on 16 Ascend 910B NPUs): 4 steps at CFG 1 on the card\'s training schedule [1.0, 0.75, 0.5, 0.25] with exponential dynamic shifting (base_shift 0.5, max_shift 0.9, 256-8192 tokens of 16 px). ' +
      'ManualSigmas holds that schedule shifted for the canvas (text to image: 1 MP, 1.0, 0.857192, 0.666756, 0.400096, 0; edits: a 2048 square, 1.0, 0.917701, 0.787999, 0.553369, 0, since ImageScaleToMaxDimension scales image 1 to 2048 on its long side); Fuobe binds sigmas for the run\'s own canvas with the same shift. Chosen over the official Fun Acc 4-step LoRA, which needs VideoX-Fun\'s parallel-decoding output head and norm overrides (not a plain LoRA in ComfyUI).',
  },
  details: {
    title: '6 steps, P-Q-Image v0.2 upsampled LoRA (writes the details)',
    license: "PrunaAI's P-Q-Image-2.1 v0.2, a derivative of Qwen-Image 2.1 under the Qwen Research License (LICENSE and NOTICE in the repository)",
    notes: "PrunaAI/P-Q-Image-2.1-Comfy @ aa7dcecb, the 6-steps-upsampled v0.2 adapter (Pruna's distillation of the prompt upsampler into the LoRA, so short prompts come out detailed with no separate upsampling call) at strength 1, euler, CFG 1, the v0.2 ManualSigmas \"1.0, 0.961054, 0.918949, 0.769302, 0.545554, 0.222292, 0\" (not interchangeable with v0.1's). " +
      'As Pruna\'s official workflows: LoraLoaderModelOnly on the base int8 model, QwenImage21Cache, CFGGuider, SamplerCustomAdvanced. Trained at 1K only; Pruna recommends at most 3 reference images for edits, so Fuobe refuses a fourth at this speed.',
  },
};
const qwen21Tier = (op, tier, base, extra) => ({
  id: `qwen-image-21-${op}-${tier}`,
  title: `${base.title} · ${QWEN21_TIERS[tier].title}`,
  capability: base.capability,
  handBuilt: `hand-built/qwen-image-21-${op}-${tier}.json`,
  bindings: { ...base.bindings, seed: [b('70', 'noise_seed')], vae: [b('3', 'vae_name')], ...(tier === 'fast' && { sigmas: [b('73', 'sigmas')] }) },
  outputs: [{ node: base.output ?? '90', kind: 'image' }],
  ...(base.limits && { limits: base.limits }),
  ...(base.packs && { packs: base.packs }),
  vramGb: 20,
  optionalModels: [QWEN21_CLEAN_VAE],
  license: `${QWEN21_LICENCE}; ${QWEN21_TIERS[tier].license}${extra?.license ?? ''}${QWEN21_CLEAN_LICENCE}`,
  notes:
    `Options → Speed "${tier}" on qwen-image-21-${op}: the same graph with a LoraLoaderModelOnly after the UNETLoader${extra?.after ?? ''} and its KSampler replaced by ` +
    `RandomNoise + CFGGuider (cfg 1) + KSamplerSelect euler + ManualSigmas + SamplerCustomAdvanced on the same latent. No steps binding: the sigmas are the schedule. ${QWEN21_TIERS[tier].notes}${extra?.notes ?? ''}${QWEN21_CLEAN_NOTE}`,
});

// Kandinsky 6.0 (nm10-kandinsky6): each file's licence as its card states it, and what the graphs share.
const K6_LICENSE =
  'MIT (Kandinsky 6.0 Lite and Pro distilled weights, Kandinsky Lab); Qwen2.5-VL 7B text encoder Apache-2.0; CLIP-L MIT; HunyuanVideo VAE: Tencent Hunyuan Community License ' +
  '(territory EXCLUDES the EU, UK and South Korea); audio VAE v1-44.pth from hkchengrex/MMAudio: CC BY-NC 4.0 (NON-COMMERCIAL); BigVGAN v2 vocoder MIT (NVIDIA); ' +
  'Qwen3.5 9B (Prompt helper) Apache-2.0; kandinsky6 pack code MIT (vendored Kandinsky video code Apache-2.0)';
const K6_NOTES =
  'Kandinsky Lab\'s kandinsky6 pack (its T2VA / I2VA templates, without the VSR stage: Upscale -> Kandinsky VSR does that) on core loaders: UNETLoader (the transformer), DualCLIPLoader kandinsky5 ' +
  '(qwen_2.5_vl_7b + clip_l), VAELoader (HunyuanVideo VAE), Kandinsky6AudioVAELoader (v1-44.pth + models/audio_vae/bigvgan_vocoder, 44k, scaling 0.417). ' +
  'unet = the Quality setting: Lite distilled (default, 6.38 GB) or Pro distilled (60.3 GB, an optional download); both run the pack\'s PiFlow sampler at 10 steps and CFG 1 (MagCache is bypassed for distilled models, so it is left out). ' +
  'One caption feeds the picture and the sound (Kandinsky6TextEncode): spoken lines between <S> and <E>, the sound between <AUDCAP> and <ENDAUDCAP>; Fuobe writes the tags from quoted words and a "Sound:" line. ' +
  'Node 20 is the Prompt helper (Kandinsky6BeautifyPrompt on Qwen3.5 9B bf16, 19.3 GB): Fuobe takes it out unless Prompt helper is on, so the encoder reads the words as typed. ' +
  '5 s = 121 frames (4n + 1) at 24 fps; width and height multiples of 16 (480p by default: 864x480 in the template, Fuobe\'s 16:9 is 848x480). ' +
  'VRAM is not published: 24 GB for Lite is an estimate (6.4 GB DiT; the 16.6 GB encoder and the VAE load in turn), Pro distilled holds a 60.3 GB DiT (an 80 GB GPU, or a lot of system RAM for ComfyUI to offload into). ' +
  'The kandinsky6 pack needs ComfyUI 0.38 or newer; the cloud half is kandinsky-6 on fal.';

// Genjutsu's Openjutsu modes: the packs their H3 graphs need, and the licence line they share.
const OJ_PACKS = ['ComfyUI-MiniMaxH3-Context-Loop', 'ComfyUI-Fantastic-MiniMaxH3-PromptBuilder', 'comfyui-h3-oneclick-swap', 'ComfyUI-KJNodes', 'ComfyUI-VideoHelperSuite'];
const OJ_H3_LICENCE =
  'MiniMax H3 Community License (H3 Ref2VA, its VAEs, the packaged Qwen3-VL text encoder, the DMAD LoRA derived from it): territory EXCLUDES the US, the EU, the UK and South Korea; ' +
  'commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface; no outputs used to improve other AI models · ' +
  'Qwen3-VL 8B describer Apache-2.0 · SAM 3.1 under Meta\'s SAM License · graphs from D3voz/openjutsu (MIT) · Context Loop nodes GPL-3.0, Fantastic PromptBuilder MIT, H3 OneClick Swap MIT';

export const SPEC = [
  // =========================================================================
  // IMAGE
  // =========================================================================
  {
    id: 'flux1-dev-t2i',
    title: 'FLUX.1 [dev] Text to Image',
    capability: 't2i',
    export: 'flux_dev_full_text_to_image',
    transforms: [
      // Expose guidance: the template relies on the model default (3.5); add an explicit FluxGuidance.
      { op: 'insertAfter', source: ['194:49', 0], id: '1001', node: { class_type: 'FluxGuidance', inputs: { guidance: 3.5 }, _meta: { title: 'FluxGuidance' } }, input: 'conditioning', only: ['194:50'] },
    ],
    bindings: {
      prompt: [b('194:49', 'text')],
      width: [b('194:48', 'width')],
      height: [b('194:48', 'height')],
      seed: [b('194:50', 'seed')],
      steps: [b('194:50', 'steps')],
      guidance: [b('1001', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    notes: 'No negative prompt (cfg 1, distilled guidance). FluxGuidance node 1001 added so guidance is bindable (template implicit default is also 3.5). fp16 weights (23.8 GB) — ComfyUI offloads on 16-24 GB cards; set weight_dtype fp8 in node 194:46 for lower VRAM.',
  },
  {
    id: 'flux1-krea-dev-t2i',
    title: 'FLUX.1 Krea [dev] Text to Image',
    capability: 't2i',
    export: 'flux1_krea_dev',
    transforms: [
      { op: 'insertAfter', source: ['200:195', 0], id: '1001', node: { class_type: 'FluxGuidance', inputs: { guidance: 3.5 }, _meta: { title: 'FluxGuidance' } }, input: 'conditioning', only: ['200:197'] },
    ],
    bindings: {
      prompt: [b('200:195', 'text')],
      width: [b('200:196', 'width')],
      height: [b('200:196', 'height')],
      seed: [b('200:197', 'seed')],
      steps: [b('200:197', 'steps')],
      guidance: [b('1001', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 16,
    notes: 'Photorealistic "opinionated" FLUX.1 dev fine-tune by Krea (fp8 scaled weights). Shares text encoders + ae.safetensors with flux1-dev-t2i.',
  },
  {
    id: 'flux1-schnell-t2i',
    title: 'FLUX.1 [schnell] Text to Image',
    capability: 't2i',
    export: 'flux_schnell_full_text_to_image',
    bindings: {
      prompt: [b('41', 'clip_l'), b('41', 't5xxl')],
      width: [b('27', 'width')],
      height: [b('27', 'height')],
      seed: [b('31', 'seed')],
      steps: [b('31', 'steps')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    notes: '4-step distilled, Apache-2.0 licence (commercial OK). Prompt goes to both CLIP-L and T5 fields of CLIPTextEncodeFlux. Guidance is ignored by schnell.',
  },
  {
    id: 'flux2-dev-t2i',
    title: 'FLUX.2 [dev] Text to Image',
    capability: 't2i',
    export: 'image_flux2_text_to_image',
    transforms: [{ op: 'resolveSwitches', booleans: { '98:104': false } }],
    bindings: {
      prompt: [b('98:6', 'text')],
      width: [b('98:47', 'width'), b('98:48', 'width')],
      height: [b('98:47', 'height'), b('98:48', 'height')],
      seed: [b('98:25', 'noise_seed')],
      steps: [b('98:100', 'value')],
      guidance: [b('98:26', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 32,
    notes: 'Mistral-Small text encoder (36 GB bf16) + 32B fp8mixed transformer; needs ~64 GB system RAM for offloading on 24 GB cards. Width/height must be set on BOTH the latent and the Flux2Scheduler (both listed).',
  },
  {
    id: 'flux2-dev-t2i-turbo',
    title: 'FLUX.2 [dev] Text to Image (Turbo LoRA, 8-step)',
    capability: 't2i',
    export: 'image_flux2_text_to_image',
    transforms: [{ op: 'resolveSwitches', booleans: { '98:104': true } }],
    bindings: {
      prompt: [b('98:6', 'text')],
      width: [b('98:47', 'width'), b('98:48', 'width')],
      height: [b('98:47', 'height'), b('98:48', 'height')],
      seed: [b('98:25', 'noise_seed')],
      steps: [b('98:99', 'value')],
      guidance: [b('98:26', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 32,
    notes: 'Same as flux2-dev-t2i with the official template\'s "Enable Turbo LoRA" path (Flux_2-Turbo-LoRA, 8 steps).',
  },
  {
    id: 'flux2-dev-edit',
    title: 'FLUX.2 [dev] Image Edit (1 reference)',
    capability: 'edit',
    export: 'image_flux2',
    transforms: [{ op: 'resolveSwitches', booleans: { '68:94': false } }],
    bindings: {
      prompt: [b('68:6', 'text')],
      image: [b('46', 'image')],
      seed: [b('68:25', 'noise_seed')],
      steps: [b('68:91', 'value')],
      guidance: [b('68:26', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 32,
    notes: 'Output size follows the input image rescaled to ~1 megapixel (ImageScaleToTotalPixels node 45, megapixels=1).',
  },
  {
    id: 'flux2-dev-multiref',
    title: 'FLUX.2 [dev] Multi-Reference Edit (3 images)',
    capability: 'edit',
    export: 'image_flux2',
    transforms: [
      { op: 'resolveSwitches', booleans: { '68:94': false } },
      {
        op: 'addNodes',
        nodes: {
          1101: { class_type: 'LoadImage', inputs: { image: 'reference2.png' }, _meta: { title: 'Load Image (reference 2)' } },
          1102: { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['1101', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1 }, _meta: { title: 'Scale reference 2' } },
          1103: { class_type: 'VAEEncode', inputs: { pixels: ['1102', 0], vae: ['68:10', 0] }, _meta: { title: 'VAE Encode (reference 2)' } },
          1111: { class_type: 'LoadImage', inputs: { image: 'reference3.png' }, _meta: { title: 'Load Image (reference 3)' } },
          1112: { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['1111', 0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 1 }, _meta: { title: 'Scale reference 3' } },
          1113: { class_type: 'VAEEncode', inputs: { pixels: ['1112', 0], vae: ['68:10', 0] }, _meta: { title: 'VAE Encode (reference 3)' } },
        },
      },
      { op: 'insertAfter', source: ['68:43', 0], id: '1104', node: { class_type: 'ReferenceLatent', inputs: { latent: ['1103', 0] }, _meta: { title: 'Set Reference Latent (2)' } }, input: 'conditioning' },
      { op: 'insertAfter', source: ['1104', 0], id: '1114', node: { class_type: 'ReferenceLatent', inputs: { latent: ['1113', 0] }, _meta: { title: 'Set Reference Latent (3)' } }, input: 'conditioning' },
    ],
    bindings: {
      prompt: [b('68:6', 'text')],
      image: [b('46', 'image')],
      image2: [b('1101', 'image')],
      image3: [b('1111', 'image')],
      seed: [b('68:25', 'noise_seed')],
      steps: [b('68:91', 'value')],
      guidance: [b('68:26', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 32,
    notes: 'Official FLUX.2 edit template extended with two more chained ReferenceLatent inputs (FLUX.2 supports up to ~10). All three images are required; refer to them in the prompt as "image 1/2/3". Output size follows image 1 (~1 MP).',
  },
  {
    id: 'qwen-image-2512-t2i',
    title: 'Qwen-Image 2512 Text to Image',
    capability: 't2i',
    export: 'image_qwen_Image_2512',
    transforms: [{ op: 'resolveSwitches', booleans: { '238:229': false } }],
    bindings: {
      prompt: [b('238:227', 'text')],
      negativePrompt: [b('238:228', 'text')],
      width: [b('238:232', 'width')],
      height: [b('238:232', 'height')],
      seed: [b('238:230', 'seed')],
      steps: [b('238:224', 'value')],
      cfg: [b('238:223', 'value')],
      shift: [b('238:222', 'shift')],
    },
    outputs: [{ node: '60', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    notes: 'Best open model for in-image text rendering (EN/ZH). Native 1328x1328; recommended sizes 1664x928 (16:9), 928x1664 (9:16), 1472x1104 (4:3). 50 steps cfg 4 by default.',
  },
  {
    id: 'qwen-image-2512-t2i-lightning',
    title: 'Qwen-Image 2512 Text to Image (Lightning 4-step)',
    capability: 't2i',
    export: 'image_qwen_Image_2512',
    transforms: [{ op: 'resolveSwitches', booleans: { '238:229': true } }],
    bindings: {
      prompt: [b('238:227', 'text')],
      negativePrompt: [b('238:228', 'text')],
      width: [b('238:232', 'width')],
      height: [b('238:232', 'height')],
      seed: [b('238:230', 'seed')],
      steps: [b('238:225', 'value')],
      cfg: [b('238:218', 'value')],
      shift: [b('238:222', 'shift')],
    },
    outputs: [{ node: '60', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    notes: 'Official template with "Enable 4 Steps LoRA" on (Qwen-Image-2512-Lightning-4steps, cfg 1). ~10x faster than qwen-image-2512-t2i.',
  },
  {
    id: 'z-image-turbo-t2i',
    title: 'Z-Image Turbo Text to Image',
    capability: 't2i',
    export: 'image_z_image_turbo',
    bindings: {
      prompt: [b('57:27', 'text')],
      width: [b('57:13', 'width')],
      height: [b('57:13', 'height')],
      seed: [b('57:3', 'seed')],
      steps: [b('57:3', 'steps')],
      shift: [b('57:11', 'shift')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 12,
    notes: '6B distilled model, 8 steps, cfg 1 (no negative prompt). Fastest high-quality option; fits 12-16 GB GPUs.',
  },
  {
    id: 'hidream-i1-dev-t2i',
    title: 'HiDream-I1 Dev Text to Image',
    capability: 't2i',
    export: 'hidream_i1_dev',
    bindings: {
      prompt: [b('16', 'text')],
      negativePrompt: [b('40', 'text')],
      width: [b('53', 'width')],
      height: [b('53', 'height')],
      seed: [b('3', 'seed')],
      steps: [b('3', 'steps')],
      cfg: [b('3', 'cfg')],
      shift: [b('70', 'shift')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    notes: '17B MoE (fp8). Four text encoders incl. Llama-3.1-8B (fp8). Dev variant: 28 steps, cfg 1, lcm sampler; negative prompt has little effect at cfg 1.',
  },
  {
    id: 'sdxl-t2i',
    title: 'SDXL 1.0 Text to Image',
    capability: 't2i',
    export: 'image_sdxl_simple',
    transforms: [{ op: 'set', node: '11', input: 'text', value: 'lowres, blurry, out of focus, deformed, bad anatomy, watermark, text, signature' }],
    bindings: {
      prompt: [b('10', 'text')],
      negativePrompt: [b('11', 'text')],
      width: [b('13', 'width')],
      height: [b('13', 'height')],
      seed: [b('12', 'seed')],
      steps: [b('12', 'steps')],
      cfg: [b('12', 'cfg')],
    },
    outputs: [{ node: '7', kind: 'image' }],
    limits: { maxWidth: 1536, maxHeight: 1536, dimensionMultiple: 8 },
    vramGb: 8,
    notes: 'Lightweight baseline (single 6.9 GB checkpoint). Native 1024x1024 class resolutions. Default negative prompt replaced with a generic one.',
  },
  // ---- MOSS-Image (research #7 §4.6, package N7-1): plain words or a layout's JSON boxes ------------------------
  {
    id: 'moss-image-t2i',
    title: 'MOSS-Image SFT text to image (plain words or a layout of boxes; strong Chinese and English text)',
    capability: 't2i',
    handBuilt: 'hand-built/moss-image-t2i.json',
    bindings: {
      prompt: [b('4', 'text')], negativePrompt: [b('5', 'text')], width: [b('6', 'width')], height: [b('6', 'height')],
      seed: [b('8', 'seed')], steps: [b('8', 'steps')], cfg: [b('8', 'cfg')], sampler: [b('8', 'sampler_name')], scheduler: [b('8', 'scheduler')],
      unet: [b('1', 'unet_name')],
    },
    outputs: [{ node: '10', kind: 'image' }],
    defaults: { sampler: 'er_sde', scheduler: 'simple', unet: 'moss_image_sft_int8_convrot.safetensors' },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    optionalModels: ['moss_image_sft_8stepdmd_int8_convrot.safetensors', 'moss_image_base_int8_convrot.safetensors'],
    vramGb: 16,
    // §4.5: each file's licence, the optional Fast and Base files' too (Spectrallic's card is Apache-2.0).
    license:
      "Apache-2.0 (MOSS-Image SFT and Base, Qwen3.5-9B, FLUX.2 small decoder, byte-identical to BFL's Apache-2.0 FLUX.2-small-decoder; " +
      "Fast: Spectrallic's MOSS-Image SFT 8-step DMD int8 file, Apache-2.0)",
    notes:
      'Core nodes only (MOSS-Image is native in the pinned ComfyUI): Comfy-Org\'s template image_moss_image_t2i_bboxes without its subgraph, TextGenerate upsampler and box nodes. ' +
      'The prompt is plain words or a compiled layout (a summary + items with pixel boxes from the canvas centre, y before x), which reaches the model verbatim; ' +
      'width / height are the layout\'s canvas (multiples of 16, up to 2048). Standard = the template: 25 steps, CFG 2.5, er_sde / simple, skip-layer guidance on layer 22 for the first half; ' +
      'Quality = the MOSS-Image user guide: 50 steps, CFG 3, euler; Fast = Spectrallic\'s SFT with the 8-step DMD LoRA merged (unet), 8 steps, CFG 1; ' +
      'Base = MOSS-Image Base (unet) at 50 steps, CFG 3, euler. ' +
      'The text encoder is qwen3.5_9b_int8_convrot (the int8 file FIBO 2\'s prompt writer also loads), not the template\'s qwen3.5_9b_w4a8_gptq. ' +
      'The 16 GB VRAM figure is an estimate, as MOSS-Image publishes none: about 15 GB of files (DiT 5.4 + encoder 9.7 + VAE 0.25), and ComfyUI offloads. ' +
      'The int8 files run through comfy-kitchen\'s kernels, which need a PyTorch built for CUDA 13 (cu130): comfy/quant_ops.py turns its CUDA backend off otherwise and logs a warning, and the model may run slower.',
  },
  // ---- FLUX 3 Image Klein (research #10 §6.3, package nm10-flux3-klein) ------------------------------------------------
  {
    id: 'flux3-klein-t2i',
    title: 'FLUX 3 Image Klein text to image (16 steps; BFL\'s prompt helper writes the full caption, or a layout of boxes as typed)',
    capability: 't2i',
    handBuilt: 'hand-built/flux3-klein-t2i.json',
    bindings: {
      prompt: [b('11', 'prompt')], width: [b('6', 'width')], height: [b('6', 'height')],
      seed: [b('7', 'seed'), b('11', 'sampling_mode.seed')], steps: [b('7', 'steps')], unet: [b('1', 'unet_name')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    defaults: { unet: 'flux3-image-klein-int8-convrot.safetensors' },
    limits: { maxWidth: 4096, maxHeight: 4096, dimensionMultiple: 16 },
    optionalModels: ['flux3-image-klein-nvfp4.safetensors', 'flux3-image-klein-bf16.safetensors'],
    vramGb: 16, // a guess (16-24 GB): see notes
    license: KLEIN_LICENSE,
    notes:
      'Comfy-Org\'s image_flux3_klein_distilled_t2i (2026-10-15, minComfyUIVersion 0.41.0) without its subgraph, ResolutionSelector, box editor and notes; core nodes only. ' +
      'The prompt goes to TextGenerate on BFL\'s FLUX 3 prompt upsampler (CLIPLoader type flux3, 3,584 tokens, top_k 1 as the card\'s greedy decoding, presence penalty 1.5, ' +
      'the t2i system prompt of black-forest-labs/flux-3-image-klein-pup@3f3edb52), whose caption Qwen3-VL-4B encodes. Prompt helper off (params.extra.promptHelper "off"), ' +
      'or a layout of boxes (compileFlux3: a caption citing <obj_N>, then the 0-1000 table), sends the words as typed: the provider takes the helper\'s branch out. ' +
      'Distilled: 16 steps (the card; the template has 15), CFG 1, er_sde / simple, an empty negative. The template\'s file names (flux3_image_klein_sd_int8_convrot) are not ' +
      'in the repository: the files are BFL\'s (flux3-image-klein-int8-convrot). VRAM about 16-24 GB, estimated: BFL\'s card gives 25-31 GB on a B200 at 1 MP with the helper off, ' +
      'Freefield measured 17.8 GB with the int8 files; the helper adds a 6.7 GB encoder, which ComfyUI offloads after it runs.',
  },
  {
    id: 'flux3-klein-edit',
    title: 'FLUX 3 Image Klein edit with up to 10 references (16 steps; the prompt helper looks at them)',
    capability: 'edit',
    handBuilt: 'hand-built/flux3-klein-edit.json',
    bindings: {
      prompt: [b('11', 'prompt')], image: [b('20', 'image')], image2: [b('21', 'image')], image3: [b('22', 'image')], image4: [b('23', 'image')],
      image5: [b('24', 'image')], image6: [b('25', 'image')], image7: [b('26', 'image')], image8: [b('27', 'image')], image9: [b('28', 'image')],
      image10: [b('29', 'image')], seed: [b('7', 'seed'), b('11', 'sampling_mode.seed')], steps: [b('7', 'steps')], unet: [b('1', 'unet_name')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    defaults: { unet: 'flux3-image-klein-int8-convrot.safetensors' },
    limits: { maxImages: 10 },
    optionalModels: ['flux3-image-klein-nvfp4.safetensors', 'flux3-image-klein-bf16.safetensors'],
    vramGb: 16, // a guess (16-24 GB): see notes
    license: KLEIN_LICENSE,
    notes:
      'Comfy-Org\'s image_flux3_klein_distilled_image_edit with ten LoadImage nodes on one ReferenceMultiLatent (resize, 1 MP each; the result takes reference 1\'s shape, ' +
      'as the template\'s empty_latent) and on the BatchImagesNode the prompt helper looks at (the i2i system prompt, presence penalty 0). References not given are left out ' +
      '(ReferenceMultiLatent and BatchImagesNode take them as optional inputs; slots drop from the last). Prompt: the instruction, references named by order ' +
      '(the first image, the second image… or <ref_image_0> in a typed caption). 16 steps, CFG 1, euler / simple, an empty negative (ConditioningZeroOut) with the ' +
      'references on both sides, as the template. Prompt helper off sends the words as typed. Removed: the box editor, image compare and notes.',
  },
  {
    id: 'flux3-klein-base-t2i-lora',
    title: 'FLUX 3 Image Klein Base text to image with LoRAs (50 steps, CFG 3.5; the base LoRAs are trained on)',
    capability: 't2i',
    handBuilt: 'hand-built/flux3-klein-base-t2i-lora.json',
    bindings: {
      prompt: [b('11', 'prompt')], width: [b('6', 'width')], height: [b('6', 'height')],
      seed: [b('7', 'seed'), b('11', 'sampling_mode.seed')], steps: [b('7', 'steps')], cfg: [b('7', 'cfg')], unet: [b('1', 'unet_name')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    defaults: { unet: 'flux3-image-klein-base-int8-convrot.safetensors' },
    limits: { maxWidth: 4096, maxHeight: 4096, dimensionMultiple: 16 },
    optionalModels: ['flux3-image-klein-base-nvfp4.safetensors', 'flux3-image-klein-base-bf16.safetensors'],
    vramGb: 16, // a guess (16-24 GB): see notes
    license: KLEIN_LICENSE,
    notes:
      'flux3-klein-t2i on Klein Base, the undistilled checkpoint BFL, fal\'s trainer and AI-Toolkit train LoRAs on: 50 steps, CFG 3.5, euler / simple (the card), ' +
      'the empty negative now counts. The run\'s LoRAs (a trained FLUX 3 Klein Soul ID, Settings -> LoRAs) are injected after the UNETLoader as a LoraLoaderModelOnly stack. ' +
      'Same prompt helper, Prompt helper off and layout rules as flux3-klein-t2i. About three times the distilled model\'s sampling time.',
  },
  {
    id: 'qwen-image-edit-2509',
    title: 'Qwen-Image-Edit 2509 (Lightning 4-step)',
    capability: 'edit',
    export: 'image_qwen_image_edit_2509',
    transforms: [{ op: 'resolveSwitches' }],
    bindings: {
      prompt: [b('433:111', 'prompt')],
      negativePrompt: [b('433:110', 'prompt')],
      image: [b('78', 'image')],
      seed: [b('433:3', 'seed')],
      steps: [b('433:436', 'value')],
      cfg: [b('433:437', 'value')],
    },
    outputs: [{ node: '469', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    notes: 'Official template default keeps "Enable Lightning LoRA" ON (4 steps, cfg 1). Input is rescaled to ~1 MP (FluxKontextImageScale); output size follows the input.',
  },
  {
    id: 'qwen-image-edit-2511',
    title: 'Qwen-Image-Edit 2511',
    capability: 'edit',
    export: 'image_qwen_image_edit_2511',
    transforms: [
      { op: 'resolveSwitches', booleans: { '170:168': false } },
      // Single-image edit: drop the template's second (material) reference.
      { op: 'delete', node: '170:149', input: 'image2' },
      { op: 'delete', node: '170:151', input: 'image2' },
    ],
    bindings: {
      prompt: [b('170:151', 'prompt')],
      negativePrompt: [b('170:149', 'prompt')],
      image: [b('41', 'image')],
      seed: [b('170:169', 'seed')],
      steps: [b('170:166', 'value')],
      cfg: [b('170:154', 'value')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    notes: 'Derived from the official 2511 "material replacement" template with the 2nd reference removed. 40 steps, cfg 4 (Lightning LoRA path disabled). Better identity/consistency than 2509.',
  },
  {
    id: 'qwen-image-edit-2511-multi',
    title: 'Qwen-Image-Edit 2511 Multi-Image (3 images)',
    capability: 'edit',
    export: 'image_qwen_image_edit_2511',
    transforms: [
      { op: 'resolveSwitches', booleans: { '170:168': false } },
      { op: 'addNodes', nodes: { 1201: { class_type: 'LoadImage', inputs: { image: 'reference3.png' }, _meta: { title: 'Load Image (image 3)' } } } },
      { op: 'set', node: '170:149', input: 'image3', value: ['1201', 0] },
      { op: 'set', node: '170:151', input: 'image3', value: ['1201', 0] },
    ],
    bindings: {
      prompt: [b('170:151', 'prompt')],
      negativePrompt: [b('170:149', 'prompt')],
      image: [b('41', 'image')],
      image2: [b('83', 'image')],
      image3: [b('1201', 'image')],
      seed: [b('170:169', 'seed')],
      steps: [b('170:166', 'value')],
      cfg: [b('170:154', 'value')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    notes: 'TextEncodeQwenImageEditPlus takes up to 3 images; refer to them as "image 1/2/3" in the prompt. All three are required. Output size follows image 1.',
  },
  {
    id: 'flux1-kontext-dev-edit',
    title: 'FLUX.1 Kontext [dev] Image Edit',
    capability: 'edit',
    export: 'flux_kontext_dev_basic',
    bindings: {
      prompt: [b('192:6', 'text')],
      image: [b('190', 'image')],
      seed: [b('192:31', 'seed')],
      steps: [b('192:31', 'steps')],
      guidance: [b('192:35', 'guidance')],
    },
    outputs: [{ node: '136', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 16,
    notes: 'Instruction edit ("change the background to ..."). Output follows the input aspect at ~1 MP (FluxKontextImageScale).',
  },
  {
    id: 'flux1-fill-inpaint',
    title: 'FLUX.1 Fill [dev] Inpaint',
    capability: 'inpaint',
    export: 'flux_fill_inpaint_example',
    transforms: [
      // Separate mask upload (white = repaint) instead of the template's image alpha channel.
      { op: 'addNodes', nodes: { 1301: { class_type: 'LoadImageMask', inputs: { image: 'mask.png', channel: 'red' }, _meta: { title: 'Load Mask (white = inpaint)' } } } },
      { op: 'set', node: '47:38', input: 'mask', value: ['1301', 0] },
    ],
    bindings: {
      prompt: [b('47:23', 'text')],
      image: [b('17', 'image')],
      mask: [b('1301', 'image')],
      seed: [b('47:3', 'seed')],
      steps: [b('47:3', 'steps')],
      guidance: [b('47:26', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    notes: 'mask = separate uploaded PNG, same size as image, read from the RED channel: white (255) = area to regenerate, black = keep. Guidance 30 is correct for Fill.',
  },
  {
    id: 'flux1-fill-outpaint',
    title: 'FLUX.1 Fill [dev] Outpaint',
    capability: 'outpaint',
    export: 'flux_fill_outpaint_example',
    bindings: {
      prompt: [b('23', 'text')],
      image: [b('17', 'image')],
      padLeft: [b('44', 'left')],
      padTop: [b('44', 'top')],
      padRight: [b('44', 'right')],
      padBottom: [b('44', 'bottom')],
      seed: [b('3', 'seed')],
      steps: [b('3', 'steps')],
      guidance: [b('26', 'guidance')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, padMultiple: 8 },
    vramGb: 24,
    notes: 'Extends the canvas by padLeft/padTop/padRight/padBottom pixels (multiples of 8) and fills it. Keep final size <= ~2 MP.',
  },
  {
    id: 'upscale-image-esrgan',
    title: 'Image Upscale (Real-ESRGAN 4x)',
    capability: 'upscale-image',
    handBuilt: 'hand-built/upscale-image-esrgan.json',
    bindings: {
      image: [b('1', 'image')],
      upscaleModel: [b('2', 'model_name')],
      scale: [b('4', 'scale_by')],
    },
    outputs: [{ node: '5', kind: 'image' }],
    limits: { maxWidth: 8192, maxHeight: 8192 },
    vramGb: 4,
    notes: 'Hand-built: UpscaleModelLoader -> ImageUpscaleWithModel -> ImageScaleBy. The model fixes the factor (x4 for RealESRGAN_x4plus); `scale` resizes AFTER the model (0.5 => net 2x). Any spandrel-supported model in models/upscale_models works as upscaleModel.',
  },
  {
    id: 'upscale-image-seedvr2',
    title: 'Image Upscale / Restore (SeedVR2 7B int8)',
    capability: 'upscale-image',
    export: 'utility_seedvr2_7b_int8_upscale_image',
    transforms: [{ op: 'removeOutputs', ids: ['65'] }],
    bindings: {
      image: [b('1', 'image')],
      scale: [b('66:57', 'resize_type.multiplier')],
      seed: [b('66:54', 'seed')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 16,
    notes: 'Native SeedVR2 nodes (core ComfyUI >= 0.28), one-step diffusion restoration. scale = output multiplier (template 4). The numz/ComfyUI-SeedVR2_VideoUpscaler pack is NOT used (it cannot register on CPU-only hosts and is superseded by core nodes).',
  },
  {
    id: 'restore-qwen-image-21',
    title: 'Restore an old or damaged photo, same faces and framing (Qwen-Image 2.1 + AusBoss Restore LoRA, then SeedVR2 2x)',
    capability: 'edit',
    handBuilt: 'hand-built/restore-qwen-image-21.json',
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')],
      seed: [b('32', 'seed'), b('56', 'seed')], steps: [b('32', 'steps')],
      loraStrength: [b('4', 'strength_model')], scale: [b('52', 'resize_type.multiplier')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    defaults: { steps: 25, loraStrength: 1, scale: 2 },
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; Restore LoRA by AusBoss under the same licence; SeedVR2 Apache-2.0',
    notes:
      'One restore pass as the Restore LoRA card sets it up, then a SeedVR2 enlargement. The photo is scaled to about 2 MP on the 32 grid (ImageScaleToTotalPixels, lanczos: ' +
      'small prints grow to it, big noisy ones shrink to it, as the card asks) -> UNETLoader -> LoraLoaderModelOnly (qwen-image-2.1-restore, step 1,500; loraStrength 1.0, 0.5 for a blurry photo) -> ' +
      'QwenImage21Cache -> TextEncodeQwenImage21 (the photo as image 1, resolution 0, no negative) -> KSampler on its latent, 25 steps, cfg 1, euler, simple, denoise 1 -> ' +
      'VAEDecode -> SplitImageWithAlpha. Then SeedVR2 7B int8 one step (the nodes of the upscale-image-seedvr2 template): ResizeImageMaskNode x scale (2) lanczos -> Preprocess -> ' +
      'VAEEncodeTiled 512/128 -> Conditioning -> KSampler 1 step -> VAEDecodeTiled -> PostProcessing (lab colour from the restored photo). About 8 MP out. ' +
      'Prompt: one of the two instructions the LoRA was trained on, alone (a wrong "Scene:" description painted features that were not there). No turbo LoRA (25 steps sat closer: 0.15 px, face 0.90). ' +
      'One pass only (a second came back crunchy); never with the Consistency or Outfit-Swap LoRA. Faces under about 100 px can come back as a slightly different person. ' +
      'The open route of the Restore Photo app. RTX 5090: about 70 s a photo at 25 steps, peak about 31 GB.',
  },
  {
    id: 'bg-remove-birefnet',
    title: 'Remove Background (BiRefNet, native)',
    capability: 'bg-remove',
    export: 'utility_birefnet_remove_background',
    transforms: [
      { op: 'removeOutputs', ids: ['18', '20'] },
      { op: 'addNodes', nodes: { 1401: { class_type: 'SaveImage', inputs: { images: ['19:16', 0], filename_prefix: 'ComfyUI' }, _meta: { title: 'Save Image (RGBA)' } } } },
    ],
    bindings: { image: [b('17', 'image')] },
    outputs: [{ node: '1401', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 4,
    notes: 'Native core nodes (LoadBackgroundRemovalModel/RemoveBackground). Output is an RGBA PNG (transparent background). Template preview nodes replaced with SaveImage. MIT-licensed model.',
  },
  {
    id: 'bg-remove-rmbg',
    title: 'Remove Background (ComfyUI-RMBG, BEN2)',
    capability: 'bg-remove',
    handBuilt: 'hand-built/bg-remove-rmbg.json',
    bindings: { image: [b('1', 'image')] },
    outputs: [{ node: '3', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 4,
    autoDownloads: ['ComfyUI-RMBG downloads the selected model (BEN2 -> models/RMBG/BEN2) from Hugging Face on first run'],
    notes: 'Custom pack alternative to bg-remove-birefnet. Model choices on node 2: RMBG-2.0 (best, but CC BY-NC 4.0 non-commercial), INSPYRENET, BEN, BEN2 (default). Output RGBA PNG.',
  },
  {
    id: 'image-matte-feynobg',
    title: 'Fine-hair cut-out (FeyNoBg, ComfyUI-RMBG 3.3.0)',
    capability: 'bg-remove',
    handBuilt: 'hand-built/image-matte-feynobg.json',
    packs: ['ComfyUI-RMBG'],
    bindings: { image: [b('1', 'image')] },
    outputs: [{ node: '3', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 4,
    license: 'FeyNoBg weights: unknown (the Hugging Face repo 1038lab/FeyNobg has no card, no licence tag and no LICENSE file, checked 2026-11-02); ComfyUI-RMBG code GPL-3.0',
    autoDownloads: ['AILab_FeyNoBg downloads config.json, FeyNobg.safetensors (1.05 GB) and preprocessor_config.json from 1038lab/FeyNobg into models/RMBG/FeyNoBg/ on first run'],
    notes:
      'AILab_FeyNoBg (ComfyUI-RMBG 3.3.0): a 263M Swin-L matting model for hair, fur, glass and lace, no trimap; refine_foreground on (sub-pixel edge refinement), background Alpha -> RGBA PNG. ' +
      'Needs the nobg Python package (the pack\'s requirements.txt: nobg>=0.3.1). The class is recorded from ComfyUI-RMBG\'s source at the pinned commit.',
  },
  {
    id: 'face-swap-reactor',
    title: 'Face Swap (ReActor)',
    capability: 'face-swap',
    handBuilt: 'hand-built/face-swap-reactor.json',
    bindings: {
      image: [b('1', 'image')],
      image2: [b('2', 'image')],
    },
    outputs: [{ node: '4', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 4,
    autoDownloads: [
      'insightface buffalo_l face analysis models -> models/insightface/models/buffalo_l (downloaded by ReActor on first run)',
      'retinaface_resnet50 detector -> models/facedetection (downloaded on first run)',
    ],
    notes: 'image = target photo (faces get replaced), image2 = source face. inswapper_128 is research/non-commercial licensed; ReActor applies an NSFW detector by default. Requires the insightface Python package (insightface 2.1 installs from pip on Python 3.13).',
  },

  // =========================================================================
  // VIDEO
  // =========================================================================
  wanT2V(false),
  wanT2V(true),
  wanI2V('base'),
  wanI2V('lightx2v'),
  wanI2V('lora'),
  {
    id: 'wan22-ti2v-5b',
    title: 'Wan 2.2 5B Text to Video (720p)',
    capability: 't2v',
    export: 'video_wan2_2_5B_ti2v',
    bindings: {
      prompt: [b('6', 'text')],
      negativePrompt: [b('7', 'text')],
      width: [b('55', 'width')],
      height: [b('55', 'height')],
      frames: [b('55', 'length')],
      fps: [b('57', 'fps')],
      seed: [b('3', 'seed')],
      steps: [b('3', 'steps')],
      cfg: [b('3', 'cfg')],
      shift: [b('48', 'shift')],
    },
    outputs: [{ node: '58', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 32, frameStep: 4 },
    vramGb: 12,
    notes: 'Dense 5B model with the high-compression Wan2.2 VAE: 1280x704 @24 fps, 121 frames (5 s). Fits 12 GB with offloading. Best consumer-GPU video option.',
  },
  {
    id: 'wan22-ti2v-5b-i2v',
    title: 'Wan 2.2 5B Image to Video (720p)',
    capability: 'i2v',
    export: 'video_wan2_2_5B_ti2v',
    transforms: [
      { op: 'addNodes', nodes: { 1501: { class_type: 'LoadImage', inputs: { image: 'start.png' }, _meta: { title: 'Load Image (start frame)' } } } },
      { op: 'set', node: '55', input: 'start_image', value: ['1501', 0] },
    ],
    bindings: {
      prompt: [b('6', 'text')],
      negativePrompt: [b('7', 'text')],
      image: [b('1501', 'image')],
      width: [b('55', 'width')],
      height: [b('55', 'height')],
      frames: [b('55', 'length')],
      fps: [b('57', 'fps')],
      seed: [b('3', 'seed')],
      steps: [b('3', 'steps')],
      cfg: [b('3', 'cfg')],
      shift: [b('48', 'shift')],
    },
    outputs: [{ node: '58', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 32, frameStep: 4 },
    vramGb: 12,
    notes: 'Same as wan22-ti2v-5b with the optional start_image input of Wan22ImageToVideoLatent wired to a LoadImage (the official template documents this as the I2V mode). Image is used at the given width/height; pre-crop to the target aspect.',
  },
  {
    id: 'wan22-flf2v-14b',
    title: 'Wan 2.2 14B First-Last Frame to Video',
    capability: 'flf2v',
    export: 'video_wan2_2_14B_flf2v',
    bindings: {
      prompt: [b('90', 'text')],
      negativePrompt: [b('78', 'text')],
      image: [b('80', 'image')],
      endImage: [b('89', 'image')],
      width: [b('81', 'width')],
      height: [b('81', 'height')],
      frames: [b('81', 'length')],
      fps: [b('86', 'fps')],
      seed: [b('84', 'noise_seed'), b('87', 'noise_seed')],
      steps: [b('84', 'steps'), b('87', 'steps')],
      cfg: [b('84', 'cfg'), b('87', 'cfg')],
      shift: [b('73', 'shift'), b('74', 'shift')],
    },
    outputs: [{ node: '83', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes: 'Uses the Wan 2.2 I2V high/low experts. High->low switch at step 10 (end_at_step of node 84 / start_at_step of node 87, not a binding). Start and end images should share the output aspect ratio.',
  },
  {
    // Keyframe animation: Fuobe Animation on your GPU. The library file holds two keyframes (one pass);
    // the provider rewrites it for 2-10 keyframes (expand: 'keyframes', src/lib/av/inbetween-graph.ts), all passes on one set of loaders.
    id: 'wan22-inbetween-anisora',
    title: 'Keyframe animation: Wan 2.2 14B first/last-frame in-betweens with AniSora 3.2, every Nth frame per gap, one video',
    capability: 'keyframes',
    handBuilt: 'hand-built/wan22-inbetween-anisora.json',
    bindings: {
      prompt: [b('p1', 'text')],
      negativePrompt: [b('9', 'text')],
      image: [b('k1', 'image')],
      endImage: [b('k2', 'image')],
      width: [b('f1', 'width')],
      height: [b('f1', 'height')],
      frames: [b('f1', 'length')],
      fps: [b('video', 'fps')],
      seed: [b('h1', 'noise_seed')],
      shift: [b('3', 'shift'), b('6', 'shift')],
    },
    outputs: [{ node: 'save', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 81, dimensionMultiple: 16, frameStep: 4 },
    expand: 'keyframes',
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.2 I2V A14B, lightx2v 4-step LoRA, bilibili Index-AniSora V3.2; Kijai\'s AniSora extraction states no licence of its own)',
    notes:
      'One Wan 2.2 FLF2V pass per pair of neighbouring keyframes, all sharing one set of loaders: the high-noise expert with AniSora 3.2 (strength 1) and the low-noise expert with the lightx2v 4-step LoRA (strength 1), ModelSamplingSD3 shift 5 on both, ' +
      'KSamplerAdvanced 4 steps at CFG 1, euler / simple, high 0-2 with leftover noise, low 2-end; umt5 fp8, Wan 2.1 VAE, Wan\'s standard negative words. Each pass has its own length (4n + 1, 17-81 frames), words and seed. ' +
      'VHS_SelectEveryNthImage keeps every Nth frame (1-4) counted back from the next keyframe (skip_first_images = ((length - 2) mod N) + 1), so each pose is on screen and no joint shows a frame twice; keyframe 1 (ImageFromBatch of pass 1) goes in front; ' +
      'BatchImagesNode joins them in order and CreateVideo plays them at 24 fps (snappier, the passes are made at 16 fps) or 16 fps (true time). About 24 GB of VRAM at 720p; RAM for the decoded frames grows with the total length.',
  },
  {
    id: 'wan22-fun-camera-14b',
    title: 'Wan 2.2 14B Fun Camera Control (image to video)',
    capability: 'camera-motion',
    export: 'video_wan2_2_14B_fun_camera',
    transforms: [{ op: 'set', node: '108', input: 'camera_pose', value: 'Zoom In' }],
    bindings: {
      prompt: [b('107', 'text')],
      negativePrompt: [b('99', 'text')],
      image: [b('97', 'image')],
      cameraMotion: [b('108', 'camera_pose')],
      width: [b('108', 'width')],
      height: [b('108', 'height')],
      frames: [b('108', 'length')],
      fps: [b('105', 'fps')],
      seed: [b('102', 'noise_seed'), b('103', 'noise_seed')],
      steps: [b('102', 'steps'), b('103', 'steps')],
      cfg: [b('102', 'cfg'), b('103', 'cfg')],
      shift: [b('100', 'shift'), b('101', 'shift')],
    },
    outputs: [{ node: '106', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes: 'cameraMotion is one of: Static, Pan Up, Pan Down, Pan Left, Pan Right, Zoom In, Zoom Out, Anti Clockwise (ACW), ClockWise (CW). width/height/frames live on WanCameraEmbedding (node 108) which feeds WanCameraImageToVideo. Default changed from "Static" to "Zoom In".',
  },
  {
    id: 'wan22-fun-control-14b',
    title: 'Wan 2.2 14B Fun Control (reference image + control video)',
    capability: 'motion-transfer',
    export: 'video_wan2_2_14B_fun_control',
    transforms: [
      // The template feeds a pre-processed control video; we preprocess in-graph with native Canny
      // (same thresholds the template uses in its bypassed 4-step variant) so a raw video works.
      { op: 'addNodes', nodes: { 1601: { class_type: 'Canny', inputs: { image: ['156', 0], low_threshold: 0.1, high_threshold: 0.6 }, _meta: { title: 'Canny (control preprocessing)' } } } },
      { op: 'set', node: '160', input: 'control_video', value: ['1601', 0] },
      // Fuobe's own words in place of the template's sample (src/lib/comfy-prompts.ts writes them for every run).
      { op: 'set', node: '99', input: 'text', value: 'The person from the reference picture, with their own face, hair, body and complete outfit, moves exactly like the person in the driving video, in the setting and light of the reference picture.' },
    ],
    bindings: {
      prompt: [b('99', 'text')],
      negativePrompt: [b('91', 'text')],
      image: [b('145', 'image')],
      video: [b('158', 'file')],
      width: [b('160', 'width')],
      height: [b('160', 'height')],
      frames: [b('160', 'length')],
      fps: [b('100', 'fps')],
      seed: [b('96', 'noise_seed'), b('95', 'noise_seed')],
      steps: [b('96', 'steps'), b('95', 'steps')],
      cfg: [b('96', 'cfg'), b('95', 'cfg')],
      shift: [b('93', 'shift'), b('94', 'shift')],
    },
    outputs: [{ node: '98', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes: 'image = reference/first frame (style + identity), video = driving clip; structure/motion is transferred via Canny edges computed in-graph (node 1601). Only the first `frames` frames of the video are used; feed a ~16 fps clip so motion speed is preserved. Swap node 1601 for depth/pose preprocessors if you install comfyui_controlnet_aux.',
  },
  {
    id: 'wan21-vace-14b-ref2v',
    title: 'Wan 2.1 VACE 14B Reference to Video',
    capability: 'ref2v',
    export: 'video_wan_vace_14B_ref2v',
    transforms: [
      // The template's CausVid LoRA is CC-BY-NC-4.0 (tianweiy/CausVid): the Apache-2.0 lightx2v T2V 4-step LoRA replaces it,
      // with the sampler settings of the round-4 VACE graphs (docs/research/comfyui-oss-4.md, section b).
      { op: 'set', node: '115', input: 'lora_name', value: 'lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors' },
      { op: 'set', node: '115', input: 'strength_model', value: 1 },
      { op: 'set', node: '115', input: 'strength_clip', value: 0 },
      { op: 'set', node: '108', input: 'sampler_name', value: 'euler' },
      { op: 'set', node: '110', input: 'shift', value: 5 },
    ],
    bindings: {
      prompt: [b('105', 'text')],
      negativePrompt: [b('107', 'text')],
      image: [b('73', 'image')],
      width: [b('109', 'width')],
      height: [b('109', 'height')],
      frames: [b('109', 'length')],
      fps: [b('68', 'fps')],
      seed: [b('108', 'seed')],
      steps: [b('108', 'steps')],
      cfg: [b('108', 'cfg')],
      shift: [b('110', 'shift')],
      loraStrength: [b('115', 'strength_model')],
    },
    outputs: [{ node: '69', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 32,
    license: 'Apache-2.0 (Wan 2.1 VACE 14B, lightx2v T2V LoRA, umT5, Wan VAE)',
    notes:
      'Subject/character reference (not a first frame): the reference appears in a newly composed scene. fp16 14B weights (34.7 GB) + the lightx2v T2V 4-step LoRA at 1.0: 4 steps, cfg 1, euler, shift 5 ' +
      '(loraStrength 0 + steps 20 + cfg 6 = the slow full-quality path). 24 GB cards need weight_dtype fp8_e4m3fn on node 113. ' +
      'The template ships the CausVid LoRA (CC-BY-NC-4.0, non-commercial) at 0.3 with uni_pc and shift 8; here the Apache-2.0 lightx2v LoRA ' +
      '(lightx2v/Wan2.1-T2V-14B-StepDistill-CfgDistill) replaces it, with the sampler settings of the other Wan VACE graphs.',
  },
  {
    id: 'wan22-s2v-14b',
    title: 'Wan 2.2 S2V 14B Talking Video (image + audio)',
    capability: 'lipsync',
    export: 'video_wan2_2_14B_s2v',
    // Fuobe's neutral line in place of the template's sample (src/lib/comfy-prompts.ts).
    transforms: [{ op: 'set', node: '6', input: 'text', value: 'A person is talking to the camera.' }],
    bindings: {
      prompt: [b('6', 'text')],
      negativePrompt: [b('7', 'text')],
      image: [b('52', 'image')],
      audio: [b('58', 'audio')],
      width: [b('93', 'width')],
      height: [b('93', 'height')],
      seed: [b('3', 'seed'), b('79:77', 'seed'), b('85:183', 'seed')],
      steps: [b('103', 'value')],
      cfg: [b('105', 'value')],
    },
    outputs: [{ node: '113', kind: 'video' }],
    limits: { maxWidth: 1024, maxHeight: 1024, dimensionMultiple: 16, maxDurationSec: 14 },
    vramGb: 24,
    notes: 'Audio-driven speaking/singing video with body motion. Fixed length: 1 base chunk + 2 extend subgraphs of 77 frames @16 fps (~14 s); shorter audio is padded, longer audio is cut. Output muxes the input audio. Uses the lightx2v 4-step LoRA by default (steps 4, cfg 1; without it use 20 / 6.0).',
  },
  {
    id: 'wan-animate2',
    title: 'Wan Animate 2 Motion Transfer (character + driving video)',
    capability: 'motion-transfer',
    export: 'video_wan_animate2',
    transforms: [
      { op: 'removeOutputs', ids: ['292'] },
      { op: 'resolveSwitches' },
      { op: 'set', node: '672:585', input: 'text', value: 'The character performs exactly the same movements as the person in the driving video, background stationary' },
      // Fuobe's own words in place of the template's sample (src/lib/comfy-prompts.ts writes them for every run).
      { op: 'set', node: '672:582', input: 'text', value: 'Character Description: The person from the reference picture, with their own face, hair, body and complete outfit.\nBackground description: The setting, background and light of the reference picture.' },
    ],
    bindings: {
      prompt: [b('672:582', 'text')],
      negativePrompt: [b('672:581', 'text')],
      image: [b('189', 'image')],
      video: [b('240', 'file')],
      width: [b('672:600', 'resize_type.width')],
      height: [b('672:600', 'resize_type.height')],
      seed: [b('672:597', 'noise_seed')],
      steps: [b('672:591', 'steps')],
    },
    outputs: [{ node: '246', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16 },
    vramGb: 24,
    notes: 'image = character reference, video = driving video (raw frames; no pose extraction needed). Processes the whole driving video in 81-frame fragments via native loop nodes; output keeps the driving video fps + audio. prompt = character/background description (node 672:582); the separate pose prompt (672:585) is set to a generic motion description. The side-by-side comparison output of the template was removed.',
  },
  {
    id: 'hunyuan15-t2v-720p',
    title: 'HunyuanVideo 1.5 Text to Video (720p)',
    capability: 't2v',
    export: 'video_hunyuan_video_1.5_720p_t2v',
    bindings: {
      prompt: [b('44', 'text')],
      negativePrompt: [b('93', 'text')],
      width: [b('124', 'width')],
      height: [b('124', 'height')],
      frames: [b('124', 'length')],
      fps: [b('101', 'fps')],
      seed: [b('129', 'noise_seed')],
      steps: [b('128', 'steps')],
      cfg: [b('131', 'cfg')],
      shift: [b('132', 'shift')],
    },
    outputs: [{ node: '102', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes: '8.3B model, 1280x720, 121 frames @24 fps (5 s), 20 steps cfg 6. The template\'s optional 1080p super-resolution stage is bypassed (not exported).',
  },
  {
    id: 'hunyuan15-i2v-720p',
    title: 'HunyuanVideo 1.5 Image to Video (720p)',
    capability: 'i2v',
    export: 'video_hunyuan_video_1.5_720p_i2v',
    bindings: {
      prompt: [b('44', 'text')],
      negativePrompt: [b('93', 'text')],
      image: [b('80', 'image')],
      width: [b('78', 'width')],
      height: [b('78', 'height')],
      frames: [b('78', 'length')],
      fps: [b('101', 'fps')],
      seed: [b('127', 'noise_seed')],
      steps: [b('126', 'steps')],
      cfg: [b('129', 'cfg')],
      shift: [b('130', 'shift')],
    },
    outputs: [{ node: '102', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    notes: 'Uses SigCLIP vision conditioning + first frame. 1280x720, 121 frames @24 fps.',
  },
  {
    id: 'ltx2-t2v',
    title: 'LTX-2 Text to Video + Audio',
    capability: 't2v',
    export: 'video_ltx2_t2v',
    bindings: {
      prompt: [b('92:3', 'text')],
      negativePrompt: [b('92:4', 'text')],
      width: [b('92:89', 'width')],
      height: [b('92:89', 'height')],
      frames: [b('92:62', 'value')],
      fps: [b('92:102', 'value'), b('92:103', 'value')],
      seed: [b('92:11', 'noise_seed'), b('92:67', 'noise_seed')],
      steps: [b('92:9', 'steps')],
      cfg: [b('92:47', 'cfg')],
    },
    outputs: [{ node: '75', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 257, dimensionMultiple: 64, frameStep: 8 },
    vramGb: 32,
    notes: 'Generates synchronized audio (speech/SFX/music) together with video. Two-stage: base pass at width/2 x height/2, then 2x latent upscale + 3-step distilled refine, so width/height are the FINAL size (multiples of 64). frames must be 8n+1 (121 = 5 s @24 fps). fps is set on both the float and int primitives.',
  },
  {
    id: 'ltx2-i2v',
    title: 'LTX-2 Image to Video + Audio',
    capability: 'i2v',
    export: 'video_ltx2_i2v',
    bindings: {
      prompt: [b('92:3', 'text')],
      negativePrompt: [b('92:4', 'text')],
      image: [b('98', 'image')],
      width: [b('102', 'resize_type.width')],
      height: [b('102', 'resize_type.height')],
      frames: [b('92:62', 'value')],
      fps: [b('92:22', 'frame_rate'), b('92:51', 'frame_rate'), b('92:97', 'fps')],
      seed: [b('92:11', 'noise_seed'), b('92:67', 'noise_seed')],
      steps: [b('92:9', 'steps')],
      cfg: [b('92:47', 'cfg')],
    },
    outputs: [{ node: '75', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 257, dimensionMultiple: 64, frameStep: 8 },
    vramGb: 32,
    notes: 'Input image is center-cropped/resized to width x height (node 102). Same two-stage pipeline as ltx2-t2v; produces audio. fps (25 by default) must be set in three places (all listed).',
  },
  {
    id: 'ltx25-t2v',
    title: 'LTX-2.5 Text to Video + Audio (distilled)',
    capability: 't2v',
    export: 'video_ltx2_5_t2v',
    transforms: [
      { op: 'removeOutputs', ids: ['405:381'] },
      { op: 'resolveSwitches', booleans: { '405:383': false } },
      // Replace the ResolutionSelector-driven size and duration*fps math with plain values.
      { op: 'set', node: '405:372', input: 'value', value: 1280 },
      { op: 'set', node: '405:360', input: 'value', value: 704 },
      { op: 'set', node: '405:356', input: 'length', value: 121 },
      { op: 'set', node: '405:366', input: 'frames_number', value: 121 },
    ],
    bindings: {
      prompt: [b('405:376', 'value')],
      negativePrompt: [b('405:373', 'text')],
      width: [b('405:372', 'value')],
      height: [b('405:360', 'value')],
      frames: [b('405:356', 'length'), b('405:366', 'frames_number')],
      fps: [b('405:361', 'value')],
      seed: [b('405:339', 'noise_seed'), b('405:338', 'noise_seed')],
    },
    outputs: [{ node: '75', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 241, dimensionMultiple: 64, frameStep: 8 },
    vramGb: 24,
    notes: 'Newest LTX (22B distilled, int8). Fixed manual sigma schedules (no steps/cfg). width/height are FINAL size (base pass at half size, then 2x latent upscale) -> multiples of 64. frames = seconds*fps+1 (template default 5 s @24 fps = 121). The template\'s optional Gemma prompt-enhancer branch is disabled.',
  },
  {
    id: 'ltx25-i2v',
    title: 'LTX-2.5 Image to Video + Audio (distilled)',
    capability: 'i2v',
    export: 'video_ltx2_5_i2v',
    transforms: [
      { op: 'removeOutputs', ids: ['398:381'] },
      { op: 'resolveSwitches', booleans: { '398:383': false } },
      { op: 'set', node: '398:372', input: 'value', value: 1280 },
      { op: 'set', node: '398:360', input: 'value', value: 704 },
      { op: 'set', node: '398:356', input: 'length', value: 121 },
      { op: 'set', node: '398:366', input: 'frames_number', value: 121 },
    ],
    bindings: {
      prompt: [b('398:376', 'value')],
      negativePrompt: [b('398:373', 'text')],
      image: [b('395', 'image')],
      width: [b('398:372', 'value')],
      height: [b('398:360', 'value')],
      frames: [b('398:356', 'length'), b('398:366', 'frames_number')],
      fps: [b('398:361', 'value')],
      seed: [b('398:339', 'noise_seed'), b('398:338', 'noise_seed')],
    },
    outputs: [{ node: '75', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 241, dimensionMultiple: 64, frameStep: 8 },
    vramGb: 24,
    notes: 'First-frame conditioning (strength 0.7 base pass, 1.0 refine). Same size/frames rules as ltx25-t2v. Image is resized to longer side 1536 before conditioning; give it the output aspect ratio.',
  },
  // ---- MiniMax H3 as a video model: text, image and start + end frame to video with sound, on the fl2va model.
  // Fast: larryvrh's turbo v4 LoRA at 1.0, 8 steps, SLA attention (sparsity 0.85) and the AdaLN LoRA fix. Best (-hq): the
  // same model without them, 20 steps res_multistep, core nodes only. Orbit: pablodawson's 360 Orbit LoRA, with the still
  // as both first and last frame. Not yet validated.
  {
    id: 'minimax-h3-t2v',
    title: 'MiniMax H3 Text to Video + Audio (turbo v4, 8 steps)',
    capability: 't2v',
    handBuilt: 'hand-built/minimax-h3-t2v.json',
    packs: ['ComfyUI-MiniMax-H3-Turbo', 'plaguekind-nodes'],
    bindings: {
      prompt: [b('131', 'prompt')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')], loraStrength: [b('134', 'strength')],
      vae: [b('136', 'vae_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8, loraStrength: 1 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    optionalModels: [H3_SOL_VAE],
    license: `${H3_LICENSE_FAST}${H3_LICENSE_SOL}`,
    notes:
      'Text to video with sound: MiniMaxH3ImageToVideo with no frames given, the fl2va pruned int8 model with the turbo v4 LoRA at 1.0 (MiniMaxH3TurboLoRA, ' +
      'MiniMaxH3TurboSampler), BasicScheduler simple 8 steps, H3SLAAttention (sparsity 0.85, block 64, int8 QK; needs Triton) and H3AdaLNLoRAFix (port), CFG 1. ' +
      `${H3_NOTES_COMMON} ${H3_NOTES_TIME}`,
  },
  {
    id: 'minimax-h3-i2v',
    title: 'MiniMax H3 Image to Video + Audio (turbo v4, 8 steps)',
    capability: 'i2v',
    handBuilt: 'hand-built/minimax-h3-i2v.json',
    packs: ['ComfyUI-MiniMax-H3-Turbo', 'plaguekind-nodes'],
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')], loraStrength: [b('134', 'strength')],
      vae: [b('136', 'vae_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8, loraStrength: 1 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    optionalModels: [H3_SOL_VAE],
    license: `${H3_LICENSE_FAST}${H3_LICENSE_SOL}`,
    notes:
      'Image to video with sound: image = the first frame (MiniMaxH3ImageToVideo first_frame), the fl2va pruned int8 model with the turbo v4 LoRA at 1.0, ' +
      `8 steps, SLA attention (sparsity 0.85; needs Triton) and the AdaLN LoRA fix, CFG 1. ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_COMMON} ${H3_NOTES_TIME}`,
  },
  {
    id: 'minimax-h3-flf2v',
    title: 'MiniMax H3 Start + End Frame to Video + Audio (turbo v4, 8 steps)',
    capability: 'flf2v',
    handBuilt: 'hand-built/minimax-h3-flf2v.json',
    packs: ['ComfyUI-MiniMax-H3-Turbo', 'plaguekind-nodes'],
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')], endImage: [b('140', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')], loraStrength: [b('134', 'strength')],
      vae: [b('136', 'vae_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8, loraStrength: 1 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    optionalModels: [H3_SOL_VAE],
    license: `${H3_LICENSE_FAST}${H3_LICENSE_SOL}`,
    notes:
      'Start and end frame to video with sound: image = the first frame, endImage = the last (cover-cropped to the canvas), the fl2va pruned int8 model with ' +
      `the turbo v4 LoRA at 1.0, 8 steps, SLA attention (sparsity 0.85; needs Triton) and the AdaLN LoRA fix, CFG 1. ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_COMMON} ${H3_NOTES_TIME}`,
  },
  {
    id: 'minimax-h3-t2v-hq',
    title: 'MiniMax H3 Text to Video + Audio (20 steps)',
    capability: 't2v',
    handBuilt: 'hand-built/minimax-h3-t2v-hq.json',
    bindings: {
      prompt: [b('131', 'prompt')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')],
      vae: [b('136', 'vae_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 20 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    optionalModels: [H3_SOL_VAE],
    license: `${H3_LICENSE}${H3_LICENSE_SOL}`,
    notes:
      'Text to video with sound, the sharper setting: the fl2va pruned int8 model without the turbo LoRA, BasicScheduler simple 20 steps, KSamplerSelect res_multistep, ' +
      `CFG 1; core nodes only. About 2.3 times as long as minimax-h3-t2v. ${H3_NOTES_COMMON}`,
  },
  {
    id: 'minimax-h3-i2v-hq',
    title: 'MiniMax H3 Image to Video + Audio (20 steps)',
    capability: 'i2v',
    handBuilt: 'hand-built/minimax-h3-i2v-hq.json',
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')],
      vae: [b('136', 'vae_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 20 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    optionalModels: [H3_SOL_VAE],
    license: `${H3_LICENSE}${H3_LICENSE_SOL}`,
    notes:
      'Image to video with sound, the sharper setting: image = the first frame, the fl2va pruned int8 model without the turbo LoRA, 20 steps res_multistep, CFG 1; ' +
      `core nodes only. About 2.3 times as long as minimax-h3-i2v. ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_COMMON}`,
  },
  {
    id: 'minimax-h3-flf2v-hq',
    title: 'MiniMax H3 Start + End Frame to Video + Audio (20 steps)',
    capability: 'flf2v',
    handBuilt: 'hand-built/minimax-h3-flf2v-hq.json',
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')], endImage: [b('140', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')],
      vae: [b('136', 'vae_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 20 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    optionalModels: [H3_SOL_VAE],
    license: `${H3_LICENSE}${H3_LICENSE_SOL}`,
    notes:
      'Start and end frame to video with sound, the sharper setting: image = the first frame, endImage = the last, the fl2va pruned int8 model without the turbo LoRA, ' +
      `20 steps res_multistep, CFG 1; core nodes only. About 2.3 times as long as minimax-h3-flf2v. ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_COMMON}`,
  },
  {
    id: 'minimax-h3-orbit',
    title: 'MiniMax H3 360-degree orbit of a still + Audio (Orbit LoRA, 28 steps)',
    capability: 'i2v',
    handBuilt: 'hand-built/minimax-h3-orbit.json',
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 73, fps: 24, steps: 28 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    license: `${H3_LICENSE} · pablodawson's 360 Orbit LoRA under the same MiniMax H3 Community License`,
    notes:
      'A camera orbit around one frozen instant: image (LoadImage 138) is both the first and the last frame of MiniMaxH3ImageToVideo. The fl2va pruned int8 model ' +
      "with pablodawson's 360 Orbit LoRA (minimax_h3_flf2v_lora_v1, LoraLoaderModelOnly at 1.0), MiniMaxH3SigmaShift 12 / 3, BasicScheduler simple 28 steps, " +
      "KSamplerSelect res_multistep, CFG 1; core nodes only. 73 frames (3.04 s) is the LoRA's training length. The prompt reads best in the LoRA's own caption style: " +
      'one frozen instant, the camera in one continuous 360-degree orbit, everything holding its place, camera parallax the only movement. The LoRA was trained ' +
      `without sound; the graph still decodes H3's audio. ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_SIZE} ${H3_NOTES_FILES} With the Orbit LoRA (0.16 GB).`,
  },
  // ---- Pika H3 Flex (nm10-pika-flex): Pika's post-trained H3 in 6 steps, as Comfy-Org's video_pika_h3_flex_{t2v,fl2va,ref2va} templates.
  {
    id: 'minimax-h3-flex-t2v',
    title: 'MiniMax H3 Text to Video + Audio (Pika H3 Flex, 6 steps)',
    capability: 't2v',
    handBuilt: 'hand-built/minimax-h3-flex-t2v.json',
    bindings: {
      prompt: [b('131', 'prompt')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    license: H3_FLEX_LICENSE,
    notes:
      'Text to video with sound (FL2VA with no frames). The fl2va pruned int8 model with Pika\'s FL2VA adapter; core nodes only. ' +
      `${H3_FLEX_NOTES} ${H3_NOTES_SIZE} ${H3_NOTES_LAYOUT} ${H3_NOTES_FILES} With Pika\'s FL2VA adapter (1.96 GB).`,
  },
  {
    id: 'minimax-h3-flex-i2v',
    title: 'MiniMax H3 Image to Video + Audio (Pika H3 Flex, 6 steps)',
    capability: 'i2v',
    handBuilt: 'hand-built/minimax-h3-flex-i2v.json',
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    license: H3_FLEX_LICENSE,
    notes:
      'Image to video with sound: image = the first frame. The fl2va pruned int8 model with Pika\'s FL2VA adapter; core nodes only. ' +
      `${H3_FLEX_NOTES} ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_SIZE} ${H3_NOTES_LAYOUT} ${H3_NOTES_FILES} With Pika\'s FL2VA adapter (1.96 GB).`,
  },
  {
    id: 'minimax-h3-flex-flf2v',
    title: 'MiniMax H3 Start + End Frame to Video + Audio (Pika H3 Flex, 6 steps)',
    capability: 'flf2v',
    handBuilt: 'hand-built/minimax-h3-flex-flf2v.json',
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('138', 'image')], endImage: [b('140', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    license: H3_FLEX_LICENSE,
    notes:
      'Start and end frame to video with sound: image = the first frame, endImage = the last. The fl2va pruned int8 model with Pika\'s FL2VA adapter; core nodes only. ' +
      `${H3_FLEX_NOTES} ${H3_NOTES_FIRST_FRAME} ${H3_NOTES_SIZE} ${H3_NOTES_LAYOUT} ${H3_NOTES_FILES} With Pika\'s FL2VA adapter (1.96 GB).`,
  },
  {
    id: 'minimax-h3-flex-ref2va',
    title: 'MiniMax H3 References to Video + Audio (Pika H3 Flex Ref2VA: up to 9 images, 3 clips, 3 audio clips; 6 steps)',
    capability: 'ref2v',
    handBuilt: 'hand-built/minimax-h3-flex-ref2va.json',
    expand: 'references',
    bindings: {
      prompt: [b('131', 'prompt')], image: [b('150', 'image')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24 },
    limits: { maxFrames: 362, dimensionMultiple: 32, maxImages: 9, maxVideos: 3, maxAudios: 3, maxReferences: 12, maxReferenceGroupSec: 15 },
    // The clips' loader is added per run (expandH3References), so the graph itself doesn't hold it.
    runtimeNodes: ['VHS_LoadVideo'],
    vramGb: 32,
    license: H3_FLEX_LICENSE,
    notes:
      'References to video with sound: core MiniMaxH3ReferenceToVideo on the ref2va pruned int8 model with Pika\'s Ref2VA adapter. The graph holds Image 1 ' +
      '(LoadImage 150 → ref_images.ref_image_0); the provider adds the rest per run (expandH3References): up to 9 images (LoadImage → ' +
      'ref_images.ref_image_N), 3 clips (VHS_LoadVideo at 24 fps, up to 15 s → ref_videos.ref_video_N, and the clip\'s own sound → ref_video_audios.ref_video_audio_N) ' +
      'and 3 standalone audio clips (LoadAudio → ref_audios.ref_audio_N), 12 files in all, at least one image or clip; a request with no image takes node 150 out. ' +
      'Each clip or audio clip 2-15 s, each group at most 15 s combined; a clip\'s own sound is not counted as an audio file. The prompt cites them in order: ' +
      '<Picture 1>, <Video 1>, <Audio 1> (the studio writes Image 1, Clip 1, Voice 1 and the server turns them into these tags). ref_image_size stays match ' +
      `(the template's; max keeps a 2048 px short edge for stronger identity and is several times slower). ${H3_FLEX_NOTES} ${H3_NOTES_SIZE} ${H3_NOTES_FILES.replace('fl2va', 'ref2va')} ` +
      'With Pika\'s Ref2VA adapter (1.96 GB). VideoHelperSuite loads the clips (runtimeNodes, so the GPU pre-flight asks for it).',
  },
  // ---- MiniMax H3 on 8-31 GB cards (new-models-10 §6.4): Comfy-Org's "FastVideo FastH3" templates
  // (workflow_templates video_fastvideo_fasth3_t2v / _i2v, the "First Last Frame to Video (FastVideo FastH3)" subgraph) as
  // API graphs. src/lib/gpu/h3-tier.ts picks the tier and binds `unet` to the card's file (NVFP4 on Blackwell, else int8, or
  // Trim's fp8 on a PyTorch without CUDA 13). Trim has text to video only: FastVideo's Trim cards name eight-step text-to-video.
  ...[
    ['minimax-h3-fast-t2v', 't2v', 'Text to Video', false, false],
    ['minimax-h3-fast-i2v', 'i2v', 'Image to Video', true, false],
    ['minimax-h3-fast-flf2v', 'flf2v', 'Start + End Frame to Video', true, true],
  ].map(([id, capability, what, first, last]) => ({
    id,
    title: `MiniMax H3 ${what} + Audio on a 16 GB GPU (FastH3 V2, 8 steps)`,
    capability,
    handBuilt: `hand-built/${id}.json`,
    bindings: {
      prompt: [b('131', 'prompt')],
      ...(first && { image: [b('138', 'image')] }),
      ...(last && { endImage: [b('140', 'image')] }),
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')], unet: [b('127', 'unet_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 16,
    optionalModels: ['fastvideo_fasth3_8step_v2_pruned_nvfp4.safetensors'],
    license: H3_LICENSE_FASTH3,
    notes:
      `${what} with sound on FastVideo's FastH3 8-Step V2 (DMD2, step 1300; FastVideo/FastVideo-FastH3-Comfy @ ec1e3aa3), as Comfy-Org's FastH3 template: ` +
      'MiniMaxH3ImageToVideo' + (first ? (last ? ' with first_frame and last_frame' : ' with first_frame') : ' with no frames') + ', UNETLoader (unet: the pruned int8 ConvRot file, ' +
      '22.13 GB, or the NVFP4 file, 13.61 GB, for Blackwell) -> MiniMaxH3SigmaShift 10 / 3 -> ModelAttentionBackend "comfy kitchen attention" (INT8 attention, ' +
      'listed on NVIDIA and AMD GPUs only, so a CPU ComfyUI refuses the value) -> BlockSparseAttention vsa 10% from 20% of the steps, BasicScheduler simple 8 steps, ' +
      'KSamplerSelect res_multistep, CFG 1; core nodes only (ComfyUI 0.36 or later). FastVideo: fits 16 GB, not 12 GB, in its tests; the int8 file is partly ' +
      'offloaded under 24 GB. ' + (first ? 'FastVideo\'s card says FL2VA was not distilled; Comfy-Org\'s image-to-video template runs it, so a start frame is followed less closely than on minimax-h3-i2v. ' + H3_NOTES_FIRST_FRAME + ' ' : '') +
      `${H3_NOTES_CANVAS} ${H3_NOTES_LAYOUT} ${H3_NOTES_FASTH3_FILES}`,
  })),
  {
    id: 'minimax-h3-trim-t2v',
    title: 'MiniMax H3 Text to Video + Audio on an 8-12 GB GPU (FastH3 Trim, 8 steps, experimental)',
    capability: 't2v',
    handBuilt: 'hand-built/minimax-h3-trim-t2v.json',
    bindings: {
      prompt: [b('131', 'prompt')],
      width: [b('131', 'width')], height: [b('131', 'height')], frames: [b('131', 'length')],
      seed: [b('129', 'noise_seed')], steps: [b('124', 'steps')], unet: [b('127', 'unet_name')],
      filenamePrefix: [b('174', 'filename_prefix')],
    },
    outputs: [{ node: '174', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 8 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 12,
    optionalModels: ['fastvideo_fasth3_trim_8step_fp8.safetensors', 'fastvideo_fasth3_trim_8step_nvfp4.safetensors'],
    license: H3_LICENSE_FASTH3,
    notes:
      "Text to video with sound on FastVideo's FastH3 Trim (FastVideo/FastVideo-FastH3-Trim-Comfy @ f66c13dc, 2026-10-06): 42 of H3's 50 blocks with a shared " +
      'rank-16 timestep basis, 8-step DMD2 (checkpoint 300), experimental and below FastH3 V2 in quality. The FastH3 template\'s graph with unet = the Trim file: ' +
      'int8 ConvRot (18.92 GB, the default, any recent NVIDIA card), fp8 (19.68 GB, Ada and newer, for a PyTorch without CUDA 13) or NVFP4 (11.89 GB, Blackwell); ' +
      'MiniMaxH3SigmaShift 10 / 3, Comfy Kitchen attention, BlockSparseAttention vsa 10%, BasicScheduler simple 8 steps, res_multistep, CFG 1. vramGb 12 is the ' +
      'int8 / fp8 file partly offloaded; the 8 GB figure is FastVideo\'s test with the NVFP4 file and memory capped at 8 GB on an RTX 4090 (82 s for 5 s at 480p). ' +
      'FastVideo\'s timings (5 s with sound): RTX 5090 13.4 s at 480p, 35.4 s at 768p; RTX 4090 43.9 s / 132.8 s; none measured here. Text to video only: the Trim ' +
      `cards name eight-step text-to-video and no frame conditioning. ${H3_NOTES_CANVAS} ${H3_NOTES_LAYOUT} ${H3_NOTES_FASTH3_FILES}`,
  },
  {
    id: 'infinitetalk-native',
    title: 'InfiniteTalk Lip-sync (native, single speaker, ~6 s)',
    capability: 'lipsync',
    export: 'video_wan2_1_infinitetalk',
    transforms: [
      { op: 'removeOutputs', ids: ['162'] },
      { op: 'set', node: '188:129', input: 'mode', value: 'single_speaker' },
      { op: 'set', node: '324:311', input: 'mode', value: 'single_speaker' },
      { op: 'delete', node: '188:129', input: 'mode.audio_encoder_output_2' },
      { op: 'delete', node: '188:129', input: 'mode.mask_1' },
      { op: 'delete', node: '188:129', input: 'mode.mask_2' },
      { op: 'delete', node: '324:311', input: 'mode.audio_encoder_output_2' },
      { op: 'delete', node: '324:311', input: 'mode.mask_1' },
      { op: 'delete', node: '324:311', input: 'mode.mask_2' },
      { op: 'set', node: '140', input: 'audio', value: ['24', 0] },
      // single-speaker InfiniteTalk weights instead of the two-speaker "multi" patch
      { op: 'rename', map: { 'wan2.1_infiniteTalk_multi_fp16.safetensors': 'wan2.1_infiniteTalk_single_fp16.safetensors' } },
      { op: 'set', node: '188:14', input: 'text', value: 'A person is talking to the camera.' },
      { op: 'set', node: '324:312', input: 'text', value: 'A person is talking to the camera.' },
    ],
    bindings: {
      prompt: [b('188:14', 'text'), b('324:312', 'text')],
      image: [b('32', 'image')],
      audio: [b('24', 'audio')],
      width: [b('149', 'value')],
      height: [b('150', 'value')],
      seed: [b('188:193', 'noise_seed'), b('324:321', 'noise_seed')],
      steps: [b('188:192', 'steps'), b('324:320', 'steps')],
    },
    outputs: [{ node: '141', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxDurationSec: 6 },
    vramGb: 24,
    notes: 'Official native InfiniteTalk template converted from two-speaker to single-speaker (single-speaker InfiniteTalk patch, masks/2nd audio/first-pass preview output removed). Two 81-frame windows @25 fps => ~6 s; audio beyond that is not animated (trim audio to <= 6 s). For long clips use infinitetalk-wanwrapper.',
  },
  {
    id: 'infinitetalk-wanwrapper',
    title: 'InfiniteTalk Lip-sync (WanVideoWrapper, long audio)',
    capability: 'lipsync',
    // Hand-built since O11 from the graph the export below produced (kijai's example 03 at 088128b with these transforms
    // applied: MelBandRoFormer 301/302 removed and the audio fed to 194 directly, preview 293 dropped, save_output on,
    // sdpa attention, the prompt "A person is talking to the camera.", Windows sub-paths flattened), so it builds and
    // validates without a frontend export: 'custom_nodes/ComfyUI-WanVideoWrapper/example_workflows/wanvideo_2_1_14B_I2V_InfiniteTalk_example_03.json'.
    handBuilt: 'hand-built/infinitetalk-wanwrapper.json',
    bindings: {
      prompt: [b('241', 'positive_prompt')],
      negativePrompt: [b('241', 'negative_prompt')],
      image: [b('284', 'image')],
      audio: [b('125', 'audio')],
      width: [b('245', 'value')],
      height: [b('246', 'value')],
      frames: [b('270', 'value')],
      seed: [b('128', 'seed')],
      steps: [b('128', 'steps')],
      // Exposed for Fuobe Speak's InfiniteTalk recipe (Originals O11): the LoRA (FusioniX in place of lightx2v), the sampler's
      // text guidance, shift and solver, InfiniteTalk's motion frames and colour match, and the audio guidance.
      lora: [b('138', 'lora')],
      loraStrength: [b('138', 'strength')],
      cfg: [b('128', 'cfg')],
      shift: [b('128', 'shift')],
      scheduler: [b('128', 'scheduler')],
      motionFrame: [b('192', 'motion_frame')],
      colormatch: [b('192', 'colormatch')],
      audioCfg: [b('194', 'audio_cfg_scale')],
    },
    outputs: [{ node: '131', kind: 'video' }],
    // The graph's own solver and colour match (the fast lightx2v pass); fps = the wrapper's 25 (MultiTalkWav2VecEmbeds).
    defaults: { fps: 25, scheduler: 'dpm++_sde', colormatch: 'disabled' },
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxFrames: 1000 },
    vramGb: 16,
    optionalModels: ['Wan2.1_I2V_14B_FusionX_LoRA.safetensors'],
    license: 'Apache-2.0 (InfiniteTalk, Wan 2.1, lightx2v; FusioniX: Apache-2.0 card; the LoRAs it merges carry their own licences)',
    autoDownloads: ['DownloadAndLoadWav2VecModel downloads TencentGameMate/chinese-wav2vec2-base into models/transformers on first run'],
    notes:
      'kijai WanVideoWrapper example 03 (GGUF Q8 Wan2.1-I2V-480p + InfiniteTalk single, lightx2v LoRA, 6 steps). Generates in 81-frame windows until the audio ends; `frames` is a MAX frame cap @25 fps (default 500 = 20 s). Changes vs example: MelBandRoFormer vocal separation removed (use clean speech audio), attention sdpa instead of sageattn, save_output=true, model sub-folders flattened. A VHS_VideoCombine node saves the video. ' +
      'The defaults are the fast lightx2v pass (6 steps, cfg 1, shift 11, motion_frame 9, dpm++_sde). Fuobe Speak sends a slower, higher-quality recipe through the extra bindings: ' +
      'lora Wan2.1_I2V_14B_FusionX_LoRA.safetensors at 1 (the run\'s LoRA goes into WanVideoLoraSelect, which this wrapper graph loads itself), steps 25, cfg 5 (text guidance), audioCfg 5 (audio guidance; the wrapper runs the extra audio-free pass when cfg > 1), ' +
      'shift 10, scheduler unipc (InfiniteTalk\'s solver), motionFrame 15 and colormatch reinhard for InfiniteTalk\'s colour correction (a Lab mean / spread match to the portrait; the wrapper has no strength, so on = 1). About 25 / 6 × 3 passes the time of the fast pass.',
  },
  {
    id: 'upscale-video-seedvr2',
    title: 'Video Upscale / Restore (SeedVR2 3B int8)',
    capability: 'upscale-video',
    export: 'utility_seedvr2_3b_int8_upscale_video',
    transforms: [{ op: 'resolveSwitches' }],
    bindings: {
      video: [b('73', 'file')],
      scale: [b('66:57', 'resize_type.multiplier')],
      seed: [b('66:54', 'seed')],
    },
    outputs: [{ node: '76', kind: 'video' }],
    limits: { maxWidth: 3840, maxHeight: 3840, maxDurationSec: 20 },
    vramGb: 16,
    notes: 'Native SeedVR2 (one-step diffusion restoration, temporally consistent). scale = output multiplier (template 2). Keeps source fps + audio. Temporal latent chunking is off (template default); long or 1080p+ clips need more VRAM.',
  },
  {
    id: 'upscale-video-esrgan',
    title: 'Video Upscale (Real-ESRGAN 4x)',
    capability: 'upscale-video',
    export: 'utility-gan_upscaler',
    bindings: {
      video: [b('9', 'file')],
      upscaleModel: [b('1', 'model_name')],
    },
    outputs: [{ node: '12', kind: 'video' }],
    limits: { maxWidth: 3840, maxHeight: 3840 },
    vramGb: 4,
    notes: 'Fast GAN upscale frame by frame (no new detail). Output factor = model factor (x4). Keeps fps + audio.',
  },
  {
    id: 'interpolate-film',
    title: 'Frame Interpolation (FILM, native)',
    capability: 'interpolate',
    export: 'utility_video_frame_interpolation',
    transforms: [{ op: 'resolveSwitches' }],
    bindings: {
      video: [b('4', 'file')],
      multiplier: [b('16:9', 'value')],
    },
    outputs: [{ node: '7', kind: 'video' }],
    limits: { maxMultiplier: 16 },
    vramGb: 4,
    notes: 'Native FrameInterpolate node. Output fps = source fps x multiplier (same duration, smoother motion). Audio passthrough.',
  },
  {
    id: 'interpolate-rife',
    title: 'Frame Interpolation (RIFE 4.26, native)',
    capability: 'interpolate',
    export: 'utility_video_frame_interpolation',
    transforms: [
      { op: 'resolveSwitches' },
      { op: 'set', node: '16:1', input: 'model_name', value: 'rife_v4.26.safetensors' },
    ],
    bindings: {
      video: [b('4', 'file')],
      multiplier: [b('16:9', 'value')],
    },
    outputs: [{ node: '7', kind: 'video' }],
    limits: { maxMultiplier: 16 },
    vramGb: 2,
    notes: 'Same official template with the RIFE v4.26 checkpoint (template lists rife_v4.25/4.26 variants in Comfy-Org/frame_interpolation). Faster than FILM.',
  },
  {
    id: 'interpolate-rife-vfi',
    title: 'Frame Interpolation (RIFE VFI custom pack)',
    capability: 'interpolate',
    handBuilt: 'hand-built/interpolate-rife-vfi.json',
    bindings: {
      video: [b('1', 'video')],
      multiplier: [b('2', 'value')],
    },
    outputs: [{ node: '6', kind: 'video' }],
    limits: { maxMultiplier: 8 },
    vramGb: 2,
    autoDownloads: ['RIFE VFI downloads rife49.pth into custom_nodes/ComfyUI-Frame-Interpolation/ckpts/rife on first run'],
    notes: 'Fannovel16/ComfyUI-Frame-Interpolation + VideoHelperSuite alternative to interpolate-rife. Output fps = source fps x multiplier (VHS_VideoInfo + ComfyMathExpression). Output is VHS_VideoCombine (history .gifs[]).',
  },

  // =========================================================================
  // AUDIO
  // =========================================================================
  {
    id: 'music-ace-step-15',
    title: 'ACE-Step 1.5 Music (tags + lyrics)',
    capability: 'music',
    export: 'audio_ace_step_1_5_checkpoint',
    transforms: [
      { op: 'set', node: '106', input: 'format', value: 'mp3' },
      { op: 'set', node: '106', input: 'format.quality', value: 'V0' },
      { op: 'set', node: '94', input: 'bpm', value: 120 },
      { op: 'set', node: '94', input: 'duration', value: 60 },
      { op: 'set', node: '98', input: 'seconds', value: 60 },
      // A song with no words is an instrumental (the template's sample lyrics are never sung).
      { op: 'set', node: '94', input: 'lyrics', value: '[Instrumental]' },
    ],
    bindings: {
      tags: [b('94', 'tags')],
      lyrics: [b('94', 'lyrics')],
      duration: [b('94', 'duration'), b('98', 'seconds')],
      bpm: [b('94', 'bpm')],
      seed: [b('3', 'seed'), b('94', 'seed')],
      steps: [b('3', 'steps')],
    },
    outputs: [{ node: '106', kind: 'audio' }],
    limits: { maxDurationSec: 240 },
    vramGb: 8,
    notes: 'Turbo AIO checkpoint (8 steps). tags = style description, lyrics with [Verse]/[Chorus] markers; "[Instrumental]" when there are no words (in place of the template sample lyrics). Output MP3 V0 (changed from FLAC). Defaults changed to 60 s / 120 bpm. Language/keyscale/timesignature stay at template values (en, E minor, 4).',
  },
  // (new-models-10 §6.6) full songs on core nodes. MiniMax Music 3 from the template audio_minimax_music_3
  // (Comfy-Org's int8 DiT in place of its fp16 one, as the template's own note offers for low VRAM; its Tiled decode switch
  // kept, turned on by the provider for songs over 2 minutes); YuE2 from audio_yue2_text2music (ABC planning on, "full") and
  // audio_yue2_music_cover (SheetSage2 reads the song's melody, "melody" mode). The templates' PreviewAny pass-throughs are left out.
  {
    id: 'music-minimax-3',
    title: 'MiniMax Music 3: full songs with vocals up to 5 minutes (caption + lyrics)',
    capability: 'music',
    handBuilt: 'hand-built/music-minimax-3.json',
    bindings: {
      tags: [b('4', 'caption')],
      lyrics: [b('4', 'lyrics')],
      duration: [b('4', 'max_duration')],
      seed: [b('4', 'seed'), b('7', 'seed')],
      steps: [b('7', 'steps')],
      tiledDecode: [b('10', 'switch')],
    },
    outputs: [{ node: '11', kind: 'audio' }],
    defaults: { duration: 120, tiledDecode: false },
    limits: { maxDurationSec: 300 },
    vramGb: 24,
    license: 'MiniMax-Music3 Community License (MiniMaxAI/MiniMax-Music3 @ 1b525ccb: MIT-style grant with the notice kept and an Acceptable Use Policy; a commercial product must show "MiniMax-Music3" in its interface; MiniMax\'s written authorisation above US$20M yearly revenue); the Comfy-Org repack @ 9e364ccd is tagged Apache-2.0',
    notes:
      'From the core template audio_minimax_music_3 from comfyui-workflow-templates 0.11.86 (comfyui_workflow_templates_json 0.1.112), hand-transcribed: int8 DiT, MP3 V0. tags = the caption (style, mood, vocals, arrangement; the template suggests Global Metadata, Vocal Details and Arrangement), lyrics with section tags on lines of their own ' +
      '([Intro] [Verse] [Pre-Chorus] [Chorus] [Post-Chorus] [Bridge] [Instrumental] [Solo] [Outro]); "[Instrumental]" when there are no words. duration = max_duration, an upper bound ' +
      '(the model can end the song earlier; 9,000 acoustic frames at 25 fps = 5 min). KSampler 30 steps, cfg 1.7, euler / simple and the encoder\'s cfg_scale 1.7 / top_k 50, as the template. ' +
      '32 kHz stereo. The template\'s Tiled decode switch (VAEDecodeAudioTiled 1536 / 64): less VRAM for long songs, a small risk of seams; tiledDecode true for songs over 120 s. ' +
      'VRAM 24 GB, the card\'s figure: under 24 GB at full precision and about 22 GB with CPU offload; its 8 GB figure streams the language model layer by layer (diffusers group offload), ' +
      'which the core node does not do (ComfyUI\'s own partial loading may still fit smaller cards). Files: DiT int8 2.5 GB (fp16 4.91, fp32 9.83), pruned int8 encoder 9.2 GB ' +
      '(pruned bf16 16.71, full bf16 18.47), DAV VAE 0.22 GB.',
  },
  {
    id: 'music-yue2-song',
    title: 'YuE2 3B: lyrics to song (style + lyrics, ABC planning)',
    capability: 'music',
    handBuilt: 'hand-built/music-yue2-song.json',
    bindings: {
      tags: [b('2', 'style'), b('3', 'style')],
      lyrics: [b('2', 'lyrics'), b('3', 'lyrics')],
      duration: [b('3', 'max_duration')],
      seed: [b('2', 'seed'), b('3', 'seed'), b('6', 'seed')],
      steps: [b('6', 'steps')],
    },
    outputs: [{ node: '8', kind: 'audio' }],
    defaults: { duration: 120 },
    limits: { maxDurationSec: 300 },
    vramGb: 12,
    license: 'CC-BY-NC-4.0 (m-a-p/YuE2-3B @ 8f24312f weights; the Comfy-Org/YuE2 repack @ 2f76ca75 is tagged the same)',
    notes:
      'From the core template audio_yue2_text2music from comfyui-workflow-templates 0.11.86 (comfyui_workflow_templates_json 0.1.112), hand-transcribed: MP3 V0. tags = the style (language, genre, vocal, tempo, instruments), lyrics with section tags ([Verse] [Chorus] [Bridge] [Outro]); only the words to be sung. YuE2 Generate ABC plans ' +
      'melody and chords ("full") before the song; YuE2 Generate Music makes the tokens and the seconds the empty latent takes. duration = max_duration, an upper bound reduced for long prompts. ' +
      'KSampler 32 steps, cfg 1, dpm_2 / sgm_uniform, as the template. Checkpoint int8 3.96 GB (bf16 7.8 GB). VRAM is not published: 12 GB is Fuobe\'s estimate for the int8 checkpoint.',
  },
  {
    id: 'music-yue2-cover',
    title: 'YuE2 3B: a cover of a song (its melody, new style and lyrics)',
    capability: 'music',
    handBuilt: 'hand-built/music-yue2-cover.json',
    bindings: {
      audio: [b('9', 'audio')],
      tags: [b('3', 'style')],
      lyrics: [b('3', 'lyrics')],
      duration: [b('3', 'max_duration')],
      seed: [b('3', 'seed'), b('6', 'seed')],
      steps: [b('6', 'steps')],
    },
    outputs: [{ node: '8', kind: 'audio' }],
    defaults: { duration: 300 },
    limits: { maxDurationSec: 300 },
    vramGb: 12,
    license: 'CC-BY-NC-4.0 (m-a-p/YuE2-3B @ 8f24312f and m-a-p/SheetSage2 @ b83c3d79 weights; the Comfy-Org/YuE2 repack @ 2f76ca75 is tagged the same)',
    notes:
      'From the core template audio_yue2_music_cover from comfyui-workflow-templates 0.11.86 (comfyui_workflow_templates_json 0.1.112), hand-transcribed: MP3 V0. audio = the song to cover (LoadAudio). SheetSage2 transcribes its melody to ABC ("melody" mode, the template\'s), which YuE2 sings with the new style and lyrics: lyrics close to the ' +
      'original\'s phrasing and syllable count fit the melody best. The source audio is not YuE2\'s conditioning, only its melody. SheetSage2 bf16 1.39 GB. VRAM is not published: 12 GB is Fuobe\'s estimate for the int8 checkpoint and SheetSage2.',
  },
  {
    id: 'v2a-mmaudio',
    title: 'Video to Audio / Foley (MMAudio)',
    capability: 'v2a',
    export: 'custom_nodes/ComfyUI-MMAudio/example_workflows/mmaudio_test.json',
    transforms: [
      { op: 'removeOutputs', ids: ['98'] },
      { op: 'addNodes', nodes: { 1701: { class_type: 'SaveAudio', inputs: { audio: ['92', 0], filename_prefix: 'ComfyUI' }, _meta: { title: 'Save Audio (FLAC)' } } } },
      { op: 'set', node: '97', input: 'save_output', value: true },
    ],
    bindings: {
      video: [b('91', 'video')],
      prompt: [b('92', 'prompt')],
      negativePrompt: [b('92', 'negative_prompt')],
      seed: [b('92', 'seed')],
      steps: [b('92', 'steps')],
      cfg: [b('92', 'cfg')],
    },
    outputs: [
      { node: '97', kind: 'video' },
      { node: '1701', kind: 'audio' },
    ],
    limits: { maxDurationSec: 30 },
    vramGb: 8,
    notes: 'kijai ComfyUI-MMAudio example. Audio duration = loaded video duration (VHS_VideoInfo). Two outputs: the input video muxed with generated audio (VHS_VideoCombine -> history .gifs[]) and the FLAC track (SaveAudio -> history .audio[]). MMAudio is trained on 8 s clips; quality drops on long inputs.',
  },
  // =========================================================================
  // comfyui-oss-2 additions (docs/research/comfyui-oss-2.md, 2026-10-16)
  // Hand-built from the research graphs (scripts/comfy/hand-built/*.json).
  // =========================================================================
  // ---- speech / voice -----------------------------------------------------
  {
    id: 'tts-chatterbox-multilingual',
    title: 'Chatterbox Multilingual TTS (voice clone, 23 languages)',
    capability: 'tts',
    handBuilt: 'hand-built/tts-chatterbox-multilingual.json',
    bindings: {
      prompt: [b('2', 'text')],
      audio: [b('1', 'audio')],
      language: [b('2', 'language')],
      seed: [b('10', 'value')],
      exaggeration: [b('2', 'exaggeration')],
      cfg: [b('2', 'cfg_weight')],
      temperature: [b('2', 'temperature')],
    },
    outputs: [{ node: '3', kind: 'audio' }],
    defaults: { language: 'English (en)' },
    limits: { maxDurationSec: 300 },
    vramGb: 6,
    license: 'Chatterbox weights MIT (ResembleAI); pack repo has no LICENSE file',
    autoDownloads: [
      'FL_ChatterboxMultilingualTTS downloads ResembleAI/chatterbox (t3_mtl23ls_v2.safetensors 2.14 GB, s3gen.pt 1.06 GB, ve.pt, conds.pt, grapheme_mtl_merged_expanded_v1.json, Cangjie5_TC.json) into models/chatterbox/chatterbox_multilingual on first run',
    ],
    notes:
      'Template audio-chatterbox_tts_multilingual. prompt = text to speak; audio = 5-15 s clean reference of the voice to clone (required in this graph). ' +
      'language is a combo of "Name (code)" strings: Arabic (ar), Danish (da), German (de), Greek (el), English (en), Spanish (es), Finnish (fi), French (fr), Hebrew (he), Hindi (hi), Italian (it), Japanese (ja), Korean (ko), Malay (ms), Dutch (nl), Norwegian (no), Polish (pl), Portuguese (pt), Russian (ru), Swedish (sv), Swahili (sw), Turkish (tr), Chinese (zh). ' +
      'cfg = cfg_weight (0-1, default 0.5; lower = slower, more deliberate pacing), exaggeration 0-2 (0.5 neutral), temperature 0.05-2 (0.8). Long text is chunked by the node. seed is folded to 32 bits in the graph (node 11, the FL nodes cap seed at 2^32-1). Output MP3 V0. ' +
      'Install resemble-perth so outputs carry the Perth watermark (the pack treats it as optional). Get consent for cloned voices.',
  },
  {
    id: 'tts-indextts2',
    title: 'IndexTTS-2 TTS (voice clone, expressive)',
    capability: 'tts',
    handBuilt: 'hand-built/tts-indextts2.json',
    bindings: {
      prompt: [b('2', 'text')],
      audio: [b('1', 'audio')],
    },
    outputs: [{ node: '3', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 8,
    license: 'bilibili IndexTTS-2 Model Use License: commercial use allowed below 100M MAU / RMB 1B annual revenue; may not be used to improve other AI models. Pack code: no LICENSE file',
    autoDownloads: [
      'IndexTeam/IndexTTS-2 must be in custom_nodes/ComfyUI-IndexTTS2/checkpoints (gpt.pth 3.48 GB, s2mel.pth 1.2 GB, qwen0.6bemo4-merge 1.19 GB, config.yaml, bpe.model, ...); w2v-bert-2.0, MaskGCT semantic codec, CAMPPlus and BigVGAN are fetched from Hugging Face on first run',
    ],
    notes:
      'IndexTTS2Simple(audio = speaker reference, text, emotion_control_weight 1.0, use_fp16 true). No seed input. Best for emotion/timing control (dubbing). ' +
      'Validated with the pack registered (it imports only numpy at load time); its runtime stack (pynini, WeTextProcessing, modelscope, descript-audiotools, ...) is NOT installed by default - ' +
      'run install-comfyui.sh with INDEXTTS_RUNTIME=1, ideally in a separate worker. Emotion from a second clip or a vector (IndexTTS2EmotionVector / IndexTTS2EmotionFromText) is not wired.',
  },
  {
    id: 'tts-qwen3-design',
    title: 'Qwen3-TTS 1.7B voice design (a new voice from a description)',
    capability: 'voice-design',
    handBuilt: 'hand-built/tts-qwen3-design.json',
    packs: ['ComfyUI-QwenTTS'],
    bindings: {
      prompt: [b('1', 'text')],
      voiceDescription: [b('1', 'instruct')],
      seed: [b('1', 'seed')],
    },
    outputs: [{ node: '2', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 8,
    license: 'Qwen3-TTS weights Apache-2.0 (Qwen); ComfyUI-QwenTTS code GPL-3.0',
    autoDownloads: [
      'ComfyUI-QwenTTS downloads Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign (whole repository at its current revision; 5ecdb67327fd37bb2e042aab12ff7391903235d3 when this was written: model.safetensors 3.83 GB + speech_tokenizer 0.68 GB) into models/tts/Qwen3-TTS/Qwen3-TTS-12Hz-1.7B-VoiceDesign on first run (models/TTS/Qwen3-TTS when no tts folder is registered: ComfyUI-VoxCPM2 registers models/tts)',
    ],
    notes:
      'AILab_Qwen3TTSVoiceDesign_Advanced(text = the line, instruct = the voice in words, model_size 1.7B, language Auto, do_sample true so each seed is a different take: ' +
      'top_p 1.0, top_k 50, temperature 0.9, repetition_penalty 1.05 as fal sends; max_new_tokens 4096 = about 5 minutes at 12 Hz; unload_models false keeps it loaded for the next take). ' +
      'The Basic node samples greedily (do_sample false): every take would be the same. 10 languages (Auto, Chinese, English, Japanese, Korean, French, German, Spanish, Portuguese, Russian, Italian). ' +
      'Install the pack with its requirements.txt (transformers >= 4.57, torch >= 2.9.1). A designed voice is reused by cloning the chosen take (tts-qwen3-clone with the take and its line as reference_text). Output MP3 V0.',
  },
  {
    id: 'tts-qwen3-clone',
    title: 'Qwen3-TTS 1.7B voice clone (a short sample, optionally its transcript)',
    capability: 'tts',
    handBuilt: 'hand-built/tts-qwen3-clone.json',
    packs: ['ComfyUI-QwenTTS'],
    bindings: {
      prompt: [b('2', 'target_text')],
      audio: [b('1', 'audio')],
      voiceTranscript: [b('2', 'reference_text')],
      seed: [b('2', 'seed')],
    },
    outputs: [{ node: '3', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 8,
    license: 'Qwen3-TTS weights Apache-2.0 (Qwen); ComfyUI-QwenTTS code GPL-3.0',
    autoDownloads: [
      'ComfyUI-QwenTTS downloads Qwen/Qwen3-TTS-12Hz-1.7B-Base (whole repository at its current revision; fd4b254389122332181a7c3db7f27e918eec64e3 when this was written: model.safetensors 3.86 GB + speech_tokenizer 0.68 GB) into models/tts/Qwen3-TTS/Qwen3-TTS-12Hz-1.7B-Base on first run (models/TTS/Qwen3-TTS when no tts folder is registered: ComfyUI-VoxCPM2 registers models/tts)',
    ],
    notes:
      'AILab_Qwen3TTSVoiceClone_Advanced(target_text = the line, reference_audio = the voice sample, reference_text = what the sample says (a closer clone), ' +
      'x_vector_only false with a transcript; the pack refuses an empty reference_text otherwise, so without one the provider turns x_vector_only on (a timbre-only clone), model_size 1.7B, do_sample true, the same sampling as the design graph). A saved voice from Design a voice passes its take and the take\'s line. Output MP3 V0. Get consent for cloned voices.',
  },
  {
    id: 'tts-voxcpm2',
    title: 'VoxCPM2 TTS with voice design (48 kHz, 30 languages)',
    capability: 'voice-design',
    handBuilt: 'hand-built/tts-voxcpm2.json',
    packs: ['ComfyUI-VoxCPM2'],
    bindings: {
      prompt: [b('1', 'text')],
      voiceDescription: [b('1', 'voice_description')],
      seed: [b('1', 'seed')],
      device: [b('1', 'device')],
    },
    outputs: [{ node: '2', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 8,
    license: 'VoxCPM2 weights Apache-2.0 (OpenBMB); ComfyUI-VoxCPM2 code Apache-2.0',
    autoDownloads: [
      'ComfyUI-VoxCPM2 downloads openbmb/VoxCPM2 (whole repository; 32279effe8c19989596f05d353d1447f51d9e915 when this was written: model.safetensors 4.58 GB, audiovae.pth 0.38 GB) into models/tts/VoxCPM/VoxCPM2 on first run',
    ],
    notes:
      'VoxCPM2_TTS(voice_description = the voice in words, wrapped in parentheses before the text by the node; text = the line; model VoxCPM2, lora None, cfg 2.0, 10 timesteps, max_tokens 4096, normalize_text true, dtype auto, device cuda). ' +
      'device is a combo of what the GPU has (cuda, mps, cpu): bound to the server\'s first torch device (/system_stats), cuda when it can\'t say. 48 kHz output, 30 languages. ' +
      'The pack also trains LoRAs (VoxCPM_LoraTrainer) and loads them (lora_name): not wired yet. Install the pack with its requirements.txt (voxcpm, funasr, modelscope).',
  },
  {
    id: 'tts-voxcpm2-clone',
    title: 'VoxCPM2 voice clone (controllable from a clip, ultimate with its transcript; 48 kHz)',
    capability: 'tts',
    handBuilt: 'hand-built/tts-voxcpm2-clone.json',
    packs: ['ComfyUI-VoxCPM2'],
    bindings: {
      prompt: [b('2', 'text')],
      audio: [b('1', 'audio')],
      voiceTranscript: [b('2', 'prompt_text')],
      seed: [b('2', 'seed')],
      device: [b('2', 'device')],
    },
    outputs: [{ node: '3', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 8,
    license: 'VoxCPM2 weights Apache-2.0 (OpenBMB); ComfyUI-VoxCPM2 code Apache-2.0',
    autoDownloads: [
      'ComfyUI-VoxCPM2 downloads openbmb/VoxCPM2 (whole repository; 32279effe8c19989596f05d353d1447f51d9e915 when this was written: model.safetensors 4.58 GB, audiovae.pth 0.38 GB) into models/tts/VoxCPM/VoxCPM2 on first run',
    ],
    notes:
      'VoxCPM2_Clone(reference_audio = the voice sample, at most 50 s; prompt_text = what it says: given, the closest ("ultimate") clone, empty, the "controllable" clone; text = the line; ' +
      'the same model settings as tts-voxcpm2, denoiser and ASR off, 3 retries on a babbling or silent take). A saved voice from Design a voice passes its take and the take\'s line, so it is cloned the ultimate way. Output MP3 V0. Get consent for cloned voices.',
  },
  // nm10-speech-edit: Tencent AuK (MIT) edits what was said in a recording (Audio → Edit speech) and speaks a line in a
  // voice. Open engine only (AuK is hosted on neither fal nor Replicate).
  {
    id: 'speech-edit-auk',
    title: 'Edit what was said with Tencent AuK (words, pitch, pace, emotion, noise; windows crossfaded back)',
    capability: 'speech-edit',
    handBuilt: 'hand-built/speech-edit-auk.json',
    packs: ['ComfyUI-AuK'],
    bindings: {
      audio: [b('1', 'audio')],
      fadeCurve: [b('2', 'audio')],
      seed: [b('11', 'seed')],
      device: [b('4', 'device')],
    },
    outputs: [{ node: '50', kind: 'audio' }],
    expand: 'speech',
    defaults: { crossfade: 0.12 },
    limits: { maxDurationSec: 1200 },
    vramGb: 24,
    license: 'AuK code and weights MIT (Tencent); its Qwen2.5-Omni-3B encoder Qwen Research License (NON-COMMERCIAL)',
    autoDownloads: [
      'install-comfyui.sh with AUK=1 AUK_WEIGHTS=1 downloads into the AuK checkout\'s ckpts/ (relative paths resolve there, not in a ComfyUI models folder): tencent/AuK-Flash at 575b92f0895f75180bf2cbd35f2e176c5732b8ed (auk_flash.safetensors 6.12 GB, vae.safetensors 0.64 GB, config.yaml) and Qwen/Qwen2.5-Omni-3B at f75b40e3da2003cdd6e1829b1f420ca70797c34e (3 safetensors shards, 11.97 GB, plus config and tokenizer files); AUK_BASE=1 adds tencent/AuK at 790742b71a4430120daf2b2099192abae449eb9f (auk_base.safetensors 6.12 GB) for the Best setting',
    ],
    notes:
      'The recording (a video upload works: LoadAudio reads its soundtrack) and the edit windows Fuobe plans (params.extra.speechWindows: start, end, instruction, seconds). ' +
      'The graph is rebuilt for every window in one prompt: each window is cut with TrimAudioDuration, edited by AuKGenerateEdit (one shared AuKModelLoader) and ' +
      'crossfaded back over its first and last 0.12 s as a + (b − a) × fade-in, with the linear fade-in Fuobe writes (fadeCurve: the ramp, then a flat tail AudioMerge trims off). The recording and each edit are first brought to one rate (merged with silence at the other\'s: AuK speaks at 24 kHz), so no seam piece is resampled at its edges (a resampled piece tapers there: a click). Windows hold at least 1 s of untouched speech each side and are cut at silences. ' +
      'AuK takes a window plus its new audio up to 30 s per call (its node refuses more and does not split), so a window is at most about 14.7 s for a same-length effect. ' +
      'AuK-Flash by default (checkpoint ckpts/AuK-Flash/auk_flash.safetensors, 4 steps, CFG 0, sway -1); params.extra.quality "best" loads ckpts/AuK/auk_base.safetensors at 32 steps, CFG 2. ' +
      'The Prompt Enhancer is off: Fuobe writes the Cookbook instruction (Replace \'X\' with \'Y\'. / Add … after … / Remove …; pitch, speed, volume, emotion, whisper, enhancement and speaker extraction) and sets generation_seconds itself. ' +
      'device is bound to the server\'s first torch device (cuda:0, or cpu with fp32). AuK outputs mono, so edited windows are duplicated into a stereo recording. Peak VRAM ~25 GiB (AuK\'s README, A800, bf16), ~17 GiB with cpu_offload. ' +
      'Languages: English and Chinese (the technical report, arXiv 2609.08936: a bilingual corpus). Saves FLAC.',
  },
  {
    id: 'speech-tts-auk',
    title: 'Tencent AuK text to speech (clone a voice sample, or a voice from its description)',
    capability: 'tts',
    handBuilt: 'hand-built/speech-tts-auk.json',
    packs: ['ComfyUI-AuK'],
    bindings: {
      audio: [b('1', 'audio')],
      prompt: [b('3', 'instruction')],
      seed: [b('3', 'seed')],
      device: [b('2', 'device')],
    },
    outputs: [{ node: '4', kind: 'audio' }],
    limits: { maxDurationSec: 30 },
    vramGb: 24,
    license: 'AuK code and weights MIT (Tencent); its Qwen2.5-Omni-3B encoder Qwen Research License (NON-COMMERCIAL)',
    autoDownloads: [
      'install-comfyui.sh with AUK=1 AUK_WEIGHTS=1 downloads into the AuK checkout\'s ckpts/ (relative paths resolve there, not in a ComfyUI models folder): tencent/AuK-Flash at 575b92f0895f75180bf2cbd35f2e176c5732b8ed (auk_flash.safetensors 6.12 GB, vae.safetensors 0.64 GB, config.yaml) and Qwen/Qwen2.5-Omni-3B at f75b40e3da2003cdd6e1829b1f420ca70797c34e (3 safetensors shards, 11.97 GB, plus config and tokenizer files); AUK_BASE=1 adds tencent/AuK at 790742b71a4430120daf2b2099192abae449eb9f (auk_base.safetensors 6.12 GB) for the Best setting',
    ],
    notes:
      'Zero-shot TTS: the voice sample (audio) and the line as AuK\'s instruction (Say the following with the same voice: "…"), written by Fuobe; without a sample the loader is removed and AuK is asked for ' +
      'instruct TTS (Generate speech based on the following description: "…". The content to speak is: "…".) with params.voiceDescription. generation_seconds is the line\'s length at a speaking rate (the Prompt Enhancer that would estimate it is off). ' +
      'The sample plus the line fit in 30 s. AuK-Flash, 4 steps, CFG 0. Get consent for cloned voices. Saves FLAC.',
  },
  {
    id: 'tts-dialogue-chatterbox',
    title: 'Chatterbox Dialogue (2 speakers, voice clone)',
    capability: 'dialogue',
    handBuilt: 'hand-built/tts-dialogue-chatterbox.json',
    bindings: {
      prompt: [b('3', 'dialog_text')],
      audio: [b('1', 'audio')],
      audio2: [b('2', 'audio')],
      seed: [b('10', 'value')],
      exaggeration: [b('3', 'exaggeration')],
      cfg: [b('3', 'cfg_weight')],
      temperature: [b('3', 'temperature')],
    },
    outputs: [{ node: '4', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 6,
    license: 'Chatterbox weights MIT (ResembleAI); pack repo has no LICENSE file',
    autoDownloads: [
      'FL_ChatterboxDialogTTS downloads ResembleAI/chatterbox English model (t3_cfg.safetensors 2.13 GB, s3gen.safetensors 1.06 GB, ve.safetensors, tokenizer.json, conds.pt) into models/chatterbox/chatterbox on first run',
    ],
    notes:
      'Template audio-chatterbox_tts_dialog. prompt = script, one line per turn starting with "SPEAKER A:" or "SPEAKER B:" (parsed with startswith). audio = speaker A reference, audio2 = speaker B reference. ' +
      'English model only. The node also outputs per-speaker stems (outputs 1-4, not saved here) that suit multi-person lipsync; speakers C/D need optional inputs speaker_C_Audio/speaker_D_Audio (not wired). ' +
      'cfg = cfg_weight (0.2-1), exaggeration 0.25-2, temperature 0.05-5. seed is folded to 32 bits in the graph (node 11). Output MP3 V0 of the mixed dialogue.',
  },
  {
    id: 'voice-change-chatterbox',
    title: 'Chatterbox Voice Changer (speech to speech)',
    capability: 'voice-change',
    handBuilt: 'hand-built/voice-change-chatterbox.json',
    bindings: {
      audio: [b('1', 'audio')],
      audio2: [b('2', 'audio')],
      seed: [b('10', 'value')],
    },
    outputs: [{ node: '4', kind: 'audio' }],
    limits: { maxDurationSec: 300 },
    vramGb: 3,
    license: 'Chatterbox weights MIT (ResembleAI); pack repo has no LICENSE file',
    autoDownloads: ['FL_ChatterboxVC downloads ResembleAI/chatterbox s3gen.pt (1.06 GB) + conds.pt into models/chatterbox/chatterbox_vc on first run'],
    notes:
      'Template audio-chatterbox_vc. audio = performance to convert (timing and prosody are kept), audio2 = 5-15 s of the target voice. Zero-shot, no training. seed is folded to 32 bits in the graph (node 11). ' +
      'To re-voice a video: extract its audio client-side (or GetVideoComponents.audio -> FL_ChatterboxVC -> CreateVideo(audio=...)) and remux.',
  },

  // ---- video: extend / reframe / relight / draw-to-video ------------------
  {
    id: 'video-extend-wan22-fun-vace',
    title: 'Wan 2.2 Fun VACE Video Extend (lightx2v 4-step)',
    capability: 'extend',
    handBuilt: 'hand-built/video-extend-wan22-fun-vace.json',
    bindings: {
      video: [b('1', 'file')],
      prompt: [b('12', 'text')],
      negativePrompt: [b('13', 'text')],
      width: [b('3', 'width'), b('5', 'width'), b('7', 'width'), b('8', 'width'), b('15', 'width')],
      height: [b('3', 'height'), b('5', 'height'), b('7', 'height'), b('8', 'height'), b('15', 'height')],
      frames: [b('30', 'value')],
      contextFrames: [b('31', 'value')],
      fps: [b('27', 'fps')],
      seed: [b('22', 'noise_seed'), b('23', 'noise_seed')],
      steps: [b('22', 'steps'), b('23', 'steps')],
      cfg: [b('22', 'cfg'), b('23', 'cfg')],
      shift: [b('20', 'shift'), b('21', 'shift')],
    },
    outputs: [{ node: '28', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 105, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.2 Fun VACE, Wan 2.2 lightx2v LoRAs)',
    notes:
      'Continues a clip. frames = NEW frames to generate (4n+1, from duration*fps); contextFrames = how many of the source\'s last frames are fed back as known context (multiple of 4, default 16). ' +
      'The graph computes window = frames + contextFrames (ComfyMathExpression, must stay <= 121) and the negative tail index itself. WanVaceToVideo control: last contextFrames frames (mask 0 = keep) + gray frames (mask 1 = generate). ' +
      'Output = whole source clip resized/center-cropped to width x height + the new frames, overlap linear-blended (KJNodes ImageBatchExtendWithOverlap), at fps (16 = Wan native; resample the source to 16 fps first). ' +
      'Run repeatedly on the result to extend further. Source audio is dropped. 4 steps split 2/2 high/low (split not bound), cfg 1, shift 5. ' +
      'The lightx2v LoRAs are the T2V ones, as Fun VACE is built on the A14B T2V base.',
  },
  {
    id: 'video-reframe-wan22-fun-vace',
    title: 'Wan 2.2 Fun VACE Video Reframe / Outpaint',
    capability: 'reframe',
    handBuilt: 'hand-built/video-reframe-wan22-fun-vace.json',
    bindings: {
      video: [b('1', 'file')],
      prompt: [b('9', 'text')],
      negativePrompt: [b('10', 'text')],
      width: [b('3', 'width'), b('12', 'width')],
      height: [b('3', 'height'), b('12', 'height')],
      frames: [b('12', 'length')],
      fps: [b('23', 'fps')],
      seed: [b('19', 'noise_seed'), b('20', 'noise_seed')],
      steps: [b('19', 'steps'), b('20', 'steps')],
      cfg: [b('19', 'cfg'), b('20', 'cfg')],
      shift: [b('17', 'shift'), b('18', 'shift')],
    },
    outputs: [{ node: '24', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.2 Fun VACE, Wan 2.2 lightx2v LoRAs)',
    notes:
      'Changes the aspect ratio of a clip and fills the new area. width/height = TARGET size (from aspectRatio); KJNodes ImageResizeKJv2 (keep_proportion=pad, center, divisible_by 16) fits the source inside it, ' +
      'pads with 0.5 gray and outputs mask 1 on the padding, 0 on the source (per frame) -> WanVaceToVideo control_video/control_masks (pattern of template video_wan_vace_outpainting, re-targeted to Wan 2.2 Fun VACE). ' +
      'frames must be <= the source frame count (4n+1): WanVaceToVideo trims the control video to frames, and pads a shorter one with gray + mask 1 (= invents frames). ' +
      'Only call it when the aspect ratio actually changes (no padding -> ImageResizeKJv2 returns a 64x64 placeholder mask and the whole clip would be regenerated). ' +
      'Clips longer than ~5-7 s: run windows and reuse the previous window\'s last frames (see video-extend). Source audio is dropped. 4 steps split 2/2, cfg 1, shift 5.',
  },
  {
    id: 'relight-qwen-edit-2509',
    title: 'Qwen-Image-Edit 2509 Relight (prompted lighting)',
    capability: 'edit',
    handBuilt: 'hand-built/relight-qwen-edit-2509.json',
    bindings: {
      prompt: [b('1002', 'string_b')],
      negativePrompt: [b('433:110', 'prompt')],
      image: [b('78', 'image')],
      seed: [b('433:3', 'seed')],
      steps: [b('433:436', 'value')],
      cfg: [b('433:437', 'value')],
      loraStrength: [b('1001', 'strength_model')],
    },
    outputs: [{ node: '469', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Edit-2509, Relight LoRA, Lightning LoRA)',
    notes:
      'Official template image_qwen_image_edit_2509_relight = library qwen-image-edit-2509 + node 1001 (Relight LoRA after the Lightning LoRA) + node 1002 (StringConcatenate prefixing the LoRA trigger "重新照明," = "relight,"). ' +
      'prompt = the light to apply, e.g. "relight with neon magenta and cyan rim lights" (Chinese prompts follow the LoRA captions best). Output size follows the input (~1 MP). 4 steps, cfg 1.',
  },
  {
    id: 'qwen-image-edit-2509-angles',
    title: 'Qwen-Image-Edit 2509 Multiple Angles (Fuobe Angles: dx8152 LoRA + Qwen-Image-Lightning)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-edit-2509-angles.json',
    bindings: {
      prompt: [b('433:111', 'prompt')],
      negativePrompt: [b('433:110', 'prompt')],
      image: [b('78', 'image')],
      seed: [b('433:3', 'seed')],
      steps: [b('433:436', 'value')],
      cfg: [b('433:437', 'value')],
      loraStrength: [b('1001', 'strength_model')],
    },
    outputs: [{ node: '469', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Edit 2509, dx8152 Multiple-angles LoRA, Qwen-Image-Lightning)',
    notes:
      'A new camera angle on one photo: library qwen-image-edit-2509 (Qwen-Image-Edit 2509 fp8 + the Lightning 4-step LoRA, FluxKontextImageScale to ~1 MP, ModelSamplingAuraFlow 3, CFGNorm, euler / simple, cfg 1) ' +
      'with dx8152\'s Multiple-angles LoRA after the Lightning LoRA at 1.25 (as fal\'s hosted route and the public HF Space fuse it) and 6 steps (fal\'s default for this LoRA; the Lightning LoRA is distilled for 4). ' +
      'prompt = the LoRA\'s camera instructions in Chinese with English ("将镜头向左旋转45度 Rotate the camera 45 degrees to the left." / move forward / close-up / bird\'s-eye / worm\'s-eye / wide-angle), which Fuobe Angles writes from its controls. ' +
      'The LoRA file is renamed from 镜头转换.safetensors to qwen-edit-2509-multiple-angles-dx8152.safetensors; Fuobe downloads it into ComfyUI\'s loras folder before a run. Output size follows the input (~1 MP).',
  },
  {
    id: 'relight-qwen-edit-2509-reference',
    title: 'Qwen-Image-Edit 2509 Relight from Reference (light migration)',
    capability: 'edit',
    handBuilt: 'hand-built/relight-qwen-edit-2509-reference.json',
    bindings: {
      prompt: [b('1002', 'string_b')],
      negativePrompt: [b('433:110', 'prompt')],
      image: [b('78', 'image')],
      image2: [b('1003', 'image')],
      seed: [b('433:3', 'seed')],
      steps: [b('433:436', 'value')],
      cfg: [b('433:437', 'value')],
      loraStrength: [b('1001', 'strength_model')],
    },
    outputs: [{ node: '469', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Edit-2509, Light-Migration LoRA, Lightning LoRA)',
    notes:
      'Template templates-portrait_light_migration: image = subject, image2 = lighting reference (wired as image2 of both TextEncodeQwenImageEditPlus). Node 1002 prefixes the template instruction ' +
      '("参考色调，移除图1原有的光照并参考图2的光照和色调对图1重新照明" = remove image 1\'s lighting and relight it with image 2\'s light and tone); prompt may stay empty or add constraints. 4 steps, cfg 1.',
  },
  {
    id: 'video-relight-bernini-r',
    title: 'Bernini-R Video Relight / Restyle (lightx2v 6-step)',
    capability: 'v2v',
    handBuilt: 'hand-built/video-relight-bernini-r.json',
    bindings: {
      video: [b('1', 'file')],
      prompt: [b('5', 'string_b')],
      negativePrompt: [b('7', 'text')],
      width: [b('8', 'width')],
      height: [b('8', 'height')],
      frames: [b('8', 'length')],
      seed: [b('16', 'noise_seed')],
      steps: [b('13', 'steps')],
      cfg: [b('16', 'cfg'), b('17', 'cfg')],
    },
    outputs: [{ node: '20', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 121, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (ByteDance Bernini-R, lightx2v)',
    notes:
      'Official template video_bernini_r_video_editing, subgraph flattened with its turbo switch ON: lightx2v T2V v2 rank64 LoRA at 3.0 (high) / 1.5 (low), 6 steps split at 3 (SplitSigmas, not bound), cfg 1, res_multistep. ' +
      'Node 5 prepends the template system prompt for style/lighting/colour edits; prompt = the edit, e.g. "Relight the scene as golden hour, warm low sun from the left; keep subject, motion and framing unchanged". ' +
      'BerniniConditioning resizes/center-crops the source to width x height and trims it to frames (use the source aspect ratio and frame count, 4n+1). Output fps = source fps (linked), no audio. ' +
      'Also works as general prompt-driven video restyle. Turbo off (template): 40 steps split 20, cfg 5, no LoRA. Very new weights (2026-06): GPU smoke-test before exposing.',
  },
  {
    id: 'draw-to-video-wan-move',
    title: 'Wan-Move Draw-to-Video (motion paths, lightx2v)',
    capability: 'draw-to-video',
    handBuilt: 'hand-built/draw-to-video-wan-move.json',
    bindings: {
      image: [b('1', 'image')],
      tracks: [b('3', 'value')],
      prompt: [b('6', 'text')],
      negativePrompt: [b('7', 'text')],
      width: [b('2', 'width'), b('11', 'width')],
      height: [b('2', 'height'), b('11', 'height')],
      frames: [b('11', 'length')],
      motionStrength: [b('11', 'strength')],
      fps: [b('17', 'fps')],
      seed: [b('15', 'seed')],
      steps: [b('15', 'steps')],
      cfg: [b('15', 'cfg')],
      shift: [b('14', 'shift')],
    },
    outputs: [{ node: '18', kind: 'video' }],
    limits: { maxWidth: 832, maxHeight: 832, maxFrames: 81, dimensionMultiple: 16, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (Ruihang/Wan-Move-14B-480P, lightx2v)',
    notes:
      'Official template video_wanmove_480p (turbo path). image = start frame (resized/center-cropped to width x height). tracks = JSON string: a list of tracks, each a list of {"x": px, "y": px} with exactly ONE point per output frame ' +
      '(frames points), in width x height pixel space; all tracks the same length (nodes_wanmove.py uses len(tracks[0])). Client: resample each drawn stroke to frames points by arc length, add a few parallel tracks per object, ' +
      'and constant-position tracks to pin the background. motionStrength = track conditioning strength (1.0). 480p model: keep the long side <= 832. 6 steps, cfg 1, er_sde, shift 8 (without the LoRA: 20 steps, cfg 6).',
  },

  // ---- multi-shot: join per-shot clips ------------------------------------
  ...[2, 3, 4].map((n) => ({
    id: `video-concat-${n}`,
    title: `Join ${n} Shots (multi-shot concat)`,
    capability: 'concat',
    handBuilt: `hand-built/video-concat-${n}.json`,
    bindings: {
      ...Object.fromEntries(Array.from({ length: n }, (_, i) => [i === 0 ? 'video' : `video${i + 1}`, [b(String(1 + 3 * i), 'file')]])),
      width: Array.from({ length: n }, (_, i) => b(String(3 + 3 * i), 'width')),
      height: Array.from({ length: n }, (_, i) => b(String(3 + 3 * i), 'height')),
      fps: [b('21', 'fps')],
    },
    outputs: [{ node: '22', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, dimensionMultiple: 16 },
    vramGb: 0,
    license: 'no model (ComfyUI core nodes)',
    notes:
      `Hard-cut concatenation of ${n} clips (video${n > 1 ? ', video2' : ''}${n > 2 ? ', video3' : ''}${n > 3 ? ', video4' : ''}) in order: LoadVideo -> ImageScale (lanczos, center crop to width x height) -> BatchImagesNode -> CreateVideo (fps linked from the first clip's GetVideoComponents; bind fps to override). ` +
      'Multi-shot recipe: storyboard panels (storyboard-qwen-edit-2509-next-scene) -> one wan22-i2v-14b-lightx2v job per shot (or wan22-flf2v-14b between panels N and N+1 for match cuts) -> this graph; add sound afterwards (v2a-mmaudio / music). ' +
      'All clips should share one fps (frames are concatenated, not retimed); audio tracks are dropped. Runs on CPU; RAM grows with total frame count. LTX-2.5 native multishot (ltx25-t2v/i2v with a shot-list prompt) is the one-pass alternative.',
  })),
  // ---- marketing (Wave B): join clips and keep one clip's sound (UGC presenter, Click to Ad, Ad Multiplier) ----
  ...[1, 2].flatMap((sound) =>
    [2, 3, 4].map((n) => ({
      id: `video-concat-sound${sound}-${n}`,
      title: `Join ${n} clips at one frame rate, keeping clip ${sound}'s sound${sound === 2 ? ' (it starts where clip 1 ends)' : ''}`,
      capability: 'concat',
      handBuilt: `hand-built/video-concat-sound${sound}-${n}.json`,
      bindings: {
        ...Object.fromEntries(Array.from({ length: n }, (_, i) => [i === 0 ? 'video' : `video${i + 1}`, [b(String(1 + 3 * i), 'video')]])),
        width: Array.from({ length: n }, (_, i) => b(String(2 + 3 * i), 'width')),
        height: Array.from({ length: n }, (_, i) => b(String(2 + 3 * i), 'height')),
        fps: [...Array.from({ length: n }, (_, i) => b(String(1 + 3 * i), 'force_rate')), b('21', 'fps')],
      },
      outputs: [{ node: '22', kind: 'video' }],
      limits: { maxWidth: 1920, maxHeight: 1920, dimensionMultiple: 16 },
      vramGb: 0,
      license: 'no model (ComfyUI core nodes + VideoHelperSuite loader)',
      notes:
        `Hard-cut join of ${n} clips in order, each resampled to fps (VHS_LoadVideo force_rate, default 25 = InfiniteTalk's rate) so clips made at 16 fps (Wan) and 25 fps play at their real speed, ` +
        'scaled and centre-cropped to width x height -> BatchImagesNode -> CreateVideo(fps) with a soundtrack: ' +
        (sound === 1
          ? 'clip 1\'s own sound from the start (a voiced presenter followed by silent b-roll, or a reference ad followed by a new CTA). '
          : 'silence as long as clip 1 (VHS_VideoInfoLoaded duration -> EmptyAudio), then clip 2\'s own sound (a silent hook clip, then the voiced presenter or the reference ad). ') +
        `The sound clip must have an audio track (VHS fails to extract audio otherwise); the other clips' sound is dropped. Marketing Studio's UGC, Click to Ad and Ad Multiplier joins use it. ` +
        'Runs on CPU (tested with a 16 fps silent hook + a 25 fps voiced clip + 16 fps b-roll: the sound starts at the hook\'s end). RAM grows with the total frame count at the target fps.',
    })),
  ),

  // ---- storyboard ----------------------------------------------------------
  {
    id: 'storyboard-qwen-edit-2509-next-scene',
    title: 'Storyboard Next Scene (Qwen-Image-Edit 2509 + next-scene LoRA)',
    capability: 'edit',
    handBuilt: 'hand-built/storyboard-qwen-edit-2509-next-scene.json',
    bindings: {
      prompt: [b('1002', 'string_b')],
      negativePrompt: [b('433:110', 'prompt')],
      image: [b('78', 'image')],
      image2: [b('1003', 'image')],
      seed: [b('433:3', 'seed')],
      steps: [b('433:436', 'value')],
      cfg: [b('433:437', 'value')],
      loraStrength: [b('1001', 'strength_model')],
    },
    outputs: [{ node: '469', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Edit-2509, Lightning LoRA); next-scene LoRA MIT (lovis93)',
    notes:
      'Run once per panel: image = previous panel (panel 1 from z-image-turbo-t2i, optionally with the user\'s character LoRA), image2 = character/product reference re-injected every panel to limit identity drift, ' +
      'prompt = camera move + story beat ("The camera pulls back to a wide shot ..."). Node 1002 prefixes "Next Scene:". loraStrength default 0.75 (model card: 0.7-0.8). 4 steps, cfg 1. ' +
      'Drift can still build up over many chained panels; qwen-image-edit-2511-multi (independent panels from the same references) is the no-drift alternative.',
  },

  // ---- video matting / depth ----------------------------------------------
  {
    id: 'video-bg-remove-birefnet',
    title: 'Video Background Removal (BiRefNet, transparent WebM)',
    capability: 'bg-remove-video',
    handBuilt: 'hand-built/video-bg-remove-birefnet.json',
    bindings: { video: [b('1', 'file')] },
    outputs: [
      { node: '7', kind: 'video', role: 'cutout' },
      { node: '10', kind: 'video', role: 'matte' },
    ],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 4,
    license: 'MIT (BiRefNet)',
    notes:
      'Core RemoveBackground on every frame -> InvertMask -> JoinImageWithAlpha (it stores 1-mask as alpha, like bg-remove-birefnet) -> SaveWEBM (vp9, crf 24, fps = source fps): an RGBA .webm with real transparency (yuva420p). ' +
      'Second output (node 10) = black/white matte .mp4 for compositing. SaveWEBM reports its file under history outputs "images" (animated: true), not "videos": classify by the .webm extension / the declared kind. ' +
      'Per-frame model, so hair edges can flicker. Source audio is dropped. For "keep only X" use video-bg-remove-sam3. ' +
      'Roles: node 7 "cutout", node 10 "matte"; params.matteOutput ("cutout" | "matte", on a Remove background job: op bg-remove-video) makes the provider drop the other save node (Video tools → Remove background: Cutout video / Alpha mask).',
  },
  {
    id: 'video-bg-remove-sam3',
    title: 'Video Cutout by Text (SAM 3.1 tracking, transparent WebM)',
    capability: 'bg-remove-video',
    handBuilt: 'hand-built/video-bg-remove-sam3.json',
    bindings: {
      video: [b('1', 'file')],
      prompt: [b('4', 'text')],
    },
    outputs: [
      { node: '9', kind: 'video', role: 'cutout' },
      { node: '12', kind: 'video', role: 'matte' },
    ],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 6,
    license: 'Meta SAM License (royalty-free, commercial use allowed; attribution + acceptable-use terms)',
    notes:
      'prompt = what to KEEP ("person", "red car"). SAM3_VideoTrack (detection_threshold 0.5, max_objects 4, detect_interval 1) -> SAM3_TrackToMask (object_indices "" = all tracked objects) -> InvertMask -> JoinImageWithAlpha -> SaveWEBM (vp9, fps = source). ' +
      'Masks are hard-edged; multiply with the BiRefNet matte for hair. Output under history "images" (animated .webm). Template utility_video_segment_sam3 runs SAM3_Detect per frame instead. ' +
      'Second output (node 12, role "matte", added by the remove-object package) = the black-and-white matte .mp4 of what was kept (MaskToImage -> CreateVideo at the source fps); ' +
      'params.matteOutput ("cutout" | "matte", on a Remove background job: op bg-remove-video) makes the provider drop the other save node, so only the chosen one is encoded.',
  },
  {
    id: 'video-matte-vrmbg3',
    title: 'Video Background Removal (Bria VRMBG 3.0, temporal, transparent WebM) (ComfyUI-RMBG 3.3.0)',
    capability: 'bg-remove-video',
    handBuilt: 'hand-built/video-matte-vrmbg3.json',
    packs: ['ComfyUI-RMBG'],
    requiredModels: ['VRMBG-3.0/model.safetensors'],
    bindings: { video: [b('1', 'file')], format: [b('4', 'format')], profile: [b('4', 'profile')] },
    outputs: [
      { node: '4', kind: 'video', role: 'cutout' },
      { node: '6', kind: 'video', role: 'matte' },
      { node: '7', kind: 'image', role: 'frames' },
    ],
    defaults: { format: 'video/webm', profile: '4444' },
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 6,
    license: 'Bria VRMBG-3.0 licence: NON-COMMERCIAL (the card: non-commercial use only, commercial use needs an agreement with Bria AI; gated, Bria approves access by hand); ComfyUI-RMBG code GPL-3.0',
    notes:
      'AILab_VRMBG (ComfyUI-RMBG 3.3.0, 2026-10-20): Bria\'s VRMBG 3.0, the model behind fal\'s bria/video/background-removal/v3, so the open matte is the cloud\'s model once Bria grants access. ' +
      'Each frame is read at 1024x1024 paired with the previous frame\'s RGB times its alpha (reset_state true: the clip starts clean), and the alpha is scaled back to the frame. ' +
      'Output 0 is the straight RGBA cut-out -> VHS_VideoCombine (video/webm yuva420p, crf 20, the source\'s fps and sound; params.format prores_4444 switches it to video/ProRes profile 4444, ' +
      'yuva444p10le with alpha): role cutout; output 2 (the matte as an image) -> CreateVideo -> SaveVideo: role matte; node 7 writes the RGBA as half-float OpenEXR frames (input sRGB -> scene-linear): role frames, ' +
      'kept only for params.format exr (zipped onto the cut-out). params.matteOutput keeps one of cutout / matte (the provider drops the other save node). The whole clip is decoded at once (GetVideoComponents): RAM grows with the length. ' +
      'The weights are gated: request access at huggingface.co/briaai/VRMBG-3.0, then put config.json, model.safetensors, model.py and vrmbg3_config.py (revision 59716e19) in models/RMBG/VRMBG-3.0/. ' +
      'model.py is Bria\'s own model code, loaded by the node. The class is recorded from ComfyUI-RMBG\'s source at the pinned commit.',
  },
  {
    id: 'video-key-corridorkey',
    title: 'Green-screen key: CorridorKey 2.0 with despill, transparent WebM / ProRes 4444 / EXR, in passes (ComfyUI-CorridorKey2 + VHS)',
    capability: 'bg-remove-video',
    handBuilt: 'hand-built/video-key-corridorkey.json',
    packs: ['ComfyUI-CorridorKey2', 'ComfyUI-VideoHelperSuite'],
    bindings: {
      video: [b('1', 'video')],
      framesPerBatch: [b('2', 'frames_per_batch')],
      despill: [b('6', 'despill_strength')],
      format: [b('7', 'format')],
      profile: [b('7', 'profile')],
    },
    outputs: [
      { node: '7', kind: 'video', role: 'cutout' },
      { node: '9', kind: 'video', role: 'matte' },
      { node: '11', kind: 'image', role: 'frames' },
    ],
    defaults: { framesPerBatch: 48, despill: 0.5, format: 'video/webm', profile: '4444' },
    limits: { maxWidth: 3840, maxHeight: 2160 },
    // Corridor: 4 GB up to 1440p and 6 GB for 4K (the node picks a smaller temporal window and its low-VRAM path on a
    // smaller card); about 6 GB at 1080p in the wrapper's own notes. NVIDIA RTX 30-series or newer (bf16).
    vramGb: 6,
    license: 'CorridorKey 2.0 weights: Corridor Key Licence 2.0 (CC BY-NC-SA 4.0 with added terms: free for any lawful use including commercial projects, and what you make is yours; it may NOT be offered as a paid API or inference service, nor resold or repackaged; derivatives stay under the same licence; a commercial software package needs a written agreement with Corridor Digital; organisations above US$20M revenue need a seat per user). The frozen models it builds on keep their own licences: NVIDIA C-RADIOv4-SO400M (NVIDIA Open Model License), Microsoft MoGe-2 ViT-B (MIT), Google DeepMind RVM small (CC-BY 4.0). The ComfyUI nodes (hashu786/ComfyUI-CorridorKey2) are under the same Corridor Key Licence 2.0.',
    autoDownloads: [
      'CorridorKey2 downloads about 5.1 GB into models/corridorkey2/ on first run: corridorkey_v2.safetensors (2.66 GB) and foundation_stats.safetensors from nikopueringer/CorridorKey2.0 (its main revision, cf44a8db when checked), NVIDIA C-RADIOv4-SO400M @ c0457f5d (1.72 GB), Microsoft MoGe-2 ViT-B @ ca5f0e07 (0.42 GB) and Google DeepMind RVM small (0.27 GB, md5-checked)',
    ],
    notes:
      'VHS_LoadVideo decodes framesPerBatch frames per pass (VHS_BatchManager, 48 by default) and the three VHS_VideoCombine encodes stay open across passes, so memory stays flat on a long clip. ' +
      'CorridorKey2 (hashu786/ComfyUI-CorridorKey2, which vendors Corridor\'s CorridorKey 2.0 code unmodified at 485f5e9) keys each pass as one clip at native resolution, with overlapping temporal Hann windows ' +
      '(window auto: the largest that fits the free VRAM) and no hint, so the model picks the subject; despill 0.5 (Corridor\'s default), input sRGB. Each pass starts its temporal context afresh. ' +
      'Only the outputs a node reads are computed. Roles: node 7 cutout (output 4, the despilled straight RGBA, as a transparent WebM, VP9 yuva420p, with the clip\'s sound; params.format prores_4444 switches it to ' +
      'video/ProRes profile 4444, which VHS writes as yuva444p10le with alpha), node 9 matte (output 1 as an H.264 MP4), node 11 frames (the RGBA as half-float OpenEXR, input sRGB -> scene-linear, one file a frame, in every pass). ' +
      'params.matteOutput keeps cutout or matte; "foreground" feeds node 7 the despilled foreground premultiplied over black (output 2) as H.264 with sound instead. ' +
      'Node 11 stays only for params.format exr, with the cut-out as its preview, and Fuobe zips every pass\'s frames onto it. ' +
      'Corridor\'s despill takes out green spill: the key is for green screens. NVIDIA CUDA only (RTX 30-series or newer). The node\'s class is recorded from its source at the pinned commit.',
  },
  {
    id: 'video-depth-da3',
    title: 'Video Depth Map (Depth Anything 3 Mono)',
    capability: 'depth-video',
    handBuilt: 'hand-built/video-depth-da3.json',
    bindings: { video: [b('1', 'file')], sideBySide: [b('9', 'value')] },
    defaults: { sideBySide: false },
    outputs: [{ node: '7', kind: 'video' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 4,
    license: 'Apache-2.0 (DA3MONO-LARGE; DA3-LARGE / GIANT are CC-BY-NC, do not swap them in)',
    notes:
      'Template utility_depth_anything3_video_depth_estimation: LoadDA3Model -> DA3Inference (resolution 504, step 14; mode "mono") -> DA3Render (output "depth", output.normalization v2_style) -> CreateVideo (source fps + audio). ' +
      'Grayscale depth video (near = bright). Per-frame model (some flicker possible); video-depth-vda-small is the temporally stable alternative. DynamicCombo inputs are dotted keys in API format.',
  },
  {
    id: 'video-depth-vda-small',
    title: 'Video Depth Map (Video Depth Anything Small, temporally stable)',
    capability: 'depth-video',
    handBuilt: 'hand-built/video-depth-vda-small.json',
    bindings: { video: [b('1', 'file')], colormap: [b('5', 'colormap')], sideBySide: [b('9', 'value')] },
    defaults: { colormap: 'gray', sideBySide: false },
    outputs: [{ node: '7', kind: 'video' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 4,
    license: 'Apache-2.0 (Video-Depth-Anything-Small); Base/Large and metric variants are CC-BY-NC-4.0 (non-commercial) - keep the vits model',
    autoDownloads: ['LoadVideoDepthAnythingModel downloads depth-anything/Video-Depth-Anything-Small video_depth_anything_vits.pth (0.12 GB) into models/videodepthanything on first run'],
    notes:
      'yuvraj108c/ComfyUI-Video-Depth-Anything: LoadVideoDepthAnythingModel(model video_depth_anything_vits.pth - pass it explicitly, the declared default ".safetensors" is not in its own option list) -> ' +
      'VideoDepthAnythingProcess(input_size 518, max_res 1280, fp16) -> VideoDepthAnythingOutput(gray) -> CreateVideo (source fps). Designed for long videos with consistent depth across frames. Audio dropped. ' +
      'colormap = gray | inferno (the only two VideoDepthAnythingOutput offers; turbo / magma / viridis would need a LUT step). sideBySide true = the original clip on the left, ' +
      'the depth map scaled to the clip\'s size on the right (ImageStitch; an even width for the encoder), through a lazy ComfySwitchNode (remove-object package).',
  },

  {
    id: 'video-depth-vda-large',
    title: 'Video Depth Map (Video Depth Anything Large, non-commercial weights)',
    capability: 'depth-video',
    handBuilt: 'hand-built/video-depth-vda-small.json',
    transforms: [{ op: 'set', node: '3', input: 'model', value: 'video_depth_anything_vitl.pth' }],
    bindings: { video: [b('1', 'file')], colormap: [b('5', 'colormap')], sideBySide: [b('9', 'value')] },
    defaults: { colormap: 'gray', sideBySide: false },
    outputs: [{ node: '7', kind: 'video' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 8,
    license: 'CC-BY-NC-4.0 (Video-Depth-Anything-Large weights: non-commercial)',
    autoDownloads: ['LoadVideoDepthAnythingModel downloads depth-anything/Video-Depth-Anything-Large video_depth_anything_vitl.pth (about 1.5 GB) into models/videodepthanything on first run'],
    notes:
      'video-depth-vda-small with the Large model: the model Higgsfield\'s Depth Map runs. Its weights are CC-BY-NC-4.0: the licence is information (Settings → Models & licences ' +
      'lists it as Non-commercial with a switch), the Depth map defaults stay VDA-Small (Apache-2.0) on the GPU. Same graph otherwise: gray or inferno, side by side through the lazy switch, audio dropped.',
  },
  {
    id: 'image-face-mosaic-sam3',
    title: 'Pixelate faces (SAM 3.1 face mask + mosaic, core nodes)',
    capability: 'face-mosaic',
    handBuilt: 'hand-built/image-face-mosaic-sam3.json',
    bindings: {
      image: [b('1', 'image')],
      prompt: [b('3', 'text')],
      threshold: [b('4', 'threshold')],
      maskGrow: [b('5', 'expand')],
      mosaicScale: [b('7', 'scale_by')],
    },
    outputs: [{ node: '10', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 4,
    license: 'Meta SAM License (SAM 3.1: royalty-free, commercial use allowed; attribution + acceptable-use terms)',
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    notes:
      'Fuobe Soul\'s PixeletedFace look: SAM3_Detect with the words (prompt, "face" by default: every face, one merged mask, threshold 0.4), GrowMask 12 px so the hair line and jaw are covered, ' +
      'then the picture shrunk by mosaicScale with area averaging (0.04: blocks of 25 px) and blown back up with nearest-exact to its own size, composited only under the mask (ImageCompositeMasked). ' +
      'No face found: the picture comes back unchanged. Core nodes and the SAM 3.1 checkpoint only.',
  },

  {
    id: 'image-person-mask-sam3',
    title: 'Person mask (SAM 3.1, core nodes)',
    capability: 'bg-remove',
    handBuilt: 'hand-built/image-person-mask-sam3.json',
    bindings: {
      image: [b('1', 'image')],
      prompt: [b('3', 'text')],
      threshold: [b('4', 'threshold')],
    },
    outputs: [{ node: '6', kind: 'image' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 4,
    license: 'Meta SAM License (SAM 3.1: royalty-free, commercial use allowed; attribution + acceptable-use terms)',
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    notes:
      'WorldCast cases: the person in the still and in each view as a mask, white where they are, the size of the picture. SAM3_Detect with the words (prompt, "person" by default; ' +
      'threshold 0.4, every match merged into one mask) then MaskToImage. The WorldCast worker cuts its tight no_padding_black crops from it. Core nodes and the SAM 3.1 checkpoint only.',
  },

  // ---- Watermark Remover (ComfyUI-Qwen-Watermark @ eef829d3) ----------------
  // Scan, then remove the marks the visitor kept: the app's own page (src/components/watermark) runs both through
  // POST /api/generations. Same Qwen files as Live edit and Inpaint, plus SAM ViT-B for sticker outlines.
  {
    id: 'image-watermark-scan-qwen3vl',
    title: 'Find watermarks, captions, logos, stickers and mosaics on a photo (Qwen3-VL, ComfyUI-Qwen-Watermark)',
    capability: 'watermark-scan',
    handBuilt: 'hand-built/image-watermark-scan-qwen3vl.json',
    packs: ['ComfyUI-Qwen-Watermark'],
    bindings: { image: [b('1', 'image')] },
    outputs: [
      { node: '23', kind: 'text', role: 'report' },
      { node: '70', kind: 'text', role: 'scan-tile' },
      { node: '71', kind: 'text', role: 'scan-tile' },
      { node: '72', kind: 'text', role: 'scan-tile' },
      { node: '73', kind: 'text', role: 'scan-tile' },
    ],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 10,
    license: 'Qwen3-VL 8B Apache-2.0; ComfyUI-Qwen-Watermark nodes MIT',
    notes:
      'The pack\'s detect-only workflow (qwen_watermark_detection.api.json) without its preview and save nodes: QWMDetect auto_qwen reads the picture once with ' +
      'Qwen3-VL 8B (int8, detection side 1536, up to 2048 tokens, expand 20, padding 0.35, min confidence 0.65) and PreviewAny shows its report: JSON ' +
      '{coordinate_space: "pixels", image_size, boxes: [{label, bbox (padded repair box), source_bbox (tight), overlay_type, mask_method, confidence}], ' +
      'rejected_boxes (below 0.65), status}. Four more QWMDetect read the photo in quarters (ImageCrop, each 4/7 of the width and height from ' +
      'GetImageSize and ComfyMathExpression a * 4 // 7, so a mark repeated over the photo comes back copy by copy); their reports (role scan-tile) ' +
      'are merged into the report by the provider (mergeScanReports). The app draws source_bbox and sends the kept boxes to image-watermark-remove-qwen21. ' +
      'The GPU pre-flight also checks image-watermark-remove-qwen21 for a scan (its companion graph).',
  },
  {
    id: 'image-watermark-remove-qwen21',
    title: 'Remove watermarks, captions, logos, stickers and mosaics, the rest unchanged (Qwen-Image 2.1, ComfyUI-Qwen-Watermark)',
    capability: 'watermark-remove',
    handBuilt: 'hand-built/image-watermark-remove-qwen21.json',
    packs: ['ComfyUI-Qwen-Watermark'],
    bindings: {
      image: [b('1', 'image')],
      seed: [b('12', 'seed'), b('30', 'seed')],
      detectMode: [b('3', 'mode')],
      boxes: [b('3', 'boxes_json')],
      detectExpand: [b('3', 'expand')],
      maxSize: [b('5', 'max_side'), b('28', 'max_side')],
    },
    outputs: [{ node: '33', kind: 'image' }, { node: '38', kind: 'text', role: 'quality' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; Qwen3-VL 8B Apache-2.0; SAM ViT-B (segment-anything) Apache-2.0; ComfyUI-Qwen-Watermark nodes MIT',
    notes:
      'The pack\'s main workflow (qwen21_watermark.api.json, plain settings) with the int8 UNET (qwen_image_2.1_int8_convrot, as Live edit) and without its ' +
      'debug save and preview nodes. QWMDetect (manual_boxes with the kept boxes and a 32 px repair margin past the scan\'s box; auto_qwen with ' +
      'expand 20 for API callers) -> QWMRefineMask (a rectangle for text, logos, ' +
      'blocks and mosaics, a SAM ViT-B outline for stickers) -> QWMPrepare (context 96, max side maxSize, no pre-fill: the OpenCV pre-fill smeared the pattern of a mosaic into a large box) -> Qwen-Image 2.1 edit, 20 steps, ' +
      'cfg 1 -> QWMComposite (feather 6, align, colour match) -> QWMResidualDetect (Qwen3-VL looks for leftovers inside the first mask) -> one more pass ' +
      'when it finds some -> QWMFinal keeps the better pass and raises when any pixel outside the mask changed. Outputs: the picture (SaveImage, PNG) and ' +
      'the quality report (PreviewAny, role quality: folded into the picture\'s meta, never a result of its own). Seeds are random per run. ' +
      'The structure settings (denoise 0.65 / 0.55, context 384, no pre-fill) are the pack\'s alternative for faces.',
  },
  {
    id: 'image-watermark-remove-qwen21-brush',
    title: 'Remove what was brushed, the rest unchanged (Qwen-Image 2.1, ComfyUI-Qwen-Watermark)',
    capability: 'watermark-remove',
    handBuilt: 'hand-built/image-watermark-remove-qwen21-brush.json',
    packs: ['ComfyUI-Qwen-Watermark'],
    bindings: {
      image: [b('1', 'image')],
      mask: [b('50', 'image')],
      seed: [b('12', 'seed'), b('30', 'seed')],
      maxSize: [b('5', 'max_side'), b('28', 'max_side')],
    },
    outputs: [{ node: '33', kind: 'image' }, { node: '38', kind: 'text', role: 'quality' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; Qwen3-VL 8B Apache-2.0; SAM ViT-B (segment-anything) Apache-2.0; ComfyUI-Qwen-Watermark nodes MIT',
    notes:
      'image-watermark-remove-qwen21 with a painted mask: LoadImageMask (red channel, white = remove, the picture\'s size) into QWMDetect manual_mask. ' +
      'The provider runs it when the request carries a mask, on the latest result.',
  },

  // ---- palette / colour lock ----------------------------------------------
  {
    id: 'palette-transfer-image',
    title: 'Palette Lock (ColorTransfer to a swatch)',
    capability: 'grade',
    handBuilt: 'hand-built/palette-transfer-image.json',
    bindings: {
      image: [b('1', 'image')],
      image2: [b('2', 'image')],
      strength: [b('3', 'strength')],
    },
    outputs: [{ node: '4', kind: 'image' }],
    limits: { maxWidth: 8192, maxHeight: 8192 },
    vramGb: 0,
    license: 'no model (ComfyUI core ColorTransfer)',
    notes:
      'Soul HEX parity: image = picture to recolor, image2 = palette swatch PNG the app renders from the HEX list (e.g. 512x512 bands sized by intended coverage). ColorTransfer method mkl_lab (alternatives reinhard_lab, histogram; not bound), ' +
      'strength 0-10 (0.8 default; > 1 exaggerates). Pair with hex codes in the generation prompt (FLUX.2 understands "#E4572E") for semantic placement. Histogram matching shifts skin tones: keep strength <= 0.8. Runs on CPU.',
  },
  {
    id: 'palette-transfer-video',
    title: 'Palette Lock for Video (ColorTransfer, flicker-free)',
    capability: 'v2v',
    handBuilt: 'hand-built/palette-transfer-video.json',
    bindings: {
      video: [b('1', 'file')],
      image: [b('3', 'image')],
      strength: [b('4', 'strength')],
    },
    outputs: [{ node: '6', kind: 'video' }],
    limits: { maxWidth: 4096, maxHeight: 4096 },
    vramGb: 0,
    license: 'no model (ComfyUI core ColorTransfer)',
    notes:
      'video = clip to recolor, image = palette swatch PNG. ColorTransfer(source_stats "uniform") pools colour statistics over all frames, so the grade does not flicker; mkl_lab, strength 0.8. ' +
      'Output keeps the source fps and audio. Runs on CPU.',
  },

  {
    id: 'selftest-image',
    title: 'Self-test: invert image',
    capability: 'edit',
    handBuilt: 'hand-built/selftest-image.json',
    bindings: { image: [b('1', 'image')], filenamePrefix: [b('3', 'filename_prefix')] },
    outputs: [{ node: '3', kind: 'image' }],
    vramGb: 0,
    notes: 'Runs on any ComfyUI (CPU is fine), needs no model files. Used by Settings → Run self-test and the end-to-end self-test.',
  },
  {
    id: 'selftest-video',
    title: 'Self-test: image to flicker video',
    capability: 'i2v',
    handBuilt: 'hand-built/selftest-video.json',
    bindings: { image: [b('1', 'image')], filenamePrefix: [b('6', 'filename_prefix')] },
    outputs: [{ node: '6', kind: 'video' }],
    vramGb: 0,
    notes: 'Runs on any ComfyUI (CPU is fine), needs no model files. Exercises the SaveVideo output path.',
  },
  {
    id: 'selftest-meta-batch',
    title: 'Self-test: invert a clip 8 frames at a time (VHS meta-batch)',
    capability: 'v2v',
    handBuilt: 'hand-built/selftest-meta-batch.json',
    bindings: { video: [b('1', 'video')], filenamePrefix: [b('4', 'filename_prefix')] },
    outputs: [{ node: '4', kind: 'video' }],
    vramGb: 0,
    license: 'n/a (no model)',
    notes:
      'Runs on any ComfyUI (CPU is fine), needs no model files. VHS_BatchManager re-queues the prompt every 8 frames (new prompt ids, ui "unfinished_batch" until the last pass); ' +
      'exercises the provider\'s meta-batch follow-up that mixed-media-zimage-frames relies on. Keeps the source fps and audio.',
  },

  // =========================================================================
  // comfyui-oss-3 (round 3): docs/research/comfyui-oss-3.json. Graphs are the researcher's validated API graphs;
  // changes are listed in each entry's notes.
  // =========================================================================

  // ---- Layers ---------------------------------------------------------------
  {
    id: 'layers-qwen-image-layered',
    title: 'Layers: split an image into RGBA layers (Qwen-Image-Layered)',
    capability: 'layers',
    handBuilt: 'hand-built/layers-qwen-image-layered.json',
    bindings: {
      image: [b('74', 'image')], prompt: [b('116', 'value')], numLayers: [b('83:118', 'layers')], maxSize: [b('82', 'largest_size')],
      seed: [b('83:3', 'seed')], steps: [b('83:3', 'steps')], cfg: [b('83:3', 'cfg')],
    },
    outputs: [{ node: '60', kind: 'image', role: 'layers' }],
    limits: { maxLayers: 10 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Layered weights and the Comfy-Org repack)',
    notes:
      'Template image_qwen_image_layered with the fp8mixed weights (bf16 is 40.9 GB). The input is scaled so its longest side = maxSize (640 is the trained bucket; 1024 works, slower). ' +
      'numLayers = how many RGBA layers come out (1-10, default 4 like the model card; the latent holds numLayers+1 slices and slice 0, the reconstructed composite, is cut off by LatentCut). prompt = optional caption of the whole image. ' +
      'SaveImage writes one full-canvas RGBA PNG per layer, back to front: the provider reports them in that order with meta {name, z, bbox} (bbox from the alpha channel). "Separate layer" = run again on one layer.',
  },
  {
    id: 'layers-qwen-image-layered-control',
    title: 'Layers: pull out a named element (Qwen-Image-Layered-Control)',
    capability: 'layers',
    handBuilt: 'hand-built/layers-qwen-image-layered-control.json',
    bindings: {
      image: [b('74', 'image')], prompt: [b('83:6', 'text')], numLayers: [b('83:123', 'layers')], maxSize: [b('82', 'largest_size')],
      seed: [b('83:3', 'seed')], steps: [b('83:3', 'steps')], cfg: [b('83:3', 'cfg')],
    },
    outputs: [{ node: '60', kind: 'image', role: 'layers' }],
    limits: { maxLayers: 10 },
    vramGb: 24,
    license: 'Apache-2.0 (DiffSynth-Studio Qwen-Image-Layered-Control)',
    notes:
      'Template image_qwen_image_layered_control. prompt names the element(s) to separate ("guitar", "the headline text"); numLayers 2 gives [rest, element] back to front. ' +
      'Higgsfield Layers "Separate layer" / click-to-extract. 40.9 GB bf16 download, cast to fp8_e4m3fn at load.',
  },

  // ---- Moodboards: style reference -----------------------------------------
  {
    id: 'style-ref-qwen-edit-2511',
    title: 'Style reference: Qwen-Image-Edit-2511 + Lightning, new image in the look of 1-2 board collages',
    capability: 'style-reference',
    handBuilt: 'hand-built/style-ref-qwen-edit-2511.json',
    bindings: {
      image: [b('1', 'image')], image2: [b('2', 'image')], prompt: [b('20', 'string_b')], width: [b('26', 'width')], height: [b('26', 'height')],
      seed: [b('27', 'seed')], steps: [b('27', 'steps')], cfg: [b('27', 'cfg')], loraStrength: [b('11', 'strength_model')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Edit-2511, Lightning LoRA)',
    notes:
      'The app builds 1-2 collages from the board (4-20 images as a contact sheet, ~1 MP each) and uploads them as image / image2 (one collage is passed twice). ' +
      'The instruction asks for the look, not the content: same palette, light, contrast, grain, lens and mood. Output size = the empty latent (any aspect ratio). ' +
      'Lightning 4 steps at cfg 1 (loraStrength 0, steps 40, cfg 4 for the slow full-quality path). Zero-shot; a persistent moodboard is a style LoRA trained like a character.',
  },
  {
    id: 'style-ref-flux2-klein-4b',
    title: 'Style reference: FLUX.2 [klein] 4B, four references (4 steps)',
    capability: 'style-reference',
    handBuilt: 'hand-built/style-ref-flux2-klein-4b.json',
    bindings: {
      image: [b('76', 'image')], image2: [b('81', 'image')], image3: [b('77', 'image')], image4: [b('78', 'image')], prompt: [b('75:74', 'text')],
      width: [b('75:66', 'width'), b('75:62', 'width')], height: [b('75:66', 'height'), b('75:62', 'height')], seed: [b('75:73', 'noise_seed')], steps: [b('75:62', 'steps')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 10,
    license: 'Apache-2.0 (FLUX.2 [klein] 4B)',
    notes:
      'Template image_flux2_klein_image_edit_4b_distilled with two extra ReferenceLatent references and an explicit output size. 1-4 references: ' +
      'the provider bypasses the ReferenceLatent pair of each reference not given (bypassReference). Fast (4 steps, 8-10 GB). Weaker than Qwen-Image-Edit-2511 on complex prompts.',
  },
  {
    id: 'style-ref-krea2',
    title: 'Style reference: Krea 2 Turbo + style_reference LoRA, two references',
    capability: 'style-reference',
    handBuilt: 'hand-built/style-ref-krea2.json',
    bindings: {
      image: [b('69', 'image')], image2: [b('70', 'image')], prompt: [b('30:19', 'value')],
      width: [b('30:61', 'width'), b('30:64', 'width')], height: [b('30:61', 'height'), b('30:64', 'height')], seed: [b('30:63', 'noise_seed')], steps: [b('30:60', 'steps')],
      loraStrength: [b('30:15', 'strength_model')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license: 'Krea 2 Community License (free for individuals and small teams; enterprise terms above the thresholds); LoRA by Ostris under the same licence',
    notes:
      'The only open model here trained for style reference (1-2 references). The template ResolutionSelector is replaced by explicit width/height (multiple of 16); its TextGenerate prompt expansion is removed (Fuobe enhances prompts itself).',
  },
  {
    id: 'style-ref-uso-flux1',
    title: 'Style reference: USO on FLUX.1 [dev], two stacked style images (non-commercial base)',
    capability: 'style-reference',
    handBuilt: 'hand-built/style-ref-uso-flux1.json',
    bindings: {
      image: [b('1', 'image')], image2: [b('2', 'image')], prompt: [b('20', 'text')], width: [b('23', 'width')], height: [b('23', 'height')],
      seed: [b('24', 'seed')], steps: [b('24', 'steps')], guidance: [b('21', 'guidance')],
    },
    outputs: [{ node: '26', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license: 'USO LoRA/projector Apache-2.0, but the FLUX.1 [dev] base is NON-COMMERCIAL (outputs may be used commercially per the BFL licence; running it as a paid service is not)',
    notes: 'ByteDance USO style-only reference: each USOStyleReference stacks one more style image (CLIPVisionEncode + USOStyleReference pairs). 20 steps, guidance 3.5, cfg 1.',
  },

  // ---- Soul HEX: palette-conditioned generation -------------------------------
  {
    id: 'palette-zimage-hex',
    title: 'Soul HEX: Z-Image Turbo with the hex palette in the prompt + ColorTransfer lock to a swatch',
    capability: 'palette',
    handBuilt: 'hand-built/palette-zimage-hex.json',
    bindings: {
      paletteImage: [b('1', 'image')], prompt: [b('20', 'string_a')], paletteText: [b('20', 'string_b')], width: [b('23', 'width')], height: [b('23', 'height')],
      seed: [b('24', 'seed')], steps: [b('24', 'steps')], strength: [b('26', 'strength')], method: [b('26', 'method')],
    },
    outputs: [{ node: '27', kind: 'image' }],
    defaults: { method: 'mkl_lab', paletteText: 'Color palette: #0F0C0B, #65370D, #916D4C, #C6BE94, #F2F1C4.' },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 12,
    license: 'Apache-2.0 (Z-Image Turbo); ColorTransfer has no model',
    notes:
      'One job = generate + lock. The provider writes paletteText from params.palette ("Color palette: #.., #..") and renders paletteImage, a swatch PNG with one band per colour, server-side. ' +
      'strength 0 = prompt only; 0.5-0.8 = lock; 1.0 = full statistics transfer (shifts skin tones). method mkl_lab (default, keeps contrast), reinhard_lab (softer), histogram (strongest). ' +
      'palette-transfer-image / -video do the same lock as a post-step for any model (cloud outputs too).',
  },

  // ---- Fuobe Soul (Originals O2): restyle a picture with a look ----------------------
  {
    id: 'z-image-turbo-i2i',
    title: 'Z-Image Turbo image to image (Fuobe Soul edit: the look and its LoRAs on your picture)',
    capability: 'edit',
    handBuilt: 'hand-built/z-image-turbo-i2i.json',
    bindings: {
      image: [b('1', 'image')], megapixels: [b('2', 'megapixels')], prompt: [b('14', 'text')], seed: [b('17', 'seed')], steps: [b('17', 'steps')],
      strength: [b('17', 'denoise')], shift: [b('13', 'shift')],
    },
    outputs: [{ node: '19', kind: 'image' }],
    defaults: { steps: 8, shift: 3, strength: 0.6, megapixels: 1 },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 12,
    license: 'Apache-2.0 (Z-Image Turbo)',
    notes:
      'Fuobe Soul\'s edit route (Soul 2.0 image-to-image): the picture scaled to Soul\'s tier (megapixels 1 = 720p, 2 = 1080p) on the 16-pixel grid, VAE-encoded, then the Soul sampler ' +
      '(8 steps, cfg 1, res_multistep, shift 3) at denoise = strength (0.6 like fal\'s z-image/turbo/image-to-image; about 0.17 would be Higgsfield\'s refiner pass). ' +
      'The look\'s LoRAs are injected after the UNETLoader (LoraLoaderModelOnly), as on z-image-turbo-t2i. The result keeps the picture\'s shape.',
  },

  // ---- Owner's SOTA image families: Qwen-Image 2.1 (2026-10-31) ------------------------
  // Core ComfyUI 0.42.0 nodes (TextEncodeQwenImage21, QwenImage21Cache); inpaint and expand also need the AusBoss nodes.
  // The Qwen 2.1 VAE decodes four channels, so every graph drops the alpha (SplitImageWithAlpha) before saving or stitching.
  {
    id: 'qwen-image-21-t2i',
    title: 'Qwen-Image 2.1 Text to Image',
    capability: 't2i',
    handBuilt: 'hand-built/qwen-image-21-t2i.json',
    bindings: {
      prompt: [b('4', 'prompt')], width: [b('5', 'width')], height: [b('5', 'height')], seed: [b('6', 'seed')], steps: [b('6', 'steps')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 32 },
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The Qwen-Image 2.1 text-to-image workflow, its subgraph flattened: int8 model, Qwen3-VL 8B int8 text encoder (type qwen_image), ' +
      'TextEncodeQwenImage21 (no negative, resolution 1024, no images), EmptyLatentImage, KSampler 25 steps, cfg 1, euler, simple, denoise 1. ' +
      'Removed: the ResolutionSelector (width/height bind the latent, multiples of 32, native up to 2048x2048) and the SaveImageAdvanced (SaveImage after SplitImageWithAlpha, as the Qwen 2.1 VAE decodes four channels). ' +
      'cfg 1: no negative prompt.' + QWEN21_CLEAN_NOTE,
  },
  {
    id: 'qwen-image-21-edit',
    title: 'Qwen-Image 2.1 Image Edit (up to 4 references)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-edit.json',
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')],
      seed: [b('32', 'seed')], steps: [b('32', 'steps')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The 25-step Qwen-Image 2.1 edit behind the site\'s preview pictures, with the references wired as in the Qwen-Image 2.1 image-edit workflow: ' +
      'each image scaled to 2048 on its long side (lanczos), all of them on one TextEncodeQwenImage21 (images.image_1..4, resolution 0 = each at its own size on the 32 grid, vae linked, no negative), ' +
      'its latent (image 1\'s size: no custom-size latent, which shifts the edit), QwenImage21Cache auto, KSampler 25 steps, cfg 1, euler, simple. Output follows image 1 (2048 on the long side). ' +
      'Images 2-4 are optional: Fuobe leaves out the branch of a reference not given. Prompt: one plain instruction, then one keep clause pointing at the picture ' +
      '("Keep ... exactly as in image 1"); refer to references as image 1/2/3/4. Removed: the ComfySwitchNode custom size, compare and note nodes. It and qwen-image-21-turbo-edit made 133 of the site\'s preview edits.' + QWEN21_CLEAN_NOTE,
  },
  {
    id: 'qwen-image-21-turbo-edit',
    title: 'Qwen-Image 2.1 Turbo Image Edit (8 steps, up to 4 references)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-turbo-edit.json',
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')], seed: [b('70', 'noise_seed')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The Qwen-Image 2.1 turbo image-edit workflow, as the site\'s fast preview edits run it: turbo int8 model, the fixed 8-step ManualSigmas ' +
      'schedule, KSamplerSelect euler, CFGGuider cfg 1, RandomNoise, SamplerCustomAdvanced on the encoder\'s latent; references as qwen-image-21-edit (2048 lanczos, resolution 0, up to 4, optional ones dropped). ' +
      'No steps binding: the sigmas are the schedule. Removed: the prompt enhancer branch (Qwen3.5 9B PE model, off in the workflow), the custom-size switch, compare and notes. ' +
      'In a blind test it matched 25 steps (21 vs 22 of 48 outfit edits) and was weaker only on hard camera turns and product rotations (use qwen-image-21-edit there).' + QWEN21_CLEAN_NOTE,
  },
  // ---- Relight with placed lights (the Relight app's own tool, src/components/relight): Generate lighting and the scene read.
  {
    id: 'qwen-image-21-relight',
    title: 'Relight with placed lights: Qwen-Image 2.1 + Viggle 6-step speed LoRA, the photo plus words written from the lights (viggle_turbo)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-relight.json',
    packs: ['viggle_turbo'],
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], seed: [b('70', 'noise_seed')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    license:
      'Qwen Research License Agreement (Qwen-Image 2.1 and Viggle\'s turbo LoRA, a derivative): NON-COMMERCIAL, research and evaluation only; ' +
      'the viggle_turbo node file ships in the same model repo under the same terms',
    notes:
      'Built from Viggle\'s ComfyUI edit workflow (Viggle/Qwen-Image-2.1-viggle-turbo, comfyui/) with one reference: the int8 Qwen-Image 2.1 model, ' +
      'the v0.2.1 6-step LoRA (r256) on ViggleTurboLora at 1.0 (applied unmerged; it reads lora_alpha / r from the file\'s metadata), QwenImage21Cache auto, ' +
      'TextEncodeQwenImage21 at resolution 1024 (about 1 MP, sides on the 32 grid), positive only, BasicGuider (no CFG), euler, ' +
      'ViggleTurboSigmas "1.0, 0.9375, 0.875, 0.75, 0.5, 0.25" (the raw nodes, shifted for the latent\'s size), RandomNoise, SamplerCustomAdvanced, VAEDecode. ' +
      'The words come from the placed lights ("Relight the photo with a strong sunset orange light coming from the left, at face height, far away. The scene is in ' +
      'darkness, lit only by these lights …"), so the result is lit only by them and the page blends it with the original (Intensity). Image 2 is an optional ' +
      'light-guide picture (the rig drawn over the darkened photo), dropped when not given. The seed comes from the photo, so moving one light changes only that light. ' +
      'A Pruna 8-step v0.1 LoRA in its place must also load through ViggleTurboLora at 1.0: its x2 strength is only in the metadata, so LoraLoaderModelOnly at 1.0 gives half.',
  },
  {
    id: 'relight-scene-read',
    title: 'Relight scene read: depth (Depth Anything 3 mono large) and the subject\'s matte (BiRefNet) of one photo (core)',
    capability: 'bg-remove',
    handBuilt: 'hand-built/relight-scene-read.json',
    bindings: { image: [b('1', 'image')] },
    outputs: [
      { node: '5', kind: 'image', role: 'depth' },
      { node: '9', kind: 'image', role: 'matte' },
    ],
    vramGb: 6,
    license: 'Depth Anything 3 mono large: Apache-2.0 (model card) · BiRefNet: MIT',
    notes:
      'One photo in, two grey PNGs out, for the Relight page\'s depth-true preview: DA3Inference (mono, 504, lower-bound resize) and DA3Render depth with ' +
      'v2_style normalisation (near = bright), and the core background-removal nodes (birefnet.safetensors) with the mask saved as a picture (white = subject). ' +
      'Runs once per photo; its runs are helper steps the Library leaves out.',
  },
  {
    id: 'qwen-image-21-live-edit',
    title: 'Qwen-Image 2.1 Live Edit (2-step DMD2 LoRA, as you type)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-live-edit.json',
    packs: ['fuobe-live'],
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')],
      mask: [b('14', 'image')], seed: [b('70', 'noise_seed')], width: [b('30', 'width')], height: [b('30', 'height')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 32 },
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1 and the DMD2 2-step LoRA by linoyts, a derivative): NON-COMMERCIAL, research and evaluation only; Fuobe live nodes MIT',
    notes:
      'Live editing as you type (Fuobe builds this graph in code; this file is its canonical form): the int8 Qwen-Image 2.1 model with the DMD2 2-step LoRA at 1, ' +
      'BasicGuider (CFG 1, positive only), euler, ManualSigmas "1.0, 0.5, 0.0" (the LoRA card\'s schedule, no shift), on Fuobe\'s live nodes (fuobe_live.py): ' +
      'a loader that skips the input-folder listing, the references resized and VAE-encoded in their own node (cached while only the text changes), a positive-only encode, ' +
      'a crop around a painted region, a paste-back of unchanged pixels with colour matching, and a save node that sends the picture over the socket. ' +
      'Live frames at 384-768, kept steps at 1024-2048 composited onto a full-size lossless master. References 2-4 and the mask are optional.',
  },
  {
    id: 'qwen-image-21-inpaint',
    title: 'Qwen-Image 2.1 Inpaint (crop around the mask, paste back)',
    capability: 'inpaint',
    handBuilt: 'hand-built/qwen-image-21-inpaint.json',
    packs: ['ausboss-nodes'],
    bindings: {
      prompt: [b('22', 'values.a')], image: [b('10', 'image')], mask: [b('11', 'image')], seed: [b('27', 'seed')], steps: [b('27', 'steps')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; AusBoss nodes MIT${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The AusBoss pack\'s example "Qwen Image 2.1 Inpaint (AusBoss)", its two subgraphs flattened: ' +
      'Crop For Inpaint (context 1.6, blend 8 px, multiple 32, 1.5 MP, bicubic) -> GrowMask 8 on the crop\'s mask -> StringFormat "{a} Keep everything else exactly the same." -> ' +
      'TextEncodeQwenImage21 with the crop as image 1 (resolution 0) -> VAEEncode of the crop + SetLatentNoiseMask -> QwenImage21Cache -> KSampler 25 steps, cfg 1, euler, simple -> ' +
      'SplitImageWithAlpha -> Stitch Inpaint (classic, no colour match) back into the full picture. mask = separate uploaded PNG, same size as image, read from the RED channel: white = change ' +
      '(as flux1-fill-inpaint). Removed: Mask by Touch and its SAM 3.1 model (the mask is uploaded), the speed LoRA (off in the example), the crop/pad loader (LoadImage), compare, timer and notes. ' +
      'Prompt: say what goes in the painted area like asking a person ("Replace the cup with a glass of orange juice").' + QWEN21_CLEAN_NOTE,
  },
  {
    id: 'qwen-image-21-recolor',
    title: 'Qwen-Image 2.1 Recolor (tap mask by name, crop, repaint, paste back)',
    capability: 'recolor',
    handBuilt: 'hand-built/qwen-image-21-recolor.json',
    bindings: {
      image: [b('10', 'image')], touches: [b('14', 'touches')], maskGrow: [b('15', 'expand')],
      prompt: [b('22', 'values.a')], seed: [b('27', 'seed')], steps: [b('27', 'steps')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; Meta SAM License (SAM 3.1); AusBoss nodes MIT',
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    notes:
      'Tap to Recolor: qwen-image-21-inpaint with the mask made in the graph from the taps by AusBoss Mask by Touch on core SAM 3.1. ' +
      'touches = the node\'s JSON {"v":1,"items":[{"t":"name","w":word,"x":int,"y":int,"op":1|0}]} in the photo\'s pixels: ' +
      'each tap asks for the smallest thing of the piece\'s name under it (Jacket: jacket + clothing; Auto: clothing, bag, shoe, hat, scarf), a Leave out tap takes away a hand, arm, hair, ' +
      'belt, bag strap or necklace under it. SAM 3.1\'s point prompt alone (SAM3_Detect) returned the whole person on every GPU test, so taps go through names. If nothing is found ' +
      'the mask is empty and the photo comes back unchanged (if_nothing "empty mask"); free_vram unloads SAM before the repaint. -> GrowMask maskGrow (1) -> Crop For Inpaint ' +
      '(context 1.4, blend 2 px, multiple 32, 1.5 MP, bicubic: a tight paste, since a wider one showed a blotchy rim on flat studio backgrounds) -> GrowMask 16 on the crop\'s mask ' +
      '(the sampling mask: 8 left a thin line of the old colour along a draped neckline, smaller left old-colour specks at the edge) -> StringFormat "{a} Keep everything else in the picture exactly the same." -> TextEncodeQwenImage21 with ' +
      'the crop as image 1 (resolution 0) -> VAEEncode + SetLatentNoiseMask -> QwenImage21Cache -> KSampler 20 steps, cfg 1, euler, simple (16 looked the same as 25 on the tests) -> ' +
      'SplitImageWithAlpha -> Stitch Inpaint (classic, colour match 0: a tone match would pull the new colour back). Outside the piece the photo is bit-identical. ' +
      'RTX 5090: about 32 s per colour warm at 1.5 MP (target_megapixels 1.0 + 16 steps: 19 s, slightly softer stripes), peak 23 GB. ' +
      'Prompt: "Change the colour of <the piece> (Auto: the outfit) to <colour words (#hex)>. Keep its fabric, weave, folds, seams, stitching, sheen, print and shadows exactly as they are, so only the colour is new."',
  },
  {
    id: 'qwen-image-21-outpaint',
    title: 'Qwen-Image 2.1 Expand (outpaint-v2 LoRA, Qwen3-VL scene description)',
    capability: 'outpaint',
    handBuilt: 'hand-built/qwen-image-21-outpaint.json',
    packs: ['ausboss-nodes'],
    bindings: {
      prompt: [b('21', 'string')], image: [b('10', 'image'), b('11', 'image')],
      padLeft: [b('10', 'pad_left'), b('11', 'pad_left')], padTop: [b('10', 'pad_top'), b('11', 'pad_top')],
      padRight: [b('10', 'pad_right'), b('11', 'pad_right')], padBottom: [b('10', 'pad_bottom'), b('11', 'pad_bottom')],
      seed: [b('32', 'seed')], steps: [b('32', 'steps')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { padMultiple: 8 },
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; outpaint LoRA by AusBoss under the same licence; AusBoss nodes MIT${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The Qwen-Image 2.1 outpaint workflow (v12) as the site\'s Expand previews run it: Crop + Rotate + Pad puts the photo on a gray (#808080) canvas grown by the pads ' +
      '(feather 12, scaled to 1 MP on the 32 grid) -> outpaint-v2 LoRA at 1 -> Qwen3-VL 8B (the same text encoder, TextGenerate, the workflow\'s instruction, seed fixed) describes the picture, ' +
      '"Outpaint the image: ... Scene:" leads -> TextEncodeQwenImage21 with the canvas as image 1 -> KSampler 25 steps, cfg 1, euler, simple, no noise mask (it drew a box at the seam) -> ' +
      'SplitImageWithAlpha -> Stitch Inpaint (blend in, tone match 1) -> scaled to the full-size padded canvas, and the original photo composited back on top (second pad node, feather 48). ' +
      'Pads are the input photo\'s pixels (multiples of 8); defaults 384/288/384/288 = a 1.5x zoom-out of a 1536x1152 photo. Grow at most about the photo\'s own size per side per run. ' +
      'prompt = the optional "what goes there" hint (the lead-in "Also include in the prompt:" is added); it must not name the subject, which then appears again in the margin. ' +
      'Removed: AusBoss Seed/Text/Compare/RunTimer/ShowText/WorkflowNote and its SaveImage (SaveImage).' + QWEN21_CLEAN_NOTE,
  },
  // ---- Qwen-Image 2.1 in 2-6 steps (Options → Speed), the 2.1 Next-Scene LoRA, and a 16 GB route ---------------------------
  // Each speed graph is its base graph with one LoRA + ManualSigmas branch (qwen21Tier above); the provider picks it from
  // params.extra.speed (src/lib/comfy-variants.ts). Turbo is qwen-image-21-turbo-edit; Full is the base graph.
  qwen21Tier('t2i', 'draft', { title: 'Qwen-Image 2.1 Text to Image', capability: 't2i', bindings: { prompt: [b('4', 'prompt')], width: [b('5', 'width')], height: [b('5', 'height')] }, output: '9', limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 32 } }),
  qwen21Tier('t2i', 'fast', { title: 'Qwen-Image 2.1 Text to Image', capability: 't2i', bindings: { prompt: [b('4', 'prompt')], width: [b('5', 'width')], height: [b('5', 'height')] }, output: '9', limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 32 } }),
  qwen21Tier('t2i', 'details', { title: 'Qwen-Image 2.1 Text to Image', capability: 't2i', bindings: { prompt: [b('4', 'prompt')], width: [b('5', 'width')], height: [b('5', 'height')] }, output: '9', limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 32 } }),
  qwen21Tier('edit', 'draft', { title: 'Qwen-Image 2.1 Image Edit (up to 4 references)', capability: 'edit', bindings: { prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')] }, limits: { maxWidth: 2048, maxHeight: 2048 } }),
  qwen21Tier('edit', 'fast', { title: 'Qwen-Image 2.1 Image Edit (up to 4 references)', capability: 'edit', bindings: { prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')] }, limits: { maxWidth: 2048, maxHeight: 2048 } }),
  qwen21Tier('edit', 'details', { title: 'Qwen-Image 2.1 Image Edit (up to 4 references)', capability: 'edit', bindings: { prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')] }, limits: { maxWidth: 2048, maxHeight: 2048 } }),
  qwen21Tier('inpaint', 'draft', { title: 'Qwen-Image 2.1 Inpaint', capability: 'inpaint', bindings: { prompt: [b('22', 'values.a')], image: [b('10', 'image')], mask: [b('11', 'image')] }, packs: ['ausboss-nodes'] }, { license: '; AusBoss nodes MIT' }),
  qwen21Tier('inpaint', 'fast', { title: 'Qwen-Image 2.1 Inpaint', capability: 'inpaint', bindings: { prompt: [b('22', 'values.a')], image: [b('10', 'image')], mask: [b('11', 'image')] }, packs: ['ausboss-nodes'] }, { license: '; AusBoss nodes MIT' }),
  qwen21Tier('outpaint', 'draft', { title: 'Qwen-Image 2.1 Expand', capability: 'outpaint', bindings: { prompt: [b('21', 'string')], image: [b('10', 'image'), b('11', 'image')], padLeft: [b('10', 'pad_left'), b('11', 'pad_left')], padTop: [b('10', 'pad_top'), b('11', 'pad_top')], padRight: [b('10', 'pad_right'), b('11', 'pad_right')], padBottom: [b('10', 'pad_bottom'), b('11', 'pad_bottom')] }, limits: { padMultiple: 8 }, packs: ['ausboss-nodes'] }, { after: ' and the outpaint-v2 LoRA (the speed LoRA stacks on it)', license: '; outpaint LoRA by AusBoss under the same licence; AusBoss nodes MIT', notes: ' Expand keeps its Qwen3-VL scene description (TextGenerate) as it is.' }),
  qwen21Tier('outpaint', 'fast', { title: 'Qwen-Image 2.1 Expand', capability: 'outpaint', bindings: { prompt: [b('21', 'string')], image: [b('10', 'image'), b('11', 'image')], padLeft: [b('10', 'pad_left'), b('11', 'pad_left')], padTop: [b('10', 'pad_top'), b('11', 'pad_top')], padRight: [b('10', 'pad_right'), b('11', 'pad_right')], padBottom: [b('10', 'pad_bottom'), b('11', 'pad_bottom')] }, limits: { padMultiple: 8 }, packs: ['ausboss-nodes'] }, { after: ' and the outpaint-v2 LoRA (the speed LoRA stacks on it)', license: '; outpaint LoRA by AusBoss under the same licence; AusBoss nodes MIT', notes: ' Expand keeps its Qwen3-VL scene description (TextGenerate) as it is.' }),
  {
    id: 'qwen-image-21-next-scene',
    title: 'Storyboard Next Scene (Qwen-Image 2.1 + the 2.1 Next-Scene LoRA)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-next-scene.json',
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], seed: [b('32', 'seed')], steps: [b('32', 'steps')],
      loraStrength: [b('60', 'strength_model')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    defaults: { promptPrefix: 'Next Scene:' },
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `${QWEN21_LICENCE}; Next-Scene LoRA by akhaliq @ 67ce88cd: an apache-2.0 tag on its card only (no LICENSE file), an adapter of Qwen-Image 2.1, so non-commercial through its base${QWEN21_CLEAN_LICENCE}`,
    notes:
      'Storyboard\'s next frame on your GPU: the qwen-image-21-edit graph with akhaliq/Qwen-Image-2.1-Next-Scene-LoRA @ 67ce88cd (next_scene_step2500, the card\'s recommended diffusers/ComfyUI conversion) at 0.7, ' +
      'the card\'s clean-chain recipe: strength 0.7 or less and a 0.5 px Gaussian blur on each chained input (ImageBlur radius 1, sigma 0.5 on the previous panel), 28 steps (the card\'s usage), cfg 1, euler, simple. ' +
      'image = the previous panel, image2 = an optional character reference (left out when not given). The prompt starts "Next Scene:" with the camera move first (promptPrefix adds it when missing). ' +
      'Trained at 512 px on Sintel and Tears of Steel frame pairs: strongest on filmic scenes and establishing shots, static portraits are out of scope (card). ' +
      'storyboard-qwen-edit-2509-next-scene stays the classic choice on your GPU, and the cloud keeps Qwen-Image-Edit 2509 + its next-scene LoRA on fal (Qwen-Image 2.1 is not hosted).' + QWEN21_CLEAN_NOTE,
  },
  // ---- QMA camera angles (96 views) on Qwen-Image 2.1 ------------------------------------------------------------------
  {
    id: 'qwen-image-21-qma',
    title: 'QMA Camera Angles (Qwen-Image 2.1 + the QMA LoRA, 96 views)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-qma.json',
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], seed: [b('32', 'seed')], steps: [b('32', 'steps')], cfg: [b('32', 'cfg')],
      megapixels: [b('20', 'megapixels')], loraStrength: [b('60', 'strength_model')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 20,
    optionalModels: [QWEN21_CLEAN_VAE],
    license: `${QWEN21_LICENCE}; QMA Camera Angles LoRA by gribbliest @ 13007eec: Apache-2.0 on its card (no LICENSE file), an adapter of Qwen-Image 2.1, so non-commercial through its base${QWEN21_CLEAN_LICENCE}`,
    notes:
      'Re-shoots a picture from one of 96 cameras: the qwen-image-21-edit graph with gribbliest/qwen-image-2.1-qma-camera-angles @ 13007eec (rank 64, 319 MB) at strength 1.0 and the card\'s settings: ' +
      'the source scaled to about 1 MP (ImageScaleToTotalPixels, lanczos, 32 px steps; megapixels 0.6 = the card\'s 768 px preview), one reference on TextEncodeQwenImage21 (resolution 0, its latent), ' +
      'QwenImage21Cache, KSampler 30 steps, CFG 3 (the card; the encoder\'s empty negative), euler, simple. ' +
      'Prompt: "<qma> {azimuth} {elevation} {distance}" then any edit words; Fuobe writes it from the run\'s camera (horizontal_angle / vertical_angle / zoom, snapped to the nearest view). ' +
      'Directions are the original camera\'s: "right side view" = the camera swings 90° to its own right. Open engine only: fal\'s Qwen-Image 2.1 takes no LoRAs.' + QWEN21_CLEAN_NOTE,
  },
  {
    id: 'qwen-image-21-t2i-small',
    title: 'Qwen-Image 2.1 Text to Image on a 16 GB GPU (Zen Image Edit: Qwen3.5-0.8B encoder + fusion adapter)',
    capability: 't2i',
    handBuilt: 'hand-built/qwen-image-21-t2i-small.json',
    packs: ['zen-image-edit-comfyui'],
    bindings: {
      prompt: [b('5', 'prompt')], width: [b('5', 'width')], height: [b('5', 'height')], seed: [b('6', 'seed')], steps: [b('6', 'steps')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 32 },
    vramGb: 16,
    optionalModels: [QWEN21_CLEAN_VAE],
    requiredModels: ['adapter_v12.safetensors'],
    autoDownloads: ZEN_FIRST_RUN,
    license: `${QWEN21_LICENCE}${ZEN_LICENCE}${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The small-GPU route (Options → GPU "Small", or Auto on a card under 20 GB when this route is ready there): recoilme/zen-image-edit-comfyui @ 7a29e58c (release v2) as its example graph t2i_api.json, ' +
      'ZenImage21AdapterLoader (adapter_file: adapter_v12.safetensors, a required file in models/text_encoders whose full path Fuobe binds from GET /experiment/models, else models/text_encoders/adapter_v12.safetensors from ComfyUI\'s folder; text_encoder: the pinned Qwen3.5-0.8B folder models/text_encoders/qwen3.5_0.8b when the server has it, else Qwen/Qwen3.5-0.8B by id; bf16) -> ZenImage21TextEncode (resolution 1024; width / height the canvas) in place of the 17.5 GB Qwen3-VL 8B, ' +
      'the stock Qwen-Image 2.1 DiT (here the int8 file, 7.3 GB, where the example loads bf16) -> ModelSamplingAuraFlow shift 5 (the model author\'s static shift) -> KSampler 30 steps, cfg 1, euler, simple. ' +
      'Conditioning cosine 0.95 (text) against the native encoder (AiArtLab/zen-image-edit @ 3d571755). English prompts only; numerals on signs can come out wrong. About 17.5 GB resident at 1024 px with the bf16 DiT (card): the int8 DiT is what brings it to 16 GB (the example graphs load bf16). Needs transformers >= 5.17.' + QWEN21_CLEAN_NOTE,
  },
  {
    id: 'qwen-image-21-edit-small',
    title: 'Qwen-Image 2.1 Image Edit on a 16 GB GPU (Zen Image Edit, up to 4 references)',
    capability: 'edit',
    handBuilt: 'hand-built/qwen-image-21-edit-small.json',
    packs: ['zen-image-edit-comfyui'],
    bindings: {
      prompt: [b('5', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')], image3: [b('12', 'image')], image4: [b('13', 'image')],
      seed: [b('6', 'seed')], steps: [b('6', 'steps')], vae: [b('3', 'vae_name')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 16,
    optionalModels: [QWEN21_CLEAN_VAE],
    requiredModels: ['adapter_v12.safetensors'],
    autoDownloads: ZEN_FIRST_RUN,
    license: `${QWEN21_LICENCE}${ZEN_LICENCE}${QWEN21_CLEAN_LICENCE}`,
    notes:
      'The small-GPU edit, as zen-image-edit-comfyui\'s edit_api.json: ZenImage21TextEncode with the VAE linked (the DiT splices the references in as latents), resolution 1024 (references resized to about 1 MP on the 32 grid, the geometry adapter v12 was tuned at), ' +
      'image_1 the picture to change (the canvas follows it), image_2-4 optional references (left out when not given). Same sampler as qwen-image-21-t2i-small. English prompts only.' + QWEN21_CLEAN_NOTE,
  },
  // ---- Apps: Steam It (a creased outfit, pressed; nothing else changes) ---------------------------
  {
    id: 'steam-it-qwen-image-21',
    title: 'Steam It: the clothes pressed, everything else kept (SAM 3.1 clothing mask + Qwen-Image 2.1 inpaint)',
    capability: 'edit',
    handBuilt: 'hand-built/steam-it-qwen-image-21.json',
    bindings: { prompt: [b('23', 'prompt')], image: [b('10', 'image')], seed: [b('27', 'seed')], steps: [b('27', 'steps')] },
    outputs: [{ node: '90', kind: 'image' }],
    vramGb: 20,
    license:
      'Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms); AusBoss nodes MIT',
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    notes:
      'The Steam It app\'s graph: qwen-image-21-inpaint with the mask found instead of painted. SAM3_Detect with the word "clothing" (threshold 0.4, 2 refine passes, every garment in one mask; works on a worn outfit ' +
      'and on a flat-lay or a hanger) -> GrowMask 16 px on the full picture, so a hem or a sleeve can settle past its old outline and the paste-back follows the same mask -> Crop For Inpaint (context 1.3, ' +
      'blend 8 px, multiple 32, 2 MP, bicubic) -> TextEncodeQwenImage21 with the crop as image 1 (resolution 0) and the app\'s instruction as the prompt -> VAEEncode of the crop + SetLatentNoiseMask -> ' +
      'QwenImage21Cache -> KSampler 25 steps, cfg 1, euler, simple -> SplitImageWithAlpha -> Stitch Inpaint (classic, no colour match): every pixel outside the grown mask and its 8 px blend is the upload\'s own. ' +
      'No clothing found: the empty mask selects the whole picture and the stitch gives it back unchanged. The prompt names only the finished state (smooth, pressed fabric) and what stays the same. ' +
      'RTX 5090: about 75 s a photo at 2048x1536 (25 steps), peak 26.5 GB.',
  },
  // Outfit Swap: AusBoss's Outfit Swap LoRA keeps the person picture in place (0.1 px against 3.6 px without it, on its card).
  {
    id: 'outfit-swap-qwen-image-21',
    title: 'Qwen-Image 2.1 Outfit Swap (outfit photo; Outfit Swap LoRA, Qwen3-VL describes the outfit)',
    capability: 'edit',
    handBuilt: 'hand-built/outfit-swap-qwen-image-21.json',
    bindings: {
      prompt: [b('53', 'values.d')], request: [b('53', 'values.c')], image: [b('10', 'image')], image2: [b('11', 'image')],
      seed: [b('32', 'seed')], steps: [b('32', 'steps')], loraStrength: [b('4', 'strength_model')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1 and the Outfit Swap LoRA by AusBoss, a derivative): NON-COMMERCIAL, research and evaluation only',
    notes:
      'AusBoss\'s "Qwen Image 2.1 Outfit Swap" workflow (the LoRA card\'s workflows/qwen-image-2.1-outfit-swap.json), its two subgraphs flattened onto core nodes: ' +
      'the Outfit Swap LoRA (step 1,000, the card\'s main file) at 1 on the int8 model, the person to about 2 MP and the outfit to about 1 MP on the 32 grid (ImageScaleToTotalPixels, lanczos, ' +
      'for the pack\'s Image Resize in megapixels mode), TextEncodeQwenImage21 with the person as image 1 and the outfit as image 2 (resolution 0, no negative), QwenImage21Cache, KSampler 25 steps, cfg 1, euler, simple, ' +
      'SplitImageWithAlpha. The words: Qwen3-VL (the same text encoder, TextGenerate, thinking on) answers two yes/no checks on the person picture (feet, legs) and describes the outfit in one phrase, ' +
      'leaving out shoes when the feet are not in the picture and everything below the waist when the legs are not; StringFormat writes "Dress the person in image 1 in <phrase>. Keep their face, hair, hands, pose and the background exactly the same. <request> <prompt>". ' +
      'request = "Replace everything they wear." (the card\'s default: clears the old outfit) or "Keep their own shoes and legwear."; prompt = the person\'s own words, added at the end. ' +
      'Changed from the card: the no-feet phrase ends "shown in image 2" (the card adds "without the shoes"; Fuobe\'s requests name only what is wanted). ' +
      'Removed: the outfit picture\'s crop node (Fuobe sends the photo as it is), the typed/described switch (outfit-swap-qwen-image-21-text is the words route), the turbo LoRA row (off on the card), compare, timer, notes. Output follows the person picture at about 2 MP. RTX 5090: about 80 s a photo at 25 steps, peak about 29.5 GB.',
  },
  {
    id: 'outfit-swap-qwen-image-21-text',
    title: 'Qwen-Image 2.1 Outfit Swap (outfit in words; Outfit Swap LoRA)',
    capability: 'edit',
    handBuilt: 'hand-built/outfit-swap-qwen-image-21-text.json',
    bindings: {
      prompt: [b('53', 'values.b')], request: [b('53', 'values.c')], image: [b('10', 'image')],
      seed: [b('32', 'seed')], steps: [b('32', 'steps')], loraStrength: [b('4', 'strength_model')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    vramGb: 20,
    license: 'Qwen Research License Agreement (Qwen-Image 2.1 and the Outfit Swap LoRA by AusBoss, a derivative): NON-COMMERCIAL, research and evaluation only',
    notes:
      'Outfit Swap with no outfit photo (Fuobe runs it when the request has one picture): outfit-swap-qwen-image-21 without image 2 and the describer. ' +
      'prompt = the outfit in words ("a black velvet tuxedo with satin lapels"), set into "Dress the person in image 1 in <prompt>. Keep their face, hair, hands, pose and the background exactly the same. <request>". ' +
      'The LoRA was trained with an outfit picture as image 2: with one picture, loraStrength 1 and 0 (the plain 25-step edit) both dress the person as asked and keep the picture in place. RTX 5090: about 65 s a photo.',
  },
  // ---- Owner's SOTA image families: Ideogram 4 -------------------------------------------
  {
    id: 'ideogram4-t2i',
    title: 'Ideogram 4 text to image (int8, dual-model guidance, the Quality / Default / Turbo preset table)',
    capability: 't2i',
    handBuilt: 'hand-built/ideogram4-t2i.json',
    bindings: {
      prompt: [b('98:24', 'text')], width: [b('98:27', 'value')], height: [b('98:28', 'value')], seed: [b('98:18', 'noise_seed')],
      preset: [b('98:156', 'choice')],
    },
    outputs: [{ node: '158', kind: 'image' }],
    defaults: { preset: 'Quality' },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'Ideogram Non-Commercial Model Agreement: NON-COMMERCIAL (research and personal use; commercial use needs a paid Ideogram licence)',
    notes:
      'The Ideogram 4 int8 text-to-image workflow, exported through the ComfyUI frontend (subgraph 98 flattened, its LLM caption-template subgraph and preview pruned); it made the site\'s Ideogram 4 preview stills. ' +
      'Kept as saved: the conditional UNET with CFGOverride (cfg 3 for the last 30% of steps) into DualModelGuider cfg 7, whose negative pass is the unconditional UNET on the zeroed prompt; ' +
      'qwen3vl_8b_fp8_scaled loaded as type ideogram4; flux2-vae; EmptyFlux2LatentImage; euler; SamplerCustomAdvanced; width and height rounded up to 16 (at least 256) by its math nodes. ' +
      'The preset table feeds Ideogram4Scheduler (Quality 48 steps / mu 0 / std 1.5, Default 20 / 0 / 1.75, Turbo 12 / 0.5 / 1.75); the graph runs Quality, the recipe of the preview stills with people (those without ran Default, as the original workflow does). ' +
      'No negative prompt: the guidance is asymmetric with a text-free unconditional pass. The prompt is an Ideogram 4 JSON caption (the app writes one from plain words); ' +
      'plain sentences often come back as the grey "blocked by safety filter" card. The Realism Engine LoRA graph is not used.',
  },
  // ---- Owner's SOTA image families: Krea 2 (2026-10-31). Every graph runs Krea 2 Turbo (krea2_turbo_fp8_scaled, as the owner's edit
  // workflow does), Qwen3-VL 4B (CLIPLoader type krea2) and the Qwen-Image VAE; Krea's in-graph "Refine prompt" TextGenerate is left out
  // (Fuobe's Enhance does it).
  {
    id: 'krea2-realism-t2i',
    title: 'Krea 2 Realism: Krea 2 Turbo + the Realism V2 LoRA, 6 steps',
    capability: 't2i',
    handBuilt: 'hand-built/krea2-realism-t2i.json',
    bindings: {
      prompt: [b('6', 'text')], width: [b('5', 'width')], height: [b('5', 'height')], seed: [b('3', 'seed')], steps: [b('3', 'steps')],
      loraStrength: [b('15', 'strength_model')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license: 'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it); Krea2-realism-V2 LoRA MIT',
    notes:
      'The official Krea 2 Turbo text-to-image graph with LoraLoaderModelOnly Krea2-realism-V2 at 1.0 after the UNET, run as the LoRA\'s author recommends: ' +
      'euler / simple, 6 steps (4-8), cfg 1 with ConditioningZeroOut, about 2 MP (1 MP gets noisy), detailed natural-language prose. Removed: the style-LoRA and Refine-prompt switches, ' +
      'the ResolutionSelector (explicit width/height, multiple of 16).',
  },
  {
    id: 'krea2-turbo-t2i',
    title: 'Krea 2 Turbo Text to Image (8 steps)',
    capability: 't2i',
    handBuilt: 'hand-built/krea2-turbo-t2i.json',
    bindings: { prompt: [b('6', 'text')], width: [b('5', 'width')], height: [b('5', 'height')], seed: [b('3', 'seed')], steps: [b('3', 'steps')] },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license: 'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it)',
    notes:
      'The official Krea 2 Turbo text-to-image graph: euler / simple, 8 steps, cfg 1 with ConditioningZeroOut, 1024x1024 by default. Removed: the style-LoRA and Refine-prompt switches ' +
      '(your own LoRAs attach after the UNET as on every graph), the ResolutionSelector (explicit width/height, multiple of 16).',
  },
  {
    id: 'krea2-edit-general',
    title: 'Krea 2 Edit: Krea 2 Turbo + the General Edit V2 LoRA, instruction edits with an optional second photo',
    capability: 'edit',
    handBuilt: 'hand-built/krea2-edit-general.json',
    bindings: {
      prompt: [b('84', 'prompt')], image: [b('72', 'image')], image2: [b('90', 'image')], width: [b('82', 'width')], height: [b('82', 'height')],
      seed: [b('53', 'seed')], steps: [b('53', 'steps')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license:
      'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it); the Krea 2 General Edit V2 LoRA is NON-COMMERCIAL (commercial use needs a licence from its author)',
    notes:
      'The comfyui-krea2edit pack\'s "Krea2 Image Edit" graph with the pack\'s V2 LoRA krea2_general_edit_v2 at 1.0 → Krea2EditModelPatch (the photo VAE-encoded as source_latent, ' +
      'the pixel path vae + source_image, target_latent = the KSampler\'s latent, fit_mode fit, ref_boost 4, ref_boost_a 1, both references aligned) → Krea2EditGroundedEncode with the instruction ' +
      '(grounding_px 768) as the positive and an empty one on the same photo as the negative; EmptySD3LatentImage; KSampler 8 steps (the V2 card; the v1.2 graph used 10), cfg 1, euler, simple. ' +
      'image2 is the person for "put this person in the scene" (a group the pack\'s graph ships bypassed): its loader goes when no second photo is given. The output follows image 1 ("auto") or the shape asked for; ' +
      '1 MP is the sweet spot. Removals need the Raw model at cfg 3 (pack README): Turbo at cfg 1 tends to re-render the subject.',
  },
  {
    id: 'krea2-edit-identity',
    title: 'Krea 2 Identity Edit: Krea 2 Turbo + the Identity Edit V2 LoRA, a person restaged from one photo',
    capability: 'edit',
    handBuilt: 'hand-built/krea2-edit-identity.json',
    bindings: {
      prompt: [b('84', 'prompt')], image: [b('72', 'image')], image2: [b('90', 'image')], width: [b('82', 'width')], height: [b('82', 'height')],
      seed: [b('53', 'seed')], steps: [b('53', 'steps')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license:
      'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it); the Krea 2 Identity Edit V2 LoRA is NON-COMMERCIAL (commercial use needs a licence from its author)',
    notes:
      'krea2-edit-general\'s graph (the pack\'s "Krea2 Image Edit") with krea2_identity_edit_v2 at 1.0, ref_boost 2 and the person aligned (trained): a new place, pose or outfit, the same face. ' +
      'For a distinctive face, end the instruction with "Preserve the exact facial identity - distinguishing features: ..." (pack notes). image2 = a second person or the person to put in the scene, ' +
      'dropped when not given. 8 steps, cfg 1, euler, simple.',
  },
  {
    id: 'krea2-turbo-i2i',
    title: 'Krea 2 Turbo image to image (your picture redrawn at the strength you pick)',
    capability: 'edit',
    handBuilt: 'hand-built/krea2-turbo-i2i.json',
    bindings: {
      image: [b('1', 'image')], megapixels: [b('2', 'megapixels')], prompt: [b('6', 'text')], seed: [b('3', 'seed')], steps: [b('3', 'steps')],
      strength: [b('3', 'denoise')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 20,
    license: 'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it)',
    notes:
      'Image to image on Krea 2 Turbo, built like z-image-turbo-i2i: the picture scaled to about 2 MP on the 16-pixel grid, ' +
      'VAE-encoded, then Krea 2 Turbo\'s sampler (8 steps, cfg 1, euler, simple) at denoise = strength (0.6). The result keeps the picture\'s shape.',
  },
  {
    id: 'krea2-inpaint',
    title: 'Krea 2 Inpaint: the masked area painted by the Krea 2 inpaint-edit LoRA (Ostris edit nodes)',
    capability: 'inpaint',
    handBuilt: 'hand-built/krea2-inpaint.json',
    bindings: { prompt: [b('20', 'prompt')], image: [b('1', 'image')], mask: [b('2', 'image')], seed: [b('23', 'seed')], steps: [b('23', 'steps')] },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    packs: ['ComfyUI-Krea2-Ostris-Edit'],
    vramGb: 20,
    license: 'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it); the inpaint-edit LoRA by Cierpliwy under the same licence; ComfyUI-Krea2-Ostris-Edit MIT',
    notes:
      'The edit stage of Cierpliwy\'s krea2-inpaint-workflows examples: Krea 2 Turbo → LoRA krea2_inpaint_edit at 1.0 (the v1 512 file; ' +
      'the model card now recommends krea2_inpaint_edit_v2_17500) → Krea2OstrisEditModelPatch with kv_cache on (the card: needed for correct masked editing); TextEncodeKrea2OstrisEdit (clip, vae, image1 = ' +
      'the photo with the masked area black) as the positive, ConditioningZeroOut as the negative; EmptyLatentImage at the reference\'s size; KSampler 8 steps, cfg 1, euler_ancestral, simple. ' +
      'mask = separate PNG, red channel, white = paint here (the flux1-fill-inpaint convention). The reference is scaled to about 1 MP on the 16-pixel grid (the add-on\'s limit until ostris PR #10); ' +
      'the whole picture is redrawn, nothing is pasted back. Needs the ComfyUI-Krea2-Ostris-Edit nodes.',
  },
  {
    id: 'krea2-outpaint',
    title: 'Krea 2 Expand: the canvas grown on black and filled by the Krea 2 inpaint-edit LoRA (Ostris edit nodes)',
    capability: 'outpaint',
    handBuilt: 'hand-built/krea2-outpaint.json',
    bindings: {
      prompt: [b('20', 'prompt')], image: [b('1', 'image')], padLeft: [b('8', 'left')], padTop: [b('8', 'top')], padRight: [b('8', 'right')], padBottom: [b('8', 'bottom')],
      seed: [b('23', 'seed')], steps: [b('23', 'steps')],
    },
    outputs: [{ node: '29', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, padMultiple: 8 },
    packs: ['ComfyUI-Krea2-Ostris-Edit'],
    vramGb: 20,
    license: 'Krea 2 Community License (free under US$1M yearly revenue; enterprise terms above it); the inpaint-edit LoRA by Cierpliwy under the same licence; ComfyUI-Krea2-Ostris-Edit MIT',
    notes:
      'krea2-inpaint\'s edit stage on a bigger canvas, as in the add-on\'s outpaint_example: the photo on black grown by padLeft/padTop/padRight/padBottom px (ImagePadForOutpaint with feathering 0, ' +
      'then black over its mask: a hard edge like the example\'s SolidMask canvas), scaled to about 1 MP, then the same LoRA, patch (kv_cache on) and 8 euler_ancestral steps. Default pads 256 px a side ' +
      '(the example grows a 512 px picture by a quarter of its side on each). The prompt describes the whole scene. The v1 512 LoRA was trained without outpainting masks (v2 adds them, model card). ' +
      'Needs the ComfyUI-Krea2-Ostris-Edit nodes.',
  },
  // ---- Owner's SOTA image families: FIBO 2 (Bria FIBO 2.0 Dev and Edit Turbo, core nodes) ------------------------
  {
    id: 'fibo2-dev-t2i',
    title: 'FIBO 2 Dev text to image (Qwen3.5 writes the structured VGL prompt)',
    capability: 't2i',
    handBuilt: 'hand-built/fibo2-dev-t2i.json',
    bindings: {
      prompt: [b('112', 'prompt')], negativePrompt: [b('94', 'text')], width: [b('102', 'width')], height: [b('102', 'height')],
      seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg')],
    },
    outputs: [{ node: '56', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'CC-BY-NC-4.0 (Bria FIBO 2.0 weights: NON-COMMERCIAL; commercial use needs a Bria agreement)',
    notes:
      'The FIBO 2 Dev text-to-image VGL workflow: core TextGenerate on Qwen3.5 9B int8 (CLIPLoader type stable_diffusion, 2048 tokens, sampling off) turns the words ' +
      'into Bria\'s VGL JSON with an art-director system prompt, and CLIP Text Encode (fibo2, Qwen3-VL 4B int8) encodes it; empty negative, 30 steps, cfg 5, euler / simple. ' +
      'The ResolutionSelector is replaced by an explicit width x height (FIBO 2 is trained at about 1 MP, multiple of 16); the prompt preview and the notes are removed.',
  },
  {
    id: 'fibo2-dev-edit',
    title: 'FIBO 2 Dev image edit, up to 4 references',
    capability: 'edit',
    handBuilt: 'hand-built/fibo2-dev-edit.json',
    bindings: {
      prompt: [b('112', 'prompt')], negativePrompt: [b('112', 'negative_prompt')],
      image: [b('113', 'image')], image2: [b('116', 'image')], image3: [b('117', 'image')], image4: [b('118', 'image')],
      seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg')],
    },
    outputs: [{ node: '56', kind: 'image' }],
    vramGb: 16,
    license: 'CC-BY-NC-4.0 (Bria FIBO 2.0 weights: NON-COMMERCIAL; commercial use needs a Bria agreement)',
    notes:
      'The FIBO 2 Dev multi-image edit workflow: image 1 scaled to 1 MP and to a multiple of 16 (bicubic), the other references straight into TextEncodeFibo2 ' +
      '(images.image_2..4: the original graph wires two, 3 and 4 are wired the same way). The encoder gives the conditioning and the latent at the trained size of image 1\'s shape ' +
      '(width = height = 0); empty negative (the null caption FIBO 2 was trained with), 30 steps, cfg 5, euler / simple. One picture is scaled and centre-cropped to the result (the edit ' +
      'lines up with it pixel for pixel); several are each scaled to their own trained size. References not given are left out of the encoder. The instruction names the pictures ' +
      '<image_1>, <image_2>... The VGL edit graphs (a 9.75 GB prompt writer on every edit) are not used.',
  },
  {
    id: 'fibo2-edit-turbo-edit',
    title: 'FIBO 2 Edit Turbo image edit (4 steps), up to 4 references',
    capability: 'edit',
    handBuilt: 'hand-built/fibo2-edit-turbo-edit.json',
    bindings: {
      prompt: [b('112', 'prompt')], image: [b('113', 'image')], image2: [b('116', 'image')], image3: [b('117', 'image')], image4: [b('118', 'image')],
      seed: [b('3', 'seed')], steps: [b('3', 'steps')],
    },
    outputs: [{ node: '56', kind: 'image' }],
    vramGb: 16,
    license: 'CC-BY-NC-4.0 (Bria FIBO 2.0 weights: NON-COMMERCIAL; commercial use needs a Bria agreement)',
    notes:
      'The FIBO 2 Edit Turbo multi-image edit workflow: fibo2-dev-edit on the Edit Turbo weights, 4 steps, cfg 1 (no negative pass), euler / simple; ' +
      'references 3 and 4 wired like reference 2, and left out when not given. Edits only: the turbo weights aren\'t used for text to image.',
  },

  // ---- Fuobe DoP (Originals O4): LTX-2.3 camera moves, FPV and transitions with LoRAs ------------
  {
    id: 'ltx23-i2v-lora',
    title: 'LTX-2.3 22B distilled image to video + LoRAs (Fuobe DoP · LTX)',
    capability: 'i2v',
    handBuilt: 'hand-built/ltx23-i2v-lora.json',
    bindings: {
      prompt: [b('128', 'text')], negativePrompt: [b('112', 'text')], image: [b('31', 'image')],
      width: [b('113', 'value')], height: [b('98', 'value')], frames: [b('130', 'value')], fps: [b('114', 'value')], seed: [b('100', 'noise_seed')],
    },
    outputs: [{ node: '68', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 257, dimensionMultiple: 32, frameStep: 8 },
    vramGb: 32,
    license: 'LTX-2 Community License (LTX-2.3 22B: free under US$10M annual revenue); Gemma 3 text encoder (Gemma Terms of Use)',
    notes:
      'From the official video_ltx2_3_flf2v template (LTX-2.3 22B distilled fp8, one pass of 8 manual sigmas, cfg 1, Euler ancestral) without the end-frame guide: the start frame is a ' +
      'first-frame guide at strength 1 (the template uses 0.7 for both ends), resized and centre-cropped to width x height. A motion\'s LoRAs (FPV, Wind to Face, the transition LoRA) are ' +
      'injected after the CheckpointLoaderSimple (LoraLoaderModelOnly). Silent like a DoP clip: the audio latent rides through the audio-video sampler but is not decoded. frames = seconds*fps+1 (8n+1), 24 fps.',
  },
  {
    id: 'ltx23-flf2v-lora',
    title: 'LTX-2.3 22B distilled start and end frame to video + LoRAs (Fuobe DoP · LTX transitions)',
    capability: 'flf2v',
    handBuilt: 'hand-built/ltx23-flf2v-lora.json',
    bindings: {
      prompt: [b('128', 'text')], negativePrompt: [b('112', 'text')], image: [b('31', 'image')], endImage: [b('39', 'image')],
      width: [b('113', 'value')], height: [b('98', 'value')], frames: [b('130', 'value')], fps: [b('114', 'value')], seed: [b('100', 'noise_seed')],
    },
    outputs: [{ node: '68', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 257, dimensionMultiple: 32, frameStep: 8 },
    vramGb: 32,
    license: 'LTX-2 Community License (LTX-2.3 22B: free under US$10M annual revenue); Gemma 3 text encoder (Gemma Terms of Use)',
    notes:
      'The official video_ltx2_3_flf2v template (LTX-2.3 22B distilled fp8, first- and last-frame guides at strength 0.7, 8 manual sigmas, cfg 1) with plain size, frame and fps values ' +
      'and the joyfox LTX-2.3 Transition LoRA (or any LTX-2.3 LoRA) injected after the CheckpointLoaderSimple. Both frames are resized and centre-cropped to width x height. Silent (the audio is not decoded).',
  },
  {
    id: 'ltx23-t2v-lora',
    title: 'LTX-2.3 22B distilled text to video + LoRAs',
    capability: 't2v',
    handBuilt: 'hand-built/ltx23-t2v-lora.json',
    bindings: {
      prompt: [b('128', 'text')], negativePrompt: [b('112', 'text')],
      width: [b('113', 'value')], height: [b('98', 'value')], frames: [b('130', 'value')], fps: [b('114', 'value')], seed: [b('100', 'noise_seed')],
    },
    outputs: [{ node: '68', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, maxFrames: 257, dimensionMultiple: 32, frameStep: 8 },
    vramGb: 32,
    license: 'LTX-2 Community License (LTX-2.3 22B: free under US$10M annual revenue); Gemma 3 text encoder (Gemma Terms of Use)',
    notes:
      'ltx23-i2v-lora without the start frame: the empty latent takes width x height directly. LoRAs injected after the CheckpointLoaderSimple. Silent (the audio is not decoded). ' +
      'Suits LTX camera LoRAs when there is no start frame.',
  },

  // ---- Restore & colourise (package archive-restore): Lightricks' Restore IC-LoRA, tiled latent fusion --------------
  {
    id: 'video-restore-ltx25-tiled',
    title: 'Restore & colourise archive footage: LTX-2.5 22B distilled + the Restore IC-LoRA, tiled latent fusion, one 97-frame window with the 17-frame prefix hand-off (stage 2: the Detail Refine IC-LoRA) (ComfyUI-LTXVideo pack)',
    capability: 'restore-video',
    handBuilt: 'hand-built/video-restore-ltx25-tiled.json',
    packs: ['ComfyUI-LTXVideo'],
    modelUrls: {
      // The LTX-2.5 files ltx25-i2v / ltx25-t2v load (their template's links), and the Restore IC-LoRA at the researched commit.
      'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors': 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors',
      'ltx-2.5-video-vae-bf16.safetensors': 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/vae/ltx-2.5-video-vae-bf16.safetensors',
      'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors': 'https://huggingface.co/Lightricks/LTX-2.5/resolve/main/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors',
      'ltx-2.5-22b-ic-lora-restore-1.0.safetensors': 'https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Restore/resolve/79245e197a6cd3251e77d178dc380b0e9f2d6563/ltx-2.5-22b-ic-lora-restore-1.0.safetensors',
    },
    optionalModels: ['ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors'],
    bindings: {
      video: [b('source', 'video')], video2: [b('prefix_source', 'video')], image: [b('reference', 'image')],
      prompt: [b('positive', 'text')], negativePrompt: [b('negative', 'text')], seed: [b('sample', 'seed')], cfg: [b('sample', 'cfg')],
      fps: [b('conditioning', 'frame_rate'), b('video', 'fps')],
      windowStart: [b('source', 'skip_first_frames')], windowFrames: [b('source', 'frame_load_cap'), b('empty', 'length')],
      canvasWidth: [b('canvas', 'width'), b('empty', 'width'), b('reference_fit', 'width')],
      canvasHeight: [b('canvas', 'height'), b('empty', 'height'), b('reference_fit', 'height')],
      fieldWidth: [b('field', 'width')], fieldHeight: [b('field', 'height')],
      prefixFrom: [b('prefix_source', 'skip_first_frames')], prefixFrames: [b('keep', 'batch_index')],
      lora: [b('lora', 'lora_name')], loraStrength: [b('lora', 'strength_model')],
      tileWidth: [b('sample', 'tile_width')], tileHeight: [b('sample', 'tile_height')],
      streaming: [b('guide', 'use_streaming')], tileFrames: [b('sample', 'tile_frames')],
      filenamePrefix: [b('save', 'filename_prefix')],
    },
    outputs: [{ node: 'save', kind: 'video' }],
    defaults: {
      lora: 'ltx-2.5-22b-ic-lora-restore-1.0.safetensors', windowStart: 0, windowFrames: 97, prefixFrames: 0, prefixFrom: 80, canvasWidth: 1440, canvasHeight: 1088,
      fieldWidth: 640, fieldHeight: 240, tileWidth: 960, tileHeight: 544, streaming: false, tileFrames: 0,
    },
    limits: { maxWidth: 3840, maxHeight: 3840, maxFrames: 481, dimensionMultiple: 32, frameStep: 8 },
    vramGb: 24,
    license:
      'LTX-2.x Community License (LTX-2.5 22B distilled, its video VAE, and Lightricks\' Restore and Detail Refine IC-LoRAs, both gated on Hugging Face: free under US$10M annual revenue); ' +
      'Gemma 4 text encoder packaged by Lightricks; ComfyUI-LTXVideo nodes under the LTX-2 Community License (its LICENSE file)',
    notes:
      'Built from the Restore IC-LoRA card\'s recipe (Hugging Face Lightricks/LTX-2.5-22b-IC-LoRA-Restore at 79245e1, read as data) and the node definitions of ComfyUI-LTXVideo at 220e1d4 ' +
      '(its LTX-2.5_V2V_TiledFusion_Upscale example wires the same nodes): the window (windowStart, windowFrames: 8n+1, at most 97) read at the clip\'s own rate, lanczos to the canvas ' +
      '(canvasWidth x canvasHeight: 1440x1088 for 4:3, 1920x1088 for 16:9), the frame-aligned IC-LoRA guide at downscale 1, LTXVTiledFusionSampler with 960x544 tiles at 50% overlap ' +
      'and the 8 distilled sigmas (euler, cfg 1), tiled decode, silent H.264 (the pipeline puts the sound back after the join). ' +
      'video2 = the window before\'s saved frames; its last 17 (prefixFrom) go in as LTXVAddGuide at frame 0, and prefixFrames (17) drops them from this window\'s output; absent on the ' +
      'first window (the provider removes that branch). image = an optional reference picture at frame_idx -1 (a second IC-LoRA guide; removed without one). deinterlace keeps one field ' +
      '(fieldWidth x fieldHeight, nearest rows: no blending; ComfyUI has no fieldmatch/yadif/decimate node), removed when off. Stage 2 (Restore to 4K): the same graph on the restored clip ' +
      'with the Detail Refine IC-LoRA, a 2x canvas and 1024x576 tiles. A single generation of a whole clip past 97 frames streams: streaming on the guide and tileFrames 97 on the sampler ' +
      '(the card\'s other long-clip path; no reference picture there). Needs the ComfyUI-LTXVideo pack.',
  },

  // ---- Shorts Studio / Mixed Media: trim, segment, restyle ------------------------
  {
    id: 'video-trim',
    title: 'Trim a clip by seconds (core Trim Video, keeps fps and audio)',
    capability: 'trim',
    handBuilt: 'hand-built/video-trim.json',
    bindings: { video: [b('1', 'file')], startTime: [b('2', 'start_time')], duration: [b('2', 'duration')] },
    outputs: [{ node: '3', kind: 'video' }],
    vramGb: 0,
    license: 'n/a (no model)',
    notes:
      'startTime = params.startTime, duration = params.endTime - params.startTime (0 = to the end). Keeps the source fps, size and audio. ' +
      'Shorts Studio segmenting: one job per <=5 s window. Runs on CPU (verified end to end through Fuobe).',
  },
  {
    id: 'video-segment-resample',
    title: 'Cut a segment at a target fps and size, plus its first frame (VHS loader)',
    capability: 'trim',
    handBuilt: 'hand-built/video-segment-resample.json',
    bindings: {
      video: [b('1', 'video')], fps: [b('1', 'force_rate'), b('3', 'fps')], startFrame: [b('1', 'skip_first_frames')], frames: [b('1', 'frame_load_cap')],
      width: [b('2', 'width')], height: [b('2', 'height')],
    },
    outputs: [{ node: '4', kind: 'video' }, { node: '7', kind: 'image', role: 'first-frame' }],
    limits: { maxWidth: 1920, maxHeight: 1920, dimensionMultiple: 16, maxFrames: 241, frameStep: 4 },
    vramGb: 0,
    license: 'n/a (no model)',
    notes:
      'VHS_LoadVideo resamples to fps (force_rate) first, then skips startFrame frames (= params.startTime * fps) and keeps frames (= (endTime - startTime) * fps, 4n+1 for Wan); ImageScale crops to width x height (aspect ratio + resolution). ' +
      '81 frames @16 fps = 5.06 s, the Wan 2.2 window. Second output = the segment\'s first frame (restyle it, then video-restyle-wan22-fun-vace). Also the Mixed Media frame sampler (fps 4-24). Runs on CPU.',
  },
  {
    id: 'video-restyle-wan22-fun-vace',
    title: 'Restyle a <=5 s segment: Wan 2.2 Fun VACE with depth control + a restyled first frame',
    capability: 'v2v',
    handBuilt: 'hand-built/video-restyle-wan22-fun-vace.json',
    bindings: {
      video: [b('1', 'file')], image: [b('4', 'image')], prompt: [b('12', 'text')], negativePrompt: [b('13', 'text')],
      width: [b('3', 'width'), b('5', 'width'), b('9', 'width'), b('34', 'width'), b('35', 'width'), b('15', 'width')],
      height: [b('3', 'height'), b('5', 'height'), b('9', 'height'), b('34', 'height'), b('35', 'height'), b('15', 'height')],
      frames: [b('30', 'value')], fps: [b('26', 'fps')], seed: [b('22', 'noise_seed'), b('23', 'noise_seed')], steps: [b('22', 'steps'), b('23', 'steps')],
      cfg: [b('22', 'cfg'), b('23', 'cfg')], shift: [b('20', 'shift'), b('21', 'shift')], controlStrength: [b('15', 'strength')],
    },
    outputs: [{ node: '27', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxFrames: 81, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.2 Fun VACE, lightx2v, Depth Anything 3 mono-large)',
    notes:
      'Shorts Studio chain: video-segment-resample (<=81 frames @16 fps + first frame) -> qwen-image-edit-2511 restyles the first frame with the preset prompt -> this graph -> video-concat-N. ' +
      'Control: frame 0 = the restyled frame (image, kept), frames 1..N-1 = Depth Anything 3 depth maps (generated); the restyled frame is also the VACE reference. Lightx2v 4 steps. frames must be 4n+1 and <= the segment length.',
  },
  {
    id: 'video-evolution-wan22-fun-vace',
    title: 'Evolve a <=5 s segment: Wan 2.2 Fun VACE from the noised segment, depth control + a direction frame',
    capability: 'v2v',
    handBuilt: 'hand-built/video-evolution-wan22-fun-vace.json',
    bindings: {
      video: [b('1', 'video')], image: [b('4', 'image')], prompt: [b('12', 'text')], negativePrompt: [b('13', 'text')],
      width: [b('3', 'width'), b('5', 'width'), b('9', 'width'), b('15', 'width')],
      height: [b('3', 'height'), b('5', 'height'), b('9', 'height'), b('15', 'height')],
      frames: [b('30', 'value')], fps: [b('1', 'force_rate'), b('26', 'fps')], seed: [b('22', 'noise_seed'), b('23', 'noise_seed')], steps: [b('46', 'value')],
      cfg: [b('22', 'cfg'), b('23', 'cfg')], shift: [b('50', 'value')], controlStrength: [b('15', 'strength')],
      denoise: [b('45', 'value')],
    },
    outputs: [{ node: '27', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxFrames: 81, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.2 Fun VACE, lightx2v, Depth Anything 3 mono-large)',
    notes:
      'Fuobe\'s Evolution on the GPU: video-segment-resample (<=81 frames @16 fps + first frame) -> qwen-image-edit-2511 takes the first frame toward the creative direction (images 2-3 = references) -> this graph -> video-concat-N -> the clip\'s sound. ' +
      'Any clip loads: VHS_LoadVideo resamples it to fps (16), keeps at most `frames` frames and cuts them to 4n+1 (Wan format), and every length in the graph is the loaded count, so a short or 30 fps clip is neither a shape error nor slow motion (Edit video sends whole clips). ' +
      'Unlike video-restyle-wan22-fun-vace the sampler starts from the segment itself: reference latent + VAE-encoded frames (LatentConcat on t, the shape WanVaceToVideo makes), noised to denoise = the noise level it starts from (flow matching: (1 - denoise) x clip + denoise x noise; low 0.45, medium 0.65, high 0.85). ' +
      'The simple scheduler with shift s reaches sigma = denoise N - steps steps into a schedule of N = round(steps x (s - (s - 1) x denoise) / denoise) steps, and the last `steps` run (Lightx2v 4-step), so the run starts within a few hundredths of any denoise from 0.02 to 1 (KSampler\'s floor(steps / denoise) could only make 1, 0.8, 0.67, 0.57 or 0.5 with 4 steps). ' +
      'Wan 2.2\'s high-noise expert takes only the steps at or above its switch point (sigma 0.875; ComfySwitchNode gives the first sampler the low-noise expert when the run starts below it, as all three intensities do). ' +
      'Control: Depth Anything 3 depth on every frame (no kept frame, no masks); the direction frame is the VACE reference. Same weights as the restyle graph.',
  },
  {
    // Blockout to film (package blockout-film): the open engine's render of a grey-box blockout.
    id: 'video-blockout-wan22-fun-vace',
    title: 'Blockout to film: Wan 2.2 Fun VACE driven by the blockout\'s own depth + a first frame drawn from the references',
    capability: 'v2v',
    handBuilt: 'hand-built/video-blockout-wan22-fun-vace.json',
    bindings: {
      video: [b('1', 'file')], image: [b('4', 'image')], prompt: [b('12', 'text')], negativePrompt: [b('13', 'text')],
      width: [b('3', 'width'), b('5', 'width'), b('34', 'width'), b('35', 'width'), b('15', 'width')],
      height: [b('3', 'height'), b('5', 'height'), b('34', 'height'), b('35', 'height'), b('15', 'height')],
      frames: [b('30', 'value')], fps: [b('26', 'fps')], seed: [b('22', 'noise_seed'), b('23', 'noise_seed')], steps: [b('22', 'steps'), b('23', 'steps')],
      cfg: [b('22', 'cfg'), b('23', 'cfg')], shift: [b('20', 'shift'), b('21', 'shift')], controlStrength: [b('15', 'strength')],
      invertDepth: [b('41', 'value')],
    },
    outputs: [{ node: '27', kind: 'video' }],
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxFrames: 81, frameStep: 4 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.2 Fun VACE, lightx2v)',
    notes:
      'Cinema\'s Blockout on your GPU: the browser renders the grey box and its depth (near = bright, as Depth Anything draws it) at 16 fps; video-segment-resample cuts the depth into 81-frame windows that overlap by one frame; ' +
      'qwen-image-edit-2511 draws the first frame from the grey box\'s first frame and up to two references; each window runs this graph with the first frame (window 1) or the last frame of the window before (frame-extract), then video-concat-encoded joins them. ' +
      'The same graph as video-restyle-wan22-fun-vace without Depth Anything 3: control frame 0 = the first frame (kept), frames 1..N-1 = the depth video, near = bright (invertDepth: true runs it through ImageInvert first, for a near = dark pass such as Blender\'s mist; ComfySwitchNode picks); the first frame is also the VACE reference. Lightx2v 4 steps. Silent (no audio input): sound comes afterwards (Sound for video). ' +
      'A blockout uploaded without a depth pass runs video-restyle-wan22-fun-vace instead (Depth Anything 3 on the grey box).',
  },
  {
    id: 'mixed-media-zimage-frames',
    title: 'Mixed Media: per-frame stylisation at 4-24 fps (Z-Image Turbo img2img + Fun Union ControlNet canny)',
    capability: 'v2v',
    handBuilt: 'hand-built/mixed-media-zimage-frames.json',
    bindings: {
      video: [b('1', 'video')], fps: [b('1', 'force_rate'), b('22', 'frame_rate')], frames: [b('1', 'frame_load_cap')], startFrame: [b('1', 'skip_first_frames')],
      width: [b('3', 'width')], height: [b('3', 'height')], prompt: [b('16', 'text')], seed: [b('20', 'seed')], steps: [b('20', 'steps')],
      denoise: [b('20', 'denoise')], controlStrength: [b('14', 'strength')], framesPerBatch: [b('2', 'frames_per_batch')],
    },
    outputs: [{ node: '22', kind: 'video' }],
    limits: { maxWidth: 1536, maxHeight: 1536, dimensionMultiple: 16, maxFrames: 240, frameStep: 1 },
    vramGb: 16,
    license: 'Apache-2.0 (Z-Image Turbo, Z-Image-Turbo-Fun-Controlnet-Union)',
    notes:
      'Higgsfield Mixed Media: frames sampled at 4/8/10/12/24 fps (force_rate), each frame restyled with the preset prompt, re-assembled at the same fps with the source audio. ' +
      'VHS_BatchManager re-queues the prompt every framesPerBatch frames so VRAM stays flat: the provider follows the re-queued prompts (same filename prefix) and collects the final video. ' +
      'Fixed batch noise = less flicker. denoise 0.55-0.8 trades fidelity for style; canny keeps outlines.',
  },

  // ---- Sound effects ------------------------------------------------------------
  {
    id: 'sfx-stable-audio-3-small',
    title: 'Sound effects: Stable Audio 3.0 Small SFX (native, 8 steps)',
    capability: 'sfx',
    handBuilt: 'hand-built/sfx-stable-audio-3-small.json',
    bindings: {
      prompt: [b('52:31', 'value')], negativePrompt: [b('52:7', 'text')], duration: [b('52:36', 'value')], seed: [b('52:3', 'seed')], steps: [b('52:3', 'steps')],
      cfg: [b('52:3', 'cfg')], checkpoint: [b('52:25', 'ckpt_name')],
    },
    outputs: [{ node: '57', kind: 'audio' }],
    defaults: { checkpoint: 'stable_audio_3_small_sfx.safetensors' },
    vramGb: 6,
    license: 'Stability AI Community License (free below US$1M annual revenue)',
    notes:
      'Template audio_stable_audio_3_medium with the Qwen3.5 prompt-expansion branch removed and the checkpoint switched to small_sfx (Fuobe enhances prompts itself). Distilled: lcm, 8 steps, cfg 1. ' +
      'checkpoint can be stable_audio_3_medium.safetensors (9.2 GB, music + SFX, longer) with the same graph. Stereo, duration in seconds (2-20 s for SFX).',
  },
  {
    id: 'sfx-stable-audio-open',
    title: 'Sound effects: Stable Audio Open 1.0 (native, up to 47 s)',
    capability: 'sfx',
    handBuilt: 'hand-built/sfx-stable-audio-open.json',
    bindings: {
      prompt: [b('6', 'text')], negativePrompt: [b('7', 'text')], duration: [b('11', 'seconds')], seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg')],
    },
    outputs: [{ node: '20', kind: 'audio' }],
    vramGb: 6,
    license: 'Stability AI Community License (free below US$1M annual revenue; enterprise licence above)',
    notes: 'Template audio_stable_audio_example; SaveAudioAdvanced switched from flac to mp3 V0. 44.1 kHz stereo, max 47.6 s. dpmpp_3m_sde_gpu / exponential, 50 steps, cfg ~5.',
  },
  {
    id: 'sfx-hunyuan-foley',
    title: 'Sound effects: HunyuanVideo-Foley XL, text to audio (territory-restricted licence)',
    capability: 'sfx',
    handBuilt: 'hand-built/sfx-hunyuan-foley.json',
    bindings: {
      prompt: [b('3', 'prompt')], negativePrompt: [b('3', 'negative_prompt')], duration: [b('3', 'duration')], seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg_scale')],
    },
    outputs: [{ node: '4', kind: 'audio' }],
    vramGb: 12,
    license: 'Tencent Hunyuan Community License (territory EXCLUDES the EU, UK and South Korea)',
    autoDownloads: ['HunyuanDependenciesLoader fetches the SigLIP2 and CLAP text encoders into the Hugging Face cache on first run'],
    notes: 'HunyuanFoleySampler.image is optional, so the same graph is text-to-audio (connect frames for video-synced foley). 48 kHz. Needs loguru (install-comfyui.sh).',
  },
  {
    id: 'sfx-mmaudio-t2a',
    title: 'Sound effects: MMAudio large 44k v2, text only (non-commercial weights)',
    capability: 'sfx',
    handBuilt: 'hand-built/sfx-mmaudio-t2a.json',
    bindings: {
      prompt: [b('3', 'prompt')], negativePrompt: [b('3', 'negative_prompt')], duration: [b('3', 'duration')], seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg')],
    },
    outputs: [{ node: '4', kind: 'audio' }],
    vramGb: 8,
    license: 'CC-BY-NC-4.0 (MMAudio weights: NON-COMMERCIAL)',
    notes: 'Same files as v2a-mmaudio (no new download). MMAudioSampler.images is optional: without it MMAudio runs text-to-audio. Trained on 8 s clips (longer durations degrade).',
  },
  {
    id: 'sfx-thinksound',
    title: 'Sound effects: ThinkSound light, text to audio with a sound description (isolated worker)',
    capability: 'sfx',
    handBuilt: 'hand-built/sfx-thinksound.json',
    bindings: {
      prompt: [b('3', 'caption')], description: [b('3', 'cot_description')], duration: [b('3', 'duration')], seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg_scale')],
    },
    outputs: [{ node: '4', kind: 'audio' }],
    vramGb: 12,
    worker: 'isolated',
    license: 'Apache-2.0 (ThinkSound weights, FunAudioLLM); wrapper code has no LICENSE file',
    autoDownloads: ['ThinkSoundFeatureUtilsLoader fetches google/t5-v1_1-xl and facebook/metaclip-h14 into the Hugging Face cache on first run'],
    notes:
      'The only permissive SFX model found. prompt = short caption, description = the chain-of-thought sound description ThinkSound was trained with (the provider uses the prompt when none is given). Max 30 s. ' +
      'ISOLATED WORKER: the wrapper is stale and its requirements pin old versions that would downgrade the shared venv; run it on a separate ComfyUI (scripts/comfy/README.md).',
  },

  // ---- Dubbing / transcription / captions ---------------------------------------
  {
    id: 'dub-prepare-separate-transcribe',
    title: 'Separate voice and background (MelBand RoFormer) and transcribe the voice with timestamps (Qwen3-ASR 1.7B)',
    capability: 'separate-audio',
    handBuilt: 'hand-built/dub-prepare-separate-transcribe.json',
    bindings: {
      audio: [b('1', 'audio')], sourceLanguage: [b('7', 'language')], asrModel: [b('7', 'model')], hints: [b('7', 'hints')], maxChars: [b('7', 'max_chars')],
    },
    outputs: [
      { node: '5', kind: 'audio', stem: 'voice' },
      { node: '6', kind: 'audio', stem: 'background' },
      { node: '8', kind: 'text', role: 'cues' },
      { node: '9', kind: 'text', role: 'transcript' },
      { node: '10', kind: 'text', role: 'language' },
    ],
    defaults: { sourceLanguage: 'auto', asrModel: 'Qwen/Qwen3-ASR-1.7B-hf' },
    vramGb: 8,
    license: 'MelBand RoFormer weights MIT (KimberleyJSN); Qwen3-ASR / ForcedAligner Apache-2.0; ComfyUI-QwenASR code GPL-3.0 (same as ComfyUI)',
    autoDownloads: [
      'AILab_Qwen3ASRSubtitle downloads Qwen/Qwen3-ASR-1.7B-hf (4.08 GB; 0.6B: 1.56 GB) and Qwen/Qwen3-ForcedAligner-0.6B-hf (1.84 GB) into models/Qwen3-ASR on first run',
    ],
    notes:
      'Dubbing step 1. Changed from the original graph: LoadAudio replaces LoadVideo + GetVideoComponents (LoadAudio decodes the soundtrack of a video upload too, without decoding frames), so it takes audio or video. ' +
      'Outputs in order: voice stem, background stem (music + effects), cue lines ("start-end: text", seconds), plain transcript, detected language (PreviewAny, folded into the text outputs\' meta). ' +
      'ASR runs on the separated vocals. 52 languages auto-detected (30 selectable).',
  },
  // Graph B of docs/research/dbs-separation-7.md §4.4 (DBS D3): the open dub's first step with DBS in place of MelBand
  // RoFormer, so the background keeps the score and the sound effects (a vocals model takes singing with the voice).
  // Same output contract as dub-prepare-separate-transcribe; node 7 is that graph's Qwen3-ASR node with its bindings.
  {
    id: 'dub-prepare-dbs-transcribe',
    title: 'Separate the dialogue from the music and effects (DBS) and transcribe it with timestamps (Qwen3-ASR 1.7B)',
    capability: 'separate-audio',
    handBuilt: 'hand-built/dub-prepare-dbs-transcribe.json',
    packs: ['ComfyUI-DBS'],
    // Both DBS models, as in separate-soundtrack-dbs: a CUDA host runs DBS-TIGER unless asked otherwise.
    requiredModels: ['DBS-BSRNN-DnR/model.safetensors', 'DBS-BSRNN-DnR/config.json', 'DBS-TIGER-DnR/model.safetensors', 'DBS-TIGER-DnR/config.json'],
    bindings: {
      audio: [b('1', 'audio')], separationModel: [b('2', 'model')],
      sourceLanguage: [b('7', 'language')], asrModel: [b('7', 'model')], hints: [b('7', 'hints')], maxChars: [b('7', 'max_chars')],
    },
    outputs: [
      { node: '5', kind: 'audio', stem: 'voice' },
      { node: '6', kind: 'audio', stem: 'background' },
      { node: '8', kind: 'text', role: 'cues' },
      { node: '9', kind: 'text', role: 'transcript' },
      { node: '10', kind: 'text', role: 'language' },
    ],
    defaults: { separationModel: 'DBS-BSRNN-DnR', sourceLanguage: 'auto', asrModel: 'Qwen/Qwen3-ASR-1.7B-hf' },
    vramGb: 8,
    license: 'DBS weights Apache-2.0 (trained on DnR v2, CC BY 4.0); Qwen3-ASR / ForcedAligner Apache-2.0; ComfyUI-QwenASR GPL-3.0; ComfyUI-DBS MIT',
    autoDownloads: [
      'AILab_Qwen3ASRSubtitle downloads Qwen/Qwen3-ASR-1.7B-hf (4.08 GB; 0.6B: 1.56 GB) and Qwen/Qwen3-ForcedAligner-0.6B-hf (1.84 GB) into models/Qwen3-ASR on first run',
    ],
    notes:
      'Dubbing step 1 with DBS: the voice split runs on a CPU (23 MB of weights) and the background keeps the music and the sound effects, singing included. ' +
      'Qwen3-ASR still needs the 8 GB listing on a GPU. audio = an audio file or a video (LoadAudio reads a video\'s soundtrack without decoding frames). ' +
      'DBSLoader model DBS-BSRNN-DnR (fast, the CPU default) or DBS-TIGER-DnR (best, the CUDA default); DBSSeparate in mono at the input\'s rate. ' +
      'Outputs in order: voice stem (speech), background stem = the original minus the speech (AudioMerge subtract: it keeps the stereo image), cue lines ("start-end: text", seconds), plain transcript, ' +
      'detected language (PreviewAny, folded into the text outputs\' meta). Both stems are FLAC, so voice + background add up to the source. ' +
      'The provider splits a file with more than 2 channels with its background from music + effects (node 4 rewired to AudioMerge add): ComfyUI saves mono or stereo only. ASR runs on the separated speech.',
  },
  // DBS soundtrack separation (docs/research/dbs-separation-7.md §4.4, graph A): the one graph behind Split soundtrack (and
  // Remove dialogue, Clean up dialogue, "Original sound" later). ComfyUI-DBS is not on the validation server: checked
  // statically there (core nodes) and validated + run on an isolated worker with the pack and the weights.
  {
    id: 'separate-soundtrack-dbs',
    title: 'Split a soundtrack into dialogue, music and effects (DBS, ComfyUI-DBS)',
    capability: 'separate-audio',
    handBuilt: 'hand-built/separate-soundtrack-dbs.json',
    packs: ['ComfyUI-DBS'],
    // Both models are required (23 MB together): a CUDA host runs DBS-TIGER unless asked otherwise, so the Workflows page's
    // install commands fetch it and its presence check names it when it's missing.
    requiredModels: ['DBS-BSRNN-DnR/model.safetensors', 'DBS-BSRNN-DnR/config.json', 'DBS-TIGER-DnR/model.safetensors', 'DBS-TIGER-DnR/config.json'],
    bindings: { audio: [b('1', 'audio')], separationModel: [b('2', 'model')], channels: [b('3', 'channels')] },
    outputs: [
      { node: '5', kind: 'audio', stem: 'voice' },
      { node: '6', kind: 'audio', stem: 'music' },
      { node: '7', kind: 'audio', stem: 'effects' },
      { node: '8', kind: 'audio', stem: 'background' },
      { node: '9', kind: 'text', role: 'report' },
    ],
    defaults: { separationModel: 'DBS-BSRNN-DnR', channels: 'mono' },
    vramGb: 0,
    license: 'DBS weights Apache-2.0 (JusperLee; trained on DnR v2, CC BY 4.0); ComfyUI-DBS code MIT; vendored DBS code Apache-2.0 with MIT notices (BS-RoFormer, MSST, TIGER)',
    notes:
      'CPU OK, about 1.7 GiB on CUDA. audio = an audio file or a video (LoadAudio reads a video\'s soundtrack without decoding frames). ' +
      'DBSLoader model DBS-BSRNN-DnR (fast: 18.9 MB, 9.07 dB SI-SDR on DnR v2, the CPU default) or DBS-TIGER-DnR (best: 4.1 MB, 10.13 dB, about 3x slower on a CPU, the CUDA default); device auto. ' +
      'Measured on a 4-CPU host (torch 2.14.1+cpu, 10-20 s clips): DBS-BSRNN 0.17-0.33x real time per channel, DBS-TIGER 0.08-0.09x. ' +
      'DBSSeparate channels mono (the mean of the channels, the official usage) or each channel (stereo stems: every channel separated on its own, 2x the time); output_sample_rate input. ' +
      'ComfyUI saves audio as mono or stereo only (a 5.1 waveform comes out as scrambled stereo three times as long), so the provider splits a file with more than 2 channels in mono ' +
      'and makes its background from music + effects (node 4 rewired to AudioMerge add) rather than the original minus the speech. ' +
      'Outputs in order: voice (speech), music, effects (sfx), background = original minus speech (AudioMerge subtract: with mono it keeps the original stereo image at mono cost; ' +
      'AudioMerge scales the whole result down when it peaks over 1.0), and the pack\'s JSON report (model, device, rates, windows, seconds, times real time). ' +
      'Voice + background add up to the source, except on a loud master where AudioMerge had to lower the background to fit under full scale (FLAC holds no more). ' +
      'Voice is first, so a chain without a stem takes the dialogue. Trained on synthetic English mixes (DnR v2): dialogue separates well (15-16 dB), music against effects less so (5.7-7.8 dB). ' +
      'Some FSD50K and FMA clips inside DnR v2 carry their own CC licences, NC variants included; whether that reaches the weights or their outputs is unresolved (recorded as information).',
  },
  // DBS graph C (docs/research/dbs-separation-7.md §4.4): one remix of the split at set levels, for a server-side mix (Clean up
  // dialogue: the dialogue with the music and effects under it, or alone). Same pack and weights as graph A.
  {
    id: 'soundtrack-remix-dbs',
    title: 'Remix a soundtrack: dialogue, music and effects at set levels (DBS, ComfyUI-DBS)',
    capability: 'separate-audio',
    handBuilt: 'hand-built/soundtrack-remix-dbs.json',
    packs: ['ComfyUI-DBS'],
    requiredModels: ['DBS-BSRNN-DnR/model.safetensors', 'DBS-BSRNN-DnR/config.json', 'DBS-TIGER-DnR/model.safetensors', 'DBS-TIGER-DnR/config.json'],
    bindings: {
      audio: [b('1', 'audio')],
      separationModel: [b('2', 'model')],
      channels: [b('3', 'channels')],
      voiceDb: [b('4', 'volume')],
      musicDb: [b('5', 'volume')],
      effectsDb: [b('6', 'volume')],
    },
    outputs: [
      { node: '9', kind: 'audio', stem: 'voice' },
      { node: '10', kind: 'text', role: 'report' },
    ],
    defaults: { separationModel: 'DBS-BSRNN-DnR', channels: 'mono', voiceDb: 0, musicDb: -18, effectsDb: -18 },
    vramGb: 0,
    license: 'DBS weights Apache-2.0 (JusperLee; trained on DnR v2, CC BY 4.0); ComfyUI-DBS code MIT; vendored DBS code Apache-2.0 with MIT notices (BS-RoFormer, MSST, TIGER)',
    notes:
      'CPU OK, about 1.7 GiB on CUDA. Graph A\'s split (LoadAudio reads a video\'s soundtrack too), then AudioAdjustVolume on the speech (voiceDb), music (musicDb) and sfx (effectsDb) stems ' +
      '(whole dB, -100..100; -100 leaves a stem at 1e-5, below 16-bit FLAC\'s floor) and AudioMerge add twice, saved as one FLAC with the input\'s length, starting at 0, so it goes back on a picture with video-mux-audio-replace. ' +
      'AudioMerge scales the whole mix down when it peaks over 1.0 (a crude limiter). channels mono gives a mono mix; each channel keeps stereo at twice the time. ' +
      'A source with more than 2 channels is split in mono (ComfyUI saves mono or stereo only). The output is tagged as the voice stem (the cleaned dialogue), so a chain takes it. ' +
      'DBS removes music and sound effects, not steady noise: hiss and hum stay with the dialogue or the effects (unmeasured, §11).',
  },
  // Clean up voice (NVIDIA NemotronLabs RE-USE, universal speech enhancement): Fuobe's own ComfyUI-RE-USE pack (no mamba-ssm).
  // Not on the validation server: checked statically there (core nodes) and run through the pack's own tests.
  {
    id: 'voice-clean-reuse',
    title: 'Clean up voice: noise, echo, clipping and codec damage removed from speech (NVIDIA RE-USE, ComfyUI-RE-USE)',
    capability: 'enhance-voice',
    handBuilt: 'hand-built/voice-clean-reuse.json',
    packs: ['ComfyUI-RE-USE'],
    optionalModels: ['NemotronLabs-RE-USE-laughter.safetensors'],
    bindings: { audio: [b('1', 'audio')], reuseModel: [b('2', 'model')], rate: [b('3', 'rate')], channels: [b('3', 'channels')], roomToneDb: [b('3', 'room_tone_db')], level: [b('3', 'level')] },
    outputs: [
      { node: '4', kind: 'audio', stem: 'voice' },
      { node: '5', kind: 'text', role: 'report' },
    ],
    defaults: { reuseModel: 'NemotronLabs-RE-USE.safetensors', rate: 'source', channels: 'mono', roomToneDb: -60, level: 'match input' },
    vramGb: 0,
    license: "RE-USE weights OpenMDW-1.1 (NVIDIA; 'ready for commercial use' on the card; the card's safety section points to the NVIDIA Open Model License for use-case limits); ComfyUI-RE-USE code MIT with adapted RE-USE code OpenMDW-1.1",
    notes:
      'CPU OK; about 1 GB VRAM with chunking. audio = an audio file or a video (LoadAudio reads a video\'s soundtrack without decoding frames). ' +
      'REUSELoader model NemotronLabs-RE-USE (voice only) or NemotronLabs-RE-USE-laughter (keeps laughs and breaths a little more), 39 MB each; device auto. ' +
      'REUSEEnhance rate: the model\'s STFT scales with the rate (a 40 ms window at any rate), so work grows about linearly with it; above the source rate it fills the empty high band (bandwidth extension). ' +
      'Chunks from the free memory (2-20 s on CUDA, 5-10 s on a CPU) joined with 1 s raised-cosine crossfades; Cancel works between chunks. ' +
      'room_tone_db mixes the original back under the clean voice (Strength: Full -60 = off, Natural -24, Light -14); level match input brings the speech level back (the model is about 3 dB quieter), peak at most -1 dBFS. ' +
      'Measured under a busy RTX 5090 (worst cases): 0.26 s of work per second of audio at 16 kHz, 1.4 at 48 kHz with Triton (about 6x slower without); i9 CPU with numba: 4 at 16 kHz, 15 at 48 kHz. ' +
      'It keeps the main speaker and removes everything else (other voices, music, effects): voice-clean-bed-reuse keeps the music and effects. ' +
      'The Mamba layer is a plain-PyTorch rewrite (no mamba-ssm): it matches the reference maths numerically, but it is not NVIDIA\'s code path.',
  },
  {
    id: 'voice-clean-bed-reuse',
    title: 'Clean the dialogue of a soundtrack and keep its music and effects (DBS + NVIDIA RE-USE)',
    capability: 'enhance-voice',
    handBuilt: 'hand-built/voice-clean-bed-reuse.json',
    packs: ['ComfyUI-RE-USE', 'ComfyUI-DBS'],
    requiredModels: ['DBS-BSRNN-DnR/model.safetensors', 'DBS-BSRNN-DnR/config.json', 'DBS-TIGER-DnR/model.safetensors', 'DBS-TIGER-DnR/config.json'],
    optionalModels: ['NemotronLabs-RE-USE-laughter.safetensors'],
    bindings: {
      audio: [b('1', 'audio')],
      reuseModel: [b('2', 'model')],
      separationModel: [b('3', 'model')],
      channels: [b('4', 'channels'), b('6', 'channels')],
      rate: [b('6', 'rate')],
      roomToneDb: [b('6', 'room_tone_db')],
      level: [b('6', 'level')],
      bedDb: [b('6', 'bed_db')],
    },
    outputs: [
      { node: '7', kind: 'audio', stem: 'voice' },
      { node: '8', kind: 'text', role: 'report' },
    ],
    defaults: { reuseModel: 'NemotronLabs-RE-USE.safetensors', separationModel: 'DBS-BSRNN-DnR', rate: 'source', channels: 'mono', roomToneDb: -24, level: 'match input', bedDb: 0 },
    vramGb: 0,
    license: "RE-USE weights OpenMDW-1.1 (NVIDIA; 'ready for commercial use' on the card; the card's safety section points to the NVIDIA Open Model License for use-case limits); ComfyUI-RE-USE code MIT with adapted RE-USE code OpenMDW-1.1; DBS weights Apache-2.0 (JusperLee; trained on DnR v2, CC BY 4.0); ComfyUI-DBS code MIT; vendored DBS code Apache-2.0 with MIT notices (BS-RoFormer, MSST, TIGER)",
    notes:
      'CPU OK. The video soundtrack variant of voice-clean-reuse (the provider runs it for params.extra.background "keep"): DBS splits the soundtrack (graph A\'s nodes), ' +
      'RE-USE cleans only the dialogue, and REUSEEnhance mixes the original music & effects (the original minus the speech, AudioMerge subtract) back under it at bed_db, at the higher of the two rates, peak at most -1 dBFS. ' +
      'A source with more than 2 channels runs in mono with music + effects as the bed (node 5 rewired, as graph A). The result has the input\'s length, starting at 0, so it goes back on the picture with video-mux-audio-replace. ' +
      'DBS was trained on English mixes; the dialogue split is its strong part (15-16 dB).',
  },
  {
    id: 'captions-qwen3-asr',
    title: 'Transcribe speech into timed caption cues (Qwen3-ASR 0.6B + ForcedAligner)',
    capability: 'transcribe',
    handBuilt: 'hand-built/captions-qwen3-asr.json',
    bindings: {
      audio: [b('1', 'audio')], sourceLanguage: [b('3', 'language')], asrModel: [b('3', 'model')], maxChars: [b('3', 'max_chars')], hints: [b('3', 'hints')],
    },
    outputs: [{ node: '4', kind: 'text', role: 'cues' }, { node: '5', kind: 'text', role: 'language' }],
    defaults: { sourceLanguage: 'auto', asrModel: 'Qwen/Qwen3-ASR-0.6B-hf' },
    vramGb: 4,
    license: 'Qwen3-ASR / ForcedAligner Apache-2.0; ComfyUI-QwenASR code GPL-3.0',
    autoDownloads: ['AILab_Qwen3ASRSubtitle downloads Qwen/Qwen3-ASR-0.6B-hf (1.56 GB) and Qwen/Qwen3-ForcedAligner-0.6B-hf (1.84 GB) into models/Qwen3-ASR on first run'],
    notes:
      'Default caption source for Faceless / Shorts. Changed from the original graph: LoadAudio instead of LoadVideo + GetVideoComponents (audio or video input). ' +
      'maxChars 32 + split_by_punctuation_or_pause_or_length gives short vertical-video lines. The text output is one "start-end: text" line per cue, which Fuobe reads as the captions. ' +
      'output_format none: the node writes no file of its own (concurrent jobs would race on one captions.srt); SaveText returns the cues. ' +
      'Burn the cues in with captions-burnin (chain: transcript text -> prompt).',
  },
  {
    id: 'captions-burnin',
    title: 'Burn captions into a video (core Draw Text Overlay, chunk by chunk)',
    capability: 'captions',
    handBuilt: 'hand-built/captions-burnin.json',
    bindings: {
      video: [b('1', 'file'), b('3', 'audio')], fontSize: [b('12', 'font_size')], fontColor: [b('12', 'color')], captionPosition: [b('12', 'position')],
    },
    outputs: [{ node: '92', kind: 'video' }],
    defaults: { fontColor: '#ffffff', captionPosition: 'bottom' },
    expand: 'captions',
    vramGb: 0,
    license: 'no model (ComfyUI core TextOverlay, GPL-3.0 like ComfyUI; Pillow\'s bundled Aileron font, OFL)',
    notes:
      'Fuobe\'s open caption burn-in, all inside ComfyUI with core nodes. Fuobe rewrites the graph for each request: the cues (prompt lines "start-end: text" or SRT, e.g. from captions-qwen3-asr) ' +
      'cut the clip into Trim Video windows. Gaps go straight to Concatenate Video (never decoded). A cue window is cut into chunks of at most ~384 MB of frames (about 0.5 s of 1080x1920 at 30 fps, 5 s at 360p); ' +
      'each chunk is decoded (GetVideoComponents), gets a TextOverlay in the style of node 12 (fontSize = % of the frame height, fontColor, captionPosition top | bottom, outlined) and is encoded at once (CreateVideo codec h264), ' +
      'so ComfyUI only needs one chunk of raw frames at a time and can evict finished chunks under memory pressure. Concatenate Video joins chunks and gaps in order and lays the clip\'s own soundtrack (LoadAudio, node 3) ' +
      'under the result; for a silent clip node 3 is dropped. The provider reads the upload\'s MP4 header for duration, fps, size and audio: window edges sit between frames, cues past the end are dropped and the rest of the clip after the last cue stays uncaptioned. ' +
      'Windows hold at least 3 frames (Concatenate Video rejects a 2-frame clip followed by another): a shorter pause between cues gets no gap, a shorter caption is held for 3 frames. ' +
      'Measured on a CPU-only ComfyUI under RAM pressure (--cache-ram 11): a 20 s 640x360 30 fps clip with 18 s of captions peaks at +0.50 GB RSS and a 40 s one at +0.45 GB (decoding the whole clip in one batch takes +5.16 GB for the 20 s clip); ' +
      'without pressure ComfyUI\'s RAM cache keeps finished chunks (+2.64 GB for 20 s) until memory runs low. Runs on CPU (verified end to end through Fuobe).',
  },
  {
    id: 'captions-whisper-burnin',
    title: 'Captions in one job: Whisper large-v3-turbo word timestamps burned into the frames (non-commercial code)',
    capability: 'captions',
    handBuilt: 'hand-built/captions-whisper-burnin.json',
    bindings: {
      video: [b('1', 'video')], sourceLanguage: [b('3', 'language')], whisperModel: [b('3', 'model')], fontSize: [b('4', 'font_size')], fontColor: [b('4', 'font_color')],
    },
    outputs: [{ node: '5', kind: 'video' }, { node: '7', kind: 'text', role: 'transcript' }],
    defaults: { sourceLanguage: 'auto', whisperModel: 'large-v3-turbo', fontColor: 'white' },
    vramGb: 6,
    license: 'Whisper weights MIT (OpenAI); ComfyUI-Whisper code CC-BY-NC-SA-4.0 (NON-COMMERCIAL: the author asks to be contacted for commercial use)',
    autoDownloads: ['Apply Whisper downloads large-v3-turbo.pt (1.62 GB) into models/stt/whisper on first run'],
    notes:
      'All-ComfyUI alternative that transcribes and burns in one job (word-by-word captions from words_alignment). One style per run (font, size, colour, border, centred). ' +
      'The default open route is captions-qwen3-asr + captions-burnin (chosen because of this NC code licence, which is now information: Settings → Models & licences); install-comfyui.sh installs ComfyUI-Whisper unless NC_PACKS=0. Save SRT (not an output node) is dropped; the transcript text is kept. ' +
      'VHS_LoadVideo decodes the whole clip and Add Subtitles To Frames copies it (about 2.5 copies of the frames in RAM): the provider refuses clips that would need more than half of the ComfyUI server\'s RAM and points to the chunked route. ' +
      'sourceLanguage takes Whisper\'s own names (the provider maps ISO codes: tl/fil -> Tagalog, he -> Hebrew).',
  },
  {
    id: 'translate-qwen35-textgen',
    title: 'Translate text or timed caption lines with Qwen3.5 4B (core TextGenerate)',
    capability: 'translate',
    handBuilt: 'hand-built/translate-qwen35-textgen.json',
    bindings: {
      instruction: [b('2', 'string_a')], prompt: [b('2', 'string_b')], seed: [b('3', 'sampling_mode.seed')], maxTokens: [b('3', 'max_length')],
    },
    outputs: [{ node: '4', kind: 'text' }],
    defaults: {
      instruction:
        'Translate the text below into {language}. If it has "start-end:" timestamps, keep every line and keep the timestamps exactly as they are, translate only the text after the colon and keep it about as long as the original so it can be spoken in the same time. Output only the translation.\n\n',
    },
    vramGb: 10,
    license: 'Apache-2.0 (Qwen3.5)',
    notes:
      'Dubbing step 2 fully inside ComfyUI (Fuobe\'s LLM provider is the default; this keeps an all-open route). prompt = the text (e.g. the cue lines of dub-prepare-separate-transcribe), ' +
      'instruction = defaults.instruction with {language} = params.targetLanguage. Temperature 0.3 for faithful output. Changed from the original graph: the text binding is named prompt.',
  },
  {
    id: 'speech-translate-gemma4',
    title: 'Speech to translated text in one step: Gemma 4 E4B audio input (core TextGenerate)',
    capability: 'translate',
    handBuilt: 'hand-built/speech-translate-gemma4.json',
    bindings: { audio: [b('5', 'audio')], instruction: [b('1', 'prompt')], seed: [b('1', 'sampling_mode.seed')], maxTokens: [b('1', 'max_length')] },
    outputs: [{ node: '8', kind: 'text' }],
    defaults: { instruction: 'Transcribe the speech in this audio, then translate it into {language}. Output only the {language} translation.' },
    vramGb: 12,
    license: 'Apache-2.0 (Gemma 4)',
    notes:
      'Gemma 4 E2B/E4B take audio natively. No timestamps: use it for voice-over style dubs (whole-script TTS) or as a cross-check; use dub-prepare-separate-transcribe when the dub must follow cue timings. ' +
      'Keep clips under a few minutes (context). Changed from the original graph: the prompt binding is named instruction ({language} = params.targetLanguage).',
  },
  {
    id: 'lipsync-v2v-infinitetalk',
    title: 'Lip re-sync real footage to a new voice: InfiniteTalk video-to-video (WanVideoWrapper)',
    capability: 'lipsync',
    handBuilt: 'hand-built/lipsync-v2v-infinitetalk.json',
    bindings: {
      video: [b('228', 'video')], audio: [b('125', 'audio')], prompt: [b('241', 'positive_prompt')], negativePrompt: [b('241', 'negative_prompt')],
      width: [b('245', 'value')], height: [b('246', 'value')], frames: [b('270', 'value'), b('228', 'frame_load_cap')], seed: [b('128', 'seed')], steps: [b('128', 'steps')],
      startStep: [b('128', 'start_step')], audioScale: [b('194', 'audio_scale')],
    },
    outputs: [{ node: '131', kind: 'video' }],
    defaults: { fps: 25 },
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxFrames: 1000 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.1, InfiniteTalk, lightx2v)',
    autoDownloads: ['DownloadAndLoadWav2VecModel fetches TencentGameMate/chinese-wav2vec2-base (0.38 GB) on first run'],
    notes:
      'Same model files as infinitetalk-wanwrapper (no new download). The source frames are VAE-encoded and only the last steps are re-denoised (steps 4, startStep 2), so camera, background and body stay; ' +
      'mouth, head and upper body follow the new audio. 81-frame windows until the audio ends. Changed from the original graph: VHS_LoadVideo gets only custom_width (height 0 keeps the source\'s proportions, no squashing) ' +
      'and ImageResizeKJv2 crops to width x height, which the provider takes from the source\'s own shape (aspect ratio "auto", read from the MP4 header) at the chosen resolution; ' +
      'frames (num_frames and VHS frame_load_cap) = the voice\'s length at 25 fps, at most 1000 (40 s): the provider refuses a longer voice instead of cutting it. Pass the clean dubbed voice, then mux the background with video-mux-audio.',
  },
  {
    id: 'lipsync-latentsync16',
    title: 'Lip re-sync, mouth only: LatentSync 1.6 (isolated worker)',
    capability: 'lipsync',
    handBuilt: 'hand-built/lipsync-latentsync16.json',
    bindings: {
      video: [b('1', 'video')], audio: [b('2', 'audio')], lengthMode: [b('3', 'mode')], seed: [b('4', 'seed')], lipsExpression: [b('4', 'lips_expression')], steps: [b('4', 'inference_steps')],
    },
    outputs: [{ node: '5', kind: 'video' }],
    defaults: { lengthMode: 'loop_to_audio' },
    vramGb: 20,
    worker: 'isolated',
    license: 'LatentSync 1.6 weights CreativeML OpenRAIL++-M (commercial use with use-based restrictions); wrapper code has no LICENSE file',
    autoDownloads: ['LatentSyncNode snapshot_downloads ByteDance/LatentSync-1.6 (latentsync_unet.pt 5.07 GB, whisper/tiny.pt 0.08 GB), stabilityai/sd-vae-ft-mse (0.33 GB) and the s3fd face detector (0.09 GB) on first run'],
    notes:
      'Re-renders only the mouth (512x512 face crop): identity, background and camera are untouched. VideoLengthAdjuster: normal (pad audio, trim video), pingpong / loop_to_audio (extend the picture when the dub is longer). 25 fps; needs a visible, mostly frontal face. ' +
      'ISOLATED WORKER: at import the wrapper overrides TMPDIR and folder_paths temp handling for the whole process, rmtree()s a temp folder next to ComfyUI and pip-installs packages at node init, so run it on a separate ComfyUI (scripts/comfy/README.md).',
  },
  {
    id: 'video-mux-audio',
    title: 'Add a soundtrack: new voice + background stem mixed onto a video (picture stream-copied)',
    capability: 'mux',
    handBuilt: 'hand-built/video-mux-audio.json',
    bindings: {
      video: [b('1', 'file')], audio: [b('3', 'audio')], audio2: [b('4', 'audio')], backgroundVolumeDb: [b('5', 'volume')], duration: [b('9', 'duration')],
    },
    outputs: [{ node: '8', kind: 'video' }],
    vramGb: 0,
    license: 'n/a (no model)',
    notes:
      'audio = the new voice (Chatterbox dub, narration), audio2 = the background stem of dub-prepare-separate-transcribe or a music bed (backgroundVolumeDb, e.g. -12 under narration). ' +
      'Both are mixed over EmptyAudio of the video\'s length (duration: the provider reads it from the MP4 header), because AudioMerge cuts audio2 to audio1\'s length. ' +
      'Concatenate Video with complete_audio copies the video stream packet by packet (no decode, no re-encode: lossless, constant memory) and encodes only the new AAC soundtrack. ' +
      'Video length is unchanged. Without audio2 the provider uses video-mux-audio-replace. Runs on CPU (verified end to end through Fuobe; +0.02 GB RAM for a 900-frame clip).',
  },
  {
    id: 'video-mux-audio-replace',
    title: 'Replace a video\'s soundtrack with one audio track',
    capability: 'mux',
    handBuilt: 'hand-built/video-mux-audio-replace.json',
    bindings: { video: [b('1', 'file')], audio: [b('3', 'audio')] },
    outputs: [{ node: '8', kind: 'video' }],
    vramGb: 0,
    license: 'n/a (no model)',
    notes:
      'LoadVideo + LoadAudio -> Concatenate Video (complete_audio) -> SaveVideo: the picture is stream-copied, only the new soundtrack is encoded. The single-track variant of video-mux-audio (voice-over, narration, music). ' +
      'A soundtrack longer than the video is cut at the video\'s end. Runs on CPU (verified end to end through Fuobe).',
  },

  // ---- Product 3D, try-on --------------------------------------------------------
  {
    id: 'image-to-3d-pixal3d',
    title: 'Image to textured 3D (Pixal3D, PBR GLB, ~250k triangles)',
    capability: 'image-to-3d',
    handBuilt: 'hand-built/image-to-3d-pixal3d.json',
    bindings: {
      image: [b('122', 'image')], seed: [b('3', 'seed'), b('12', 'seed'), b('18', 'seed'), b('23', 'seed')], textureSize: [b('288', 'value')],
    },
    outputs: [{ node: '322', kind: 'model3d' }],
    vramGb: 16,
    license:
      'MIT (Pixal3D weights by TencentARC, as the multi-view weights; TRELLIS.2 VAEs as repackaged by Comfy-Org, BiRefNet, microsoft/MoGe 2); the dino_v3_L_naf image encoder is DINOv3 ViT-L under the DINOv3 License ' +
      '(royalty-free, commercial use allowed; the app must show a "Built with DINOv3" notice)',
    notes: 'Template 3d_pixal3d_trellis2_image_to_model, Pixal3D branch (the default image-to-3D route): MoGe-2 (geometry_estimation/moge_2_vitl_normal_fp16, resolution_level 9) estimates the camera from the cut-out, MoGeGeometryToFOV (horizontal, degrees) -> Pixal3DConditioning (camera_angle_x) with the DINOv3 encoder, UNet pixal3d_int8_convrot; ImageCropToMask pad_factor 1.1 (as the node asks for Pixal3D). BiRefNet cut-out -> ImageCropToMask 1024 -> structure (12 steps) -> shape (20) -> upsample to 1536 (12) -> texture (12) -> RemeshMesh (768, sign_mode solid, fill 20, band 1, smooth 20) -> DecimateMesh (250,000 faces, midpoint) -> smooth normals -> UV unwrap -> base colour / metallic / roughness baked at textureSize, normal map 2048 and AO 1024 baked from the dense remeshed mesh onto the decimated one -> GLB (Save3DAdvanced, history ui "3d"). No turntable in the graph: after the job the Fuobe server finishes the GLB (roughness floor by material, pivot at the bottom centre, plus a smaller meshopt + WebP 2048 web GLB; the raw GLB stays the download) and renders a 96-frame 24 fps turntable on the CPU (model-viewer on SwiftShader) when Chromium and ffmpeg are available. Run end to end on an RTX 5090: 114-185 s per object, 25-35 MB raw GLB at ~250k triangles (was 8M triangles / 317 MB before the decimate step), web GLB 1.6-3.6 MB; more faithful to the photo than TRELLIS.2 (209-238 s). The origin is the camera-aligned volume centre, hence the pivot fix. Surfaces can show faint planar facets from the shape decode (no graph setting removes them).',
  },
  {
    id: 'image-to-3d-trellis2',
    title: 'Image to textured 3D (TRELLIS.2, PBR GLB, ~250k triangles; fallback to Pixal3D)',
    capability: 'image-to-3d',
    handBuilt: 'hand-built/image-to-3d-trellis2.json',
    bindings: {
      image: [b('122', 'image')], seed: [b('3', 'seed'), b('12', 'seed'), b('18', 'seed'), b('23', 'seed')], textureSize: [b('288', 'value')],
    },
    outputs: [{ node: '322', kind: 'model3d' }],
    vramGb: 16,
    license:
      'MIT (TRELLIS.2 weights, DINOv3-NAF / TRELLIS VAEs as repackaged by Comfy-Org, BiRefNet); the dino_v3_L_naf image encoder is DINOv3 ViT-L under the DINOv3 License ' +
      '(royalty-free, commercial use allowed; the app must show a "Built with DINOv3" notice)',
    notes: 'Template 3d_pixal3d_trellis2_image_to_model, TRELLIS.2 branch (the fallback image-to-3D route; Pixal3D is the default): Trellis2Conditioning with the DINOv3 encoder, UNet trellis_2_int8_convrot; ImageCropToMask pad_factor 1.0. BiRefNet cut-out -> ImageCropToMask 1024 -> structure (12 steps) -> shape (20) -> upsample to 1536 (12) -> texture (12) -> RemeshMesh (768, sign_mode solid, fill 20, band 1, smooth 20) -> DecimateMesh (250,000 faces, midpoint) -> smooth normals -> UV unwrap -> base colour / metallic / roughness baked at textureSize, normal map 2048 and AO 1024 baked from the dense remeshed mesh onto the decimated one -> GLB (Save3DAdvanced, history ui "3d"). No turntable in the graph: after the job the Fuobe server finishes the GLB (roughness floor by material, pivot at the bottom centre, plus a smaller meshopt + WebP 2048 web GLB; the raw GLB stays the download) and renders a 96-frame 24 fps turntable on the CPU (model-viewer on SwiftShader) when Chromium and ffmpeg are available. Run end to end on an RTX 5090: 209-238 s, 28-43 MB raw GLB at ~250k triangles. The 36-view RotateMesh + RenderMesh turntable (unlit, aliased, 12 fps) was removed.',
  },
  {
    id: 'image-to-3d-trellis2-multiview',
    title: 'Photos of 2-4 sides to textured 3D (Pixal3D multi-view on TRELLIS.2, PBR GLB) + a 36-view turntable video',
    capability: 'image-to-3d',
    handBuilt: 'hand-built/image-to-3d-trellis2-multiview.json',
    bindings: {
      image: [b('360', 'image')], image2: [b('361', 'image')], image3: [b('362', 'image')], image4: [b('363', 'image')],
      seed: [b('3', 'seed'), b('12', 'seed'), b('18', 'seed'), b('23', 'seed')], textureSize: [b('288', 'value')], turntableFps: [b('701', 'fps')], fovX: [b('381', 'fov_x_degrees')],
    },
    outputs: [{ node: '372', kind: 'model3d' }, { node: '702', kind: 'video', role: 'turntable' }],
    vramGb: 16,
    license:
      'MIT (Pixal3D multi-view weights by TencentARC, TRELLIS.2 VAEs as repackaged by Comfy-Org, BiRefNet, microsoft/MoGe 2); the dino_v3_L_naf image encoder is DINOv3 ViT-L under the DINOv3 License ' +
      '(royalty-free, commercial use allowed; the app must show a "Built with DINOv3" notice)',
    notes:
      'Template 3d_pixal3d_multi_views (2026-09-09) with the turnaround-sheet loader and its crops replaced by one upload per side: image = front, image2 = left, image3 = back, image4 = right ' +
      '(Pixal3DMultiViewConditioning, a fixed orbit rig 90 degrees apart, Z up: the left view is the object\'s own left, the camera at +90 degrees azimuth from the front, i.e. the photographer walks to their right; ' +
      'every side but the front is optional and the provider drops the branch of a side with no photo). ' +
      'Each side: BiRefNet cut-out -> crop to mask (1024, pad 1.1) -> the view. Then TRELLIS.2 structure (12 steps) -> shape (20) -> upsample to 1536 (12) -> texture (12) on Pixal3D multi-view ' +
      '-> decimate to 700k faces -> remesh -> UV unwrap -> baked base colour / metallic / roughness / AO / normal at textureSize -> GLB, plus a 36-view turntable (RotateMesh + RenderMesh, core) saved as MP4 at turntableFps; the Fuobe server then finishes the GLB (plus a smaller web GLB) and, when Chromium and ffmpeg are there, replaces that turntable with its CPU render. ' +
      'The views\' horizontal field of view as framed (Pixal3DMultiViewConditioning.fov) is measured on the front crop: MoGe 2 (LoadMoGeModel -> MoGeInference -> MoGeGeometryToFOV, horizontal, degrees), ' +
      'as the node\'s tooltip says for photos and as the official single-view template 3d_pixal3d_trellis2_image_to_model feeds Pixal3DConditioning; the multi-view template keeps the rig value 20, ' +
      'which suits rendered turnaround sheets but not phone photos, whose crops are usually wider. fovX (degrees, 0 = estimate, the default) fixes MoGe\'s lens instead, ' +
      'so MoGeGeometryToFOV passes it on (20 for a generated turnaround sheet). ' +
      'Weights: pixal3d_multiview_int8_convrot 5.58 GB + moge_2_vitl_normal_fp16 0.66 GB + the TRELLIS.2 VAEs, DINOv3-NAF and BiRefNet the single-view graph already uses. VRAM: about 16 GB, as the single-view graph (an estimate).',
  },
  {
    id: 'image-to-3d-hunyuan3d-21',
    title: 'Image to 3D shape: Hunyuan3D 2.1 (native, untextured GLB; territory-restricted licence)',
    capability: 'image-to-3d',
    handBuilt: 'hand-built/image-to-3d-hunyuan3d-21.json',
    bindings: { image: [b('2', 'image')], seed: [b('7', 'seed')], steps: [b('7', 'steps')], cfg: [b('7', 'cfg')], octreeResolution: [b('8', 'octree_resolution')] },
    outputs: [{ node: '10', kind: 'model3d' }],
    vramGb: 10,
    license: 'Tencent Hunyuan 3D 2.1 Community License (territory EXCLUDES the EU, UK and South Korea)',
    notes: 'Template 3d_hunyuan3d-v2.1. Shape only (no Hunyuan3D-Paint in the native nodes): clay previews or a separate texture step. Feed a background-removed image (bg-remove-birefnet).',
  },
  {
    id: 'mesh-refine-hi3d',
    title: 'Refine a 3D model\'s geometry from its photo (Hi3D 1.0, 512 / 1024 / 1536; geometry-only GLB)',
    capability: 'refine-3d',
    handBuilt: 'hand-built/mesh-refine-hi3d.json',
    packs: ['Comfyui-Hi3d-T8'],
    requiredModels: [
      'hi3d/model_index.json', 'hi3d/scheduler/scheduler_config.json', 'hi3d/vae/config.json', 'hi3d/vae/model.safetensors',
      'hi3d/transformer_512/config.json', 'hi3d/transformer_512/model.safetensors', 'hi3d/transformer_1024/config.json', 'hi3d/transformer_1024/model.safetensors',
      'dino/config.json', 'dino/model.safetensors', 'clip/config.json', 'clip/model.safetensors',
    ],
    bindings: {
      image: [b('2', 'image')], model3d: [b('5', 'mesh_file')], meshResolution: [b('6', 'resolution')], steps: [b('6', 'steps')], seed: [b('6', 'seed')],
      cpuOffload: [b('1', 'cpu_offload')],
    },
    outputs: [{ node: '7', kind: 'model3d' }],
    vramGb: 24,
    license:
      'Hi3D Open License Agreement 1.0 (Hi3D v1.0 weights and vendored code by OCEANO HK HOLDING LIMITED: commercial use permitted; above 200,000 monthly active users or USD 1,000,000 monthly revenue, ' +
      'notify the licensor and apply for a separate licence within 60 days; the app must show "Powered by Hi3D 1.0" linking to http://hi3d.ai/); T8star\'s ComfyUI nodes MIT; ' +
      'DINOv2-L Apache-2.0, CLIP ViT-L/14 MIT (OpenAI); BiRefNet MIT',
    notes:
      'Hi3D v1.0 (Sparc3D\'s refinement stage; docs/research/hi3d-refine.json) through T8star\'s Comfyui-Hi3d-T8 0.5.1: LoadImage -> core BiRefNet RemoveBackground -> InvertMask (Hi3D reads mask 1 as transparent, so the subject stays and the background goes) ' +
      '-> Hi3DRefine with the coarse GLB (Hi3DLoadMesh reads it from ComfyUI\'s input folder, where Fuobe uploads it) and Hi3DModelLoader (models/Hi3D with hi3d/, dino/, clip/; sequential CPU offload on, SDPA attention, which needs no flash-attn build) ' +
      '-> SaveGLB. Resolution 512 runs one pass (transformer_512), 1024 two and 1536 three (transformer_1024), 25 scheduler steps each. Output: geometry only (no texture, material or vertex colour), ' +
      'recentred at unit radius, not guaranteed watertight; the Fuobe server finishes it like any image-to-3D GLB (web GLB + CPU turntable). Needs Linux or Windows with an NVIDIA GPU of compute capability 8.0+ ' +
      'and CUDA 12 (official stack: CUDA 12.0-12.5, torch 2.5.0+cu124, flash-attn 2.7.4.post1, spconv-cu120 2.3.6; the pack keeps ComfyUI\'s torch and pins spconv-cu126 2.3.8, with an SDPA attention option). ' +
      'No CPU path. 1536 is validated upstream only on a 96 GB H20; the pack\'s author ran 512-1536 on a 24 GB laptop RTX 5090 with offload (vramGb is an estimate). Not yet run end to end through Fuobe. ' +
      'Weights: 7.73 GB Hi3D + 1.22 GB DINOv2-L + 1.71 GB CLIP ViT-L/14 at pinned revisions.',
  },
  {
    id: 'tryon-flux2-klein-4b',
    title: 'Virtual try-on: FLUX.2 [klein] 4B + try-on LoRA (person + top + bottom)',
    capability: 'try-on',
    handBuilt: 'hand-built/tryon-flux2-klein-4b.json',
    bindings: {
      image: [b('76', 'image')], image2: [b('81', 'image')], image3: [b('77', 'image')], prompt: [b('75:74', 'text')], seed: [b('75:73', 'noise_seed')],
      steps: [b('75:62', 'steps')], loraStrength: [b('75:400', 'strength_model')],
    },
    outputs: [{ node: '9', kind: 'image' }],
    defaults: { promptPrefix: 'TRYON' },
    vramGb: 10,
    license: 'Apache-2.0 (FLUX.2 [klein] 4B, try-on LoRA by xocialize); segformer_b2_clothes MIT; ComfyUI-RMBG code GPL-3.0',
    autoDownloads: ['ClothesSegment (ComfyUI-RMBG) downloads segformer_b2_clothes (0.11 GB) into models/RMBG/segformer_clothes on first run'],
    notes:
      'Reference order is load-bearing (LoRA card): image = person, image2 = top (or a dress / whole outfit), image3 = bottom. image2 is required; without image3 the provider bypasses the bottom\'s ReferenceLatent pair ' +
      '(one garment reference) instead of passing the top as the bottom. The LoRA was trained on clothing-agnostic inputs, ' +
      'so ClothesSegment greys the old outfit out first. Trigger word TRYON (defaults.promptPrefix: the provider puts it at the start of the prompt). Output size = the person image (~1 MP).',
  },

  // ---- Cinema Studio grid and Soul Cast -------------------------------------------
  {
    id: 'grid-zimage-contact-sheet',
    title: 'Image grid: one Z-Image Turbo contact sheet (2x2 / 3x3 / 4x4) + its tiles',
    capability: 'image-grid',
    handBuilt: 'hand-built/grid-zimage-contact-sheet.json',
    bindings: {
      gridPrompt: [b('20', 'string_a')], prompt: [b('20', 'string_b')], width: [b('23', 'width')], height: [b('23', 'height')], columns: [b('27', 'columns')], rows: [b('27', 'rows')],
      seed: [b('24', 'seed')], steps: [b('24', 'steps')],
    },
    outputs: [{ node: '26', kind: 'image', role: 'sheet' }, { node: '28', kind: 'image', role: 'tiles' }],
    defaults: {
      gridPrompt:
        'A {columns}x{rows} grid contact sheet of {count} film stills from the same scene, edge to edge with thin black gutters, consistent characters, wardrobe, lighting and colour grade in every panel, varied shot sizes and angles:',
    },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 14,
    license: 'Apache-2.0 (Z-Image Turbo)',
    notes:
      'gridPrompt defaults to a contact-sheet sentence for the chosen columns x rows ({columns}, {rows}, {count} are filled by the provider). ' +
      'Higgsfield "full grid from a single prompt": one generation, then KJNodes ImageGridtoBatch cuts the sheet into columns x rows tiles (row-major). gridPrompt is chosen by the app per size/type ' +
      '(freeform, zooms, shots); next/prev shots continue from a tile with storyboard-qwen-edit-2509-next-scene. Outputs: the sheet first, then the tiles.',
  },
  {
    id: 'soul-cast-sheet-zimage',
    title: 'Soul Cast: Z-Image Turbo character turnaround sheet (front, three-quarter, profile, back)',
    capability: 'character-sheet',
    handBuilt: 'hand-built/soul-cast-sheet-zimage.json',
    bindings: {
      sheetPrompt: [b('20', 'string_a')], prompt: [b('20', 'string_b')], width: [b('23', 'width')], height: [b('23', 'height')], columns: [b('27', 'columns')], rows: [b('27', 'rows')],
      seed: [b('24', 'seed')], steps: [b('24', 'steps')],
    },
    outputs: [{ node: '26', kind: 'image', role: 'sheet' }, { node: '28', kind: 'image', role: 'tiles' }],
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 16 },
    vramGb: 14,
    license: 'Apache-2.0 (Z-Image Turbo)',
    notes:
      'The app compiles the Soul Cast fields (genre, era, archetype, age, build, hair, outfit...) into prompt; a batch of casts = several seeds. The sheet is cut into the 4 views; ' +
      '"Save as character" turns one into an element (optionally an AI-Toolkit LoRA from the views).',
  },

  // ---- av-tools (Wave B): extract frame, video-synced foley, product shot ---------
  {
    id: 'frame-extract',
    title: 'Extract a frame: the last frame, or the frame at a time (core Trim Video + Get Image from Batch)',
    capability: 'frame',
    handBuilt: 'hand-built/frame-extract.json',
    bindings: {
      video: [b('1', 'file')], startTime: [b('2', 'start_time')], duration: [b('2', 'duration')], frameIndex: [b('4', 'batch_index')],
    },
    outputs: [{ node: '5', kind: 'image' }],
    vramGb: 0,
    license: 'n/a (no model)',
    notes:
      'Defaults give the LAST frame: Trim Video with start_time -1 (negative = from the end) and duration 0 decodes only the last second, Get Image from Batch takes index -1. ' +
      'Frame at time t: params.startTime = t, params.endTime = t + 0.5 and params.extra.frameIndex = 0 (the first frame of that window); the first frame of the clip is t = 0. ' +
      'Only the window is decoded, so it runs in constant memory on any clip length. The open side of fal-ai/ffmpeg-api/extract-frame (Canvas Extract frame, extend chains, Katana keyframes). Runs on CPU.',
  },
  {
    id: 'v2a-hunyuan-foley',
    title: 'Foley for a video: HunyuanVideo-Foley XL follows the frames (territory-restricted licence)',
    capability: 'v2a',
    handBuilt: 'hand-built/v2a-hunyuan-foley.json',
    bindings: {
      video: [b('5', 'video'), b('6', 'file')], prompt: [b('3', 'prompt')], negativePrompt: [b('3', 'negative_prompt')], duration: [b('3', 'duration')],
      fps: [b('5', 'force_rate'), b('3', 'frame_rate')], frames: [b('5', 'frame_load_cap')], seed: [b('3', 'seed')], steps: [b('3', 'steps')], cfg: [b('3', 'cfg_scale')],
    },
    outputs: [{ node: '8', kind: 'video' }, { node: '4', kind: 'audio' }],
    limits: { maxFrames: 481 },
    vramGb: 12,
    license: 'Tencent Hunyuan Community License (territory EXCLUDES the EU, UK and South Korea)',
    autoDownloads: ['HunyuanDependenciesLoader fetches the SigLIP2 and CLAP text encoders into the Hugging Face cache on first run'],
    notes:
      'Same model files as sfx-hunyuan-foley (no new download). VHS_LoadVideo samples the clip at 8 fps, 512 px wide (frames = duration x fps, so a 60 s clip holds 481 small frames), ' +
      'HunyuanFoleySampler gets them as its image input and makes duration seconds of 48 kHz sound in sync. Concatenate Video lays it under the untouched picture (stream copy); ' +
      'a sound longer than the clip is cut at its end. Outputs: the video with the new sound, then the sound alone (MP3).',
  },
  {
    id: 'product-shot-qwen-edit-2509',
    title: 'Product shot: cut out (BiRefNet), put on white, relit into a scene (Qwen-Image-Edit 2509 + White_to_Scene LoRA)',
    capability: 'edit',
    handBuilt: 'hand-built/product-shot-qwen-edit-2509.json',
    bindings: {
      prompt: [b('1002', 'string_b')],
      negativePrompt: [b('433:110', 'prompt')],
      image: [b('78', 'image')],
      seed: [b('433:3', 'seed')],
      steps: [b('433:436', 'value')],
      cfg: [b('433:437', 'value')],
      loraStrength: [b('1001', 'strength_model')],
    },
    outputs: [{ node: '469', kind: 'image' }],
    limits: { maxWidth: 2048, maxHeight: 2048 },
    vramGb: 24,
    license: 'Apache-2.0 (Qwen-Image-Edit-2509, White_to_Scene and Lightning LoRAs); BiRefNet MIT',
    notes:
      'relight-qwen-edit-2509 with a cut-out in front: core RemoveBackground (BiRefNet) masks the product, Image Composite Masked puts it on a white backdrop the size of the photo, ' +
      'then Qwen-Image-Edit 2509 + Lightning (4 steps, cfg 1) + dx8152 White_to_Scene LoRA (trigger "白底图转场景," = "white background to scene", prefixed by node 1002) places and relights it in the scene the prompt describes. ' +
      'The open route of the Product shot app (Bria Product Shot / Product Photography on the cloud).',
  },
  {
    id: 'audio-timeline',
    title: 'Voice track on the video\'s timeline: spoken lines placed at their start times over silence (core audio nodes)',
    capability: 'timeline',
    handBuilt: 'hand-built/audio-timeline.json',
    bindings: {
      audio: [b('2', 'audio')], duration: [b('1', 'duration')], startTime: [b('4', 'duration')],
    },
    outputs: [{ node: '7', kind: 'audio' }],
    expand: 'timeline',
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core audio nodes)',
    notes:
      'The dub voice track, all core nodes. The template places one line: EmptyAudio of the video\'s length (duration) is the track, the line (audio) is cut where the next line starts ' +
      '(TrimAudioDuration), put after startTime seconds of silence (AudioConcat after EmptyAudio) and added onto the track (AudioMerge add: pads or cuts the line to the track). ' +
      'The provider rewrites the graph per request: params.extra.timeline = {length, clips:[{start, duration}]} with one inputs.audios clip per entry, ' +
      'each loaded, cut, led in and added in turn, so the saved track is exactly as long as the video with every line at its cue time (pauses kept). ' +
      'SaveAudio writes FLAC (lossless, no MP3 priming delay). Feeds lip re-sync (InfiniteTalk frames = the track\'s length = the video\'s) and video-mux-audio. Runs on CPU.',
  },

  // =========================================================================
  // comfyui-oss-4 (round 4): docs/research/comfyui-oss-4.json, the 14 researched graphs and the critic's 3 (section i).
  // Graphs are the researcher's validated API graphs; changes are listed in each entry's notes. Capabilities are the
  // round-4 operations they serve.
  // =========================================================================

  // ---- Layers: text detection ----------------------------------------------------
  {
    id: 'ocr-lines-qwen35',
    title: 'Text lines with boxes for Layers: OvisOCR3 (Qwen3.5 0.8B OCR fine-tune) through core TextGenerate',
    capability: 'ocr',
    handBuilt: 'hand-built/ocr-lines-qwen35.json',
    bindings: {
      image: [b('1', 'image')], maxSize: [b('2', 'largest_size')], checkpoint: [b('3', 'clip_name')], instruction: [b('4', 'prompt')], maxTokens: [b('4', 'max_length')],
    },
    outputs: [{ node: '5', kind: 'text', role: 'lines' }, { node: '8', kind: 'text', role: 'frame' }],
    defaults: { checkpoint: 'ovisocr3_0.8b_bf16.safetensors', instruction: handBuiltInput('./hand-built/ocr-lines-qwen35.json', '4', 'prompt') },
    vramGb: 3,
    license: 'Apache-2.0 (OvisOCR3 weights by ATH-MaaS; the Qwen3.5 fallback checkpoints); ComfyUI core TextGenerate',
    notes:
      'Output 1 (role lines, SaveText .json): a JSON array in reading order, [{"bbox":[x0,y0,x1,y1],"text":"..."}], one item per text line, box corners as integers RELATIVE 0-1000 of the image ' +
      '(checked against rendered ground truth: (60, 81) px in a 1024x768 poster came back as (62, 96)). Fuobe strips ``` / ```json fences, accepts both bbox/text and bbox_2d/text_content ' +
      '(the general Qwen3.5 checkpoints answer that way), divides the corners by 1000 and returns each line with its box as x, y, w, h from 0 to 1, plus all the lines as plain text. ' +
      'Output 2 (role frame, PreviewAny text): {"width", "height", "coords": "relative-1000"}, the size the model saw after the maxSize scaling. ' +
      'instruction = defaults.instruction: OvisOCR3\'s prompts/word_spotting.txt changed from word to line level (use the original prompt for word boxes). Greedy decoding (sampling off): no seed. maxSize 1280 keeps small print legible. ' +
      'checkpoint: ovisocr3_0.8b_bf16.safetensors (1.71 GB; upstream ATH-MaaS/OvisOCR3 model.safetensors, save it under this name), or qwen3.5_0.8b_bf16 (1.75 GB, Qwen/Qwen3.5-0.8B saved under that name), ' +
      'qwen3.5_2b_bf16 (4.55 GB) or qwen3.5_4b_bf16 (9.32 GB, already in the library); the Qwen3.5 checkpoints wrap the JSON in fences, use bbox_2d/text_content and split lines more often. ' +
      'Measured on a 4-core CPU-only ComfyUI: OvisOCR3 161-194 s per poster (5/5 lines, mean IoU 0.82, also a 12-degree rotated sticker), Qwen3.5-0.8B 396 s (5/5) and 645 s on a busy poster (4/5); a GPU should take seconds. ' +
      'Tested on ComfyUI v0.41; v0.42 (#17121) writes the empty think block exactly as Qwen3.5\'s template.',
  },

  // ---- Edit video: remove, swap, insert ------------------------------------------------
  {
    id: 'video-inpaint-wan-vace',
    title: 'Remove an object from a video by naming it: SAM 3.1 tracking + Wan 2.1 VACE 14B fill (lightx2v 4-step)',
    capability: 'remove-object',
    handBuilt: 'hand-built/video-inpaint-wan-vace.json',
    bindings: {
      video: [b('1', 'file')], startTime: [b('85', 'start_time')], duration: [b('82', 'value')], width: [b('87', 'value')], height: [b('88', 'value')],
      maskPrompt: [b('8', 'text')], maskGrow: [b('11', 'expand')], prompt: [b('16', 'text')], negativePrompt: [b('17', 'text')], checkpoint: [b('20', 'unet_name')],
      loraStrength: [b('21', 'strength_model')], shift: [b('22', 'shift')], seed: [b('23', 'seed')], steps: [b('23', 'steps')], cfg: [b('23', 'cfg')],
    },
    outputs: [{ node: '38', kind: 'video' }],
    defaults: { checkpoint: 'wan2.1_vace_14B_fp16.safetensors' },
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 81, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.1 VACE 14B, lightx2v T2V LoRA, umT5, Wan VAE); SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms); GrowMaskWithBlur from ComfyUI-KJNodes (GPL-3.0 code)',
    notes:
      'maskPrompt = what to remove (SAM 3.1 text prompt, e.g. "the man in the red jacket"; up to 4 matching objects are tracked); prompt = the scene WITHOUT it. ' +
      'One window per job, in SECONDS: startTime and duration (params.startTime and params.endTime - startTime, which the provider already fills). Video Slice decodes only that window, at most 81 frames + half a frame ' +
      'at the clip\'s own fps (read from a 0.1 s probe slice), so RAM no longer grows with the clip and one window needs no fps app side. The graph keeps the largest 4n+1 frames it decoded (at most 81: 2.7 s at 30 fps, ' +
      '3.375 s at 24 fps, 5.06 s at 16 fps) and trims the sound to exactly those frames. duration 0 = the longest window; a longer duration is cut at 81 frames. ' +
      'Longer clips: one job per window, startTime = k x 81 / fps and duration = 81 / fps (fps from the clip\'s header), joined with video-concat-N (check the seams between windows). ' +
      'width x height = the work-size BUDGET (832x480 by default): VACE renders about width x height pixels in the CLIP\'s own shape (multiples of 16, at most 1280 a side; a 9:16 clip renders at 464x832), ' +
      'scaled, never cropped, so the paste-back lines up whatever aspect ratio the request had. ' +
      'SAM3_VideoTrack follows the object through the window, GrowMask (maskGrow px) covers edges and contact shadows, the control video blanks the masked area (as Comfy-Org\'s video_wan_vace_inpainting template) ' +
      'and WanVaceToVideo regenerates it. The result is pasted into the ORIGINAL frames at full resolution through a 6 px soft mask (GrowMaskWithBlur): every pixel outside the mask stays the source\'s own. ' +
      'The window\'s sound is kept (silent clips work). RAM: the window is held at the source size as float32 in several copies (decoded, cut, scaled back, pasted; ~25 MB per 1080p frame, ' +
      'so about 10 GB for 81 frames at 1080p): downscale 4K sources first. ' +
      'Changed from the original graph: the seconds-based window (the original bound startFrame / frames on the whole decoded clip and centre-cropped to width x height). ' +
      'Speed: the template\'s CausVid LoRA is CC-BY-NC-4.0, so this uses the Apache-2.0 lightx2v T2V 4-step LoRA (4 steps, cfg 1, euler, shift 5; ' +
      'made for the Wan 2.1 T2V base that VACE is built on); loraStrength 0 + steps 20 + cfg 6 is the slow full-quality path. checkpoint wan2.1_vace_1.3B_fp16.safetensors (4.31 GB) fits 8 GB cards and needs loraStrength 0, steps 20, cfg 6 ' +
      '(no 4-step LoRA for 1.3B). No new download: every default file is already in the library. ' +
      'The window, sound and work-size nodes ran on CPU (the built graph\'s own nodes, VACE replaced by the work-size frames scaled back): an 8 s 360x640 30 fps clip with sound, ' +
      'startTime 1, duration 0 -> 81 frames, 2.700 s of picture and 2.700 s of sound, rendered at 464x832 and back, matching source frames 30-110 (27.2 dB PSNR at offset 0 vs 19 dB one frame off; ' +
      'the original graph\'s centre crop gave 16.4 dB at every offset, i.e. misplaced); startTime 2, duration 1 -> 29 frames, 0.967 s of both; startTime and duration 81/30 -> frames 81-161; ' +
      'a silent clip -> 81 frames, no sound track, no error; a 60 s clip, window at 50 s: 0.6 s instead of 2.6 s with the whole-clip decode.',
  },
  {
    id: 'video-inpaint-wan-vace-painted',
    title: 'Remove an object painted on the first frame: SAM 3.1 tracks the mask + Wan 2.1 VACE 14B fill (lightx2v 4-step)',
    capability: 'remove-object',
    handBuilt: 'hand-built/video-inpaint-wan-vace-painted.json',
    bindings: {
      video: [b('1', 'file')], mask: [b('70', 'image')], startTime: [b('85', 'start_time')], duration: [b('82', 'value')],
      width: [b('87', 'value')], height: [b('88', 'value')],
      maskGrow: [b('11', 'expand')], prompt: [b('16', 'text')], negativePrompt: [b('17', 'text')], checkpoint: [b('20', 'unet_name')],
      loraStrength: [b('21', 'strength_model')], shift: [b('22', 'shift')], seed: [b('23', 'seed')], steps: [b('23', 'steps')], cfg: [b('23', 'cfg')],
    },
    outputs: [
      { node: '38', kind: 'video' },
      { node: '77', kind: 'image', role: 'mask' },
    ],
    defaults: { checkpoint: 'wan2.1_vace_14B_fp16.safetensors' },
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 81, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.1 VACE 14B, lightx2v T2V LoRA, umT5, Wan VAE); SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms); GrowMaskWithBlur from ComfyUI-KJNodes (GPL-3.0 code)',
    notes:
      'mask = a PNG of the window\'s FIRST frame, read from the red channel: white = the object to remove, black = keep (in the clip\'s shape). ' +
      'SAM3_VideoTrack takes it as initial_mask and tracks the object through the window. Changed from the original graph: the mask is read from the red channel (Fuobe\'s mask convention, as flux1-fill-inpaint) instead of alpha. ' +
      'The mask is scaled to the work size like the frames (not cropped), so any PNG size lines up. ' +
      'Everything else as video-inpaint-wan-vace: windows in seconds (startTime, duration; at most 81 frames, the largest 4n+1 decoded), width x height = the work-size budget in the clip\'s shape, ' +
      'paste-back into the original frames, the window\'s sound kept. ' +
      'For a window after the first, the mask must be painted on (or tracked to) that window\'s first frame: the second output (node 77, role "mask", added by the remove-object package) ' +
      'is the tracked mask of the window\'s LAST frame (SAM3_TrackToMask before GrowMask, at the work size, white = the object), which Fuobe feeds to the next window as its mask, so the object is followed across windows. ' +
      'The provider keeps node 77 only when params.extra.handOffMask is true (a window another one waits on); otherwise it is dropped, so a single or last window saves just the video.',
  },
  {
    id: 'video-erase-void',
    title: 'Remove an object AND what it causes (shadows, reflections, things it moves): Netflix VOID, two passes (core nodes)',
    capability: 'remove-object',
    handBuilt: 'hand-built/video-erase-void.json',
    bindings: {
      video: [b('1', 'file')], startTime: [b('85', 'start_time')], duration: [b('82', 'value')], width: [b('87', 'value')],
      height: [b('88', 'value')], maskPrompt: [b('8', 'text')], maskGrow: [b('11', 'expand')], prompt: [b('16', 'text')],
      negativePrompt: [b('17', 'text')], cfg: [b('21', 'cfg'), b('44', 'cfg')], steps: [b('22', 'steps'), b('45', 'steps')], seed: [b('24', 'noise_seed')], skipPass2: [b('49', 'value')],
    },
    outputs: [{ node: '52', kind: 'video' }],
    defaults: { skipPass2: false },
    limits: { maxWidth: 1024, maxHeight: 1024, maxFrames: 197, dimensionMultiple: 8 },
    vramGb: 40,
    license:
      'VOID weights Apache-2.0 (netflix/void-model), BUT fine-tuned from CogVideoX-Fun-V1.5-5b-InP, whose 5B transformer is under the CogVideoX License: free for academic research; commercial use only after ' +
      'registering for its basic commercial licence (open.bigmodel.cn), and at most 1 million service visits a month without a further licence; no military or illegal use. ' +
      'T5-XXL and the CogVideoX VAE Apache-2.0; RAFT BSD-3-Clause; SAM 3.1 under Meta\'s SAM License',
    notes:
      'The premium removal: VOID also removes what the object causes (shadows, reflections, objects it holds falling). Comfy-Org template utility_void_video_inpainting (2026-05-14), flattened, ' +
      'with SAM3_VideoTrack (maskPrompt) instead of per-frame SAM3_Detect. The binary mask goes straight into VOIDInpaintConditioning (1 = remove) as in the template; VOIDQuadmaskPreprocess is only for VOID\'s own 4-level quadmasks. ' +
      'Window in seconds like the VACE graphs (startTime, duration; Video Slice decodes only the window, at most 197 frames + half a frame at the clip\'s fps): the graph keeps the largest 8n+5 frames it decoded ' +
      '(45, 53 ... 197: an even latent length, which VOIDInpaintConditioning / VOIDWarpedNoise would otherwise round down to) and trims the sound to exactly those frames, so picture and sound stay the same length. ' +
      'duration 0 = the longest window (197 frames, 7.9 s at 25 fps); windows of 197 / fps seconds tile a longer clip. ' +
      'Output = the work size, not the source size: width x height is the budget (672x384 by default, VOID\'s training size) in the CLIP\'s shape (multiples of 8, at most 1024 a side; 672x376 for 16:9, 376x672 for 9:16), ' +
      'scaled, never cropped: the whole frame is re-rendered, so upscale afterwards if needed. The window\'s sound is kept. ' +
      'Pass 2 re-samples with noise warped along pass 1\'s optical flow (RAFT) for steadier long clips; skipPass2 true halves the time (pass 1 "is sufficient for most videos" per Netflix\'s card). ' +
      'The switch is lazy, so pass 2 does not run then, but void_pass2 and the RAFT file must still be installed (ComfyUI checks every loader that feeds the output before it runs). ' +
      'Downloads 32.5 GB: 2 x 11.14 GB passes, T5-XXL fp16 9.79 GB (the same file as FLUX\'s t5xxl_fp16), CogVideoX VAE 0.43 GB, RAFT 0.02 GB. ' +
      'VRAM: Netflix\'s reference code needs 40 GB+; in ComfyUI, plan on a 24 GB card with offloading. ' +
      'Changed from the original graph: the seconds-based window, the in-graph 8n+5 count and the aspect-keeping work size (the original bound startFrame / frames and centre-cropped). ' +
      'The window and work-size nodes ran on CPU: a 10 s 640x360 25 fps clip with sound, startTime 0.5, duration 0 -> 197 frames at 672x376, 7.880 s of picture and of sound; duration 2 -> 45 frames, 1.800 s of both.',
  },
  {
    id: 'video-swap-wan-vace',
    title: 'Swap an object or character for a reference image: SAM 3.1 tracking + Wan 2.1 VACE 14B with reference (lightx2v 4-step)',
    capability: 'video-swap',
    handBuilt: 'hand-built/video-swap-wan-vace.json',
    bindings: {
      video: [b('1', 'file')], image: [b('40', 'image')], startTime: [b('85', 'start_time')], duration: [b('82', 'value')], width: [b('87', 'value')], height: [b('88', 'value')],
      maskPrompt: [b('8', 'text')], maskGrow: [b('11', 'expand')], prompt: [b('16', 'text')], negativePrompt: [b('17', 'text')], checkpoint: [b('20', 'unet_name')],
      loraStrength: [b('21', 'strength_model')], shift: [b('22', 'shift')], seed: [b('23', 'seed')], steps: [b('23', 'steps')], cfg: [b('23', 'cfg')],
    },
    outputs: [{ node: '38', kind: 'video' }],
    defaults: { checkpoint: 'wan2.1_vace_14B_fp16.safetensors' },
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 81, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.1 VACE 14B, lightx2v T2V LoRA, umT5, Wan VAE); SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms); GrowMaskWithBlur from ComfyUI-KJNodes (GPL-3.0 code)',
    notes:
      'Genjutsu "Object Swap" on the open engine. maskPrompt = what to replace (the tracked mask, as video-inpaint-wan-vace); image = the new object, product or character, best cut out on a plain or white background ' +
      '(bg-remove-birefnet); prompt describes the result. The reference goes to WanVaceToVideo.reference_image (one extra latent frame that TrimVideoLatent drops) and the masked area is regenerated following the original motion. ' +
      'One image: with several references the provider sends the first (or a collage). Window rules (startTime / duration in seconds, at most 81 frames; width x height = the work-size budget in the clip\'s shape), the paste-back into the original frames ' +
      'and the kept sound are as video-inpaint-wan-vace. For a whole person, SCAIL-2 Character Replacement (template video_wan21_scail2_character_replacement) keeps the body motion better.',
  },
  {
    id: 'video-insert-wan-vace',
    title: 'Insert an object into a painted region: Wan 2.1 VACE 14B with a reference image (region held for the whole window)',
    capability: 'video-insert',
    handBuilt: 'hand-built/video-insert-wan-vace.json',
    bindings: {
      video: [b('1', 'file')], image: [b('40', 'image')], mask: [b('70', 'image')], startTime: [b('85', 'start_time')], duration: [b('82', 'value')],
      width: [b('87', 'value')], height: [b('88', 'value')],
      maskGrow: [b('11', 'expand')], prompt: [b('16', 'text')], negativePrompt: [b('17', 'text')], checkpoint: [b('20', 'unet_name')],
      loraStrength: [b('21', 'strength_model')], shift: [b('22', 'shift')], seed: [b('23', 'seed')], steps: [b('23', 'steps')], cfg: [b('23', 'cfg')],
    },
    outputs: [{ node: '38', kind: 'video' }],
    defaults: { checkpoint: 'wan2.1_vace_14B_fp16.safetensors' },
    limits: { maxWidth: 1280, maxHeight: 1280, maxFrames: 81, dimensionMultiple: 16 },
    vramGb: 24,
    license: 'Apache-2.0 (Wan 2.1 VACE 14B, lightx2v T2V LoRA, umT5, Wan VAE); GrowMaskWithBlur from ComfyUI-KJNodes (GPL-3.0 code)',
    notes:
      'mask = the region where the new object should appear, a PNG in the clip\'s shape read from the red channel (white = the region, black = keep), scaled (not cropped) to the work size; it is held for every frame of the window (RepeatImageBatch), ' +
      'so it suits a static or slow camera (without the repeat WanVaceToVideo would pad a one-frame mask with 1 = generate and regenerate the whole clip). image = the object (best cut out on white); ' +
      'prompt = what appears where and what it does. No SAM. Changed from the original graph: the mask is read from the red channel (Fuobe\'s mask convention) instead of alpha. ' +
      'Window rules (startTime / duration in seconds, at most 81 frames), the work-size budget, paste-back and the kept sound as video-inpaint-wan-vace.',
  },

  // ---- Genjutsu Character swap (O5, docs/research/openjutsu-6.md): MiniMax H3 + Akatz Labs' Character Swap LoRA ----
  // Openjutsu's graph (Comfy Org, MIT; derived from Akatz Labs' MIT workflow at 0670e4f) on the UNPATCHED h3_character_swap
  // pack: the resolution goes as the string "480" / "768". The pack is not installed on the validation server, so these
  // graphs are checked statically (core nodes against /object_info) and validate only where the pack is installed.
  {
    id: 'video-character-swap-h3',
    title: 'Character swap: SAM 3.1 picks the person, MiniMax H3 + the Character Swap LoRA regenerate only them (h3_character_swap pack)',
    capability: 'video-character-swap',
    handBuilt: 'hand-built/video-character-swap-h3.json',
    packs: ['h3_character_swap'],
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    optionalModels: ['h3_character_swap_pro4500_1000.safetensors'],
    bindings: {
      video: [b('30', 'file')], image: [b('9', 'image')], image2: [b('anchor_image', 'image')],
      startTime: [b('trim', 'start_time')], duration: [b('trim', 'duration'), b('31', 'duration_seconds')], quality: [b('31', 'resolution')],
      prompt: [b('801', 'prompt')], seed: [b('801', 'seed')], steps: [b('801', 'steps')], cfg: [b('801', 'cfg')], audioGuide: [b('801', 'audio_guide')],
      maskPrompt: [b('101', 'text')], selection: [b('104', 'selection')], subjectIndex: [b('104', 'index')], maskGrow: [b('110', 'expansion_px')],
      positiveCoords: [b('103', 'positive_coords')], negativeCoords: [b('103', 'negative_coords')], useMask: [b('803', 'use_mask')],
      windowFrames: [b('805', 'window_frames')], historyFrames: [b('805', 'history_frames')],
      lora: [b('850', 'lora_name')], loraStrength: [b('850', 'strength_model')], filenamePrefix: [b('809', 'filename_prefix')],
    },
    outputs: [{ node: '809', kind: 'video' }],
    defaults: { quality: '768', maskPrompt: 'person', selection: 'largest', subjectIndex: 0, maskGrow: 64, audioGuide: true, useMask: true, windowFrames: '124', historyFrames: '18', lora: 'h3_character_swap_v1.5.safetensors' },
    limits: { maxDurationSec: 30, maxFrames: 3592 },
    vramGb: 24,
    license: 'MiniMax H3 Community License (H3 Ref2VA, its video and audio VAEs, the packaged Qwen3-VL text encoder, Akatz Labs\' Character Swap LoRA): territory EXCLUDES the US, the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface; no outputs used to improve other AI models · Qwen3-VL-32B base Apache-2.0 · SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms) · FL2V Turbo LoRA Apache-2.0 at the pinned revision · h3_character_swap nodes GPL-3.0 (Akatz Labs; NVIDIA INT8 kernel derivative Apache-2.0)',
    notes:
      'Genjutsu "Character swap" on the open engine (Openjutsu, comfy-openjutsu @ 70ec62d; Akatz Labs h3-character-swap-tool @ 0670e4f). video = the clip, image = the character, image2 = the anchor first frame ' +
      '(absent: the provider deletes anchor_image and anchor_fit, unlinks 803.anchor and sets 803.use_anchor false); startTime / duration pick the part (trim and 31.duration_seconds both get the length, 5-15 s; up to 30 s plans more windows, beyond H3\'s trained range). ' +
      'quality "480" | "768" (strings: the unpatched pack; Openjutsu\'s patched pack takes integers). prompt in H3\'s reference tags (<Video 1> the clip, <Picture 1> the character, <Picture 2> the anchor). ' +
      'Who to swap: maskPrompt (SAM words, "person"), selection largest | leftmost | rightmost | index with subjectIndex, or clicks as positiveCoords / negativeCoords (JSON pixel points on the prepared first frame). ' +
      'lora V1.5 (h3_character_swap_v1.5) or V1 (h3_character_swap_pro4500_1000); "none" deletes node 850 and feeds 800.model from the Turbo LoRA (node 4). 8 steps, CFG 1, er_sde / normal for the FL2V Turbo LoRA; windows 124 frames with 18 of history (17n+5 / 0, 1, 17n+1). ' +
      'The clip\'s own sound is put back by the pack (807) and kept by CreateVideo; the pack also writes its own MP4 under output/H3-Character-Swap. Needs FFmpeg and FFprobe on PATH. ' +
      'Tested by its authors on a 96 GB RTX PRO 6000 (Comfy) and a 24 GB RTX 4090 with 128 GB RAM and model offloading (Akatz); NVFP4 text encoding runs natively on compute capability 10+ (Blackwell), slower elsewhere. 46.33 GB of weights.',
  },
  {
    id: 'video-character-swap-h3-relay',
    title: 'Character swap on H3 Relay 2.0: SAM 3.1 subject, MiniMax H3 + the Character Swap LoRA in native loop windows (h3-relay pack)',
    capability: 'video-character-swap',
    handBuilt: 'hand-built/video-character-swap-h3-relay.json',
    packs: ['h3-relay'],
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    optionalModels: ['h3_character_swap_pro4500_1000.safetensors'],
    bindings: {
      video: [b('source', 'file')], image: [b('reference', 'image')],
      startTime: [b('trim', 'start_time')], duration: [b('trim', 'duration'), b('prepare', 'duration_seconds')], quality: [b('prepare', 'resolution')],
      prompt: [b('reference_conditioning', 'prompt')], seed: [b('plan', 'seed')], steps: [b('schedule', 'steps')], cfg: [b('guider', 'cfg')], audioGuide: [b('history', 'target_audio_guide')],
      maskPrompt: [b('subject', 'text')], selection: [b('select', 'selection')], subjectIndex: [b('select', 'index')], maskGrow: [b('expand_mask', 'expansion_px')],
      positiveCoords: [b('detect', 'positive_coords')], negativeCoords: [b('detect', 'negative_coords')],
      windowFrames: [b('plan', 'window_frames')], historyFrames: [b('plan', 'history_frames')],
      lora: [b('adapter', 'lora_name')], loraStrength: [b('adapter', 'strength_model')], filenamePrefix: [b('save', 'filename_prefix')],
    },
    outputs: [{ node: 'save', kind: 'video' }],
    defaults: { quality: '768', maskPrompt: 'person', selection: 'largest', subjectIndex: 0, maskGrow: 64, audioGuide: true, windowFrames: '124', historyFrames: '18', lora: 'h3_character_swap_v1.5.safetensors' },
    limits: { maxDurationSec: 30, maxFrames: 3592 },
    vramGb: 24,
    license: 'MiniMax H3 Community License (H3 Ref2VA, its video and audio VAEs, the packaged Qwen3-VL text encoder, Akatz Labs\' Character Swap LoRA): territory EXCLUDES the US, the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface; no outputs used to improve other AI models · Qwen3-VL-32B base Apache-2.0 · SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms) · FL2V Turbo LoRA Apache-2.0 at the pinned revision · H3 Relay nodes GPL-3.0 (Sendy Software LLC and contributors; vendored Context Loop and Spectrum GPL-3.0); the graph is H3 Relay\'s example workflow (GPL-3.0 repository)',
    notes:
      'Akatz Labs\' newer route for the same swap (h3-relay @ e2a7665b, 2.0.1; example_workflows/toolkit/H3-Character-Swap.api.json, which Akatz\'s tool ships at 5f83374). Changed: a Trim Video node picks the part, the mask preview is removed, the adapter loads the V1.5 file by its Hugging Face name. ' +
      'Bindings as video-character-swap-h3 without an anchor frame or a masked-generation switch; lora "none" deletes the adapter and feeds its users from the Turbo LoRA. H3 Relay registers HTTP routes and an in-memory H3 layout compatibility layer on import: run it on the isolated worker if you prefer (install-comfyui.sh installs it with H3_RELAY=1). ' +
      'Needs FFmpeg and FFprobe on PATH.',
  },
  // Remove object's "Remove a person (H3)" (docs/research/openjutsu-6.md §4.4, §11.1 item 9): H3 Relay 2.0's Person Removal
  // example (akatz-ai/h3-relay @ e2a7665b, GPL-3.0) with Akatz Labs' Person Remover V1 LoRA, started from a clean first
  // frame the app makes (the person already gone). The clip comes in at 24 fps on the 32-pixel grid (Fuobe's fit step).
  {
    id: 'video-person-remove-h3-relay',
    title: 'Remove a person on H3 Relay 2.0: SAM 3.1 marks them green, MiniMax H3 + the Person Remover LoRA rebuilds the background from a clean first frame (h3-relay pack)',
    capability: 'remove-object',
    handBuilt: 'hand-built/video-person-remove-h3-relay.json',
    packs: ['h3-relay'],
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    bindings: {
      video: [b('source', 'file')], image: [b('anchor', 'image')],
      maskPrompt: [b('subject', 'text')], maskGrow: [b('grow_mask', 'expand')], seed: [b('plan', 'seed')], steps: [b('schedule', 'steps')],
      windowFrames: [b('plan', 'window_frames')], historyFrames: [b('plan', 'history_frames')],
      lora: [b('adapter', 'lora_name')], loraStrength: [b('adapter', 'strength_model')], filenamePrefix: [b('save', 'filename_prefix')],
      windowControls: [b('review', 'window_controls')],
    },
    outputs: [{ node: 'save', kind: 'video' }],
    defaults: { maskPrompt: 'person', maskGrow: 5, steps: 12, windowFrames: '22', historyFrames: '18', lora: 'H3-Person-Remover-V1.safetensors', loraStrength: 1, windowControls: '{}' },
    limits: { maxDurationSec: 60, maxFrames: 3592 },
    vramGb: 24,
    license: 'MiniMax H3 Community License (H3 Ref2VA, its video and audio VAEs, the packaged Qwen3-VL text encoder, Akatz Labs\' Person Remover V1 LoRA): territory EXCLUDES the US, the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface; no outputs used to improve other AI models · Qwen3-VL-32B base Apache-2.0 · SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms) · H3 Relay nodes GPL-3.0 (Sendy Software LLC and contributors; vendored Context Loop and Spectrum GPL-3.0); the graph is H3 Relay\'s example workflow (GPL-3.0 repository)',
    notes:
      'H3 Relay\'s toolkit H3-Person-Removal.api.json at e2a7665b (Akatz Labs\' tool ships the same file). Changed: the clean first frame goes through an ImageScale (centre crop) to the video\'s exact size, so an edit that came back a little larger or smaller still fits; SAM 3.1\'s words default to "person"; the save prefix. ' +
      'video = the part already fitted to 24 fps on the 32-pixel grid (oss-fit-clip), image = the clean first frame (the app makes it with Qwen-Image-Edit from the part\'s first frame). 22-frame windows with 18 of history, 12 steps, er_sde / simple, CFG 1, LoRA 1.0, mask grown 5 px, seed 904234 by default (Akatz\'s settings). The output is silent: the app puts the clip\'s sound back. ' +
      'Needs the h3-relay pack (H3_RELAY=1) and FFmpeg. ' +
      'windowControls = H3 Relay\'s Review Windows controls: {config_key, windows: {index: {seed, locked, record_id}}}; locked windows come back exactly from the checkpoints the Relay keeps in ComfyUI\'s output/__h3_removal_cache, the first unlocked one is drawn again with its seed (Redo from here). The provider reads the run\'s window previews from /h3_relay/removal/previews.',
  },
  // Remove object's mask first: the removal graph's own SAM 3.1 chain on the first seconds
  // of the fitted part, the person filled green exactly as the removal will see it (the model card: "check the saved
  // green-mask preview before running the full removal"). Native ComfyUI nodes only.
  {
    id: 'video-person-remove-h3-mask',
    title: 'Remove a person, mask first: SAM 3.1 finds who you name, thresholds and grows the mask and fills it green over the clip, as H3 Person Removal sees it (core nodes)',
    capability: 'person-mask',
    handBuilt: 'hand-built/video-person-remove-h3-mask.json',
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    bindings: {
      video: [b('source', 'file')], maskPrompt: [b('subject', 'text')], maskGrow: [b('grow_mask', 'expand')], filenamePrefix: [b('save', 'filename_prefix')],
    },
    outputs: [{ node: 'save', kind: 'video' }],
    defaults: { maskPrompt: 'person', maskGrow: 5 },
    limits: { maxDurationSec: 10, maxFrames: 240 },
    vramGb: 6,
    license: 'SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms); the chain is H3 Relay\'s Person Removal example (GPL-3.0 repository)',
    notes:
      'The SAM 3.1 part of video-person-remove-h3-relay, node for node (detect 0.4 with 2 refinements, track 0.5 with 1 object and detection every 12 frames, threshold 0.5, grow maskGrow px, green 0x00FF00), saved as a video instead of sampled. ' +
      'video = the first seconds of the part, fitted to 24 fps on the 32-pixel grid like the removal (oss-fit-clip). Needs nothing but SAM 3.1.',
  },

  // Character Swap Studio (o/h3-studio; docs/research/openjutsu-6.md §4.2): Akatz Labs' H3 Character Swap workbench for whole
  // clips. A segment is one H3 Relay 2.0 pass ("segment" schedule) over its frames plus the history before it; the
  // previous take's lossless master supplies that history (Akatz's continuation masters), the approved mask replaces
  // SAM's own when there is one, and an anchor is Picture 2 (Picture 3 after the boundary). The mask graph is the same
  // SAM 3.1 chain on any frame of a shot, spliced into the version it corrects.
  {
    id: 'video-character-swap-h3-segment',
    title: 'Character Swap Studio segment: one H3 Relay 2.0 pass with the approved mask, an anchor and the previous take\'s lossless master as history (h3-relay pack)',
    capability: 'video-character-swap',
    handBuilt: 'hand-built/video-character-swap-h3-segment.json',
    packs: ['h3-relay'],
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    optionalModels: ['h3_character_swap_pro4500_1000.safetensors'],
    bindings: {
      video: [b('source', 'file')], image: [b('reference', 'image')], image2: [b('anchor_image', 'image')],
      startTime: [b('trim', 'start_time')], duration: [b('trim', 'duration'), b('prepare', 'duration_seconds')], quality: [b('prepare', 'resolution')],
      prompt: [b('reference_conditioning', 'prompt')], seed: [b('plan', 'seed')], steps: [b('schedule', 'steps')], cfg: [b('guider', 'cfg')], audioGuide: [b('history', 'target_audio_guide')],
      maskPrompt: [b('subject', 'text')], selection: [b('select', 'selection')], subjectIndex: [b('select', 'index')], maskGrow: [b('expand_mask', 'expansion_px')],
      positiveCoords: [b('detect', 'positive_coords')], negativeCoords: [b('detect', 'negative_coords')],
      windowFrames: [b('plan', 'window_frames')], historyFrames: [b('plan', 'history_frames')],
      historyVideo: [b('history_source', 'file')], historyStart: [b('history_tail', 'batch_index')], historyLength: [b('history_tail', 'length')],
      lora: [b('adapter', 'lora_name')], loraStrength: [b('adapter', 'strength_model')], filenamePrefix: [b('save', 'filename_prefix'), b('save_master', 'filename_prefix')],
    },
    outputs: [{ node: 'save', kind: 'video' }, { node: 'save_master', kind: 'video', role: 'master' }],
    defaults: { quality: '768', maskPrompt: 'person', selection: 'largest', subjectIndex: 0, maskGrow: 64, audioGuide: true, windowFrames: '124', historyFrames: '18', lora: 'h3_character_swap_v1.5.safetensors' },
    limits: { maxDurationSec: 30, maxFrames: 703 },
    vramGb: 24,
    license: 'MiniMax H3 Community License (H3 Ref2VA, its video and audio VAEs, the packaged Qwen3-VL text encoder, Akatz Labs\' Character Swap LoRA): territory EXCLUDES the US, the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface; no outputs used to improve other AI models · Qwen3-VL-32B base Apache-2.0 · SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms) · FL2V Turbo LoRA Apache-2.0 at the pinned revision · H3 Relay nodes GPL-3.0 (Sendy Software LLC and contributors; vendored Context Loop and Spectrum GPL-3.0); the graph is built from H3 Relay\'s example workflow (GPL-3.0 repository)',
    notes:
      'One segment of Character Swap Studio on your GPU, built from video-character-swap-h3-relay: the window plan runs H3 Relay\'s "segment" schedule (one pass, at most 362 frames with its continuation boundary). ' +
      'video = the clip at 24 fps (oss-fit-clip), startTime / duration = the segment and the history frames before it (the app starts half a frame early and runs a quarter frame long, so Trim Video and PrepareVideo keep exactly those frames), image = the character, image2 = the anchor (absent: the provider deletes it, unlinks the window\'s anchor, drops Picture 2 and the first-frame guide unless there is history). ' +
      'historyVideo = the previous take\'s lossless master (save_master, 16-bit FFV1), historyStart / historyLength = its last frames, which become initial_history on the plan, the window and the append (Akatz\'s H3RelayLoadHistory route, with frames instead of an NPZ); absent: the provider deletes that branch. With history and an anchor the anchor is Picture 3 (the window\'s anchor output is then the generated boundary). ' +
      'The approved mask (params.extra.maskVideo, a whole-shot mask at 24 fps from video-mask-h3-relay) is added by the provider: Trim Video at maskStart for the same duration, fitted to the canvas, red channel to a mask, into the expansion instead of SAM\'s own chain; useMask false bypasses the edit mask (the whole frame is regenerated). ' +
      'Outputs: the segment (H.264) and its lossless master (role master) for the next segment. Needs the h3-relay pack (H3_RELAY=1), VideoHelperSuite and FFmpeg.',
  },
  {
    id: 'video-mask-h3-relay',
    title: 'Character Swap Studio mask: SAM 3.1 finds the person on any frame of a shot (words, largest / leftmost / rightmost / #n, or clicks), follows them to the end of the shot or redoes one frame, spliced into the mask it corrects (h3-relay pack)',
    capability: 'person-mask',
    handBuilt: 'hand-built/video-mask-h3-relay.json',
    packs: ['h3-relay'],
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    bindings: {
      video: [b('source', 'file')], startTime: [b('trim', 'start_time')], duration: [b('trim', 'duration'), b('prepare', 'duration_seconds')], quality: [b('prepare', 'resolution')],
      maskPrompt: [b('subject', 'text')], selection: [b('select', 'selection')], subjectIndex: [b('select', 'index')],
      positiveCoords: [b('detect', 'positive_coords')], negativeCoords: [b('detect', 'negative_coords')],
      keyFrame: [b('key_frame', 'batch_index'), b('span', 'batch_index'), b('head', 'length')], spanFrames: [b('span', 'length'), b('recover', 'source_frames')],
      tailStart: [b('tail', 'batch_index')], tailFrames: [b('tail', 'length')], prevMask: [b('prev_source', 'file')],
      filenamePrefix: [b('save', 'filename_prefix')],
    },
    outputs: [{ node: 'save', kind: 'video', role: 'matte' }],
    defaults: { quality: '768', maskPrompt: 'person', selection: 'largest', subjectIndex: 0, keyFrame: 0, spanFrames: 120 },
    limits: { maxDurationSec: 150, maxFrames: 3592 },
    vramGb: 6,
    license: 'SAM 3.1 under Meta\'s SAM License (commercial use allowed under its terms) · H3 Relay nodes GPL-3.0 (Sendy Software LLC and contributors)',
    notes:
      'Who to swap in one shot, as a black-and-white mask video at H3\'s canvas size and 24 fps (white = the person): the shot is prepared like a segment (H3 Relay\'s PrepareSource), SAM 3.1 detects on frame keyFrame from the words (maskPrompt) and the clicks (positiveCoords / negativeCoords, moved into the canvas by the provider; a click makes its detection first, so selection becomes index 0), H3RelaySelectMask picks largest / leftmost / rightmost / #n as the swap graphs do, SAM 3.1 tracks it for spanFrames (the rest of the shot for Track shot, 1 for Update frame) and recovers empty frames. ' +
      'prevMask = the version it corrects: its frames before (head) and after (tail) the new part are spliced around it; without one the provider links the new part straight to the video (and puts blank frames before a track that starts mid-shot). Akatz Labs\' app does the same with its own nodes (mask versions, Update frame, Track shot). Needs the h3-relay pack.',
  },

  // ---- Faceless "Frame by frame": Ken Burns over a still ------------------------------
  {
    id: 'kenburns-still',
    title: 'Ken Burns pan and zoom over a still for N seconds at F fps (core loops, chunk-encoded, no model)',
    capability: 'still-motion',
    handBuilt: 'hand-built/kenburns-still.json',
    bindings: {
      image: [b('1', 'image')], supersample: [b('2', 'scale_by')], width: [b('4', 'value')], height: [b('5', 'value')], duration: [b('6', 'value')], fps: [b('7', 'value')],
      zoomStart: [b('9', 'value')], zoomEnd: [b('10', 'value')], panStartX: [b('11', 'value')], panStartY: [b('12', 'value')], panEndX: [b('13', 'value')], panEndY: [b('14', 'value')],
      easeInOut: [b('19', 'value')], chunkFrames: [b('17', 'value')],
    },
    outputs: [{ node: '32', kind: 'video' }],
    limits: { maxWidth: 1920, maxHeight: 1920, dimensionMultiple: 2, maxDurationSec: 10 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core nodes)',
    notes:
      'The still-motion operation: params.zoomFrom / zoomTo -> zoomStart / zoomEnd (1 = the widest crop with the output\'s shape, 1.25 = 25 % closer), params.panFrom / panTo {x, y} -> panStartX/Y and panEndX/Y ' +
      '(the crop centre, 0-1 of the still, clamped so the crop stays inside), params.easing "ease-in-out" -> easeInOut 1 ((1 - cos(pi t)) / 2), "linear" -> 0; duration, fps and width x height (the output size) as usual. ' +
      'Presets (app side): push in zoom 1 -> 1.2; pull out 1.2 -> 1; pan left zoom 1.15, x 0.6 -> 0.4; pan up zoom 1.15, y 0.6 -> 0.4; a gentle end-card push-in 1 -> 1.05. ' +
      'Core loops (StartLoop/EndLoop, ComfyUI 2026-09-15): the outer loop runs one pass per chunk of chunkFrames frames, the inner loop crops each frame (ImageCrop) and scales it (lanczos) to width x height, ' +
      'each chunk is encoded at once (CreateVideo h264) and ConcatenateVideo joins them, so finished chunks can leave memory. supersample upsizes the still once so crop steps are half a source pixel. ' +
      'At most 10 s per job: RAM still grows by about one output frame per frame (~11 MB at 720p) until ComfyUI\'s RAM-pressure cache evicts chunks; split longer scenes. ' +
      'Changed from the original graph: easeInOut (node 19) blends linear and eased progress (the original graph was always eased). ' +
      'On a 4-core CPU: 2 s 640x360 25 fps 17.9 s; 5 s 1280x720 30 fps 75.6 s (+2.6 GB RSS); 10 s 1280x720 30 fps 142.1 s (+3.7 GB RSS, both under RAM pressure). ' +
      'Tested on CPU (64x64 still, 2 s 320x180 25 fps, chunks of 20): 50 frames, 2.000 s H.264 in 8.5-9.3 s (easeInOut 1) and 7.6-11.2 s (0); ' +
      'the two match at the first, middle and last frame and differ in between, and the eased one barely moves over its first and last frames. ' +
      'Crops are whole pixels, so a tiny still steps visibly (the first frame after zoom 1 jumps by one source pixel); supersample and a still larger than the output hide it.',
  },
  {
    id: 'video-concat-encoded',
    title: 'Join clips the open engine encoded, packet by packet in constant memory (core ConcatenateVideo, no decode)',
    capability: 'concat',
    handBuilt: 'hand-built/video-concat-encoded.json',
    bindings: { video: [b('1', 'file')], video2: [b('2', 'file')] },
    outputs: [{ node: '4', kind: 'video' }],
    expand: 'videos',
    limits: { maxClips: 100 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'The Faceless / Explainer "Frame by frame" join: the Ken Burns scenes (kenburns-still, and the pieces of scenes over 10 s), and joins of those joins, one after another in input order. ' +
      'The template joins two clips (video, video2); Fuobe rewrites it for each request: one LoadVideo per inputs.videos entry, wired to ConcatenateVideo videos.video0..N-1 (at most 100). ' +
      'ConcatenateVideo copies the encoded packets when every clip has the same codec, extradata, size, bit depth, colour space and sound layout (clips ComfyUI\'s CreateVideo / SaveVideo made at one size and fps), ' +
      'so RAM stays flat however long the film is (video-concat-{2,3,4} decode every frame as float32: about 11 MB a frame at 720p, 20 GB for a 60 s film at 30 fps); otherwise it re-encodes one clip at a time to the first clip\'s settings ' +
      '(still constant memory), and clips of different sizes fail with "could not be encoded compatibly". Unlike video-concat-{2,3,4} it neither scales, crops nor retimes: the clips must share one size and frame rate. ' +
      'Sound tracks are kept as they are (the Ken Burns clips have none; the mux adds the voice and the bed).',
  },

  {
    id: 'video-fit-clip',
    title: 'One clip cut, retimed and framed for a packet-copy join: start/length at a set fps, centre crop, its sound or silence (VHS meta-batch, no model)',
    capability: 'trim',
    handBuilt: 'hand-built/video-fit-clip.json',
    bindings: {
      video: [b('1', 'video')], startTime: [b('8', 'value')], duration: [b('9', 'value')], fps: [b('5', 'value')],
      width: [b('3', 'width')], height: [b('3', 'height')], framesPerBatch: [b('2', 'frames_per_batch')], filenamePrefix: [b('4', 'filename_prefix')],
    },
    outputs: [{ node: '4', kind: 'video' }],
    defaults: { fps: 30, width: 1280, height: 720 },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 2 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core + VideoHelperSuite GPL-3.0 code)',
    notes:
      'The Canvas Video concatenator, one job per clip, then video-concat-encoded joins them: every clip comes out at the film\'s size (width x height, scaled to cover and centre-cropped), ' +
      'at fps (30) and as H.264 + AAC from VHS, so ConcatenateVideo can copy the packets. VHS_LoadVideo resamples to fps and skips round(startTime x fps) frames, keeping round(duration x fps) ' +
      '(duration 0 = to the end); its sound is cut to the same window (VHS lazy audio: start = skipped frames / fps, length = kept frames / fps), so picture and sound stay in sync. ' +
      'framesPerBatch frames per pass (64): memory stays flat however long the clip. Muted clips and clips with no sound: the provider replaces the combine\'s audio with an EmptyAudio as long as the window ' +
      '(silenceVhsAudio), so every clip of a film has a sound track; when the window\'s length is unknown (no header, no end) the sound is dropped instead.',
  },

  // ---- Music beds and audio joins --------------------------------------------------------
  {
    id: 'audio-loop-crossfade',
    title: 'Music bed of any length: loop a clip with equal-power crossfades and a fade-out (core audio nodes + core loop)',
    capability: 'audio-loop',
    handBuilt: 'hand-built/audio-loop-crossfade.json',
    bindings: {
      audio: [b('1', 'audio')], fadeCurve: [b('3', 'audio')], crossfade: [b('5', 'value')], duration: [b('6', 'value')], headroomDb: [b('2', 'volume')],
    },
    outputs: [{ node: '29', kind: 'audio' }],
    limits: { maxDurationSec: 600 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core audio nodes; VideoHelperSuite loader, GPL-3.0 code)',
    notes:
      'audio = the clip to loop; duration = the bed\'s length (params.duration, up to 600 s: ACE-Step\'s <= 240 s beds become 10-minute beds); crossfade = seconds at each seam (params.crossfade). ' +
      'fadeCurve = the crossfade curve Fuobe writes and uploads, because core has no gain-ramp node: a stereo WAV exactly crossfade seconds long, left channel = sin(pi/2 t) (fade-in), ' +
      'right channel = cos(pi/2 t) (fade-out), at 8 kHz so AudioMerge upsamples the curve and never resamples the music (for loops of near-identical material a linear curve avoids the +3 dB equal-power bump). ' +
      'Repeats = ceil((duration - crossfade) / (clip - crossfade)) from VHS_LoadAudioUpload\'s duration; each repeat is the body + (tail fading out + head fading in); the last crossfade seconds fade out. ' +
      'The clip must be longer than 2 x crossfade. headroomDb (integer dB, default -3) keeps a summed seam under 1.0, because AudioMerge "add" normalises a whole segment that peaks over 1. ' +
      'Each loop pass keeps its output cached, so memory grows as O(repeats^2 x clip): prefer clips >= 60 s (<= 10 repeats). Saves FLAC at the clip\'s sample rate. ' +
      'Tested on CPU (two tone clips): a 3 s 44.1 kHz stereo clip (440 Hz left, 660 Hz right), crossfade 0.5 s (a 16-bit 8 kHz curve), duration 10 -> FLAC 10.000 s, 44.1 kHz stereo in 1.1-2.5 s; ' +
      'seams at 2.5 / 5 / 7.5 s (+2.1 dB RMS over each seam on the pure tones: the equal-power bump), no clicks (largest sample step 0.035 vs 0.031 in the source), ' +
      'level -3 dB elsewhere (headroomDb) and the last 0.5 s fading to 0.',
  },
  {
    id: 'audio-join-crossfade',
    title: 'Join two audio clips with a crossfade (core audio nodes)',
    capability: 'audio-join',
    handBuilt: 'hand-built/audio-join-crossfade.json',
    bindings: { audio: [b('1', 'audio')], audio2: [b('2', 'audio')], fadeCurve: [b('3', 'audio')], crossfade: [b('5', 'value')] },
    outputs: [{ node: '17', kind: 'audio' }],
    expand: 'audios',
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core audio nodes; VideoHelperSuite loader, GPL-3.0 code)',
    notes:
      'audio then audio2, overlapped by crossfade seconds (params.crossfade, > 0; 0.02 gives a click-free hard join). fadeCurve = the same curve WAV as audio-loop-crossfade, crossfade seconds long, written by the provider. ' +
      'More clips (params.audios in order): the provider rewrites the graph for all of them in one prompt (expand "audios"): every clip but the last is read by a VHS loader ' +
      '(for its length), the first gives its body, each middle clip its head, middle and tail, the last its head and the rest, and each seam is tail x fade-out + next head x fade-in, all concatenated in order; ' +
      'middle clips must be longer than 2 x crossfade. The output runs at the highest sample rate of the clips (AudioConcat resamples) and is saved as FLAC. ' +
      'Clips placed at exact times are audio-timeline\'s job. ' +
      'Tested on CPU: 3 s 44.1 kHz tones + 2 s 48 kHz noise, crossfade 0.5 s -> FLAC 4.500 s at 48 kHz stereo in 0.2-2.1 s; the tones keep their level (-9.0 dB RMS) up to 2.5 s, ' +
      'the overlap ramps over 0.5 s and the noise follows at its own level (-15.2 dB): no headroom is taken off here.',
  },

  // ---- Export: pro codecs, HDR, EXR -------------------------------------------------------
  {
    id: 'video-export-pro',
    title: 'Pro codec export: ProRes 422 HQ / 4444, H.265 10-bit, FFV1 lossless, H.264 (VideoHelperSuite)',
    capability: 'export-video',
    handBuilt: 'hand-built/video-export-pro.json',
    bindings: { video: [b('1', 'file')], format: [b('3', 'format')], profile: [b('3', 'profile')] },
    outputs: [{ node: '3', kind: 'video' }],
    defaults: { format: 'video/ProRes', profile: 'hq' },
    vramGb: 0,
    license: 'n/a (no model; VideoHelperSuite GPL-3.0 code and the system ffmpeg\'s prores_ks / libx265 / ffv1 / libx264 encoders)',
    notes:
      'params.format -> format (+ profile): prores_422_hq -> video/ProRes + hq; prores_4444 -> video/ProRes + 4444 (also lt, standard, 4444xq); h265_10bit -> video/h265-mp4 (pix_fmt yuv420p10le, its first option); ' +
      'ffv1 -> video/ffv1-mkv (lossless, rgba64le); h264 -> video/h264-mp4; exr -> video-export-exr. VHS falls back to each format widget\'s default when an input is missing, and adds profile only for ProRes. ' +
      'VHS writes <prefix>_00001.<ext> (.mov ProRes, .mp4 H.264/H.265, .mkv FFV1; no sound) and, when the clip has sound, <prefix>_00001-audio.<ext>, the only file the history lists (under "gifs"); ' +
      'it also leaves a first-frame .png next to them. Fuobe saves an FFV1 export as a .bin video file for now, as it does not yet map .mkv (video/x-matroska) to an extension. ' +
      'Decodes the whole clip (GetVideoComponents): RAM grows with the length. ' +
      'Tested on CPU (a 1 s 64x64 16 fps clip with AAC sound, 0.16-0.4 s each, checked with ffprobe): ProRes HQ .mov yuv444p10le + pcm_s16le; ProRes 4444 yuv444p12le; h265-mp4 HEVC Main 10 yuv420p10le + AAC; ' +
      'ffv1-mkv gbrap16le + FLAC; h264-mp4 High yuv420p + AAC; 16 frames and 1.000 s in every file; bt709 tags (FFV1: gbr matrix, sRGB transfer, bt709 primaries).',
  },
  {
    id: 'video-sdr-to-hdr',
    title: 'SDR to HDR: expand to Rec.2020 HLG and save 10-bit H.264 (core ImageSDRToHDR, no model)',
    capability: 'sdr-to-hdr',
    handBuilt: 'hand-built/video-sdr-to-hdr.json',
    bindings: { video: [b('1', 'file')], peakNits: [b('3', 'algorithm.target_luminance')], colorSpace: [b('4', 'color_space')] },
    outputs: [{ node: '5', kind: 'video' }],
    defaults: { colorSpace: 'HDR' },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'An algorithmic inverse tone map (Lottes-style curve blended with a log-gain curve), not a learned model: the open stand-in for Topaz\'s SDR to HDR. peakNits = the target peak white (650 by default, 0 = the calibrated rendering). ' +
      'CreateVideo writes BT.2020 HLG at 10 bits (color_space HDR) and SaveVideo an H.264 High 10 MP4; the sound is kept. params.format hlg_10bit is this graph as built; pq_10bit binds colorSpace "HDR PQ" ' +
      '(BT.2020 PQ, HDR10\'s transfer, still H.264 High 10: core ComfyUI has no H.265 encoder); exr -> video-sdr-to-hdr-exr. ' +
      'The learned alternative is the LTX-2.5 SDR-To-HDR IC-LoRA (LTX community licence, not built). Decodes the whole clip: RAM grows with the length. ' +
      'Tested on CPU (1 s 64x64 16 fps clip, 0.2-1.5 s): H.264 High 10, yuv420p10le, bt2020nc / bt2020 / arib-std-b67 (HLG), 16 frames, AAC kept. ' +
      'Through Fuobe with colorSpace HDR PQ (3 s 320x180 25 fps clip with sound): H.264 High 10, yuv420p10le, smpte2084 / bt2020, 75 frames, AAC.',
  },
  {
    id: 'video-export-exr',
    title: 'OpenEXR frame sequence (16-bit float, scene-linear) from a video (core SaveImageAdvanced)',
    capability: 'export-video',
    handBuilt: 'hand-built/video-export-exr.json',
    bindings: { video: [b('1', 'file')] },
    outputs: [{ node: '5', kind: 'video', role: 'preview' }, { node: '3', kind: 'image', role: 'frames' }],
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'params.format "exr" of the export-video operation. One half-float .exr per frame (role frames, in frame order); input_color_space sRGB applies the inverse sRGB curve, so the files are scene-linear Rec.709. ' +
      'Node 5 saves an H.264 preview with the clip\'s sound (role preview): the result shown in the feed; Fuobe zips the frames and attaches the zip to it. ' +
      'The frames have no sound. Decodes the whole clip: RAM grows with the length. Fuobe saves each frame as an image .bin file for now, ' +
      'as it does not yet map .exr (image/aces) to an extension; the zip is the deliverable anyway. ' +
      'Tested on CPU (1 s 64x64 16 fps clip, 0.06-0.2 s): 16 .exr files (<prefix>_00001.exr ...), HALF B/G/R channels, ZIP compression, linear transfer. ' +
      'With the preview (through Fuobe, 2 s 160x96 30 fps clip with sound): 60 .exr files zipped (2.6 MB, stored) onto an H.264 preview with AAC.',
  },

  // ---- Still to clip, ad end card ---------------------------------------------------------
  {
    id: 'still-to-clip',
    title: 'Still or end card to an N-second clip with a silent track (core, no model)',
    capability: 'still-motion',
    handBuilt: 'hand-built/still-to-clip.json',
    bindings: {
      image: [b('1', 'image')], width: [b('2', 'width')], height: [b('2', 'height')], duration: [b('3', 'value')], fps: [b('4', 'value')],
    },
    outputs: [{ node: '9', kind: 'video' }],
    limits: { maxWidth: 3840, maxHeight: 3840, dimensionMultiple: 2 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'The still held for duration seconds at fps, centre-cropped to width x height (ImageScale), with a silent stereo AAC track so joins and players see sound. ' +
      'The app renders an end card (logo on the brand colour) at the clip\'s size; for a gentle push-in use kenburns-still with zoom 1 -> 1.05. ' +
      'With video-concat-sound1-2 it is the end-card fallback for clips the open engine did not make (see video-append-endcard). ' +
      'Tested on CPU (64x64 PNG -> 2 s 320x180 25 fps, 0.2-1.0 s): 50 identical frames, H.264 + stereo AAC silence, 2.000 s.',
  },
  {
    id: 'video-append-endcard',
    title: 'Append an end card to an ad and keep the ad\'s sound (picture stream-copied; core ConcatenateVideo)',
    capability: 'concat',
    handBuilt: 'hand-built/video-append-endcard.json',
    bindings: {
      video: [b('1', 'file'), b('2', 'audio')], image: [b('3', 'image')], width: [b('4', 'value')], height: [b('5', 'value')], fps: [b('6', 'value')], duration: [b('7', 'value')],
    },
    outputs: [{ node: '15', kind: 'video' }],
    limits: { dimensionMultiple: 2 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'video = the ad (LoadVideo and LoadAudio read the same upload), image = the card; width, height and fps must be the clip\'s own (from its header), duration = the card\'s seconds (2 by default). ' +
      'The ad\'s picture is copied packet by packet (bit-identical, never decoded); the card is encoded as H.264 at the clip\'s size and fps, and the ad\'s sound is padded with card-length silence (AudioConcat) ' +
      'and passed as complete_audio. Silent ads (LoadAudio stops with "No audio stream found in the file", checked): the provider drops nodes 2, 12 and 13 and the complete_audio input of node 14, and the result has no sound track. ' +
      'LIMIT: only for clips the open engine made (ComfyUI CreateVideo/SaveVideo, sRGB-tagged H.264). Clips from other encoders (cloud models, uploads, ffmpeg/libx264, tagged or not) fail in core v0.41 with ' +
      '"Video chunk 1 could not be encoded compatibly: extradata ... color space"; for those use still-to-clip + video-concat-sound1-2 (decodes everything, keeps clip 1\'s sound). ' +
      'Tested on CPU: a ComfyUI-made 2 s 320x180 25 fps clip with sound + a 2 s card -> 4.000 s, 100 frames in 0.3-2.9 s; the ad\'s 50 frames decode bit-identical to the source (framemd5) and silencedetect finds silence from 2.00 s. ' +
      'Silent ad + a 1.5 s card with nodes 2, 12 and 13 dropped: 3.52 s, 88 frames, no sound track (keeping node 12 as complete_audio instead gives a sound track only the card\'s 1.5 s long). ' +
      'The fixture clip from ffmpeg failed with the extradata / colour-space error above (the limit reproduced).',
  },

  // ---- Cinema Studio 3D scene, subject splats -------------------------------------------
  {
    id: 'scene-mesh-moge',
    title: 'Image to a textured 3D mesh of the whole scene + a depth map (MoGe 2 / MoGe 3, core nodes)',
    capability: 'scene-3d',
    handBuilt: 'hand-built/scene-mesh-moge.json',
    bindings: {
      image: [b('1', 'image')], checkpoint: [b('6', 'model_name')], resolutionLevel: [b('7', 'resolution_level')], fovX: [b('7', 'fov_x_degrees')], decimation: [b('8', 'decimation')],
    },
    outputs: [{ node: '9', kind: 'model3d', role: 'scene' }, { node: '11', kind: 'image', role: 'depth' }],
    defaults: { checkpoint: 'moge_2_vitl_normal_fp16.safetensors' },
    vramGb: 4,
    license: 'MIT (microsoft/MoGe 2 and 3, Comfy-Org/MoGe repack)',
    notes:
      'Cinema Studio "Create 3D scene": photo -> textured GLB of the WHOLE frame (role scene) + a depth PNG (role depth). From the official template 3d_moge_perspective_to_mesh (2026-05-15): normal-map previews dropped, the depth PNG added; ' +
      'images with a longer edge over 2048 px are resized to 2048 first (changed from the original graph, which tested the width only, so tall portraits went through at full size; checked on CPU: ' +
      '1536x3000 -> 1048x2048, 3000x1536 -> 2048x1048, 1024x768 unchanged). The browser orbits the GLB, captures a view, and qwen-image-edit-2511 re-renders it with the original photo. ' +
      'resolutionLevel 0-9 (detail), fovX = horizontal field of view in degrees (0 = estimate), decimation 2 for phones (about 4x fewer triangles). ' +
      'checkpoint moge_2_vitl_normal_fp16 (0.66 GB) by default; moge_3_vitl_fp16 (0.74 GB) and moge_3_vitg_fp16 (2.50 GB) load through the same node. ' +
      'On a 4-core CPU: a 768x768 living-room photo became a 25.2 MB GLB (556k vertices, 1.08M triangles, one texture, depth 0.35-6.58 m) in 42 s, +1.6 GB RSS. It runs on a CPU too: MoGe 2 ViT-L has ~0.33B parameters. ' +
      'TripoSplat (image-to-splat-triposplat) rebuilds the subject only, not the scene.',
  },
  {
    id: 'image-to-splat-triposplat',
    title: 'Image to a Gaussian splat of the subject (TripoSplat, core nodes) + an orbit video',
    capability: 'splat',
    handBuilt: 'hand-built/image-to-splat-triposplat.json',
    bindings: {
      image: [b('99', 'image')], cutout: [b('88:35', 'switch')], numGaussians: [b('88:55', 'num_gaussians')], steps: [b('88:6', 'steps')], cfg: [b('88:6', 'cfg')],
      seed: [b('88:6', 'seed'), b('88:55', 'seed')], splatFormat: [b('92', 'format')], orbitFrames: [b('75', 'frames')],
    },
    outputs: [{ node: '51', kind: 'model3d', role: 'splat' }, { node: '42', kind: 'video', role: 'turntable' }],
    defaults: { splatFormat: 'spz', cutout: true },
    limits: { maxGaussians: 1048576 },
    vramGb: 8,
    license:
      'MIT (VAST-AI/TripoSplat weights); the dino_v3_vit_h image encoder is under the DINOv3 License (royalty-free, commercial use allowed, trade-control limits; ' +
      'the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT',
    notes:
      'Subject or product splat (3D Angles, 3D Jutsu props, a splat alternative to TRELLIS.2 spins). The official template 3d_triposplat_image_to_gaussian_splat (2026-06-02) with the UI-only live-preview patch removed ' +
      'and a 75-frame H.264 orbit (RenderSplat + CreateCameraInfo orbit yaw 35, pitch 30, distance 2.5; role turntable, 25 fps). Subject only: BiRefNet cuts it out first (cutout false = use the image\'s own alpha). ' +
      'Output 1 (role splat): splatFormat spz (Niantic, gzip, ~10x smaller, base colour), ply (full spherical harmonics) or ksplat, saved by SaveGLB under that extension. ' +
      'ComfyUI serves all three as application/octet-stream, so Fuobe goes by the extension: spz and ply are saved as 3D models (model/x-spz, model/ply), ksplat as a .bin file, ' +
      'and each output records its format. ' +
      'cutout is true by default (manifest defaults). ' +
      'numGaussians up to 1,048,576 (262,144 by default); seed drives both the sampler and the decoder. RenderSplat also takes a look_at camera, so a view picked in the browser can be rendered on the server. ' +
      '3.78 GB of weights (TripoSplat 0.74, DINOv3 ViT-H 1.68, TripoSplat VAE decoder 0.58, FLUX.2 VAE 0.34, BiRefNet 0.44).',
  },
  {
    // Any Angle (app-any-angle): the 3D view of one photo, built once and saved. Measured on an RTX 5090 (any-angle GPU test).
    id: 'any-angle-3d',
    title: 'Any Angle: a photo to a 3D view of its subject (TripoSplat), with a turntable, the sweep its front view is measured on and a GLB',
    capability: 'splat',
    handBuilt: 'hand-built/any-angle-3d.json',
    bindings: {
      // Only the photo: the seeds, the Gaussians and the 48 frames stay as the graph has them (the same photo, the same view).
      image: [b('1', 'image')],
    },
    outputs: [
      { node: '16', kind: 'model3d', role: 'splat' },
      { node: '83', kind: 'video', role: 'turntable' },
      { node: '85', kind: 'image', role: 'sweep' },
      { node: '88', kind: 'image', role: 'sweep-mask' },
      { node: '21', kind: 'image', role: 'matte' },
      { node: '91', kind: 'model3d', role: 'mesh' },
    ],
    defaults: {},
    vramGb: 8,
    license:
      'MIT (VAST-AI/TripoSplat weights); the dino_v3_vit_h image encoder is under the DINOv3 License (royalty-free, commercial use allowed, trade-control limits; the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT',
    notes:
      'Step 1 of Any Angle, run once per photo (the server keeps the result by the photo\'s sha256; feature any-angle-step, out of Library). image-to-splat-triposplat\'s chain with the cut-out always on ' +
      '(without it a turned camera shows the photo as a flat card with black wedges), seeds fixed at 46 for the sampler and the decoder (the same photo gives the same 3D view), 20 steps, cfg 3, dpmpp_2m, 262,144 Gaussians. ' +
      'Outputs: the splat as .spz (role splat, about 3 MB: every angle reloads it), a 48-frame turntable from yaw 0 at pitch 10, distance 2, fov 33, 512 px, 12 fps (role turntable, shown while picking), ' +
      'the same frames at 192 px as lossless animated WebP, colour (role sweep) and RenderSplat\'s coverage mask (role sweep-mask), the BiRefNet cut-out (role matte) and a GLB from core SplatToMesh at 256 (role mesh, the desktop drag view). ' +
      'The server compares the sweep with the cut-out photo (silhouette overlap and colour correlation, the GPU test\'s measure) to find the photo\'s front yaw and distance: ' +
      'TripoSplat drops its own camera estimate and puts each subject in a pose of its own (the test found yaw 125, 75 and 90 on three photos). ' +
      'GPU test (RTX 5090): cut-out 0.8-1.3 s, TripoSplat 1.0 + 18-19.4 + 0.4 s, .spz save under 0.05 s, 48 frames at 512 px 20-37 s, mesh 0.4-0.5 s; about 8.7 GiB peak.',
  },
  {
    // Any Angle (app-any-angle): one angle from the saved 3D view, painted back into a photo by Qwen-Image 2.1 + the AnyAngle LoRA.
    id: 'any-angle-shot',
    title: 'Any Angle: one camera angle of a photo, the 3D view rendered there and repainted by Qwen-Image 2.1 + the AnyAngle LoRA',
    capability: 'edit',
    handBuilt: 'hand-built/any-angle-shot.json',
    bindings: {
      image: [b('1', 'image')], splatFile: [b('2', 'model_file')],
      cameraYaw: [b('20', 'mode.yaw')], cameraPitch: [b('20', 'mode.pitch')], cameraDistance: [b('20', 'mode.distance')], cameraFov: [b('20', 'fov')],
      targetX: [b('20', 'target_x')], targetY: [b('20', 'target_y')], targetZ: [b('20', 'target_z')],
      width: [b('30', 'width')], height: [b('30', 'height')], seed: [b('56', 'seed')], steps: [b('56', 'steps')], cfg: [b('56', 'cfg')],
    },
    outputs: [{ node: '58', kind: 'image' }],
    defaults: { steps: 25, cfg: 1 },
    limits: { maxWidth: 2048, maxHeight: 2048, dimensionMultiple: 8 },
    vramGb: 32,
    license:
      'Qwen Research License Agreement (Qwen-Image 2.1, Qwen3-VL 8B encoder, VAE): NON-COMMERCIAL, research and evaluation only; the AnyAngle LoRA (lilylilith/QI_2.1_AnyAngle) Apache-2.0',
    notes:
      'Step 2 of Any Angle, one job per angle. The saved .spz goes in like any input (splatFile) and Load3D reads it without the browser: its image entry points at the photo (the provider fills it), ' +
      'then File3DToSplat. CreateCameraInfo orbit takes the camera Fuobe works out (the photo\'s measured front view plus the preset\'s turn, height and distance; a close-up aims at the face\'s height), ' +
      'RenderSplat renders it at the photo\'s shape (up to 2048 px, black background). Qwen-Image 2.1 int8 + the AnyAngle LoRA at 1.0, loaded here (one model loader, so no request LoRA lands on another), ' +
      'TextEncodeQwenImage21 with the LoRA\'s own prompt "Change the camera angle from <image2> to <image1>.", image 1 the original photo, image 2 the render, resolution 1024 (about 1 MP out: 1184x896 from a 1536x1152 photo), ' +
      'KSampler 25 steps, cfg 1, euler, simple, seed 46. GPU test (RTX 5090): reload + render 2.3 s (a rebuild would be about 20 s), text encode 5.4 s, sampler 22.6 s, about 30 s an angle, peak 28.4-29.2 GiB (card total, with the desktop): vramGb 32, since a 24 GB card has no room to spare. ' +
      'Tested against the alternatives: the other image order gives back the original angle, cfg 3 is 5x slower and no better, bf16 is 2x slower, the photo behind the render adds a ghost second person, grey is no better than black.',
  },
  {
    // Idol 3D (docs/research/idol-9.md §5.5): Speridlabs' Idol, TripoSplat's architecture retrained, on the same core nodes.
    id: 'image-to-splat-idol',
    title: 'Image to a Gaussian splat of one object (Idol on the TripoSplat core nodes) + an orbit video',
    capability: 'splat',
    handBuilt: 'hand-built/image-to-splat-idol.json',
    bindings: {
      image: [b('99', 'image')], cutout: [b('88:35', 'switch')], numGaussians: [b('88:55', 'num_gaussians')], steps: [b('88:6', 'steps')], cfg: [b('88:6', 'cfg')],
      sampler: [b('88:6', 'sampler_name')], photoCrop: [b('88:104', 'switch')],
      seed: [b('88:6', 'seed'), b('88:55', 'seed')], splatFormat: [b('92', 'format')], orbitFrames: [b('75', 'frames')],
    },
    outputs: [{ node: '51', kind: 'model3d', role: 'splat' }, { node: '42', kind: 'video', role: 'turntable' }],
    defaults: { splatFormat: 'spz', cutout: true, photoCrop: false },
    limits: { maxGaussians: 1048576 },
    vramGb: 8,
    license:
      'Apache-2.0 (speridlabs/idol weights; the ComfyUI files are nynxz/Idol\'s conversion, Apache-2.0); Idol is VAST-AI-Research\'s TripoSplat architecture (MIT, code and weights); ' +
      'the dino_v3_vit_h image encoder is under the DINOv3 License (royalty-free, commercial use allowed, trade-control limits; ' +
      'the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT',
    notes:
      'Idol 3D (Speridlabs): one object from one picture -> a Gaussian splat (role splat) + a 75-frame orbit video (role turntable). A copy of image-to-splat-triposplat with the same node ids. ' +
      'Reference settings (idol-sdk sampler.py L43-70): 50 Euler steps, simple schedule; Idol\'s CFG weight 3 in its (1+w)cond - w*uncond form is ComfyUI cfg 4.0, and its rescale_t 3 is TripoSplat\'s built-in shift 3 (comfy/supported_models.py), so no ModelSamplingSD3. ' +
      'Quick look (set by the page as params.extra): 20 dpmpp_2m steps, cfg 4, 65,536 Gaussians, the ComfyUI-Idol README\'s "faster trade-off" and "fast preview"; quality unmeasured. ' +
      'Photo crop (photoCrop, default false): TripoSplatPreprocessImage is Idol\'s "synthetic" 1.2 crop; scaled to 720 and centred on a black 1024 canvas (88:101-103) the object spans 600 px, where Idol\'s "real" 1.7 crop gives 602 px. ' +
      'ComfySwitchNode 88:104 picks it; its inputs are lazy, so the branch not taken does not run. Not yet compared with IdolPreprocessImage "real". ' +
      'About half the Gaussians are near-transparent: RenderSplat thresholds 0.05; the saved file is not pruned without the ComfyUI-Idol pack. ' +
      '1.32 GB of new weights (idol_fp16 0.74, idol_decoder_fp16 0.58) plus the shared 2.46 GB (DINOv3 ViT-H 1.68, FLUX.2 VAE 0.34, BiRefNet 0.44). ' +
      'VRAM: vendor peak 7.2 GB in the SDK; unmeasured in ComfyUI.',
  },
  {
    // idol-2 (docs/research/idol-9.md §5.6): image-to-splat-idol with the ComfyUI-Idol pack. The provider runs it when the
    // server has the pack (GET /object_info/IdolPruneSplat) and image-to-splat-idol otherwise.
    id: 'image-to-splat-idol-clean',
    title: 'Image to a cleaned Gaussian splat of one object (Idol, ComfyUI-Idol crop and pruning) + an orbit video',
    capability: 'splat',
    handBuilt: 'hand-built/image-to-splat-idol-clean.json',
    packs: ['ComfyUI-Idol'],
    bindings: {
      image: [b('99', 'image')], cutout: [b('88:35', 'switch')], numGaussians: [b('88:55', 'num_gaussians')], steps: [b('88:6', 'steps')], cfg: [b('88:6', 'cfg')],
      sampler: [b('88:6', 'sampler_name')], cropMode: [b('88:110', 'mode')], minOpacity: [b('88:111', 'min_opacity')], maxScale: [b('88:111', 'max_scale')],
      seed: [b('88:6', 'seed'), b('88:55', 'seed')], splatFormat: [b('92', 'format')], orbitFrames: [b('75', 'frames')],
    },
    // The input-view still is the card's poster ("preview": the picture shown for the result); the count of Gaussians the
    // prune kept is the pack's own report of the run (meta.kept on the splat).
    outputs: [
      { node: '51', kind: 'model3d', role: 'splat' },
      { node: '42', kind: 'video', role: 'turntable' },
      { node: '93', kind: 'image', role: 'preview' },
      { node: '94', kind: 'text', role: 'report' },
    ],
    defaults: { splatFormat: 'spz', cutout: true, cropMode: 'synthetic', minOpacity: 0.05, maxScale: 0 },
    limits: { maxGaussians: 1048576 },
    vramGb: 8,
    license:
      'Apache-2.0 (speridlabs/idol weights; the ComfyUI files are nynxz/Idol\'s conversion, Apache-2.0); Idol is VAST-AI-Research\'s TripoSplat architecture (MIT, code and weights); ' +
      'the dino_v3_vit_h image encoder is under the DINOv3 License (royalty-free, commercial use allowed, trade-control limits; ' +
      'the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT; ComfyUI-Idol nodes Apache-2.0',
    notes:
      'Idol 3D with the ComfyUI-Idol pack (Nynxz, pinned at 4d3a4f67): image-to-splat-idol with the same node ids, except: ' +
      'IdolPreprocessImage 88:110 replaces TripoSplatPreprocessImage 88:2 and the core photo crop 88:101-104 (cropMode synthetic = Idol\'s 1.2 crop, real = its 1.7 photo crop; ' +
      'the mask is Fuobe\'s cut-out switch 88:35, BiRefNet or the picture\'s alpha; erode 1, 1024 px). ' +
      'IdolPruneSplat 88:111 after the decoder drops the near-transparent Gaussians (minOpacity 0.05; maxScale 0 = off, 0.05 = "Trim spikes", the needle-shaped ones at the silhouette): ' +
      'the saved file and the orbit video both get the pruned splat. Its count of the Gaussians kept goes to a PreviewAny (94, role report; the first item of a batch), which the result card shows. ' +
      'IdolCamera 88:112 reads the camera Idol predicted from the KSampler\'s latent; RenderSplat 88:113 renders the pruned splat from it (1 frame, 1024 px, black) and SaveImage 93 keeps it ' +
      '(role preview: the card\'s poster, what the model saw). The pack has no Python dependencies; ComfyUI v0.23.0 or later (Fuobe runs 0.41.0). ' +
      'Same weights, sampler presets and VRAM listing as image-to-splat-idol.',
  },
  {
    // idol-7 (docs/research/idol-9.md §2.1, §2.4, §9): Idol's splat turned into a rough vertex-coloured mesh by core SplatToMesh.
    id: 'image-to-mesh-idol',
    title: 'Image to a rough vertex-coloured 3D mesh (Idol splat -> core Extract Mesh from Splat, GLB, no textures) + an orbit video',
    capability: 'image-to-3d',
    handBuilt: 'hand-built/image-to-mesh-idol.json',
    bindings: {
      image: [b('99', 'image')], cutout: [b('88:35', 'switch')], numGaussians: [b('88:55', 'num_gaussians')], steps: [b('88:6', 'steps')], cfg: [b('88:6', 'cfg')],
      sampler: [b('88:6', 'sampler_name')], photoCrop: [b('88:104', 'switch')],
      seed: [b('88:6', 'seed'), b('88:55', 'seed')], orbitFrames: [b('75', 'frames')], meshResolution: [b('93', 'resolution')],
    },
    // The mesh has no role, as every image-to-3D graph's GLB (the server's finish and the viewer take it as the model).
    outputs: [{ node: '51', kind: 'model3d' }, { node: '42', kind: 'video', role: 'turntable' }],
    defaults: { cutout: true, photoCrop: false },
    vramGb: 8,
    license:
      'Apache-2.0 (speridlabs/idol weights; the ComfyUI files are nynxz/Idol\'s conversion, Apache-2.0); Idol is VAST-AI-Research\'s TripoSplat architecture (MIT, code and weights); ' +
      'the dino_v3_vit_h image encoder is under the DINOv3 License (royalty-free, commercial use allowed, trade-control limits; ' +
      'the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT',
    notes:
      'Idol 3D quick mesh: image-to-splat-idol (same node ids, Best settings: 50 Euler steps, cfg 4, 262,144 Gaussians; photoCrop the looser photo crop) with the splat file replaced by core SplatToMesh 93 ' +
      '("Extract Mesh from Splat", comfy_extras/nodes_gaussian_splat.py): a density grid of meshResolution along the longest axis (384 by default, 64-768 in steps of 16; memory and time grow with its cube), ' +
      'kernel 5, no smoothing, level 0.4, components under 500 vertices dropped, and Gaussians under min_opacity 0.02 ignored, which leaves out the near-transparent haze. ' +
      'SaveGLB 51 writes one self-contained binary GLB (the model output, no role): vertex colours (COLOR_0) under an unlit material (KHR_materials_unlit), no UVs, no textures, no PBR. ' +
      'The 75-frame orbit video (role turntable) is the splat\'s, thresholded at 0.05; after the job the Fuobe server finishes the GLB like every image-to-3D route (web GLB, pivot at the bottom) ' +
      'and, when Chromium and ffmpeg are there, replaces that video with a turntable of the mesh itself. Mesh quality from Idol splats is unmeasured: a rough mesh to rig or to refine, not a finished asset. ' +
      'Same weights as image-to-splat-idol (1.32 GB of Idol files plus the shared 2.46 GB). VRAM: vendor peak 7.2 GB in the SDK for the splat; SplatToMesh\'s own peak at 384 unmeasured.',
  },
  {
    // idol-8 (docs/research/idol-9.md §8, §9 idol-8): the other sides of an object from one picture, for From several images
    // (TRELLIS.2 multi-view) and Elements. Needs the ComfyUI-Idol pack (IdolCamera); there is no core-node fallback.
    id: 'image-to-views-idol',
    title: 'Four views of one object from one picture (Idol splat, rendered from its predicted camera: front, left, back, right)',
    capability: 'splat',
    handBuilt: 'hand-built/image-to-views-idol.json',
    packs: ['ComfyUI-Idol'],
    bindings: {
      image: [b('99', 'image')], cutout: [b('88:35', 'switch')], numGaussians: [b('88:55', 'num_gaussians')], steps: [b('88:6', 'steps')], cfg: [b('88:6', 'cfg')],
      sampler: [b('88:6', 'sampler_name')], cropMode: [b('88:110', 'mode')], minOpacity: [b('88:111', 'min_opacity')], maxScale: [b('88:111', 'max_scale')],
      seed: [b('88:6', 'seed'), b('88:55', 'seed')],
    },
    // One batch of four (meta.index 0-3 = front, left, back, right; the provider names each side).
    outputs: [{ node: '96', kind: 'image', role: 'tiles' }],
    defaults: { cutout: true, cropMode: 'synthetic', minOpacity: 0.05, maxScale: 0 },
    limits: { maxGaussians: 1048576 },
    vramGb: 8,
    license:
      'Apache-2.0 (speridlabs/idol weights; the ComfyUI files are nynxz/Idol\'s conversion, Apache-2.0); Idol is VAST-AI-Research\'s TripoSplat architecture (MIT, code and weights); ' +
      'the dino_v3_vit_h image encoder is under the DINOv3 License (royalty-free, commercial use allowed, trade-control limits; ' +
      'the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT; ComfyUI-Idol nodes Apache-2.0',
    notes:
      'Fill the other sides from one picture: image-to-splat-idol-clean up to the pruned splat (IdolPreprocessImage 88:110, the sampler 88:6, ' +
      'the decoder 88:55, IdolPruneSplat 88:111 at minOpacity 0.05), then RenderSplat 88:120 from IdolCamera 88:112 (the camera Idol predicted for the input picture) ' +
      'with frames 4: a full turn in four steps of 90°, starting at the input view, 1024 px on white, opacity_threshold 0.05. SaveImage 96 keeps the batch: ' +
      'index 0 is the front (the input view), 1 the object\'s left, 2 its back, 3 its right. The sign of frames sets the direction: +4 turns the camera ' +
      'about world +Y (three.js, Y up) toward the viewer\'s right, which is the object\'s left (checked with an asymmetric splat through RenderSplat on 0.41.0); -4 would give the right first. ' +
      'No splat file and no orbit video are saved. The views are renders of a 3D reconstruction and can look soft; faces of real people are the hardest case, so check them before use. Same weights, presets and VRAM listing as image-to-splat-idol.',
  },
  {
    // Photo to 3D (app-photo-to-3d) and Image to 3D's quick model: Idol (TripoSplat's architecture, new weights) on core nodes,
    // its splat turned into a GLB with core SplatToMesh (docs/research/idol-9.md §5.5).
    id: 'image-to-3d-idol',
    title: 'Image to a 3D model (.glb) + its Gaussian splat + an orbit video (Idol on core TripoSplat nodes, SplatToMesh)',
    capability: 'image-to-3d',
    handBuilt: 'hand-built/image-to-3d-idol.json',
    bindings: {
      image: [b('99', 'image')], cutout: [b('88:35', 'switch')], photoCrop: [b('88:104', 'switch')], seed: [b('88:6', 'seed'), b('88:55', 'seed')],
      steps: [b('88:6', 'steps')], cfg: [b('88:6', 'cfg')], sampler: [b('88:6', 'sampler_name')], numGaussians: [b('88:55', 'num_gaussians')],
      splatFormat: [b('92', 'format')], orbitFrames: [b('75', 'frames')], meshDetail: [b('60', 'resolution')], frontYaw: [b('79', 'mode.yaw'), b('80', 'mode.yaw')],
    },
    outputs: [{ node: '61', kind: 'model3d' }, { node: '51', kind: 'model3d', role: 'splat' }, { node: '42', kind: 'video', role: 'orbit' }, { node: '77', kind: 'image' }],
    defaults: { splatFormat: 'spz', cutout: true, photoCrop: false },
    limits: { maxGaussians: 1048576 },
    vramGb: 10,
    license:
      'Apache-2.0 (speridlabs/Idol weights, via nynxz/Idol; built on TripoSplat, MIT, VAST-AI-Research); the dino_v3_vit_h image encoder is under the DINOv3 License ' +
      '(royalty-free, commercial use allowed, trade-control limits; the app must show a "Built with DINOv3" notice); FLUX.2 VAE Apache-2.0; BiRefNet MIT',
    notes:
      'One photo of one person or product -> a vertex-coloured GLB (main output, no role: the server makes its web GLB), the splat (role splat, .spz), ' +
      'a 4 s orbit of the splat (role orbit: the server skips its mesh turntable) and a front still (the poster). image-to-splat-triposplat with Idol\'s files and ' +
      'reference sampler (50 euler steps, cfg 4; the shift 3 is built into the TripoSplat model class). BiRefNet cut-out (cutout false = the image\'s own alpha), ' +
      'then TripoSplatPreprocessImage = Idol\'s "synthetic" 1.2 crop; photoCrop true scales it to 720 px on a black 1024 square, about Idol\'s "real" 1.7 crop (core nodes, not run). ' +
      'SplatToMesh (meshDetail = its grid, 384 by default; min_opacity 0.05 drops Idol\'s faint halo, which RenderSplat\'s opacity_threshold 0.05 also hides in the clip and still; ' +
      'the .spz keeps it: no core node prunes a splat). frontYaw turns the orbit\'s start and the still to the subject\'s front (calibrated on the GPU). ' +
      'Backdrop #ece4da, the middle of the server turntable\'s studio sweep. New weights 1.32 GB (idol_fp16 0.74, idol_decoder_fp16 0.58); with TripoSplat\'s shared ' +
      'DINOv3 ViT-H, FLUX.2 VAE and BiRefNet 3.78 GB. On an RTX 5090 a photo takes about 3.5 min with its orbit clip; the first run peaked at 12.7 GB on the card. frontYaw 90 turns the orbit and the still to the front.',
  },
  {
    // N7-5: Cinema's "Film this path" on the open engine (docs/research/new-models-7.md §3.6, the wan21-i2v-uni3c-path table).
    id: 'wan21-i2v-uni3c-path',
    title: 'Fly path: a still filmed along a camera path, Wan 2.1 I2V guided by Uni3C on a browser render of the path (core nodes)',
    capability: 'camera-path',
    handBuilt: 'hand-built/wan21-i2v-uni3c-path.json',
    bindings: {
      image: [b('5', 'image')], video: [b('7', 'file')], prompt: [b('10', 'text')], negativePrompt: [b('11', 'text')],
      width: [b('12', 'width')], height: [b('12', 'height')], seed: [b('13', 'seed')], steps: [b('13', 'steps')], cfg: [b('13', 'cfg')],
      shift: [b('18', 'shift')], strength: [b('9', 'strength')], checkpoint: [b('1', 'unet_name')], filenamePrefix: [b('16', 'filename_prefix')],
    },
    outputs: [{ node: '16', kind: 'video' }],
    defaults: { fps: 16, checkpoint: 'wan2.1_i2v_720p_14B_fp8_scaled.safetensors' },
    limits: { maxWidth: 1280, maxHeight: 1280, dimensionMultiple: 16, maxFrames: 81, frameStep: 4 },
    vramGb: 48,
    optionalModels: ['Wan2_1-I2V-14B-480p_fp8_e4m3fn_scaled_KJ.safetensors'],
    license: 'Apache-2.0 (Wan 2.1 I2V 14B; Uni3C, alibaba-damo-academy/Uni3C — Kijai\'s repack repo carries no licence field)',
    notes:
      'Cinema 3D scene "Film this path": the still is the start image (WanImageToVideo, 81 frames, CLIP vision H) and the browser\'s render of the MoGe mesh or ' +
      'point cloud along the path (81 frames, 16 fps, black where nothing was seen) is the `video`, which core ' +
      'WanUni3CControlnetApply encodes with the Wan VAE as Uni3C\'s render_video (it pads or cuts it to the latent\'s frame count and resizes it, centre crop, to the ' +
      'output size; it has no hole-mask input, so the render\'s mask stays in the browser). Model path: UNETLoader -> ModelSamplingSD3 (shift 5) -> ' +
      'Uni3C (strength 1, 0-1) -> KSampler (30 steps, cfg 5, uni_pc / simple; Uni3C\'s own sampler settings are 50 steps at cfg 5). ' +
      'Weights: Kijai/WanVideo_comfy Wan21_Uni3C_controlnet_fp16 @ 8260d429 in models/model_patches (its header has every key core ModelPatchLoader\'s Uni3C branch ' +
      'reads) and Wan 2.1 I2V 14B 720P fp8 scaled (Comfy-Org/Wan-2.1 @ 123acf1c), the base Uni3C was trained on. The 480P Q8 GGUF ' +
      'Fuobe uses for InfiniteTalk can\'t load through a core node (UNETLoader reads no GGUF; that needs city96\'s ComfyUI-GGUF pack), so the core drop-in to try ' +
      'first on a smaller GPU is the 480P fp8 file the native InfiniteTalk graph uses (`checkpoint`): both are dim 5120, which the Uni3C node checks. ' +
      'VRAM: Uni3C\'s own figures are 46-51 GB with offload.',
  },

  // ---- Content Factory: read a reference video ---------------------------------------------
  {
    id: 'reference-brief-gemma4',
    title: 'Reference video to a style brief: Gemma 4 E4B reads the frames and the sound (core TextGenerate)',
    capability: 'write',
    handBuilt: 'hand-built/reference-brief-gemma4.json',
    bindings: {
      video: [b('1', 'video')], frames: [b('1', 'frame_load_cap')], startFrame: [b('1', 'skip_first_frames')], frameWidth: [b('1', 'custom_width')],
      checkpoint: [b('2', 'clip_name')], instruction: [b('3', 'prompt')], seed: [b('3', 'sampling_mode.seed')], maxTokens: [b('3', 'max_length')],
    },
    outputs: [{ node: '4', kind: 'text', role: 'brief' }],
    defaults: { fps: 24, checkpoint: 'gemma4_e4b_it_fp8_scaled.safetensors', instruction: handBuiltInput('./hand-built/reference-brief-gemma4.json', '3', 'prompt') },
    limits: { maxFrames: 720, frameStep: 1 },
    vramGb: 12,
    license: 'Apache-2.0 (Gemma 4); VideoHelperSuite loader GPL-3.0 code',
    notes:
      'Content Factory "Use as reference": the clip\'s frames AND sound go into one TextGenerate call and come back as a JSON style brief (role brief): format, hook, pacing, shots, visual_style, animation_style, ' +
      'narration, music, captions, topic_ideas (5). The instruction forbids copying the reference\'s people, logos or exact words. Strip ``` fences before parsing. ' +
      'VHS_LoadVideo resamples to 24 fps (fixed: TextGenerate assumes 24 fps and keeps every 24th frame, i.e. 1 fps, each capped at 70 soft tokens); frames = the frame cap at 24 fps (720 = the first 30 s), ' +
      'startFrame = frames skipped at 24 fps, frameWidth = 384 px wide (about 0.7 GB of frames for 720). In ComfyUI v0.41 only the Gemma 4 and MiniMax text encoders read a video input ' +
      '(the Qwen3.5 encoder ignores it). Same model file as speech-translate-gemma4 (no new download). For a long clip, brief the first 30 s (the default).',
  },
  // ---- round 4 (engine seams): vectorize -------------------------------------------
  {
    id: 'image-vectorize-vtracer',
    title: 'Image to SVG: VTracer traces the colours into stacked vector shapes (no model)',
    capability: 'vectorize',
    handBuilt: 'hand-built/image-vectorize-vtracer.json',
    bindings: {
      image: [b('1', 'image')],
      curveMode: [b('2', 'mode')],
      filterSpeckle: [b('2', 'filter_speckle')],
      colorPrecision: [b('2', 'color_precision')],
      filenamePrefix: [b('4', 'filename_prefix')],
    },
    outputs: [{ node: '4', kind: 'image' }],
    vramGb: 0,
    license: 'MIT (VTracer, ComfyUI-ToSVG); the pack also imports PyMuPDF (AGPL-3.0) for its SVG-to-image node, which this graph doesn\'t use',
    notes:
      'The open side of Recraft Vectorize / fal image2svg (the Vectorize app). ComfyUI-ToSVG\'s colour VTracer node (stacked layers, spline curves; curveMode polygon gives straight edges) ' +
      'returns the SVG as text, TS_SVGStringToSVGBytesIO wraps it and core SaveSVGNode writes fuobe/<id>_*.svg (reported under "images", so the provider collects it as an image output). ' +
      'filterSpeckle drops specks up to that many pixels, colorPrecision (1-8 bits per channel) sets how many colours are kept. Best on logos, icons and flat art; photos give very many paths. Runs on CPU in about a second.',
  },

  // ---- round 4 (r4/video-finish): FPS Boost to exact targets, chunked upscaling and export, HDR EXR ------------------
  {
    id: 'interpolate-rife-fps',
    title: 'FPS Boost and slow motion to an exact frame rate: interpolate by m, keep every n-th frame (core FrameInterpolate)',
    capability: 'interpolate',
    handBuilt: 'hand-built/interpolate-rife-fps.json',
    bindings: {
      video: [b('1', 'file')], checkpoint: [b('5', 'model_name')], multiplier: [b('6', 'value')], every: [b('8', 'value')], slowdown: [b('10', 'value')],
    },
    outputs: [{ node: '13', kind: 'video' }],
    defaults: { checkpoint: 'rife_v4.26.safetensors' },
    // oss-rife's Model control: FILM for large motion.
    optionalModels: ['film_net_fp16.safetensors'],
    limits: { maxMultiplier: 16 },
    vramGb: 2,
    license: 'RIFE 4.26 and FILM weights from Comfy-Org/frame_interpolation (MIT / Apache-2.0); VideoHelperSuite (GPL-3.0 code) for Select Every Nth',
    notes:
      'Higgsfield\'s FPS Boost targets (24 / 30 / 60 / 90 / 120 fps) and slow motion on the open engine. The provider picks m (multiplier, 2-16) and n (every) from the clip\'s own frame rate (its header) so that ' +
      'source fps x m / n = target x slowdown (24 -> 30 m5 n4, 24 -> 60 m5 n2, 24 -> 90 m15 n4, 24 -> 120 m5, 30 -> 60 m2, 60 -> 90 m3 n2, 60 -> 120 m2; a target the source rate is a whole multiple of (60 -> 30: m1 n2) only drops frames, ' +
      'and then the provider links FrameInterpolate out; other lower targets still interpolate (30 -> 24: m4 n5)). The output fps is computed in the graph from the decoded frame rate (source fps x m / (n x slowdown)); m and n need the header\'s rate, so the provider refuses a clip without one rather than guess. ' +
      'The last frame is held once more before interpolating, so the clip keeps its length (N frames become N x m + 1, about one output frame longer than the source) instead of losing a source frame. ' +
      'slowdown > 1 stretches the clip (2 = twice as long); the provider then drops the sound link (it would no longer match). checkpoint film_net_fp16.safetensors runs FILM (better on large motion, about 31x slower on CPU). ' +
      'Holds the whole interpolated clip in memory (the source frames, their copy with the last frame held, and source frames x m; the selection is a view): the provider refuses clips that need more than half the server\'s RAM. ' +
      'Frame counts and lengths, checked on CPU: 24 fps 2 s 320x180 -> 60 fps = 121 frames, 2.017 s (m 5, n 2); 25 fps 3 s with sound -> 30 fps at 2x slow motion = 181 frames, 6.03 s, no sound track; 30 fps 2 s with sound -> 24 fps = 49 frames, 2.04 s, sound kept (m 4, n 5).',
  },
  {
    id: 'upscale-video-esrgan-chunked',
    title: 'Video Upscale (Real-ESRGAN 4x) in passes of a few frames: memory stays flat whatever the length (VHS meta-batch)',
    capability: 'upscale-video',
    handBuilt: 'hand-built/upscale-video-esrgan-chunked.json',
    bindings: {
      video: [b('1', 'video')], framesPerBatch: [b('2', 'frames_per_batch')], upscaleModel: [b('3', 'model_name')], shortSide: [b('5', 'resize_type.shorter_size')],
    },
    outputs: [{ node: '7', kind: 'video' }],
    defaults: { shortSide: 1080 },
    limits: { maxWidth: 3840, maxHeight: 3840 },
    vramGb: 4,
    license: 'Real-ESRGAN weights (BSD-3-Clause); VideoHelperSuite GPL-3.0 code',
    notes:
      'R4-38: upscale-video-esrgan decodes the whole film (about 38 GB of float frames for 30 s at 480p before the 4x model). This one decodes framesPerBatch frames per pass (VHS_BatchManager re-queues the prompt ' +
      'until the clip is done, as mixed-media-zimage-frames does), upscales them with the model (tiled), scales them so the shorter edge is shortSide px (params.resolution: 1080p -> 1080, the shape kept) and pipes them ' +
      'into one ffmpeg H.264 encode that stays open across passes; the last pass writes the file with the source\'s sound at the source frame rate. The provider follows the passes by their filename prefix. ' +
      'framesPerBatch: the provider sizes it from the clip\'s header so a pass holds about 1.5 GB of frames (16 by default). Any spandrel model in models/upscale_models works as upscaleModel (x2 / x4). ' +
      'Tested on CPU with an x4 ESRGAN network: 30 s 256x144 25 fps with sound -> 1920x1080, 750 frames, AAC, 47 passes of 16 frames in 417 s, ComfyUI\'s RSS peaked 0.87 GB above idle (upscale-video-esrgan on 10 s of the same clip, 4x to 1024x576 only, peaked 3.0 GB above idle); through Fuobe a silent 2 s 24 fps clip -> 1280x720, 48 frames, no audio link.',
  },
  {
    id: 'upscale-video-seedvr2-chunked',
    title: 'Video Upscale / Restore (SeedVR2 3B int8) in passes of 4n+1 frames: memory stays flat (VHS meta-batch)',
    capability: 'upscale-video',
    handBuilt: 'hand-built/upscale-video-seedvr2-chunked.json',
    bindings: {
      video: [b('1', 'video')], framesPerBatch: [b('2', 'frames_per_batch')], shortSide: [b('3', 'resize_type.shorter_size')], seed: [b('9', 'seed')],
    },
    outputs: [{ node: '13', kind: 'video' }],
    defaults: { shortSide: 1080 },
    limits: { maxWidth: 3840, maxHeight: 3840 },
    vramGb: 16,
    license: 'SeedVR2 (Apache-2.0); VideoHelperSuite GPL-3.0 code',
    notes:
      'The native SeedVR2 nodes of upscale-video-seedvr2 (same files, same settings) run on framesPerBatch frames per pass (33 by default; SeedVR2 pads a pass to 4n+1 frames and crops the padding back) and the ' +
      'passes are piped into one H.264 encode with the source\'s sound, so a long clip no longer needs the whole film in memory (the template is capped at 20 s). The frames are first scaled so the shorter edge is ' +
      'shortSide px. Each pass is restored on its own: there is no temporal context across a pass boundary, so a seam every framesPerBatch frames is possible.',
  },
  {
    id: 'video-export-pro-chunked',
    title: 'Pro codec export in passes (ProRes 422 HQ / 4444, H.265 10-bit, FFV1, H.264): memory stays flat (VHS meta-batch)',
    capability: 'export-video',
    handBuilt: 'hand-built/video-export-pro-chunked.json',
    bindings: { video: [b('1', 'video')], framesPerBatch: [b('2', 'frames_per_batch')], format: [b('4', 'format')], profile: [b('4', 'profile')] },
    outputs: [{ node: '4', kind: 'video' }],
    defaults: { format: 'video/ProRes', profile: 'hq' },
    vramGb: 0,
    license: 'n/a (no model; VideoHelperSuite GPL-3.0 code and the system ffmpeg\'s prores_ks / libx265 / ffv1 / libx264 encoders)',
    notes:
      'video-export-pro with VHS_LoadVideo decoding framesPerBatch frames per pass (64 by default) into one VHS_VideoCombine encode that stays open across passes, at the source frame rate, with the source\'s sound: ' +
      'the export Fuobe\'s Export mode runs (video-export-pro decodes the whole clip). Same params.format mapping (prores_422_hq -> video/ProRes + hq, prores_4444 -> + 4444, h265_10bit -> video/h265-mp4 (yuv420p10le), ' +
      'ffv1 -> video/ffv1-mkv, h264 -> video/h264-mp4; exr -> video-export-exr). VHS lists only <prefix>_00001-audio.<ext> when the clip has sound, <prefix>_00001.<ext> otherwise, on the last pass. ' +
      'Caveat: VHS\'s ProRes "hq" profile leaves the pixel format to prores_ks, which picks yuv444p10le for the RGB frames, so "ProRes 422 HQ" is the HQ profile (apch) carrying 4:4:4 10-bit samples ' +
      '(FFmpeg decodes it; a strict 4:2:2 file needs a VHS format with -pix_fmt yuv422p10le, which would be a change to the node pack). The same holds for video-export-pro. ' +
      'Tested on CPU (3 s 320x180 25 fps clip with sound): ProRes apch / yuv444p10le / PCM and H.265 Main 10 yuv420p10le with AAC; on a silent 2 s 24 fps clip FFV1 gbrap16le .mkv, 48 of 48 frames; each ffprobe-checked.',
  },
  // ---- Open-H3 Regenerate 2K (package n7-3-regenerate-2k; docs/research/new-models-7.md §2.6): Upscale → Video's
  // "Regenerate · creative", the "Regenerate in 2K" result action and the Canvas Upscale node's choice, on your GPU only.
  {
    id: 'video-regenerate-h3',
    title: 'Regenerate a soft clip at 1080p, 2K or 4K: Open-H3 Regenerate 2K (MiniMax H3 FL2VA + NVIDIA\'s refiner LoRA, 3 Euler steps, the LBH latent upscaler, the fast H3 VAE decoder) (ComfyUI-Open-H3-Regenerate + LBH packs)',
    capability: 'upscale-video',
    handBuilt: 'hand-built/video-regenerate-h3.json',
    packs: ['ComfyUI-Open-H3-Regenerate', 'Comfyui_Minimax_h3_latent_Upscaler'],
    bindings: {
      video: [b('9', 'file')], prompt: [b('16', 'text')], resolution: [b('17', 'resolution')], draftSize: [b('11', 'size')],
      frames: [b('11', 'max_frames')], startSigma: [b('19', 'start_sigma')], steps: [b('19', 'steps')], seed: [b('20', 'noise_seed')],
      startTime: [b('29', 'start_time')], duration: [b('29', 'duration')], filenamePrefix: [b('28', 'filename_prefix')],
    },
    outputs: [{ node: '28', kind: 'video' }],
    defaults: { resolution: '2k (2560x1440)', draftSize: '768p (1344x768)', frames: 121, startSigma: 0.8, steps: 3, fps: 24 },
    limits: { maxFrames: 360 },
    vramGb: 48,
    license:
      'MiniMax H3 Community License (the H3 FL2VA model, its video and audio VAEs, the packaged Qwen3-VL text encoder, NVIDIA\'s Open-H3-Regenerate-2K LoRA and the fast H3 VAE decoder, a distilled ' +
      'Model Derivative): territory EXCLUDES the US, the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the ' +
      'product\'s interface; Comfy\'s docs add that commercial use of locally made outputs needs a MiniMax licence · the LoRA\'s merged LightX2V Turbo v1.2 part Apache-2.0 (at 3ec17a3), its LMS Sharp ' +
      'part no stated licence · LBH latent upscaler weights Apache-2.0, its node code MIT · ComfyUI-Open-H3-Regenerate Apache-2.0 · Qwen3-VL-32B base Apache-2.0',
    notes:
      'rdh9616\'s "Open-H3 Regenerate 2K - Draft Video" example (ComfyUI-Open-H3-Regenerate at 9b686c5) without the note, the three PreviewAny nodes and OpenH3VideoToPrompt: the prompt goes straight into ' +
      'CLIPTextEncode 16, so nothing calls a server from inside the graph. curve_name "none" (the tensors of the Sharp curve branches are zero in the blocks checked), so the curve table is never read ' +
      '("(model\'s own table)": no 21 GB ref2va file needed). A Video Slice (29) in front cuts the 15 s window a longer clip is regenerated in (startTime, duration; 0 = the whole clip). ' +
      'Prepare Draft (11) resamples to 24 fps, cover-crops to draftSize (768p for H3 drafts, 576p for other models; a portrait clip gets the preset turned, and any other shape is cropped to 16:9, since the upscale always targets 16:9 or 9:16) and ' +
      'cuts frames (round(seconds x 24), at most 360 = 15 s per pass); Save Refined Latent (24) and Finish (26) read its frame count. The LBH upscaler puts the latent on the target grid ' +
      '(resolution: 1080p (1920x1080) | 2k (2560x1440) | 4k (3840x2160), 4K via 2K), the refine re-noises it to startSigma (0 = the release 0.909 grid; Close 0.7, Balanced 0.8) and runs steps (3, or 2 = ' +
      'Faster) Euler steps at CFG 1 with Sol-Attn sparse attention and the audio held as encoded silence; the refined latent is saved before decoding (output/open_h3_latents/, redo a failed decode with ' +
      'rdh\'s "Decode Saved Latent" graph) and decoded by the fast H3 VAE decoder (tiled H3 VAE fallback). Finish trims the padding, crops 1088 -> 1080 and 2176 -> 2160 and cuts the draft\'s own sound to ' +
      'length, which CreateVideo muxes back at 24 fps. Measured by the pack\'s author: about 3 min per 5 s at 2K on a 72 GB RTX PRO 5000 (9.5 min with dense attention); 22 s on a B200 (NVIDIA); ' +
      'a community run reached about 1080p on 32 GB with a lossy LoRA. The packs were tested by their author on ComfyUI 0.42.0.',
  },
  // ---- Regenerate in Cinema and the Video studio (package n7-10-regenerate-more; docs/research/new-models-7.md §2.10 row 8): a
  // MiniMax H3 take drafted at 768p that keeps its latent, and the 2K finish that starts from that latent (no decode and
  // re-encode in between), from rdh9616's "Prompt to 2K" and "Decode Saved Latent" examples at 9b686c5.
  {
    id: 'video-h3-t2v-2k',
    title: 'MiniMax H3 text to video at 768p that keeps its latent for a 2K finish (FL2VA + LightX2V Turbo 4-step v1.2, 6 steps er_sde; ComfyUI-Open-H3-Regenerate saves the latent)',
    capability: 't2v',
    handBuilt: 'hand-built/video-h3-t2v-2k.json',
    packs: ['ComfyUI-Open-H3-Regenerate'],
    bindings: {
      prompt: [b('10', 'prompt')],
      width: [b('10', 'width')], height: [b('10', 'height')], frames: [b('10', 'length')],
      seed: [b('11', 'noise_seed')], steps: [b('13', 'steps')],
      latentPrefix: [b('20', 'filename_prefix')], filenamePrefix: [b('19', 'filename_prefix')],
    },
    outputs: [{ node: '19', kind: 'video' }],
    defaults: { width: 1344, height: 768, frames: 124, fps: 24, steps: 6 },
    limits: { maxFrames: 362, dimensionMultiple: 32 },
    vramGb: 32,
    license: `${H3_LICENSE} · LightX2V FL2V Turbo 4-step v1.2 LoRA Apache-2.0 (its card at 3ec17a3) · ComfyUI-Open-H3-Regenerate Apache-2.0`,
    notes:
      'The draft half of rdh9616\'s "Open-H3 Regenerate 2K - Prompt to 2K" example: MiniMaxH3ImageToVideo with no frames given (text to video with sound), the FL2VA pruned int8 model with ' +
      'LightX2V\'s FL2V Turbo 4-step v1.2 LoRA at 1.0 (core LoraLoaderModelOnly), BasicScheduler simple 6 steps, er_sde, CFG 1, decoded with the fp16 H3 video VAE. Between the sampler and the ' +
      'decoder, Save Refined Latent (20) writes the 768p latent with its soundtrack to output/open_h3_latents/<latentPrefix>_00001.safetensors (Fuobe names it after the run), so "Finish in 2K" ' +
      '(video-regenerate-h3-latent) upscales that latent straight away instead of re-encoding the decoded draft. The pack is opt-in (OPEN_H3_REGEN=1). rdh measured about 2 min for a 5 s draft ' +
      '(6 x 16 s) on a 72 GB RTX PRO 5000.',
  },
  {
    id: 'video-regenerate-h3-latent',
    title: 'Finish a 768p MiniMax H3 draft in 2K from its saved latent: Open-H3 Regenerate 2K without the decode and re-encode (ComfyUI-Open-H3-Regenerate + LBH packs)',
    capability: 'upscale-video',
    handBuilt: 'hand-built/video-regenerate-h3-latent.json',
    packs: ['ComfyUI-Open-H3-Regenerate', 'Comfyui_Minimax_h3_latent_Upscaler'],
    bindings: {
      latent: [b('1', 'latent_file')], prompt: [b('16', 'text')], resolution: [b('17', 'resolution')],
      startSigma: [b('19', 'start_sigma')], steps: [b('19', 'steps')], seed: [b('20', 'noise_seed')], filenamePrefix: [b('28', 'filename_prefix')],
    },
    outputs: [{ node: '28', kind: 'video' }],
    defaults: { resolution: '2k (2560x1440)', startSigma: 0.8, steps: 3, fps: 24 },
    vramGb: 48,
    license:
      'MiniMax H3 Community License (the H3 FL2VA model, its VAEs, the packaged Qwen3-VL text encoder, NVIDIA\'s Open-H3-Regenerate-2K LoRA and the fast H3 VAE decoder): territory EXCLUDES the US, ' +
      'the EU, the UK and South Korea; commercial use above US$20M yearly revenue needs MiniMax\'s written authorization; show "MiniMax H3" on the product\'s interface · LBH latent upscaler weights ' +
      'Apache-2.0, its node code MIT · ComfyUI-Open-H3-Regenerate Apache-2.0',
    notes:
      'video-regenerate-h3 started from a saved latent instead of a clip (rdh9616\'s "Decode Saved Latent" loader in front of the "Prompt to 2K" regenerate half): Load Refined Latent (1) reads the ' +
      'draft\'s output/open_h3_latents/ file by name (latent: the draft run\'s latentPrefix + _00001.safetensors, so it runs on the ComfyUI that made the draft), the LBH upscaler puts it on the ' +
      'target grid (resolution: 1080p | 2k | 4k), the refine re-noises it to startSigma (0.8, closer to the draft) and runs 3 Euler steps at CFG 1 with Sol-Attn and the prompt, the refined latent ' +
      'is saved again, the fast H3 VAE decoder decodes it, and Finish trims to the draft\'s frame count and puts the draft\'s own sound back at 24 fps.',
  },
  // ---- Character swap in 2K (docs/research/new-models-7.md §2.10 rows 4-5): only the swapped
  // character comes from the regenerate, over the original footage, with the footage's own sound.
  {
    id: 'video-composite-mask',
    title: 'Put only the swapped character back over the original footage: the 768p swap, then the regenerated one, each through the approved mask (grown, feathered), with the footage\'s sound (core nodes, no model)',
    capability: 'composite',
    handBuilt: 'hand-built/video-composite-mask.json',
    bindings: {
      video: [b('source', 'file')], video2: [b('regen', 'file')], video3: [b('take', 'file')], mask: [b('mask', 'file')],
      startTime: [b('source_slice', 'start_time')], windowStart: [b('regen_slice', 'start_time')], takeStart: [b('take_slice', 'start_time')], maskStart: [b('mask_slice', 'start_time')],
      duration: [b('source_slice', 'duration'), b('regen_slice', 'duration'), b('take_slice', 'duration'), b('mask_slice', 'duration')],
      canvasWidth: [b('take_scaled', 'width'), b('take_mask_img', 'width')], canvasHeight: [b('take_scaled', 'height'), b('take_mask_img', 'height')],
      takeX: [b('base', 'x')], takeY: [b('base', 'y')],
      regionWidth: [b('regen_mask_img', 'width')], regionHeight: [b('regen_mask_img', 'height')],
      regenWidth: [b('regen_scaled', 'width'), b('regen_trim', 'width')], regenHeight: [b('regen_scaled', 'height'), b('regen_trim', 'height')],
      trimX: [b('regen_trim', 'x')], trimY: [b('regen_trim', 'y')],
      regenX: [b('composite', 'x')], regenY: [b('composite', 'y')],
      maskGrow: [b('take_grow', 'expand'), b('regen_grow', 'expand')],
      feather: [b('take_feather', 'left'), b('take_feather', 'top'), b('take_feather', 'right'), b('take_feather', 'bottom'), b('regen_feather', 'left'), b('regen_feather', 'top'), b('regen_feather', 'right'), b('regen_feather', 'bottom')],
      filenamePrefix: [b('save', 'filename_prefix')],
    },
    outputs: [{ node: 'save', kind: 'video' }],
    defaults: { startTime: 0, windowStart: 0, takeStart: 0, maskStart: 0, duration: 3, canvasWidth: 320, canvasHeight: 180, takeX: 0, takeY: 0, regionWidth: 316, regionHeight: 180, regenWidth: 316, regenHeight: 179, trimX: 0, trimY: 0, regenX: 2, regenY: 0, maskGrow: 8, feather: 12 },
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'Character Swap Studio\'s Sharpen and Genjutsu\'s Character swap at 1080p / 2K / 4K on your GPU: a swap was redrawn by video-regenerate-h3, and only the character goes back over the footage, so the background and the sound stay as filmed. ' +
      'video = the footage at 24 fps and the film\'s size (the studio\'s 24 fps copy, or Genjutsu\'s part fitted by video-fit-clip), video3 = the 768p swap (H3\'s canvas), video2 = its regenerate, mask = the approved whole-shot mask from video-mask-h3-relay (H3\'s canvas, white = the person). ' +
      'Each LoadVideo goes through a Video Slice of the same duration (one composite window of at most 3 s, because every stream is decoded as float32, about 25 MB a frame at 1080p) from its own start (startTime, takeStart, windowStart, maskStart). ' +
      'Two layers, each through the mask scaled to it, grown (maskGrow) and feathered (feather): first the swap stretched back over the region of the footage its canvas covers (canvasWidth x canvasHeight at takeX, takeY), ' +
      'then the regenerate over the centre region its 16:9 / 9:16 draft kept (regionWidth x regionHeight; the mask is centre-cropped to it), less the rows its finish trims at 1080p and 4K (1080 of 1088, 2160 of 2176; the columns for a tall clip): ' +
      'the regenerate is laid over regenWidth x regenHeight at regenX, regenY and the mask cut to the same rows (CropMask at trimX, trimY), so a character reaching past that region keeps the 768p swap there rather than the original person. ' +
      'Fuobe works the regions out from the film\'s size and H3\'s canvas. CreateVideo takes the footage\'s own sound and rate (a silent clip stays silent). ' +
      'Run end to end on ComfyUI 0.41.0 (CPU): a 320x180 24 fps clip with sound, a 224x128 swap, a 384x216 regenerate and a 224x128 box mask, a 1.5 s window from 0.5 s: 36 frames and 1.5 s of AAC, the regenerate only inside the feathered box; the same with a silent clip gives video only.',
  },
  {
    id: 'video-sdr-to-hdr-exr',
    title: 'SDR to HDR as OpenEXR frames (scene-linear Rec.2020, half float) plus a 10-bit HLG preview (core, no model)',
    capability: 'sdr-to-hdr',
    handBuilt: 'hand-built/video-sdr-to-hdr-exr.json',
    bindings: { video: [b('1', 'file')], peakNits: [b('3', 'algorithm.target_luminance')] },
    outputs: [{ node: '6', kind: 'video', role: 'preview' }, { node: '4', kind: 'image', role: 'frames' }],
    vramGb: 0,
    license: 'n/a (no model; ComfyUI core)',
    notes:
      'params.format exr of the sdr-to-hdr operation (Higgsfield\'s "EXR 16-bit: uncompressed frame sequence for compositing"). The same ImageSDRToHDR expansion as video-sdr-to-hdr; SaveImageAdvanced writes each ' +
      'frame as a half-float EXR with input_color_space HDR, i.e. the inverse HLG curve: scene-linear light in Rec.2020 primaries, highlights above 1.0 kept. Node 6 saves the 10-bit HLG MP4 with the clip\'s sound as ' +
      'the result to watch (role preview); Fuobe zips the frames (role frames) and attaches the zip to it. Decodes the whole clip: RAM grows with the length (Fuobe refuses a clip too long for the memory it has). ' +
      'Tested through Fuobe on CPU (2 s 160x96 30 fps clip with sound): 60 half-float EXR frames zipped onto an H.264 High 10 HLG (arib-std-b67, bt2020) preview with AAC.',
  },
  // ---- NVIDIA RTX Video (nm10-rtx-video, docs/research/new-models-10.md §6): Comfy-Org's ComfyUI Nvidia VFX Nodes 0.2.1 on
  // NVIDIA's RTX Video SDK (nvidia-vfx). An NVIDIA RTX card only, no model files to download (the SDK's models ship in the wheel).
  {
    id: 'upscale-video-rtx',
    title: 'Video Upscale on an NVIDIA RTX card: RTX Video Super Resolution (1-4x) in passes of a few frames, sound kept (ComfyUI Nvidia VFX Nodes)',
    capability: 'upscale-video',
    handBuilt: 'hand-built/upscale-video-rtx.json',
    packs: ['ComfyUI_Nvidia_VFX_Nodes'],
    gpu: 'nvidia-rtx',
    bindings: {
      video: [b('1', 'video')], framesPerBatch: [b('2', 'frames_per_batch')], shortSide: [b('4', 'value')], rtxQuality: [b('6', 'quality')],
    },
    outputs: [{ node: '8', kind: 'video' }],
    defaults: { shortSide: 1080, rtxQuality: 'ULTRA' },
    limits: { maxWidth: 3840, maxHeight: 3840, maxScale: 4 },
    vramGb: 0,
    license:
      'NVIDIA Software License Agreement (2025-05-05) and Product-Specific Terms for NVIDIA AI Products: the nvidia-vfx 0.2.0.0 runtime (RTX Video SDK libraries and their models, ' +
      'bundled in the wheel; free, proprietary, runs only on NVIDIA GPUs, no redistributing or reverse engineering, no published benchmarks without NVIDIA\'s permission); ' +
      'the wheel also carries the NVIDIA Open Model License (models commercially usable; NVIDIA claims no outputs) · ComfyUI Nvidia VFX Nodes Apache-2.0 · VideoHelperSuite GPL-3.0 code',
    notes:
      'Built like upscale-video-esrgan-chunked: VHS_LoadVideo decodes framesPerBatch frames per pass (VHS_BatchManager re-queues the prompt until the clip is done) and one H.264 encode stays open across ' +
      'passes; the last pass writes the file with the source\'s sound at the source frame rate. RTX Video Super Resolution (node 6) scales by min(4, max(1, shortSide / the clip\'s shorter edge)) ' +
      '(ComfyMathExpression 5 from VHS_VideoInfo\'s loaded size), rounds the size to 8 and splits its own work into chunks of at most 16 MP of output; ResizeImageMaskNode 7 then lands exactly on shortSide ' +
      '(the shape kept). rtxQuality: ULTRA (compressed sources, the default) or HIGHBITRATE_ULTRA (clean, high-bitrate sources); LOW-HIGH are faster. Needs an NVIDIA RTX card, ComfyUI on a CUDA ' +
      'PyTorch (cu130 or newer, the pack\'s README) and a graphics driver of 570.190+ / 580.82+ / 590.44+ on Linux (570.65+ on Windows); no CPU, Apple or AMD path. The runtime ships its models, so ' +
      'nothing downloads at run time. The node\'s inputs follow the pack\'s schema at 38d790d.',
  },
  {
    id: 'fps-rtx-framegen',
    title: 'FPS Boost and slow motion on an RTX 40 series card or later: RTX Video Frame Generation by m, keep every n-th frame, cuts detected (ComfyUI Nvidia VFX Nodes)',
    capability: 'interpolate',
    handBuilt: 'hand-built/fps-rtx-framegen.json',
    packs: ['ComfyUI_Nvidia_VFX_Nodes'],
    gpu: 'nvidia-rtx-40',
    bindings: {
      video: [b('1', 'file')], multiplier: [b('6', 'value')], every: [b('8', 'value')], slowdown: [b('10', 'value')], rtxQuality: [b('7', 'mode')],
    },
    outputs: [{ node: '13', kind: 'video' }],
    defaults: { rtxQuality: 'MEDIUM' },
    limits: { maxMultiplier: 16 },
    vramGb: 0,
    license:
      'NVIDIA Software License Agreement (2025-05-05) and Product-Specific Terms for NVIDIA AI Products: the nvidia-vfx 0.2.0.0 runtime (RTX Video SDK libraries and their models, ' +
      'bundled in the wheel; free, proprietary, runs only on NVIDIA GPUs, no redistributing or reverse engineering, no published benchmarks without NVIDIA\'s permission); ' +
      'the wheel also carries the NVIDIA Open Model License (models commercially usable; NVIDIA claims no outputs) · ComfyUI Nvidia VFX Nodes Apache-2.0 · VideoHelperSuite GPL-3.0 code',
    notes:
      'interpolate-rife-fps with RTX Video Frame Generation in place of FrameInterpolate (same node ids, no model loader): the provider picks m (2-16) and n from the clip\'s frame rate so that ' +
      'source fps x m / n = target x slowdown, and links node 7 out when m is 1. The node returns (N - 1) x m + 1 frames for N inputs; the last frame is held once more first, so N source frames ' +
      'become N x m + 1 (the RIFE graph\'s count, fpsFrames). automatic_shot_change_detection is on, so a cut is not blended across. rtxQuality = the node\'s mode (LOW, MEDIUM (default), HIGH). ' +
      'Decodes the whole clip and holds source frames x m (the provider\'s RAM check counts it like RIFE). Needs an NVIDIA RTX 40 series card or later (the pack\'s README), a CUDA PyTorch ' +
      '(cu130 or newer) and a recent graphics driver; no CPU path. The node\'s inputs follow the pack\'s schema at 38d790d.',
  },
  {
    id: 'sdr-to-hdr-rtx',
    title: 'SDR to HDR on an NVIDIA RTX card: RTX Video HDR to BT.2020 HLG or PQ (HDR10), saved as 10-bit H.264 with matching colour tags (ComfyUI Nvidia VFX Nodes)',
    capability: 'sdr-to-hdr',
    handBuilt: 'hand-built/sdr-to-hdr-rtx.json',
    packs: ['ComfyUI_Nvidia_VFX_Nodes'],
    gpu: 'nvidia-rtx',
    bindings: { video: [b('1', 'file')], peakNits: [b('3', 'luminance')], colorSpace: [b('3', 'output_colorspace'), b('4', 'color_space')] },
    outputs: [{ node: '5', kind: 'video' }],
    defaults: { colorSpace: 'HDR', peakNits: 650 },
    limits: { minPeakNits: 400, maxPeakNits: 2000 },
    vramGb: 0,
    license:
      'NVIDIA Software License Agreement (2025-05-05) and Product-Specific Terms for NVIDIA AI Products: the nvidia-vfx 0.2.0.0 runtime (RTX Video SDK libraries and their models, ' +
      'bundled in the wheel; free, proprietary, runs only on NVIDIA GPUs, no redistributing or reverse engineering, no published benchmarks without NVIDIA\'s permission); ' +
      'the wheel also carries the NVIDIA Open Model License (models commercially usable; NVIDIA claims no outputs) · ComfyUI Nvidia VFX Nodes Apache-2.0',
    notes:
      'The learned alternative to video-sdr-to-hdr\'s inverse tone map: RTX Video HDR (the SDK\'s TrueHDR, with its DL-Debander pass) at peakNits (400-2000, 650 by default), contrast 100, ' +
      'saturation 100, middle grey 50. A ComfyUI IMAGE carries no colour metadata, so colorSpace binds both the node\'s output_colorspace and CreateVideo\'s color_space to the same value: ' +
      '"HDR" = BT.2020 HLG (params.format hlg_10bit), "HDR PQ" = BT.2020 PQ, HDR10\'s transfer (pq_10bit); CreateVideo writes 10 bits and SaveVideo an H.264 High 10 MP4 tagged ' +
      'bt2020nc / bt2020 / arib-std-b67 or smpte2084 (the same encode as video-sdr-to-hdr). The sound is kept. EXR frames stay on video-sdr-to-hdr-exr. ' +
      'Decodes the whole clip: RAM grows with the length. Needs an NVIDIA RTX card and a CUDA PyTorch (cu130 or newer); no CPU path. The node\'s inputs follow the pack\'s schema at 38d790d.',
  },
  // ---- Kandinsky 6.0 (research #10, package nm10-kandinsky6) -------------------------------------------------------------
  // Kandinsky Lab's packs (kandinsky6, kandinsky6-sr) aren't on the validation server: the graphs follow the packs' own
  // templates and are checked against the node definitions read from their source at the pinned commits.
  {
    id: 'kandinsky6-t2av',
    title: 'Kandinsky 6.0 text to video with sound and dialogue (distilled Lite or Pro, 10 steps, 5 s at 24 fps)',
    capability: 't2v',
    handBuilt: 'hand-built/kandinsky6-t2av.json',
    packs: ['kandinsky6'],
    bindings: {
      prompt: [b('20', 'video_caption')], negativePrompt: [b('6', 'video_caption')],
      width: [b('7', 'width')], height: [b('7', 'height')], frames: [b('7', 'length')], fps: [b('7', 'fps')],
      seed: [b('8', 'seed'), b('20', 'seed')], unet: [b('1', 'unet_name')],
      filenamePrefix: [b('12', 'filename_prefix')],
    },
    outputs: [{ node: '12', kind: 'video' }],
    defaults: { width: 864, height: 480, frames: 121, fps: 24, frameStep: 4, unet: 'Kandinsky-6.0-Lite-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors' },
    limits: { maxFrames: 121, dimensionMultiple: 16, maxWidth: 2048, maxHeight: 2048 },
    // Pro (Quality) and the Prompt helper's Qwen3.5 9B (off by default: its nodes are taken out) are needed only when picked.
    optionalModels: ['Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors', 'qwen3.5_9b_bf16.safetensors'],
    requiredModels: ['bigvgan_vocoder/bigvgan_generator.pt', 'bigvgan_vocoder/config.json'],
    vramGb: 24,
    license: K6_LICENSE,
    notes: K6_NOTES,
  },
  {
    id: 'kandinsky6-i2av',
    title: 'Kandinsky 6.0 image to video with sound and dialogue (the image is the first frame; distilled Lite or Pro, 10 steps)',
    capability: 'i2v',
    handBuilt: 'hand-built/kandinsky6-i2av.json',
    packs: ['kandinsky6'],
    bindings: {
      prompt: [b('20', 'video_caption')], negativePrompt: [b('6', 'video_caption')], image: [b('30', 'image')],
      width: [b('7', 'width'), b('31', 'width')], height: [b('7', 'height'), b('31', 'height')], frames: [b('7', 'length')], fps: [b('7', 'fps')],
      seed: [b('8', 'seed'), b('20', 'seed')], unet: [b('1', 'unet_name')],
      filenamePrefix: [b('12', 'filename_prefix')],
    },
    outputs: [{ node: '12', kind: 'video' }],
    defaults: { width: 864, height: 480, frames: 121, fps: 24, frameStep: 4, unet: 'Kandinsky-6.0-Lite-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors' },
    limits: { maxFrames: 121, dimensionMultiple: 16, maxWidth: 2048, maxHeight: 2048 },
    // Pro (Quality) and the Prompt helper's Qwen3.5 9B (off by default: its nodes are taken out) are needed only when picked.
    optionalModels: ['Kandinsky-6.0-Pro-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors', 'qwen3.5_9b_bf16.safetensors'],
    requiredModels: ['bigvgan_vocoder/bigvgan_generator.pt', 'bigvgan_vocoder/config.json'],
    vramGb: 24,
    license: K6_LICENSE,
    notes:
      K6_NOTES +
      ' Image to video: the picture is cropped to the clip\'s size (ImageScale, centre), encoded with the VAE and appended as the reference tail (Kandinsky6ImageToVideoAudio, the I2VA template), which Kandinsky6RemoveReferenceLatent takes off before decoding. The prompt helper also sees the picture.',
  },
  {
    id: 'video-upscale-kandinsky6-vsr',
    title: 'Kandinsky VSR video upscale: 2x, 2.25x (480p to 1080p) or 4x, tiled, keeps the sound (clips up to 121 frames)',
    capability: 'upscale-video',
    handBuilt: 'hand-built/video-upscale-kandinsky6-vsr.json',
    packs: ['kandinsky6-sr'],
    bindings: {
      video: [b('1', 'file')], seed: [b('6', 'seed')], scale: [b('6', 'scale')], upscalerScale: [b('5', 'target_scale')],
      filenamePrefix: [b('8', 'filename_prefix')],
    },
    outputs: [{ node: '8', kind: 'video' }],
    defaults: { scale: '2.25x', upscalerScale: '2x' },
    limits: { maxDurationSec: 5 },
    requiredModels: [
      'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/transformer/config.json', 'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/vae/config.json',
      'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/latent_upscaler/config.json', 'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/model_index.json',
      'Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/scheduler/scheduler_config.json',
    ],
    vramGb: 24,
    license: 'MIT (Kandinsky 6.0 VSR weights, kandinskylab/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers); kandinsky6-sr pack code Apache-2.0',
    notes:
      'The kandinsky6-sr pack\'s Video Super Resolution template, with Fuobe\'s bindings: LoadVideo -> GetVideoComponents -> Kandinsky6VSRUpscale (the 2-step distilled VSR DiT from Load Diffusion Model, ' +
      'the K-VAE and the latent upscaler bank; tiled diffusion in latent space, overlap 0.2, NABLA attention off) -> CreateVideo with the clip\'s own sound (trimmed to the frames kept) -> SaveVideo. ' +
      'scale = params.resolution as the pack\'s combo ("2x", "2.25x", "4x"); upscalerScale = the bank entry it needs ("2x" for 2x and 2.25x, "4x" for 4x). ' +
      'The pack resamples the clip to 24 fps and keeps at most 121 frames (about 5 s): Fuobe refuses a longer clip rather than cut it. 2x and 4x need sides that are multiples of 16. ' +
      'Each loader lists a file only with its config.json beside it (the eight files of the SR README\'s manual-download table, in diffusion_models/Kandinsky-6.0-VSR-distilled2steps-5s-Diffusers/). ' +
      'VRAM is not published: 24 GB is an estimate (a 3.19 GB DiT, a 6.96 GB K-VAE and a 7.31 GB latent upscaler bank, loaded one stage at a time). The same model runs on fal (kandinsky-vsr).',
  },
  // ---- World mode: Hy-Nomas (research #10 §6.14, package nm10-hy-nomas-world) ----------------------------------------------
  // Nynxz's ComfyUI-HyNomas isn't on the validation server: the graph follows its nomas_world example and is checked against
  // the node definitions read from its source at the pinned commit (tests/world-mode.test.ts).
  {
    id: 'world-hy-nomas-turn',
    title: 'World mode: one turn of a Hy-Nomas world (the opening and every turn before it, then this turn in words and a camera move, 1280x704 at 24 fps)',
    capability: 'world-turn',
    handBuilt: 'hand-built/world-hy-nomas-turn.json',
    packs: ['ComfyUI-HyNomas'],
    expand: 'world',
    bindings: {
      prompt: [b('4', 'scene')], seed: [b('6', 'seed')], width: [b('6', 'width')], height: [b('6', 'height')],
      steps: [b('6', 'steps'), b('8', 'steps')], filenamePrefix: [b('12', 'filename_prefix')],
    },
    outputs: [{ node: '12', kind: 'video' }],
    defaults: { width: 1280, height: 704, steps: 8, fps: 24 },
    limits: { maxDurationSec: 12, dimensionMultiple: 32 },
    // The bf16 DiT (17.1 GB) is the base for LoRA merges, never needed for a run.
    optionalModels: ['nomas_dit_distilled_bf16.safetensors'],
    vramGb: 24,
    license:
      'Apache-2.0 (Hy-Nomas DiT, Tencent Hunyuan; the ComfyUI files are nynxz/Hy-Nomas\'s conversion); PixelUMM decoder (nomas_pixelumm_vae_bf16, Tencent\'s fine-tune of NVIDIA PixelUMM): ' +
      'NVIDIA One-Way Noncommercial License (NON-COMMERCIAL research and evaluation only, per the converted weights\' card); Qwen2.5-VL 7B text encoder Apache-2.0; ComfyUI-HyNomas nodes Apache-2.0',
    notes:
      'Nynxz\'s ComfyUI-HyNomas (pinned at a89e0515) on core loaders: UNETLoader (the distilled DiT, int8 ConvRot, 8.97 GB), CLIPLoader qwen_image (qwen_2.5_vl_7b, 16.6 GB, shared with Qwen-Image), ' +
      'VAELoader (the PixelUMM decoder, 15.8 GB): about 25 GB of files beside the shared text encoder. ' +
      'The template is the pack\'s nomas_world example: Nomas World Prompt (perspective, style, subject, scene, action, seconds) -> Nomas World (seed, 1280x704, 8 Euler steps, window history) with a Nomas Camera Path, ' +
      'then Nomas World Continue for a turn (change, action, camera, seconds). Fuobe rebuilds it per run: the opening and one Continue per turn up to the one asked for, ' +
      'each with a key script that flies along the turn\'s camera move (or no camera for a still turn), then TrimVideoLatent drops the earlier turns\' latents so VAE Decode -> CreateVideo 24 fps -> SaveVideo writes this turn alone. ' +
      'The port keeps a world in ComfyUI\'s memory (NOMAS_WORLD plus an int8 key/value cache in temp/nomas_history), and ComfyUI reuses the outputs of the last prompt it ran: the turns before this one have the same inputs and node ids every time, ' +
      'so only the new turn is generated; after another job or a restart they are generated again from the same seed. ' +
      'No sound (Hy-Nomas makes none). No image input: Hy-Nomas starts every world from words. ' +
      'Speed and VRAM are the port author\'s: about 21 s per 3 s turn plus about 4 s of decode per 10-latent window on an RTX 5090 at 1280x704 int8; Tencent\'s single-4090 configuration uses an int8 DiT and cache, ' +
      'an FP8 decoder and CPU offload; plan on a 24 GB card. The pack patches the core loaders\' model detection (Load Diffusion Model, Load VAE) to recognise the Nomas files.',
  },

  // ---- Genjutsu's Openjutsu modes (D3voz/openjutsu @ 7fe118bb, MIT): Group swap, Scene edit, From picture, Fix faces,
  // Fix colours. Fuobe's copies of its graphs (scripts/comfy/hand-built/), with the NVFP4 H3 text encoder, BFL's FLUX 3
  // Klein file name, the rank-64 SolarRenderer pair and words that name only what is wanted. The provider writes each
  // request's settings by node title (src/lib/openjutsu-graphs.ts, params.extra.openjutsu). Genjutsu trims and scales the
  // part first (video-fit-clip: 24 fps, the target short edge, the clip's sound), so the VHS loaders read it whole.
  {
    id: 'video-group-swap-h3',
    title: 'Group swap: 1-4 characters each take over one person, named by role (Openjutsu advanced: SAM 3.1 tracks, Qwen3-VL labels them, MiniMax H3 + DMAD redraw the labelled people clip by clip)',
    capability: 'video-group-swap',
    handBuilt: 'hand-built/video-group-swap-h3.json',
    packs: OJ_PACKS,
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    bindings: { video: [b('14', 'video')], image: [b('2', 'image')], image2: [b('5', 'image')], image3: [b('8', 'image')], image4: [b('11', 'image')] },
    outputs: [{ node: '82', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 15 },
    vramGb: 24,
    license: OJ_H3_LICENCE,
    notes:
      'video = the part (Genjutsu fits it first), image..image4 = the characters (unused pictures, their shrink and describer are deleted). params.extra.openjutsu: pictures, roles (one line each, ordinal fill), quality 480p | 720p (pack 736p) | 1080p, motion 512 | 768, hats, mouthsFollowSound, edge tight | normal | loose (20 / 40 / 60 px), seed. ' +
      'Every job runs under its own Context Loop run name (fuobe_<generation id>); the provider deletes output/h3_chains/<run> through the pack\'s run-folder routes once the result is in. Weights touched one stage after another: H3 21 GB, NVFP4 text encoder 15.7 GB, describer 9.4 GB, SAM 3.1 1.7 GB, VAEs 3.8 GB. Upstream timing: 6 s at 480p in 6-13 min on a 16 GB card.',
  },
  {
    id: 'video-group-swap-h3-one-by-one',
    title: 'Group swap, one by one: exactly 2 characters, each person redrawn on a pass of their own (Openjutsu advanced_maxq)',
    capability: 'video-group-swap',
    handBuilt: 'hand-built/video-group-swap-h3-one-by-one.json',
    packs: OJ_PACKS,
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    bindings: { video: [b('8', 'video')], image: [b('2', 'image')], image2: [b('5', 'image')] },
    outputs: [{ node: '96', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 15 },
    vramGb: 24,
    license: OJ_H3_LICENCE,
    notes: 'The same settings as video-group-swap-h3 with pictures 2; about twice as long, sharper on two people.',
  },
  {
    id: 'video-scene-edit-h3',
    title: 'Scene edit: change, remove or replace the background of what SAM 3.1 tracks, the rest of the shot and its sound kept (Openjutsu object, MiniMax H3 + DMAD)',
    capability: 'video-scene-edit',
    handBuilt: 'hand-built/video-scene-edit-h3.json',
    packs: OJ_PACKS,
    modelUrls: { 'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors' },
    bindings: { video: [b('5', 'video')], image: [b('2', 'image')] },
    outputs: [{ node: '55', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 15 },
    vramGb: 24,
    license: OJ_H3_LICENCE,
    notes:
      'params.extra.openjutsu: action change | remove | background, target (SAM words, comma list; background: what stays), becomes, picture (image sent), biggestOnly, keepShape, edge (10 / 20 / 40 px), motion, quality, seed, paint (one run-length keyframe at <= 256 px). ' +
      'Remove drops the picture and the grey shape; background flips the grown mask. Own run name and run-folder clean-up as video-group-swap-h3.',
  },
  {
    id: 'image-from-picture-prepare',
    title: 'From picture, first frame: FLUX 3 Image Klein puts the character in the pose of the part\'s first frame, in the picture\'s setting, or relights it (one pass)',
    capability: 'image-from-picture',
    handBuilt: 'hand-built/image-from-picture-prepare.json',
    packs: ['ComfyUI-VideoHelperSuite'],
    bindings: { video: [b('1', 'video')], startFrame: [b('1', 'skip_first_frames')], image: [b('4', 'image')] },
    outputs: [{ node: '21', kind: 'image' }],
    defaults: { fps: 24 },
    vramGb: 16,
    license: 'FLUX Kommunity License v1.0 (FLUX 3 Image Klein and its prompt upsampler) · Qwen3-VL 4B Apache-2.0 base · flux2-vae Apache-2.0',
    notes:
      'video = the clip, startFrame = round(part start x 24), image = the character (left out for the clip\'s own person). params.extra.openjutsu: light (the look\'s words), ownPerson, keepCrop (denoise 0.9 from the frame), adjust, seed; the canvas is the clip\'s shape at 768 px on the short side. ' +
      'A light rebuilds it as one pass: the upsampler writes the pose from the frame, FLUX sees only the character at 3 MP.',
  },
  {
    id: 'video-scene-describe',
    title: 'From picture, what happens: Qwen3-VL 8B describes the part at 2 fps and rewrites it for the approved first frame',
    capability: 'video-describe',
    handBuilt: 'hand-built/video-scene-describe.json',
    packs: ['ComfyUI-VideoHelperSuite'],
    bindings: { video: [b('1', 'video')], startFrame: [b('1', 'skip_first_frames')], image: [b('74', 'image')] },
    outputs: [{ node: '79', kind: 'text' }],
    defaults: { fps: 24 },
    vramGb: 12,
    license: 'Qwen3-VL 8B: Apache-2.0',
    notes: 'image = the approved first frame (left out for the clip\'s own person: pass 1 is then the description). params.extra.openjutsu: seconds, ownPerson. About 15-40 s.',
  },
  {
    id: 'character-describe-qwen3vl',
    title: 'Describe my character: Qwen3-VL 8B writes who the character in one picture is and what they wear (core TextGenerate)',
    capability: 'write',
    handBuilt: 'hand-built/character-describe-qwen3vl.json',
    bindings: { image: [b('1', 'image')] },
    outputs: [{ node: '5', kind: 'text' }],
    defaults: {},
    vramGb: 12,
    license: 'Qwen3-VL 8B: Apache-2.0',
    notes:
      'Genjutsu\'s Character swap, "Describe my character": image = the character\'s picture, scaled to 1024 px on its longest side. One sentence of 35 to 60 words in the form the swap prompt and the anchor brief take ' +
      '(who and their apparent age, build, face, hair, skin tone, each garment with its colour, fabric and cut, shoes, jewellery and accessories). The instruction is fixed in the graph: no text from the run goes in. ' +
      'Greedy decoding (sampling off): the same picture gives the same words. Same text encoder file as Qwen-Image 2.1 (no new download). About 4 s on an RTX 5090 once the model is loaded.',
  },
  {
    id: 'video-from-picture-solar',
    title: 'From picture, the video: SolarRenderer (MiniMax H3 + its 4-step and control LoRAs) animates the approved first frame with the part\'s motion as Metric3D normals; the clip\'s sound kept',
    capability: 'video-from-picture',
    handBuilt: 'hand-built/video-from-picture-solar.json',
    packs: [...OJ_PACKS, 'SolarRenderer', 'comfyui_controlnet_aux'],
    bindings: { video: [b('1', 'video')], image: [b('20', 'image')] },
    outputs: [{ node: '63', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 15 },
    vramGb: 24,
    autoDownloads: ['Metric3D vit-small (metric_depth_vit_small_800k.pth) -> custom_nodes/comfyui_controlnet_aux/ckpts/JUGGHM/Metric3D (fetched on first run unless placed there)'],
    license: `${OJ_H3_LICENCE} · SolarRenderer LoRAs (rank 64): MiniMax H3 Community License; SolarRenderer code Apache-2.0 · Metric3D BSD-2-Clause`,
    notes:
      'video = the fitted part, image = the approved first frame. params.extra.openjutsu: seconds (17k+5 frames at 24 fps), quality 480p | 720p (canvas clamped to 2048 px), motion 0 | 512 | 768, seed, scene (the editable description, opening the detailed description). ' +
      'Parts over 170 frames need SolarRenderer\'s long-clip patch, which the install script applies.',
  },
  {
    id: 'video-from-picture-h3',
    title: 'From picture, the video on native MiniMax H3 (DMAD, 6 steps) from the approved first frame and the part\'s normals',
    capability: 'video-from-picture',
    handBuilt: 'hand-built/video-from-picture-h3.json',
    packs: [...OJ_PACKS, 'comfyui_controlnet_aux'],
    bindings: { video: [b('1', 'video')], image: [b('20', 'image')] },
    outputs: [{ node: '63', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 15 },
    vramGb: 24,
    autoDownloads: ['Metric3D vit-small (metric_depth_vit_small_800k.pth) -> custom_nodes/comfyui_controlnet_aux/ckpts/JUGGHM/Metric3D (fetched on first run unless placed there)'],
    license: `${OJ_H3_LICENCE} · Metric3D BSD-2-Clause`,
    notes: 'A second renderer for From picture, on native MiniMax H3; the same settings as video-from-picture-solar.',
  },
  {
    id: 'video-motion-transfer-h3',
    title: 'Motion transfer on native MiniMax H3 (DMAD, 6 steps): the character photo as the look, the part\'s Metric3D normals as the motion, the clip\'s sound kept',
    capability: 'motion-transfer',
    handBuilt: 'hand-built/video-motion-transfer-h3.json',
    packs: [...OJ_PACKS, 'comfyui_controlnet_aux'],
    bindings: { video: [b('1', 'video')], image: [b('20', 'image')] },
    outputs: [{ node: '63', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 15 },
    vramGb: 24,
    autoDownloads: ['Metric3D vit-small (metric_depth_vit_small_800k.pth) -> custom_nodes/comfyui_controlnet_aux/ckpts/JUGGHM/Metric3D (fetched on first run unless placed there)'],
    license: `${OJ_H3_LICENCE} · Metric3D BSD-2-Clause`,
    notes: 'Genjutsu Motion transfer\'s "MiniMax H3" model (oss-h3-motion): video-from-picture-h3 with the character photo itself as Picture 1 (no prepared first frame) and words that put the character in the photo\'s setting. video = the part fitted at 24 fps, image = the character photo. params.extra.openjutsu: seconds, quality 480p | 720p, motion 0 | 512 | 768, seed (the same settings as From picture\'s video).',
  },
  {
    id: 'video-fix-faces-h3',
    title: 'Fix faces: H3-FaceRefine tracks the character\'s face, MiniMax H3 redraws it in overlapping sections and it is pasted back (faces over 20 % of the frame are left alone)',
    capability: 'video-fix-faces',
    handBuilt: 'hand-built/video-fix-faces-h3.json',
    packs: [...OJ_PACKS, 'ComfyUI-H3-FaceRefine', 'ComfyUI-Impact-Pack'],
    bindings: { video: [b('1', 'video')], image: [b('2', 'image')] },
    outputs: [{ node: '30', kind: 'video' }],
    defaults: {},
    limits: { maxDurationSec: 10 },
    vramGb: 24,
    autoDownloads: ['YOLO face and person detectors (ultralytics/bbox/face_yolov8m.pt, ultralytics/segm/person_yolov8m-seg.pt), SAM ViT-B (sams/sam_vit_b_01ec64.pth) and InsightFace buffalo_l (insightface/models/buffalo_l), as H3-FaceRefine documents'],
    license: `${OJ_H3_LICENCE} · YOLO face/person weights AGPL-3.0 · SAM ViT-B Apache-2.0 · InsightFace buffalo_l (identity tracking): NON-COMMERCIAL research only`,
    notes: 'video = the finished video, image = the character photo. params.extra.openjutsu: faceStyle photo | mouth, chunkSeconds 4 | 6.5 | 10, seed. H3FaceTrackCrop.select is largest_face (H3-FaceRefine 1.1.1). The whole clip is decoded and pasted back at full size (two frame-sized copies of every frame: 1080p 10 s is about 12 GB), so a part is fitted to 1080 px on its short side and kept to 10 s.',
  },
  {
    id: 'video-fix-colours',
    title: 'Fix colours: a soft film finish (Image Detail Contrast + Orion4D\'s DCTL tone mapper), no model',
    capability: 'video-tone',
    handBuilt: 'hand-built/video-fix-colours.json',
    packs: ['comfyui-image-detail-contrast', 'Orion4D_FXMax', 'ComfyUI-VideoHelperSuite'],
    bindings: { video: [b('1', 'video')], framesPerBatch: [b('5', 'frames_per_batch')] },
    outputs: [{ node: '4', kind: 'video' }],
    defaults: { framesPerBatch: 48 },
    limits: { maxDurationSec: 60 },
    vramGb: 2,
    license: 'n/a (no model; Image Detail Contrast MIT, Orion4D_FXMax MIT, VideoHelperSuite GPL-3.0 code)',
    notes: 'params.extra.openjutsu: finish soft | filmic | rich | off (the tone mapper\'s settings travel in raw_settings, no preset files), strength 0-1 (Orion 0-0.5), soften 0-1 (detail contrast 0 to -0.6; 0 drops the step). Both steps work frame by frame, so the clip goes through in passes (VHS_BatchManager re-queues the prompt until the clip is done, as upscale-video-esrgan-chunked does) into one H.264 encode that stays open; the last pass writes the file with the source\'s sound. framesPerBatch: the provider sizes it from the clip\'s header so a pass holds about 1.5 GB of frames (three frame-sized copies: decoded, softened, toned), so memory stays flat whatever the length.',
  },
  // Head Swap (app-head-swap): the BFS head-swap LoRA on the Qwen-Image 2.1 edit, then the new head pasted onto the untouched shot.
  {
    id: 'head-swap-qwen-image-21',
    title: 'Qwen-Image 2.1 Head Swap (BFS head LoRA V1.1, pasted back onto the shot)',
    capability: 'edit',
    handBuilt: 'hand-built/head-swap-qwen-image-21.json',
    bindings: {
      prompt: [b('30', 'prompt')], image: [b('10', 'image')], image2: [b('11', 'image')],
      seed: [b('32', 'seed')], steps: [b('32', 'steps')], loraStrength: [b('4', 'strength_model')],
      maskPrompt: [b('43', 'text')], maskGrow: [b('50', 'expand')], maskBlur: [b('50', 'blur_radius')], pasteBack: [b('52', 'switch')],
    },
    outputs: [{ node: '90', kind: 'image' }],
    defaults: { maskPrompt: 'head', maskGrow: 32, maskBlur: 16, pasteBack: true },
    limits: { maxWidth: 2048, maxHeight: 2048 },
    modelUrls: {
      'bfs_head_v1.1_qwen_2.1.safetensors': 'https://huggingface.co/Alissonerdx/BFS-Best-Face-Swap/resolve/0ca3913ade4b4ada458d60c232354e8586c4c181/bfs_head_v1.1_qwen_2.1.safetensors',
      'sam3.1_multiplex_fp16.safetensors': 'https://huggingface.co/Comfy-Org/sam3.1/resolve/7bb8374780a725b4353ed31f3a9395c9742b5621/checkpoints/sam3.1_multiplex_fp16.safetensors',
    },
    vramGb: 20,
    license: "Qwen Research License Agreement (Qwen-Image 2.1): NON-COMMERCIAL, research and evaluation only; BFS head-swap LoRA by Alissonerdx MIT; SAM 3.1 under Meta's SAM License (commercial use allowed under its terms); GrowMaskWithBlur from ComfyUI-KJNodes (GPL-3.0 code)",
    notes:
      "qwen-image-21-edit (int8, 25 steps, euler / simple, cfg 1, both pictures 2048 on the long side, resolution 0) with Alissonerdx's BFS head LoRA V1.1 at 1.0 and its training prompt " +
      '("head_swap: start with <image1> as the base image ..."). image = the shot to keep (body, pose, light, background), image2 = the head (identity, hair, eye colour): body first, head second, as V1.1 was trained; ' +
      'other BFS versions take other orders, so the file is pinned. V1.1 is V1 without the second-half img_mlp.gate_up modules (less skin softening, slightly weaker expression transfer); ' +
      "the V1.1 \"alternative\" file copies expression better at about 1 degree more head-pose error. Paste-back (pasteBack, on by default): SAM 3.1 finds the head (\"head\") on the swap and on the shot scaled to the swap's size, " +
      'the two masks are joined (ImageCompositeMasked of the mask images, so old long hair goes too), grown by maskGrow and blurred by maskBlur (GrowMaskWithBlur), and only that area comes from the swap: ' +
      "every other pixel is the shot's, which removes Qwen 2.1's colour and detail drift over the whole picture. pasteBack false returns the whole swap (the switch is lazy, SAM does not run). " +
      "No head found: the shot comes back unchanged. BFS's own workflow runs the Pruna 8-step LoRA with deis_2m (RES4LYF); this graph keeps core samplers. RTX 5090: about 130 s a photo warm, about 250 s when the models load, peak about 28 GB.",
  },
];
