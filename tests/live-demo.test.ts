import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHAT_CREW, type ChatRow, chatRows } from "@/components/live/live-chat-demo";
import { YOUR_TURN } from "@/components/live/live-crew";
import { ChangeCount, createKeyBus } from "@/components/live/live-demo";
import {
  type Box,
  cameraFor,
  changeLog,
  changesWord,
  countChanges,
  type Demo,
  type DemoStep,
  demoEnds,
  demoProblems,
  frameFile,
  frameFiles,
  frameOrder,
  framePath,
  LIVE_DEMO,
  LIVE_DEMO_V,
  LIVE_DEMOS,
  pickDemo,
  PORTRAIT_DEMO,
  PORTRAIT_DEMO_V,
  LOOP_MAX_MS,
  markAt,
  loopMs,
  MID_W,
  pendingWords,
  pillText,
  SMALL_W,
  sentence,
  stops,
  SWEEP_MS,
  sweepPath,
  tierFor,
  typeDelays,
  viewBefore,
  wordsIn,
  ZOOM_MAX,
} from "@/lib/live/demo";

/*
 * The recorded live edit session (LIVE_DEMO: the room makeover, public/previews/live-edit/room/demo.json) and its
 * player (src/lib/live/demo.ts, src/components/live/live-demo.tsx): the file plays, every frame is there in the sizes a
 * card needs, one round stays short, the whole picture always shows, and the session is one prompt that keeps growing.
 * The portrait session (Home's tile, and the players' other pick) is checked at the end.
 */

const PUBLIC = path.join(__dirname, "..", "public");
const exists = (src: string) => fs.existsSync(path.join(PUBLIC, src));
const shippedText = fs.readFileSync(path.join(PUBLIC, LIVE_DEMO), "utf8").replace(/\r\n/g, "\n");
const shipped = JSON.parse(shippedText) as Demo;

/**
 * A made-up eleven-change session in the longer shape the player also plays (the shipped one has no zoom steps): the
 * camera moves in on the changed area, the words go on the end of the one prompt, a partial live frame arrives while
 * typing, the camera pulls back out as the settled one arrives, then the count goes up. The two big changes keep the
 * whole picture.
 */
const LABELS = ["White walls", "Oak floor", "Velvet sofa", "Arched window", "Hanging plants", "Bookshelves", "Gold armchair", "String lights", "Golden hour", "Sleeping cat", "Reading lamp"];
function longSession(): Demo {
  const frames: Demo["frames"] = { s0: { src: "/previews/x/960/step-00.jpg", small: "/previews/x/512/step-00.jpg" } };
  const script: DemoStep[] = [{ type: "frame", frame: "s0", ms: 800 }];
  LABELS.forEach((label, i) => {
    const n = String(i + 1).padStart(2, "0");
    const early = i < 2;
    frames[`s${i + 1}a`] = { src: `/previews/x/960/step-${n}a.jpg` };
    frames[`s${i + 1}`] = { src: `/previews/x/960/step-${n}.jpg` };
    const box: Box | null = label === "String lights" || label === "Golden hour" ? null : [0.4, 0.3, 0.6, 0.6];
    if (box) script.push({ type: "zoom", box, ms: 200 });
    script.push(
      { type: "type", text: `${i ? ", " : ""}${label.toLowerCase()}`, ms: early ? 700 : 450 },
      { type: "frame", frame: `s${i + 1}a`, live: true, ms: early ? 600 : 540 },
      { type: "type", text: " now", ms: early ? 500 : 300 },
    );
    if (box) script.push({ type: "zoom", box: null, ms: 0 });
    script.push({ type: "frame", frame: `s${i + 1}`, ms: early ? 700 : 560 }, { type: "change", ms: early ? 900 : 700 });
  });
  script.push({ type: "compare", ms: 3400 }, { type: "pause", ms: 1200 });
  return { v: 2, size: [960, 720], frames, script };
}

describe("the shipped demo", () => {
  it("plays: every frame file is there, every step is valid, one round is short", () => {
    expect(demoProblems(shipped, exists)).toEqual([]);
    expect(loopMs(shipped)).toBeLessThanOrEqual(LOOP_MAX_MS);
  });

  it("is one prompt of eight changes or more, each settled picture shown before the count goes up", () => {
    const changes = shipped.script.flatMap((s, i) => (s.type === "change" ? [i] : []));
    expect(changes.length).toBeGreaterThanOrEqual(8);
    expect(countChanges(shipped)).toBe(changes.length);
    for (const [k, i] of changes.entries()) {
      const prev = shipped.script[i - 1];
      expect(prev).toMatchObject({ type: "frame", frame: `s${k + 1}` });
      expect(prev.type === "frame" && prev.live).toBeFalsy();
      // Every change after the first goes on the end of the same words.
      const next = shipped.script.slice(i + 1).find((s) => s.type === "type");
      if (next?.type === "type") expect(next.text.startsWith(", ")).toBe(true);
    }
    // The words at the end are the whole prompt: every change is still in it (a change may hold a comma of its own).
    expect(viewBefore(shipped, shipped.script.length).typed.split(", ").length).toBeGreaterThanOrEqual(changes.length);
    expect(shipped.script.at(-2)?.type).toBe("compare");
    expect(Object.keys(shipped.frames)[0]).toBe("s0");
    for (const id of Object.keys(shipped.frames)) expect(id).not.toMatch(/^\d+$/);
  });

  it("is fetched at its content version, and so is every frame", () => {
    const sha8 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").slice(0, 8);
    expect(sha8(shippedText)).toBe(LIVE_DEMO_V);
    for (const f of Object.values(shipped.frames)) {
      for (const src of frameFiles(f)) {
        expect(src).toMatch(/\?v=[0-9a-f]{8}$/);
        expect(src.split("?v=")[1]).toBe(sha8(fs.readFileSync(path.join(PUBLIC, framePath(src)))));
      }
    }
  });

  it("compares the original with the last picture, whatever order the frames are listed in", () => {
    const ends = demoEnds(shipped);
    const order = frameOrder(shipped);
    expect(ends).toEqual({ before: order[0], after: order.at(-1) });
    const shuffled: Demo = { ...shipped, frames: Object.fromEntries(Object.entries(shipped.frames).reverse()) };
    expect(demoEnds(shuffled)).toEqual(ends);
  });

  it("keeps the whole picture: no step zooms in", () => {
    expect(shipped.script.filter((s) => s.type === "zoom")).toEqual([]);
  });

  it("has every settled picture at 1280, 768 and 512 px, and every live frame at 768 px or more, in AVIF and WebP", async () => {
    expect(shipped.size).toEqual([1280, 960]);
    const width = async (src: string) => (await sharp(path.join(PUBLIC, framePath(src))).metadata()).width;
    const live = new Set(shipped.script.flatMap((s) => (s.type === "frame" && s.live ? [s.frame] : [])));
    for (const [id, f] of Object.entries(shipped.frames)) {
      expect(await width(f.src)).toBe(f.w ?? shipped.size[0]);
      expect(f.small && (await width(f.small))).toBe(SMALL_W);
      // A browser without AVIF gets WebP files, as wide as the AVIF ones.
      for (const w of [f.webp, f.webpMid, f.webpSrc]) if (w) expect(w).toMatch(/\.webp\?/);
      expect(f.webp && (await width(f.webp))).toBe(SMALL_W);
      expect(f.webpSrc && (await width(f.webpSrc))).toBe(f.w ?? shipped.size[0]);
      if (live.has(id)) expect(f.w).toBeGreaterThanOrEqual(MID_W);
      else {
        expect(f.mid && (await width(f.mid))).toBe(MID_W);
        expect(f.webpMid && (await width(f.webpMid))).toBe(MID_W);
      }
    }
  });

  it("shows each live frame long enough to be drawn across and seen", () => {
    for (const s of shipped.script) if (s.type === "frame" && s.live) expect(s.ms).toBeGreaterThanOrEqual(SWEEP_MS);
  });

  it("shows no timings: the pill says Live, nothing more", () => {
    expect(shippedText).not.toMatch(/Ms"\s*:/);
  });
});

describe("the files a card loads", () => {
  const settled = {
    src: "/previews/x/1280/a.avif",
    mid: "/previews/x/768/a.avif",
    small: "/previews/x/512/a.avif",
    webp: "/previews/x/512/a.webp",
    webpMid: "/previews/x/768/a.webp",
    webpSrc: "/previews/x/1280/a.webp",
  };
  const live = { src: "/previews/x/live/a.avif", w: 896, small: "/previews/x/live/512/a.avif", webp: "/previews/x/live/512/a.webp", webpSrc: "/previews/x/live/a.webp" };

  it("is as wide as the card on the screen, in device pixels", () => {
    // A 638 px card on a 2x screen, a 366 px card on a 3x phone, a 646 px card on a 1x screen, the 200 px Apps card.
    expect(frameFile(settled, tierFor(638 * 2), 1280)).toBe(settled.src);
    expect(frameFile(settled, tierFor(366 * 3), 1280)).toBe(settled.src);
    expect(frameFile(settled, tierFor(646), 1280)).toBe(settled.mid);
    expect(frameFile(settled, tierFor(200 * 2), 1280)).toBe(settled.small);
    expect(frameFile(live, tierFor(638 * 2), 1280)).toBe(live.src);
    expect(frameFile(live, tierFor(646), 1280)).toBe(live.src);
    expect(frameFile(live, tierFor(200 * 2), 1280)).toBe(live.small);
  });

  it("waits for the card's width, and takes the largest file when none is as wide", () => {
    expect(tierFor(0)).toBe(0);
    expect(tierFor(Number.NaN)).toBe(0);
    expect(tierFor(5000)).toBe(Number.POSITIVE_INFINITY);
    expect(frameFile({ src: "/previews/x/a.webp" }, 2000, 1280)).toBe("/previews/x/a.webp");
    expect(frameFile(settled, 1, 1280)).toBe(settled.small);
  });

  it("gives a browser without AVIF the WebP files, as wide as the card", () => {
    expect(frameFile(settled, tierFor(638 * 2), 1280, false)).toBe(settled.webpSrc);
    expect(frameFile(settled, tierFor(646), 1280, false)).toBe(settled.webpMid);
    expect(frameFile(settled, tierFor(200 * 2), 1280, false)).toBe(settled.webp);
    expect(frameFile(live, tierFor(638 * 2), 1280, false)).toBe(live.webpSrc);
    expect(frameFile(live, tierFor(646), 1280, false)).toBe(live.webpSrc);
    expect(frameFile(live, tierFor(200 * 2), 1280, false)).toBe(live.webp);
    // A frame with only its small WebP still plays, from that file.
    expect(frameFile({ src: "/previews/x/a.avif", webp: "/previews/x/a.webp" }, tierFor(638 * 2), 1280, false)).toBe("/previews/x/a.webp");
    // No AVIF file reaches a browser without AVIF.
    for (const need of [400, 646, 1276]) for (const f of [settled, live]) expect(frameFile(f, tierFor(need), 1280, false)).toMatch(/\.webp$/);
  });
});

describe("timing", () => {
  it("types in the time the script gives, spaces a little slower", () => {
    const d = typeDelays("deep red lips", 1300);
    expect(d.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1300);
    expect(d.reduce((a, b) => a + b, 0)).toBeGreaterThan(1300 - 13);
    expect(d[4] - d[3]).toBe(40);
  });

  it("never types faster than a person can read", () => {
    expect(Math.min(...typeDelays("a very long instruction typed in no time at all", 100))).toBeGreaterThanOrEqual(28);
  });
});

describe("an eleven-step session", () => {
  const d = longSession();
  const without = (src: string) => !src.includes("/x/");

  it("is valid apart from its stand-in files, and one round takes about half a minute", () => {
    expect(demoProblems(d)).toEqual([]);
    expect(demoProblems(d, without).every((p) => p.endsWith("is missing"))).toBe(true);
    expect(loopMs(d)).toBeGreaterThan(28_000);
    expect(loopMs(d)).toBeLessThanOrEqual(LOOP_MAX_MS);
  });

  it("compares the original with the eleventh step", () => {
    expect(demoEnds(d)).toEqual({ before: "s0", after: "s11" });
  });

  it("picks up where it paused, with the count and the words so far", () => {
    const change7 = d.script.flatMap((s, i) => (s.type === "change" ? [i] : []))[6];
    const v = viewBefore(d, change7 + 2);
    expect(v.changes).toBe(7);
    expect(v.frame).toBe("s7");
    // The words are never cleared: all seven changes, then the eighth being typed.
    expect(v.typed).toBe(`${LABELS.slice(0, 7).map((l) => `${l.toLowerCase()} now`).join(", ")}, ${LABELS[7].toLowerCase()}`);
    expect(v.zoom).toBeNull();
    // The picture is there at once, not faded in from the dark behind it.
    expect(v).toMatchObject({ fade: 0, sweep: false, under: null });
    expect(viewBefore(d, change7 + 3)).toMatchObject({ frame: "s8a", changes: 7 });
    const change2 = d.script.flatMap((s, i) => (s.type === "change" ? [i] : []))[1];
    expect(viewBefore(d, change2 + 4)).toMatchObject({ frame: "s3a", zoom: [0.4, 0.3, 0.6, 0.6] });
    expect(viewBefore(d, change2).zoom).toBeNull();
  });

  it("shows the count on the small card once there are two changes", () => {
    expect(pillText({ changes: 0 })).toEqual({ main: "Live", count: null });
    expect(pillText({ changes: 1 }, true).count).toBeNull();
    expect(pillText({ changes: 7 }, true).count).toBe("7");
    expect(pillText({ changes: 7 }).count).toBeNull();
  });

  it("refuses an unknown step and a round over the limit", () => {
    const odd = { ...d, script: [...d.script, { type: "keep", label: "x", ms: 800 }] } as unknown as Demo;
    expect(demoProblems(odd).some((x) => x.includes("unknown step"))).toBe(true);
    const slow: Demo = { ...d, script: [...d.script, { type: "pause", ms: LOOP_MAX_MS }] };
    expect(demoProblems(slow).some((x) => x.startsWith("one round"))).toBe(true);
  });
});

describe("the camera", () => {
  /** Where a point of the picture lands in the frame, as shares of its width and height. */
  const at = (c: ReturnType<typeof cameraFor>, px: number, py: number) => [c.x + c.s * px, c.y + c.s * py];

  it("stays on the whole picture with no area, or one that already fills most of it", () => {
    expect(cameraFor(null)).toEqual({ s: 1, x: 0, y: 0 });
    expect(cameraFor([0.01, 0.01, 0.99, 0.99])).toEqual({ s: 1, x: 0, y: 0 });
    expect(cameraFor([0.27, 0.11, 0.68, 0.89])).toEqual({ s: 1, x: 0, y: 0 });
  });

  it("moves in on a small change, centred, no closer than the limit", () => {
    const c = cameraFor([0.45, 0.45, 0.55, 0.55]);
    expect(c.s).toBe(ZOOM_MAX);
    const [x, y] = at(c, 0.5, 0.5);
    expect(x).toBeCloseTo(0.5);
    expect(y).toBeCloseTo(0.5);
  });

  it("frames a mid-size change whole, with room around it", () => {
    const box: Box = [0.2, 0.25, 0.75, 0.7];
    const c = cameraFor(box);
    expect(c.s).toBeGreaterThan(1.15);
    expect(c.s).toBeLessThan(ZOOM_MAX);
    const [l, t0] = at(c, box[0], box[1]);
    const [r, b] = at(c, box[2], box[3]);
    for (const v of [l, t0]) expect(v).toBeGreaterThan(0);
    for (const v of [r, b]) expect(v).toBeLessThan(1);
  });

  it("never shows past the picture's edge, even for a change in a corner", () => {
    for (const box of [[0, 0, 0.1, 0.1], [0.9, 0.85, 1, 1], [0.6, 0.15, 0.68, 0.36], [0.31, 0.63, 0.61, 1]] as Box[]) {
      const c = cameraFor(box);
      expect(c.x).toBeLessThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(0);
      expect(c.x + c.s).toBeGreaterThanOrEqual(1);
      expect(c.y + c.s).toBeGreaterThanOrEqual(1);
    }
  });

  it("draws a live frame across exactly the part of the picture in view", () => {
    // The edge's centre, in shares of the picture's width, for a mask-position (see sweepPath).
    const centre = (pos: number) => 1.25 - 1.5 * (pos / 100);
    const whole = sweepPath(cameraFor(null));
    expect(whole).toEqual({ from: 90, to: 10, scanFrom: -10, scanTo: 110 });
    for (const box of [null, [0.42, 0.26, 0.65, 0.71], [0.58, 0.16, 0.68, 0.36], [0.31, 0.63, 0.61, 1]] as (Box | null)[]) {
      const cam = cameraFor(box);
      const p = sweepPath(cam);
      const [l, r] = [-cam.x / cam.s, (1 - cam.x) / cam.s];
      // It starts with the whole edge just left of the view and ends just right of it; the line rides the edge.
      expect(centre(p.from) + 0.1).toBeCloseTo(l, 2);
      expect(centre(p.to) - 0.1).toBeCloseTo(r, 2);
      expect(p.scanFrom / 100).toBeCloseTo(centre(p.from), 2);
      expect(p.scanTo / 100).toBeCloseTo(centre(p.to), 2);
    }
  });

  it("refuses a zoom box outside the picture", () => {
    const d = longSession();
    const bad: Demo = { ...d, script: d.script.map((s) => (s.type === "zoom" && s.box ? { ...s, box: [0.5, 0.2, 0.4, 1.2] as Box } : s)) };
    expect(demoProblems(bad).some((x) => x.includes("zoom box"))).toBe(true);
  });
});

describe("the change count", () => {
  it("says how many changes the one prompt holds, and nothing before the first", () => {
    expect(changesWord(1)).toBe("1 change");
    const html = renderToStaticMarkup(createElement(ChangeCount, { changes: 7 }));
    expect(html).toContain(">7 changes<");
    expect(html).toContain(">One prompt<");
    expect(html).toContain('data-live-count="7"');
    expect(renderToStaticMarkup(createElement(ChangeCount, { changes: 0 }))).toBe("");
  });

  it("steps aside while the compare plays", () => {
    expect(renderToStaticMarkup(createElement(ChangeCount, { changes: 3, hidden: true }))).toMatch(/opacity-0/);
  });
});

describe("the chat player's turns", () => {
  it("lists every change with the words it added and the picture it settled on", () => {
    const log = changeLog(shipped);
    expect(log).toHaveLength(countChanges(shipped));
    expect(log[0]).toMatchObject({ words: "freshly painted smooth white walls, seamless oak floor", frame: "s1" });
    expect(log[1]).toMatchObject({ words: "emerald velvet sofa with straight arms centred under the window", frame: "s2" });
    for (const [k, c] of log.entries()) {
      expect(c.frame).toBe(`s${k + 1}`);
      expect(c.words).not.toMatch(/^[\s,]/);
    }
    // Joined back up, the turns are the whole prompt.
    expect(log.map((c) => c.words).join(", ")).toBe(viewBefore(shipped, shipped.script.length).typed);
  });

  it("puts only the words since the last settled change in the box", () => {
    const log = changeLog(shipped);
    const full = viewBefore(shipped, shipped.script.length).typed;
    expect(pendingWords(log, "", 0)).toBe("");
    expect(pendingWords(log, "freshly pa", 0)).toBe("freshly pa");
    expect(pendingWords(log, full.slice(0, log[0].end), 1)).toBe("");
    expect(pendingWords(log, `${full.slice(0, log[0].end)}, emerald`, 1)).toBe("emerald");
    expect(pendingWords(log, full, log.length)).toBe("");
  });

  it("follows a session in the long shape too, zoom steps and all", () => {
    const log = changeLog(longSession());
    expect(log.map((c) => c.words)).toEqual(LABELS.map((l) => `${l.toLowerCase()} now`));
    expect(log.at(-1)?.frame).toBe(`s${LABELS.length}`);
  });
});

describe("the chat player's room", () => {
  it("has someone to type every change of the shipped session, and the sixth is the viewer's", () => {
    expect(CHAT_CREW.length).toBeGreaterThanOrEqual(countChanges(shipped));
    expect(CHAT_CREW[5].id).toBe("you");
    expect(CHAT_CREW.filter((p) => p.id === "you")).toHaveLength(1);
  });
});

describe("the chat player's history", () => {
  const log = changeLog(shipped);
  const messages = (rows: ChatRow[]) => rows.filter((r) => r.kind === "message");

  it("keeps every earlier round when the picture goes back to the original: only a reload starts it over", () => {
    const first = chatRows(log, 0, log.length, "").rows;
    const second = chatRows(log, 1, 2, "").rows;
    // The second round starts with everything the first one ended with, then a line, then its own changes.
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second[first.length]).toMatchObject({ kind: "round", round: 1 });
    expect(messages(second)).toHaveLength(log.length + 2);
    // Keys never repeat, so a message on screen keeps its place as the chat rolls.
    expect(new Set(second.map((r) => r.key)).size).toBe(second.length);
  });

  it("has everyone join once, and they stay for the rounds after", () => {
    const { rows, here } = chatRows(log, 2, 3, "");
    const joins = rows.filter((r) => r.kind === "join").map((r) => (r.kind === "join" ? r.who.id : ""));
    expect(new Set(joins).size).toBe(joins.length);
    expect(here.map((p) => p.id).sort()).toEqual([...new Set(CHAT_CREW.map((p) => p.id))].sort());
  });

  it("shows someone else's change as they type it, and yours only once it settles", () => {
    const typingMaya = chatRows(log, 0, 0, "freshly pa").rows.at(-1);
    expect(typingMaya).toMatchObject({ kind: "message", n: 1, words: "freshly pa", frame: null });
    const yourTurn = chatRows(log, 0, 5, "floor to ce").rows;
    expect(messages(yourTurn).at(-1)).toMatchObject({ n: 5 });
    // The next person joins as soon as yours settles, so yours is the last message, not the last row.
    const yours = messages(chatRows(log, 0, 6, "").rows).at(-1);
    expect(yours).toMatchObject({ kind: "message", n: 6, words: log[5].words, frame: log[5].frame });
    expect(yours?.kind === "message" && yours.who.id).toBe("you");
  });
});

describe("the sentence under the picture", () => {
  const s = sentence(shipped);
  const log = changeLog(shipped);

  it("is the whole prompt, each change's own words in its place", () => {
    expect(s.text).toBe(viewBefore(shipped, shipped.script.length).typed);
    expect(s.clauses).toHaveLength(log.length);
    s.clauses.forEach((c, i) => expect(s.text.slice(c.start, c.end)).toBe(log[i].words));
  });

  it("puts every picture at the letter it was drawn for: the words typed before it, never after", () => {
    expect(s.marks[0]).toMatchObject({ at: 0, frame: "s0", live: false });
    expect(s.marks.map((m) => m.frame)).toEqual(frameOrder(shipped));
    for (const m of s.marks.filter((k) => k.live)) expect(m.at).toBeLessThanOrEqual(s.clauses[m.change].end);
    // Each change's full-quality picture sits at the end of its words.
    s.clauses.forEach((c, i) => expect(s.marks.find((m) => m.frame === `s${i + 1}`)).toMatchObject({ at: c.end, live: false, change: i }));
  });

  it("only stops where a picture was drawn, and a tie goes to the full-quality one", () => {
    const at = stops(s.marks);
    expect(at[0]).toBe(0);
    expect(at.at(-1)).toBe(s.text.length);
    expect(markAt(s.marks, s.clauses[0].end).frame).toBe("s1");
    expect(markAt(s.marks, s.clauses[0].end - 1).live).toBe(true);
    expect(markAt(s.marks, 0).frame).toBe("s0");
    expect(markAt(s.marks, s.text.length).frame).toBe(`s${log.length}`);
  });

  it("counts the words a picture holds", () => {
    expect(wordsIn(s.text, 0)).toBe(0);
    expect(wordsIn(s.text, s.clauses[0].end)).toBe(8);
  });
});

describe("the visitor's keys", () => {
  it("answers a key at once, gives up after the wait with none, and keeps keys pressed early for the next letters", async () => {
    const keys = createKeyBus();
    const waiting = keys.wait(1000);
    keys.press();
    await expect(waiting).resolves.toBe(true);
    await expect(keys.wait(5)).resolves.toBe(false);
    keys.press(3);
    await expect(Promise.all([keys.wait(5), keys.wait(5), keys.wait(5)])).resolves.toEqual([true, true, true]);
    await expect(keys.wait(5)).resolves.toBe(false);
    keys.press(2);
    keys.clear();
    await expect(keys.wait(5)).resolves.toBe(false);
  });

  it("is the sixth change, and the room has someone for every other one", () => {
    expect(YOUR_TURN).toBe(5);
    expect(CHAT_CREW.length).toBeGreaterThanOrEqual(countChanges(shipped));
  });
});

/* The portrait session: Home's tile always plays it, and the players pick it or the room at random. */
describe("the portrait session, and the random pick", () => {
  const sha8 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex").slice(0, 8);
  const portraitText = fs.readFileSync(path.join(PUBLIC, PORTRAIT_DEMO), "utf8").replace(/\r\n/g, "\n");
  const portrait = JSON.parse(portraitText) as Demo;

  it("plays: every frame file is there, at its content version, and the file is fetched at its own", () => {
    expect(demoProblems(portrait, exists)).toEqual([]);
    expect(sha8(portraitText)).toBe(PORTRAIT_DEMO_V);
    for (const fr of Object.values(portrait.frames)) {
      for (const src of frameFiles(fr)) expect(src.split("?v=")[1]).toBe(sha8(fs.readFileSync(path.join(PUBLIC, framePath(src)))));
    }
  });

  it("offers both sessions, and either can come up", () => {
    expect(LIVE_DEMOS.map((d) => d.src)).toEqual([LIVE_DEMO, PORTRAIT_DEMO]);
    expect(LIVE_DEMOS.map((d) => d.v)).toEqual([LIVE_DEMO_V, PORTRAIT_DEMO_V]);
    expect(pickDemo(0).src).toBe(LIVE_DEMO);
    expect(pickDemo(0.49).src).toBe(LIVE_DEMO);
    expect(pickDemo(0.5).src).toBe(PORTRAIT_DEMO);
    expect(pickDemo(0.9999).src).toBe(PORTRAIT_DEMO);
  });
});
