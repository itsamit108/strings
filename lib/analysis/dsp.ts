/**
 * Signal processing that runs inside the workers. Pure functions, no DOM.
 * Short-time Fourier transform → per-frame physical measurements.
 */
import { BAND_COUNT, BAND_HIGH_HZ, BAND_LOW_HZ, type AnalysisParams, type ChunkFeatures } from './types';

class FFT {
  private rev: Uint32Array;
  private cos: Float32Array;
  private sin: Float32Array;
  constructor(public n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  /** In-place forward transform. */
  run(re: Float32Array, im: Float32Array) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const t = re[i]; re[i] = re[j]; re[j] = t;
      }
    }
    im.fill(0);
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const c = this.cos[t], s = this.sin[t];
          const a = start + k, b = a + half;
          const xr = re[b] * c + im[b] * s;
          const xi = im[b] * c - re[b] * s;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

interface Tables {
  key: string;
  fft: FFT;
  window: Float32Array;
  /** pitch class per bin, −1 = unused */
  pitchClass: Int8Array;
  /** pitch range per bin, −1 = unused */
  bandOf: Int8Array;
  tilt: Float32Array;
}

let tables: Tables | null = null;

function getTables(p: AnalysisParams): Tables {
  const key = `${p.sampleRate}:${p.fftSize}`;
  if (tables && tables.key === key) return tables;
  const n = p.fftSize, bins = n / 2;
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); // Hann
  const binHz = p.sampleRate / n;

  const pitchClass = new Int8Array(bins).fill(-1);
  for (let b = 1; b < bins; b++) {
    const f = b * binHz;
    if (f < 160 || f > 4200) continue;
    const midi = Math.round(69 + 12 * Math.log2(f / 440));
    pitchClass[b] = ((midi % 12) + 12) % 12;
  }

  // Pitch ranges are equal steps on a log-frequency scale, the way pitch is heard.
  const bandOf = new Int8Array(bins).fill(-1);
  const octaves = Math.log2(BAND_HIGH_HZ / BAND_LOW_HZ);
  for (let b = 1; b < bins; b++) {
    const f = b * binHz;
    if (f < BAND_LOW_HZ || f >= BAND_HIGH_HZ) continue;
    bandOf[b] = Math.min(BAND_COUNT - 1, Math.floor((Math.log2(f / BAND_LOW_HZ) / octaves) * BAND_COUNT));
  }

  // Music carries less power at high frequencies (roughly pink). A +3 dB per
  // octave tilt lets the high ranges take part instead of being drowned by bass.
  const tilt = new Float32Array(bins);
  for (let b = 0; b < bins; b++) tilt[b] = Math.max(1, b * binHz) / 1000;

  tables = { key, fft: new FFT(n), window, pitchClass, bandOf, tilt };
  return tables;
}

export function analyzeChunk(
  samples: Float32Array,
  offset: number,
  frameStart: number,
  frameEnd: number,
  p: AnalysisParams,
): ChunkFeatures {
  const t = getTables(p);
  const n = p.fftSize, bins = n / 2, hop = p.hop;
  const frames = frameEnd - frameStart;
  const out: ChunkFeatures = {
    frameStart,
    frames,
    rms: new Float32Array(frames),
    flux: new Float32Array(frames),
    centroid: new Float32Array(frames),
    chroma: new Float32Array(frames * 12),
    bands: new Float32Array(frames * BAND_COUNT),
  };
  const re = new Float32Array(n), im = new Float32Array(n);
  const power = new Float32Array(bins);
  const logMag = new Float32Array(bins), prevLog = new Float32Array(bins);
  const binHz = p.sampleRate / n;
  let havePrev = false;

  // Start one frame early so the first frame has a "previous spectrum" to compare with.
  for (let f = Math.max(0, frameStart - 1); f < frameEnd; f++) {
    const base = f * hop - offset;
    let sq = 0;
    for (let i = 0; i < n; i++) {
      const j = base + i;
      const s = j >= 0 && j < samples.length ? samples[j] : 0;
      sq += s * s;
      re[i] = s * t.window[i];
    }
    t.fft.run(re, im);
    let fluxSum = 0, num = 0, den = 0;
    for (let b = 1; b < bins; b++) {
      const pw = re[b] * re[b] + im[b] * im[b];
      power[b] = pw;
      const mag = Math.sqrt(pw);
      const lm = Math.log(1 + 0.25 * mag);
      const d = lm - prevLog[b];
      if (d > 0) fluxSum += d;
      logMag[b] = lm;
      num += mag * b;
      den += mag;
    }
    prevLog.set(logMag);
    if (f >= frameStart) {
      const o = f - frameStart;
      out.rms[o] = Math.sqrt(sq / n);
      out.flux[o] = havePrev ? fluxSum / bins : 0;
      out.centroid[o] = den > 1e-9 ? (num / den) * binHz : 0;
      const c = o * 12;
      for (let b = 1; b < bins; b++) {
        const pc = t.pitchClass[b];
        if (pc >= 0) out.chroma[c + pc] += power[b];
      }
      const bo = o * BAND_COUNT;
      for (let b = 1; b < bins; b++) {
        const band = t.bandOf[b];
        if (band >= 0) out.bands[bo + band] += power[b] * t.tilt[b];
      }
      for (let k = 0; k < BAND_COUNT; k++) out.bands[bo + k] = Math.sqrt(out.bands[bo + k]);
    }
    havePrev = true;
  }
  return out;
}
