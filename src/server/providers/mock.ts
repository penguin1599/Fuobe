import "server-only";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { IDOL_VIEW_ORDER, idolViewMeta, wantsIdolViews } from "@/lib/av/idol-views";
import { cueText, parseCues, type Cue } from "@/lib/cues";
import { H3_REMOVAL_WORKFLOW } from "@/lib/catalog/character-swap";
import { HAND_OFF, windowArtifact } from "@/lib/catalog/remove-object";
import { OPERATION_OUTPUT, type MediaKind, type Operation } from "@/lib/catalog/types";
import { spectralColor } from "@/lib/scene3d";
import { imageSize } from "@/lib/image-size";
import type { ProviderAdapter, RemoteOutput } from "./types";
import { textOutput } from "./llm";
import { encodePng } from "../png";
import { toDataUri } from "../storage";
import { zip } from "../zip";

/**
 * Demo provider: lets anyone click through the whole product with no API keys or GPU.
 * Produces abstract placeholder art (SVG) for images, a bundled sample clip for video, a short
 * tone for audio, labelled text for transcripts/translations/scripts and a sample .glb for 3D,
 * with the structured extras real providers return (layer boxes, cues, text blocks, stems, OCR lines with boxes,
 * numbered frames).
 * Clearly labelled as demo output.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function demoSvg(prompt: string, aspectRatio = "1:1", variant = 0): string {
  const [aw, ah] = (aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)?.slice(1).map(Number) ?? [1, 1]) as number[];
  const width = 1024;
  const height = Math.round((1024 * ah) / aw);
  const r = rng(hash(`${prompt}#${variant}`));
  const hue = Math.floor(r() * 360);
  const blobs = Array.from({ length: 6 }, (_, i) => {
    const h = (hue + i * 47 + r() * 40) % 360;
    return `<circle cx="${(r() * width).toFixed(0)}" cy="${(r() * height).toFixed(0)}" r="${(180 + r() * 320).toFixed(0)}" fill="oklch(${(0.62 + r() * 0.25).toFixed(2)} ${(0.12 + r() * 0.1).toFixed(2)} ${h})" opacity="${(0.55 + r() * 0.4).toFixed(2)}"/>`;
  }).join("");
  const words = prompt.trim().split(/\s+/).slice(0, 18);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > 28) {
      lines.push(cur.trim());
      cur = w;
    } else cur += " " + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  const text = lines
    .slice(0, 4)
    .map((l, i) => `<text x="64" y="${height - 72 - (Math.min(lines.length, 4) - 1 - i) * 44}" font-size="34" font-family="ui-sans-serif, system-ui" font-weight="600" fill="white" fill-opacity="0.92">${escapeXml(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="90"/></filter>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="black" stop-opacity="0"/><stop offset="1" stop-color="black" stop-opacity="0.55"/></linearGradient></defs>
<rect width="100%" height="100%" fill="oklch(0.3 0.06 ${hue})"/>
<g filter="url(#b)">${blobs}</g>
<rect width="100%" height="100%" fill="url(#s)"/>
<rect x="56" y="48" rx="18" width="176" height="40" fill="white" fill-opacity="0.18"/>
<text x="76" y="75" font-size="20" font-family="ui-sans-serif, system-ui" font-weight="600" fill="white">PLACEHOLDER</text>
${text}
</svg>`;
}

function demoWav(seconds = 2, tones: [number, number] = [440, 660], wobble = 0): Buffer {
  const rate = 22050;
  const n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 2000, (n - i) / 2000);
    // A slow tremolo makes the "voice" stem sound different from the steady "background" one.
    const am = wobble ? 0.55 + 0.45 * Math.sin((2 * Math.PI * wobble * i) / rate) : 1;
    const v = (Math.sin((2 * Math.PI * tones[0] * i) / rate) * 0.25 + Math.sin((2 * Math.PI * tones[1] * i) / rate) * 0.12) * env * am;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const DURATION_MS: Record<MediaKind, number> = { image: 3500, video: 7000, audio: 3000, text: 2500, model3d: 6000 };

type DemoOutput = RemoteOutput & { text?: string; meta?: Record<string, unknown> };

const svgUri = (svg: string) => toDataUri(Buffer.from(svg), "image/svg+xml");

function canvas(aspectRatio: string) {
  const [aw, ah] = (aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)?.slice(1).map(Number) ?? [1, 1]) as number[];
  return { w: 1024, h: Math.round((1024 * ah) / aw) };
}

/** Layers: a full-frame background plus 2–3 cut-out shapes on transparency, each with name, z and bbox [x, y, w, h]. */
function demoLayers(prompt: string, aspectRatio: string, n: number): DemoOutput[] {
  const { w, h } = canvas(aspectRatio);
  const hue = Math.floor(rng(hash(`${prompt}#layers`))() * 360);
  const layer = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
  const label = escapeXml(prompt.split(/\s+/).slice(0, 3).join(" ") || "Placeholder");
  const all: { name: string; box: number[]; draw: (b: number[]) => string }[] = [
    { name: "Subject", box: [w * 0.28, h * 0.22, w * 0.44, h * 0.6], draw: (b) => `<ellipse cx="${b[0] + b[2] / 2}" cy="${b[1] + b[3] / 2}" rx="${b[2] / 2}" ry="${b[3] / 2}" fill="oklch(0.72 0.17 ${(hue + 40) % 360})"/>` },
    { name: "Prop", box: [w * 0.08, h * 0.62, w * 0.26, h * 0.3], draw: (b) => `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="28" fill="oklch(0.8 0.14 ${(hue + 150) % 360})"/>` },
    {
      name: "Text",
      box: [w * 0.06, h * 0.06, w * 0.6, h * 0.1],
      draw: (b) => `<text x="${b[0]}" y="${b[1] + b[3] * 0.75}" font-size="${Math.round(b[3] * 0.7)}" font-family="ui-sans-serif, system-ui" font-weight="700" fill="white">${label}</text>`,
    },
  ];
  const shapes = all.slice(0, Math.max(2, Math.min(3, n - 1)));
  const background: DemoOutput = {
    url: svgUri(
      layer(
        `<rect width="100%" height="100%" fill="oklch(0.32 0.07 ${hue})"/><rect x="40" y="${h - 76}" rx="14" width="300" height="40" fill="white" fill-opacity="0.18"/><text x="58" y="${h - 49}" font-size="20" font-family="ui-sans-serif, system-ui" font-weight="600" fill="white">PLACEHOLDER · layers</text>`,
      ),
    ),
    kind: "image",
    contentType: "image/svg+xml",
    meta: { name: "Background", z: 0, bbox: [0, 0, w, h], demo: true },
  };
  return [
    background,
    ...shapes.map((s, i) => ({
      url: svgUri(layer(s.draw(s.box))),
      kind: "image" as const,
      contentType: "image/svg+xml",
      meta: { name: s.name, z: i + 1, bbox: s.box.map(Math.round), demo: true },
    })),
  ];
}

/** Text layers: the picture with its text removed, plus the text blocks that were on it. */
function demoTextLayers(prompt: string, aspectRatio: string): DemoOutput[] {
  const { w, h } = canvas(aspectRatio);
  const headline = prompt.split(/\s+/).slice(0, 4).join(" ") || "Your headline";
  const box = (x: number, y: number, bw: number, bh: number) => [x * w, y * h, bw * w, bh * h].map(Math.round);
  return [
    {
      url: svgUri(demoSvg("", aspectRatio, 7)),
      kind: "image",
      contentType: "image/svg+xml",
      meta: {
        name: "Background",
        z: 0,
        bbox: [0, 0, w, h],
        demo: true,
        textBlocks: [
          { text: headline.toUpperCase(), bbox: box(0.08, 0.1, 0.84, 0.12), fontFamily: "Inter", fontWeight: 800, fontSize: Math.round(h * 0.08), color: "#ffffff", align: "left" },
          { text: "Demo text block — connect a provider to read the real text", bbox: box(0.08, 0.24, 0.7, 0.05), fontFamily: "Inter", fontWeight: 500, fontSize: Math.round(h * 0.03), color: "#e8e6ff", align: "left" },
        ],
      },
    },
  ];
}

/** A demo transcript: a few timed lines that say what they are. */
function demoCues(prompt: string): Cue[] {
  const lines = [
    "This is a demo transcript.",
    "Connect a speech-to-text provider in Settings,",
    "or start ComfyUI, to transcribe your clip for real.",
    prompt ? `You asked for: ${prompt.slice(0, 80)}` : "Every line keeps its timing.",
  ];
  return lines.map((text, i) => ({ start: i * 2.5, end: i * 2.5 + 2.3, text }));
}

/** Demo translation: each line (or cue) tagged with the language, timing kept. */
function demoTranslate(source: string, language: string): DemoOutput {
  const tag = (t: string) => `[${language}] ${t}`;
  const cues = parseCues(source);
  if (cues) {
    const out = cues.map((c) => ({ ...c, text: tag(c.text) }));
    return textOutput(cueText(out), out, { language, demo: true });
  }
  const body = source.trim()
    ? source
        .split("\n")
        .map((l) => (l.trim() ? tag(l) : l))
        .join("\n")
    : tag("Demo translation");
  return textOutput(`${body}\n\n(Demo translation — connect Claude or a local model (Ollama, LM Studio or Unsloth Studio) in Settings to translate for real.)`, null, { language, demo: true });
}

function demoWrite(brief: string): DemoOutput {
  const topic = brief.trim().replace(/[.\s]+$/, "") || "your idea";
  return textOutput(
    [
      `Demo script for: ${topic}`,
      "",
      "HOOK — Open on the most striking image, no intro.",
      "BEAT 1 — Show the problem in one shot.",
      "BEAT 2 — Reveal the product or idea solving it.",
      "BEAT 3 — A close-up detail that makes it feel real.",
      "CLOSE — One line call to action.",
      "",
      "(Demo text — connect Claude or a local model (Ollama, LM Studio or Unsloth Studio) in Settings to write for real.)",
    ].join("\n"),
    null,
    { demo: true },
  );
}

const sampleClip = (ar: string) => (ar === "9:16" || ar === "3:4" || ar === "2:3" ? "demo-portrait.mp4" : ar === "1:1" ? "demo-square.mp4" : "demo-landscape.mp4");

/** OCR: a few lines with their boxes (x, y, w, h as fractions of the picture), as a real reader returns them. */
function demoOcr(brief: string): DemoOutput {
  const lines = [
    { text: "DEMO TEXT", bbox: [0.08, 0.1, 0.52, 0.09] },
    { text: brief ? brief.slice(0, 60) : "Every line comes with its box", bbox: [0.08, 0.24, 0.7, 0.05] },
    { text: "Connect fal or start ComfyUI to read the real text", bbox: [0.08, 0.84, 0.78, 0.04] },
  ];
  return textOutput(lines.map((l) => l.text).join("\n"), null, { lines, demo: true });
}

/** The picture a data URI carries (the Watermark Remover's input, which the demo keeps whole), else null. */
function dataUriBytes(uri: unknown): Buffer | null {
  const m = typeof uri === "string" ? /^data:[^;,]+;base64,(.*)$/s.exec(uri) : null;
  return m ? Buffer.from(m[1], "base64") : null;
}

/**
 * The Watermark Remover's scan in demo mode: a report like the pack's (pixels), with a caption across the lower third and a
 * corner logo, sized to the picture (a 1000 x 1000 one when its size can't be read).
 */
export function demoWatermarkReport(image: unknown): string {
  const bytes = dataUriBytes(image);
  const size = (bytes && imageSize(bytes)) || { width: 1000, height: 1000 };
  const { width: w, height: h } = size;
  const px = (b: number[]) => [Math.round(b[0] * w), Math.round(b[1] * h), Math.round(b[2] * w), Math.round(b[3] * h)];
  const boxes = [
    { label: "caption text across the picture", bbox: px([0.14, 0.58, 0.86, 0.74]), source_bbox: px([0.18, 0.61, 0.82, 0.7]), overlay_type: "translucent_text_logo", mask_method: "rectangle", confidence: 0.92 },
    { label: "round logo in the corner", bbox: px([0.76, 0.06, 0.96, 0.24]), source_bbox: px([0.79, 0.08, 0.93, 0.21]), overlay_type: "text_logo", mask_method: "rectangle", confidence: 0.88 },
  ];
  return JSON.stringify({ coordinate_space: "pixels", image_size: [w, h], boxes, rejected_boxes: [], status: "detected", demo: true });
}

/** A black-and-white mask (white = the object) in the picture's shape. */
function demoMaskSvg(ar: string): string {
  const [w, h] = ar === "9:16" || ar === "3:4" || ar === "2:3" ? [360, 640] : ar === "1:1" ? [512, 512] : [640, 360];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#000"/><ellipse cx="${w * 0.55}" cy="${h * 0.6}" rx="${w * 0.12}" ry="${h * 0.14}" fill="#fff"/></svg>`;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));

/**
 * A depth map like a depth model's PNG, 512 px wide in the request's shape: a back wall, a floor that comes closer
 * toward the bottom of the frame and three rounded subjects standing on it. Grey (bright = near) like MoGe's on the
 * open engine; painted with the Spectral colour map (red = near) like Marigold's on the cloud.
 */
function demoDepth(prompt: string, aspectRatio: string, spectral: boolean): DemoOutput {
  const { w: cw, h: ch } = canvas(aspectRatio);
  const w = 512;
  const h = Math.max(16, Math.round((w * ch) / cw));
  const r = rng(hash(`${prompt}#depth`));
  const blobs = Array.from({ length: 3 }, (_, i) => ({ x: 0.2 + i * 0.3 + (r() - 0.5) * 0.1, y: 0.5 + r() * 0.2, rx: 0.07 + r() * 0.07, ry: 0.14 + r() * 0.12, near: 0.5 + r() * 0.3 }));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      let near = 0.12 + 0.68 * Math.max(0, (v - 0.4) / 0.6) ** 1.3;
      for (const b of blobs) {
        const d = ((u - b.x) / b.rx) ** 2 + ((v - b.y) / b.ry) ** 2;
        if (d < 1) near = Math.max(near, b.near + 0.08 * Math.sqrt(1 - d));
      }
      const n = clamp(near, 0, 1);
      const g = Math.round(n * 255);
      data.set(spectral ? [...spectralColor(1 - n), 255] : [g, g, g, 255], (y * w + x) * 4);
    }
  return { url: toDataUri(encodePng({ width: w, height: h, data }), "image/png"), kind: "image", contentType: "image/png", meta: { role: "depth", demo: true } };
}

function demoOutputs(op: Operation | undefined, kind: MediaKind, prompt: string, ar: string, meta: Record<string, unknown>): DemoOutput[] {
  // The prompt falls back to the op name when a step has none.
  const brief = prompt === op ? "" : prompt;
  switch (op) {
    case "layers":
      return demoLayers(brief, ar, Math.max(3, Math.min(4, Number(meta.numLayers ?? 4))));
    case "text-layers":
      return demoTextLayers(brief, ar);
    case "transcribe": {
      const cues = demoCues(brief);
      return [textOutput(cueText(cues), cues, { language: meta.sourceLanguage ?? "English", demo: true })];
    }
    case "translate":
      return [demoTranslate(brief, String(meta.targetLanguage ?? "Spanish"))];
    case "write":
      return [demoWrite(brief)];
    case "enhance-voice": {
      // Clean up voice: the demo's clean voice (public/samples/clean-voice), else a tone.
      const file = path.join(process.cwd(), "public", "samples", "clean-voice", "clean.m4a");
      const after = fs.existsSync(file) ? toDataUri(fs.readFileSync(file), "audio/mp4") : null;
      return [after ? { url: after, kind: "audio", contentType: "audio/mp4", meta: { stem: "voice", demo: true } } : { url: toDataUri(demoWav(3, [220, 330], 3), "audio/wav"), kind: "audio", contentType: "audio/wav", meta: { stem: "voice", demo: true } }];
    }
    case "separate-audio": {
      const stem = (name: string, wav: Buffer): DemoOutput => ({ url: toDataUri(wav, "audio/wav"), kind: "audio", contentType: "audio/wav", meta: { stem: name, demo: true } });
      // A dialogue / music / effects split (DBS) returns those three and the music-and-effects bed, voice first.
      // A remix of the split at set levels (DBS graph C, Clean up dialogue): one track, the clean dialogue.
      if (meta.remix) return [stem("voice", demoWav(3, [220, 330], 3))];
      const stems: DemoOutput[] = meta.threeStems
        ? [stem("voice", demoWav(3, [220, 330], 3)), stem("music", demoWav(3, [262, 392])), stem("effects", demoWav(3, [90, 140], 7)), stem("background", demoWav(3, [110, 165]))]
        : [stem("voice", demoWav(3, [220, 330], 3)), stem("background", demoWav(3, [110, 165]))];
      // Workflows that also time the voice stem (the open dub's first step) return its cues too.
      if (meta.transcript) {
        const cues = demoCues("");
        stems.push(textOutput(cueText(cues), cues, { role: "cues", language: meta.sourceLanguage ?? "English", demo: true }));
      }
      return stems;
    }
    case "image-to-3d":
    case "text-to-3d":
      return [
        { url: "sample:demo-model.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { demo: true, format: "glb" } },
        { url: "sample:demo-turntable.mp4", kind: "video", contentType: "video/mp4", meta: { demo: true, turntable: true } },
      ];
    // Round 4. A rig comes back as the demo mesh. A scene is the mesh and its depth map on the open engine (MoGe),
    // the depth map alone on the cloud (Marigold).
    case "scene-3d": {
      const depth = demoDepth(brief, ar, kind === "image");
      if (kind === "image") return [depth];
      return [{ url: "sample:demo-model.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { demo: true, format: "glb", scene: true, role: "scene" } }, depth];
    }
    // A splat is a real one (scripts/gen-demo-splat.mjs), so the splat viewer opens in demo mode: an .spz with its
    // orbit video on the open engine (as the TripoSplat and Idol 3D graphs write), a .ply on the cloud (fal's).
    case "splat":
      // Idol 3D's four views of the object (front, left, back, right), as image-to-views-idol returns them.
      if (meta.idolViews) return IDOL_VIEW_ORDER.map((side, index) => ({ url: svgUri(demoSvg(`${side} view`, "1:1", index)), kind: "image" as const, contentType: "image/svg+xml", meta: { ...idolViewMeta(index), role: "tiles", demo: true } }));
      return meta.openSplat
        ? [
            { url: "sample:demo-splat.spz", kind: "model3d", contentType: "model/x-spz", meta: { demo: true, format: "spz", role: "splat" } },
            { url: "sample:demo-turntable.mp4", kind: "video", contentType: "video/mp4", meta: { demo: true, turntable: true } },
          ]
        : [{ url: "sample:demo-splat.ply", kind: "model3d", contentType: "model/ply", meta: { demo: true, format: "ply" } }];
    case "rig-3d":
      return [{ url: "sample:demo-model.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { demo: true, format: "glb", rigged: true } }];
    // Hi3D's refine: the demo mesh, geometry only as the real one is.
    case "refine-3d":
      return [{ url: "sample:demo-model.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { demo: true, format: "glb", refined: true, geometryOnly: true } }];
    // A retexture comes back as the demo mesh (a real one is the same model with its new textures).
    case "retexture-3d":
      return [{ url: "sample:demo-model.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { demo: true, format: "glb", retextured: true } }];
    case "ocr":
      return [demoOcr(brief)];
    // As many frames as were asked for (max_frames), 4 without a count.
    case "extract-frames":
      return Array.from({ length: clamp(Math.round(Number(meta.frames ?? 4)), 1, 500) }, (_, index) => ({ url: svgUri(demoSvg(`frame ${index + 1}`, ar, index)), kind: "image" as const, contentType: "image/svg+xml", meta: { index, demo: true } }));
    case "overlay":
      return [{ url: svgUri(demoSvg(brief || "overlay", ar, 5)), kind: "image", contentType: "image/svg+xml", meta: { demo: true } }];
    // The face mosaic (O11): a demo picture; no masks, so the browser has nothing to pixelate.
    case "face-mosaic":
      return [{ url: svgUri(demoSvg(brief || "pixelated faces", ar, 6)), kind: "image", contentType: "image/svg+xml", meta: { demo: true } }];
    // A song's stems (Mureka): its vocals and instruments, one track each.
    case "song-stems":
      return (
        [
          ["vocals", [330, 495]],
          ["drums", [90, 140]],
          ["bass", [55, 82]],
          ["other", [262, 392]],
        ] as const
      ).map(([stem, tones]) => ({ url: toDataUri(demoWav(3, [tones[0], tones[1]]), "audio/wav"), kind: "audio" as const, contentType: "audio/wav", meta: { stem, demo: true } }));
    // The Watermark Remover: two marks sized to the picture; the removal gives the picture back as it came (a demo).
    case "watermark-scan":
      return [textOutput(demoWatermarkReport(meta.image), null, { role: "report", demo: true })];
    case "watermark-remove": {
      const image = typeof meta.image === "string" && meta.image.startsWith("data:image/") ? meta.image : null;
      const contentType = image ? image.slice(5, image.indexOf(";")) : "image/svg+xml";
      return [{ url: image ?? svgUri(demoSvg("clean picture", ar, 6)), kind: "image", contentType, meta: { demo: true, quality: { status: "completed_clean_first_pass", selectedPass: 1, outsideMaskMaxDifference: 0, needsReview: false } } }];
    }
    // The same tone, as long as the loop was asked to be (or the clips joined end to end).
    case "audio-loop":
      return [{ url: toDataUri(demoWav(clamp(Math.round(Number(meta.duration ?? 12)), 4, 30)), "audio/wav"), kind: "audio", contentType: "audio/wav", meta: { demo: true } }];
    case "audio-join":
      return [{ url: toDataUri(demoWav(clamp(3 * Number(meta.clips ?? 2), 4, 30), [330, 495]), "audio/wav"), kind: "audio", contentType: "audio/wav", meta: { demo: true } }];
    case "remove-object":
      return [
        { url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", meta: { demo: true, ...(meta.h3Review ? demoRemovalReview(ar) : {}) } },
        // The painted eraser also hands the window's last tracked mask to the next window.
        ...(meta.lastMask ? [{ url: svgUri(demoMaskSvg(ar)), kind: "image" as const, contentType: "image/svg+xml", meta: { role: "mask", demo: true } }] : []),
      ];
    case "bg-remove-video":
      return [{ url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", meta: { demo: true, role: meta.matteOutput } }];
    case "video-swap":
      return [
        { url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", meta: { demo: true } },
        // Character Swap Studio's segment graph also saves a lossless master the next segment continues from.
        ...(meta.master ? [{ url: `sample:${sampleClip(ar)}`, kind: "video" as const, contentType: "video/mp4", meta: { role: "master", demo: true } }] : []),
      ];
    case "video-insert":
    case "insert-moment":
    case "restore-video":
    case "keyframes":
    case "still-motion":
    case "images-to-video":
      return [{ url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", meta: { demo: true } }];
    case "sdr-to-hdr":
    case "export-video": {
      // EXR frames ride along on the preview clip as a zip (meta.artifacts.exr), as the real routes do.
      const exr = meta.format === "exr" ? { artifacts: { exr: toDataUri(zip([{ name: "README.txt", data: Buffer.from("Demo mode: a real run puts one 16-bit EXR file per frame here.\n") }]), "application/zip") } } : {};
      return [{ url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", meta: { demo: true, ...(meta.format ? { format: meta.format } : {}), ...exr } }];
    }
    case "trim":
    case "captions":
    case "mux":
      return [
        { url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", meta: { demo: true } },
        // The segment cutter also hands over the segment's first frame (Shorts restyles it, then the clip).
        ...(meta.firstFrame ? [{ url: svgUri(demoSvg("first frame", ar, 3)), kind: "image" as const, contentType: "image/svg+xml", meta: { role: "first-frame", demo: true } }] : []),
      ];
  }
  if (kind === "image") {
    return Array.from({ length: Number(meta.count) }, (_, i) => ({ url: svgUri(demoSvg(prompt, ar, i)), kind: "image" as const, contentType: "image/svg+xml" }));
  }
  if (kind === "audio") return [{ url: toDataUri(demoWav(), "audio/wav"), kind: "audio", contentType: "audio/wav" }];
  if (kind === "text") return [textOutput(`Demo text for: ${brief || "your request"}`, null, { demo: true })];
  if (kind === "model3d") return [{ url: "sample:demo-model.glb", kind: "model3d", contentType: "model/gltf-binary", meta: { demo: true } }];
  return [{ url: `sample:${sampleClip(ar)}`, kind: "video", contentType: "video/mp4", ...(meta.draft ? { draftId: `demo_draft_${nanoid(8)}` } : {}) }];
}

/** A demo of H3 Relay's window review: three 22-frame windows, each with a still and a checkpoint. */
function demoRemovalReview(ar: string): Record<string, unknown> {
  const hex = (n: number, len: number) => String(n).repeat(len).slice(0, len);
  const windows = [0, 1, 2].map((index) => ({ index, start: index * 22, frames: 22, seed: String(904234 + index), recordId: hex(index + 1, 32), poster: windowArtifact(index, "poster") }));
  const artifacts: Record<string, string> = {};
  for (const w of windows) artifacts[w.poster] = svgUri(demoSvg(`window ${w.index + 1}`, ar, w.index));
  return { review: { runId: hex(9, 32), configKey: hex(8, 64), seed: "904234", total: 3, windows, reuse: { video: "fuobe_demo0001.mp4", image: "fuobe_demo0002.png", prefix: "fuobe/demo" } }, artifacts };
}

export const mockProvider: ProviderAdapter = {
  id: "mock",
  label: "Placeholder",
  isConfigured: () => true,

  async prepareFile(data, contentType, _name, route) {
    // The Watermark Remover's picture is kept whole (its scan reads the size, its removal gives it back); others stay tiny.
    if ((route?.op === "watermark-scan" || route?.op === "watermark-remove") && contentType.startsWith("image/")) return toDataUri(data, contentType);
    return toDataUri(data.subarray(0, 64), contentType); // never sent anywhere; keep it tiny
  },

  async submit({ route, input, model }) {
    return {
      externalId: `demo_${nanoid(10)}`,
      meta: {
        startedAt: Date.now(),
        op: route.op,
        // Colour matching keeps the input's kind (an image or a video); a timeline is audio or (fal) a video;
        // a 3D scene is a mesh (open) or a depth map (cloud).
        kind: route.op === "color-match" || route.op === "timeline" || route.op === "scene-3d" ? model.kind : OPERATION_OUTPUT[route.op],
        prompt: input.prompt ?? route.op,
        aspectRatio: input.aspectRatio ?? "1:1",
        count: Math.max(1, Math.min(4, input.numOutputs ?? 1)),
        // Let draft mode be tried end to end in demo mode.
        draft: !!(input.draft && route.map?.draft),
        targetLanguage: input.targetLanguage,
        sourceLanguage: input.sourceLanguage,
        numLayers: input.numLayers,
        duration: input.duration,
        format: input.format,
        clips: input.audios?.length,
        frames: route.op === "extract-frames" ? input.extra?.max_frames : undefined,
        // Idol 3D asked for its four views of the object (src/lib/av/idol-views.ts).
        idolViews: route.op === "splat" && wantsIdolViews(input.extra),
        // Remove background: which file the demo stands for (the cut-out or its alpha mask).
        matteOutput: route.op === "bg-remove-video" ? (input.matteOutput ?? model.options.matteOutputs?.[0] ?? "cutout") : undefined,
        // The painted eraser's second output: the window's last tracked mask (video-inpaint-wan-vace-painted), saved
        // only for a window the next one waits on (as the comfyui provider does).
        lastMask: route.provider === "comfyui" && route.endpoint === "video-inpaint-wan-vace-painted" && input.extra?.[HAND_OFF] === true,
        // Workflows whose second output is the cut's first frame (video-segment-resample).
        firstFrame: route.provider === "comfyui" && route.endpoint === "video-segment-resample",
        // Character Swap Studio's segment graph: the take and its lossless master (video-character-swap-h3-segment).
        master: route.provider === "comfyui" && route.endpoint === "video-character-swap-h3-segment",
        // H3 Person Removal: each window's preview and checkpoint, so "Redo from here" can be tried (H3 Relay's review).
        h3Review: route.provider === "comfyui" && route.endpoint === H3_REMOVAL_WORKFLOW,
        // A splat on the open engine is an .spz with an orbit video; fal's is a .ply.
        openSplat: route.op === "splat" && route.provider === "comfyui",
        // A stem split that also transcribes (ComfyUI's dub-prepare-separate-transcribe).
        transcript: route.op === "separate-audio" && route.provider === "comfyui" && route.endpoint.includes("transcribe"),
        // The Watermark Remover's picture (kept whole by prepareFile).
        image: route.op === "watermark-scan" || route.op === "watermark-remove" ? input.images?.[0] : undefined,
        // A dialogue / music / effects split (ComfyUI's separate-soundtrack-dbs): four stems.
        threeStems: route.op === "separate-audio" && route.endpoint === "separate-soundtrack-dbs",
        // DBS graph C (soundtrack-remix-dbs): one remixed track.
        remix: route.op === "separate-audio" && route.endpoint === "soundtrack-remix-dbs",
      },
      payload: { demo: true, ...input },
    };
  },

  async poll({ meta }) {
    const kind = meta.kind as MediaKind;
    const elapsed = Date.now() - Number(meta.startedAt);
    const total = DURATION_MS[kind] ?? DURATION_MS.image;
    if (elapsed < 600) return { state: "queued", message: "Queued (demo)" };
    if (elapsed < total) return { state: "running", progress: elapsed / total, message: "Making a placeholder" };
    return { state: "succeeded", outputs: demoOutputs(meta.op as Operation | undefined, kind, String(meta.prompt), String(meta.aspectRatio), meta) };
  },

  async test() {
    return { ok: true, detail: "Demo provider is always available" };
  },
};
