import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { planVoiceFirst, voiceFirstCost, voiceFirstDefault, voiceFirstSource, wantsVoiceFirst, VOICE_FIRST_PARAM } from "@/lib/av/voice-first";
import { transcribeRequest } from "@/lib/av/captions";
import { planTranscribe } from "@/lib/catalog/swap-studio-plan";
import type { GenerationRequest } from "@/lib/catalog/types";
import { tempDir } from "./helpers/temp-dir";

// "Clean the voice first" (DBS D6): the speech apart from the music and effects before a transcriber or a lip sync hears
// it (DBS on your GPU, ElevenLabs voice isolation in the cloud), and after a lip re-sync on your GPU the music and effects
// of the same recording go back under it. The studio owner's until it has passed a real run.
const dir = tempDir("fuobe-voice-first-");
process.env.FUOBE_DATA_DIR = dir;
process.env.COMFYUI_URL = "http://127.0.0.1:9";
delete process.env.FUOBE_PASSWORD;
delete process.env.FUOBE_PUBLIC_SIGNUP;

const { setSetting } = await import("@/server/settings");
const { saveFile } = await import("@/server/storage");
const { createGenerations } = await import("@/server/generations");
const { transcribeClip } = await import("@/server/genjutsu");
const auth = await import("@/server/auth");
const route = await import("@/app/api/generations/route");
const { soundLive } = await import("@/server/sound-live");
beforeAll(() => setSetting("demoMode", "auto"));
afterEach(() => {
  delete process.env.FUOBE_PUBLIC_SIGNUP;
});

const flag = { extra: { [VOICE_FIRST_PARAM]: true } };
const clipUrl = () => saveFile({ data: fs.readFileSync(path.join(__dirname, "fixtures/shorts-12s.mp4")), contentType: "video/mp4", source: "upload", name: "talk.mp4" }).url;

describe("the plan", () => {
  it("a transcript of a video on your GPU: DBS on the video, its voice stem into Qwen3-ASR", () => {
    const r: GenerationRequest = { feature: "captions", modelId: "oss-qwen3-asr", op: "transcribe", inputs: { video: "/api/files/v.mp4" }, params: { sourceDuration: 12, sourceLanguage: "en", ...flag } };
    expect(wantsVoiceFirst(r)).toBe(true);
    const [voice, main, ...rest] = planVoiceFirst(r, "open");
    expect(rest).toEqual([]);
    expect(voice.request).toMatchObject({ modelId: "oss-dbs-separate", op: "separate-audio", inputs: { video: "/api/files/v.mp4" }, params: { sourceDuration: 12, extra: { channels: "mono" } } });
    expect(main).toMatchObject({ after: ["voice"], chain: [{ slot: "audio", stem: "voice" }], request: { modelId: "oss-qwen3-asr", op: "transcribe", params: { sourceLanguage: "en" } } });
    expect(main.request.inputs).toBeUndefined();
    expect(main.request.params?.extra).toBeUndefined();
  });

  it("in the cloud: ElevenLabs voice isolation before Scribe v2", () => {
    const r: GenerationRequest = { feature: "captions", modelId: "scribe-v2", op: "transcribe", inputs: { video: "/api/files/v.mp4" }, params: flag };
    const steps = planVoiceFirst(r, "cloud");
    expect(steps.map((s) => s.request.modelId)).toEqual(["elevenlabs-voice-isolation", "scribe-v2"]);
    expect(steps[1].chain).toEqual([{ slot: "audio" }]);
  });

  it("a lip sync on your GPU: the voice drives it, then the music and effects of the same recording go back under it", () => {
    const r: GenerationRequest = { feature: "lipsync", modelId: "oss-infinitetalk", op: "lipsync", inputs: { video: "/api/files/face.mp4", audio: "/api/files/line.wav" }, params: flag };
    const steps = planVoiceFirst(r, "open");
    expect(steps.map((s) => s.key)).toEqual(["voice", "main", "bed"]);
    expect(steps[0].request.inputs).toEqual({ audio: "/api/files/line.wav" });
    expect(steps[1].request.inputs).toEqual({ video: "/api/files/face.mp4" });
    expect(steps[2]).toMatchObject({
      after: ["main", "voice", "voice"],
      chain: [{ slot: "video" }, { slot: "audio", stem: "voice" }, { slot: "audio2", stem: "background" }],
      request: { modelId: "oss-mux", op: "mux", params: { extra: { backgroundVolumeDb: 0 } } },
    });
    // The cloud has no bed to put back (DBS isn't hosted).
    expect(planVoiceFirst({ ...r, modelId: "sync-lipsync-3" }, "cloud").map((s) => s.key)).toEqual(["voice", "main"]);
  });

  it("knows its source, its defaults and its cost line, and refuses what it can't clean", () => {
    expect(voiceFirstSource({ op: "transcribe", inputs: { audio: "/a.wav", video: "/v.mp4" } })).toEqual({ slot: "audio", url: "/a.wav" });
    expect(voiceFirstSource({ op: "avatar", inputs: { images: ["/p.png"] } })).toBeNull();
    // Off until the chain has passed a real run; then on for a video's speech.
    expect(voiceFirstDefault("video", false)).toBe(false);
    expect(voiceFirstDefault("video", true)).toBe(true);
    expect(voiceFirstDefault("audio", true)).toBe(false);
    expect(voiceFirstCost("cloud", 120)).toBe("adds $0.20");
    expect(voiceFirstCost("open", 30)).toMatch(/^adds (under a minute|about \d)/);
    expect(() => planVoiceFirst({ feature: "x", modelId: "oss-chatterbox", op: "tts", params: flag }, "open")).toThrow(/transcripts, captions and lip sync/);
    expect(wantsVoiceFirst({ op: "tts", params: flag })).toBe(false);
  });

  it("is asked for by Captions, Character Swap Studio and Genjutsu", () => {
    expect(transcribeRequest({ engine: "open", video: "/v.mp4", cleanVoiceFirst: true, seconds: 9 }).params).toEqual({ sourceDuration: 9, extra: { cleanVoiceFirst: true } });
    expect(transcribeRequest({ engine: "open", video: "/v.mp4" }).params).toBeUndefined();
    const clip = { id: "c", name: "Talk", source: { url: "/api/files/v.mp4", duration: 6, hasAudio: true } } as never;
    expect(planTranscribe(clip, "open", { cleanVoiceFirst: true })[0].request.params?.extra).toEqual({ cleanVoiceFirst: true });
    expect(planTranscribe(clip, "open")[0].request.params?.extra).toBeUndefined();
  });
});

describe("runs (demo mode)", () => {
  it("one batch, the transcript first: what Captions watches", () => {
    const made = createGenerations(transcribeRequest({ engine: "open", video: clipUrl(), cleanVoiceFirst: true, seconds: 12 }));
    expect(made.map((g) => [g.modelId, g.op])).toEqual([
      ["oss-qwen3-asr", "transcribe"],
      ["oss-dbs-separate", "separate-audio"],
    ]);
    expect(made[0].request.chain).toEqual([{ slot: "audio", stem: "voice" }]);
    expect(made[0].batchId).toBe(made[1].batchId);
  });

  it("joins the caller's batch when it has one", () => {
    const made = createGenerations(transcribeRequest({ engine: "open", video: clipUrl(), cleanVoiceFirst: true, seconds: 12 }), { batchId: "studio-batch" });
    expect(made.map((g) => g.batchId)).toEqual(["studio-batch", "studio-batch"]);
  });

  it("a lip sync on your GPU ends with the mux, which comes first", () => {
    const audio = saveFile({ data: Buffer.from("RIFF0000WAVEfmt "), contentType: "audio/wav", source: "upload", name: "line.wav" }).url;
    const made = createGenerations({ feature: "lipsync", modelId: "oss-infinitetalk", op: "avatar", inputs: { images: ["/api/files/placeholder.png"], audio }, params: flag });
    expect(made.map((g) => g.op)).toEqual(["mux", "separate-audio", "avatar"]);
  });

  it("Genjutsu's What's said takes it", () => {
    const { id } = transcribeClip({ engine: "open", source: { url: clipUrl(), duration: 12 }, cleanVoiceFirst: true });
    expect(id).toBeTruthy();
  });
});

describe("public sign-up: the studio owner's until it has passed a real run", () => {
  it("is open in this repository once its run passed, and opens only with a validated graph and a passed run", () => {
    expect(soundLive()).toEqual({ "clean-voice-first": true, "original-sound": true });
    const d = tempDir("fuobe-sound-live-");
    const files = (validated: boolean, passed: boolean) => {
      fs.writeFileSync(path.join(d, "m.json"), JSON.stringify({ workflows: [{ id: "separate-soundtrack-dbs", validated }] }));
      fs.writeFileSync(path.join(d, "r.json"), JSON.stringify({ features: { "clean-voice-first": { passed } } }));
      return [path.join(d, "m.json"), path.join(d, "r.json")] as const;
    };
    expect(soundLive(...files(true, true))["clean-voice-first"]).toBe(true);
    expect(soundLive(...files(false, true))["clean-voice-first"]).toBe(false);
    expect(soundLive(...files(true, false))["clean-voice-first"]).toBe(false);
    expect(soundLive(path.join(d, "none.json"), path.join(d, "none.json"))["clean-voice-first"]).toBe(false);
  });

  const call = (body: unknown, cookie?: string, preview = false) =>
    route.POST(
      new NextRequest(`http://localhost:3000/api/generations${preview ? "?preview=1" : ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cookie && { cookie: `${auth.SESSION_COOKIE}=${cookie}` }) },
        body: JSON.stringify(body),
      }),
    );
  it("lets an account ask for it once it has passed", async () => {
    auth.setPassword("install password");
    process.env.FUOBE_PUBLIC_SIGNUP = "1";
    const cookie = auth.createSession(auth.createAccount("voicefirst@example.com", "long enough").id).value;
    const asked = transcribeRequest({ engine: "open", video: "/api/files/uploads/none.mp4", cleanVoiceFirst: true });
    const r = await call(asked, cookie);
    expect(r.status).not.toBe(403);
  });
});
