#!/usr/bin/env node
/**
 * Demo-mode Gaussian splats for Image to 3D → Splat: the same faceted crystal as the demo GLB, as a standard 3DGS
 * .ply (public/samples/demo-splat.ply, what cloud TripoSplat returns) and a Niantic .spz v2 (demo-splat.spz, what
 * the open TripoSplat and Idol 3D graphs write). Like an Idol splat, about a third of its Gaussians are faint haze
 * (opacity under 0.05) around the object, so the viewer's "Hide faint haze" slider has something to hide.
 * Deterministic (a seeded generator). Run: node scripts/gen-demo-splat.mjs
 * A bigger one to time the viewer with (not committed): --gaussians=262144 --out=/tmp/splat-262k (writes
 * demo-splat.ply and .spz there).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const out = arg("out") ? path.resolve(arg("out")) : path.join(root, "public", "samples");
fs.mkdirSync(out, { recursive: true });

const N = Number(arg("gaussians") ?? 4096);
const SOLID = Math.round(N * (2816 / 4096));
const HAZE = N - SOLID;

// mulberry32: the same file on every run.
let seed = 0x5d4bdb;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The crystal's outline (gen-demo-3d.mjs): an octagonal bipyramid, tip at y 1.05, girdle at y 0.25 to -0.05
// (radius 0.62), bottom tip at y -1.25. y is up.
const radiusAt = (y) => (y > 0.25 ? 0.62 * (1.05 - y) / 0.8 : y < -0.05 ? 0.62 * (y + 1.25) / 1.2 : 0.62);
const PALETTE = [
  [0.365, 0.294, 0.859],
  [0.51, 0.44, 0.95],
  [0.27, 0.2, 0.7],
  [0.62, 0.55, 0.98],
];
const SH_C0 = 0.28209479177387814;
const logit = (p) => Math.log(p / (1 - p));

/** Each Gaussian: position, colour (linear 0-1), opacity (0-1), scale (world units), rotation (w, x, y, z). */
const splats = [];
for (let i = 0; i < N; i++) {
  const haze = i >= SOLID;
  const y = -1.25 + rand() * 2.3;
  const a = rand() * Math.PI * 2;
  // Solid ones sit near the surface (facets: the octagon's sector picks the colour); haze floats a little outside.
  const r = haze ? radiusAt(y) * (1.05 + rand() * 0.35) + 0.04 : radiusAt(y) * (0.82 + rand() * 0.18);
  const sector = Math.floor(((a / (Math.PI * 2)) * 8 + (y > 0.1 ? 0.5 : 0)) % 8);
  const base = PALETTE[(sector + (y > 0.1 ? 0 : 1)) % PALETTE.length];
  const shade = 0.85 + 0.3 * ((y + 1.25) / 2.3);
  const color = haze ? [0.72, 0.7, 0.8] : base.map((c) => Math.min(1, c * shade));
  const s = haze ? 0.05 + rand() * 0.05 : 0.025 + rand() * 0.025;
  // Turned about y (by up to 180°: w stays positive, so both files hold the very same quaternion).
  const half = rand() * (Math.PI / 2);
  splats.push({
    p: [Math.cos(a) * r, y, Math.sin(a) * r],
    color,
    opacity: haze ? 0.01 + rand() * 0.035 : 0.75 + rand() * 0.24,
    scale: [s, s * (0.6 + rand() * 0.4), s],
    rot: [Math.cos(half), 0, Math.sin(half), 0],
  });
}

// .ply: the 17 float32 values per Gaussian that Idol / TripoSplat write (x y z, zero normals, f_dc, logit opacity,
// log scale, rotation w x y z).
const PROPS = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${N}\n${PROPS.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
const body = Buffer.alloc(N * PROPS.length * 4);
splats.forEach((g, i) => {
  const v = [...g.p, 0, 0, 0, ...g.color.map((c) => (c - 0.5) / SH_C0), logit(g.opacity), ...g.scale.map(Math.log), ...g.rot];
  v.forEach((x, k) => body.writeFloatLE(x, (i * PROPS.length + k) * 4));
});
const ply = Buffer.concat([Buffer.from(header, "ascii"), body]);
fs.writeFileSync(path.join(out, "demo-splat.ply"), ply);

// .spz v2 (github.com/nianticlabs/spz): a 16-byte header, then positions (24-bit fixed point), alphas, colours,
// scales and rotations, each as one block, all gzipped. Same axes as the .ply.
const FRACTIONAL_BITS = 12;
const u8 = (x) => Math.max(0, Math.min(255, Math.round(x)));
const head = Buffer.alloc(16);
head.writeUInt32LE(0x5053474e, 0); // "NGSP"
head.writeUInt32LE(2, 4);
head.writeUInt32LE(N, 8);
head.writeUInt8(0, 12); // SH degree 0
head.writeUInt8(FRACTIONAL_BITS, 13);
head.writeUInt8(0, 14); // flags
const positions = Buffer.alloc(N * 9);
const alphas = Buffer.alloc(N);
const colors = Buffer.alloc(N * 3);
const scales = Buffer.alloc(N * 3);
const rotations = Buffer.alloc(N * 3);
splats.forEach((g, i) => {
  g.p.forEach((x, k) => {
    const fixed = Math.round(x * (1 << FRACTIONAL_BITS)) & 0xffffff;
    positions.writeUIntLE(fixed, (i * 3 + k) * 3, 3);
  });
  alphas[i] = u8(g.opacity * 255);
  // spz stores the DC coefficient scaled by 0.15 around 0.5.
  g.color.forEach((c, k) => (colors[i * 3 + k] = u8((((c - 0.5) / SH_C0) * 0.15 + 0.5) * 255)));
  g.scale.forEach((s, k) => (scales[i * 3 + k] = u8((Math.log(s) + 10) * 16)));
  // x, y, z of the unit quaternion with w >= 0.
  const [w, x, y, z] = g.rot;
  const sign = w < 0 ? -1 : 1;
  [x, y, z].forEach((q, k) => (rotations[i * 3 + k] = u8(q * sign * 127.5 + 127.5)));
});
const spz = zlib.gzipSync(Buffer.concat([head, positions, alphas, colors, scales, rotations]), { level: 9 });
fs.writeFileSync(path.join(out, "demo-splat.spz"), spz);
console.log(`wrote demo-splat.ply (${ply.length} bytes) and demo-splat.spz (${spz.length} bytes), ${N} Gaussians, ${HAZE} of them haze`);
