/**
 * Spreads the Fourier analysis over every CPU core, then joins the pieces.
 */
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
  const params: AnalysisParams = { sampleRate: sr, fftSize, hop, totalFrames: Math.max(1, Math.ceil(length / hop)) };

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
  return finalize(chunks, params, buffer.duration);
}
