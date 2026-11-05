// Every node type the studio's workflows and graph builders use. The worker program (scripts/build-worker.mjs) and
// Fuobe Connect (scripts/connect-nodes.mjs) each freeze this list into what they ship: a graph with any other node is
// refused on the person's computer, and the studio can't add to the list.
import fs from "node:fs";
import path from "node:path";

export function studioNodes(root) {
  const index = JSON.parse(fs.readFileSync(path.join(root, "workflows/comfyui/requirements.json"), "utf8"));
  const nodes = new Set();
  for (const wf of Object.values(index.workflows)) {
    for (const c of wf.core) nodes.add(c);
    for (const cs of Object.values(wf.packs)) for (const c of cs) nodes.add(c);
  }
  for (const f of fs.readdirSync(path.join(root, "workflows/comfyui"))) {
    if (!f.endsWith(".json") || f === "requirements.json" || f === "manifest.json") continue;
    try {
      const g = JSON.parse(fs.readFileSync(path.join(root, "workflows/comfyui", f), "utf8"));
      for (const n of Object.values(g)) if (n && typeof n === "object" && typeof n.class_type === "string") nodes.add(n.class_type);
    } catch {}
  }
  // What the graph builders add on their own (LoRA loaders, video joins, overlays…).
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  for (const file of [...walk(path.join(root, "src/lib")), ...walk(path.join(root, "src/server"))]) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/class_type: "([^"]+)"/g)) nodes.add(m[1]);
  }
  for (const extra of ["LoraLoader", "LoraLoaderModelOnly"]) nodes.add(extra);
  return [...nodes].sort();
}

// Outputs ComfyUI never checks the type of: any ("*"), match-typed and dropdown-typed ones. A link from one reaches
// any input (a dropdown too, whose list ComfyUI checks only for a value the graph writes), so Fuobe Connect lets such a
// link, and any link into a dropdown, feed only what Fuobe's own graphs feed that way.
const LOOSE_TYPES = new Set(["*", "COMFY_MATCHTYPE_V3", "COMBO"]);
const looseType = (t) => typeof t !== "string" || t.split(",").some((p) => LOOSE_TYPES.has(p.trim()));
const isDropdown = (spec) => {
  const t = Array.isArray(spec) ? spec[0] : spec;
  return Array.isArray(t) || t === "COMBO" || t === "COMFY_DYNAMICCOMBO_V3";
};
/** An input's name with a trailing number made general: images.image1 and images.image2 are one kind of input. */
export const inputKind = (key) => key.replace(/\d+$/, "#");

/** The studio's graphs (API form): workflows/comfyui and the hand-built ones. */
export function studioGraphs(root) {
  const out = [];
  for (const dir of ["workflows/comfyui", "scripts/comfy/hand-built"]) {
    const at = path.join(root, dir);
    if (!fs.existsSync(at)) continue;
    for (const f of fs.readdirSync(at)) {
      if (!f.endsWith(".json") || ["requirements.json", "manifest.json", "object_info.subset.json"].includes(f)) continue;
      try {
        const g = JSON.parse(fs.readFileSync(path.join(at, f), "utf8"));
        if (g && typeof g === "object" && !Array.isArray(g)) out.push(g);
      } catch {}
    }
  }
  return out;
}

/**
 * The node types (on `nodes`) with outputs ComfyUI doesn't type-check, by output slot, and every [source type, target
 * type, input kind] that the studio's graphs link from such an output or into a dropdown. Types come from
 * workflows/comfyui/object_info.subset.json; inside ComfyUI, Fuobe Connect also reads them from the node classes.
 */
export function connectLinks(root, nodes) {
  const info = JSON.parse(fs.readFileSync(path.join(root, "workflows/comfyui/object_info.subset.json"), "utf8"));
  const loose = {};
  for (const n of nodes) {
    const outs = info[n]?.output;
    if (!Array.isArray(outs)) continue;
    const slots = outs.flatMap((t, i) => (looseType(t) ? [i] : []));
    if (slots.length) loose[n] = slots;
  }
  const dropdown = (cls, key) => {
    const inputs = info[cls]?.input ?? {};
    const spec = inputs.required?.[key] ?? inputs.optional?.[key];
    return spec !== undefined && isDropdown(spec);
  };
  const links = new Set();
  for (const g of studioGraphs(root)) {
    for (const n of Object.values(g)) {
      if (!n || typeof n !== "object" || typeof n.class_type !== "string") continue;
      for (const [key, v] of Object.entries(n.inputs ?? {})) {
        if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || !Number.isInteger(v[1])) continue;
        const src = g[v[0]]?.class_type;
        if (typeof src !== "string") continue;
        if (loose[src]?.includes(v[1]) || dropdown(n.class_type, key)) links.add(JSON.stringify([src, n.class_type, inputKind(key)]));
      }
    }
  }
  return { loose, links: [...links].sort().map((l) => JSON.parse(l)) };
}
