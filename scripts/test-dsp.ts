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

// The recording's decay (sets how long the light lingers), as the renderer measures it.
{
  const fs = a.hop / a.sampleRate, L = a.loud, O = a.onset, F = a.totalFrames;
  const decays: number[] = [];
  for (let f = 1; f < F - 1; f++) {
    if (O[f] < 0.3 || O[f] < O[f - 1] || O[f] < O[f + 1]) continue;
    let pk = f;
    for (let g = f; g < Math.min(F, f + Math.round(0.08 / fs)); g++) if (L[g] > L[pk]) pk = g;
    if (L[pk] < 0.15) continue;
    let g = pk;
    const stop = Math.min(F, pk + Math.round(3 / fs));
    while (g < stop && L[g] > 0.5 * L[pk] && !(g > pk + 2 && O[g] > 0.3)) g++;
    if (g < stop && L[g] <= 0.5 * L[pk]) decays.push((g - pk) * fs);
  }
  decays.sort((x, y) => x - y);
  const d = decays.length >= 4 ? decays[decays.length >> 1] : 0.3;
  console.log('decay events', decays.length, 'median', d.toFixed(2), 's -> trail', Math.min(0.2, Math.max(0.04, 0.035 + 0.12 * d)).toFixed(3), 's');
}

// Tuning: pure tones (with two harmonics) at known frequencies must read back their offset from A4 = 440 Hz.
import('../lib/analysis/analyze').then(({ estimateTuning }) => {
  for (const hz of [440, 432, 445, 261.6256 * 2 ** (-0.2 / 12)]) {
    const sr = 44100, x = new Float32Array(sr * 6);
    for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = 0.5 * Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(4 * Math.PI * hz * t) + 0.1 * Math.sin(6 * Math.PI * hz * t); }
    const want = ((1200 * Math.log2(hz / 440)) % 100 + 150) % 100 - 50;
    console.log(`tuning ${hz.toFixed(2)} Hz -> ${estimateTuning(x, sr).toFixed(1)} cents (expected ${want.toFixed(1)})`);
  }
  console.log('demo tuning', estimateTuning(mono, 44100).toFixed(1), 'cents');
});
