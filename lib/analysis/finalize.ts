/**
 * Whole-song measurements made from the per-frame features:
 * dynamic range, onsets, tempo, key, pitch-range levels, fingerprint.
 */
import { BAND_COUNT, type Analysis, type AnalysisParams, type ChunkFeatures, type KeyEstimate } from './types';

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// Krumhansl–Kessler key profiles: how strongly each scale degree is heard in a key.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const ARC_POINTS = 512;

function percentile(values: Float32Array, q: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / (Math.sqrt(da * db) + 1e-12);
}

/** Pitch class → angle on the circle of fifths (0..1). Neighbouring keys get neighbouring colours. */
export function fifthsAngle(pitchClass: number): number {
  return ((pitchClass * 7) % 12) / 12;
}

/** Circular mean of a chroma vector on the circle of fifths → 0..1. */
export function chromaAngle(chroma: ArrayLike<number>, offset = 0): number {
  let x = 0, y = 0;
  for (let pc = 0; pc < 12; pc++) {
    const a = fifthsAngle(pc) * 2 * Math.PI;
    x += chroma[offset + pc] * Math.cos(a);
    y += chroma[offset + pc] * Math.sin(a);
  }
  const ang = Math.atan2(y, x) / (2 * Math.PI);
  return ang < 0 ? ang + 1 : ang;
}

export function finalize(chunks: ChunkFeatures[], p: AnalysisParams, duration: number): Analysis {
  const F = p.totalFrames;
  const rms = new Float32Array(F), flux = new Float32Array(F), centroid = new Float32Array(F);
  const chroma = new Float32Array(F * 12), bands = new Float32Array(F * BAND_COUNT);
  for (const c of chunks) {
    rms.set(c.rms, c.frameStart);
    flux.set(c.flux, c.frameStart);
    centroid.set(c.centroid, c.frameStart);
    chroma.set(c.chroma, c.frameStart * 12);
    bands.set(c.bands, c.frameStart * BAND_COUNT);
  }
  const fps = p.sampleRate / p.hop;

  // Loudness in decibels, mapped onto this song's own range so quiet songs still breathe.
  const db = new Float32Array(F);
  for (let i = 0; i < F; i++) db[i] = 20 * Math.log10(rms[i] + 1e-7);
  const peak = percentile(db, 0.98);
  let floor = Math.max(peak - 42, percentile(db, 0.1) - 4);
  floor = Math.min(floor, peak - 12);
  const loud = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    const v = Math.min(1, Math.max(0, (db[i] - floor) / (peak - floor)));
    loud[i] = Math.pow(v, 1.3);
  }

  // Brightness: spectral centre of mass on a log scale (300 Hz → 0, 6 kHz → 1).
  const bright = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    const c = Math.max(1, centroid[i]);
    bright[i] = Math.min(1, Math.max(0, Math.log2(c / 300) / Math.log2(6000 / 300)));
  }

  // Onsets: spectral flux above its local average.
  const onset = new Float32Array(F);
  const W = Math.max(2, Math.round(0.4 * fps));
  const prefix = new Float64Array(F + 1);
  for (let i = 0; i < F; i++) prefix[i + 1] = prefix[i] + flux[i];
  for (let i = 0; i < F; i++) {
    const a = Math.max(0, i - W), b = Math.min(F, i + W + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    onset[i] = Math.max(0, flux[i] - 1.15 * mean);
  }
  const onsetScale = percentile(onset, 0.985) || 1e-6;
  for (let i = 0; i < F; i++) onset[i] = Math.min(1.5, onset[i] / onsetScale);

  // Tempo: the lag at which the onset curve best repeats itself.
  const mean = onset.reduce((s, v) => s + v, 0) / F;
  const maxLag = Math.min(F - 1, Math.ceil((60 / 40) * fps));
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1 && lag < F; lag++) {
    let s = 0;
    for (let i = 0; i + lag < F; i++) s += (onset[i] - mean) * (onset[i + lag] - mean);
    ac[lag] = s / (F - lag);
  }
  let bestLag = 0, bestScore = -Infinity;
  const minLag = Math.max(2, Math.floor((60 / 220) * fps));
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpmAt = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpmAt / 110) / 0.8) ** 2);
    const harmonic = 2 * lag <= maxLag ? 0.5 * ac[2 * lag] : 0;
    const score = (ac[lag] + harmonic) * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  let bpm = 100;
  // How strongly the onsets repeat at that lag, against their own variance (1 = perfectly periodic).
  const variance = onset.reduce((s, v) => s + (v - mean) ** 2, 0) / F;
  const tempoStrength = bestLag > 0 && variance > 1e-12 ? Math.max(0, ac[bestLag] / variance) : 0;
  if (bestLag > 0 && bestScore > 0) {
    const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
    bpm = (60 * fps) / (bestLag + shift);
  }

  // Key: correlate the song's average pitch-class content with every major and minor key.
  const avg = new Array(12).fill(0);
  for (let i = 0; i < F; i++) for (let pc = 0; pc < 12; pc++) avg[pc] += chroma[i * 12 + pc];
  let best: KeyEstimate = { tonic: 0, minor: false, name: 'C major', confidence: 0 };
  let second = -1;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const profile = minor ? KK_MINOR : KK_MAJOR;
      const rotated = avg.map((_, pc) => profile[(pc - tonic + 12) % 12]);
      const r = pearson(avg, rotated);
      if (r > best.confidence) {
        second = best.confidence;
        best = { tonic, minor, name: `${NOTE_NAMES[tonic]} ${minor ? 'minor' : 'major'}`, confidence: r };
      } else if (r > second) second = r;
    }
  }

  // Chroma per frame → proportions.
  for (let i = 0; i < F; i++) {
    let s = 0;
    for (let pc = 0; pc < 12; pc++) s += chroma[i * 12 + pc];
    if (s > 0) for (let pc = 0; pc < 12; pc++) chroma[i * 12 + pc] /= s;
  }

  // Each pitch range is scaled to its own loudest moments in this song, then
  // smoothed the way a level meter is: quick to rise, slow to fall.
  const column = new Float32Array(F);
  const rise = 1 - Math.exp(-1 / (0.03 * fps)), fall = 1 - Math.exp(-1 / (0.22 * fps));
  for (let k = 0; k < BAND_COUNT; k++) {
    for (let i = 0; i < F; i++) column[i] = bands[i * BAND_COUNT + k];
    const top = percentile(column, 0.97) || 1e-9;
    let level = 0;
    for (let i = 0; i < F; i++) {
      const v = Math.min(1.25, column[i] / top);
      level += (v - level) * (v > level ? rise : fall);
      bands[i * BAND_COUNT + k] = Math.pow(level, 0.85);
    }
  }

  // Fingerprint: FNV-1a hash of the measured loudness, brightness and pitch content.
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ F;
  const mix = (byte: number) => {
    h1 = Math.imul(h1 ^ byte, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((byte + 0x9e) & 0xff), 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  };
  for (let i = 0; i < F; i += 4) {
    let top = 0;
    for (let pc = 1; pc < 12; pc++) if (chroma[i * 12 + pc] > chroma[i * 12 + top]) top = pc;
    mix(Math.round(loud[i] * 31));
    mix(Math.round(bright[i] * 31));
    mix(top);
  }
  mix(F & 0xff); mix((F >> 8) & 0xff); mix(Math.round(bpm) & 0xff);
  const fingerprint = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).toUpperCase();

  // Outline of the whole song for the timeline.
  const arc = new Float32Array(ARC_POINTS), arcHue = new Float32Array(ARC_POINTS);
  const acc = new Float32Array(12);
  for (let a = 0; a < ARC_POINTS; a++) {
    const i0 = Math.floor((a * F) / ARC_POINTS);
    const i1 = Math.max(i0 + 1, Math.floor(((a + 1) * F) / ARC_POINTS));
    let m = 0;
    acc.fill(0);
    for (let i = i0; i < i1 && i < F; i++) {
      m = Math.max(m, loud[i]);
      for (let pc = 0; pc < 12; pc++) acc[pc] += chroma[i * 12 + pc] * loud[i];
    }
    arc[a] = m;
    arcHue[a] = chromaAngle(acc);
  }

  return {
    ...p, duration, loud, onset, bright, chroma, bands,
    bpm, beatPeriod: 60 / bpm, tempoStrength, key: best,
    fingerprint, seed: h1 ^ h2, arc, arcHue,
  };
}

/** Linear interpolation of the feature tracks at a time in seconds. */
export class FeatureSampler {
  readonly chroma = new Float32Array(12);
  readonly bands = new Float32Array(BAND_COUNT);
  loud = 0;
  onset = 0;
  bright = 0;
  constructor(private a: Analysis) {}
  at(time: number) {
    const a = this.a;
    if (time < 0 || time > a.duration) {
      this.loud = this.onset = 0;
      this.chroma.fill(0);
      this.bands.fill(0);
      return this;
    }
    const x = (time * a.sampleRate - a.fftSize / 2) / a.hop;
    const xi = Math.min(a.totalFrames - 1, Math.max(0, x));
    const i0 = Math.floor(xi), i1 = Math.min(a.totalFrames - 1, i0 + 1), f = xi - i0;
    this.loud = a.loud[i0] * (1 - f) + a.loud[i1] * f;
    this.onset = Math.max(a.onset[i0] * (1 - f), a.onset[i1] * f);
    this.bright = a.bright[i0] * (1 - f) + a.bright[i1] * f;
    for (let pc = 0; pc < 12; pc++)
      this.chroma[pc] = a.chroma[i0 * 12 + pc] * (1 - f) + a.chroma[i1 * 12 + pc] * f;
    for (let k = 0; k < BAND_COUNT; k++)
      this.bands[k] = a.bands[i0 * BAND_COUNT + k] * (1 - f) + a.bands[i1 * BAND_COUNT + k] * f;
    return this;
  }
}
