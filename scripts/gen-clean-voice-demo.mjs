#!/usr/bin/env node
/**
 * Makes Clean up voice's demo files (public/samples/clean-voice/, played by src/components/audio-tools/clean-voice-demo.tsx)
 * from their full-size sources. Needs ffmpeg on PATH (with libwebp).
 *
 *   node scripts/gen-clean-voice-demo.mjs --room room.png --quiet quiet.png --noisy noisy.wav --clean clean.wav
 *     [--start 0] [--out public/samples/clean-voice]
 *
 * --room   the restaurant photo (4:3); --quiet the same photo with the room softened and dimmed around her.
 *          Both become 1280x960 WebP (room.webp, quiet.webp).
 * --noisy  the recording with the room in it; --clean her voice alone. Same moment, same length: the demo plays both
 *          from one clock and switches between them. Both are cut to the same 8 s from --start, made 48 kHz mono, and
 *          given the same gain (the louder one to about -16 LUFS), so switching only changes what is around her voice.
 *          They become AAC-LC 128 kb/s .m4a (noisy.m4a, clean.m4a), with no metadata.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]]] : a), []));
const missing = ['room', 'quiet', 'noisy', 'clean'].filter((k) => !args[k]);
if (missing.length) {
  console.error(`Missing --${missing.join(', --')}\nUsage: node scripts/gen-clean-voice-demo.mjs --room <photo> --quiet <softened photo> --noisy <recording> --clean <voice alone> [--start <s>] [--out <folder>]`);
  process.exit(2);
}
const out = path.resolve(args.out ?? path.join(HERE, '..', 'public', 'samples', 'clean-voice'));
const start = Number(args.start ?? 0);
const LENGTH = 8;
const TARGET_LUFS = -16;
const W = 1280;
const H = 960;

const ffmpeg = (...a) => execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', ...a]);
/** Integrated loudness (LUFS) of a file, from ffmpeg's report. */
const loudness = (file) => {
  const log = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const m = /I:\s+(-?[\d.]+) LUFS/.exec(log);
  return m ? Number(m[1]) : NaN;
};

fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-voice-demo-'));
try {
  for (const name of ['room', 'quiet']) {
    ffmpeg('-i', args[name], '-vf', `scale=${W}:${H}:flags=lanczos:force_original_aspect_ratio=increase,crop=${W}:${H}`, '-map_metadata', '-1', '-c:v', 'libwebp', '-quality', '82', '-compression_level', '6', path.join(out, `${name}.webp`));
  }
  const cut = Object.fromEntries(
    ['noisy', 'clean'].map((name) => {
      const file = path.join(tmp, `${name}.wav`);
      ffmpeg('-ss', start.toFixed(3), '-t', String(LENGTH), '-i', args[name], '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', file);
      return [name, file];
    }),
  );
  const loudest = Math.max(loudness(cut.noisy), loudness(cut.clean));
  const gain = Number.isFinite(loudest) ? TARGET_LUFS - loudest : 0;
  for (const [name, file] of Object.entries(cut)) {
    ffmpeg('-i', file, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:level=false`, '-map_metadata', '-1', '-fflags', '+bitexact', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', path.join(out, `${name}.m4a`));
  }
  console.log(`Wrote room.webp, quiet.webp, noisy.m4a and clean.m4a to ${out} (${LENGTH} s from ${start} s, gain ${gain.toFixed(1)} dB on both clips)`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
