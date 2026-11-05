import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { corsFlag, fixFor, guessInstall, installFromStats, platformOf, startFile, START_FILE_NAME } from "@/lib/comfy-install";
import { GUARD_FILE_NAME, GUARD_SOURCE, guardBase64 } from "@/lib/comfy-guard";
import { explainComfyError } from "@/lib/comfy";
import { fixFromPromptError } from "@/lib/gpu/fix-codes";
import { parseComfyBinary, parseComfyText } from "@/lib/comfy-ws";
import { tileJob, type LocalJob } from "@/lib/computer-runner";
import { browserSupport, COMFY_PORTS, firstPorts, graphProblem, lookStrength, localBase, mayDownload, pageCanReach, pickLook, portsToLook, preflightPath, readPath, sameFinder, settled, statsFacts, typedPort, viewPath, writePath, type Finder } from "@/lib/local-comfy";
import { DONE_SHOWN_MS, duration, jobFraction, jobWords, madeNoun, makingWords, queueWords, RELAY_WORDS, reportAllowed, savingWords, sendingWords, tabFailureWords, type RelayState } from "@/lib/relay";
import { tempDir } from "./helpers/temp-dir";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("the local ComfyUI's addresses", () => {
  it("is 127.0.0.1 unless the person typed localhost or [::1], and never a network address", () => {
    expect(localBase(8188)).toBe("http://127.0.0.1:8188");
    expect(localBase(8000, "localhost")).toBe("http://localhost:8000");
    expect(() => localBase(8188, "192.168.1.5")).toThrow();
    expect(() => localBase(8188, "evil.example")).toThrow();
    expect(() => localBase(70000)).toThrow();
    expect(typedPort("8189")).toEqual({ port: 8189, host: "127.0.0.1" });
    expect(typedPort("localhost:8000")).toEqual({ port: 8000, host: "localhost" });
    expect(typedPort("http://127.0.0.1:7821/")).toEqual({ port: 7821, host: "127.0.0.1" });
    expect(typedPort("http://192.168.1.5:8188")).toBeNull();
    expect(typedPort("https://tunnel.example")).toBeNull();
    expect(typedPort("127.0.0.1:8188/api")).toBeNull();
    expect(typedPort("99999")).toBeNull();
  });

  it("looks at the remembered port first, then the usual ones (8188, then Desktop's 8000)", () => {
    expect(COMFY_PORTS.slice(0, 2)).toEqual([8188, 8000]);
    expect(portsToLook(8190)[0]).toBe(8190);
    expect(new Set(portsToLook(8188)).size).toBe(portsToLook(8188).length);
  });

  it("reads only what a run needs", () => {
    for (const ok of ["/system_stats", "/object_info", "/object_info/KSampler", "/models/loras", "/queue", `/history/${ID}`, "/history?max_items=64", `/api/jobs/${ID}`, "/ws?clientId=fuobe-abcdefgh"]) {
      expect(readPath(ok), ok).toBe(ok);
    }
    expect(readPath(viewPath({ filename: "fuobe_00001_.png", subfolder: "fuobe", type: "output" }))).toMatch(/^\/view\?/);
    for (const bad of [
      "/userdata/x",
      "/internal/logs",
      "/manager/reboot",
      "/history",
      "/history/../x",
      "/history/not-a-uuid",
      "/view?filename=x.png&type=input&subfolder=",
      "/view?filename=../x.png&type=output&subfolder=",
      "/view?filename=x.png&type=output&subfolder=../../secrets",
      "/view?filename=x.png&type=output",
      "/models/../../etc",
      "/system_stats?x=1",
    ]) {
      expect(() => readPath(bad), bad).toThrow();
    }
  });

  it("sends only the run's own inputs, prompt and stops", () => {
    const own = { promptIds: [ID], names: ["fuobe_abcdefgh12.png"] };
    expect(writePath("/upload/image", { name: "fuobe_abcdefgh12.png", type: "input", overwrite: "true" }, own)).toBe("/upload/image");
    expect(() => writePath("/upload/image", { name: "fuobe_zzzzzzzz12.png", type: "input", overwrite: "true" }, own)).toThrow();
    expect(() => writePath("/upload/image", { name: "../x.png", type: "input", overwrite: "true" }, own)).toThrow();
    expect(() => writePath("/upload/image", { name: "fuobe_abcdefgh12.png", type: "output", overwrite: "true" }, own)).toThrow();
    expect(writePath("/prompt", { prompt_id: ID, prompt: {} }, own)).toBe("/prompt");
    expect(() => writePath("/prompt", { prompt_id: OTHER, prompt: {} }, own)).toThrow();
    expect(writePath("/queue", { delete: [ID] }, own)).toBe("/queue");
    expect(() => writePath("/queue", { clear: true }, own)).toThrow();
    expect(() => writePath("/queue", { delete: [OTHER] }, own)).toThrow();
    expect(writePath("/interrupt", { prompt_id: ID }, own)).toBe("/interrupt");
    expect(() => writePath("/interrupt", {}, own)).toThrow();
    expect(writePath(`/api/jobs/${ID}/cancel`, {}, own)).toBe(`/api/jobs/${ID}/cancel`);
    expect(() => writePath(`/api/jobs/${OTHER}/cancel`, {}, own)).toThrow();
    for (const p of ["/free", "/customnode/install", "/manager/queue/install", "/upload/mask", "/settings/x"]) expect(() => writePath(p, {}, own), p).toThrow();
  });

  it("refuses a graph whose loaders read files the run didn't send", () => {
    const staged = ["fuobe_abcdefgh12.png"];
    expect(graphProblem({ "1": { class_type: "LoadImage", inputs: { image: "fuobe_abcdefgh12.png" } }, "2": { class_type: "KSampler", inputs: { seed: 1 } } }, staged)).toBeNull();
    expect(graphProblem({ "1": { class_type: "LoadImage", inputs: { image: "fuobe_abcdefgh12.png [input]" } } }, staged)).toBeNull();
    expect(graphProblem({ "1": { class_type: "VHS_LoadVideo", inputs: { video: ["5", 0] } } }, staged)).toBeNull();
    expect(graphProblem({ "1": { class_type: "LoadImage", inputs: { image: "private_photo.png" } } }, staged)).toMatch(/didn't send/);
    expect(graphProblem({ "1": { class_type: "VHS_LoadImagesPath", inputs: { directory: "C:/Users/me/Pictures" } } }, staged)).toMatch(/didn't send/);
    expect(graphProblem({ "1": { class_type: "LoadAudio", inputs: { audio: "secret.wav" } } }, staged)).toMatch(/didn't send/);
    expect(graphProblem({ "1": { class_type: "LoadSomethingNew", inputs: { file_path: "x.bin" } } }, staged)).toMatch(/didn't send/);
  });

  it("downloads only files its own prompt's entries list", () => {
    const entry = { outputs: { "9": { images: [{ filename: "fuobe_00001_.png", subfolder: "fuobe", type: "output" }] } } };
    expect(mayDownload({ filename: "fuobe_00001_.png", subfolder: "fuobe", type: "output" }, [entry])).toBe(true);
    expect(mayDownload({ filename: "someone_else.png", subfolder: "", type: "output" }, [entry])).toBe(false);
    expect(mayDownload({ filename: "fuobe_00001_.png", subfolder: "", type: "output" }, [entry])).toBe(false);
  });

  it("picks the ComfyUI it can read, then the remembered port, then the usual order (8188 before 8000)", () => {
    const stats = { system: {} };
    expect(pickLook([{ port: 8000, state: "unreadable" }, { port: 8188, state: "found", stats }])).toMatchObject({ port: 8188, state: "found" });
    expect(pickLook([{ port: 8188, state: "unreadable" }, { port: 8000, state: "unreadable" }], 8000)).toMatchObject({ port: 8000 });
    expect(pickLook([{ port: 8189, state: "unreadable" }, { port: 8188, state: "unreadable" }])).toMatchObject({ port: 8188 });
    // Another app on 8000 (a dev server, SillyTavern…) doesn't win over ComfyUI's own port.
    expect(pickLook([{ port: 8000, state: "unreadable" }, { port: 8188, state: "unreadable" }])).toMatchObject({ port: 8188 });
    expect(pickLook([{ port: 7821, state: "unreadable" }, { port: 8001, state: "unreadable" }, { port: 8189, state: "unreadable" }])).toMatchObject({ port: 8189 });
    // A port the person typed, outside the usual ones, comes after them.
    expect(pickLook([{ port: 3391, state: "unreadable" }, { port: 8190, state: "unreadable" }])).toMatchObject({ port: 8190 });
    expect(pickLook([{ port: 8188, state: "none" }])).toEqual({ state: "none" });
  });

  it("the card's screens: several answering ports to pick from, one ComfyUI followed while it restarts, any readable one connects", () => {
    const stats = { system: {} };
    const start: Finder = { s: "start" };
    // Two answer without the setting: ComfyUI's own port first, the other offered.
    const two = settled(start, [{ port: 8000, state: "unreadable" }, { port: 8188, state: "unreadable" }, { port: 8189, state: "none" }], undefined, 1);
    expect(two).toEqual({ s: "needs-setting", port: 8188, back: false, others: [8000] });
    // ComfyUI on 8188 restarts: waiting for it, though another app still answers on 8000.
    const waiting = settled(two, [{ port: 8000, state: "unreadable" }, { port: 8188, state: "none" }], undefined, 5);
    expect(waiting).toEqual({ s: "waiting", port: 8188, since: 5 });
    // Each quiet look while it waits keeps the same screen (the same "since", so the 2-minute help comes).
    const again = settled(waiting, [{ port: 8000, state: "unreadable" }, { port: 8188, state: "none" }], undefined, 9);
    expect(again).toEqual(waiting);
    expect(sameFinder(waiting, again)).toBe(true);
    // Back without the setting yet.
    expect(settled(waiting, [{ port: 8188, state: "unreadable" }], undefined, 11)).toEqual({ s: "needs-setting", port: 8188, back: true });
    // Back with it on another port (ComfyUI moved): connects.
    expect(settled(waiting, [{ port: 8188, state: "none" }, { port: 8189, state: "found", stats }], undefined, 12)).toMatchObject({ s: "found", port: 8189 });
    // Nothing anywhere; a typed port that missed.
    expect(settled(start, [{ port: 8188, state: "none" }], undefined, 1)).toEqual({ s: "none" });
    expect(settled({ s: "none" }, [{ port: 3391, state: "none" }], undefined, 1, { typed: 3391 })).toEqual({ s: "none", missed: 3391 });
    expect(sameFinder({ s: "none" }, { s: "none", missed: 3391 })).toBe(false);
  });

  describe("ranking what answers on this computer", () => {
    const stats = { system: { comfyui_version: "0.42.0" } };
    const start: Finder = { s: "start" };

    it("ComfyUI on 8188 (even unreadable) and a 401 on 8189: 8188 is the one shown, 8189 only among the other ports", () => {
      // The browser sees the same for both (an answer it may not read): ComfyUI's usual port ranks first.
      const s = settled(start, [{ port: 8188, state: "unreadable" }, { port: 8189, state: "unreadable" }, { port: 8000, state: "none" }], undefined, 1);
      expect(s).toEqual({ s: "needs-setting", port: 8188, back: false, others: [8189] });
      // Readable on 8188: it connects, whatever answers elsewhere.
      expect(settled(start, [{ port: 8189, state: "unreadable" }, { port: 8188, state: "found", stats }], undefined, 1)).toMatchObject({ s: "found", port: 8188 });
      expect(lookStrength({ port: 8188, state: "unreadable" })).toBeGreaterThan(lookStrength({ port: 8189, state: "unreadable" }));
    });

    it("only a 401 on 8189: a weak candidate (it may not be ComfyUI), not a ComfyUI found", () => {
      const s = settled(start, [{ port: 8188, state: "none" }, { port: 8189, state: "unreadable" }], undefined, 1);
      expect(s).toEqual({ s: "needs-setting", port: 8189, back: false, weak: true });
      // Another app's readable answer isn't ComfyUI: never shown, never under Other ports.
      expect(settled(start, [{ port: 8000, state: "other" }, { port: 8189, state: "unreadable" }], undefined, 1)).toEqual({ s: "needs-setting", port: 8189, back: false, weak: true });
      expect(settled(start, [{ port: 8000, state: "other" }], undefined, 1)).toEqual({ s: "none" });
      expect(lookStrength({ port: 8188, state: "other" })).toBe(0);
    });

    it("something on 8000, ComfyUI Desktop's port, is a candidate (after 8188)", () => {
      expect(settled(start, [{ port: 8188, state: "none" }, { port: 8000, state: "unreadable" }], undefined, 1)).toEqual({ s: "needs-setting", port: 8000, back: false });
      expect(settled(start, [{ port: 8000, state: "unreadable" }, { port: 8188, state: "unreadable" }], undefined, 1)).toEqual({ s: "needs-setting", port: 8188, back: false, others: [8000] });
      // And it beats an app on a port ComfyUI doesn't usually use.
      expect(settled(start, [{ port: 8189, state: "unreadable" }, { port: 8000, state: "unreadable" }], undefined, 1)).toEqual({ s: "needs-setting", port: 8000, back: false, others: [8189] });
    });

    it("a port the person types counts as theirs: its screen, a miss, or another app there", () => {
      const none: Finder = { s: "none" };
      expect(settled(none, [{ port: 9188, state: "unreadable" }], undefined, 1, { typed: 9188 })).toEqual({ s: "needs-setting", port: 9188, back: false, chosen: true });
      expect(settled(none, [{ port: 9188, state: "found", stats }], undefined, 1, { typed: 9188 })).toMatchObject({ s: "found", port: 9188 });
      expect(settled(none, [{ port: 8000, state: "other" }], undefined, 1, { typed: 8000 })).toEqual({ s: "none", notComfy: 8000 });
      expect(settled(none, [{ port: 9188, state: "none" }], undefined, 1, { typed: 9188 })).toEqual({ s: "none", missed: 9188 });
    });

    it("a weak port shown gives way once ComfyUI's own port answers (it never sticks)", () => {
      const weak = settled(start, [{ port: 8188, state: "none" }, { port: 8189, state: "unreadable" }], undefined, 1);
      // A quiet look at 8189 and 8188: ComfyUI started on 8188.
      expect(settled(weak, [{ port: 8189, state: "unreadable" }, { port: 8188, state: "unreadable" }], undefined, 2, { partial: true })).toEqual({ s: "needs-setting", port: 8188, back: false, others: [8189] });
      // The weak port goes quiet: no "waiting for ComfyUI to start" for an app that may not be ComfyUI.
      expect(settled(weak, [{ port: 8189, state: "none" }, { port: 8188, state: "none" }], undefined, 3, { partial: true })).toEqual({ s: "none" });
    });

    it("a ComfyUI read on a port it doesn't usually use wins over an unreadable 8188", () => {
      expect(settled(start, [{ port: 8188, state: "unreadable" }, { port: 8190, state: "found", stats }], undefined, 1)).toMatchObject({ s: "found", port: 8190 });
      expect(pickLook([{ port: 8188, state: "unreadable" }, { port: 7821, state: "found", stats }])).toMatchObject({ port: 7821, state: "found" });
      // Where ComfyUI was found before counts as much as 8188.
      expect(settled(start, [{ port: 8188, state: "none" }, { port: 8190, state: "unreadable" }], 8190, 1)).toEqual({ s: "needs-setting", port: 8190, back: false });
    });

    it("nothing answers: not found", () => {
      expect(settled(start, COMFY_PORTS.map((port) => ({ port, state: "none" as const })), undefined, 1)).toEqual({ s: "none" });
      expect(pickLook([])).toEqual({ state: "none" });
    });

    it("the person picks another port: it is shown and followed, or the same screen says nothing answers there now", () => {
      const two = settled(start, [{ port: 8188, state: "unreadable" }, { port: 8189, state: "unreadable" }], undefined, 1);
      const picked = settled(two, [{ port: 8189, state: "unreadable" }], undefined, 2, { chosen: 8189, partial: true });
      expect(picked).toEqual({ s: "needs-setting", port: 8189, back: false, chosen: true, others: [8188] });
      // Followed: quiet looks at 8189 keep it (8188 is still offered).
      expect(settled(picked, [{ port: 8189, state: "unreadable" }], undefined, 3, { partial: true })).toEqual(picked);
      // And back to 8188.
      expect(settled(picked, [{ port: 8188, state: "unreadable" }], undefined, 4, { chosen: 8188, partial: true })).toEqual({ s: "needs-setting", port: 8188, back: false, chosen: true, others: [8189] });
      // Picked, and readable there: connects.
      expect(settled(two, [{ port: 8189, state: "found", stats }], undefined, 5, { chosen: 8189, partial: true })).toMatchObject({ s: "found", port: 8189 });
      // Picked, and gone: the screen stays, and says so.
      expect(settled(two, [{ port: 8189, state: "none" }], undefined, 6, { chosen: 8189, partial: true })).toEqual({ s: "needs-setting", port: 8188, back: false, missed: 8189 });
      // Picked, and another app answers there now: the screen stays, and says so.
      expect(settled(two, [{ port: 8189, state: "other" }], undefined, 7, { chosen: 8189, partial: true })).toEqual({ s: "needs-setting", port: 8188, back: false, notComfy: 8189 });
      // A port that only answered weakly, picked by the person, is no longer weak.
      const weak = settled(start, [{ port: 8189, state: "unreadable" }], undefined, 1);
      expect(settled(weak, [{ port: 8189, state: "unreadable" }], undefined, 2, { chosen: 8189, partial: true })).toEqual({ s: "needs-setting", port: 8189, back: false, chosen: true });
      // The weak port shown, picked and gone: not still shown as answering; the next one that answers, or none.
      expect(settled(weak, [{ port: 8189, state: "none" }], undefined, 3, { chosen: 8189, partial: true })).toEqual({ s: "none", missed: 8189 });
      const weak2 = settled(start, [{ port: 8189, state: "unreadable" }, { port: 8190, state: "unreadable" }], undefined, 1);
      expect(settled(weak2, [{ port: 8189, state: "none" }], undefined, 3, { chosen: 8189, partial: true })).toEqual({ s: "needs-setting", port: 8190, back: false, weak: true, missed: 8189 });
    });

    it("a quiet look at the port shown keeps the other ports found before", () => {
      const two = settled(start, [{ port: 8188, state: "unreadable" }, { port: 8189, state: "unreadable" }, { port: 8000, state: "unreadable" }], undefined, 1);
      expect(two).toMatchObject({ port: 8188, others: [8000, 8189] });
      const quiet = settled(two, [{ port: 8188, state: "unreadable" }], undefined, 2, { partial: true });
      expect(quiet).toEqual(two);
      expect(sameFinder(quiet, two)).toBe(true);
    });

    it("looks first where ComfyUI was found before and on 8188", () => {
      expect(firstPorts()).toEqual([8188]);
      expect(firstPorts(8190)).toEqual([8190, 8188]);
      expect(firstPorts(8188)).toEqual([8188]);
    });
  });

  it("can tell Fuobe's guard is there", () => {
    expect(readPath("/fuobe/guard")).toBe("/fuobe/guard");
    expect(statsFacts({ system: { argv: ["main.py", "--enable-cors-header", "https://fuobe.com"] } }, "https://fuobe.com", true)).toMatchObject({ cors: "exact", guard: true });
    expect(statsFacts({ system: {} }, "https://fuobe.com", false).guard).toBe(false);
    expect(statsFacts({ system: {} }, "https://fuobe.com").guard).toBeUndefined();
  });

  it("tells the server about the machine, never its command line", () => {
    const f = statsFacts(
      {
        system: { os: "nt", comfyui_version: "0.42.0", ram_total: 64 * 2 ** 30, embedded_python: true, argv: ["main.py", "--base-directory", "C:\\Users\\Jo\\secret", "--enable-cors-header", "https://fuobe.com"] },
        devices: [{ name: "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync", vram_total: 32 * 2 ** 30 }],
      },
      "https://fuobe.com",
    );
    expect(f).toEqual({ device: "cuda:0 NVIDIA GeForce RTX 5090 : cudaMallocAsync", vramBytes: 32 * 2 ** 30, ramBytes: 64 * 2 ** 30, version: "0.42.0", os: "nt", portable: true, cors: "exact" });
    expect(JSON.stringify(f)).not.toMatch(/secret|Users/);
    expect(statsFacts({ system: { argv: ["main.py", "--enable-cors-header"] } }, "https://fuobe.com").cors).toBe("any");
    expect(statsFacts({ system: { argv: ["main.py", "--enable-cors-header", "*"] } }, "https://fuobe.com").cors).toBe("any");
    expect(statsFacts({ system: { argv: ["main.py", "--enable-cors-header", "https://other.example"] } }, "https://fuobe.com").cors).toBe("other");
  });
});

describe("ComfyUI's live socket", () => {
  it("reads progress and the run's end", () => {
    expect(parseComfyText(JSON.stringify({ type: "progress", data: { value: 12, max: 30, prompt_id: ID, node: "3" } }))).toEqual({ type: "progress", value: 12, max: 30, promptId: ID, node: "3" });
    expect(parseComfyText(JSON.stringify({ type: "executing", data: { node: null, prompt_id: ID } }))).toEqual({ type: "executing", node: null, promptId: ID });
    expect(parseComfyText(JSON.stringify({ type: "execution_success", data: { prompt_id: ID } }))).toEqual({ type: "success", promptId: ID });
    expect(parseComfyText(JSON.stringify({ type: "execution_error", data: { prompt_id: ID, exception_message: "CUDA out of memory", node_type: "KSampler" } }))).toMatchObject({ type: "error", message: "CUDA out of memory" });
    expect(parseComfyText(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 2 } } } }))).toEqual({ type: "status", queueRemaining: 2 });
    expect(parseComfyText("not json")).toBeNull();
    expect(parseComfyText(JSON.stringify({ type: "progress", data: { value: "x" } }))).toBeNull();
    expect(parseComfyText(JSON.stringify({ type: "crystools.monitor", data: {} }))).toBeNull();
  });

  it("reads preview frames of both kinds, and ignores broken ones", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const one = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), jpeg]);
    expect(parseComfyBinary(one)).toMatchObject({ type: "image/jpeg" });
    expect(Buffer.from(parseComfyBinary(one)!.data).equals(jpeg)).toBe(true);
    const meta = Buffer.from(JSON.stringify({ prompt_id: ID, node_id: "3", image_type: "image/png" }));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(meta.length);
    const four = Buffer.concat([Buffer.from([0, 0, 0, 4]), len, meta, Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
    expect(parseComfyBinary(four)).toMatchObject({ type: "image/png", promptId: ID });
    expect(parseComfyBinary(Buffer.from([0, 0, 0, 4, 0xff, 0xff, 0xff, 0xff, 1]))).toBeNull();
    expect(parseComfyBinary(Buffer.from([0, 0, 0, 1, 0, 0, 0, 9, 1]))).toBeNull();
    expect(parseComfyBinary(Buffer.from([0, 0, 0, 3, 0, 0, 0, 0, 1]))).toBeNull();
    expect(parseComfyBinary(Buffer.from([0, 0]))).toBeNull();
  });
});

describe("a ComfyUI refusal", () => {
  it("names a missing node from its message, quoted or not", () => {
    const fix = (message: string) => fixFromPromptError({ error: { type: "missing_node_type", message } }, "wf", [], () => undefined);
    expect(fix("Node 'Image Resize' not found. The custom node may not be installed.")).toMatchObject({ code: "comfy_missing_node", items: [{ class: "Image Resize" }] });
    expect(fix("Cannot execute because node FancyNode does not exist.")).toMatchObject({ items: [{ class: "FancyNode" }] });
  });

  it("can't stall the server, however long the message (a tab reports what its ComfyUI said)", () => {
    const at = performance.now();
    expect(fixFromPromptError({ error: { type: "missing_node_type", message: "node ".repeat(52_000) } }, "wf", [], () => undefined)).toBeNull();
    const nodeErrors = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i), { class_type: "X".repeat(5000), errors: Array.from({ length: 50 }, () => ({ message: "node ".repeat(2000), details: "d".repeat(5000) })) }]));
    const words = explainComfyError(nodeErrors);
    expect(performance.now() - at).toBeLessThan(500);
    expect(words.split("\n").length).toBeLessThanOrEqual(20);
    expect(words.length).toBeLessThan(20 * 1000);
  });
});

describe("the run's words", () => {
  it("says what is happening, without jargon", () => {
    expect(sendingWords(["image/png"])).toBe("Sending your photo to ComfyUI");
    expect(sendingWords(["image/png", "image/jpeg"])).toBe("Sending your photos to ComfyUI");
    expect(sendingWords(["image/png", "video/mp4"])).toBe("Sending your files to ComfyUI");
    expect(sendingWords([])).toBe("Starting on your computer");
    expect(queueWords(0)).toBe("Next in ComfyUI's queue");
    expect(queueWords(2)).toBe("In ComfyUI's queue · 2 ahead");
    expect(makingWords("image", 12, 30)).toBe("Making your picture · step 12 of 30");
    expect(makingWords("video")).toBe("Making your clip");
    expect(savingWords(0.64)).toBe("Saving to Fuobe · 64%");
    for (const w of [sendingWords(["x"]), queueWords(1), makingWords("audio", 1, 2), savingWords(0.5), tabFailureWords("comfy-error", 500), tabFailureWords("save-failed")]) {
      expect(w).not.toMatch(/\b(CORS|relay|lease|task|claim)\b/i);
    }
  });

  it("the tab that runs a job says where it is at once, ahead of the server's next word", () => {
    expect(jobWords({ phase: "sending" }, "image", "Sending your photo to ComfyUI")).toBe("Sending your photo to ComfyUI");
    expect(jobWords({ phase: "sending" }, "image", "Queued")).toBe("Starting on your computer");
    expect(jobWords({ phase: "queued", position: 2 }, "image", "Queued")).toBe("In ComfyUI's queue · 2 ahead");
    expect(jobWords({ phase: "running", value: 3, max: 8 }, "image", "Queued")).toBe("Making your picture · step 3 of 8");
    expect(jobWords({ phase: "running" }, "video", undefined)).toBe("Making your clip");
    expect(jobWords({ phase: "saving", saved: 0.5 }, "image", "Making your picture")).toBe("Saving to Fuobe · 50%");
    expect(jobWords({ phase: "saving", saved: 0.5, waiting: true }, "image", undefined)).toBe("Saving to Fuobe · waiting for the studio");
    // Done here: still saving until the run itself moves on (never back to an older step the server said).
    expect(jobWords({ phase: "done" }, "image", "Making your picture · step 6 of 8")).toBe("Saving to Fuobe · 100%");
    // Failed here: the server has the last word.
    expect(jobWords({ phase: "failed" }, "image", undefined)).toBeUndefined();
  });

  it("the tab never says all is well while ComfyUI here is closed or runs without Fuobe's setting", () => {
    expect(jobWords({ phase: "sending" }, "image", "Queued", "down")).toBe(RELAY_WORDS.comfyDown);
    expect(jobWords({ phase: "sending" }, "image", "Queued", "no-setting")).toBe(RELAY_WORDS.comfyNoSetting);
    expect(jobWords({ phase: "running", value: 3, max: 8 }, "image", undefined, "down")).toBe(RELAY_WORDS.comfyDown);
    // The server's own words for a problem come through while the job is sending.
    for (const w of [RELAY_WORDS.comfyDown, RELAY_WORDS.comfyNoSetting, RELAY_WORDS.resent, RELAY_WORDS.noComputer]) expect(jobWords({ phase: "sending" }, "image", w)).toBe(w);
    // Saving goes on from the studio's side whatever ComfyUI does now.
    expect(jobWords({ phase: "saving", saved: 0.2 }, "image", undefined, "down")).toBe("Saving to Fuobe · 20%");
  });

  it("says long waits in hours", () => {
    expect(RELAY_WORDS.waitedTooLong(30 * 60_000)).toContain("for 30 minutes");
    expect(RELAY_WORDS.waitedTooLong(4 * 3_600_000)).toContain("for 4 hours");
    expect(duration(3_600_000)).toBe("1 hour");
    expect(duration(90 * 60_000)).toBe("90 minutes");
  });

  it("a tile's % and time left come from the job's own steps, and its words name what it makes", () => {
    expect(jobFraction({ phase: "running", value: 9, max: 12 })).toBe(0.75);
    expect(jobFraction({ phase: "running", value: 12, max: 12 })).toBe(0.99);
    expect(jobFraction({ phase: "running" })).toBeNull();
    expect(jobFraction({ phase: "saving", value: 12, max: 12 })).toBeNull();
    expect([madeNoun("image"), madeNoun("video"), madeNoun("audio"), madeNoun(undefined)]).toEqual(["picture", "clip", "sound", "picture"]);
  });

  it("a saved job stays on its tile, saying it is saving, until its run moves on (or a short while)", () => {
    const job = (taskId: string, phase: LocalJob["phase"], endedAt?: number): LocalJob => ({ taskId, generationId: "g", phase, ...(endedAt !== undefined && { endedAt }) });
    const saved = job("t1", "done", 1000);
    expect(tileJob([saved], "g", 1000 + DONE_SHOWN_MS - 1)).toBe(saved);
    expect(jobWords(saved, "image", "Making your picture · step 6 of 8")).toBe("Saving to Fuobe · 100%");
    expect(tileJob([saved], "g", 1000 + DONE_SHOWN_MS + 1)).toBeUndefined();
    // The run's next step (or a run sent again) shows its own job, never the old one.
    const next = job("t2", "sending");
    expect(tileJob([saved, next], "g", 1001)).toBe(next);
    expect(tileJob([saved, next], "other", 1001)).toBeUndefined();
  });

  it("takes each report only in its state", () => {
    const all: RelayState[] = ["waiting", "sending", "queued", "running", "collecting", "done", "failed", "canceled"];
    expect(all.filter((s) => reportAllowed("sent", s))).toEqual(["sending"]);
    expect(all.filter((s) => reportAllowed("finished", s))).toEqual(["queued", "running"]);
    expect(all.filter((s) => reportAllowed("running", s))).toEqual(["queued", "running"]);
    expect(reportAllowed("finished", "waiting")).toBe(false);
    expect(reportAllowed("refused", "running")).toBe(false);
    expect(reportAllowed("stopped", "canceled")).toBe(true);
    expect(reportAllowed("nonsense" as never, "running")).toBe(false);
  });
});

describe("ComfyUI's one setting", () => {
  it("names only this site", () => {
    expect(corsFlag("https://fuobe.com")).toBe("--enable-cors-header https://fuobe.com");
    expect(corsFlag("http://127.0.0.1:3370")).toBe("--enable-cors-header http://127.0.0.1:3370");
    for (const bad of ["*", "https://fuobe.com/", "https://fuobe.com' ; calc", 'https://a"b.com', "javascript:x", "https://fuobe.com & calc"]) expect(() => corsFlag(bad), bad).toThrow();
  });

  it("guesses the install from the port and the computer", () => {
    expect(guessInstall(8000, "windows")).toBe("desktop");
    expect(guessInstall(8000, "mac")).toBe("desktop");
    expect(guessInstall(8188, "windows")).toBe("portable");
    expect(guessInstall(8188, "mac")).toBe("terminal");
    expect(guessInstall(8189, "linux")).toBe("terminal");
    expect(installFromStats({ system: { embedded_python: true } }, 8000, "windows")).toBe("portable");
    expect(platformOf({ userAgentData: { platform: "Windows" } })).toBe("windows");
    expect(platformOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" })).toBe("mac");
    expect(platformOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })).toBe("linux");
  });

  it("gives each install its one fix, with Fuobe's guard", () => {
    expect(fixFor("desktop", "https://fuobe.com")).toMatchObject({ copy: "https://fuobe.com", path: ["Settings (the gear, bottom left)", "Server-Config", "Enable CORS header"] });
    expect(fixFor("portable", "https://fuobe.com")).toMatchObject({ startFile: true, copy: "--enable-cors-header https://fuobe.com" });
    expect(fixFor("stability-matrix", "https://fuobe.com").path).toContain("Extra Launch Arguments");
    // The start file adds the guard itself; every other install gets it to put in custom_nodes.
    expect(fixFor("portable", "https://fuobe.com").guard).toBeUndefined();
    for (const i of ["desktop", "stability-matrix", "terminal"] as const) expect(fixFor(i, "https://fuobe.com").guard).toMatch(/custom_nodes/);
  });

  it("a terminal's fix is the setting to add to its own command, and keeps the port ComfyUI was found on", () => {
    const usual = fixFor("terminal", "https://fuobe.com", 8188);
    expect(usual.copy).toBe("--enable-cors-header https://fuobe.com");
    expect(usual.lead).toMatch(/Add this to the command you start ComfyUI with/);
    expect(usual.example).toBe("python main.py --enable-cors-header https://fuobe.com");
    expect(fixFor("terminal", "https://fuobe.com", 8189).example).toBe("python main.py --enable-cors-header https://fuobe.com --port 8189");
  });

  it("makes a Windows start file for the port and this site only", () => {
    const bat = startFile(8188, "https://fuobe.com");
    expect(bat).toMatch(/\r\n/);
    expect(bat.replace(/\r\n/g, "")).not.toMatch(/\n/);
    expect(bat.startsWith("@echo off\r\n")).toBe(true);
    expect(bat).toContain("$Port = 8188");
    expect(bat).toContain("$Flag = '--enable-cors-header https://fuobe.com'");
    expect(bat).toContain(START_FILE_NAME);
    // It asks before it stops anything, and never changes the person's own start files.
    expect(bat.indexOf("Read-Host")).toBeLessThan(bat.indexOf("Stop-Process"));
    expect(bat).not.toMatch(/\.bak|WriteAllLines|Also add this setting/);
    // It puts Fuobe's guard into ComfyUI's custom_nodes before ComfyUI starts again, byte for byte.
    expect(bat).toContain(`FromBase64String('${guardBase64()}')`);
    expect(bat).toContain(GUARD_FILE_NAME);
    expect(bat.indexOf(GUARD_FILE_NAME)).toBeLessThan(bat.indexOf("Start-Process"));
    expect(Buffer.from(guardBase64(), "base64").toString("latin1")).toBe(GUARD_SOURCE);
    // It downloads nothing and sends nothing.
    expect(bat).not.toMatch(/Invoke-WebRequest|Invoke-RestMethod|DownloadString|curl|wget|bitsadmin|Net\.WebClient/i);
    expect(() => startFile(8188, "https://fuobe.com'; Remove-Item C:\\ -Recurse; '")).toThrow();
    expect(() => startFile(Number("8188; calc"), "https://fuobe.com")).toThrow();
  });

  it.runIf(process.platform === "win32")("is PowerShell that parses", () => {
    const bat = startFile(8189, "http://127.0.0.1:3370");
    const script = bat.slice(bat.indexOf("#FUOBE-PS"));
    const file = path.join(tempDir("fuobe-start-"), "s.ps1");
    fs.writeFileSync(file, script);
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$t, [ref]$e); $e.Count`],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("0");
  });
});

describe("which browsers can reach the ComfyUI on this computer", () => {
  const nav = (userAgent: string, o: { platform?: string; mobile?: boolean; brands?: boolean } = {}) => ({
    userAgent,
    ...(o.brands && { userAgentData: { platform: o.platform ?? "Windows", mobile: !!o.mobile } }),
  });
  it("Chrome, Edge and Firefox on a computer can; Safari, any iPhone or iPad browser and phones can't", () => {
    expect(browserSupport(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", { brands: true }), { narrow: false })).toBe("ok");
    expect(browserSupport(nav("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0", { brands: true }), { narrow: false })).toBe("ok");
    expect(browserSupport(nav("Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0"), { narrow: false })).toBe("ok");
    expect(browserSupport(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15"), { narrow: false })).toBe("safari");
    expect(browserSupport(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1"), { narrow: true })).toBe("phone");
    expect(browserSupport(nav("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"), { narrow: false })).toBe("phone");
    expect(browserSupport(nav("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36", { brands: true, mobile: true, platform: "Android" }), { narrow: true })).toBe("phone");
    // A narrow window on a computer is still a computer; a phone-width page is a phone.
    expect(browserSupport(nav("Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36", { brands: true }), { narrow: true, coarse: true })).toBe("phone");
  });

  it("an iPad's browsers say Macintosh, as a Mac's do: its touch screen makes them a tablet, at any width", () => {
    const ipadSafari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const ipadChrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Version/18.0 Safari/605.1.15";
    const ipadFirefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Safari/605.1.15";
    for (const ua of [ipadSafari, ipadChrome, ipadFirefox]) expect(browserSupport({ userAgent: ua, maxTouchPoints: 5 }, { narrow: false, coarse: false })).toBe("phone");
    // A Mac has no touch screen: Safari there is Safari, Chrome and Firefox there can.
    expect(browserSupport({ userAgent: ipadSafari, maxTouchPoints: 0 }, { narrow: false })).toBe("safari");
    expect(browserSupport({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", maxTouchPoints: 0, userAgentData: { platform: "macOS", mobile: false } }, { narrow: false })).toBe("ok");
    expect(browserSupport({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:151.0) Gecko/20100101 Firefox/151.0", maxTouchPoints: 0 }, { narrow: false })).toBe("ok");
    // A Windows laptop with a touch screen is still a computer.
    expect(browserSupport({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", maxTouchPoints: 10, userAgentData: { platform: "Windows", mobile: false } }, { narrow: false })).toBe("ok");
  });

  it("an http page on a network address can't ask Chrome for the permission; localhost and https can", () => {
    expect(pageCanReach("https://fuobe.com")).toBe(true);
    expect(pageCanReach("http://localhost:3000")).toBe(true);
    expect(pageCanReach("http://127.0.0.1:3370")).toBe(true);
    expect(pageCanReach("http://192.168.1.20:3000")).toBe(false);
    expect(pageCanReach("http://studio.lan")).toBe(false);
    // Whatever the address, a page the browser itself calls secure may ask.
    expect(pageCanReach("http://studio.test:3375", true)).toBe(true);
    expect(pageCanReach("http://192.168.1.20:3000", false)).toBe(false);
  });
});

describe("the GPU check from the browser", () => {
  it("reads only ComfyUI's facts and lists, and asks the Manager only its read-only questions", () => {
    for (const [m, p] of [
      ["GET", "/system_stats"],
      ["GET", "/api/system_stats"],
      ["GET", "/object_info"],
      ["GET", "/api/object_info/KSampler"],
      ["GET", "/models/checkpoints"],
      ["GET", "/experiment/models"],
      ["GET", "/experiment/models/loras"],
      ["GET", "/features"],
      ["GET", "/manager/version"],
      ["GET", "/v2/manager/queue/status"],
      ["GET", "/api/v2/customnode/installed"],
      ["POST", "/v2/customnode/import_fail_info_bulk"],
      ["POST", "/customnode/import_fail_info"],
    ] as const)
      expect(preflightPath(m, p), `${m} ${p}`).toBe(p);
    for (const [m, p] of [
      ["POST", "/prompt"],
      ["POST", "/upload/image"],
      ["GET", "/view?filename=a.png&subfolder=&type=input"],
      ["POST", "/manager/queue/install"],
      ["POST", "/v2/customnode/install"],
      ["GET", "/internal/logs"],
      ["GET", "/userdata/comfy.settings.json"],
      ["GET", "/api/api/system_stats"],
    ] as const)
      expect(() => preflightPath(m, p), `${m} ${p}`).toThrow();
  });
});
