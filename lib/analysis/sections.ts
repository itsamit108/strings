/**
 * Finds where the music changes (its sections) and picks, for each section, the design that shows
 * what that section is doing.
 *
 * Boundaries: Foote's audio novelty (ICME 2000). The song is cut into half-second blocks; each block
 * is described by its notes (chroma), its spectrum (pitch-range levels), loudness, onsets and timbral
 * brightness. A self-similarity matrix compares every block with every other, and a Gaussian-tapered
 * checkerboard kernel slid along its diagonal scores how different the music just after each moment is
 * from the music just before. Peaks of that score are the section boundaries.
 *
 * Design per section, from what was measured in it (scores are compared within the song):
 *  - Plate (Chladni figure): one note dominates and holds steady, the way one frequency drives a plate.
 *  - Ripples (interference): two or more notes sounding together, each a wave source.
 *  - Rings: many onsets (hits); a ring leaves the centre on every half beat.
 *  - Membrane: weight in the voice range (about 300 Hz–2.5 kHz, pitch ranges 4–6), as modes of a round drum skin.
 *  - Ribbons: energy across the whole spectrum at once.
 */
import type { Analysis } from './types';
import { BAND_COUNT } from './types';

export type Design = 'ribbons' | 'rings' | 'plate' | 'ripples' | 'membrane';
export const DESIGNS: Design[] = ['ribbons', 'rings', 'plate', 'ripples', 'membrane'];
export const DESIGN_NAMES: Record<Design, string> = {
  ribbons: 'Ribbons',
  rings: 'Rings',
  plate: 'Plate',
  ripples: 'Ripple tank',
  membrane: 'Membrane',
};

export interface Section {
  start: number;
  end: number;
  design: Design;
  /** raw measurements, kept for the explanation and for tests */
  stats: SectionStats;
  /** seconds the change into this section takes: as wide as the change in the music itself */
  fade: number;
}

export interface SectionStats {
  onset: number;
  top1: number;
  pair: number;
  steady: number;
  bass: number;
  spread: number;
  mid: number;
  voice: number;
  high: number;
  loud: number;
}

const BLOCK = 0.5;      // seconds per block
const HALF = 12;        // kernel half-width in blocks (6 s each side)
const MIN_GAP = 16;     // at least 8 s between boundaries
const MAX_LEN = 32;     // split sections longer than this (seconds)
const MIN_PIECE = 10;   // never make a section shorter than this when splitting (seconds)
const MAX_BLOCKS = 1600; // keeps the similarity matrix ≤ 10 MB

/** Share of the energy in the voice range: pitch ranges 4–6 (about 315 Hz – 2.5 kHz), where voices carry. */
function voiceShare(a: Analysis, i: number): number {
  let sum = 0, voice = 0;
  for (let k = 0; k < BAND_COUNT; k++) {
    const b = a.bands[i * BAND_COUNT + k];
    sum += b;
    if (k >= 3 && k <= 5) voice += b;
  }
  return sum > 0 ? voice / sum : 0;
}

function blocks(a: Analysis) {
  const fps = a.sampleRate / a.hop;
  // Half-second blocks, but never more than MAX_BLOCKS of them: the similarity matrix is n², so a long
  // recording (an hour would be 207 MB) is compared in longer blocks instead.
  const per = Math.max(1, Math.round(BLOCK * fps), Math.ceil(a.totalFrames / MAX_BLOCKS));
  const n = Math.max(1, Math.floor(a.totalFrames / per));
  const dims = 12 + BAND_COUNT + 4;
  const v = new Float32Array(n * dims);
  for (let b = 0; b < n; b++) {
    const o = b * dims;
    for (let i = b * per; i < (b + 1) * per && i < a.totalFrames; i++) {
      for (let pc = 0; pc < 12; pc++) v[o + pc] += a.chroma[i * 12 + pc];
      for (let k = 0; k < BAND_COUNT; k++) v[o + 12 + k] += a.bands[i * BAND_COUNT + k];
      v[o + 20] += a.loud[i];
      v[o + 21] += a.onset[i];
      v[o + 22] += a.bright[i];
      v[o + 23] += voiceShare(a, i);
    }
    // Each part counts equally: notes, spectrum, then loudness / onsets / brightness.
    const norm = (from: number, to: number, w: number) => {
      let s = 0;
      for (let d = from; d < to; d++) s += v[o + d] * v[o + d];
      s = Math.sqrt(s) || 1;
      for (let d = from; d < to; d++) v[o + d] = (v[o + d] / s) * w;
    };
    for (let d = 20; d < 24; d++) v[o + d] /= per;
    norm(0, 12, 1);
    norm(12, 12 + BAND_COUNT, 1);
    for (let d = 20; d < 24; d++) v[o + d] *= 0.6;
    v[o + 23] *= 1.5; // a voice coming in or leaving is a strong change
  }
  return { v, n, dims, per };
}

/** Novelty score per block (Foote 2000). */
export function novelty(a: Analysis): { score: Float32Array; blockSeconds: number } {
  const { v, n, dims, per } = blocks(a);
  const sim = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let d = 0, ni = 0, nj = 0;
      for (let k = 0; k < dims; k++) { d += v[i * dims + k] * v[j * dims + k]; ni += v[i * dims + k] ** 2; nj += v[j * dims + k] ** 2; }
      const c = d / (Math.sqrt(ni * nj) || 1);
      sim[i * n + j] = sim[j * n + i] = c;
    }
  }
  const score = new Float32Array(n);
  const sigma = HALF / 2;
  for (let c = 0; c < n; c++) {
    let s = 0;
    for (let x = -HALF; x < HALF; x++) {
      const i = c + x;
      if (i < 0 || i >= n) continue;
      for (let y = -HALF; y < HALF; y++) {
        const j = c + y;
        if (j < 0 || j >= n) continue;
        const gx = x + 0.5, gy = y + 0.5;
        const taper = Math.exp(-(gx * gx + gy * gy) / (2 * sigma * sigma));
        s += Math.sign(gx) * Math.sign(gy) * taper * sim[i * n + j];
      }
    }
    score[c] = Math.max(0, s);
  }
  return { score, blockSeconds: (per * a.hop) / a.sampleRate };
}

function boundaries(score: Float32Array, blockSeconds: number, duration: number): number[] {
  const n = score.length;
  let mean = 0;
  for (const s of score) mean += s / n;
  let sd = 0;
  for (const s of score) sd += (s - mean) ** 2 / n;
  sd = Math.sqrt(sd);
  const peaks: { i: number; s: number }[] = [];
  for (let i = HALF / 2; i < n - HALF / 2; i++) {
    let isMax = true;
    for (let d = -8; d <= 8 && isMax; d++) if (d && i + d >= 0 && i + d < n && score[i + d] > score[i]) isMax = false;
    if (isMax && score[i] > mean + 0.3 * sd) peaks.push({ i, s: score[i] });
  }
  // Strongest first, keeping them apart.
  peaks.sort((p, q) => q.s - p.s);
  const kept: number[] = [];
  for (const p of peaks) if (kept.every((k) => Math.abs(k - p.i) >= MIN_GAP)) kept.push(p.i);
  const cuts = [0, ...kept.sort((x, y) => x - y).map((i) => i * blockSeconds), duration];
  // Long sections: cut again at their own strongest change.
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (let k = 0; k < cuts.length - 1; k++) {
      const a0 = cuts[k], a1 = cuts[k + 1];
      if (a1 - a0 <= MAX_LEN) continue;
      let best = -1, bestS = -1;
      for (let i = Math.ceil((a0 + MIN_PIECE) / blockSeconds); i * blockSeconds < a1 - MIN_PIECE && i < n; i++) {
        if (score[i] > bestS) { bestS = score[i]; best = i; }
      }
      const at = best >= 0 ? best * blockSeconds : (a0 + a1) / 2;
      cuts.splice(k + 1, 0, at);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  // A very short last piece joins the one before.
  if (cuts.length > 2 && duration - cuts[cuts.length - 2] < 6) cuts.splice(cuts.length - 2, 1);
  return cuts;
}

function measure(a: Analysis, t0: number, t1: number): SectionStats {
  const fps = a.sampleRate / a.hop;
  const i0 = Math.max(0, Math.floor(t0 * fps)), i1 = Math.min(a.totalFrames, Math.ceil(t1 * fps));
  let onset = 0, top1 = 0, pair = 0, steady = 0, bass = 0, spread = 0, mid = 0, voice = 0, high = 0, loud = 0, n = 0;
  for (let i = i0; i < i1; i++) {
    if (a.loud[i] < 0.05) continue; // silence says nothing about the music
    n++;
    let m1 = 0, m2 = 0, change = 0;
    for (let pc = 0; pc < 12; pc++) {
      const c = a.chroma[i * 12 + pc];
      if (c > m1) { m2 = m1; m1 = c; } else if (c > m2) m2 = c;
      if (i > i0) change += Math.abs(c - a.chroma[(i - 1) * 12 + pc]);
    }
    top1 += m1;
    pair += m1 > 0 ? m2 / m1 : 0;
    steady += 1 - Math.min(1, change);
    let sum = 0, active = 0, middle = 0;
    for (let k = 0; k < BAND_COUNT; k++) {
      const b = a.bands[i * BAND_COUNT + k];
      sum += b;
      if (b > 0.45) active++;
      if (k >= 2 && k <= 5) middle += b;
    }
    bass += sum > 0 ? (a.bands[i * BAND_COUNT] + a.bands[i * BAND_COUNT + 1]) / sum : 0;
    mid += sum > 0 ? middle / sum : 0;
    voice += voiceShare(a, i);
    high += sum > 0 ? (a.bands[i * BAND_COUNT + 6] + a.bands[i * BAND_COUNT + 7]) / sum : 0;
    spread += active / BAND_COUNT;
    onset += a.onset[i];
    loud += a.loud[i];
  }
  n = Math.max(1, n);
  return { onset: onset / n, top1: top1 / n, pair: pair / n, steady: steady / n, bass: bass / n, spread: spread / n, mid: mid / n, voice: voice / n, high: high / n, loud: loud / n };
}

function raw(s: SectionStats): Record<Design, number> {
  const calm = 1 - Math.min(1, s.onset / 0.6);
  return {
    plate: s.top1 * (1 - s.pair) * s.steady * calm,
    ripples: s.pair * (0.4 + s.bass),
    rings: s.onset * (0.5 + s.loud),
    membrane: s.voice * (0.5 + s.loud) * (1 - s.spread * 0.5),
    ribbons: s.spread * (0.5 + s.loud) * (0.7 + s.high),
  };
}

export function planSections(a: Analysis): Section[] {
  const { score, blockSeconds } = novelty(a);
  const cuts = boundaries(score, blockSeconds, a.duration);
  // The novelty curve finds where the music changes to within a block; move each change onto the
  // strongest onset nearby (within most of a beat), so the picture changes exactly when the sound does.
  const frameSec = a.hop / a.sampleRate, reach = Math.max(0.3, 0.75 * a.beatPeriod);
  for (let c = 1; c < cuts.length - 1; c++) {
    const lo = Math.max(cuts[c - 1] + 1, cuts[c] - reach), hi = Math.min(cuts[c + 1] - 1, cuts[c] + reach);
    let best = -1, bestOn = 0;
    for (let f = Math.ceil(lo / frameSec); f <= Math.floor(hi / frameSec) && f < a.onset.length; f++)
      if (a.onset[f] > bestOn) { bestOn = a.onset[f]; best = f; }
    if (best >= 0 && bestOn > 0.15) cuts[c] = best * frameSec;
  }
  const stats = cuts.slice(0, -1).map((t, k) => measure(a, t, cuts[k + 1]));
  const raws = stats.map(raw);
  // Compare each design's score with the same design elsewhere in this song (z-scores),
  // plus a little of its absolute strength so a one-section song still picks sensibly.
  const z: Record<Design, number>[] = raws.map(() => ({} as Record<Design, number>));
  for (const d of DESIGNS) {
    const vals = raws.map((r) => r[d]);
    const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / vals.length);
    const scale = Math.max(sd, 0.05 * Math.abs(mean), 1e-6);
    const top = Math.max(...vals, 1e-6);
    raws.forEach((r, i) => { z[i][d] = (r[d] - mean) / scale + 1.5 * (r[d] / top); });
  }
  const used = new Map<Design, number>();
  const out: Section[] = [];
  let prev: Design | null = null;
  for (let i = 0; i < stats.length; i++) {
    let best: Design = 'ribbons', bestS = -Infinity;
    for (const d of DESIGNS) {
      if (d === prev) continue; // a new section always looks different
      // Fit first; then each earlier use of a design counts against it, so a song moves through its options.
      const uses = used.get(d) ?? 0;
      const s = z[i][d] + (uses === 0 ? 0.35 : -0.6 * uses);
      if (s > bestS) { bestS = s; best = d; }
    }
    used.set(best, (used.get(best) ?? 0) + 1);
    out.push({ start: cuts[i], end: cuts[i + 1], design: best, stats: stats[i], fade: changeWidth(score, blockSeconds, cuts[i], a.beatPeriod) });
    prev = best;
  }
  // A change happens inside the part it opens and takes at most half of it, so two changes never overlap.
  for (let i = 1; i < out.length; i++) out[i].fade = Math.min(out[i].fade, 0.5 * (out[i].end - out[i].start));
  return out;
}

/**
 * How long the change at `at` takes in the music: the width of the novelty peak at half its height.
 * A sudden change (a drop, an entrance) gives a narrow peak, a gradual one a wide peak. Kept between
 * 2 and 8 beats, so it moves in the song's own time.
 */
function changeWidth(score: Float32Array, blockSeconds: number, at: number, beat: number): number {
  const c = Math.round(at / blockSeconds);
  if (c <= 0 || c >= score.length) return 4 * beat;
  const half = score[c] / 2;
  let l = c, r = c;
  while (l > 0 && score[l - 1] > half && c - l < 24) l--;
  while (r < score.length - 1 && score[r + 1] > half && r - c < 24) r++;
  const width = (r - l + 1) * blockSeconds;
  return Math.min(8 * beat, Math.max(2 * beat, width));
}

/**
 * Which designs are showing at `time`, and how strongly. Around each boundary the outgoing and incoming
 * designs cross with an equal-power curve (cos / sin), as sound engineers cross-fade two tracks, so the
 * picture never dips in the middle. `blend` is 0 away from boundaries and 1 at the middle of a change.
 */
export function designsAt(sections: Section[], time: number): { shown: { design: Design; weight: number }[]; blend: number; progress: number } {
  if (!sections.length) return { shown: [{ design: 'ribbons', weight: 1 }], blend: 0, progress: -1 };
  let k = sections.findIndex((s) => time < s.end);
  if (k < 0) k = sections.length - 1;
  const s = sections[k], prev = sections[k - 1];
  // A change starts on the musical event itself (never before it: the picture follows the sound) and
  // takes as long as the change in the music does.
  if (prev && time >= s.start && time < s.start + s.fade) {
    const w = Math.min(1, Math.max(0, (time - s.start) / s.fade));
    return {
      shown: [{ design: prev.design, weight: Math.cos((w * Math.PI) / 2) }, { design: s.design, weight: Math.sin((w * Math.PI) / 2) }],
      blend: Math.sin(w * Math.PI),
      progress: w,
    };
  }
  return { shown: [{ design: s.design, weight: 1 }], blend: 0, progress: -1 };
}
