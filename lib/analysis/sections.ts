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
 *  - Figure (Lissajous): two notes sound together; the figure is drawn from their frequency ratio.
 *  - Ripples (two-source interference): two notes with weight in the bass, as two wave sources.
 *  - Rings: many onsets (hits); a ring leaves the centre on every half beat.
 *  - Membrane: weight in the voice range (about 300 Hz–2.5 kHz, pitch ranges 4–6), as modes of a round drum skin.
 *  - Ribbons: energy across the whole spectrum at once.
 */
import type { Analysis } from './types';
import { BAND_COUNT } from './types';

export type Design = 'ribbons' | 'rings' | 'plate' | 'figure' | 'ripples' | 'membrane';
export const DESIGNS: Design[] = ['ribbons', 'rings', 'plate', 'figure', 'ripples', 'membrane'];
export const DESIGN_NAMES: Record<Design, string> = {
  ribbons: 'Ribbons',
  rings: 'Rings',
  plate: 'Plate',
  figure: 'Two-note figure',
  ripples: 'Ripple tank',
  membrane: 'Membrane',
};

export interface Section {
  start: number;
  end: number;
  design: Design;
  /** raw measurements, kept for the explanation and for tests */
  stats: SectionStats;
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
  const per = Math.max(1, Math.round(BLOCK * fps));
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
    figure: s.top1 * s.pair * calm,
    ripples: s.pair * (0.4 + s.bass),
    rings: s.onset * (0.5 + s.loud),
    membrane: s.voice * (0.5 + s.loud) * (1 - s.spread * 0.5),
    ribbons: s.spread * (0.5 + s.loud) * (0.7 + s.high),
  };
}

export function planSections(a: Analysis): Section[] {
  const { score, blockSeconds } = novelty(a);
  const cuts = boundaries(score, blockSeconds, a.duration);
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
  const used = new Set<Design>();
  const out: Section[] = [];
  let prev: Design | null = null;
  for (let i = 0; i < stats.length; i++) {
    let best: Design = 'ribbons', bestS = -Infinity;
    for (const d of DESIGNS) {
      if (d === prev) continue; // a new section always looks different
      const s = z[i][d] + (used.has(d) ? 0 : 0.35);
      if (s > bestS) { bestS = s; best = d; }
    }
    used.add(best);
    out.push({ start: cuts[i], end: cuts[i + 1], design: best, stats: stats[i] });
    prev = best;
  }
  return out;
}

/** Which designs are showing at `time`, and how strongly (they cross-fade around each boundary). */
export function designsAt(sections: Section[], time: number, fade: number): { design: Design; weight: number }[] {
  if (!sections.length) return [{ design: 'ribbons', weight: 1 }];
  for (let k = 0; k < sections.length; k++) {
    const s = sections[k];
    if (time < s.end || k === sections.length - 1) {
      const next = sections[k + 1];
      if (next && time > s.end - fade / 2) {
        const w = Math.min(1, Math.max(0, (time - (s.end - fade / 2)) / fade));
        const e = w * w * (3 - 2 * w);
        return [{ design: s.design, weight: 1 - e }, { design: next.design, weight: e }];
      }
      const prevS = sections[k - 1];
      if (prevS && time < s.start + fade / 2) {
        const w = Math.min(1, Math.max(0, (time - (s.start - fade / 2)) / fade));
        const e = w * w * (3 - 2 * w);
        return [{ design: prevS.design, weight: 1 - e }, { design: s.design, weight: e }];
      }
      return [{ design: s.design, weight: 1 }];
    }
  }
  return [{ design: sections[sections.length - 1].design, weight: 1 }];
}
