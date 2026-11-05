import { describe, expect, it } from "vitest";
import {
  AUK_SEQUENCE_MAX,
  CONTEXT_MIN,
  diffLines,
  diffWords,
  editedLength,
  editInstruction,
  effectInstruction,
  mapTime,
  onCameraWarning,
  pieceLength,
  planEffectWindows,
  planSpeechEdit,
  planTextWindows,
  SEQUENCE_MARGIN,
  SPEECH_CROSSFADE,
  SpeechEditError,
  splitWords,
  stitchPlan,
  ttsInstruction,
  ttsLength,
  wordsFromCues,
  type SpeechWindow,
  type Word,
} from "@/lib/speech-edit";

/** Words at 0.4 s each with a 0.05 s gap, and a 0.5 s pause after every `phrase` words. */
function timed(text: string, phrase = 6, start = 0): Word[] {
  let t = start;
  return splitWords(text).map((w, i) => {
    if (i > 0) t += i % phrase === 0 ? 0.5 : 0.05;
    const word = { text: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.4) * 1000) / 1000 };
    t += 0.4;
    return word;
  });
}

const TEXT =
  "We open the new studio on Tuesday morning. Everyone is welcome to come along and see the space. " +
  "There will be coffee and cake for the first fifty guests. Bring a friend if you like and say hello to the team.";

const fits = (w: SpeechWindow) => w.end - w.start + w.seconds <= AUK_SEQUENCE_MAX - SEQUENCE_MARGIN + 1e-6;

describe("Edit speech: the diff", () => {
  it("finds the smallest changed span, ignoring case and punctuation around words", () => {
    const old = splitWords("We open the new studio on Tuesday morning.");
    expect(diffWords(old, splitWords("we open the new studio, on Thursday morning"))).toEqual([{ from: 6, to: 7, words: ["Thursday"], at: 6 }]);
    expect(diffWords(old, old)).toEqual([]);
  });

  it("tells insertions, removals and replacements apart, and keeps far-apart edits separate", () => {
    const old = splitWords("one two three four five six seven eight");
    expect(diffWords(old, splitWords("one two really three four five six seven eight"))).toEqual([{ from: 2, to: 2, words: ["really"], at: 2 }]);
    expect(diffWords(old, splitWords("one two four five six seven eight"))).toEqual([{ from: 2, to: 3, words: [], at: 2 }]);
    expect(diffWords(old, splitWords("uno two three four five six seven ocho"))).toEqual([
      { from: 0, to: 1, words: ["uno"], at: 0 },
      { from: 7, to: 8, words: ["ocho"], at: 7 },
    ]);
  });

  it("diffs edited transcript lines as one text", () => {
    const cues = [
      { start: 0, end: 2, text: "Hello there" },
      { start: 2.5, end: 4, text: "how are you" },
    ];
    expect(diffLines(cues, ["Hello there", "how were you"])).toEqual([{ from: 3, to: 4, words: ["were"], at: 3 }]);
  });
});

describe("Edit speech: AuK's instructions", () => {
  const words = splitWords("the cat sat on the mat and the cat ran");
  it("uses the Cookbook templates", () => {
    expect(editInstruction(words, { from: 2, to: 3, words: ["stood"] })).toBe("Replace 'sat' with 'stood'.");
    expect(editInstruction(words, { from: 3, to: 3, words: ["quietly"] })).toBe("Add 'quietly' after 'sat'.");
    expect(editInstruction(words, { from: 0, to: 0, words: ["Then"] })).toBe("Add 'Then' before 'the cat sat'.");
    expect(editInstruction(words, { from: 9, to: 10, words: [] })).toBe("Remove 'ran'.");
  });

  it("widens a phrase that occurs twice until it is unique", () => {
    // "cat" occurs twice: the change is widened to "the cat sat" → "the dog sat".
    const i = editInstruction(words, { from: 1, to: 2, words: ["dog"] });
    expect(i).toBe("Replace 'the cat sat' with 'the dog sat'.");
  });

  it("writes the effects in AuK's words", () => {
    expect(effectInstruction({ kind: "pitch", semitones: 2 })).toBe("Raise the pitch by 2 semitones.");
    // The Cookbook's templates as they are: "by {1/2/3} semitones", "to {0.5/0.75/1.25/1.5/2.0}x".
    expect(effectInstruction({ kind: "pitch", semitones: -1 })).toBe("Lower the pitch by 1 semitones.");
    expect(effectInstruction({ kind: "pace", speed: 1.5 })).toBe("Adjust the speech speed to 1.5x.");
    expect(effectInstruction({ kind: "pace", speed: 2 })).toBe("Adjust the speech speed to 2.0x.");
    expect(effectInstruction({ kind: "volume", db: -10 })).toBe("Decrease the volume by 10 dB.");
    expect(effectInstruction({ kind: "emotion", emotion: "happy" })).toBe("Change the emotion to happy.");
    expect(effectInstruction({ kind: "clean" })).toMatch(/remove noise and reverberation/);
    expect(effectInstruction({ kind: "isolate" }, "hello  there")).toBe('Keep only the speaker who says "hello there" and remove all other speakers.');
  });

  it("speaks a line with or without a voice sample", () => {
    expect(ttsInstruction('Say "hi"', { hasVoice: true })).toBe("Say the following with the same voice: \"Say 'hi'\"");
    expect(ttsInstruction("Hi", { hasVoice: false, voiceDescription: "A calm voice" })).toBe('Generate speech based on the following description: "A calm voice". The content to speak is: "Hi".');
    expect(ttsLength("Hello there")).toBeGreaterThan(1);
    expect(() => ttsLength("x".repeat(600))).toThrow(SpeechEditError);
    expect(() => ttsLength("Hello", 29.5)).toThrow(/voice sample is too long/);
    // The limit it states is the limit it keeps.
    expect(() => ttsLength("Hello", 21)).toThrow(/under 20 seconds/);
    expect(ttsLength("Hello", 19)).toBeGreaterThanOrEqual(1);
  });
});

describe("Edit speech: windows", () => {
  const words = timed(TEXT);
  const duration = words[words.length - 1].end + 0.6;
  const at = (w: string) => words.findIndex((x) => x.text.replace(/\W/g, "") === w);

  it("cuts a window at silences, with at least a second of untouched speech each side", () => {
    const i = at("Tuesday");
    const [w] = planTextWindows({ words, duration }, [{ from: i, to: i + 1, words: ["Thursday"] }]);
    expect(w.instruction).toBe("Replace 'Tuesday' with 'Thursday'.");
    expect(words[i].start - w.start).toBeGreaterThanOrEqual(CONTEXT_MIN);
    expect(w.end - words[i].end).toBeGreaterThanOrEqual(CONTEXT_MIN);
    // Both cuts are the middle of a pause, not inside a word.
    for (const t of [w.start, w.end]) expect(words.some((x) => t > x.start && t < x.end)).toBe(false);
    expect(fits(w)).toBe(true);
    // "Thursday" is about as long as "Tuesday": the new window runs about as long as the old one.
    expect(Math.abs(w.seconds - (w.end - w.start))).toBeLessThan(0.2);
  });

  it("starts at 0 for an edit at the very start and ends at the end for one at the end", () => {
    const first = planTextWindows({ words, duration }, [{ from: 0, to: 1, words: ["They"] }])[0];
    expect(first.start).toBe(0);
    const last = planTextWindows({ words, duration }, [{ from: words.length - 1, to: words.length, words: ["crew."] }])[0];
    expect(last.end).toBeCloseTo(duration, 6);
  });

  it("runs several far-apart edits as several windows, and merges close ones", () => {
    const far = planTextWindows({ words, duration }, [
      { from: at("Tuesday"), to: at("Tuesday") + 1, words: ["Friday"] },
      { from: at("friend"), to: at("friend") + 1, words: ["partner"] },
    ]);
    expect(far).toHaveLength(2);
    expect(far[1].start - far[0].end).toBeGreaterThanOrEqual(2 * SPEECH_CROSSFADE);
    const close = planTextWindows({ words, duration }, [
      { from: at("coffee"), to: at("coffee") + 1, words: ["tea"] },
      { from: at("cake"), to: at("cake") + 1, words: ["biscuits"] },
    ]);
    expect(close).toHaveLength(1);
    expect(close[0].instruction).toBe("Replace 'coffee and cake' with 'tea and biscuits'.");
  });

  it("lengthens or shortens the window by the new words' time", () => {
    const i = at("Tuesday");
    const [longer] = planTextWindows({ words, duration }, [{ from: i, to: i + 1, words: ["Tuesday,", "the", "fifth", "of", "November,"] }]);
    expect(longer.seconds - (longer.end - longer.start)).toBeGreaterThan(1);
    const [gone] = planTextWindows({ words, duration }, [{ from: i, to: i + 1, words: [] }]);
    expect(gone.instruction).toBe("Remove 'Tuesday'.");
    expect(gone.end - gone.start - gone.seconds).toBeCloseTo(0.4, 1);
  });

  it("holds every window to AuK's 30 s with its new audio, and refuses a change too long for one call", () => {
    const long = timed(Array.from({ length: 80 }, (_, k) => `w${k}`).join(" "), 1000);
    const end = long[long.length - 1].end;
    const [w] = planTextWindows({ words: long, duration: end }, [{ from: 30, to: 31, words: ["x"] }]);
    // No silences at all: cut at word boundaries, still in budget.
    expect(fits(w)).toBe(true);
    expect(() => planTextWindows({ words: long, duration: end }, [{ from: 5, to: 40, words: ["short"] }])).toThrow(/too long for one pass/);
  });

  it("splits an effect's range at silences into windows AuK can take", () => {
    const ws = planEffectWindows({ words, duration }, { start: 0, end: duration }, { kind: "pitch", semitones: 2 });
    expect(ws.length).toBeGreaterThan(1);
    for (const w of ws) {
      expect(fits(w)).toBe(true);
      expect(w.seconds).toBeCloseTo(w.end - w.start, 3);
      expect(w.instruction).toBe("Raise the pitch by 2 semitones.");
    }
    // Back to back, covering the whole range.
    expect(ws[0].start).toBe(0);
    expect(ws[ws.length - 1].end).toBeCloseTo(duration, 3);
    for (let k = 1; k < ws.length; k++) expect(ws[k].start).toBe(ws[k - 1].end);
    const pace = planEffectWindows({ words, duration }, { start: 2, end: 6 }, { kind: "pace", speed: 2 });
    expect(pace[0].seconds).toBeCloseTo((pace[0].end - pace[0].start) / 2, 3);
    expect(() => planEffectWindows({ words, duration }, { start: 1, end: 1.1 }, { kind: "clean" })).toThrow(SpeechEditError);
  });

  it("times words inside transcript lines by their length", () => {
    const w = wordsFromCues([{ start: 1, end: 3, text: "a bbb" }]);
    expect(w).toEqual([
      { text: "a", start: 1, end: 1.667 },
      { text: "bbb", start: 1.667, end: 3 },
    ]);
  });
});

describe("Edit speech: the crossfade stitch", () => {
  const w = (start: number, end: number, seconds: number): SpeechWindow => ({ start, end, seconds, instruction: "x", label: "x" });

  it("puts a seam at each side of a window, none at the recording's start or end", () => {
    const x = SPEECH_CROSSFADE;
    const p = stitchPlan([w(2, 6, 5)], 10, x);
    expect(p).toEqual([
      { kind: "source", from: 0, to: 2 },
      { kind: "seam-in", window: 0, at: 2, length: x },
      { kind: "edit", window: 0, from: x, to: 5 - x },
      { kind: "seam-out", window: 0, at: 6 - x, length: x },
      { kind: "source", from: 6, to: 10 },
    ]);
    const total = p.reduce((t, q) => t + pieceLength(q), 0);
    expect(total).toBeCloseTo(editedLength([w(2, 6, 5)], 10), 6);
    expect(editedLength([w(2, 6, 5)], 10)).toBe(11);
    const edge = stitchPlan([w(0, 3, 3), w(7, 10, 2)], 10, x);
    expect(edge.map((q) => q.kind)).toEqual(["edit", "seam-out", "source", "seam-in", "edit"]);
    expect(edge.reduce((t, q) => t + pieceLength(q), 0)).toBeCloseTo(9, 6);
  });

  it("joins back-to-back windows without an empty piece of the original", () => {
    const p = stitchPlan([w(1, 4, 3), w(4, 8, 4)], 10);
    expect(p.filter((q) => q.kind === "source")).toEqual([
      { kind: "source", from: 0, to: 1 },
      { kind: "source", from: 8, to: 10 },
    ]);
    expect(() => stitchPlan([w(1, 4, 3), w(3, 8, 4)], 10)).toThrow(/overlap/);
  });

  it("maps original times to the edited recording", () => {
    const ws = [w(2, 6, 5)];
    expect(mapTime(ws, 1)).toBe(1);
    expect(mapTime(ws, 4)).toBe(4.5);
    expect(mapTime(ws, 8)).toBe(9);
  });
});

describe("Edit speech: a run", () => {
  const cues = [
    { start: 0, end: 2.2, text: "We open the new studio" },
    { start: 2.8, end: 4.6, text: "on Tuesday morning." },
    { start: 5.3, end: 8, text: "Everyone is welcome to come along." },
  ];

  it("is one AuK job on audio, and AuK then the stream-copy mux on a video, with the lipsync warning", () => {
    const audio = planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, edited: [cues[0].text, "on Thursday morning.", cues[2].text], seconds: 8.5 });
    expect(audio.steps).toHaveLength(1);
    expect(audio.steps[0].request).toMatchObject({ modelId: "oss-auk", op: "speech-edit", inputs: { audio: "/api/files/a.wav" }, feature: "speech-edit" });
    expect((audio.steps[0].request.params?.extra?.speechWindows as SpeechWindow[])[0].instruction).toBe("Replace 'Tuesday' with 'Thursday'.");
    expect(audio.warning).toBeNull();
    const video = planSpeechEdit({ engine: "open", media: "/api/files/v.mp4", kind: "video", cues, edited: [cues[0].text, "on Thursday morning.", cues[2].text], seconds: 8.5 });
    expect(video.steps.map((s) => [s.request.modelId, s.request.op])).toEqual([
      ["oss-auk", "speech-edit"],
      ["oss-mux", "mux"],
    ]);
    expect(video.steps[1]).toMatchObject({ after: ["edit"], chain: [{ slot: "audio" }] });
    expect(video.warning).toMatch(/Lipsync/);
    // A pitch change keeps the lips in time: no warning.
    expect(onCameraWarning("video", planSpeechEdit({ engine: "open", media: "/api/files/v.mp4", kind: "video", cues, range: { start: 0, end: 4 }, effect: { kind: "pitch", semitones: 1 }, seconds: 8.5 }).windows)).toBeNull();
  });

  it("runs on your GPU only, and says what's missing", () => {
    expect(() => planSpeechEdit({ engine: "cloud", media: "/api/files/a.wav", kind: "audio", cues, edited: ["x"], seconds: 8 })).toThrow(/Runs on your GPU|runs on your GPU/);
    expect(() => planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, edited: cues.map((c) => c.text), seconds: 8 })).toThrow(/Nothing changed/);
    expect(() => planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, edited: ["x"], seconds: 8, hasAudio: false })).toThrow(/no sound/);
  });

  it("keeps a video's sound in step with the picture: every change keeps its length, and Pace is refused", () => {
    const edited = [cues[0].text, "on a very sunny Wednesday morning in late October.", cues[2].text];
    const audio = planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, edited, seconds: 9 });
    expect(audio.length).toBeGreaterThan(10);
    const video = planSpeechEdit({ engine: "open", media: "/api/files/v.mp4", kind: "video", cues, edited, seconds: 9 });
    expect(video.length).toBe(9);
    for (const w of video.windows) expect(w.seconds).toBeCloseTo(w.end - w.start, 6);
    expect(video.notes.join(" ")).toMatch(/keeps its length/);
    // A removal on a video keeps its length too.
    const removed = planSpeechEdit({ engine: "open", media: "/api/files/v.mp4", kind: "video", cues, edited: [cues[0].text, "on morning.", cues[2].text], seconds: 9 });
    expect(removed.length).toBe(9);
    expect(() => planSpeechEdit({ engine: "open", media: "/api/files/v.mp4", kind: "video", cues, range: { start: 0, end: 9 }, effect: { kind: "pace", speed: 2 }, seconds: 9 })).toThrow(/drift from the picture/);
    // Same-length effects still run on a video; Pace still runs on audio.
    expect(planSpeechEdit({ engine: "open", media: "/api/files/v.mp4", kind: "video", cues, range: { start: 0, end: 9 }, effect: { kind: "volume", db: 5 }, seconds: 9 }).length).toBe(9);
    expect(planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, range: { start: 0, end: 9 }, effect: { kind: "pace", speed: 2 }, seconds: 9 }).length).toBeLessThan(5);
  });

  it("merges two nearby changes with the edited words between them, not the old punctuation", () => {
    const plan = planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, edited: [cues[0].text, "on a very sunny Wednesday morning in late October.", cues[2].text], seconds: 9 });
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].instruction).toBe("Replace 'Tuesday morning.' with 'a very sunny Wednesday morning in late October.'.");
  });

  it("writes no model names or step counts in what the page shows", () => {
    const plan = planSpeechEdit({ engine: "open", media: "/api/files/a.wav", kind: "audio", cues, edited: [cues[0].text, "on Thursday morning.", cues[2].text], seconds: 9 });
    expect(plan.notes.join(" ")).not.toMatch(/Flash|steps/);
  });
});
