/**
 * Colour from sound, by physics and by what listeners report.
 *
 * Hue: a note is raised by octaves (doubling its frequency, about 40 times) until it
 * lands in the octave of visible light, 400–800 THz. Its wavelength then gives a spectral
 * colour. Visible light spans a little less than one octave, so each of the twelve notes
 * gets its own colour, and the gap left at the ends (just past violet and just past red)
 * is closed with the purples, as on Newton's colour circle. C is green, D blue, E violet,
 * F♯ magenta-red, G red, A orange, B yellow-green.
 *
 * Lightness, saturation and mood follow cross-modal studies (see README):
 * louder → more saturated (Anikin & Johansson 2019), higher pitch → lighter (Marks 1974),
 * low register → more saturated, brighter timbre (spectral centroid) → lighter
 * (Schubert & Wolfe 2006), fast major music → lighter, more saturated and yellower, slow
 * minor music → darker and bluer (Palmer, Schloss et al., PNAS 2013).
 */
import { oklch } from './color';

const C4 = 261.6256;
const SPEED_OF_LIGHT = 299792458;
/** The visible stretch used for spectral colours; beyond it the purples close the circle. */
const VIOLET_NM = 420;
const RED_NM = 680;

// CIE 1931 colour-matching functions, analytic fit (Wyman, Sloan & Shirley 2013).
const lobe = (x: number, m: number, s1: number, s2: number) => {
  const t = (x - m) / (x < m ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};
function spectralXyz(nm: number): [number, number, number] {
  return [
    1.056 * lobe(nm, 599.8, 37.9, 31) + 0.362 * lobe(nm, 442, 16, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2),
    0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1),
    1.217 * lobe(nm, 437, 11.8, 36) + 0.681 * lobe(nm, 459, 26, 13.8),
  ];
}
/** OKLab hue (turns) of a CIE XYZ colour. */
function xyzHue([X, Y, Z]: [number, number, number]): number {
  const l = Math.cbrt(0.8189330101 * X + 0.3618667424 * Y - 0.1288597137 * Z);
  const m = Math.cbrt(0.0329845436 * X + 0.9293118715 * Y + 0.0361456387 * Z);
  const s = Math.cbrt(0.0482003018 * X + 0.2643662691 * Y + 0.633851707 * Z);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = Math.atan2(b, a) / (2 * Math.PI);
  return h < 0 ? h + 1 : h;
}

const fVioletEdge = SPEED_OF_LIGHT / (VIOLET_NM * 1e-9);
const fRedEdge = SPEED_OF_LIGHT / (RED_NM * 1e-9);
const hueViolet = xyzHue(spectralXyz(VIOLET_NM));
const hueRed = xyzHue(spectralXyz(RED_NM));

/** OKLCH hue (turns) of a sound frequency, raised by octaves into visible light. */
export function frequencyHue(hz: number): number {
  let f = hz;
  while (f < fRedEdge) f *= 2;
  while (f >= 2 * fRedEdge) f /= 2;
  if (f <= fVioletEdge) return xyzHue(spectralXyz((SPEED_OF_LIGHT / f) * 1e9));
  // Past violet: through the purples and magenta, back round to red.
  const t = (f - fVioletEdge) / (2 * fRedEdge - fVioletEdge);
  const span = ((hueRed - hueViolet) % 1 + 1) % 1;
  return (hueViolet + t * span) % 1;
}

/**
 * Hue of each pitch class (C = 0), from physics: the light of the note's actual frequency in this
 * recording. A recording tuned sharp or flat of A4 = 440 Hz (A = 432, 442, a tape running fast...)
 * sounds at different frequencies, so its notes give slightly different light: see setTuning.
 */
export const NOTE_HUES = Float32Array.from({ length: 12 }, (_, pc) => frequencyHue(C4 * 2 ** (pc / 12)));
let tuningCents = 0;
/** Sets the recording's tuning (cents from A4 = 440 Hz); every note's light follows its real frequency. */
export function setTuning(cents: number) {
  const c = Number.isFinite(cents) ? Math.max(-50, Math.min(50, cents)) : 0;
  if (c === tuningCents) return;
  tuningCents = c;
  for (let pc = 0; pc < 12; pc++) NOTE_HUES[pc] = frequencyHue(C4 * 2 ** ((pc + c / 100) / 12));
}

/** Hue of the notes sounding (weights per pitch class), and how clearly one colour dominates (0..1). */
export function notesHue(weights: ArrayLike<number>): { hue: number; clarity: number } {
  let x = 0, y = 0, sum = 0;
  for (let pc = 0; pc < 12; pc++) {
    const a = NOTE_HUES[pc] * 2 * Math.PI;
    x += weights[pc] * Math.cos(a);
    y += weights[pc] * Math.sin(a);
    sum += weights[pc];
  }
  const h = Math.atan2(y, x) / (2 * Math.PI);
  return { hue: h < 0 ? h + 1 : h, clarity: sum > 1e-9 ? Math.hypot(x, y) / sum : 0 };
}

/** Moves hue `a` toward hue `b` by `t`, the short way round the circle. */
export function mixHue(a: number, b: number, t: number): number {
  const d = (((b - a) % 1) + 1.5) % 1 - 0.5;
  return (a + d * t + 1) % 1;
}

function inGamut(L: number, C: number, h: number): boolean {
  const h2 = h * 2 * Math.PI, a = C * Math.cos(h2), b = C * Math.sin(h2);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const e = 1e-4;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && bl >= -e && bl <= 1 + e;
}

// Most saturated colour the screen can show, per lightness and hue (sRGB).
const GL = 41, GH = 72;
const gamut = new Float32Array(GL * GH);
for (let i = 0; i < GL; i++) {
  for (let j = 0; j < GH; j++) {
    let lo = 0, hi = 0.4;
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (inGamut(i / (GL - 1), mid, j / GH)) lo = mid; else hi = mid;
    }
    gamut[i * GH + j] = lo;
  }
}
export function maxChroma(L: number, h: number): number {
  const x = Math.min(1, Math.max(0, L)) * (GL - 1), y = ((h % 1) + 1) % 1 * GH;
  const i0 = Math.floor(x), i1 = Math.min(GL - 1, i0 + 1), fx = x - i0;
  const j0 = Math.floor(y) % GH, j1 = (j0 + 1) % GH, fy = y - Math.floor(y);
  const v = (i: number, j: number) => gamut[i * GH + j];
  return (v(i0, j0) * (1 - fy) + v(i0, j1) * fy) * (1 - fx) + (v(i1, j0) * (1 - fy) + v(i1, j1) * fy) * fx;
}

// Lightness at which each hue reaches its most vivid colour (blue is darkest there, yellow lightest).
const cusp = new Float32Array(GH);
for (let j = 0; j < GH; j++) {
  let best = 0;
  for (let i = 0; i < GL; i++) if (gamut[i * GH + j] > gamut[best * GH + j]) best = i;
  cusp[j] = best / (GL - 1);
}
function cuspL(h: number): number {
  const y = (((h % 1) + 1) % 1) * GH, j0 = Math.floor(y) % GH, f = y - Math.floor(y);
  return cusp[j0] * (1 - f) + cusp[(j0 + 1) % GH] * f;
}

/**
 * A colour near lightness `L` and hue `h`, `sat` of the way (0..1) to the most vivid the screen can show.
 * Lightness is drawn halfway toward the hue's most vivid point, so blues and violets stay rich.
 */
export function vivid(L: number, h: number, sat: number): [number, number, number] {
  const Lv = L + (cuspL(h) - L) * 0.5;
  return oklch(Lv, maxChroma(Lv, h) * Math.min(1, Math.max(0, sat)) * 0.97, h);
}

/**
 * Emotional tone from mode and tempo, −1 (slow, minor) … +1 (fast, major), after Palmer et al. 2013.
 */
export function valence(minor: boolean, bpm: number): number {
  const tempo = Math.max(-0.6, Math.min(0.6, (bpm - 100) / 60));
  return Math.max(-1, Math.min(1, (minor ? -0.4 : 0.4) + tempo));
}

/** OKLCH hues listeners pick for happy (yellow) and sad (blue) music. */
export const YELLOW_HUE = 0.3;
export const BLUE_HUE = 0.73;

/** Intervals above the key note that colour the ribbons, bass first: root, fifth, third, seventh. */
export function chordTones(tonic: number, minor: boolean): number[] {
  return [0, 7, minor ? 3 : 4, minor ? 10 : 11].map((i) => (tonic + i) % 12);
}
