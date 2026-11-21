/**
 * WebGL2 renderer. Each design is one fragment shader that reads the last
 * four seconds of the song from a small texture. Light is kept in an HDR
 * buffer so moving lines leave a short soft trail, and the glow is that same
 * light read back blurred.
 */
import type { Analysis } from '../analysis/types';
import { BAND_COUNT } from '../analysis/types';
import { FeatureSampler, fifthsAngle } from '../analysis/finalize';
import { oklch } from './color';
import { BLUE_HUE, chordTones, mixHue, NOTE_HUES, notesHue, valence, vivid, YELLOW_HUE } from './lightmusic';
import * as S from './shaders';

export type Scene = 'ribbons' | 'rings';

/** Internal resolution steps, used only if the device cannot hold its frame rate. */
const SCALES = [0.5, 0.67, 0.8, 1];
const TRAIL = 0.07; // seconds a line's light lingers
const SHAPE_W = 128;
const SHAPE_H = 48;
/** Waves across the screen for each ribbon: long for bass, short for treble. */
const RIBBON_CYCLES = [0.8, 1.15, 1.6, 2.2];
const RIBBON_SPEED = [0.55, 0.75, 1.0, 1.3];

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Program { p: WebGLProgram; u: Uniforms }

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class PlateRenderer {
  private gl!: WebGL2RenderingContext;
  private prog!: Record<'ribbons' | 'rings' | 'fade' | 'present', Program>;
  private vao!: WebGLVertexArrayObject;
  private histTex!: WebGLTexture;
  private shapeTex!: WebGLTexture;
  private accum: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null = null;
  private width = 2;
  private height = 2;
  private askedW = 2;
  private askedH = 2;
  private scaleIndex = SCALES.length - 1;

  /** which design to draw */
  scene: Scene = 'ribbons';
  /** vertical shift of the picture's centre, as a fraction of the height (+ = up) */
  centerOffset = 0;
  /** keep the ribbons together in a narrow band (used behind the first screen's text) */
  compact = false;
  /** stop adapting the resolution (used during export) */
  governorPaused = false;

  private analysis: Analysis | null = null;
  private sampler: FeatureSampler | null = null;
  /** running total of "how much the music has moved" up to each analysis frame */
  private motion = new Float32Array(1);
  private seedPhase = new Float32Array(S.RIBBONS);

  private hist = new Float32Array(S.HIST_W * S.HIST_ROWS * 4);
  private shape = new Float32Array(SHAPE_W * SHAPE_H);
  /** how much each of the 12 notes pulls a ring at each angle (notes sit on the circle of fifths) */
  private lobes = (() => {
    const t = new Float32Array(12 * SHAPE_H);
    for (let pc = 0; pc < 12; pc++)
      for (let j = 0; j < SHAPE_H; j++) {
        const x = 2 * Math.PI * (j / SHAPE_H - fifthsAngle(pc));
        t[pc * SHAPE_H + j] = Math.pow(0.5 + 0.5 * Math.cos(x), 1.5);
      }
    return t;
  })();

  // smoothed state that follows the music
  private chroma = new Float32Array(12);
  private slowChroma = new Float32Array(12);
  private sharp = new Float32Array(12);
  private energy = 0;
  private kick = 0;
  private live = 0;
  /** timbral brightness (spectral centroid), smoothed */
  private brightness = 0.5;
  /** each ribbon's hue, drifting toward the notes sounding */
  private ribbonHue = new Float32Array(S.RIBBONS).fill(Number.NaN);
  private idleClock = 0;

  private dtSum = 0;
  private dtCount = 0;
  private baseline = 1 / 60;
  private lost = false;

  constructor(private canvas: HTMLCanvasElement) {
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.setup();
    this.seed(0x5eed);
  }

  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private onRestored = () => { this.lost = false; this.accum = null; this.setup(); };

  private setup() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('This browser has no WebGL2, which the picture needs.');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
      throw new Error('This device cannot draw high-range light, which the picture needs.');

    const mk = (fs: string): Program => {
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
          throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(sh));
        return sh;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, S.FULLSCREEN_VS));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error('Shader failed to link: ' + gl.getProgramInfoLog(p));
      const u: Uniforms = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i)!;
        u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
      }
      return { p, u };
    };
    this.prog = { ribbons: mk(S.RIBBONS_FS), rings: mk(S.RINGS_FS), fade: mk(S.FADE_FS), present: mk(S.PRESENT_FS) };
    this.vao = gl.createVertexArray()!;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    const smooth = (wrapT: number) => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
    };
    this.histTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.histTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, S.HIST_W, S.HIST_ROWS, 0, gl.RGBA, gl.FLOAT, this.hist);
    smooth(gl.CLAMP_TO_EDGE);
    this.shapeTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.shapeTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, SHAPE_W, SHAPE_H, 0, gl.RED, gl.FLOAT, this.shape);
    smooth(gl.REPEAT); // the angle wraps around the circle

    this.resize(this.askedW, this.askedH, true);
  }

  /** Start from the state that belongs to this song's fingerprint. */
  seed(seed: number) {
    for (let k = 0; k < S.RIBBONS; k++) this.seedPhase[k] = 2 * Math.PI * hash01((seed >>> 0) + k * 7919);
    this.chroma.fill(0);
    this.energy = this.kick = 0;
    this.brightness = 0.5;
    this.ribbonHue.fill(Number.NaN);
    if (this.accum && !this.lost) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** `w`, `h` are the size asked for; the drawing size may be lower on slow devices. */
  resize(w: number, h: number, force = false) {
    this.askedW = w;
    this.askedH = h;
    const k = this.governorPaused ? 1 : SCALES[this.scaleIndex];
    w = Math.max(2, Math.round(w * k));
    h = Math.max(2, Math.round(h * k));
    if (!force && w === this.width && h === this.height && this.accum) return;
    this.width = w;
    this.height = h;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (this.lost) return;
    const gl = this.gl;
    if (this.accum) { gl.deleteTexture(this.accum.tex); gl.deleteFramebuffer(this.accum.fbo); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA16F, w, h);
    // The glow is the same light read from smaller, blurrier copies of itself.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('This device could not create the light buffer.');
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.accum = { tex, fbo };
  }

  setSong(analysis: Analysis | null) {
    this.analysis = analysis;
    this.sampler = analysis ? new FeatureSampler(analysis) : null;
    if (analysis) {
      // The waves travel faster through loud passages and almost rest in quiet ones.
      const frameSeconds = analysis.hop / analysis.sampleRate;
      this.motion = new Float32Array(analysis.totalFrames + 1);
      for (let i = 0; i < analysis.totalFrames; i++)
        this.motion[i + 1] = this.motion[i] + (0.25 + 1.3 * analysis.loud[i]) * frameSeconds;
    }
    this.seed(analysis?.seed ?? 0x5eed);
  }

  private motionAt(time: number): number {
    const a = this.analysis;
    if (!a) return this.idleClock * 0.5;
    const x = Math.min(a.totalFrames, Math.max(0, (time * a.sampleRate) / a.hop));
    const i = Math.min(a.totalFrames - 1, Math.floor(x));
    return this.motion[i] + (this.motion[i + 1] - this.motion[i]) * (x - i);
  }

  private govern(wallDt: number) {
    if (this.governorPaused || wallDt > 0.1 || wallDt <= 0) return;
    this.dtSum += wallDt;
    if (++this.dtCount < 120) return;
    const avg = this.dtSum / this.dtCount;
    this.dtSum = this.dtCount = 0;
    this.baseline = Math.min(this.baseline, avg);
    if (avg > 1.5 * Math.max(this.baseline, 1 / 120) && avg > 1 / 50 && this.scaleIndex > 0) {
      this.scaleIndex--;
      this.resize(this.askedW, this.askedH);
    }
  }

  /**
   * Write the last four seconds of the song into the textures the shaders read.
   * Column 0 is now; the last column is four seconds ago.
   * Rows 0–7: level of each pitch range. Row 8: note colour and loudness. Row 9: hits.
   */
  private readHistory(time: number, keyColour: number[]) {
    const h = this.hist, s = this.sampler, W = S.HIST_W;
    const row = (r: number, i: number) => (r * W + i) * 4;
    const sc = this.slowChroma.fill(0);
    for (let i = W - 1; i >= 0; i--) { // oldest first, so notes can be smoothed forward in time
      const age = ((i + 0.5) / W) * S.HISTORY_SECONDS;
      let loud = 0, hit = 0, colour = keyColour;
      if (s) {
        s.at(time - age);
        loud = s.loud;
        hit = s.onset * Math.sqrt(s.loud);
        for (let k = 0; k < BAND_COUNT; k++) h[row(k, i)] = s.bands[k];
        // Notes change quickly; colour and shape follow them over about a fifth of a second.
        for (let pc = 0; pc < 12; pc++) sc[pc] += (s.chroma[pc] - sc[pc]) * 0.08;
        if (loud > 0.02) {
          // The strongest notes decide the colour (fourth power, so they are not averaged away).
          for (let pc = 0; pc < 12; pc++) this.sharp[pc] = sc[pc] ** 4;
          // Hue from the notes (physics); louder → more saturated, brighter timbre → lighter.
          colour = vivid(0.72 + 0.08 * (s.bright - 0.5), notesHue(this.sharp).hue, 0.78 + 0.22 * Math.min(1, loud));
        }
        if ((i & 1) === 0) {
          // Shape of the ring that left the centre at this moment.
          const col = i >> 1, pull = Math.min(1, loud * 1.4) * 2.2;
          let mean = 0;
          for (let j = 0; j < SHAPE_H; j++) {
            let v = 0;
            for (let pc = 0; pc < 12; pc++) v += sc[pc] * this.lobes[pc * SHAPE_H + j];
            this.shape[j * SHAPE_W + col] = v;
            mean += v / SHAPE_H;
          }
          for (let j = 0; j < SHAPE_H; j++)
            this.shape[j * SHAPE_W + col] = Math.max(-1, Math.min(1, (this.shape[j * SHAPE_W + col] - mean) * pull));
        }
      } else {
        // No song yet: slow, quiet waves for the first screen.
        loud = 0.5;
        for (let k = 0; k < BAND_COUNT; k++)
          h[row(k, i)] = 0.34 + 0.22 * Math.sin(this.idleClock * 0.45 + k * 1.3 - age * 1.1);
      }
      const c = row(8, i);
      h[c] = colour[0]; h[c + 1] = colour[1]; h[c + 2] = colour[2]; h[c + 3] = loud;
      h[row(9, i)] = hit;
    }
    // Ribbons should swell and settle, not jitter: smooth each pitch range over about a third of a second.
    const soft = 1 / 14;
    for (let k = 0; k < BAND_COUNT; k++) {
      let v = h[row(k, 0)];
      for (let i = 0; i < W; i++) { v += (h[row(k, i)] - v) * soft; h[row(k, i)] = v; }
      for (let i = W - 1; i >= 0; i--) { v += (h[row(k, i)] - v) * soft; h[row(k, i)] = v; }
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.histTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, S.HIST_ROWS, gl.RGBA, gl.FLOAT, h);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.shapeTex);
    if (s) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SHAPE_W, SHAPE_H, gl.RED, gl.FLOAT, this.shape);
  }

  /**
   * Draw the picture for `time` seconds into the song.
   * `dt` is the step since the last drawn frame; `wallDt` is real time (for the governor).
   */
  frame(time: number, dt: number, playing: boolean, wallDt = dt) {
    if (this.lost || !this.accum) return;
    this.govern(wallDt);
    const gl = this.gl;
    dt = Math.min(0.05, Math.max(1e-4, dt));
    const a = this.analysis, s = this.sampler;
    const ease = (tau: number) => 1 - Math.exp(-dt / tau);

    // ---- what the music is doing right now -------------------------------
    let loud = 0.4, onset = 0;
    if (a && s) {
      s.at(time);
      loud = playing ? s.loud : 0;
      onset = playing ? s.onset : 0;
      if (playing) for (let pc = 0; pc < 12; pc++) this.chroma[pc] += (s.chroma[pc] - this.chroma[pc]) * ease(0.6);
    } else this.idleClock += dt;
    this.live += ((playing || !a ? 1 : 0) - this.live) * ease(0.25);
    this.energy += (loud - this.energy) * ease(loud > this.energy ? 0.05 : 0.35);
    this.kick = Math.max(this.kick * Math.exp(-dt / 0.12), onset * Math.sqrt(loud));

    // ---- colours (see lightmusic.ts) --------------------------------------
    if (a && s && playing) this.brightness += (s.bright - this.brightness) * ease(0.4);
    const minor = a?.key.minor ?? true;
    const tonic = a?.key.tonic ?? 9; // first screen: A minor
    // Mood from mode and tempo: fast major leans lighter, more vivid and yellower; slow minor darker and bluer.
    const mood = a ? valence(minor, a.bpm) : 0;
    const keyHue = mixHue(NOTE_HUES[tonic], mood >= 0 ? YELLOW_HUE : BLUE_HUE, 0.08 * Math.abs(mood));
    const keyColour = vivid(0.74, keyHue, 0.9);
    // A deep room in the key's colour: the darker it is, the more the light stands out.
    const bg = oklch(0.1 + 0.015 * mood, 0.03, keyHue);
    const now = notesHue(this.chroma);

    const W = this.width, H = this.height, unit = Math.min(W, H);
    const scene: Scene = a ? this.scene : 'ribbons';
    this.readHistory(time, keyColour);

    // ---- light buffer -----------------------------------------------------
    const fade = Math.exp(-dt / TRAIL);
    const level = (1 - fade) * (0.5 + 0.5 * this.live) * (0.8 + 0.45 * this.energy + 0.5 * this.kick);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
    gl.useProgram(this.prog.fade.p);
    gl.uniform1f(this.prog.fade.u.uFade, fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.blendFunc(gl.ONE, gl.ONE);

    if (scene === 'ribbons') {
      const p = this.prog.ribbons;
      gl.useProgram(p.p);
      gl.uniform1i(p.u.uHist, 1);
      gl.uniform2f(p.u.uRes, W, H);
      const tall = H > W && !this.compact;
      const gap = tall ? 0.2 : this.compact ? 0.03 : 0.125;
      const centres = new Float32Array(S.RIBBONS), cycles = new Float32Array(S.RIBBONS), phase = new Float32Array(S.RIBBONS);
      const colA = new Float32Array(S.RIBBONS * 3), colB = new Float32Array(S.RIBBONS * 3);
      const motion = this.motionAt(time);
      const stretch = Math.sqrt(Math.min(1.6, Math.max(0.5, W / H)));
      // Each ribbon is a note of the key's chord (root at the bottom, then fifth, third, seventh),
      // coloured by that note's light, and drifting toward the notes sounding now.
      const tones = chordTones(tonic, minor);
      const lift = 0.07 * (this.brightness - 0.5) + 0.03 * mood + 0.06 * this.kick;
      const sat = (0.8 + 0.2 * this.energy + 0.3 * this.kick) * (1 + 0.1 * mood);
      for (let k = 0; k < S.RIBBONS; k++) {
        centres[k] = H * (0.5 + this.centerOffset + gap * (k - (S.RIBBONS - 1) / 2)); // bass at the bottom
        cycles[k] = RIBBON_CYCLES[k] * stretch;
        phase[k] = this.seedPhase[k] + RIBBON_SPEED[k] * motion;
        const target = mixHue(NOTE_HUES[tones[k]], now.hue, 0.4 * now.clarity * this.live);
        const h = Number.isNaN(this.ribbonHue[k]) ? target : mixHue(this.ribbonHue[k], target, ease(0.5));
        this.ribbonHue[k] = h;
        const L = 0.66 + 0.045 * k + lift; // higher pitch, lighter
        const rs = sat * (1 - 0.06 * k);   // lower register, more saturated
        colA.set(vivid(L, h, rs), k * 3);
        colB.set(vivid(L + 0.08, h + 0.05, rs * 0.92), k * 3);
      }
      gl.uniform1fv(p.u.uCenterY, centres);
      gl.uniform1fv(p.u.uCycles, cycles);
      gl.uniform1fv(p.u.uPhase, phase);
      gl.uniform3fv(p.u.uColA, colA);
      gl.uniform3fv(p.u.uColB, colB);
      gl.uniform1f(p.u.uAmp, H * (tall ? 0.085 : this.compact ? 0.11 : 0.125));
      gl.uniform1f(p.u.uWidthPx, (unit / 800) * 1.15);
      gl.uniform1f(p.u.uIntensity, level * 1.15);
    } else {
      const p = this.prog.rings;
      gl.useProgram(p.p);
      gl.uniform1i(p.u.uHist, 1);
      gl.uniform1i(p.u.uShape, 2);
      gl.uniform2f(p.u.uCenterPx, W / 2, H * (0.5 + this.centerOffset));
      gl.uniform1f(p.u.uRmax, 0.45 * unit);
      gl.uniform1f(p.u.uTime, time);
      gl.uniform1f(p.u.uRingT, (a?.beatPeriod ?? 0.6) / 2);
      gl.uniform1f(p.u.uWidthPx, (unit / 800) * 1.5);
      gl.uniform1f(p.u.uIntensity, level * 1.5);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accum.tex);
    gl.generateMipmap(gl.TEXTURE_2D);

    // ---- to the screen ----------------------------------------------------
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const pr = this.prog.present;
    gl.useProgram(pr.p);
    gl.uniform1i(pr.u.uAccum, 0);
    gl.uniform1f(pr.u.uExposure, 1.25);
    gl.uniform3f(pr.u.uBg, bg[0], bg[1], bg[2]);
    gl.uniform2f(pr.u.uInvRes, 1 / W, 1 / H);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.lost) return;
    const gl = this.gl;
    if (this.accum) { gl.deleteTexture(this.accum.tex); gl.deleteFramebuffer(this.accum.fbo); }
    gl.deleteTexture(this.histTex);
    gl.deleteTexture(this.shapeTex);
    gl.deleteVertexArray(this.vao);
    for (const p of Object.values(this.prog)) gl.deleteProgram(p.p);
  }
}
