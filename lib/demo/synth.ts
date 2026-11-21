/**
 * Built-in demo piece, "Low Tide".
 * Written as plain arithmetic (no audio nodes) so it is identical on every
 * device and can be rendered inside a worker. About 72 seconds:
 * quiet pad → pulse and arpeggio → full lift with kick → fade.
 */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

export const DEMO_TITLE = 'Low Tide';

export function renderDemo(sr = 44100): { left: Float32Array; right: Float32Array } {
  const BPM = 88, beat = 60 / BPM, bar = beat * 4;
  const BARS = 25;
  const total = Math.ceil((BARS * bar + 4) * sr);
  const dryL = new Float32Array(total), dryR = new Float32Array(total);
  const wetL = new Float32Array(total), wetR = new Float32Array(total);
  const rand = mulberry32(0x7151);
  const TAU = 2 * Math.PI;

  /** Add one note. `partials` = [frequency ratio, level] pairs. */
  function tone(
    t0: number, dur: number, freq: number, gain: number, pan: number, send: number,
    attack: number, release: number, decay: number, partials: number[][],
  ) {
    const i0 = Math.floor(t0 * sr), len = Math.floor((dur + release) * sr);
    const gl = gain * Math.cos((pan + 1) * 0.25 * Math.PI), gr = gain * Math.sin((pan + 1) * 0.25 * Math.PI);
    // One rotating phasor per partial: a sine wave without calling Math.sin per sample.
    const P = partials.length;
    const re = new Float64Array(P).fill(1), im = new Float64Array(P);
    const cr = new Float64Array(P), ci = new Float64Array(P), lv = new Float64Array(P);
    for (let k = 0; k < P; k++) {
      const w = (TAU * freq * partials[k][0]) / sr;
      cr[k] = Math.cos(w); ci[k] = Math.sin(w); lv[k] = partials[k][1];
    }
    const decayStep = decay > 0 ? Math.exp(-1 / (decay * sr)) : 1;
    let decayEnv = 1;
    for (let i = 0; i < len && i0 + i < total; i++) {
      const t = i / sr;
      let env = (t < attack ? t / attack : 1) * decayEnv;
      decayEnv *= decayStep;
      if (t > dur) env *= Math.max(0, 1 - (t - dur) / release) ** 2;
      let s = 0;
      for (let k = 0; k < P; k++) {
        s += lv[k] * im[k];
        const r = re[k] * cr[k] - im[k] * ci[k];
        im[k] = re[k] * ci[k] + im[k] * cr[k];
        re[k] = r;
      }
      s *= env;
      const j = i0 + i;
      dryL[j] += s * gl; dryR[j] += s * gr;
      wetL[j] += s * gl * send; wetR[j] += s * gr * send;
    }
  }

  function kick(t0: number, gain: number) {
    const i0 = Math.floor(t0 * sr), len = Math.floor(0.4 * sr);
    let phase = 0;
    for (let i = 0; i < len && i0 + i < total; i++) {
      const t = i / sr;
      const f = 46 + 90 * Math.exp(-t / 0.03);
      phase += (TAU * f) / sr;
      const s = Math.sin(phase) * Math.exp(-t / 0.12) * gain;
      dryL[i0 + i] += s; dryR[i0 + i] += s;
    }
  }

  function hat(t0: number, gain: number, pan: number) {
    const i0 = Math.floor(t0 * sr), len = Math.floor(0.06 * sr);
    let prev = 0;
    for (let i = 0; i < len && i0 + i < total; i++) {
      const n = rand() * 2 - 1;
      const hp = n - prev; // one-zero high-pass
      prev = n;
      const s = hp * Math.exp(-i / (0.012 * sr)) * gain;
      dryL[i0 + i] += s * (1 - pan) * 0.5; dryR[i0 + i] += s * (1 + pan) * 0.5;
      wetL[i0 + i] += s * 0.2; wetR[i0 + i] += s * 0.2;
    }
  }

  // Dm9 → B♭maj7 → Fmaj9 → C6/9
  const chords = [
    { root: 38, pad: [50, 57, 60, 65, 64 + 12], arp: [62, 65, 69, 72, 76, 72, 69, 65] },
    { root: 34, pad: [46, 53, 58, 62, 69], arp: [58, 62, 65, 69, 74, 69, 65, 62] },
    { root: 41, pad: [53, 57, 60, 64, 67], arp: [60, 65, 69, 72, 76, 72, 69, 67] },
    { root: 36, pad: [48, 55, 60, 64, 69], arp: [60, 64, 67, 69, 74, 69, 67, 64] },
  ];
  const PAD = [[1, 1], [2, 0.22], [3, 0.08]];
  const PLUCK = [[1, 1], [2, 0.35], [3, 0.12], [4, 0.05]];
  const BELL = [[1, 1], [2.76, 0.4], [5.4, 0.18]];
  const BASS = [[1, 1], [2, 0.3], [3, 0.1]];

  for (let b = 0; b < BARS; b++) {
    const t = b * bar, ch = chords[b % 4];
    const intro = b < 4, build = b >= 4 && b < 12, lift = b >= 12 && b < 20, outro = b >= 20;
    const padGain = intro ? 0.05 : build ? 0.06 : lift ? 0.075 : 0.05 * (1 - (b - 20) / 6);

    ch.pad.forEach((note, i) => {
      const pan = -0.7 + (1.4 * i) / (ch.pad.length - 1);
      const up = lift ? 12 * (i % 2) : 0;
      for (const detune of [-0.004, 0.004])
        tone(t, bar - 0.2, midi(note + up) * (1 + detune), padGain, pan, 0.5, 0.9, 1.6, 0, PAD);
    });

    if (build || lift) {
      const hits = build ? [0, 2] : [0, 1.5, 2, 3.5];
      for (const h of hits) tone(t + h * beat, beat * 0.8, midi(ch.root), build ? 0.2 : 0.26, 0, 0.05, 0.01, 0.2, 0.5, BASS);
    }
    if (build) {
      const level = 0.05 + 0.05 * ((b - 4) / 8);
      for (let s = 0; s < 8; s++)
        tone(t + s * beat * 0.5, 0.05, midi(ch.arp[s]), level, s % 2 ? 0.5 : -0.5, 0.45, 0.004, 0.5, 0.32, PLUCK);
    }
    if (lift) {
      for (let s = 0; s < 16; s++)
        tone(t + s * beat * 0.25, 0.04, midi(ch.arp[s % 8] + (s >= 8 ? 12 : 0)), 0.085, s % 2 ? 0.65 : -0.65, 0.4, 0.003, 0.4, 0.22, PLUCK);
      for (let k = 0; k < 4; k++) kick(t + k * beat, 0.5);
      for (let k = 0; k < 4; k++) hat(t + (k + 0.5) * beat, 0.07, k % 2 ? 0.4 : -0.4);
    }
    if (intro || outro || b % 2 === 1) {
      const count = intro || outro ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const note = ch.pad[Math.floor(rand() * ch.pad.length)] + 24;
        tone(t + rand() * (bar - 0.5), 0.1, midi(note), 0.04, rand() * 1.6 - 0.8, 0.8, 0.003, 2.2, 0.9, BELL);
      }
    }
  }
  // closing note
  tone(BARS * bar, 0.5, midi(50), 0.07, 0, 0.7, 0.4, 3, 0, PAD);
  tone(BARS * bar, 0.5, midi(57), 0.05, 0, 0.7, 0.4, 3, 0, PAD);

  // Reverb: four delay lines feeding each other (feedback delay network).
  const delays = [1423, 1777, 2137, 2557].map((d) => Math.round((d * sr) / 44100));
  const lines = delays.map((d) => new Float32Array(d));
  const idx = [0, 0, 0, 0], lp = [0, 0, 0, 0];
  const FEEDBACK = 0.86, DAMP = 0.35;
  const left = new Float32Array(total), right = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const o = [0, 0, 0, 0];
    let sum = 0;
    for (let k = 0; k < 4; k++) { o[k] = lines[k][idx[k]]; sum += o[k]; }
    for (let k = 0; k < 4; k++) {
      const input = (k % 2 ? wetR[i] : wetL[i]) + FEEDBACK * (o[k] - 0.5 * sum); // Householder mix
      lp[k] += (1 - DAMP) * (input - lp[k]);
      lines[k][idx[k]] = lp[k];
      idx[k] = (idx[k] + 1) % delays[k];
    }
    left[i] = dryL[i] + 0.55 * (o[0] + o[2]);
    right[i] = dryR[i] + 0.55 * (o[1] + o[3]);
  }

  // Gentle limiter and normalise.
  let peak = 0;
  for (let i = 0; i < total; i++) {
    left[i] = Math.tanh(left[i] * 1.4); right[i] = Math.tanh(right[i] * 1.4);
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const g = 0.89 / (peak || 1);
  const fade = Math.floor(0.05 * sr);
  for (let i = 0; i < total; i++) {
    const edge = Math.min(1, i / fade, (total - 1 - i) / fade);
    left[i] *= g * edge; right[i] *= g * edge;
  }
  return { left, right };
}
