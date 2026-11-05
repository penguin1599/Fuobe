/**
 * Print-ready export (Image to 3D): a model's triangles as a binary STL or a 3MF, in millimetres, Z up, standing on the
 * bed, scaled to the height the user sets. Hi3D (and most image-to-3D models) give a model at no real size (Hi3D centres
 * it at a unit radius), so the height is the print's. A watertight check says whether a slicer will need to repair it.
 * Pure: the page gathers the triangles from the GLB (three.js) and hands them here.
 */

/** Triangles as flat xyz positions (glTF axes: Y up, metres or no unit) and the vertex index of each corner. */
export interface TriMesh {
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
}

export type PrintFormat = "stl" | "3mf";
export const PRINT_FORMATS: { id: PrintFormat; label: string; hint: string }[] = [
  { id: "stl", label: "STL", hint: "Every slicer opens it" },
  { id: "3mf", label: "3MF", hint: "Keeps the size in millimetres" },
];

export const MIN_HEIGHT_MM = 5;
export const MAX_HEIGHT_MM = 2000;
export const DEFAULT_HEIGHT_MM = 100;

/** A height a printer can take (5 mm to 2 m), else the default. */
export function printHeight(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HEIGHT_MM;
  return Math.min(MAX_HEIGHT_MM, Math.max(MIN_HEIGHT_MM, Math.round(n * 10) / 10));
}

/**
 * Vertices at the same place merged (a GLB splits them at UV seams and hard normals, which would read as holes),
 * within `tolerance` of the model's size; triangles that collapse to a line or a point are dropped.
 */
export function weld(mesh: TriMesh, tolerance = 1e-6): { positions: Float64Array; indices: Uint32Array } {
  const p = mesh.positions;
  const n = Math.floor(p.length / 3);
  let size = 0;
  for (let i = 0; i < p.length; i++) size = Math.max(size, Math.abs(p[i]));
  const q = (size || 1) * tolerance;
  const map = new Map<string, number>();
  const remap = new Uint32Array(n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(p[3 * i] / q)},${Math.round(p[3 * i + 1] / q)},${Math.round(p[3 * i + 2] / q)}`;
    let at = map.get(key);
    if (at === undefined) {
      at = out.length / 3;
      map.set(key, at);
      out.push(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    }
    remap[i] = at;
  }
  const idx: number[] = [];
  const src = mesh.indices;
  for (let t = 0; t + 2 < src.length; t += 3) {
    const a = remap[src[t]], b = remap[src[t + 1]], c = remap[src[t + 2]];
    if (a === b || b === c || a === c) continue;
    idx.push(a, b, c);
  }
  return { positions: Float64Array.from(out), indices: Uint32Array.from(idx) };
}

export interface WatertightReport {
  /** Every edge is shared by exactly two triangles: no holes, no extra sheets. */
  watertight: boolean;
  triangles: number;
  /** Edges on one triangle only: the rims of holes. */
  openEdges: number;
  /** Edges on three or more triangles: places a slicer can't tell inside from outside. */
  nonManifoldEdges: number;
}

/** Whether a (welded) mesh is closed, by counting how many triangles share each edge. */
export function watertightCheck(mesh: { indices: Uint32Array | number[] }): WatertightReport {
  const counts = new Map<number, number>();
  const idx = mesh.indices;
  let max = 0;
  for (let i = 0; i < idx.length; i++) max = Math.max(max, idx[i]);
  const stride = max + 1;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    for (const [u, v] of [
      [idx[t], idx[t + 1]],
      [idx[t + 1], idx[t + 2]],
      [idx[t + 2], idx[t]],
    ]) {
      const key = Math.min(u, v) * stride + Math.max(u, v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let openEdges = 0;
  let nonManifoldEdges = 0;
  for (const c of counts.values()) {
    if (c === 1) openEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  const triangles = Math.floor(idx.length / 3);
  return { watertight: triangles > 0 && openEdges === 0 && nonManifoldEdges === 0, triangles, openEdges, nonManifoldEdges };
}

/** The model's size along each axis (in its own units). */
export function bounds(positions: ArrayLike<number>): { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * The model for the printer: glTF's Y-up turned to Z-up (x, y, z) → (x, −z, y), scaled so it stands `heightMm` tall,
 * centred on the bed with its lowest point at z = 0. Its footprint in millimetres comes with it.
 */
export function toPrintSpace(positions: ArrayLike<number>, heightMm: number): { positions: Float64Array; sizeMm: [number, number, number] } {
  const n = Math.floor(positions.length / 3);
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[3 * i] = positions[3 * i];
    out[3 * i + 1] = -positions[3 * i + 2];
    out[3 * i + 2] = positions[3 * i + 1];
  }
  const b = bounds(out);
  const tall = b.size[2];
  const k = tall > 0 ? printHeight(heightMm) / tall : 0;
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  for (let i = 0; i < n; i++) {
    out[3 * i] = (out[3 * i] - cx) * k;
    out[3 * i + 1] = (out[3 * i + 1] - cy) * k;
    out[3 * i + 2] = (out[3 * i + 2] - b.min[2]) * k;
  }
  return { positions: out, sizeMm: [b.size[0] * k, b.size[1] * k, b.size[2] * k] };
}

/** A binary STL (80-byte header, then each triangle's normal and corners as float32, little-endian). */
export function toStl(positions: ArrayLike<number>, indices: ArrayLike<number>, header = "Fuobe print-ready export, millimetres"): Uint8Array {
  const tris = Math.floor(indices.length / 3);
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < Math.min(80, header.length); i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, tris, true);
  let o = 84;
  for (let t = 0; t < tris; t++) {
    const [a, b, c] = [indices[3 * t], indices[3 * t + 1], indices[3 * t + 2]];
    const pa = [positions[3 * a], positions[3 * a + 1], positions[3 * a + 2]];
    const pb = [positions[3 * b], positions[3 * b + 1], positions[3 * b + 2]];
    const pc = [positions[3 * c], positions[3 * c + 1], positions[3 * c + 2]];
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const f of [nx / len, ny / len, nz / len, ...pa, ...pb, ...pc]) {
      view.setFloat32(o, f, true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return bytes;
}

const num = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1e4) / 1e4));

/** The 3MF model part: one object in millimetres. */
export function threeMfModel(positions: ArrayLike<number>, indices: ArrayLike<number>, name = "Model"): string {
  const parts: string[] = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n');
  parts.push(` <metadata name="Application">Fuobe</metadata>\n <resources>\n  <object id="1" name="${name.replace(/[<>&"]/g, "")}" type="model">\n   <mesh>\n    <vertices>\n`);
  for (let i = 0; i + 2 < positions.length; i += 3) parts.push(`     <vertex x="${num(positions[i])}" y="${num(positions[i + 1])}" z="${num(positions[i + 2])}"/>\n`);
  parts.push("    </vertices>\n    <triangles>\n");
  for (let t = 0; t + 2 < indices.length; t += 3) parts.push(`     <triangle v1="${indices[t]}" v2="${indices[t + 1]}" v3="${indices[t + 2]}"/>\n`);
  parts.push('    </triangles>\n   </mesh>\n  </object>\n </resources>\n <build>\n  <item objectid="1"/>\n </build>\n</model>\n');
  return parts.join("");
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>\n';
const RELS =
  '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>\n';

/** A 3MF: the package (a zip) with its content types, the relationship to the model, and the model. */
export function toThreeMf(positions: ArrayLike<number>, indices: ArrayLike<number>, name?: string): Uint8Array {
  const enc = new TextEncoder();
  return storeZip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "3D/3dmodel.model", data: enc.encode(threeMfModel(positions, indices, name)) },
  ]);
}

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of stored (uncompressed) files: what a 3MF needs, with no compression library. */
export function storeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface PrintExport {
  data: Uint8Array;
  mime: string;
  ext: PrintFormat;
  report: WatertightReport;
  sizeMm: [number, number, number];
}

/** The whole export: weld, check, scale to the height, write the file. */
export function printExport(mesh: TriMesh, o: { heightMm: number; format: PrintFormat; name?: string }): PrintExport {
  const welded = weld(mesh);
  const report = watertightCheck(welded);
  const placed = toPrintSpace(welded.positions, o.heightMm);
  const data = o.format === "3mf" ? toThreeMf(placed.positions, welded.indices, o.name) : toStl(placed.positions, welded.indices);
  return { data, mime: o.format === "3mf" ? "model/3mf" : "model/stl", ext: o.format, report, sizeMm: placed.sizeMm };
}

/** The check in words, for the dialog. */
export function watertightLine(r: WatertightReport): string {
  if (!r.triangles) return "This model has no surfaces to print.";
  if (r.watertight) return "Watertight: ready for your slicer.";
  const parts = [r.openEdges ? `${r.openEdges.toLocaleString("en")} open edge${r.openEdges === 1 ? "" : "s"}` : "", r.nonManifoldEdges ? `${r.nonManifoldEdges.toLocaleString("en")} shared by more than two faces` : ""].filter(Boolean);
  return `Not watertight (${parts.join(", ")}): most slicers repair this when they import it; check the preview before you print.`;
}
