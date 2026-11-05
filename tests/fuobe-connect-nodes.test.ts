import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fuobe Connect (integrations/fuobe-connect) refuses a studio's graph with a node type that isn't on the list it ships.
 * That list must hold every node the studio's workflows and graph builders use, or those runs fail on people's
 * computers. When this fails: node scripts/connect-nodes.mjs, and ship the list with the next Fuobe Connect release.
 */
describe("Fuobe Connect's node list", () => {
  it("holds every node type the studio uses", async () => {
    const { studioNodes } = await import("../scripts/lib/studio-nodes.mjs");
    const root = process.cwd();
    const shipped = JSON.parse(fs.readFileSync(path.join(root, "integrations/fuobe-connect/fuobe_connect/allowed_nodes.json"), "utf8")).nodes as string[];
    const missing = (studioNodes(root) as string[]).filter((n) => !shipped.includes(n));
    expect(missing, "run node scripts/connect-nodes.mjs").toEqual([]);
  });

  it("holds every untyped output and every such link the studio's graphs make", async () => {
    const { connectLinks, studioNodes } = await import("../scripts/lib/studio-nodes.mjs");
    const root = process.cwd();
    const shipped = JSON.parse(fs.readFileSync(path.join(root, "integrations/fuobe-connect/fuobe_connect/allowed_nodes.json"), "utf8")) as {
      loose: Record<string, number[]>;
      links: [string, string, string][];
    };
    const want = connectLinks(root, studioNodes(root)) as { loose: Record<string, number[]>; links: [string, string, string][] };
    expect(shipped.loose, "run node scripts/connect-nodes.mjs").toEqual(want.loose);
    const have = new Set(shipped.links.map((l) => l.join("|")));
    expect(want.links.filter((l) => !have.has(l.join("|"))), "run node scripts/connect-nodes.mjs").toEqual([]);
    // Fuobe's any-typed helpers are among them: a link from one may feed only what the studio's graphs feed.
    for (const n of ["CreateList", "GetItemFromList", "VRAM_Debug", "ComfySwitchNode"]) expect(Object.keys(shipped.loose)).toContain(n);
  });

  it("never lists nodes that read any folder, fetch addresses or run code", () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(process.cwd(), "integrations/fuobe-connect/fuobe_connect/allowed_nodes.json"), "utf8")).nodes as string[];
    for (const risky of ["LoadImagesFromFolderKJ", "LoadImageFromUrl", "Image Load", "Image Saver", "Text Load Line From File", "KJ_RunPython"]) expect(shipped).not.toContain(risky);
  });
});
