import { execFile, execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getPreset } from "@/lib/catalog";
import { LORA_LIBRARY, MOTION_EFFECT_LORAS, PLANNED_LORAS } from "@/lib/catalog/lora-library.generated";
import { getTrainer } from "@/lib/catalog/training";
import {
  aiToolkitConfig,
  dataLogProblems,
  datasetZipNames,
  falTrainingPayload,
  hfBaseModel,
  MOTION_LIBRARY,
  motionLibraryClip,
  motionLibraryProblems,
  publicLog,
  specCostUsd,
  specProblems,
  trainedLicence,
  type DataLog,
  type DataLogItem,
  type MotionClip,
  type TrainingSpec,
} from "@/lib/training-kit";

const ROOT = path.resolve(__dirname, "..");
/** The parts of an AI-Toolkit process the tests read. */
type Proc = { model: Record<string, unknown>; network: { linear: number }; train: Record<string, unknown>; datasets: Record<string, unknown>[]; trigger_word: string };
const KIT = path.join(ROOT, "scripts/train/kit.mjs");
const research = () => JSON.parse(fs.readFileSync(path.join(ROOT, "docs/research/fuobe-originals-recipes-5.json"), "utf8"));
const specs: TrainingSpec[] = fs
  .readdirSync(path.join(ROOT, "scripts/train/specs"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/train/specs", f), "utf8")));
const spec = (id: string) => specs.find((s) => s.id === id)!;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const item = (file: string, over: Partial<DataLogItem> = {}): DataLogItem => ({
  file,
  sha256: sha(file),
  source: "own-shoot",
  licence: "Fuobe's own",
  proof: "shoot 2026-11 call sheet, folder cctv/raw",
  author: "Fuobe team",
  date: "2026-11-01",
  people: false,
  ...over,
});
const log = (id: string, n: number, over: Partial<DataLogItem> = {}): DataLog => ({
  lora: id,
  version: 1,
  items: Array.from({ length: n }, (_, i) => item(`${String(i + 1).padStart(3, "0")}.jpg`, over)),
  reviewedBy: "Fuobe team",
  reviewedAt: "2026-11-02",
});

describe("training kit: job specs (scripts/train/specs)", () => {
  it("has a spec for every planned own LoRA, the first three and the Wan 2.2 motion LoRAs among them", () => {
    expect(specs.map((s) => s.id).sort()).toEqual(PLANNED_LORAS.map((p) => p.key).sort());
    for (const id of ["fuobe-soul-core", "fuobe-cctv", "fuobe-ultrawide-05", "fuobe-push-in", "fuobe-timelapse", "fuobe-drone-reveal"]) expect(spec(id), id).toBeDefined();
    // The §6 table and the three motion LoRAs of build plan O12.
    expect(research().fuobeTrainedLoras).toHaveLength(13);
  });

  it("passes the spec check: trainer fields from the research, both routes, a target library entry", () => {
    for (const s of specs) {
      expect(specProblems(s), s.id).toEqual([]);
      expect(specCostUsd(s), s.id).toBeGreaterThan(0);
      expect(s.target.file).toBe(PLANNED_LORAS.find((p) => p.key === s.id)!.file);
    }
    // The Wan 2.2 motion LoRAs train on fal's Wan 2.2 A14B I2V trainer and load on both experts.
    for (const id of ["fuobe-push-in", "fuobe-timelapse", "fuobe-drone-reveal"]) {
      expect(spec(id).routes.fal.trainer).toBe("fal-ai/wan-22-trainer/i2v-a14b");
      expect(spec(id).routes.aiToolkit.arch).toBe("wan22_14b_i2v");
      expect(spec(id).target.loraTarget).toBe("both");
    }
  });

  it("refuses a spec that doesn't fit its trainer or its entry", () => {
    const s = spec("fuobe-cctv");
    expect(specProblems({ ...s, train: { ...s.train, steps: 50_000 } }).join()).toMatch(/outside/);
    expect(specProblems({ ...s, routes: { ...s.routes, fal: { trainer: "fal-ai/wan-22-trainer/i2v-a14b" } } }).join()).toMatch(/learns from video/);
    expect(specProblems({ ...spec("fuobe-soul-core"), routes: { ...spec("fuobe-soul-core").routes, fal: { trainer: "fal-ai/z-image-trainer", extra: { training_type: "vibes" } } } }).join()).toMatch(/training_type takes/);
    expect(specProblems({ ...s, id: "fuobe-unknown", target: { ...s.target, file: "fuobe-unknown.safetensors", hfRepo: "fuobe/fuobe-unknown" } }).join()).toMatch(/neither a planned LoRA/);
    expect(specProblems({ ...s, trigger: "CCTV look" }).join()).toMatch(/trigger/);
    expect(specProblems({ ...spec("fuobe-push-in"), target: { ...spec("fuobe-push-in").target, loraTarget: undefined } }).join()).toMatch(/expert/);
  });

  it("builds the fal request from the trainer's own fields", () => {
    const style = falTrainingPayload(spec("fuobe-soul-core"), "https://example.com/d.zip");
    expect(style).toEqual({ image_data_url: "https://example.com/d.zip", steps: 2500, learning_rate: 0.0001, default_caption: "fbsoulcore style", training_type: "style" });
    const wan = falTrainingPayload(spec("fuobe-push-in"), "https://example.com/c.zip");
    expect(wan).toEqual({ training_data_url: "https://example.com/c.zip", number_of_steps: 800, learning_rate: 0.0002, trigger_phrase: "fbpushin" });
    for (const k of Object.keys(wan)) expect(getTrainer("fal-ai/wan-22-trainer/i2v-a14b")!.fields[k], k).toBeDefined();
  });

  it("builds the AI-Toolkit job for each base", () => {
    const turbo = aiToolkitConfig(spec("fuobe-cctv"), "/data/cctv", "/out").config.process[0] as unknown as Proc;
    expect(turbo.model.arch).toBe("zimage:turbo");
    expect(turbo.model.assistant_lora_path).toMatch(/zimage_turbo_training_adapter_v2/);
    expect(turbo.network).toEqual({ type: "lora", linear: 16, linear_alpha: 16 });
    expect(turbo.train.steps).toBe(1800);
    expect(turbo.trigger_word).toBe("fbcctv");
    // Every Z-Image spec trains on Turbo on the GPU (fal's z-image-trainer is the base route), so one route matches Soul.
    for (const s of specs.filter((x) => x.base === "z-image-turbo")) expect(s.routes.aiToolkit.arch, s.id).toBe("zimage:turbo");
    const core = aiToolkitConfig(spec("fuobe-soul-core"), "/d", "/o").config.process[0] as unknown as Proc;
    expect(core.model.arch).toBe("zimage:turbo");
    expect(core.network.linear).toBe(32);
    const soulBase = spec("fuobe-soul-core");
    const base = aiToolkitConfig({ ...soulBase, routes: { ...soulBase.routes, aiToolkit: { arch: "zimage" } } }, "/d", "/o").config.process[0] as unknown as Proc;
    expect(base.model).toMatchObject({ name_or_path: "Tongyi-MAI/Z-Image", arch: "zimage" });
    const wan = aiToolkitConfig(spec("fuobe-timelapse"), "/clips", "/o").config.process[0] as unknown as Proc;
    expect(wan.model).toMatchObject({ arch: "wan22_14b_i2v", model_kwargs: { train_high_noise: true, train_low_noise: true } });
    expect(wan.datasets[0]).toMatchObject({ folder_path: "/clips", num_frames: 41, fps: 16 });
    expect(wan.train.timestep_type).toBe("linear");
  });
});

describe("training kit: data-licence logs", () => {
  const s = spec("fuobe-cctv");

  it("ships an empty log per spec, so no job can start yet", () => {
    for (const x of specs) {
      const l = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/train/data-logs", `${x.id}.json`), "utf8"));
      expect(l.lora).toBe(x.id);
      expect(dataLogProblems(l, x).join(), x.id).toMatch(/logged/);
    }
  });

  it("passes a complete log, and refuses each gap", () => {
    expect(dataLogProblems(log("fuobe-cctv", 40), s)).toEqual([]);
    expect(dataLogProblems(log("fuobe-cctv", 39), s).join()).toMatch(/39 logged images; the spec needs 40-80/);
    expect(dataLogProblems({ ...log("fuobe-cctv", 40), reviewedBy: "" }, s).join()).toMatch(/reviewed/);
    expect(dataLogProblems(log("fuobe-cctv", 40, { proof: "" }), s).join()).toMatch(/proof/);
    expect(dataLogProblems(log("fuobe-cctv", 40, { source: "licensed" }), s).join()).toMatch(/allows AI training/);
    expect(dataLogProblems(log("fuobe-cctv", 40, { source: "licensed", aiTraining: true }), s)).toEqual([]);
    expect(dataLogProblems(log("fuobe-cctv", 40, { source: "scraped" as never }), s).join()).toMatch(/source must be/);
    expect(dataLogProblems(log("fuobe-cctv", 40, { file: "001.mp4" }), s).join()).toMatch(/not an image/);
  });

  it("asks for a release covering AI training wherever people appear", () => {
    expect(dataLogProblems(log("fuobe-cctv", 40, { people: true }), s).join()).toMatch(/signed release/);
    const consent = { form: "release-2026-11-01-a", date: "2026-11-01", scope: ["ai-training", "marketing"], adults: true };
    expect(dataLogProblems(log("fuobe-cctv", 40, { people: true, consent }), s)).toEqual([]);
    expect(dataLogProblems(log("fuobe-cctv", 40, { people: true, consent: { ...consent, scope: ["marketing"] } }), s).join()).toMatch(/cover AI training/);
    expect(dataLogProblems(log("fuobe-cctv", 40, { people: true, consent: { ...consent, adults: false } }), s).join()).toMatch(/only adults/);
    // The published half keeps that a release exists, not its reference, nor the proof or the author.
    const pub = publicLog(log("fuobe-cctv", 1, { people: true, consent, author: "Jane Doe" }));
    expect(JSON.stringify(pub)).not.toMatch(/release-2026|call sheet|Jane Doe/);
    expect(pub.items[0]).toMatchObject({ people: true, consent: "signed release covering AI training, on file", proof: "on file", source: "own-shoot", sha256: sha("001.jpg") });
    // A CC0 original keeps its public page and author as a credit.
    const cc0 = publicLog(log("fuobe-cctv", 1, { source: "cc0", licence: "CC0-1.0", proof: "https://example.org/photo/1", author: "A. Photographer" }));
    expect(cc0.items[0]).toMatchObject({ original: "https://example.org/photo/1", author: "A. Photographer" });
    expect(cc0.items[0]).not.toHaveProperty("proof");
  });

  it("checks the log against the dataset folder: every file logged, unchanged and captioned", () => {
    const l = log("fuobe-cctv", 40);
    const files = l.items.map((i) => ({ name: i.file, sha256: i.sha256 }));
    const captions = Object.fromEntries(l.items.map((i) => [i.file.replace(".jpg", ".txt"), "fbcctv style, a parking garage at night"]));
    const without = (name: string) => Object.fromEntries(Object.entries(captions).filter(([k]) => k !== name));
    expect(dataLogProblems(l, s, { files, captions })).toEqual([]);
    expect(dataLogProblems(l, s, { files: [...files, { name: "041.jpg", sha256: sha("x") }], captions }).join()).toMatch(/041.jpg is in the dataset but not in the log/);
    expect(dataLogProblems(l, s, { files: files.slice(1), captions }).join()).toMatch(/001.jpg is logged but not in the dataset/);
    expect(dataLogProblems(l, s, { files: [{ ...files[0], sha256: sha("edited") }, ...files.slice(1)], captions }).join()).toMatch(/changed since it was logged/);
    expect(dataLogProblems(l, s, { files, captions: without("001.txt") }).join()).toMatch(/001.jpg has no caption/);
    // A caption says something, with the trigger.
    expect(dataLogProblems(l, s, { files, captions: { ...captions, "002.txt": "  " } }).join()).toMatch(/002.txt is empty/);
    expect(dataLogProblems(l, s, { files, captions: { ...captions, "003.txt": "a parking garage at night" } }).join()).toMatch(/003.txt does not have the trigger fbcctv/);
    expect(dataLogProblems(l, s, { files, captions: { ...captions, "003.txt": "fbcctvx garage" } }).join()).toMatch(/003.txt does not have the trigger/);
    // Nothing else may sit in the folder: a trainer reads more kinds of file than the spec's media.
    expect(dataLogProblems(l, s, { files: [...files, { name: "notes.pdf", sha256: sha("n") }], captions }).join()).toMatch(/notes.pdf is not an image the spec trains on/);
    expect(dataLogProblems(l, s, { files, captions, other: ["extra"] }).join()).toMatch(/extra is a folder or a link/);
    const push = spec("fuobe-push-in");
    const clips: DataLog = { ...log("fuobe-push-in", 20), items: log("fuobe-push-in", 20).items.map((i) => ({ ...i, file: i.file.replace(".jpg", ".mp4") })) };
    const clipFiles = clips.items.map((i) => ({ name: i.file, sha256: i.sha256 }));
    const clipCaptions = Object.fromEntries(clips.items.map((i) => [i.file.replace(".mp4", ".txt"), "fbpushin, a slow push in on the eyes"]));
    expect(dataLogProblems(clips, push, { files: clipFiles, captions: clipCaptions })).toEqual([]);
    const stray = dataLogProblems(clips, push, { files: [...clipFiles, { name: "stray.mkv", sha256: sha("m") }, { name: "still.jpg", sha256: sha("j") }], captions: clipCaptions }).join("\n");
    expect(stray).toMatch(/stray.mkv is not a clip the spec trains on/);
    expect(stray).toMatch(/still.jpg is not a clip the spec trains on/);
    // The zip for the hosted trainer is exactly the logged files and their captions.
    expect(datasetZipNames(log("fuobe-cctv", 2))).toEqual(["001.jpg", "001.txt", "002.jpg", "002.txt"]);
  });
});

describe("training kit: publishing", () => {
  it("names the Hugging Face repo each route trained on as the card's base model", () => {
    expect(hfBaseModel(spec("fuobe-soul-core"), "fal")).toBe("Tongyi-MAI/Z-Image");
    expect(hfBaseModel(spec("fuobe-soul-core"), "ai-toolkit")).toBe("Tongyi-MAI/Z-Image-Turbo");
    expect(hfBaseModel(spec("fuobe-cctv"), "fal")).toBe("Tongyi-MAI/Z-Image-Turbo");
    expect(hfBaseModel(spec("fuobe-push-in"), "fal")).toBe("Wan-AI/Wan2.2-I2V-A14B");
    expect(hfBaseModel(spec("fuobe-push-in"), "ai-toolkit")).toBe("Wan-AI/Wan2.2-I2V-A14B");
    for (const s of specs) for (const r of ["fal", "ai-toolkit"] as const) expect(hfBaseModel(s, r)).toMatch(/^[\w.-]+\/[\w.-]+$/);
  });

  it("takes the licence snapshot from the data-licence log, never assuming one for licensed data", () => {
    const own = trainedLicence(log("fuobe-cctv", 40));
    expect(own.snapshot).toMatchObject({ commercial: true, hostedOk: true, card: { license: "apache-2.0" } });
    expect(own.snapshot!.licence).toMatch(/^Apache-2.0 .*own-shoot.*Fuobe's own/);
    const stock = log("fuobe-cctv", 40, { source: "licensed", aiTraining: true, licence: "StockCo Extended AI" });
    const asked = trainedLicence(stock);
    expect(asked.snapshot).toBeUndefined();
    expect(asked.problems.join()).toMatch(/StockCo Extended AI.*--licence/);
    expect(asked.problems.join()).toMatch(/--commercial/);
    expect(asked.problems.join()).toMatch(/--hosted-ok/);
    const said = trainedLicence(stock, { licence: "StockCo-Derivative", commercial: true, hostedOk: false });
    expect(said.snapshot).toMatchObject({ commercial: true, hostedOk: false, card: { license: "other", licenseName: "stockco-derivative" } });
    expect(said.snapshot!.licence).toMatch(/StockCo-Derivative .*licensed.*StockCo Extended AI/);
  });
});

describe("training kit: the LoRA library's planned entries", () => {
  it("lists every own LoRA as planned, with a licence snapshot, and no preset uses one", () => {
    expect(PLANNED_LORAS).toHaveLength(13);
    const planned = new Set(PLANNED_LORAS.flatMap((p) => [p.key, p.file]));
    for (const p of PLANNED_LORAS) {
      expect(p.status).toBe("planned");
      expect(p.licence.snapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.licence.name).toBeTruthy();
      expect(LORA_LIBRARY.some((e) => e.key === p.key || e.file === p.file), p.key).toBe(false);
    }
    for (const m of MOTION_EFFECT_LORAS) for (const k of m.loras) expect(planned.has(k), k).toBe(false);
    for (const p of research().presets) for (const l of p.loras ?? []) expect(planned.has(l.key) || planned.has(l.file), p.name).toBe(false);
    // The looks waiting for one keep their current recipe (CCTV runs on words and the overlay).
    expect(getPreset("motion-eyes-in")?.open?.loras).toBeUndefined();
  });

  it("is refused by the generator when a preset uses a planned LoRA or an entry has no licence snapshot; a trained block publishes it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kit-gen-"));
    fs.mkdirSync(path.join(tmp, "scripts"));
    fs.mkdirSync(path.join(tmp, "docs/research"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "src/lib/catalog"), { recursive: true });
    fs.copyFileSync(path.join(ROOT, "scripts/gen-lora-library.py"), path.join(tmp, "scripts/gen-lora-library.py"));
    const run = (data: unknown) => {
      fs.writeFileSync(path.join(tmp, "docs/research/fuobe-originals-recipes-5.json"), JSON.stringify(data));
      return execFileSync("python3", [path.join(tmp, "scripts/gen-lora-library.py")], { stdio: "pipe" }).toString();
    };
    try {
      let data = research();
      data.presets.find((p: { name: string }) => p.name === "CCTV").loras = [{ key: "fuobe-cctv", file: "fuobe-cctv.safetensors", strength: 0.8 }];
      expect(() => run(data)).toThrow(/uses the planned LoRA fuobe-cctv/);
      data = research();
      delete data.loraLibrary.find((l: { key: string }) => l.key === "awportrait").licence;
      expect(() => run(data)).toThrow(/awportrait: no licence snapshot/);
      data = research();
      data.loraLibrary.find((l: { key: string }) => l.key === "awportrait").hostedOk = undefined;
      expect(() => run(data)).toThrow(/no licence snapshot/);
      // Published (kit.mjs publish --write-research): the entry moves into the library, pinned, with its licence.
      data = research();
      const own = data.fuobeTrainedLoras.find((x: { id: string }) => x.id === "fuobe-cctv");
      own.trained = {
        file: "fuobe-cctv.safetensors",
        url: "https://huggingface.co/fuobe/fuobe-cctv/resolve/main/fuobe-cctv.safetensors",
        page: "https://huggingface.co/fuobe/fuobe-cctv",
        strength: 0.8,
        trigger: "fbcctv",
        download: "direct",
        licence: "Apache-2.0 (Fuobe's own data, data-licence log)",
        commercial: true,
        hostedOk: true,
        checked: "2026-12-01",
        revision: "a".repeat(40),
        sha256: "b".repeat(64),
        sizeBytes: 170_000_000,
      };
      expect(run(data)).toMatch(/12 planned own LoRAs/);
      const ts = fs.readFileSync(path.join(tmp, "src/lib/catalog/lora-library.generated.ts"), "utf8");
      expect(ts).toContain(`"url": "https://huggingface.co/fuobe/fuobe-cctv/resolve/${"a".repeat(40)}/fuobe-cctv.safetensors"`);
      expect(ts).toContain(`"snapshotDate": "2026-12-01"`);
      // Without its pins it is refused like any other file.
      delete own.trained.sha256;
      expect(() => run(data)).toThrow(/fuobe-cctv: no SHA256 pin/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("training kit: the motion library", () => {
  const moves = research().motionsEffects.find((m: { status: string }) => m.status === "motion-library").presets as string[];
  const clip = (over: Partial<MotionClip> = {}): MotionClip => ({
    url: "https://huggingface.co/fuobe/motion-library/resolve/" + "c".repeat(40) + "/boxing-01.mp4",
    sha256: sha("boxing"),
    seconds: 5,
    fps: 24,
    width: 1080,
    height: 1920,
    source: "own-shoot",
    licence: "Fuobe's own",
    proof: "shoot 2026-11 sports day",
    author: "Fuobe team",
    date: "2026-11-01",
    people: true,
    consent: { form: "release-7", date: "2026-11-01", scope: ["ai-training"], adults: true },
    ...over,
  });

  it("lists the 13 sports moves once each, with no clips yet, so every move keeps its current route", () => {
    expect(moves).toHaveLength(13);
    expect(motionLibraryProblems(MOTION_LIBRARY, moves)).toEqual([]);
    for (const m of MOTION_LIBRARY.moves) {
      expect(getPreset(m.presetId), m.presetId).toBeDefined();
      expect(motionLibraryClip(m.presetId)).toBeUndefined();
      // Until a clip is present the move is Fuobe DoP on its words, as before.
      expect(getPreset(m.presetId)!.open?.loras).toBeUndefined();
    }
  });

  it("checks each clip's licence fields and picks up the first clip that passes", () => {
    const lib = { ...MOTION_LIBRARY, moves: MOTION_LIBRARY.moves.map((m) => (m.preset === "Boxing" ? { ...m, clips: [clip({ source: "licensed" as never }), clip()] } : m)) };
    expect(motionLibraryProblems(lib, moves).join()).toMatch(/Boxing clip 1: driving clips are CC0/);
    expect(motionLibraryClip("motion-boxing", lib)).toEqual(clip());
    expect(motionLibraryClip("Boxing", lib)?.source).toBe("own-shoot");
    expect(motionLibraryProblems({ ...lib, moves: lib.moves.slice(1) }, moves).join()).toMatch(/Baseball Kick is missing/);
    const bad = (over: Partial<MotionClip>) => motionLibraryProblems({ ...MOTION_LIBRARY, moves: [{ ...MOTION_LIBRARY.moves[0], clips: [clip(over)] }, ...MOTION_LIBRARY.moves.slice(1)] }, moves).join();
    expect(bad({ seconds: 14 })).toMatch(/2-10 s/);
    expect(bad({ consent: undefined })).toMatch(/signed release/);
    expect(bad({ url: "http://x/y.mp4" })).toMatch(/https/);
    expect(bad({ source: "cc0", licence: "CC0-1.0", people: false, consent: undefined })).toBe("");
  });
});

describe("training kit: the command line", () => {
  const node = (args: string[]) => execFileSync("node", [KIT, ...args], { cwd: ROOT, stdio: "pipe" }).toString();
  /** A refused command: its exit code and everything it printed. */
  const refused = (args: string[]) => {
    const r = spawnSync("node", [KIT, ...args], { cwd: ROOT, encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  };

  it("refuses a job whose data-licence log is incomplete", () => {
    expect(refused(["check", "fuobe-cctv"])).toEqual({ status: 1, out: expect.stringMatching(/fuobe-cctv: not ready[\s\S]*0 logged images/) });
    expect(refused(["check", "--all"]).status).toBe(1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kit-data-"));
    try {
      expect(refused(["job", "fuobe-cctv", "--dataset", dir])).toEqual({ status: 1, out: expect.stringMatching(/does not start until/) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes both routes' configs once the log matches the dataset, and dry-runs a publish", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kit-ok-"));
    const data = path.join(tmp, "data");
    const logs = path.join(tmp, "logs");
    fs.mkdirSync(data);
    fs.mkdirSync(logs);
    const l = log("fuobe-cctv", 40);
    for (const i of l.items) {
      fs.writeFileSync(path.join(data, i.file), i.file);
      fs.writeFileSync(path.join(data, i.file.replace(".jpg", ".txt")), "fbcctv style, a parking garage at night seen from a high corner");
    }
    fs.writeFileSync(path.join(logs, "fuobe-cctv.json"), JSON.stringify(l));
    const env = { ...process.env, FUOBE_TRAIN_LOGS: logs };
    const run = (args: string[]) => execFileSync("node", [KIT, ...args], { cwd: ROOT, env, stdio: "pipe" }).toString();
    // The job downloads the zip URL, so it runs while this process serves the zip.
    const runAsync = (args: string[]) =>
      promisify(execFile)("node", [KIT, ...args], { cwd: ROOT, env }).then(
        (r) => r.stdout,
        (e: { stdout: string; stderr: string; code: number }) => ({ refused: e.code, out: e.stdout + e.stderr }),
      );
    let served = Buffer.from("");
    const server = http.createServer((_, res) => res.end(served));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const zipUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cctv.zip`;
    try {
      expect(run(["check", "fuobe-cctv", "--dataset", data])).toMatch(/fuobe-cctv: ready/);
      const out = path.join(tmp, "out");
      // First the zip of exactly the checked files; the fal request waits for its URL.
      expect(run(["job", "fuobe-cctv", "--dataset", data, "--out", out])).toMatch(/upload .*fuobe-cctv\.dataset\.zip/);
      expect(JSON.parse(fs.readFileSync(path.join(out, "fuobe-cctv.aitk.json"), "utf8")).config.process[0].datasets[0].folder_path).toBe(data);
      expect(fs.existsSync(path.join(out, "fuobe-cctv.fal.json"))).toBe(false);
      const zip = fs.readFileSync(path.join(out, "fuobe-cctv.dataset.zip"));
      const listing = execFileSync("python3", ["-I", "-m", "zipfile", "-l", path.join(out, "fuobe-cctv.dataset.zip")]).toString();
      expect(listing.match(/\d{3}\.(jpg|txt)/g)).toHaveLength(80);
      // A URL that serves something else is refused; the zip the kit built is taken.
      served = Buffer.from("another dataset");
      expect(await runAsync(["job", "fuobe-cctv", "--dataset", data, "--zip-url", zipUrl, "--out", out])).toEqual({ refused: 1, out: expect.stringMatching(/is not fuobe-cctv\.dataset\.zip/) });
      served = zip;
      expect(await runAsync(["job", "fuobe-cctv", "--dataset", data, "--zip-url", zipUrl, "--out", out])).toMatch(/Not run here/);
      expect(JSON.parse(fs.readFileSync(path.join(out, "fuobe-cctv.fal.json"), "utf8"))).toEqual({
        endpoint: "fal-ai/z-image-turbo-trainer-v2",
        input: { image_data_url: zipUrl, steps: 1800, learning_rate: 0.0001, default_caption: "fbcctv style" },
        datasetZip: { file: "fuobe-cctv.dataset.zip", sha256: crypto.createHash("sha256").update(zip).digest("hex") },
      });
      // A stray file the trainer would also read stops the job.
      fs.writeFileSync(path.join(data, "extra.webm"), "unlogged");
      const stray = spawnSync("node", [KIT, "job", "fuobe-cctv", "--dataset", data], { cwd: ROOT, env, encoding: "utf8" });
      expect({ status: stray.status, out: stray.stdout + stray.stderr }).toEqual({ status: 1, out: expect.stringMatching(/fuobe-cctv: not ready\n {2}data-licence log: extra\.webm is not an image the spec trains on/) });
      fs.rmSync(path.join(data, "extra.webm"));
      // A changed image stops the job.
      fs.writeFileSync(path.join(data, "007.jpg"), "edited");
      const changed = spawnSync("node", [KIT, "job", "fuobe-cctv", "--dataset", data], { cwd: ROOT, env, encoding: "utf8" });
      expect({ status: changed.status, out: changed.stdout }).toEqual({ status: 1, out: expect.stringMatching(/007\.jpg changed since it was logged/) });
      const file = path.join(tmp, "trained.safetensors");
      fs.writeFileSync(file, "weights");
      const publish = (args: string[]) => execFileSync("node", [KIT, "publish", "fuobe-cctv", "--file", file, ...args], { cwd: ROOT, env: { ...env, TMPDIR: tmp }, stdio: "pipe" }).toString();
      expect(() => publish([])).toThrow(/--route fal\|ai-toolkit/);
      const dry = publish(["--route", "ai-toolkit"]);
      expect(dry).toMatch(/Dry run: nothing uploaded/);
      expect(dry).toContain(`"url": "https://huggingface.co/fuobe/fuobe-cctv/resolve/main/fuobe-cctv.safetensors"`);
      expect(dry).toContain(`"sha256": "${sha("weights")}"`);
      expect(dry).toMatch(/"licence": "Apache-2.0 \(Fuobe-trained; data: own-shoot/);
      const stage = fs.readdirSync(tmp).find((n) => n.startsWith("fuobe-publish-fuobe-cctv-"))!;
      const card = fs.readFileSync(path.join(tmp, stage, "README.md"), "utf8");
      expect(card).toMatch(/^---\nlicense: apache-2.0\nbase_model: Tongyi-MAI\/Z-Image-Turbo\nbase_model_relation: adapter\n/);
      expect(fs.readFileSync(path.join(tmp, stage, "data-licence-log.json"), "utf8")).not.toMatch(/call sheet|Fuobe team/);
      // Licensed data: the licence is said, not assumed.
      fs.writeFileSync(path.join(logs, "fuobe-cctv.json"), JSON.stringify(log("fuobe-cctv", 40, { source: "licensed", aiTraining: true, licence: "StockCo AI" })));
      expect(() => publish(["--route", "fal"])).toThrow(/recorded, not assumed/);
      expect(publish(["--route", "fal", "--licence", "StockCo-Derivative", "--commercial", "no", "--hosted-ok", "no"])).toMatch(/"commercial": false,\s*"hostedOk": false/);
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lists the specs with their fal price, and the motion library's state", () => {
    expect(node(["list"])).toMatch(/fuobe-cctv\s+planned\s+image\s+log\s+0\/40-80\s+fal fal-ai\/z-image-turbo-trainer-v2 ≈ \$1\.53/);
    expect(node(["motions"])).toMatch(/Boxing\s+0 clip\(s\)\s+keeps its current route/);
  });

  it("publishes as a dry run by default, and never without a complete log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuobe-kit-pub-"));
    const file = path.join(dir, "trained.safetensors");
    fs.writeFileSync(file, "weights");
    try {
      expect(refused(["publish", "fuobe-cctv", "--file", file, "--route", "fal"])).toEqual({ status: 1, out: expect.stringMatching(/only with a complete data-licence log/) });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
