#!/usr/bin/env node
/**
 * The GPU pre-flight's requirement index (workflows/comfyui/requirements.json, src/lib/gpu/types.ts RequirementIndex):
 * per workflow its core node classes, its packs' classes, the model files it needs, VRAM, worker and first-run downloads;
 * per pack its pinned commit and registry id; per file its folder, URL pinned to a revision, size, sha256 and how a
 * ComfyUI shows it is there (the loader node's combo list, the folder listing, or not at all).
 *
 * Built from the committed library alone, no ComfyUI and no network: manifest.json, the workflow graphs,
 * object_info.subset.json (which classes are core and which belong to a pack), packs.json (pins, kept by hand) and
 * model-pins.json (revisions and sizes). It runs at the end of build-library.mjs and alone:
 *
 *   node scripts/comfy/build-requirements.mjs                 # write requirements.json
 *   node scripts/comfy/build-requirements.mjs --refresh-pins  # maintainers: re-read model-pins.json from Hugging Face
 *                                                             # (network; gated repos need HF_TOKEN), then write
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PACK_CLASSES } from './library.spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const LIBRARY = path.join(REPO, 'workflows', 'comfyui');

/** ComfyUI's folder_paths.supported_pt_extensions: the files a folder listing shows. */
export const PT_EXTENSIONS = ['.ckpt', '.pt', '.pt2', '.bin', '.pth', '.safetensors', '.pkl', '.sft'];
/**
 * Model folders a pack reads straight from disk without registering them with ComfyUI, so GET /models never lists them
 * and a folder listing can't tell whether their files are there: their files are 'unobservable' rather than missing.
 * Hi3D: Comfyui-Hi3d-T8 reads folder_paths.models_dir/Hi3D (a 'hi3d' folder only exists when extra_model_paths.yaml adds one).
 * sams: ComfyUI-Qwen-Watermark reads models/sams by its path without registering it, so a listing can't tell whether its
 * SAM file is there.
 */
export const UNLISTED_FOLDERS = new Set(['Hi3D', 'sams']);

/** Core classes of the newest families, read one by one when /object_info can't be: an older ComfyUI lacks them first. */
const NEWEST_CORE = /^(SeedVR2|Trellis2|SAM3|LTXV|LTXAV|ComfyMathExpression|TextEncodeQwenImage21|QwenImage21Cache|Ideogram4|TextEncodeFibo2|DualModelGuider|CFGOverride)/;
const NEWEST_CORE_MODULES = new Set(['comfy_extras.nodes_bg_removal']);

// A pack that registers other packs' nodes again under its own name: on a ComfyUI that has it, /object_info gives
// its module for their classes (1,700 of them on one server), so it never names a class's pack.
const WRAPPER_PACKS = new Set(['comfyui-workflow-encrypt']);

/**
 * The pack a custom class belongs to, from its python_module on the server: the pack PACK_CLASSES names for it, else
 * the module's pack, else (a wrapper pack's module) the pack the committed object_info.subset.json recorded. Throws
 * when none of these tells.
 */
export function packOfClass(cls, pythonModule, recordedModule, packClasses = PACK_CLASSES) {
  const named = Object.entries(packClasses).find(([, re]) => re.test(cls))?.[0];
  if (named) return named;
  const pack = /^custom_nodes\.([^.]+)/.exec(pythonModule || '')?.[1];
  if (pack && !WRAPPER_PACKS.has(pack)) return pack;
  const recorded = /^custom_nodes\.([^.]+)/.exec(recordedModule || '')?.[1];
  if (recorded && !WRAPPER_PACKS.has(recorded)) return recorded;
  throw new Error(`can't tell which pack ${cls} belongs to (the server names ${pack ?? 'none'}); add it to PACK_CLASSES`);
}

/** A manifest URL as it is pinned and compared: without the `?download=true` some templates carry. */
export const cleanUrl = (u) => u.replace(/\?download=true$/, '');

/** A Hugging Face resolve URL → { kind: "models" | "datasets", repo, rev, path }, or null. */
export function hfParts(url) {
  const m = /^https:\/\/huggingface\.co\/(datasets\/)?([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/.exec(cleanUrl(url));
  return m ? { kind: m[1] ? 'datasets' : 'models', repo: m[2], rev: m[3], path: decodeURIComponent(m[4]) } : null;
}

/** The URL at a revision (resolve/main/… → resolve/<sha>/…). */
export function pinUrl(url, revision) {
  const p = hfParts(url);
  if (!p || !revision) return cleanUrl(url);
  return cleanUrl(url).replace(`/resolve/${p.rev}/`, `/resolve/${revision}/`);
}

const isCombo = (spec) => Array.isArray(spec) && (Array.isArray(spec[0]) || spec[0] === 'COMBO');
const comboInput = (entry, input) => !!entry && isCombo(entry.input?.required?.[input] ?? entry.input?.optional?.[input]);
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const uniq = (a) => [...new Set(a)].sort();

/** JSON with sorted keys, no whitespace: what the hash is taken of. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const indexHash = (index) => crypto.createHash('sha256').update(canonical({ ...index, hash: undefined })).digest('hex');

/**
 * Build the index from the library's inputs. Pure: no file or network access.
 * @param {{ manifest: object, graphs: Record<string, object>, subset: Record<string, object | null>, packs: Record<string, object>, pins: Record<string, { revision: string, sizeBytes: number, sha256?: string }>, packClasses?: Record<string, RegExp> }} inputs
 * @returns {import('../../src/lib/gpu/types').RequirementIndex}
 */
export function buildIndex({ manifest, graphs, subset, packs, pins, packClasses = PACK_CLASSES }) {
  const problems = [];
  /** A class's owner: "core", or a pack name. */
  const ownerOf = (cls, wf) => {
    const e = subset[cls];
    if (e && typeof e.python_module === 'string') {
      const m = /^custom_nodes\.([^.]+)/.exec(e.python_module);
      return m ? m[1] : 'core';
    }
    // Classes the validator couldn't load (null): their pack is named by PACK_CLASSES, else by the workflow's only pack.
    for (const [pack, re] of Object.entries(packClasses)) if (re.test(cls)) return pack;
    const named = wf.customNodes.map((c) => c.name);
    if (named.length === 1) return named[0];
    problems.push(`${wf.id}: can't tell which pack ${cls} belongs to`);
    return null;
  };

  // Files: one entry per folder/file; a file re-hosted at several URLs takes the URL most workflows use.
  const refs = new Map(); // key -> { model, urls: Map<url, count>, gated, wfs: Set }
  for (const wf of manifest.workflows) {
    for (const m of wf.models) {
      const key = `${m.folder}/${m.file}`;
      const r = refs.get(key) ?? { folder: m.folder, file: m.file, sizeGb: m.sizeGb ?? 0, urls: new Map(), gated: false, wfs: new Set() };
      if (m.url) r.urls.set(cleanUrl(m.url), (r.urls.get(cleanUrl(m.url)) ?? 0) + 1);
      r.gated ||= !!m.gated;
      r.sizeGb = Math.max(r.sizeGb, m.sizeGb ?? 0);
      r.wfs.add(wf.id);
      refs.set(key, r);
    }
  }
  const packFolder = new Map();
  for (const [name, p] of Object.entries(packs)) for (const f of p.folders ?? []) packFolder.set(f, name);
  // A pack that registers models/<folder> under another name (kandinsky6: models/audio_vae as kandinsky6_audio_vae):
  // ComfyUI lists the folder only under that name, so the presence check reads that listing.
  const listAs = new Map();
  for (const p of Object.values(packs)) for (const [f, as] of Object.entries(p.listAs ?? {})) listAs.set(f, as);

  const files = {};
  for (const key of [...refs.keys()].sort()) {
    const r = refs.get(key);
    const url = [...r.urls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!url) {
      problems.push(`${key}: no download URL`);
      continue;
    }
    const pin = pins[url];
    // The loader nodes that pick this file in the workflows that need it (the input must be a combo: its list is what ComfyUI can load).
    const loaders = new Map();
    for (const id of r.wfs) {
      for (const node of Object.values(graphs[id] ?? {})) {
        for (const [input, value] of Object.entries(node?.inputs ?? {})) {
          if (value === r.file && comboInput(subset[node.class_type], input)) loaders.set(`${node.class_type}\u0000${input}`, [node.class_type, input]);
        }
      }
    }
    const ext = path.extname(r.file).toLowerCase();
    const presence = loaders.size ? 'loader' : PT_EXTENSIONS.includes(ext) && !UNLISTED_FOLDERS.has(r.folder) ? 'list' : 'unobservable';
    files[key] = {
      folder: r.folder,
      file: r.file,
      url,
      pinnedUrl: pin ? pinUrl(url, pin.revision) : url,
      sizeBytes: pin?.sizeBytes ?? Math.round(r.sizeGb * 1e9),
      // The hash rides along where a copied command checks it: formats that can run code when they load (.pth, .ckpt…),
      // the other non-safetensors files, and a file from outside Hugging Face (a release asset, which its owner can replace).
      // Every file's sha256 stays in model-pins.json (the size budget, §4.3).
      ...(pin?.sha256 && (ext !== '.safetensors' || !hfParts(url)) && { sha256: pin.sha256 }),
      gated: r.gated,
      ...(packFolder.has(r.folder) && { packFolder: packFolder.get(r.folder) }),
      ...(listAs.has(r.folder) && { listFolder: listAs.get(r.folder) }),
      presence,
      ...(loaders.size && { loaders: [...loaders.values()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1])) }),
    };
  }

  // Workflows: classes split into core and packs.
  const packClassesUsed = new Map();
  const workflows = {};
  for (const wf of manifest.workflows) {
    const graph = graphs[wf.id];
    if (!graph) {
      problems.push(`${wf.id}: no workflow graph`);
      continue;
    }
    const core = new Set();
    const byPack = {};
    for (const n of wf.customNodes) byPack[n.name] ??= new Set();
    for (const cls of new Set([...Object.values(graph).map((n) => n.class_type), ...(wf.runtimeNodes ?? [])])) {
      const owner = ownerOf(cls, wf);
      if (!owner) continue;
      if (owner === 'core') core.add(cls);
      else {
        (byPack[owner] ??= new Set()).add(cls);
        if (!packClassesUsed.has(owner)) packClassesUsed.set(owner, new Set());
        packClassesUsed.get(owner).add(cls);
      }
    }
    workflows[wf.id] = {
      core: uniq(core),
      packs: sortObj(Object.fromEntries(Object.entries(byPack).map(([k, v]) => [k, uniq(v)]))),
      files: uniq(wf.models.filter((m) => !m.optional).map((m) => `${m.folder}/${m.file}`)),
      optional: uniq(wf.models.filter((m) => m.optional).map((m) => `${m.folder}/${m.file}`)),
      vramGb: Number(wf.vramGb) || 0,
      isolated: wf.worker === 'isolated',
      // The card its nodes need (the NVIDIA RTX Video nodes): readiness checks it against the GPU's name.
      ...(wf.gpu && { gpu: wf.gpu }),
      firstRun: wf.autoDownloads ?? [],
      ...(wf.validated && { validated: true }),
    };
  }

  // Packs: every pack a workflow uses, with its pins from packs.json.
  const usedPacks = uniq(Object.values(workflows).flatMap((w) => Object.keys(w.packs)));
  const indexPacks = {};
  for (const name of usedPacks) {
    const p = packs[name];
    if (!p) {
      problems.push(`${name}: not in packs.json`);
      continue;
    }
    indexPacks[name] = {
      repo: p.repo,
      commit: p.commit,
      // A node file Fuobe ships itself (fuobe_live.py): written into custom_nodes, never cloned.
      ...(p.bundled && { bundled: p.bundled }),
      ...(p.registry && { registry: { id: p.registry.id, version: p.registry.version ?? '' } }),
      classes: uniq(packClassesUsed.get(name) ?? []),
      folders: uniq(p.folders ?? []),
      isolated: !!p.isolated,
      ...(p.subdir && { subdir: p.subdir }),
      // One node file in a model repo (viggle_turbo): downloaded, not cloned.
      ...(p.file && { file: p.file }),
      requirementsTxt: !!p.requirementsTxt,
      // Python packages to install by name instead of the pack's requirements.txt (pinned versions only).
      ...(Array.isArray(p.pip) && p.pip.length && { pip: [...p.pip] }),
      install: p.registry?.version ? 'registry' : 'manual',
    };
  }

  const coreNewest = Object.entries(subset)
    .filter(([cls, e]) => e && !String(e.python_module).startsWith('custom_nodes.') && (NEWEST_CORE.test(cls) || NEWEST_CORE_MODULES.has(e.python_module)))
    .map(([cls]) => cls);
  const used = new Set(Object.values(workflows).flatMap((w) => w.core));
  const sentinels = uniq([...Object.values(indexPacks).flatMap((p) => p.classes), ...coreNewest.filter((c) => used.has(c))]);

  if (problems.length) throw new Error(`requirements.json can't be built:\n  ${problems.join('\n  ')}`);
  const index = {
    v: 1,
    hash: '',
    comfyui: { min: manifest.comfyuiVersion, testedCommit: String(manifest.comfyuiCommit ?? '').slice(0, 8) },
    folders: uniq(Object.values(files).map((f) => f.listFolder ?? f.folder)),
    sentinels,
    packs: indexPacks,
    files,
    workflows: sortObj(workflows),
  };
  index.hash = indexHash(index);
  return index;
}

/** The inputs as committed. */
export function loadInputs(dir = LIBRARY) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const manifest = read('manifest.json');
  const graphs = Object.fromEntries(manifest.workflows.map((w) => [w.id, read(w.file)]));
  const pinsFile = path.join(dir, 'model-pins.json');
  return {
    manifest,
    graphs,
    subset: read('object_info.subset.json'),
    packs: read('packs.json'),
    pins: fs.existsSync(pinsFile) ? read('model-pins.json') : {},
    packClasses: PACK_CLASSES,
  };
}

/**
 * The index as written: one line per pack, file and workflow (reviewable diffs, small file).
 * JSON.parse of it equals the index.
 */
export function formatIndex(index) {
  const block = (o) => `{\n${Object.entries(o).map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }`;
  const top = Object.entries(index).map(([k, v]) => `  ${JSON.stringify(k)}: ${['packs', 'files', 'workflows'].includes(k) ? block(v) : JSON.stringify(v)}`);
  return `{\n${top.join(',\n')}\n}\n`;
}

export function writeIndex(dir = LIBRARY) {
  const index = buildIndex(loadInputs(dir));
  const text = formatIndex(index);
  fs.writeFileSync(path.join(dir, 'requirements.json'), text);
  return { index, bytes: Buffer.byteLength(text) };
}

// ---------------------------------------------------------------------------
// --refresh-pins: revisions, sizes and sha256 from Hugging Face (maintainers; network)

/**
 * Pin every manifest URL: the repo's current revision (GET /api/<kind>/<repo>/revision/main) and, at that revision,
 * each file's size and LFS sha256 (POST /api/<kind>/<repo>/paths-info/<sha>). URLs already at a commit keep it.
 * Files that can't be read (gated without HF_TOKEN, moved) keep their old pin, or none; they are returned in `failed`.
 */
export async function refreshPins(dir = LIBRARY, { token = process.env.HF_TOKEN, fetchImpl = fetch, log = console.log } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const pinsFile = path.join(dir, 'model-pins.json');
  const old = fs.existsSync(pinsFile) ? JSON.parse(fs.readFileSync(pinsFile, 'utf8')) : {};
  const urls = uniq(manifest.workflows.flatMap((w) => w.models.flatMap((m) => (m.url ? [cleanUrl(m.url)] : []))));
  const headers = { 'User-Agent': 'Fuobe build-requirements', ...(token && { Authorization: `Bearer ${token}` }) };
  // Group by repo and revision asked for.
  const groups = new Map();
  const failed = [];
  const byHand = [];
  for (const url of urls) {
    const p = hfParts(url);
    if (!p) {
      // A release asset elsewhere (Zen Image Edit's adapter on GitHub): its pin is kept by hand.
      failed.push({ url, why: 'not a Hugging Face resolve URL (pin kept by hand)' });
      byHand.push(url);
      continue;
    }
    const k = `${p.kind}\u0000${p.repo}\u0000${p.rev}`;
    if (!groups.has(k)) groups.set(k, { ...p, items: [] });
    groups.get(k).items.push({ url, path: p.path });
  }
  const pins = Object.fromEntries(byHand.flatMap((url) => (old[url] ? [[url, old[url]]] : [])));
  for (const g of groups.values()) {
    let sha = /^[0-9a-f]{40}$/.test(g.rev) ? g.rev : null;
    try {
      if (!sha) {
        const r = await fetchImpl(`https://huggingface.co/api/${g.kind}/${g.repo}/revision/${encodeURIComponent(g.rev)}`, { headers });
        if (!r.ok) throw new Error(`revision: HTTP ${r.status}`);
        sha = (await r.json()).sha;
        if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('revision: no sha');
      }
      const r = await fetchImpl(`https://huggingface.co/api/${g.kind}/${g.repo}/paths-info/${sha}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: g.items.map((i) => i.path), expand: false }),
      });
      if (!r.ok) throw new Error(`paths-info: HTTP ${r.status}`);
      const info = new Map((await r.json()).map((e) => [e.path, e]));
      for (const it of g.items) {
        const e = info.get(it.path);
        if (!e || e.type !== 'file') {
          failed.push({ url: it.url, why: 'not found at that revision' });
          if (old[it.url]) pins[it.url] = old[it.url];
          continue;
        }
        const size = e.lfs?.size ?? e.size;
        pins[it.url] = { revision: sha, sizeBytes: size, ...(e.lfs?.oid && /^[0-9a-f]{64}$/.test(e.lfs.oid) && { sha256: e.lfs.oid }) };
      }
      log(`✓ ${g.repo}@${sha.slice(0, 8)}: ${g.items.length} file(s)`);
    } catch (e) {
      log(`! ${g.repo}: ${e.message}`);
      for (const it of g.items) {
        failed.push({ url: it.url, why: e.message });
        if (old[it.url]) pins[it.url] = old[it.url];
      }
    }
  }
  fs.writeFileSync(pinsFile, `${JSON.stringify(sortObj(pins), null, 1)}\n`);
  return { pinned: Object.keys(pins).length, failed };
}

async function main() {
  if (process.argv.includes('--refresh-pins')) {
    const r = await refreshPins();
    console.log(`model-pins.json: ${r.pinned} pinned, ${r.failed.length} not pinned`);
    for (const f of r.failed) console.log(`  ${f.url}: ${f.why}`);
  }
  const { index, bytes } = writeIndex();
  console.log(`requirements.json: ${Object.keys(index.workflows).length} workflows, ${Object.keys(index.files).length} files, ${Object.keys(index.packs).length} packs, ${bytes} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
