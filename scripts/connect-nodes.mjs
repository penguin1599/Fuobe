#!/usr/bin/env node
// Writes Fuobe Connect's node allowlist (integrations/fuobe-connect/fuobe_connect/allowed_nodes.json): every node type
// the studio's graphs use, the node types whose outputs ComfyUI doesn't type-check, and the links the studio's graphs
// make from those outputs or into a dropdown. Fuobe Connect refuses a studio's graph with any other node, or with any
// other such link, so run this before a Fuobe Connect release whenever a workflow or graph builder starts using a new
// node or a new link of that kind. tests/fuobe-connect-nodes.test.ts checks it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectLinks, studioNodes } from "./lib/studio-nodes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONNECT_NODES = "integrations/fuobe-connect/fuobe_connect/allowed_nodes.json";

const list = studioNodes(root);
const { loose, links } = connectLinks(root, list);
const body = [
  "{",
  ` "nodes": ${JSON.stringify(list, null, 1).replace(/\n/g, "\n ")},`,
  ` "loose": {\n${Object.entries(loose).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n },`,
  ` "links": [\n${links.map((l) => `  ${JSON.stringify(l)}`).join(",\n")}\n ]`,
  "}",
].join("\n");
JSON.parse(body);
fs.writeFileSync(path.join(root, CONNECT_NODES), `${body}\n`);
console.log(`Fuobe Connect: ${list.length} allowed node types, ${Object.keys(loose).length} untyped, ${links.length} links -> ${CONNECT_NODES}`);
