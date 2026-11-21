import { renderDemo } from '../lib/demo/synth';
import { analyzeChunk } from '../lib/analysis/dsp';
import { finalize, FeatureSampler } from '../lib/analysis/finalize';

let t0 = Date.now();
const { left, right } = renderDemo(44100);
console.log('demo ms', Date.now() - t0, 'sec', left.length / 44100);
const mono = new Float32Array(left.length);
for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (left[i] + right[i]);
const p = { sampleRate: 44100, fftSize: 4096, hop: 1024, totalFrames: Math.ceil(mono.length / 1024) };
t0 = Date.now();
// two chunks, to prove chunk boundaries are seamless
const half = Math.floor(p.totalFrames / 2);
const whole = analyzeChunk(mono, 0, 0, p.totalFrames, p);
const off = (half - 1) * p.hop;
const c1 = analyzeChunk(mono.subarray(0, half * p.hop + p.fftSize), 0, 0, half, p);
const c2 = analyzeChunk(mono.subarray(off), off, half, p.totalFrames, p);
let maxDiff = 0;
for (let i = 0; i < c2.frames; i++) maxDiff = Math.max(maxDiff, Math.abs(c2.flux[i] - whole.flux[half + i]), Math.abs(c2.rms[i] - whole.rms[half + i]));
console.log('analysis ms', Date.now() - t0, 'chunk seam diff', maxDiff);
const a = finalize([c1, c2], p, mono.length / 44100);
console.log('bpm', a.bpm.toFixed(2), 'key', a.key.name, a.key.confidence.toFixed(2), 'fp', a.fingerprint);
const s = new FeatureSampler(a);
for (const t of [2, 8, 15, 25, 36, 45, 52, 60, 68]) {
  s.at(t);
  console.log(`t=${t} loud=${s.loud.toFixed(2)} onset=${s.onset.toFixed(2)} bands=${Array.from(s.bands).map((v) => v.toFixed(2)).join(' ')}`);
}

// Sections: where the music changes, and the design chosen for each.
import('../lib/analysis/sections').then(({ planSections, DESIGN_NAMES }) => {
  t0 = Date.now();
  const plan = planSections(a);
  console.log('sections ms', Date.now() - t0);
  for (const s of plan) {
    const st = Object.entries(s.stats).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
    console.log(`${s.start.toFixed(1).padStart(5)}–${s.end.toFixed(1).padStart(5)}s  ${DESIGN_NAMES[s.design].padEnd(16)} ${st}`);
  }
});
