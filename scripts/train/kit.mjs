#!/usr/bin/env node
/**
 * Fuobe's training kit (build plan O12): job specs, data-licence logs, the motion library and publishing. Nothing here
 * trains or uploads unless asked: `job` writes the configs a run takes, `publish` is a dry run without --upload.
 *
 *   node scripts/train/kit.mjs list                                   every spec, its log and its fal price
 *   node scripts/train/kit.mjs check <id>|--all [--dataset <dir>]     the spec and its data-licence log (against the files)
 *   node scripts/train/kit.mjs job <id> --dataset <dir> [--zip-url <url>] [--out <dir>]
 *                                                                     the AI-Toolkit config, the dataset zip and the fal request,
 *                                                                     once the log passes (--zip-url: where that zip was uploaded)
 *   node scripts/train/kit.mjs motions                                the motion library's clips and licences
 *   node scripts/train/kit.mjs publish <id> --file <lora.safetensors> --route fal|ai-toolkit [--org fuobe]
 *                                     [--licence <spdx>] [--commercial yes|no] [--hosted-ok yes|no] [--upload] [--write-research]
 *
 * See scripts/train/README.md.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolve } from "../lib/ts-paths.mjs";

registerHooks({ resolve });
process.removeAllListeners("warning");
process.on("warning", (w) => (w.name !== "Warning" || !/Module type of/.test(w.message) ? console.warn(`${w.name}: ${w.message}`) : undefined));

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TRAIN = path.join(ROOT, "scripts", "train");
const RESEARCH = path.join(ROOT, "docs", "research", "fuobe-originals-recipes-5.json");
const kit = await import(pathToFileURL(path.join(ROOT, "src/lib/training-kit.ts")).href);
const { PLANNED_LORAS, LORA_LIBRARY } = await import(pathToFileURL(path.join(ROOT, "src/lib/catalog/lora-library.generated.ts")).href);

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const specIds = () => fs.readdirSync(path.join(TRAIN, "specs")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const loadSpec = (id) => {
  const p = path.join(TRAIN, "specs", `${id}.json`);
  if (!fs.existsSync(p)) fail(`no spec scripts/train/specs/${id}.json`);
  return readJson(p);
};
// The logs live in scripts/train/data-logs; FUOBE_TRAIN_LOGS points elsewhere (a private copy, or a test's).
const LOGS = process.env.FUOBE_TRAIN_LOGS ?? path.join(TRAIN, "data-logs");
const loadLog = (id) => {
  const p = path.join(LOGS, `${id}.json`);
  return fs.existsSync(p) ? readJson(p) : { lora: id, version: 1, items: [] };
};
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/**
 * The dataset folder as the checker sees it: every file but the captions, with its hash (whatever its extension: a
 * trainer reads more kinds than the spec's media), each caption's text, and anything that is not a plain file.
 */
function readDataset(dir) {
  if (!dir) return undefined;
  if (!fs.existsSync(dir)) fail(`no dataset folder ${dir}`);
  const folder = { files: [], captions: {}, other: [] };
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (!e.isFile()) folder.other.push(e.name);
    else if (e.name.endsWith(".txt")) folder.captions[e.name] = fs.readFileSync(p, "utf8");
    else folder.files.push({ name: e.name, sha256: sha256(p) });
  }
  return folder;
}

function problemsOf(id, datasetDir) {
  const spec = loadSpec(id);
  const out = kit.specProblems(spec).map((p) => `spec: ${p}`);
  out.push(...kit.dataLogProblems(loadLog(id), spec, readDataset(datasetDir)).map((p) => `data-licence log: ${p}`));
  return { spec, problems: out };
}

function report(id, problems) {
  if (!problems.length) console.log(`${id}: ready`);
  else console.log(`${id}: not ready\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  … and ${problems.length - 20} more` : ""}`);
}

if (cmd === "list") {
  for (const id of specIds()) {
    const spec = loadSpec(id);
    const log = loadLog(id);
    const published = LORA_LIBRARY.some((e) => e.key === id);
    const cost = kit.specCostUsd(spec);
    console.log(`${id.padEnd(22)} ${published ? "published" : "planned  "}  ${spec.media}  log ${String(log.items.length).padStart(3)}/${spec.dataset.min}-${spec.dataset.max}  fal ${spec.routes.fal.trainer} ≈ $${cost?.toFixed(2)} (${spec.train.steps} steps)  · AI-Toolkit ${spec.routes.aiToolkit.arch}: free on your GPU`);
  }
  const missing = PLANNED_LORAS.filter((p) => !specIds().includes(p.key)).map((p) => p.key);
  if (missing.length) console.log(`planned without a spec: ${missing.join(", ")}`);
} else if (cmd === "check") {
  const ids = flag("--all") ? specIds() : [args[1]];
  if (!ids[0] || ids[0].startsWith("--")) fail("usage: kit.mjs check <id>|--all [--dataset <dir>]");
  let bad = 0;
  for (const id of ids) {
    const { problems } = problemsOf(id, flag("--all") ? undefined : opt("--dataset"));
    report(id, problems);
    if (problems.length) bad++;
  }
  process.exit(bad ? 1 : 0);
} else if (cmd === "job") {
  const id = args[1];
  const dataset = opt("--dataset");
  if (!id || !dataset) fail("usage: kit.mjs job <id> --dataset <dir> [--zip-url <url>] [--out <dir>]");
  const { spec, problems } = problemsOf(id, dataset);
  if (problems.length) {
    report(id, problems);
    fail(`\nThe job does not start until the spec and the data-licence log pass (scripts/train/README.md).`);
  }
  const out = path.resolve(opt("--out") ?? path.join(ROOT, ".train", id));
  fs.mkdirSync(out, { recursive: true });
  const aitk = kit.aiToolkitConfig(spec, path.resolve(dataset), path.join(out, "output"));
  fs.writeFileSync(path.join(out, `${id}.aitk.json`), JSON.stringify(aitk, null, 2) + "\n");
  // The hosted trainer gets exactly the checked files: the logged media and their captions, zipped here.
  const zipFile = path.join(out, `${id}.dataset.zip`);
  fs.rmSync(zipFile, { force: true });
  execFileSync("python3", ["-I", "-m", "zipfile", "-c", zipFile, ...kit.datasetZipNames(loadLog(id))], { cwd: path.resolve(dataset), stdio: "pipe" });
  const zipSha = sha256(zipFile);
  const zip = opt("--zip-url");
  if (zip) {
    // The request names a zip only once the uploaded one is this one, byte for byte.
    const res = await fetch(zip).catch((e) => fail(`could not download ${zip}: ${e.message}`));
    if (!res.ok) fail(`could not download ${zip}: HTTP ${res.status}`);
    const got = crypto.createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
    if (got !== zipSha) fail(`${zip} is not ${path.basename(zipFile)} (SHA256 ${got}, expected ${zipSha}): upload the zip the kit built.`);
    fs.writeFileSync(path.join(out, `${id}.fal.json`), JSON.stringify({ endpoint: spec.routes.fal.trainer, input: kit.falTrainingPayload(spec, zip), datasetZip: { file: path.basename(zipFile), sha256: zipSha } }, null, 2) + "\n");
  }
  console.log(`${id}: the data-licence log passes.`);
  console.log(`  Your GPU (free):  python run.py ${path.join(out, `${id}.aitk.json`)}   (in an ostris/ai-toolkit checkout)`);
  console.log(
    zip
      ? `  fal (≈ $${kit.specCostUsd(spec)?.toFixed(2)}):  submit ${path.join(out, `${id}.fal.json`)} to ${spec.routes.fal.trainer}`
      : `  fal: upload ${zipFile} (SHA256 ${zipSha}) and run this again with --zip-url <its URL> for the request`,
  );
  console.log(`  Not run here. Then: kit.mjs publish ${id} --file <the trained .safetensors> --route fal|ai-toolkit`);
} else if (cmd === "motions") {
  const research = readJson(RESEARCH);
  const row = research.motionsEffects.find((m) => m.status === "motion-library");
  const problems = kit.motionLibraryProblems(kit.MOTION_LIBRARY, row?.presets ?? []);
  for (const m of kit.MOTION_LIBRARY.moves) {
    const clip = kit.motionLibraryClip(m.presetId);
    console.log(`${m.preset.padEnd(18)} ${m.clips.length} clip(s)  ${clip ? `→ runs from ${clip.url}` : "keeps its current route (no checked clip yet)"}`);
  }
  if (problems.length) fail(`\nmotion library:\n  ${problems.join("\n  ")}`);
} else if (cmd === "publish") {
  const id = args[1];
  const file = opt("--file");
  const route = opt("--route");
  if (!id || !file || !["fal", "ai-toolkit"].includes(route))
    fail("usage: kit.mjs publish <id> --file <lora.safetensors> --route fal|ai-toolkit [--org fuobe] [--licence <spdx>] [--commercial yes|no] [--hosted-ok yes|no] [--upload] [--write-research]");
  if (!fs.existsSync(file) || !file.endsWith(".safetensors")) fail(`${file} is not a .safetensors file`);
  const spec = loadSpec(id);
  const log = loadLog(id);
  const logProblems = kit.dataLogProblems(log, spec);
  if (logProblems.length) {
    report(id, logProblems.map((p) => `data-licence log: ${p}`));
    fail("\nA file is published only with a complete data-licence log.");
  }
  const yesNo = (name) => {
    const v = opt(name);
    if (v === undefined) return undefined;
    if (v !== "yes" && v !== "no") fail(`${name} takes yes or no`);
    return v === "yes";
  };
  const { snapshot, problems: licenceProblems } = kit.trainedLicence(log, { licence: opt("--licence"), commercial: yesNo("--commercial"), hostedOk: yesNo("--hosted-ok") });
  if (!snapshot) {
    report(id, licenceProblems.map((p) => `licence: ${p}`));
    fail("\nThe trained file's licence is recorded, not assumed.");
  }
  const baseModel = kit.hfBaseModel(spec, route);
  const org = opt("--org") ?? process.env.FUOBE_HF_ORG ?? spec.target.hfRepo.split("/")[0];
  const repo = `${org}/${id}`;
  const hash = sha256(file);
  const size = fs.statSync(file).size;
  const stage = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), `fuobe-publish-${id}-`));
  fs.copyFileSync(file, path.join(stage, spec.target.file));
  fs.writeFileSync(path.join(stage, "data-licence-log.json"), JSON.stringify(kit.publicLog(log), null, 2) + "\n");
  fs.writeFileSync(
    path.join(stage, "README.md"),
    [
      "---",
      `license: ${snapshot.card.license}`,
      ...(snapshot.card.licenseName ? [`license_name: ${snapshot.card.licenseName}`] : []),
      `base_model: ${baseModel}`,
      "base_model_relation: adapter",
      "tags: [lora, fuobe]",
      "---",
      "",
      `# ${spec.name}`,
      "",
      `A LoRA Fuobe trained on its own or licensed data (${log.items.length} ${spec.media === "image" ? "images" : "clips"}) on ${baseModel}. Every file's source, licence and release is in data-licence-log.json.`,
      "",
      `- Trigger: \`${spec.trigger}\``,
      `- Strength: ${spec.target.strength}`,
      `- Licence: ${snapshot.licence}; outputs may be sold: ${snapshot.commercial ? "yes" : "no"}; hosts may run it: ${snapshot.hostedOk ? "yes" : "no"}`,
      `- File: ${spec.target.file} (SHA256 ${hash})`,
      "",
    ].join("\n"),
  );
  const trained = (revision) => ({
    file: spec.target.file,
    url: `https://huggingface.co/${repo}/resolve/main/${spec.target.file}`,
    page: `https://huggingface.co/${repo}`,
    strength: spec.target.strength,
    trigger: spec.trigger,
    ...(spec.target.loraTarget && { target: spec.target.loraTarget }),
    download: "direct",
    licence: snapshot.licence,
    commercial: snapshot.commercial,
    hostedOk: snapshot.hostedOk,
    checked: new Date().toISOString().slice(0, 10),
    revision,
    sha256: hash,
    sizeBytes: size,
  });
  console.log(`${id} → https://huggingface.co/${repo} (trained on ${baseModel}, ${route})\n  ${spec.target.file} (${size} bytes, SHA256 ${hash}), data-licence-log.json, README.md\n  staged in ${stage}`);
  if (!flag("--upload")) {
    console.log(`\nDry run: nothing uploaded. Add --upload (with HF_TOKEN set and the hf command installed) to publish.`);
    console.log(`The research entry's trained block will be:\n${JSON.stringify(trained("<the commit the upload makes>"), null, 1)}`);
    process.exit(0);
  }
  if (!process.env.HF_TOKEN) fail("HF_TOKEN is not set: a write token for the organisation is needed to upload.");
  execFileSync("hf", ["repo", "create", repo, "--repo-type", "model", "--exist-ok"], { stdio: "inherit" });
  execFileSync("hf", ["upload", repo, stage, ".", "--repo-type", "model", "--commit-message", `${spec.name}: the trained file and its data-licence log`], { stdio: "inherit" });
  const info = await fetch(`https://huggingface.co/api/models/${repo}`, { headers: { authorization: `Bearer ${process.env.HF_TOKEN}` } }).then((r) => r.json());
  if (!/^[0-9a-f]{40}$/.test(info.sha ?? "")) fail(`could not read the commit of ${repo}`);
  const block = trained(info.sha);
  console.log(`Published at commit ${info.sha}.`);
  if (flag("--write-research")) {
    const text = fs.readFileSync(RESEARCH, "utf8");
    const research = JSON.parse(text);
    const entry = research.fuobeTrainedLoras.find((x) => x.id === id);
    if (!entry) fail(`${id} is not in the research's fuobeTrainedLoras`);
    entry.trained = block;
    entry.status = "trained";
    fs.writeFileSync(RESEARCH, JSON.stringify(research, null, 1));
    console.log(`Wrote the trained block to docs/research/fuobe-originals-recipes-5.json. Now run: pnpm gen:catalog`);
  } else console.log(`Add this as fuobeTrainedLoras[${id}].trained in the research, then run pnpm gen:catalog:\n${JSON.stringify(block, null, 1)}`);
} else {
  fail("usage: kit.mjs list | check <id>|--all [--dataset <dir>] | job <id> --dataset <dir> [--zip-url <url>] [--out <dir>] | motions | publish <id> --file <f> --route fal|ai-toolkit [--upload] [--write-research]");
}
