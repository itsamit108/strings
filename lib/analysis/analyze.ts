/**
 * Spreads the Fourier analysis over every CPU core, then joins the pieces.
 */
import { FFT } from './dsp';
import { setTuning } from '../render/lightmusic';
import { finalize } from './finalize';
import type { Analysis, AnalysisParams, ChunkFeatures, WorkerRequest, WorkerResponse } from './types';

const spawn = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

function ask<T extends WorkerResponse>(worker: Worker, msg: WorkerRequest, transfer: Transferable[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<T>) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message || 'The analysis worker stopped.'));
    worker.postMessage(msg, transfer);
  });
}

export async function synthesizeDemo(sampleRate: number): Promise<{ left: Float32Array; right: Float32Array }> {
  const worker = spawn();
  try {
    const r = await ask<Extract<WorkerResponse, { type: 'demo' }>>(worker, { type: 'demo', id: 0, sampleRate });
    return { left: r.left, right: r.right };
  } finally {
    worker.terminate();
  }
}

/**
 * The recording's tuning: how far its notes sit from the A4 = 440 Hz grid, in cents. Spectral peaks
 * (sharpened by parabolic interpolation) from frames across the song each give their offset from the
 * nearest semitone; the offsets are averaged round a circle (a 100-cent cycle), weighted by strength.
 */
export function estimateTuning(mono: Float32Array, sr: number): number {
  const n = 8192, fft = new FFT(n), re = new Float32Array(n), im = new Float32Array(n);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const frames = Math.min(80, Math.floor(mono.length / n));
  const binHz = sr / n, lo = Math.ceil(80 / binHz), hi = Math.min(n / 2 - 2, Math.floor(2000 / binHz));
  const mag = new Float32Array(n / 2);
  let x = 0, y = 0;
  for (let k = 0; k < frames; k++) {
    const start = Math.floor(((k + 0.5) / frames) * (mono.length - n));
    let energy = 0;
    for (let i = 0; i < n; i++) { const v = mono[start + i]; re[i] = v * win[i]; energy += v * v; }
    if (energy / n < 1e-6) continue;
    fft.run(re, im);
    let top = 0;
    for (let b = lo - 1; b <= hi + 1; b++) { mag[b] = Math.hypot(re[b], im[b]); if (mag[b] > top) top = mag[b]; }
    for (let b = lo; b <= hi; b++) {
      const m = mag[b];
      if (m < 0.15 * top || m < mag[b - 1] || m < mag[b + 1]) continue;
      const a = Math.log(mag[b - 1] + 1e-12), c = Math.log(m + 1e-12), d = Math.log(mag[b + 1] + 1e-12);
      const shift = (0.5 * (a - d)) / (a - 2 * c + d || 1e-12);
      const f = (b + Math.max(-0.5, Math.min(0.5, shift))) * binHz;
      const cents = 1200 * Math.log2(f / 440);
      const ang = (2 * Math.PI * cents) / 100;
      x += m * Math.cos(ang); y += m * Math.sin(ang);
    }
  }
  if (Math.hypot(x, y) < 1e-9) return 0;
  return (Math.atan2(y, x) / (2 * Math.PI)) * 100;
}

export async function analyzeAudio(buffer: AudioBuffer, onProgress?: (fraction: number) => void): Promise<Analysis> {
  const length = buffer.length, sr = buffer.sampleRate;
  // Mono mix for analysis. The renderer still reads the original stereo samples.
  const mono = new Float32Array(length);
  const chans = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / chans;
  }
  const fftSize = sr >= 32000 ? 4096 : 2048;
  const hop = fftSize / 4;
  const tuning = estimateTuning(mono, sr);
  const params: AnalysisParams = { sampleRate: sr, fftSize, hop, totalFrames: Math.max(1, Math.ceil(length / hop)), refHz: 440 * 2 ** (tuning / 1200) };
  setTuning(tuning);

  const cores = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 1));
  // Small jobs keep the progress bar moving and let fast cores take more of them.
  const jobFrames = Math.max(256, Math.ceil(params.totalFrames / (cores * 6)));
  const jobs: { frameStart: number; frameEnd: number }[] = [];
  for (let f = 0; f < params.totalFrames; f += jobFrames)
    jobs.push({ frameStart: f, frameEnd: Math.min(params.totalFrames, f + jobFrames) });

  const workers = Array.from({ length: Math.min(cores, jobs.length) }, spawn);
  const chunks: ChunkFeatures[] = [];
  let next = 0, done = 0;
  try {
    await Promise.all(
      workers.map(async (worker) => {
        while (next < jobs.length) {
          const id = next++;
          const { frameStart, frameEnd } = jobs[id];
          const from = Math.max(0, (frameStart - 1) * hop);
          const to = Math.min(length, (frameEnd - 1) * hop + fftSize);
          const samples = mono.slice(from, to);
          const r = await ask<Extract<WorkerResponse, { type: 'analyze' }>>(
            worker,
            { type: 'analyze', id, samples, offset: from, frameStart, frameEnd, params },
            [samples.buffer],
          );
          chunks.push(r.features);
          onProgress?.(++done / jobs.length);
        }
      }),
    );
  } finally {
    workers.forEach((w) => w.terminate());
  }
  const result = finalize(chunks, params, buffer.duration);
  result.tuning = tuning;
  // Stereo balance: the share of each frame's energy in the right channel against the left.
  if (buffer.numberOfChannels >= 2) {
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    const pan = new Float32Array(params.totalFrames);
    for (let f = 0; f < params.totalFrames; f++) {
      let el = 0, er = 0;
      const end = Math.min(length, (f + 1) * hop);
      for (let i = f * hop; i < end; i++) { el += L[i] * L[i]; er += R[i] * R[i]; }
      pan[f] = el + er > 1e-9 ? (er - el) / (er + el) : 0;
    }
    result.pan = pan;
  }
  return result;
}
