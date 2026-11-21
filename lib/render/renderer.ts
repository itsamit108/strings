/**
 * WebGL2 renderer. Each design is one fragment shader that reads the last
 * four seconds of the song from a small texture. Light is kept in an HDR
 * buffer so moving lines leave a short soft trail, and the glow is that same
 * light read back blurred.
 */
import type { Analysis } from '../analysis/types';
import { BAND_COUNT, BAND_HIGH_HZ, BAND_LOW_HZ } from '../analysis/types';
import { FeatureSampler, fifthsAngle } from '../analysis/finalize';
import { oklch } from './color';
import { BLUE_HUE, chordTones, mixHue, NOTE_HUES, notesHue, valence, vivid, YELLOW_HUE } from './lightmusic';
import { designsAt, planSections, type Design, type Section } from '../analysis/sections';
import * as S from './shaders';

export type Scene = Design;

/** Internal resolution steps, used only if the device cannot hold its frame rate. */
const SCALES = [0.5, 0.67, 0.8, 1];
const TRAIL = 0.07; // seconds a line's light lingers
const SHAPE_W = 128;
const SHAPE_H = 48;
/** Waves across the screen for each ribbon: long for bass, short for treble. */
/**
 * Ribbon k spans pitch ranges 2k and 2k+1. We hear pitch on a log scale, so its waves follow the ribbon's
 * pitch in octaves above 20 Hz (the bottom of hearing): about 2, 4, 6 and 8 octaves. Wave count and speed
 * are in proportion to that.
 */
const RIBBON_OCTAVES = Array.from({ length: 4 }, (_, k) =>
  Math.log2((BAND_LOW_HZ * Math.pow(BAND_HIGH_HZ / BAND_LOW_HZ, (2 * k + 1) / BAND_COUNT)) / 20));
const RIBBON_CYCLES = RIBBON_OCTAVES.map((o) => 0.4 * o);
const RIBBON_SPEED = RIBBON_OCTAVES.map((o) => 0.27 * o);

/** First zero of J_n, n = 0..8: the rim of a drum skin stays still. */
const BESSEL_ZEROS = [2.4048, 3.8317, 5.1356, 6.3802, 7.5883, 8.7715, 9.9361, 11.0864, 12.2251];
const BESSEL_W = 256;
/** J_n(j_n1 · r) for r = 0..1, each row scaled to a peak of 1. */
const BESSEL = (() => {
  const t = new Float32Array(BESSEL_W * 9);
  const fact = [1];
  for (let k = 1; k < 60; k++) fact[k] = fact[k - 1] * k;
  const J = (n: number, x: number) => {
    let s = 0;
    for (let k = 0; k < 30; k++) s += ((k % 2 ? -1 : 1) * Math.pow(x / 2, 2 * k + n)) / (fact[k] * fact[k + n]);
    return s;
  };
  for (let n = 0; n < 9; n++) {
    let peak = 1e-9;
    for (let i = 0; i < BESSEL_W; i++) {
      const v = J(n, BESSEL_ZEROS[n] * (i / (BESSEL_W - 1)));
      t[n * BESSEL_W + i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    for (let i = 0; i < BESSEL_W; i++) t[n * BESSEL_W + i] /= peak;
  }
  return t;
})();
/** Plate modes (n, m), n < m; a mode's frequency grows as n² + m². */
const PLATE_MODES = (() => {
  const out: [number, number][] = [];
  for (let m = 1; m <= 12; m++) for (let n = 0; n < m; n++) out.push([n, m]);
  return out;
})();
/**
 * The plate mode whose frequency matches a note: a plate mode rings at PLATE_HZ·(n² + m²), PLATE_HZ being
 * the plate's own constant (its size and stiffness). Low music makes broad patterns, high music fine ones.
 */
const PLATE_HZ = 12;
function plateMode(hz: number): [number, number] {
  const target = hz / PLATE_HZ;
  let best = PLATE_MODES[0], bestD = Infinity;
  for (const nm of PLATE_MODES) {
    const d = Math.abs(nm[0] ** 2 + nm[1] ** 2 - target) - 0.01 * nm[0];
    if (d < bestD) { bestD = d; best = nm; }
  }
  return best;
}
/** Real frequencies are far too fast to see; moving ones are shown eight octaves down (÷256). */
const SLOW = 256;
/** Shown with the title and artist, in the picture and the video. */
const CREDIT_URL = 'strings-coral.vercel.app';

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface DrawCtx {
  W: number; H: number; unit: number; time: number; dt: number; ease: (tau: number) => number; level: number;
  tonic: number; minor: boolean; mood: number; now: { hue: number; clarity: number };
  cx: number; cy: number; order: number[];
  /** frequency (Hz) of each pitch class in the octave where the sound's energy sits now */
  noteHz: number[];
  /** size swell from the bass */
  pulse: number;
  /** line width from the voice range */
  voiceWide: number;
}
const smooth01 = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
interface Program { p: WebGLProgram; u: Uniforms }

function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class PlateRenderer {
  private gl!: WebGL2RenderingContext;
  private prog!: Record<'ribbons' | 'rings' | 'plate' | 'ripples' | 'membrane' | 'fade' | 'present', Program>;
  private besselTex!: WebGLTexture;
  private captionTex!: WebGLTexture;
  private labelTex!: WebGLTexture;
  private vao!: WebGLVertexArrayObject;
  private histTex!: WebGLTexture;
  private shapeTex!: WebGLTexture;
  private accum: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null = null;
  private width = 2;
  private height = 2;
  private askedW = 2;
  private askedH = 2;
  private scaleIndex = SCALES.length - 1;

  /** when set, always draw this design (for testing); otherwise the song's sections decide */
  force: Design | null = null;
  /** the song's sections and the design chosen for each */
  sections: Section[] = [];
  /** the design most visible at the last frame */
  current: Design = 'ribbons';
  private caption = { title: '', artist: '', show: true };
  /** where the caption sits (fractions of the picture) and how visible it is now, so it can be clicked to edit */
  captionBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  captionAlpha = 0;
  /** the small label that stays for the whole song */
  labelBox = { x0: 0, y0: 0, x1: 0, y1: 0 };
  labelAlpha = 0;
  private captionCanvas: HTMLCanvasElement | null = null;
  private labelCanvas: HTMLCanvasElement | null = null;
  private captionKey = '';
  /** vertical shift of the picture's centre, as a fraction of the height (+ = up) */
  centerOffset = 0;
  /** keep the ribbons together in a narrow band (used behind the first screen's text) */
  compact = false;
  /** the viewer asked their system for less motion: no swelling, no sky waves, slower drift */
  reducedMotion = false;
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
  /** how strongly each note drives the plate, smoothed */
  private plateW = new Float32Array(12);
  /** pitch-range levels, smoothed */
  private bandsNow = new Float32Array(BAND_COUNT);
  private bassE = 0;
  /** bass level now (fast) and a short envelope after each bass hit */
  private bassNow = 0;
  private bassHit = 0;
  private prevBass = 0;
  /** voice range (pitch ranges 4–6, about 315 Hz – 2.5 kHz) now, and a short envelope when it comes in */
  private voiceNow = 0;
  private voiceIn = 0;
  private prevVoice = 0;
  private trebleE = 0;
  /** phases that run on with the music (kept, so nothing jumps when the notes change) */
  private ripplePhase = new Float32Array(4);
  private membraneTurn = new Float32Array(9);
  /** each drum-skin mode's oscillation phase */
  private membranePhase = new Float32Array(9);
  /** whole-song measurements for the sky */
  private songBright = 0.5;
  private songBusy = 0.05;
  /** 0 away from a change of design, 1 in the middle of one */
  private blend = 0;
  /** song time at the last frame, to tell playing on from a jump (seek, replay, export start) */
  private lastTime = Number.NaN;
  /** share of the picture's height covered by controls at the top (0 when exporting) */
  private safeTop = 0;
  setSafeTop(v: number) {
    if (Math.abs(v - this.safeTop) < 0.002) return;
    this.safeTop = v;
    this.drawCaption();
  }
  /** the sky's motion: cloud flow, turn, and the last few hits sending waves outward */
  private skyFlow = [0, 0];
  private skyRot = 0;
  private hits = new Float32Array(12); // (time, strength) × 6
  private hitNext = 0;
  private lastHit = -1;
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
  private onRestored = () => { this.lost = false; this.accum = null; this.captionKey = ''; this.setup(); };

  private setup() {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('This browser has no WebGL2, which the picture needs.');
    this.gl = gl;
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float'))
      throw new Error('This device cannot draw high-range light, which the picture needs.');

    const mk = (fs: string, vs: string = S.FULLSCREEN_VS): Program => {
      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!;
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
          throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(sh));
        return sh;
      };
      const p = gl.createProgram()!;
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS))
        throw new Error('Shader failed to link: ' + gl.getProgramInfoLog(p));
      // The linked program keeps what it needs; the shader objects can go.
      for (const sh of gl.getAttachedShaders(p) ?? []) { gl.detachShader(p, sh); gl.deleteShader(sh); }
      const u: Uniforms = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i)!;
        u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
      }
      return { p, u };
    };
    this.prog = {
      ribbons: mk(S.RIBBONS_FS), rings: mk(S.RINGS_FS), plate: mk(S.PLATE_FS), ripples: mk(S.RIPPLES_FS),
      membrane: mk(S.MEMBRANE_FS), fade: mk(S.FADE_FS), present: mk(S.PRESENT_FS),
    };
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
    this.besselTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.besselTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, BESSEL_W, 9, 0, gl.RED, gl.FLOAT, BESSEL);
    smooth(gl.CLAMP_TO_EDGE);
    for (const key of ['captionTex', 'labelTex'] as const) {
      this[key] = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this[key]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      smooth(gl.CLAMP_TO_EDGE);
    }

    this.resize(this.askedW, this.askedH, true);
  }

  /** Start from the state that belongs to this song's fingerprint. */
  seed(seed: number) {
    for (let k = 0; k < S.RIBBONS; k++) this.seedPhase[k] = 2 * Math.PI * hash01((seed >>> 0) + k * 7919);
    this.chroma.fill(0);
    this.energy = this.kick = 0;
    this.live = 0;
    this.blend = 0;
    this.lastTime = Number.NaN;
    this.brightness = 0.5;
    this.ribbonHue.fill(Number.NaN);
    this.plateW.fill(0);
    this.bandsNow.fill(0);
    this.bassE = this.trebleE = 0;
    this.bassNow = this.bassHit = this.prevBass = 0;
    this.voiceNow = this.voiceIn = this.prevVoice = 0;
    this.hits.fill(0);
    this.hitNext = 0;
    this.lastHit = -1;
    this.skyFlow = [0, 0];
    this.skyRot = 0;
    this.ripplePhase.fill(0);
    for (let n = 0; n < 9; n++) this.membraneTurn[n] = 2 * Math.PI * hash01((seed >>> 0) + 101 * n);
    this.membranePhase.fill(0);
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
    this.drawCaption();
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
    this.sections = analysis ? planSections(analysis) : [];
    if (analysis) {
      let b = 0, o = 0;
      for (let i = 0; i < analysis.totalFrames; i++) { b += analysis.bright[i]; o += analysis.onset[i]; }
      this.songBright = b / Math.max(1, analysis.totalFrames);
      this.songBusy = o / Math.max(1, analysis.totalFrames);
    }
  }

  /** Title and artist, shown on the picture at the start of the song (and so in the exported video). */
  setCaption(title: string, artist: string, show: boolean) {
    this.caption = { title, artist, show };
    this.drawCaption();
  }

  /**
   * Two pictures of the title and artist: a large one that rises in at the start, and a small label that
   * stays for the rest of the song. In 9:16 the label sits above the area Reels and Shorts cover with
   * their own buttons and text.
   */
  private drawCaption() {
    if (this.lost || typeof document === 'undefined') return;
    const W = this.width, H = this.height, gl = this.gl;
    const { title, artist, show } = this.caption;
    // Redraw only when something it shows has changed (resizes and safe-area updates come often).
    const key = `${W}x${H}|${title}|${artist}|${show}|${this.safeTop.toFixed(3)}`;
    if (key === this.captionKey) return;
    this.captionKey = key;
    const unit = Math.min(W, H), tall = H > W;
    const titleFont = (px: number) => `300 ${px}px "Fraunces Variable", "Iowan Old Style", Georgia, serif`;
    const artistFont = (px: number) => `450 ${px}px "Instrument Sans Variable", system-ui, "Segoe UI", sans-serif`;
    const draw = (
      canvas: HTMLCanvasElement, tex: WebGLTexture,
      o: { x: number; base: number; tPx: number; aPx: number; maxW: number; align: CanvasTextAlign; shadow: number },
      extra?: (g: CanvasRenderingContext2D, box: { bottom: number }) => void,
    ) => {
      canvas.width = W; canvas.height = H;
      const g = canvas.getContext('2d')!;
      g.clearRect(0, 0, W, H);
      let box = { x0: 0, y0: 0, x1: 0, y1: 0 };
      if (show && (title || artist)) {
        const fit = (font: (px: number) => string, text: string, px: number) => {
          let size = px;
          g.font = font(size);
          while (size > 8 && g.measureText(text).width > o.maxW) { size *= 0.94; g.font = font(size); }
          return size;
        };
        const tSize = title ? fit(titleFont, title, o.tPx) : 0;
        const aSize = artist ? fit(artistFont, artist, o.aPx) : 0;
        g.textAlign = o.align;
        g.textBaseline = 'alphabetic';
        g.shadowColor = 'rgba(0,0,0,0.6)';
        g.shadowBlur = o.shadow;
        if (title) {
          g.font = titleFont(tSize);
          g.fillStyle = 'rgba(244,239,229,0.96)';
          g.fillText(title, o.x, o.base);
        }
        const aBase = o.base + (title ? tSize * 0.3 : 0) + aSize * 1.35;
        if (artist) {
          g.font = artistFont(aSize);
          g.fillStyle = 'rgba(214,208,196,0.88)';
          g.fillText(artist, o.x, aBase);
        }
        g.font = titleFont(tSize);
        const wT = title ? g.measureText(title).width : 0;
        g.font = artistFont(aSize);
        const wA = artist ? g.measureText(artist).width : 0;
        const w = Math.max(wT, wA), x0 = o.align === 'center' ? o.x - w / 2 : o.x;
        const top = o.base - tSize, bottom = artist ? aBase + aSize * 0.4 : o.base + tSize * 0.3;
        box = { x0: x0 / W, x1: (x0 + w) / W, y0: top / H, y1: bottom / H };
      }
      extra?.(g, { bottom: box.y1 * H });
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      return box;
    };
    this.captionBox = draw(this.captionCanvas ?? (this.captionCanvas = document.createElement('canvas')), this.captionTex, {
      x: tall ? W / 2 : W * 0.07, base: H * (tall ? 0.74 : 0.72),
      tPx: unit * (tall ? 0.08 : 0.064), aPx: unit * (tall ? 0.034 : 0.03),
      maxW: W * (tall ? 0.84 : 0.62), align: tall ? 'center' : 'left', shadow: unit * 0.02,
    });
    this.labelBox = draw(this.labelCanvas ?? (this.labelCanvas = document.createElement('canvas')), this.labelTex, {
      x: tall ? W / 2 : W * 0.045, base: H * (tall ? 0.075 + this.safeTop : 0.77),
      tPx: unit * (tall ? 0.042 : 0.034), aPx: unit * (tall ? 0.024 : 0.021),
      maxW: W * (tall ? 0.8 : 0.24), align: tall ? 'center' : 'left', shadow: unit * 0.012,
    }, (g, box) => {
      // Where to make your own: "Create yours at" quietly, then the address bright and a little bolder,
      // so it can be read off a phone and typed.
      const px = unit * (tall ? 0.034 : 0.021);
      const lead = 'Create yours at ', url = CREDIT_URL;
      const fontLead = `450 ${px}px "Instrument Sans Variable", system-ui, "Segoe UI", sans-serif`;
      const fontUrl = `620 ${px * 1.06}px "Instrument Sans Variable", system-ui, "Segoe UI", sans-serif`;
      g.font = fontLead;
      const wLead = g.measureText(lead).width;
      g.font = fontUrl;
      const wUrl = g.measureText(url).width;
      const total = wLead + wUrl;
      const y = H * 0.95;
      const x0 = tall ? W / 2 - total / 2 : W * 0.955 - total;
      g.shadowColor = 'rgba(0,0,0,0.75)';
      g.shadowBlur = unit * 0.012;
      g.textAlign = 'left';
      g.textBaseline = 'alphabetic';
      g.font = fontLead;
      g.fillStyle = 'rgba(214,208,196,0.8)';
      g.fillText(lead, x0, y);
      g.font = fontUrl;
      g.fillStyle = 'rgba(248,244,236,0.98)';
      g.fillText(url, x0 + wLead, y);
    });
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
    this.readHistory(time, keyColour);

    // ---- light buffer -----------------------------------------------------
    // During a change of design the light lingers longer, like a reverb tail, so one dissolves into the next.
    const fade = Math.exp(-dt / (TRAIL + 0.28 * this.blend));
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

    // A jump in time (seek, replay, pause/resume, export start) is not music: forget what was rising.
    const jumped = !playing || Number.isNaN(this.lastTime) || Math.abs(time - this.lastTime - dt) > 0.25;
    this.lastTime = time;
    if (time < this.lastHit - 0.05) { this.lastHit = -1; this.hits.fill(0); }

    // ---- the sky moves with the music --------------------------------------
    const tempo = a ? a.bpm / 120 : 0.5;
    const flowSpeed = (0.006 + 0.022 * this.energy) * tempo * (this.reducedMotion ? 0.3 : 1);
    this.skyFlow[0] += flowSpeed * dt * (0.8 + 0.4 * Math.sin(0.05 * time));
    this.skyFlow[1] += flowSpeed * dt * 0.35;
    this.skyRot += 0.0045 * tempo * (0.6 + 0.8 * this.energy) * dt * (this.reducedMotion ? 0.3 : 1);
    // A clear onset sends a wave out from the centre (at most one per quarter second).
    if (a && playing && !this.reducedMotion && (onset > 0.35 || this.bassHit > 0.5) && time - this.lastHit > 0.25) {
      this.hits[this.hitNext * 2] = time;
      this.hits[this.hitNext * 2 + 1] = Math.min(1, Math.max(onset * (0.4 + loud), this.bassHit));
      this.hitNext = (this.hitNext + 1) % 6;
      this.lastHit = time;
    }

    // ---- what each design needs from the music ------------------------------
    if (s && a) for (let k = 0; k < BAND_COUNT; k++) this.bandsNow[k] += ((playing ? s.bands[k] : 0) - this.bandsNow[k]) * ease(0.25);
    this.bassE += ((this.bandsNow[0] + this.bandsNow[1]) / 2 - this.bassE) * ease(1.5);
    this.trebleE += ((this.bandsNow[6] + this.bandsNow[7]) / 2 - this.trebleE) * ease(0.3);
    // Bass. For the same loudness, a low sound moves the air farther than a high one (displacement ∝ 1/f),
    // so bass is what makes the designs swell. A bass hit is a fast rise in the two lowest pitch ranges.
    const bassIn = s && a && playing ? (s.bands[0] + s.bands[1]) / 2 : 0;
    this.bassNow += (bassIn - this.bassNow) * ease(bassIn > this.bassNow ? 0.03 : 0.15);
    if (jumped) this.prevBass = bassIn;
    const rise = (bassIn - this.prevBass) / dt;
    this.prevBass = bassIn;
    this.bassHit = Math.max(this.bassHit * Math.exp(-dt / 0.2), Math.min(1, Math.max(0, (rise - 1.2) / 5)));
    // Voice range: where voices carry their formants (the resonances of the vocal tract). When it is strong,
    // the lines glow brighter and a little wider, as a resonance does; a voice coming in blooms once.
    const voiceInNow = s && a && playing ? (s.bands[3] + s.bands[4] + s.bands[5]) / 3 : 0;
    this.voiceNow += (voiceInNow - this.voiceNow) * ease(voiceInNow > this.voiceNow ? 0.05 : 0.3);
    if (jumped) this.prevVoice = voiceInNow;
    const vRise = (voiceInNow - this.prevVoice) / dt;
    this.prevVoice = voiceInNow;
    this.voiceIn = Math.max(this.voiceIn * Math.exp(-dt / 0.6), Math.min(1, Math.max(0, (vRise - 1.0) / 4)));
    // The strongest notes, sharpened (fourth power) so they are not averaged away.
    let sharpSum = 0;
    for (let pc = 0; pc < 12; pc++) { this.sharp[pc] = this.chroma[pc] ** 4; sharpSum += this.sharp[pc]; }
    for (let pc = 0; pc < 12; pc++) {
      const w = sharpSum > 0 ? this.sharp[pc] / sharpSum : pc === tonic ? 1 : 0;
      this.plateW[pc] += (w - this.plateW[pc]) * ease(0.35);
    }
    const order = Array.from({ length: 12 }, (_, i) => i).sort((x, y) => this.plateW[y] - this.plateW[x]);
    const pulse = this.reducedMotion ? 1 : 1 + 0.07 * this.bassNow + 0.06 * this.bassHit;
    // The notes' octave: where the spectrum's energy sits now (centre of the pitch-range levels).
    let wsum = 0, ksum = 0;
    for (let k = 0; k < BAND_COUNT; k++) { wsum += this.bandsNow[k]; ksum += this.bandsNow[k] * k; }
    const register = BAND_LOW_HZ * Math.pow(BAND_HIGH_HZ / BAND_LOW_HZ, ((wsum > 1e-6 ? ksum / wsum : 3.5) + 0.5) / BAND_COUNT);
    const noteHz = Array.from({ length: 12 }, (_, pc) => {
      const base = 261.6256 * Math.pow(2, pc / 12);
      return base * Math.pow(2, Math.round(Math.log2(register / base)));
    });
    const voiceWide = 1 + 0.35 * this.voiceNow;
    const ctx: DrawCtx = { W, H, unit, time, dt, ease, level: level * (1 + 0.35 * this.bassHit) * (1 + 0.3 * this.voiceNow + 0.35 * this.voiceIn), tonic, minor, mood, now, cx: W / 2, cy: H * (0.5 + this.centerOffset), order, pulse, voiceWide, noteHz };

    const plan = !a ? { shown: [{ design: 'ribbons' as Design, weight: 1 }], blend: 0 }
      : this.force ? { shown: [{ design: this.force, weight: 1 }], blend: 0 }
      : designsAt(this.sections, time);
    const shown = plan.shown;
    this.blend = plan.blend;
    let top = shown[0];
    for (const d of shown) if (d.weight > top.weight) top = d;
    this.current = top.design;
    for (const { design, weight } of shown) {
      if (weight < 0.002) continue;
      this.draw(design, ctx, weight);
    }

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
    // Sky: same song, same sky. Busier music → more stars; brighter timbre → hotter, bluer stars;
    // treble → deeper twinkle; bass → brighter nebula.
    const seed = a ? (a.seed >>> 0) % 997 : 17;
    gl.uniform1f(pr.u.uTime, a ? time : this.idleClock);
    gl.uniform1f(pr.u.uUnit, unit);
    gl.uniform1f(pr.u.uSeed, seed + 0.5);
    gl.uniform1f(pr.u.uStarDensity, Math.min(0.34, 0.1 + 1.6 * this.songBusy));
    gl.uniform1f(pr.u.uWarm, 0.6 * this.songBright + 0.4 * this.brightness);
    gl.uniform1f(pr.u.uTwinkle, 0.12 + 0.7 * this.trebleE);
    gl.uniform1f(pr.u.uNebula, 0.5 + 1.4 * this.bassE + 0.8 * this.voiceNow + 0.8 * this.voiceIn);
    // Nebula: the colour of the notes sounding now, shading into the key's fifth.
    const nA = vivid(0.5, a ? mixHue(keyHue, now.hue, 0.7 * now.clarity) : keyHue, 0.7), nB = vivid(0.5, NOTE_HUES[(tonic + 7) % 12], 0.7);
    gl.uniform3f(pr.u.uNebA, nA[0] * 0.05, nA[1] * 0.05, nA[2] * 0.05);
    gl.uniform3f(pr.u.uNebB, nB[0] * 0.05, nB[1] * 0.05, nB[2] * 0.05);
    const ang = Math.PI * (0.15 + 0.7 * hash01(seed * 31 + 7));
    gl.uniform2f(pr.u.uBandDir, Math.cos(ang), Math.sin(ang));
    gl.uniform2f(pr.u.uFlow, this.skyFlow[0], this.skyFlow[1]);
    gl.uniform1f(pr.u.uRot, this.skyRot);
    const hits = new Float32Array(24);
    for (let i = 0; i < 6; i++) {
      const age = time - this.hits[i * 2];
      const ok = a && this.hits[i * 2 + 1] > 0 && age >= 0 && age < 8;
      hits[i * 4] = ok ? age : 0;
      hits[i * 4 + 1] = ok ? this.hits[i * 2 + 1] : 0;
    }
    gl.uniform4fv(pr.u.uHits, hits);
    // A hit's wave front reaches the edge of the picture in one bar (four beats).
    gl.uniform1f(pr.u.uWaveSpeed, (0.5 * Math.hypot(W, H)) / (4 * (a?.beatPeriod ?? 0.6)));
    // Title and artist: large, rising in over the first seconds; then a small label for the rest of the song,
    // a little brighter when the music is louder.
    const on = a && this.caption.show;
    const capA = on ? smooth01(0.3, 1.5, time) * (1 - smooth01(5.5, 7, time)) : 0;
    const labA = on ? smooth01(6.2, 7.8, time) * (0.62 + 0.3 * this.energy + 0.08 * this.kick) : 0;
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
    gl.uniform1i(pr.u.uLabel, 5);
    gl.uniform1f(pr.u.uLabelAlpha, labA);
    this.labelAlpha = labA;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.captionTex);
    gl.uniform1i(pr.u.uCaption, 3);
    gl.uniform1f(pr.u.uCaptionAlpha, capA);
    this.captionAlpha = capA;
    gl.uniform1f(pr.u.uCaptionLift, this.reducedMotion ? 0 : (1 - smooth01(0.3, 2.2, time)) * 0.015);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Draws one design into the light buffer at `weight` of its full strength. */
  private draw(design: Design, c: DrawCtx, weight: number) {
    const gl = this.gl;
    const { W, H, unit, ease } = c;
    const lvl = c.level * weight;
    const note = (pc: number, L = 0.72, sat = 0.95) =>
      vivid(L + 0.07 * (this.brightness - 0.5), NOTE_HUES[pc], Math.min(1, sat * (0.85 + 0.15 * this.energy + 0.3 * this.kick)));
    if (design === 'ribbons') {
      const p = this.prog.ribbons;
      gl.useProgram(p.p);
      gl.uniform1i(p.u.uHist, 1);
      gl.uniform2f(p.u.uRes, W, H);
      const tall = H > W && !this.compact;
      const gap = tall ? 0.185 : this.compact ? 0.03 : 0.125;
      const centres = new Float32Array(S.RIBBONS), cycles = new Float32Array(S.RIBBONS), phase = new Float32Array(S.RIBBONS);
      const colA = new Float32Array(S.RIBBONS * 3), colB = new Float32Array(S.RIBBONS * 3);
      const motion = this.motionAt(c.time);
      const stretch = Math.sqrt(Math.min(1.6, Math.max(0.5, W / H)));
      // Each ribbon is a note of the key's chord (root at the bottom, then fifth, third, seventh),
      // coloured by that note's light, and drifting toward the notes sounding now.
      const tones = chordTones(c.tonic, c.minor);
      const lift = 0.07 * (this.brightness - 0.5) + 0.03 * c.mood + 0.06 * this.kick;
      const sat = (0.8 + 0.2 * this.energy + 0.3 * this.kick) * (1 + 0.1 * c.mood);
      for (let k = 0; k < S.RIBBONS; k++) {
        centres[k] = H * (0.5 + this.centerOffset + gap * (k - (S.RIBBONS - 1) / 2)); // bass at the bottom
        cycles[k] = RIBBON_CYCLES[k] * stretch;
        phase[k] = this.seedPhase[k] + RIBBON_SPEED[k] * motion;
        const target = mixHue(NOTE_HUES[tones[k]], c.now.hue, 0.4 * c.now.clarity * this.live);
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
      gl.uniform1f(p.u.uAmp, H * (tall ? 0.085 : this.compact ? 0.11 : 0.125) * c.pulse);
      gl.uniform1f(p.u.uWidthPx, (unit / 800) * 1.15 * c.voiceWide);
      gl.uniform1f(p.u.uIntensity, lvl * 1.15);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (design === 'rings') {
      const p = this.prog.rings;
      gl.useProgram(p.p);
      gl.uniform1i(p.u.uHist, 1);
      gl.uniform1i(p.u.uShape, 2);
      gl.uniform2f(p.u.uCenterPx, c.cx, c.cy);
      gl.uniform1f(p.u.uRmax, 0.45 * unit * c.pulse);
      gl.uniform1f(p.u.uTime, c.time);
      gl.uniform1f(p.u.uRingT, (this.analysis?.beatPeriod ?? 0.6) / 2);
      gl.uniform1f(p.u.uWidthPx, (unit / 800) * 1.5 * c.voiceWide);
      gl.uniform1f(p.u.uIntensity, lvl * 1.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (design === 'plate') {
      const p = this.prog.plate;
      gl.useProgram(p.p);
      const modes = new Float32Array(36), cols = new Float32Array(36);
      for (let pc = 0; pc < 12; pc++) {
        // Which of the two equal-frequency combinations each note shows is fixed per song (its fingerprint).
        modes.set([...plateMode(c.noteHz[pc]), this.membraneTurn[pc % 9] < Math.PI ? 1 : -1], pc * 3);
        cols.set(note(pc, 0.74), pc * 3);
      }
      gl.uniform2f(p.u.uCenterPx, c.cx, c.cy);
      gl.uniform1f(p.u.uHalf, 0.41 * unit * c.pulse);
      gl.uniform3fv(p.u.uModes, modes);
      gl.uniform1fv(p.u.uWeight, this.plateW);
      gl.uniform3fv(p.u.uCol, cols);
      gl.uniform1f(p.u.uWidthPx, (unit / 900) * 1.3 * c.voiceWide);
      gl.uniform1f(p.u.uJump, Math.min(1, Math.max(this.kick * 1.5, this.bassHit)));
      gl.uniform1f(p.u.uTime, c.time);
      gl.uniform1f(p.u.uIntensity, lvl * 1.6);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (design === 'ripples') {
      // One source for each note clearly sounding (at least a quarter as strong as the strongest), 2 to 4.
      const top = this.plateW[c.order[0]];
      const notes = c.order.slice(0, 4).filter((pc, k) => k < 2 || this.plateW[pc] >= 0.25 * top);
      if (this.plateW[notes[1]] < 0.15 * top) notes[1] = notes[0]; // one note: two sources in unison
      const n = notes.length;
      const p = this.prog.ripples;
      gl.useProgram(p.p);
      // Sources on a circle, turned by the song's fingerprint; with two, across the picture's long side.
      const R = 0.11 * Math.max(W, H) * (n === 2 ? 1 : 0.9);
      const turn = n === 2 ? (H > W ? Math.PI / 2 : 0) : this.membraneTurn[0];
      const src: number[] = [], k: number[] = [], amp: number[] = [], col: number[] = [];
      // One medium, one speed: wavelength ∝ 1 / frequency; the key note's wavelength is 0.075 of the picture.
      const fRef = c.noteHz[c.tonic];
      for (let i = 0; i < n; i++) {
        const a = turn + (2 * Math.PI * i) / n;
        src.push(c.cx + R * Math.cos(a), c.cy + R * Math.sin(a));
        const f = c.noteHz[notes[i]];
        k.push((2 * Math.PI * (f / fRef)) / (0.075 * unit));
        // The waves oscillate at the notes' own frequencies, eight octaves down (÷256) so the eye can follow.
        this.ripplePhase[i] += 2 * Math.PI * (f / SLOW) * c.dt;
        amp.push(this.plateW[notes[i]] + 0.1 + (i === 0 ? 0.2 * this.bassE + 0.6 * this.bassHit : 0));
        col.push(...note(notes[i]));
      }
      for (let i = n; i < 4; i++) { src.push(0, 0); k.push(0); amp.push(0); col.push(0, 0, 0); }
      gl.uniform1i(p.u.uCount, n);
      gl.uniform2fv(p.u.uSrc, src);
      gl.uniform1fv(p.u.uK, k);
      gl.uniform1fv(p.u.uPhase, this.ripplePhase);
      gl.uniform1fv(p.u.uAmp, amp);
      gl.uniform3fv(p.u.uCol, col);
      gl.uniform1f(p.u.uUnit, unit);
      gl.uniform1f(p.u.uWidthPx, 1.2);
      gl.uniform1f(p.u.uIntensity, lvl * 1.4);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else if (design === 'membrane') {
      const p = this.prog.membrane;
      gl.useProgram(p.p);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.besselTex);
      gl.uniform1i(p.u.uBessel, 4);
      // Mode 0, the whole skin breathing (the drum's fundamental), follows the bass; mode n follows pitch range n.
      const amp = new Float32Array(9);
      amp[0] = 0.45 * this.bassNow + 0.7 * this.bassHit;
      for (let n = 1; n < 9; n++) amp[n] = this.bandsNow[n - 1];
      let total = 0;
      for (let n = 0; n < 9; n++) total += amp[n];
      for (let n = 0; n < 9; n++) {
        amp[n] = (amp[n] / (0.6 + total)) * 1.1 * (n >= 4 && n <= 6 ? 1 + 0.8 * this.voiceNow : 1);
        // Each mode turns at a speed in proportion to its frequency (j_n1), alternating direction.
        // A drum skin's modes do not turn, they swing: each at its own frequency, j_n1 / j_01 times the
        // fundamental. The fundamental is the key note, nine octaves down (÷512) so the eye can follow.
        const f0 = (261.6256 * Math.pow(2, c.tonic / 12)) / (2 * SLOW);
        this.membranePhase[n] += 2 * Math.PI * f0 * (BESSEL_ZEROS[n] / BESSEL_ZEROS[0]) * c.dt;
        amp[n] *= Math.cos(this.membranePhase[n]);
      }
      gl.uniform2f(p.u.uCenterPx, c.cx, c.cy);
      gl.uniform1f(p.u.uRadius, 0.43 * unit * c.pulse);
      gl.uniform1fv(p.u.uAmp, amp);
      gl.uniform1fv(p.u.uTurn, this.membraneTurn);
      const inner = note(c.order[0], 0.76);
      const outer = vivid(0.7, mixHue(NOTE_HUES[c.tonic], NOTE_HUES[(c.tonic + 7) % 12], 0.5), 0.9);
      gl.uniform3f(p.u.uColIn, inner[0], inner[1], inner[2]);
      gl.uniform3f(p.u.uColOut, outer[0], outer[1], outer[2]);
      // Brighter sound (higher spectral centroid) has shorter waves: more, finer rings (8 to 20).
      gl.uniform1f(p.u.uLines, 8 + 12 * Math.min(1, Math.max(0, this.brightness)));
      gl.uniform1f(p.u.uWidthPx, (unit / 900) * 1.1 * c.voiceWide);
      gl.uniform1f(p.u.uIntensity, lvl * 1.3);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }


  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.lost) return;
    const gl = this.gl;
    if (this.accum) { gl.deleteTexture(this.accum.tex); gl.deleteFramebuffer(this.accum.fbo); }
    gl.deleteTexture(this.histTex);
    gl.deleteTexture(this.shapeTex);
    gl.deleteTexture(this.besselTex);
    gl.deleteTexture(this.captionTex);
    gl.deleteTexture(this.labelTex);
    gl.deleteVertexArray(this.vao);
    for (const p of Object.values(this.prog)) gl.deleteProgram(p.p);
  }
}
