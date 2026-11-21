/// <reference lib="webworker" />
import { analyzeChunk } from './dsp';
import { renderDemo } from '../demo/synth';
import type { WorkerRequest, WorkerResponse } from './types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'analyze') {
    const features = analyzeChunk(msg.samples, msg.offset, msg.frameStart, msg.frameEnd, msg.params);
    const reply: WorkerResponse = { type: 'analyze', id: msg.id, features };
    ctx.postMessage(reply, [
      features.rms.buffer, features.flux.buffer, features.centroid.buffer,
      features.chroma.buffer, features.bands.buffer,
    ]);
  } else if (msg.type === 'demo') {
    const { left, right } = renderDemo(msg.sampleRate);
    const reply: WorkerResponse = { type: 'demo', id: msg.id, left, right };
    ctx.postMessage(reply, [left.buffer, right.buffer]);
  }
};
