#!/usr/bin/env node
// Build workflows/comfyui/<id>.json + manifest.json from library.spec.mjs.
//
//   node build-library.mjs            # all entries
//   node build-library.mjs wan22-i2v-14b flux1-dev-t2i
//
// Inputs:  build/raw/<key>.api.json + .meta.json (from export-templates.mjs),
//          hand-built/*.json, a running ComfyUI (for /object_info), Hugging Face (model sizes).
// Outputs: ../../workflows/comfyui/<id>.json, manifest.json, requirements.json (build-requirements.mjs, no network)
// The "validated" flag of each manifest entry is carried over from validation-state.json when the
// workflow file content is unchanged; run validate-workflows.mjs afterwards to (re)validate.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SPEC, KNOWN_MODELS, CUSTOM_NODE_REPOS, PACK_CLASSES } from './library.spec.mjs';
import * as G from './lib/graph.mjs';
import { resolveSource } from './export-templates.mjs';
import { packOfClass, writeIndex } from './build-requirements.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO, 'workflows', 'comfyui');
const RAW_DIR = path.join(HERE, 'build', 'raw');
const SIZE_CACHE = path.join(HERE, 'build', 'model-sizes.json');
export const STATE_FILE = path.join(HERE, 'validation-state.json');
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://127.0.0.1:8188';
const COMFYUI_DIR = process.env.COMFYUI_DIR || '/home/user/ComfyUI';

// Which input of which loader holds a model file, and the models/<folder> it is read from.
export const LOADER_FOLDERS = {
  UNETLoader: { unet_name: 'diffusion_models' },
  CheckpointLoaderSimple: { ckpt_name: 'checkpoints' },
  VAELoader: { vae_name: 'vae' },
  CLIPLoader: { clip_name: 'text_encoders' },
  DualCLIPLoader: { clip_name1: 'text_encoders', clip_name2: 'text_encoders' },
  QuadrupleCLIPLoader: { clip_name1: 'text_encoders', clip_name2: 'text_encoders', clip_name3: 'text_encoders', clip_name4: 'text_encoders' },
  LoraLoaderModelOnly: { lora_name: 'loras' },
  LoraLoader: { lora_name: 'loras' },
  CLIPVisionLoader: { clip_name: 'clip_vision' },
  UpscaleModelLoader: { model_name: 'upscale_models' },
  AudioEncoderLoader: { audio_encoder_name: 'audio_encoders' },
  ModelPatchLoader: { name: 'model_patches' },
  LatentUpscaleModelLoader: { model_name: 'latent_upscale_models' },
  LoadBackgroundRemovalModel: { bg_removal_name: 'background_removal' },
  LoadDA3Model: { model_name: 'geometry_estimation' },
  FrameInterpolationModelLoader: { model_name: 'frame_interpolation' },
  LTXAVTextEncoderLoader: { text_encoder: 'text_encoders', ckpt_name: 'checkpoints' },
  LTXVAudioVAELoader: { ckpt_name: 'checkpoints' },
  WanVideoModelLoader: { model: 'diffusion_models' },
  MultiTalkModelLoader: { model: 'diffusion_models' },
  WanVideoVAELoader: { model_name: 'vae' },
  WanVideoTextEncodeCached: { model_name: 'text_encoders' },
  WanVideoLoraSelect: { lora: 'loras' },
  Wav2VecModelLoader: { model: 'wav2vec2' },
  MMAudioModelLoader: { mmaudio_model: 'mmaudio' },
  MMAudioFeatureUtilsLoader: { vae_model: 'mmaudio', synchformer_model: 'mmaudio', clip_model: 'mmaudio' },
  ReActorFaceSwap: { swap_model: 'insightface', face_restore_model: 'facerestore_models' },
  // comfyui-oss-3 additions
  ImageOnlyCheckpointLoader: { ckpt_name: 'checkpoints' },
  MelBandRoFormerModelLoader: { model_name: 'diffusion_models' },
  HunyuanModelLoader: { model_name: 'foley' },
  HunyuanDependenciesLoader: { vae_name: 'foley', synchformer_name: 'foley' },
  ThinkSoundModelLoader: { thinksound_model: 'thinksound' },
  ThinkSoundFeatureUtilsLoader: { vae_model: 'thinksound', synchformer_model: 'thinksound' },
  // comfyui-oss-4 additions
  OpticalFlowLoader: { model_name: 'optical_flow' },
  LoadMoGeModel: { model_name: 'geometry_estimation' },
  // archive-restore: Lightricks' IC-LoRA loader (ComfyUI-LTXVideo)
  LTXICLoRALoaderModelOnly: { lora_name: 'loras' },
  // MiniMax H3 video: larryvrh's turbo LoRA loader (ComfyUI-MiniMax-H3-Turbo) reads models/loras.
  MiniMaxH3TurboLoRA: { lora_name: 'loras' },
  // Relight: Viggle's speed-LoRA loader (viggle_turbo) reads models/loras.
  ViggleTurboLora: { lora_name: 'loras' },
  // Genjutsu's From picture: SolarRenderer's LoRA loader reads models/loras.
  SolarRendererLoraLoader: { lora_name: 'loras' },
  // Open-H3 Regenerate (rdh9616's pack): the merged refiner LoRA, LBH's latent upscaler and NVIDIA's fast H3 VAE decoder.
  OpenH3RegenLora: { lora_name: 'loras' },
  OpenH3RegenUpscale: { model_name: 'latent_upscale_models' },
  OpenH3RegenFastVAEDecode: { vae_name: 'vae' },
  // Clean up voice: ComfyUI-RE-USE's loader reads models/reuse.
  REUSELoader: { model: 'reuse' },
  // Kandinsky 6.0: the audio VAE in models/audio_vae (bigvgan_dir names a folder there: requiredModels), and
  // the VSR's K-VAE and latent upscaler in its bundle under models/diffusion_models.
  Kandinsky6AudioVAELoader: { tod_vae: 'audio_vae' },
  Kandinsky6SRVAELoader: { kvae_checkpoint: 'diffusion_models' },
  Kandinsky6LatentUpscalerLoader: { latent_upscaler_checkpoint: 'diffusion_models' },
  // Watermark Remover: ComfyUI-Qwen-Watermark's mask refiner reads SAM from models/sams.
  QWMRefineMask: { sam_model: 'sams' },
};
// Nodes that fetch their own weights at runtime (no manual download needed; listed in the entry's autoDownloads).
// Zen Image Edit's adapter loader reads paths: its adapter is a requiredModels file, Qwen3.5-0.8B its autoDownloads.
// AuKModelLoader (Edit speech) reads its checkpoints by path inside the AuK checkout (ckpts/…), not from a ComfyUI
// models folder: install-comfyui.sh AUK_WEIGHTS=1 downloads them there (the entries' autoDownloads say what and where).
const SELF_DOWNLOADING = new Set(['RIFE VFI', 'DownloadAndLoadWav2VecModel', 'RMBG', 'AILab_Qwen3ASRSubtitle', 'Apply Whisper', 'ClothesSegment', 'LatentSyncNode', 'ZenImage21AdapterLoader', 'AuKModelLoader',
  // Fix faces: H3-FaceRefine's detectors and Impact's SAM loader read their packs' own folders (the entry lists them in autoDownloads).
  'H3FaceTrackCrop', 'SAMLoader']);
// Binding keys whose input is a user-supplied model file (not part of "models").
const USER_MODEL_KEYS = new Set(['lora', 'loraHigh', 'loraLow', 'upscaleModel']);
const MODEL_EXT = /\.(safetensors|sft|gguf|ckpt|pt|pth|bin|onnx)$/i;
const NUMERIC_DEFAULT_KEYS = [
  'width', 'height', 'frames', 'fps', 'steps', 'cfg', 'guidance', 'denoise', 'shift', 'scale', 'duration',
  'loraStrength', 'multiplier', 'bpm', 'padLeft', 'padTop', 'padRight', 'padBottom', 'cameraMotion',
  'contextFrames', 'exaggeration', 'temperature', 'motionStrength', 'strength',
  // comfyui-oss-3 additions
  'startTime', 'startFrame', 'numLayers', 'maxSize', 'controlStrength', 'framesPerBatch', 'maxTokens', 'maxChars',
  'backgroundVolumeDb', 'startStep', 'audioScale', 'lipsExpression', 'fontSize', 'textureSize', 'turntableFps',
  'octreeResolution', 'columns', 'rows',
  // av-tools (Wave B)
  'frameIndex',
  // comfyui-oss-4 additions
  'maskGrow', 'supersample', 'zoomStart', 'zoomEnd', 'panStartX', 'panStartY', 'panEndX', 'panEndY', 'easeInOut', 'chunkFrames',
  'crossfade', 'headroomDb', 'peakNits', 'resolutionLevel', 'fovX', 'decimation', 'numGaussians', 'orbitFrames', 'frameWidth',
  // round 4 (engine seams)
  'filterSpeckle', 'colorPrecision',
  // round 4 (r4/video-finish)
  'every', 'slowdown', 'shortSide',
  // Fuobe Soul (Originals O2)
  'megapixels',
  // Originals O11
  'motionFrame', 'audioCfg', 'threshold', 'mosaicScale',
  // archive-restore
  'windowStart', 'windowFrames', 'prefixFrames', 'canvasWidth', 'canvasHeight', 'tileWidth', 'tileHeight', 'tileFrames',
  // Photo to 3D (Idol)
  'meshDetail', 'frontYaw',
];
export const BINDING_KEYS = new Set([
  'prompt', 'negativePrompt', 'image', 'image2', 'image3', 'image4', 'mask', 'endImage', 'video', 'audio',
  // nm10-flux3-klein: FLUX 3 Image Klein's edit takes up to 10 references
  'image5', 'image6', 'image7', 'image8', 'image9', 'image10',
  'width', 'height', 'frames', 'fps', 'seed', 'steps', 'cfg', 'guidance', 'denoise', 'shift',
  'loraHigh', 'loraLow', 'lora', 'loraStrength', 'upscaleModel', 'scale', 'duration', 'lyrics', 'tags',
  // library extensions
  'padLeft', 'padTop', 'padRight', 'padBottom', 'cameraMotion', 'multiplier', 'bpm', 'filenamePrefix',
  // comfyui-oss-2 additions (see library.spec.mjs header)
  'audio2', 'video2', 'video3', 'video4', 'language', 'exaggeration', 'temperature', 'contextFrames', 'tracks',
  'motionStrength', 'strength',
  // comfyui-oss-3 additions (see library.spec.mjs header)
  'startTime', 'startFrame', 'numLayers', 'maxSize', 'paletteText', 'paletteImage', 'method', 'controlStrength',
  'framesPerBatch', 'checkpoint', 'description', 'instruction', 'maxTokens', 'sourceLanguage', 'asrModel', 'hints',
  'maxChars', 'backgroundVolumeDb', 'startStep', 'audioScale', 'lengthMode', 'lipsExpression', 'whisperModel',
  'fontSize', 'fontColor', 'captionPosition', 'textureSize', 'turntableFps', 'octreeResolution', 'columns', 'rows',
  'gridPrompt', 'sheetPrompt',
  // av-tools (Wave B, see library.spec.mjs header)
  'frameIndex',
  // Full songs (see library.spec.mjs header)
  'tiledDecode',
  // comfyui-oss-4 additions (see library.spec.mjs header)
  'maskPrompt', 'maskGrow', 'skipPass2', 'supersample', 'zoomStart', 'zoomEnd', 'panStartX', 'panStartY', 'panEndX', 'panEndY',
  'easeInOut', 'chunkFrames', 'crossfade', 'headroomDb', 'fadeCurve', 'format', 'profile', 'peakNits', 'resolutionLevel', 'fovX',
  'decimation', 'cutout', 'numGaussians', 'splatFormat', 'orbitFrames', 'frameWidth',
  // Hi3D refine (see library.spec.mjs header)
  'model3d', 'meshResolution', 'cpuOffload',
  // Idol 3D (docs/research/idol-9.md §5.5): Idol 3D's looser photo crop (the sampler key is MOSS-Image's)
  'photoCrop',
  // idol-2 (docs/research/idol-9.md §5.6): ComfyUI-Idol's crop mode and its splat pruning
  'cropMode', 'minOpacity', 'maxScale',
  // round 4 (engine seams, see library.spec.mjs header)
  'curveMode', 'filterSpeckle', 'colorPrecision',
  // remove-object package (round 4)
  'colormap', 'sideBySide',
  // round 4 (r4/video-finish): FPS Boost to exact targets, chunked upscaling, HDR10 (PQ)
  'every', 'slowdown', 'shortSide', 'colorSpace',
  // Fuobe Soul (Originals O2): image to image at Soul's tier
  'megapixels',
  // Genjutsu's Character swap (Originals O5): MiniMax H3 with the h3_character_swap / H3 Relay packs
  'quality', 'selection', 'subjectIndex', 'positiveCoords', 'negativeCoords', 'audioGuide', 'useMask', 'windowFrames', 'historyFrames', 'windowControls',
  // Character Swap Studio (o/h3-studio): continuation history from the previous take's master, masks on any frame spliced into a version
  'historyVideo', 'historyStart', 'historyLength', 'keyFrame', 'spanFrames', 'tailStart', 'tailFrames', 'prevMask',
  // Originals O11: Fuobe Speak's InfiniteTalk recipe on kijai's wrapper, the face mosaic
  'scheduler', 'motionFrame', 'colormatch', 'audioCfg', 'threshold', 'mosaicScale',
  // DBS soundtrack separation (docs/research/dbs-separation-7.md §4.5): the DBS model and its channel mode
  'separationModel', 'channels',
  // MOSS-Image (docs/research/new-models-7.md §4.6): the KSampler's sampler and the UNET file its Quality / Fast settings pick
  'sampler', 'unet',
  // archive-restore (Restore & colourise): the window, the canvas, the prefix hand-off, deinterlacing and the fusion tiles
  'windowStart', 'canvasWidth', 'canvasHeight', 'fieldWidth', 'fieldHeight', 'prefixFrom', 'prefixFrames', 'tileWidth', 'tileHeight', 'streaming', 'tileFrames',
  // The owner's SOTA image families (2026-10-31): Ideogram 4's sampling preset
  'preset',
  // Open-H3 Regenerate (n7-3): the pack's output size and draft size (its combo strings) and the refine's start noise
  'resolution', 'draftSize', 'startSigma',
  // Regenerate in Cinema: the 768p draft's saved latent (the prefix it's saved under, the file the 2K finish loads)
  'latentPrefix', 'latent',
  // Character swap in 2K: the mask composite's window starts, the two layers' places and the mask's soft edge
  'takeStart', 'maskStart', 'takeX', 'takeY', 'regionWidth', 'regionHeight', 'regenWidth', 'regenHeight', 'regenX', 'regenY', 'trimX', 'trimY', 'feather',
  // Clean up voice (ComfyUI-RE-USE): the RE-USE file, the rate it runs at, room tone, level and the music & effects bed's level
  'reuseModel', 'rate', 'roomToneDb', 'level', 'bedDb',
  // Clean up dialogue (DBS graph C, docs/research/dbs-separation-7.md §4.4): each stem's level in the remix
  'voiceDb', 'musicDb', 'effectsDb',
  // Blockout to film: a near = dark depth pass (Blender's mist) inverted before VACE reads it
  'invertDepth',
  // Design a voice: the voice in words, and what a voice sample says (Qwen3-TTS / VoxCPM2 clones)
  'voiceDescription', 'voiceTranscript',
  // VoxCPM2's device combo (cuda | mps | cpu): the server's first torch device
  'device',
  // The VAE file Options → Decoder picks (Qwen-Image 2.1) and a speed tier's sigma schedule for the canvas size
  'vae', 'sigmas',
  // Green screen: the key's despill strength
  'despill',
  // NVIDIA RTX Video: the nodes' quality (Super Resolution) or mode (Frame Generation)
  'rtxQuality',
  // Kandinsky VSR: the latent upscaler bank entry its factor needs
  'upscalerScale',
  // Any Angle: the 3D view's file and each angle's camera
  'splatFile', 'cameraYaw', 'cameraPitch', 'cameraDistance', 'cameraFov', 'targetX', 'targetY', 'targetZ',
  // Head Swap: the paste-back edge's blur and the paste-back switch
  'maskBlur', 'pasteBack',
  // Photo to 3D (Idol): SplatToMesh's grid and the turn that faces the subject's front
  'meshDetail', 'frontYaw',
  // Watermark Remover (ComfyUI-Qwen-Watermark): the kept marks, how the pack finds what to repair and how far past each mark
  'boxes', 'detectMode', 'detectExpand',
]);

// Sizes in GB: two decimals, and three where two would read 0 (a 4 MB DBS model), so no other entry's size changes.
export const gb = (bytes) => Math.round((bytes / 1e9) * 100) / 100 || Math.round(bytes / 1e6) / 1000;
const readJson = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Gated repos (license click-through) answer 401 to anonymous downloads; their file listing is
// still public, so fall back to the tree API for the size and flag the model as gated.
async function hfTreeSize(url) {
  const m = url.match(/^https:\/\/huggingface\.co\/(datasets\/)?([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, ds, repo, rev, file] = m;
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
  const api = `https://huggingface.co/api/${ds ? 'datasets' : 'models'}/${repo}/tree/${rev}/${dir}`;
  const res = await fetch(api);
  if (!res.ok) return null;
  const hit = (await res.json()).find((f) => f.path === decodeURIComponent(file));
  return hit ? hit.lfs?.size || hit.size : null;
}

async function hfSize(url, cache) {
  if (cache[url] !== undefined && !cache[url]?.error) return cache[url];
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    // A renamed repository answers with a redirect to its new name on huggingface.co (Comfy-Org/flux2-dev → Flux-2-Dev):
    // follow that one. The download's own redirect, to the CDN, carries the size and isn't followed.
    const moved = res.headers.get('location');
    // A small file's redirect to its cached copy already says its size (x-linked-size), which the copy (chunked) may not.
    const first = res.headers.get('x-linked-size');
    if ([301, 302, 307, 308].includes(res.status) && moved?.startsWith('/')) res = await fetch(new URL(moved, url), { method: 'HEAD', redirect: 'manual' });
    // A GitHub release asset (Zen Image Edit's adapter) redirects to its storage, which answers with the size.
    else if ([301, 302, 307, 308].includes(res.status) && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(url)) res = await fetch(url, { method: 'HEAD' });
    const linked = res.headers.get('x-linked-size') || first;
    const len = linked || (res.status === 200 ? res.headers.get('content-length') : null);
    if (res.status === 401 || res.status === 403) {
      const size = await hfTreeSize(url);
      cache[url] = size ? { size, gated: true } : { error: `HTTP ${res.status}` };
    } else cache[url] = res.status >= 400 ? { error: `HTTP ${res.status}` } : len ? Number(len) : { error: `no size (HTTP ${res.status})` };
  } catch (e) {
    return { error: String(e.message || e) }; // do not cache transient failures
  }
  return cache[url];
}

function applyTransforms(g, transforms, objectInfo) {
  for (const t of transforms || []) {
    switch (t.op) {
      case 'resolveSwitches': G.resolveSwitches(g, t.booleans || {}); break;
      case 'set': G.setInputs(g, [t]); break;
      case 'delete': G.deleteInputs(g, [t]); break;
      case 'removeNodes': G.removeNodes(g, t.ids); break;
      case 'removeOutputs': G.removeNodes(g, t.ids); break;
      case 'addNodes': G.addNodes(g, t.nodes); break;
      case 'insertAfter': G.insertAfter(g, t.source, t.id, t.node, t.input, t.only); break;
      case 'rename': G.renameValues(g, t.map); break;
      case 'prune': G.prune(g, objectInfo); break;
      default: throw new Error(`unknown transform op ${t.op}`);
    }
  }
  return g;
}

function comfyCommit() {
  try {
    return execSync(`git -C ${COMFYUI_DIR} rev-parse HEAD`).toString().trim();
  } catch {
    return 'unknown';
  }
}

export async function fetchObjectInfo() {
  const res = await fetch(`${COMFYUI_URL}/object_info`);
  if (!res.ok) throw new Error(`GET /object_info failed: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const only = new Set(process.argv.slice(2));
  const objectInfo = await fetchObjectInfo();
  const stats = await (await fetch(`${COMFYUI_URL}/system_stats`)).json();
  const sizeCache = readJson(SIZE_CACHE, {});
  const state = readJson(STATE_FILE, {});
  const prevManifest = readJson(path.join(OUT_DIR, 'manifest.json'), { workflows: [] });
  const prevSubset = readJson(path.join(OUT_DIR, 'object_info.subset.json'), {});
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const ids = new Set();
  const entries = [];
  const errors = [];
  for (const spec of SPEC) {
    if (ids.has(spec.id)) throw new Error(`duplicate id ${spec.id}`);
    ids.add(spec.id);
    if (only.size && !only.has(spec.id)) {
      const prev = prevManifest.workflows.find((w) => w.id === spec.id);
      if (prev) entries.push(prev);
      continue;
    }
    const errs = [];
    // ---- load source
    let graph, meta, source;
    if (spec.export) {
      const src = resolveSource(spec.export);
      const rawFile = path.join(RAW_DIR, `${src.key}.api.json`);
      if (!fs.existsSync(rawFile)) {
        errors.push(`${spec.id}: raw export ${rawFile} missing; run export-templates.mjs first`);
        continue;
      }
      graph = readJson(rawFile);
      meta = readJson(path.join(RAW_DIR, `${src.key}.meta.json`), { models: [] });
      source = meta.source;
      const STRUCTURAL = (spec.transforms || []).filter((t) => !['resolveSwitches', 'prune', 'removeOutputs'].includes(t.op));
      if (STRUCTURAL.length) source += ' (modified, see notes)';
    } else if (spec.handBuilt) {
      graph = readJson(path.join(HERE, spec.handBuilt));
      meta = { models: [] };
      source = `hand-built (scripts/comfy/${spec.handBuilt})`;
    } else throw new Error(`${spec.id}: needs export or handBuilt`);

    // ---- transform
    try {
      applyTransforms(graph, spec.transforms, objectInfo);
    } catch (e) {
      errors.push(`${spec.id}: transform failed: ${e.message}`);
      continue;
    }
    const outIds = spec.outputs.map((o) => o.node);
    for (const o of outIds) if (!graph[o]) errs.push(`output node ${o} missing`);
    // Predictable output location: output/fuobe/<id>_00001_.ext
    for (const o of outIds) if (graph[o] && 'filename_prefix' in graph[o].inputs) graph[o].inputs.filename_prefix = `fuobe/${spec.id}`;
    // Previews used as pass-throughs (V3 PreviewImage/MaskPreview return their input): link around them.
    const PASS_THROUGH = { PreviewImage: 'images', MaskPreview: 'mask' };
    for (const id of G.outputNodeIds(graph, objectInfo)) {
      const inp = PASS_THROUGH[graph[id].class_type];
      const src = inp && graph[id].inputs[inp];
      if (!outIds.includes(id) && G.isLink(src) && G.consumers(graph, id).length) G.rewire(graph, [id, 0], src);
    }
    // Drop any other output nodes (previews etc.), then everything not feeding the kept outputs.
    for (const id of G.outputNodeIds(graph, objectInfo)) if (!outIds.includes(id)) delete graph[id];
    G.prune(graph, objectInfo, outIds);
    graph = G.sortGraph(graph);
    // Classes of a pack this server doesn't have (spec.packs, PACK_CLASSES) are expected: the entry names the pack instead.
    const packClass = (cls) => (spec.packs || []).some((p) => PACK_CLASSES[p]?.test(cls));
    errs.push(...G.lint(graph, objectInfo).filter((e) => !/ not installed$/.test(e) || !packClass(e.match(/class (.+) not installed$/)?.[1] ?? '')));

    // ---- bindings
    const bindings = { ...spec.bindings };
    const prefixTargets = outIds.filter((o) => graph[o] && 'filename_prefix' in graph[o].inputs).map((o) => ({ node: o, input: 'filename_prefix' }));
    if (prefixTargets.length && !bindings.filenamePrefix) bindings.filenamePrefix = prefixTargets;
    for (const [key, targets] of Object.entries(bindings)) {
      if (!BINDING_KEYS.has(key)) errs.push(`binding key ${key} not in vocabulary`);
      for (const { node, input } of targets) {
        const n = graph[node];
        if (!n) { errs.push(`binding ${key}: node ${node} not in workflow`); continue; }
        if (!(input in n.inputs)) errs.push(`binding ${key}: ${node}.${input} not an input of ${n.class_type}`);
        else if (G.isLink(n.inputs[input])) errs.push(`binding ${key}: ${node}.${input} is a link, not a widget value`);
      }
    }

    // Every media input must be bound, otherwise the workflow references a template example asset.
    const FILE_INPUTS = { LoadImage: 'image', LoadImageMask: 'image', LoadVideo: 'file', VHS_LoadVideo: 'video', LoadAudio: 'audio', VHS_LoadAudioUpload: 'audio', AUSBOSS_NODES_ImageCropRotatePad: 'image', Hi3DLoadMesh: 'mesh_file' };
    const boundTargets = new Set(Object.values(bindings).flat().map((t) => `${t.node}.${t.input}`));
    for (const [nid, n] of Object.entries(graph)) {
      const inp = FILE_INPUTS[n.class_type];
      if (inp && !boundTargets.has(`${nid}.${inp}`)) errs.push(`media input ${nid}.${inp} (${n.class_type}) is not bound`);
    }

    // ---- defaults (derived from the workflow's current values, spec overrides win)
    const defaults = {};
    for (const key of NUMERIC_DEFAULT_KEYS) {
      const t = bindings[key]?.[0];
      if (t && graph[t.node] && !G.isLink(graph[t.node].inputs[t.input])) {
        const v = graph[t.node].inputs[t.input];
        defaults[key] = typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v;
      }
    }
    // frames must be frameStep*n+1 (Wan/Hunyuan 4, LTX 8); exposed as defaults.frameStep for app code.
    const { frameStep, ...limits } = spec.limits || {};
    if (frameStep) defaults.frameStep = frameStep;
    Object.assign(defaults, spec.defaults || {});

    // ---- models
    const userModelTargets = new Set(
      Object.entries(bindings).filter(([k]) => USER_MODEL_KEYS.has(k)).flatMap(([, ts]) => ts.map((t) => `${t.node}.${t.input}`)),
    );
    const models = new Map();
    const metaByName = Object.fromEntries((meta.models || []).map((m) => [m.name, m]));
    for (const [nid, n] of Object.entries(graph)) {
      const map = LOADER_FOLDERS[n.class_type] || {};
      for (const [inp, val] of Object.entries(n.inputs)) {
        if (typeof val !== 'string') continue;
        const folder = map[inp];
        if (!folder) {
          if (MODEL_EXT.test(val) && !SELF_DOWNLOADING.has(n.class_type) && !['filename_prefix'].includes(inp) && !n.class_type.startsWith('Load'))
            errs.push(`node ${nid} (${n.class_type}).${inp}="${val}" looks like a model file but the loader is unknown`);
          continue;
        }
        if (val === 'none' || val === '') continue;
        if (userModelTargets.has(`${nid}.${inp}`) && spec.id.endsWith('-lora')) continue; // placeholder LoRA names
        if (models.has(val)) continue;
        const m = metaByName[val];
        const known = KNOWN_MODELS[val];
        // A workflow may pin its own revision of a shared file (spec.modelUrls: the same bytes at a researched commit).
        const url = spec.modelUrls?.[val] || m?.url || known?.url;
        if (m?.directory && m.directory !== folder) errs.push(`model ${val}: template says ${m.directory}, loader reads ${folder}`);
        if (!url) errs.push(`model ${val} (${folder}): no download URL known`);
        const size = url ? await hfSize(url, sizeCache) : null;
        if (size && typeof size === 'object' && size.error) errs.push(`model ${val}: ${url} -> ${size.error}`);
        const bytes = typeof size === 'number' ? size : size?.size;
        const model = { file: val, folder, url: url || null, sizeGb: bytes ? gb(bytes) : null };
        if (size?.gated) model.gated = true;
        models.set(val, model);
      }
    }

    // Files a loader reads by a name with no extension (DBSLoader: models/dbs/<model>/config.json + model.safetensors), which the
    // loop above can't see: listed like any model, so install help and the presence check (GET /models/<folder>) know them.
    // Then files a model control can pick instead (FILM for RIFE): listed as optional, so missing-model help names them.
    // A file the graph loads can be optional too: one its nodes load only when a control asks (Kandinsky 6.0's Prompt helper).
    for (const [file, optional] of [...(spec.requiredModels || []).map((f) => [f, false]), ...(spec.optionalModels || []).map((f) => [f, true])]) {
      if (models.has(file)) {
        if (optional) models.get(file).optional = true;
        continue;
      }
      const known = KNOWN_MODELS[file];
      if (!known?.url) {
        errs.push(`${optional ? 'optional' : 'required'} model ${file}: no download URL known`);
        continue;
      }
      const size = await hfSize(known.url, sizeCache);
      if (size && typeof size === 'object' && size.error) errs.push(`model ${file}: ${known.url} -> ${size.error}`);
      const bytes = typeof size === 'number' ? size : size?.size;
      models.set(file, { file, folder: known.folder, url: known.url, sizeGb: bytes ? gb(bytes) : null, ...(size?.gated && { gated: true }), ...(optional && { optional: true }) });
    }

    // ---- custom nodes
    const custom = new Set();
    // Nodes the app adds per run (spec.runtimeNodes, e.g. the clip loaders of H3's references) count as the graph's own.
    for (const cls of [...Object.values(graph).map((n) => n.class_type), ...(spec.runtimeNodes || [])]) {
      const mod = objectInfo[cls]?.python_module || '';
      if (!mod.startsWith('custom_nodes.')) continue;
      try {
        custom.add(packOfClass(cls, mod, prevSubset[cls]?.python_module));
      } catch (e) {
        errs.push(e.message);
      }
    }
    // Packs this server doesn't have installed (their classes have no python_module here): declared by the entry.
    for (const p of spec.packs || []) custom.add(p);
    const customNodes = [...custom].sort().map((name) => ({ name, repo: CUSTOM_NODE_REPOS[name] || null }));
    for (const c of customNodes) if (!c.repo) errs.push(`custom node pack ${c.name} has no repo URL`);

    // ---- write
    const text = JSON.stringify(graph, null, 2) + '\n';
    const file = `${spec.id}.json`;
    fs.writeFileSync(path.join(OUT_DIR, file), text);
    const hash = sha256(text);
    const st = state[spec.id];
    const validated = !!(st && st.sha256 === hash && st.validated);
    const entry = {
      id: spec.id,
      title: spec.title,
      capability: spec.capability,
      file,
      source,
      bindings,
      outputs: spec.outputs,
      defaults,
      limits,
      models: [...models.values()],
      customNodes,
      vramGb: spec.vramGb,
      ...(spec.license ? { license: spec.license } : {}),
      validated,
      notes: spec.notes || '',
    };
    if (spec.autoDownloads) entry.autoDownloads = spec.autoDownloads;
    // "isolated": the node pack has process-wide side effects; run it on a separate ComfyUI (see README).
    if (spec.worker) entry.worker = spec.worker;
    // The card the graph's nodes need ("nvidia-rtx", "nvidia-rtx-40"): the GPU pre-flight checks it by the card's name.
    if (spec.gpu) entry.gpu = spec.gpu;
    // The app rewrites the graph before submitting (e.g. "captions": one segment per caption cue).
    if (spec.expand) entry.expand = spec.expand;
    if (spec.runtimeNodes) entry.runtimeNodes = spec.runtimeNodes;
    if (!validated && st && st.sha256 === hash && st.error) entry.validationError = st.error;
    if (errs.length) {
      errors.push(...errs.map((e) => `${spec.id}: ${e}`));
      entry.buildWarnings = errs;
    }
    entries.push(entry);
    console.log(`${errs.length ? '!' : '✓'} ${spec.id}: ${Object.keys(graph).length} nodes, ${models.size} models${customNodes.length ? `, custom: ${customNodes.map((c) => c.name).join('+')}` : ''}`);
  }

  // keep manifest order = spec order
  const order = SPEC.map((s) => s.id);
  entries.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const versions = stats.system || {};
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    comfyuiCommit: comfyCommit(),
    comfyuiVersion: versions.comfyui_version,
    workflowTemplatesVersion: versions.installed_templates_version,
    frontendVersion: (versions.comfy_package_versions || []).find((p) => p.name === 'comfyui-frontend-package')?.installed,
    workflows: entries,
  };
  writeJson(path.join(OUT_DIR, 'manifest.json'), manifest);
  fs.mkdirSync(path.dirname(SIZE_CACHE), { recursive: true });
  writeJson(SIZE_CACHE, sizeCache);
  // The GPU pre-flight's requirement index follows the manifest (pins come from the committed model-pins.json).
  try {
    const { index, bytes } = writeIndex(OUT_DIR);
    console.log(`requirements.json: ${Object.keys(index.files).length} files, ${Object.keys(index.packs).length} packs, ${bytes} bytes`);
  } catch (e) {
    errors.push(`requirements.json: ${e.message}`);
  }
  if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
  }
  console.log(`\nWrote ${entries.length} workflows + manifest.json to ${path.relative(REPO, OUT_DIR)}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
