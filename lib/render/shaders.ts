/** Seconds of the song visible on screen at once (now → oldest). */
export const HISTORY_SECONDS = 4.0;
export const HIST_W = 256;
export const HIST_ROWS = 16;
export const RIBBONS = 4;
export const LINES_PER_RIBBON = 20;

/** One triangle that covers the screen. */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Multiply the light already on screen by uFade (blend: dst × src.a). */
export const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uFade;
out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, uFade); }`;

/**
 * RIBBONS
 * The middle of the screen is "now"; the sound then travels out to both sides
 * (the edges are four seconds ago). Each ribbon is one part of the sound, bass
 * at the bottom. Its two edges are waves whose height is how loud that part of
 * the sound was at that moment, and whose length follows pitch (long waves for
 * bass, short for treble). Twenty fine lines are strung between the two edges.
 */
export const RIBBONS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uHist;
uniform vec2 uRes;
uniform float uCenterY[${RIBBONS}];
uniform float uCycles[${RIBBONS}];
uniform float uPhase[${RIBBONS}];
uniform vec3 uColA[${RIBBONS}];
uniform vec3 uColB[${RIBBONS}];
uniform float uAmp;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
// A change of design travels out from the centre as a wave front, as a new sound spreads from its source:
// the incoming design shows inside the front, the outgoing one outside it, with a soft equal-power edge.
uniform vec4 uReveal;   // (centre x, centre y, radius, half edge width), pixels
uniform float uSide;    // 0: everywhere; 1: inside the front only; -1: outside only
float reveal() {
  if (uSide == 0.0) return 1.0;
  float m = smoothstep(uReveal.z - uReveal.w, uReveal.z + uReveal.w, length(gl_FragCoord.xy - uReveal.xy));
  return uSide > 0.0 ? cos(m * 1.5707963) : sin(m * 1.5707963);
}
const float LINES = ${LINES_PER_RIBBON.toFixed(1)};
float level(float row, float age) { return texture(uHist, vec2(age, (row + 0.5) / ${HIST_ROWS.toFixed(1)})).r; }
void main() {
  float x = gl_FragCoord.x / uRes.x * 2.0 - 1.0;
  float age = abs(x);
  float loud = texture(uHist, vec2(age, 8.5 / ${HIST_ROWS.toFixed(1)})).a;
  vec3 acc = vec3(0.0);
  for (int k = 0; k < ${RIBBONS}; k++) {
    float fk = float(k);
    float eA = level(2.0 * fk, age);
    float eB = level(2.0 * fk + 1.0, age);
    float w = 3.14159265 * x * uCycles[k];
    float yA = uCenterY[k] + uAmp * eA * sin(w - uPhase[k]);
    float yB = uCenterY[k] + uAmp * eB * sin(w * 1.27 - uPhase[k] * 1.19 + 1.1);
    float span = yB - yA;
    span = span >= 0.0 ? max(span, 1.0) : min(span, -1.0);
    float t = LINES * (gl_FragCoord.y - yA) / span;      // which line of the ribbon this pixel is near
    float inside = step(-0.5, t) * step(t, LINES + 0.5);
    float g = length(vec2(dFdx(t), dFdy(t)));            // lines per pixel
    float f = abs(fract(t + 0.5) - 0.5);
    float dist = f / max(g, 1e-4);                       // distance to the nearest line, in pixels
    float line = exp(-dist * dist / (uWidthPx * uWidthPx));
    line = mix(line, 0.7, smoothstep(0.3, 0.8, g));      // where lines meet, they join into one
    vec3 col = mix(uColA[k], uColB[k], clamp(t / LINES, 0.0, 1.0));
    acc += col * (line + 0.045) * inside * (0.3 + 0.7 * max(eA, eB));
  }
  float edge = 1.0 - smoothstep(0.8, 1.0, age);
  o = vec4(acc * edge * uIntensity * reveal() * (0.45 + 0.55 * loud), 1.0);
}`;

/**
 * RINGS
 * Each attack in the music (an onset) sends a ring out from the centre, like a wave from its source, so the
 * rings are spaced as the rhythm is: dense in busy passages, sparse in calm ones (sustained sound sends
 * faint rings at the beat). The centre is now; the edge is four seconds ago.
 * A ring keeps what the song was doing when it left: its colour (the notes), and its shape (the twelve
 * notes sit around the circle like hours on a clock, and a ring bulges toward the notes sounding).
 * Spreading out, a wave thins: its strength falls with distance (spherical spreading) and it broadens.
 */
export const RINGS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uHist;
uniform sampler2D uShape;
uniform vec2 uCenterPx;
uniform float uRmax;
uniform vec2 uRing[32];    // (seconds since the ring left, strength 0..1)
uniform int uRingCount;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
void main() {
  vec2 p = gl_FragCoord.xy - uCenterPx;
  float d = length(p) / uRmax;
  if (d > 1.05) { o = vec4(0.0); return; }
  float a01 = fract(atan(p.x, p.y) / 6.2831853);
  float shape = texture(uShape, vec2(d, a01)).r;
  float dd = d * (1.0 - 0.18 * shape);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= uRingCount) break;
    float r = uRing[i].x / ${HISTORY_SECONDS.toFixed(1)};
    float str = uRing[i].y;
    float w = uWidthPx * (0.7 + 1.1 * str) * (1.0 + 1.3 * r);   // broadens as it travels
    float x = (dd - r) * uRmax / w;
    if (abs(x) > 6.0) continue;
    vec3 c = texture(uHist, vec2(r, 8.5 / ${HIST_ROWS.toFixed(1)})).rgb;
    float spread = 1.0 / ((1.0 + 2.2 * r) * (1.0 + 2.2 * r));    // intensity falls with the square of distance
    acc += c * str * spread * (exp(-x * x) + 0.06 / (1.0 + 0.1 * x * x));
  }
  float alive = 1.0 - smoothstep(0.82, 1.0, dd);
  o = vec4(acc * alive * uIntensity, 1.0);
}`;

/** Light → screen: the sharp lines plus their soft glow, on a dark room in the colour of the key. */
export const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uAccum;
uniform float uExposure;
uniform vec3 uBg;
uniform vec2 uInvRes;
// sky
uniform float uTime;
uniform float uUnit;        // min(width, height) in pixels
uniform float uSeed;        // 0..1000, from the song's fingerprint: the same song gives the same sky
uniform float uStarDensity; // share of sky cells holding a star (busier music, more stars)
uniform float uWarm;        // 0 = cool timbre → warm orange stars, 1 = bright timbre → hot blue-white stars
uniform float uTwinkle;     // twinkle depth, from the treble
uniform float uNebula;      // nebula brightness, from the bass
uniform vec3 uNebA;
uniform vec3 uNebB;
uniform vec2 uBandDir;      // direction of the milky band across the sky
uniform vec2 uFlow;         // how far the clouds have flowed (faster with tempo and loudness)
uniform float uRot;         // how far the sky has turned (with tempo)
uniform vec4 uHits[6];      // recent hits: (seconds since, strength, -, -)
uniform float uWaveSpeed;   // pixels per second a hit's wave front travels
uniform vec3 uNoteCol[4];   // light of the four strongest notes now
uniform vec4 uNoteCum;      // their cumulative share of the sound (for picking a particle's note)
uniform float uTonal;       // how clearly pitched the sound is (0 noise .. 1 pure notes)
uniform float uSharp;       // timbre sharpness: 0 soft and mellow .. 1 bright and percussive
uniform float uMoteSize;    // particle size: low register → large, high → small (pitch–size correspondence)
uniform float uMoteDensity; // share of cells holding a mote
uniform vec2 uKundtDir;     // direction of the bass standing wave across the sky
uniform float uKundtK;      // its wavenumber, radians per pixel
uniform float uKundt;       // how strongly particles gather at its still points (0..0.85), from the bass
uniform float uRough;       // sensory roughness (Plomp–Levelt): breaks the picture's regularity, makes it shimmer
uniform float uGrain;       // spectral spread: noisy, wide spectra give a grainy light
uniform float uSoft;        // 1 - sharpness: dull sound glows softly, sharp sound is crisp
// caption (title and artist)
uniform sampler2D uCaption;
uniform float uCaptionAlpha;
uniform float uCaptionLift;
uniform sampler2D uLabel;
uniform float uLabelAlpha;
out vec4 o;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec4 hash42(vec2 p) {
  vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.103, 0.0973, 0.1099));
  p4 += dot(p4, p4.wzxy + 33.33);
  return fract((p4.xxyz + p4.yzzw) * p4.zywx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// Colour of a blackbody (a star) at a temperature in kelvin, as linear sRGB (after Tanner Helland's fit).
vec3 kelvin(float k) {
  float t = k / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.292936 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.39008157 * log(t) - 0.63184144, 0.0, 1.0) : clamp(1.129890861 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.54320678 * log(t - 10.0) - 1.19625408, 0.0, 1.0));
  return pow(c, vec3(2.2));
}
vec3 noteColour(float h) {
  return h < uNoteCum.x ? uNoteCol[0] : h < uNoteCum.y ? uNoteCol[1] : h < uNoteCum.z ? uNoteCol[2] : uNoteCol[3];
}
// One layer of stars on a jittered grid. Most stars are faint; a few are bright (a steep power law, like real skies).
// A hit sends a pressure wave out from the centre; the sky brightens briefly as its front passes.
float hitWave(vec2 px) {
  float r = length(px - 0.5 / uInvRes);
  float sum = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = uHits[i].x, str = uHits[i].y;
    if (str <= 0.0) continue;
    float front = age * uWaveSpeed;
    float d = (r - front) / (0.05 * uUnit);
    sum += str * exp(-d * d) * exp(-age / 2.2);
  }
  return sum;
}
// Sound is a longitudinal wave: particles are pushed along its direction and back as a front passes.
// Each hit's front moves outward from the centre; this is how far it has moved a particle there.
vec2 hitPush(vec2 px) {
  vec2 c = 0.5 / uInvRes;
  vec2 d = px - c;
  float r = length(d);
  float push = 0.0;
  for (int i = 0; i < 6; i++) {
    float age = uHits[i].x, str = uHits[i].y;
    if (str <= 0.0) continue;
    float x = (r - age * uWaveSpeed) / (0.06 * uUnit);
    push += str * sin(x * 2.4) * exp(-x * x) * exp(-age / 2.2);
  }
  return r > 1e-3 ? d / r * push * 0.025 * uUnit : vec2(0.0);
}
vec2 turn(vec2 px, float a) {
  vec2 c = 0.5 / uInvRes;
  float s = sin(a), co = cos(a);
  return c + mat2(co, s, -s, co) * (px - c);
}
vec3 stars(vec2 px, float cell, float density, float gain, float band) {
  vec2 c = floor(px / cell);
  vec4 h = hash42(c + uSeed);
  if (h.x > density * (1.0 + 1.5 * band)) return vec3(0.0);
  vec4 g = hash42(c * 1.7 + uSeed + 31.0);
  vec2 pos = (c + 0.2 + 0.6 * h.yz) * cell;
  float mag = pow(h.w, 5.0);
  float r = (0.55 + 1.1 * mag) * uUnit / 1000.0;
  float d = length(px - pos);
  // The glow ends well inside the star's own cell, so no cell edge ever shows.
  float core = exp(-d * d / (r * r)) + 0.04 * mag * exp(-d / (6.0 * r)) * (1.0 - smoothstep(0.08 * cell, 0.18 * cell, d));
  // Hotter or cooler stars depending on how bright the sound is (spectral centroid ↔ colour temperature).
  float temp = mix(3200.0, 13000.0, clamp(g.x * 0.75 + (uWarm - 0.5) * 0.8 + 0.12, 0.0, 1.0));
  // In clearly pitched music some stars take the light of the notes sounding; in noise they stay star-coloured.
  vec3 tint = mix(kelvin(temp), noteColour(fract(g.y * 7.31 + g.z)), uTonal * 0.7 * step(g.w, 0.75));
  // Scintillation: each star flickers at its own rate, deeper when there is more treble.
  float tw = 1.0 + uTwinkle * (0.55 * sin(uTime * (2.0 + 6.0 * g.y) + 6.2832 * g.z) + 0.3 * sin(uTime * (7.0 + 9.0 * g.w) + 3.0 * g.y));
  return tint * core * (0.08 + 0.9 * mag) * gain * max(tw, 0.0) * (1.0 + 3.0 * hitWave(pos));
}
// Motes: a few larger particles that carry the sound's shape. Soft, mellow timbres make round motes;
// sharp, bright ones make pointed motes (timbre–shape correspondence, the "bouba/kiki" effect,
// Adeli et al. 2014). Lower sound makes larger motes (pitch–size correspondence). Colour: a note sounding.
vec3 motes(vec2 px, float cell) {
  vec2 c = floor(px / cell);
  vec4 h = hash42(c + uSeed * 1.37 + 57.0);
  if (h.x > uMoteDensity) return vec3(0.0);
  vec4 g = hash42(c * 2.3 + uSeed + 77.0);
  vec2 pos = (c + 0.25 + 0.5 * h.yz) * cell;
  vec2 d = px - pos;
  float r = uMoteSize * (0.6 + 0.8 * h.w) * uUnit / 1000.0;
  if (length(d) > 4.0 * r) return vec3(0.0);
  float k = 3.0 + floor(g.x * 4.0);                       // 3 to 6 points
  float th = atan(d.y, d.x) + uTime * (g.y - 0.5) * 0.6 + 6.2832 * g.z;
  float lobe = pow(abs(cos(0.5 * k * th)), 1.0 + 5.0 * uSharp);
  float edge = r * mix(1.0, 0.3 + 1.1 * lobe, uSharp);
  float q = length(d) / edge;
  float body = exp(-q * q * 2.2);
  float halo = 0.12 * exp(-length(d) / (1.5 * r));
  return noteColour(g.w) * (body + halo) * (0.35 + 0.25 * g.y) * (1.0 + 2.0 * hitWave(pos));
}
vec3 sky(vec2 px) {
  vec2 q = px / uUnit;
  // A faint milky band crossing the sky, its clouds drifting very slowly.
  vec2 n = vec2(-uBandDir.y, uBandDir.x);
  float across = dot(q - 0.5 / uInvRes / uUnit, n);
  float band = exp(-across * across / 0.09);
  vec2 drift = uFlow;
  float cloud = fbm(q * 2.4 + uSeed * 0.37 + drift);
  float tint = fbm(q * 1.3 - uSeed * 0.21 - drift);
  vec3 neb = mix(uNebA, uNebB, smoothstep(0.3, 0.7, tint)) * smoothstep(0.42, 0.85, cloud) * band * uNebula * (1.0 + 1.5 * hitWave(px));
  // Two depths of stars turning at different rates (near ones faster), so the sky has depth.
  // Particles drift with the music (faster when louder; near ones faster than far ones) and are pushed by hits.
  vec2 p = px - hitPush(px);
  // Kundt's dust: in a standing sound wave, dust gathers where the air does not move. The sky's particles
  // bunch into bands at the bass wave's still points, a half-wavelength apart, more tightly with more bass.
  float ks = dot(p, uKundtDir);
  p += uKundtDir * (-uKundt * sin(2.0 * uKundtK * ks) / (2.0 * uKundtK));
  vec2 flow = vec2(uFlow.x, uFlow.y) * uUnit;
  vec3 s = stars(turn(p, uRot) - flow * 1.6, uUnit / 14.0, uStarDensity, 0.9, band)
         + stars(turn(p, uRot * 0.55) - flow * 0.7 + 911.0, uUnit / 34.0, uStarDensity * 0.8, 0.45, band);
  // Motes float at a middle depth, between the two star layers.
  vec3 m = motes(turn(p, uRot * 0.8) - flow * 1.15 + 433.0, uUnit / 6.0);
  return neb + s + m * (0.4 + 0.6 * uTonal);
}
void main() {
  vec2 uv = gl_FragCoord.xy * uInvRes;
  // Roughness: two close frequencies beat, and a rough sound's picture loses its regularity (periodicity ↔
  // dissonance, Giannakis 2006): the light is displaced by a slowly moving, irregular field.
  vec2 wq = gl_FragCoord.xy / (0.06 * uUnit);
  vec2 warp = (vec2(vnoise(wq + uTime * 0.9), vnoise(wq * 1.3 - uTime * 0.8 + 41.0)) - 0.5) * 2.0 * uRough * 0.012 * uUnit;
  vec3 light = textureLod(uAccum, (gl_FragCoord.xy + warp) * uInvRes, 0.0).rgb;
  // Grain: a wide, noisy spectrum gives a granular light (coarseness ↔ spectral compactness).
  float gr = hash12(floor(gl_FragCoord.xy / max(1.0, uUnit / 600.0)) + uSeed);
  light *= mix(1.0, 0.25 + 1.5 * gr, uGrain);
  // Glow: the same light, blurred. Each layer is read at four nearby points so it stays smooth.
  vec2 r1 = uInvRes * 2.5, r2 = uInvRes * 7.0;
  vec3 near = textureLod(uAccum, uv + r1 * vec2(1.0, 0.4), 1.5).rgb + textureLod(uAccum, uv + r1 * vec2(-0.4, 1.0), 1.5).rgb
            + textureLod(uAccum, uv + r1 * vec2(-1.0, -0.4), 1.5).rgb + textureLod(uAccum, uv + r1 * vec2(0.4, -1.0), 1.5).rgb;
  vec3 wide = textureLod(uAccum, uv + r2 * vec2(1.0, 0.4), 3.0).rgb + textureLod(uAccum, uv + r2 * vec2(-0.4, 1.0), 3.0).rgb
            + textureLod(uAccum, uv + r2 * vec2(-1.0, -0.4), 3.0).rgb + textureLod(uAccum, uv + r2 * vec2(0.4, -1.0), 3.0).rgb;
  // Contrast ↔ sharpness: a dull sound glows softly; a sharp one stays crisp.
  vec3 bloom = (0.2 * near + 0.1 * wide) * (0.55 + 1.0 * uSoft);
  vec3 total = (light + 0.45 * bloom) * uExposure;
  // Tone map on brightness only, so strong light stays coloured instead of washing to white.
  float m = max(total.r, max(total.g, total.b));
  vec3 mapped = m > 1e-5 ? total / m * (1.0 - exp(-m)) : vec3(0.0);
  mapped = mix(mapped, vec3(1.0), 0.15 * smoothstep(4.0, 12.0, m));
  float v = length(uv - 0.5);
  vec3 bg = uBg * (1.0 - 0.75 * smoothstep(0.15, 0.85, v));
  // The sky sits behind the light and fades where the light is strong.
  bg += sky(gl_FragCoord.xy) * (1.0 - min(1.0, m));
  vec3 col = pow(clamp(bg + mapped, 0.0, 1.0), vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  if (uCaptionAlpha > 0.001) {
    vec4 cap = texture(uCaption, vec2(uv.x, 1.0 - uv.y + uCaptionLift));
    col = mix(col, cap.rgb, cap.a * uCaptionAlpha);
  }
  if (uLabelAlpha > 0.001) {
    vec4 lab = texture(uLabel, vec2(uv.x, 1.0 - uv.y));
    col = mix(col, lab.rgb, lab.a * uLabelAlpha);
  }
  o = vec4(col, 1.0);
}`;

/**
 * PLATE: a Chladni figure. A square plate driven at a frequency vibrates in a standing wave; sand
 * gathers on its nodal lines, where the plate does not move. Each note excites its own mode (n, m),
 * chosen so that the mode's frequency, which grows as n² + m², matches the note's frequency.
 * The modes of the notes sounding are added together, weighted by how strongly each note sounds.
 * Mode shape: cos(nπx)cos(mπy) − cos(mπx)cos(nπy) (the classic square-plate approximation).
 */
export const PLATE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uCenterPx;
uniform float uHalf;          // half the plate's side, in pixels
uniform vec3 uModes[12];      // (n, m, ±1) for each note
uniform float uWeight[12];    // how strongly each note sounds now
uniform vec3 uCol[12];        // each note's light
uniform float uWidthPx;
uniform float uIntensity;
uniform float uJump;          // sand thrown up by a hit
uniform float uTime;
out vec4 o;
// A change of design travels out from the centre as a wave front, as a new sound spreads from its source:
// the incoming design shows inside the front, the outgoing one outside it, with a soft equal-power edge.
uniform vec4 uReveal;   // (centre x, centre y, radius, half edge width), pixels
uniform float uSide;    // 0: everywhere; 1: inside the front only; -1: outside only
float reveal() {
  if (uSide == 0.0) return 1.0;
  float m = smoothstep(uReveal.z - uReveal.w, uReveal.z + uReveal.w, length(gl_FragCoord.xy - uReveal.xy));
  return uSide > 0.0 ? cos(m * 1.5707963) : sin(m * 1.5707963);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  vec2 q = (gl_FragCoord.xy - uCenterPx) / uHalf;
  float edge = max(abs(q.x), abs(q.y));
  if (edge > 1.02) { o = vec4(0.0); return; }
  vec2 x = (q * 0.5 + 0.5) * 3.14159265;
  float u = 0.0, sum = 0.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float w = uWeight[i];
    if (w < 0.004) continue;
    vec3 nm = uModes[i];
    // (n, m) and (m, n) ring at the same frequency; a plate shows their sum or their difference.
    float ui = cos(nm.x * x.x) * cos(nm.y * x.y) + nm.z * cos(nm.y * x.x) * cos(nm.x * x.y);
    u += w * ui;
    col += uCol[i] * w * (0.25 + abs(ui));
    sum += w * (0.25 + abs(ui));
  }
  col /= max(sum, 1e-4);
  float g = length(vec2(dFdx(u), dFdy(u)));
  float dist = abs(u) / max(g, 1e-5);            // pixels to the nearest nodal line
  // Sand: grains, not a smooth line. A hit throws grains off the lines for a moment.
  float grain = hash12(floor(gl_FragCoord.xy / max(1.0, uWidthPx * 0.9)));
  float spread = uWidthPx * (1.6 + 5.0 * uJump);
  float onLine = exp(-dist * dist / (spread * spread));
  float sand = onLine * step(0.35 + 0.3 * uJump, grain) * (0.75 + 0.5 * grain);
  float loose = 0.03 * step(0.985, grain) * (1.0 + 4.0 * uJump);
  float rim = exp(-pow((1.0 - edge) * uHalf / (uWidthPx * 1.5), 2.0)) * 0.12;
  float inside = 1.0 - smoothstep(0.985, 1.02, edge);
  o = vec4(col * (sand + loose + rim) * inside * uIntensity * reveal(), 1.0);
}`;

/**
 * RIPPLES: a ripple tank. Two sources, one for each of the two strongest notes, send out circular
 * waves. In one medium all waves travel at the same speed, so wavelength is inversely proportional to
 * frequency. Where crests meet they add, where a crest meets a trough they cancel: the bright lines are
 * the crests of the summed wave. Equal notes give still fringes; different notes give moving ones.
 * Amplitude falls as 1/√r, as for circular waves on a surface.
 */
export const RIPPLES_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uSrc[4];      // one source for each note clearly sounding (2 to 4)
uniform float uK[4];       // wavenumber, radians per pixel
uniform float uPhase[4];   // ω·t
uniform float uAmp[4];
uniform vec3 uCol[4];
uniform int uCount;
uniform float uUnit;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
// A change of design travels out from the centre as a wave front, as a new sound spreads from its source:
// the incoming design shows inside the front, the outgoing one outside it, with a soft equal-power edge.
uniform vec4 uReveal;   // (centre x, centre y, radius, half edge width), pixels
uniform float uSide;    // 0: everywhere; 1: inside the front only; -1: outside only
float reveal() {
  if (uSide == 0.0) return 1.0;
  float m = smoothstep(uReveal.z - uReveal.w, uReveal.z + uReveal.w, length(gl_FragCoord.xy - uReveal.xy));
  return uSide > 0.0 ? cos(m * 1.5707963) : sin(m * 1.5707963);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  float h = 0.0, total = 0.0;
  vec3 col = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    if (i >= uCount) break;
    float r = length(p - uSrc[i]);
    float fall = uAmp[i] / sqrt(1.0 + r / (0.08 * uUnit));
    h += fall * cos(uK[i] * r - uPhase[i]);
    total += fall;
    col += uCol[i] * fall;
    wsum += fall;
  }
  col /= max(wsum, 1e-5);
  float c = h / max(total, 1e-5);                 // -1..1
  float g = length(vec2(dFdx(c), dFdy(c)));
  // Crest lines: where the summed wave is near its own maximum.
  float crest = max(0.0, c);
  float line = pow(crest, 14.0) + 0.9 * exp(-pow((1.0 - crest) / max(g * uWidthPx * 1.5, 1e-4), 2.0)) * crest;
  float fadeOut = 1.0 - smoothstep(0.55, 0.75, length((p - 0.5 * (uSrc[0] + uSrc[1])) / uUnit));
  o = vec4(col * (line + 0.03 * crest) * fadeOut * uIntensity * reveal(), 1.0);
}`;

/**
 * MEMBRANE: a round drum skin. Its modes are Bessel functions J_n(j_n1·r)·cos(n(θ − φ)), where j_n1 is
 * the first zero of J_n, so the rim never moves. Mode n is driven by pitch range n (bass drives the
 * broad, few-lobed modes; treble the many-lobed ones). The lines are contours of the displaced skin:
 * nested outlines that bulge where the skin is pushed out.
 */
export const MEMBRANE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uBessel;     // row n: J_n(j_n1 r) / max, r = 0..1
uniform vec2 uCenterPx;
uniform float uRadius;
uniform float uAmp[9];
uniform float uTurn[9];        // orientation of each mode
uniform vec3 uColIn;
uniform vec3 uColOut;
uniform float uLines;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
// A change of design travels out from the centre as a wave front, as a new sound spreads from its source:
// the incoming design shows inside the front, the outgoing one outside it, with a soft equal-power edge.
uniform vec4 uReveal;   // (centre x, centre y, radius, half edge width), pixels
uniform float uSide;    // 0: everywhere; 1: inside the front only; -1: outside only
float reveal() {
  if (uSide == 0.0) return 1.0;
  float m = smoothstep(uReveal.z - uReveal.w, uReveal.z + uReveal.w, length(gl_FragCoord.xy - uReveal.xy));
  return uSide > 0.0 ? cos(m * 1.5707963) : sin(m * 1.5707963);
}
void main() {
  vec2 p = (gl_FragCoord.xy - uCenterPx) / uRadius;
  float r = length(p);
  if (r > 1.25) { o = vec4(0.0); return; }
  float th = r > 1e-4 ? atan(p.y, p.x) : 0.0; // atan(0, 0) is undefined
  float w = 0.0;
  for (int n = 0; n < 9; n++) {
    float J = texture(uBessel, vec2(min(r, 1.0), (float(n) + 0.5) / 9.0)).r;
    w += uAmp[n] * J * cos(float(n) * (th - uTurn[n]));
  }
  // Each outline is a ring of the skin at rest, moved outward by the displacement.
  float R = r - 0.22 * w;
  float t = R * uLines;
  float g = length(vec2(dFdx(t), dFdy(t)));
  float f = abs(fract(t + 0.5) - 0.5);
  float dist = f / max(g, 1e-4);
  float line = exp(-dist * dist / (uWidthPx * uWidthPx));
  float inside = 1.0 - smoothstep(0.92, 1.0, R);
  float k = clamp(R, 0.0, 1.0);
  vec3 col = mix(uColIn, uColOut, k);
  o = vec4(col * line * inside * step(0.04, R) * (0.55 + 0.45 * k) * uIntensity * reveal(), 1.0);
}`;

const REVEAL = /* glsl */ `
uniform vec4 uReveal;
uniform float uSide;
float reveal() {
  if (uSide == 0.0) return 1.0;
  float m = smoothstep(uReveal.z - uReveal.w, uReveal.z + uReveal.w, length(gl_FragCoord.xy - uReveal.xy));
  return uSide > 0.0 ? cos(m * 1.5707963) : sin(m * 1.5707963);
}`;

/**
 * FARADAY WAVES: a dish of liquid shaken up and down at a frequency grows standing waves on its surface
 * (Faraday 1831), answering at half the drive frequency. Their wavelength follows the dispersion of
 * capillary-gravity waves, ω² = g·k + (σ/ρ)·k³, so a lower drive gives longer waves. One drive frequency
 * gives squares; two give hexagons; more give 8- and 12-fold quasi-patterns (Edwards & Fauve 1994).
 * Here the drive is the music: the waves' directions come from the notes sounding, each with the
 * wavenumber its own frequency gives. Lines are the surface's nodal lines; crests catch the light.
 */
export const FARADAY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uCenterPx;
uniform float uRadius;
uniform int uDirs;          // number of wave directions (2 squares, 3 hexagons, 4 eight-fold, 6 twelve-fold)
uniform float uK[6];        // wavenumber of each direction, radians per pixel
uniform float uTurn;        // orientation of the pattern
uniform float uBreath;      // cos(Ω t): the surface rising and falling
uniform vec3 uColA;
uniform vec3 uColB;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
${REVEAL}
void main() {
  vec2 p = gl_FragCoord.xy - uCenterPx;
  float r = length(p) / uRadius;
  if (r > 1.08) { o = vec4(0.0); return; }
  float h = 0.0;
  for (int j = 0; j < 6; j++) {
    if (j >= uDirs) break;
    float a = uTurn + 3.14159265 * float(j) / float(uDirs);
    h += cos(uK[j] * dot(p, vec2(cos(a), sin(a))));
  }
  h /= float(uDirs);
  float g = max(fwidth(h), 1e-5);
  float nodal = exp(-pow(h / (g * uWidthPx), 2.0)) * 0.45;          // still lines: where the surface never moves
  float hb = h * uBreath;
  float crest = pow(max(hb, 0.0), 5.0) * 0.9;                        // light gathered by the rising crests
  float dish = 1.0 - smoothstep(0.94, 1.0, r);
  float rim = exp(-pow((r - 1.0) * uRadius / (1.5 * uWidthPx), 2.0)) * 0.25;
  // Crests in the strongest note's light, the still lines in the next note's.
  o = vec4((uColA * crest + uColB * nodal) * dish * uIntensity * reveal() + uColB * rim * uIntensity * reveal(), 1.0);
}`;

/**
 * STRINGS: one string for each note sounding, lowest on the left, each as long as a real string tuned to
 * that note would be beside the others (length ∝ 1 / frequency). A plucked string vibrates as a sum of its
 * harmonics, the n-th with amplitude ∝ sin(nπβ)/n², β being where it was plucked: near the end gives a
 * bright sound with strong upper harmonics, near the middle a mellow one. β comes from this sound's
 * brightness, so the strings move with the timbre heard. Each harmonic swings at n times the note's
 * frequency, slowed so the eye can follow; the light's trail draws the vibrating envelope.
 */
export const STRINGS_FS = /* glsl */ `#version 300 es
precision highp float;
uniform int uCount;
uniform float uX[6];        // each string's position, pixels
uniform float uLen[6];      // half its length, pixels
uniform float uAmp[6];      // how far it swings, pixels
uniform float uPhase[6];    // its fundamental's phase
uniform vec3 uCol[6];
uniform float uHarm[8];     // the harmonics' amplitudes (from where it was plucked)
uniform float uCy;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
${REVEAL}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    if (i >= uCount) break;
    float u = (px.y - uCy) / uLen[i] * 0.5 + 0.5;     // 0..1 along the string
    if (u < -0.02 || u > 1.02) continue;
    float uc = clamp(u, 0.0, 1.0);
    float d = 0.0;
    for (int n = 0; n < 8; n++) {
      float fn = float(n + 1);
      d += uHarm[n] * sin(fn * 3.14159265 * uc) * cos(fn * uPhase[i]);
    }
    float dist = abs(px.x - (uX[i] + d * uAmp[i]));
    float inside = smoothstep(-0.02, 0.0, u) * (1.0 - smoothstep(1.0, 1.02, u));
    float line = (exp(-dist * dist / (uWidthPx * uWidthPx)) + 0.05 / (1.0 + dist * dist / (30.0 * uWidthPx * uWidthPx)) * smoothstep(0.0, 0.08, uc) * (1.0 - smoothstep(0.92, 1.0, uc))) * inside;
    float near = exp(-pow((px.x - uX[i]) / (2.5 * uWidthPx), 2.0));   // the pegs at each end
    float ends = near * (exp(-pow(u * uLen[i] * 2.0 / (2.5 * uWidthPx), 2.0)) + exp(-pow((u - 1.0) * uLen[i] * 2.0 / (2.5 * uWidthPx), 2.0)));
    acc += uCol[i] * (line + 0.6 * ends);
  }
  o = vec4(acc * uIntensity * reveal(), 1.0);
}`;


/**
 * TONNETZ (Euler 1739; Riemann; Chew's spiral array): the twelve notes on a lattice where each step right is
 * a fifth, each step up-right a major third and up-left a minor third. A major or minor chord is a small
 * triangle; neighbouring chords share an edge. Notes light up as they sound, the edges between notes
 * sounding together draw the chord, and the view follows the harmony's centre of effect, so each song
 * draws the path of its own harmonic journey.
 */
export const TONNETZ_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uCenterPx;
uniform float uRadius;
uniform float uSpacing;       // pixels between neighbouring notes
uniform vec2 uCam;            // the view's centre, lattice plane (cartesian, in steps)
uniform float uW[12];         // how strongly each note sounds now
uniform vec3 uCol[12];
uniform vec2 uTrail[48];      // the harmony's recent path (cartesian, in steps), newest first
uniform int uTrailN;
uniform float uWidthPx;
uniform float uIntensity;
out vec4 o;
${REVEAL}
const vec2 E1 = vec2(1.0, 0.0);            // a fifth
const vec2 E2 = vec2(0.5, 0.8660254);      // a major third
int pcOf(vec2 ab) { return int(mod(7.0 * ab.x + 4.0 * ab.y, 12.0)); }
vec2 cart(vec2 ab) { return ab.x * E1 + ab.y * E2; }
float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec2 px = gl_FragCoord.xy - uCenterPx;
  float r = length(px) / uRadius;
  if (r > 1.0) { o = vec4(0.0); return; }
  vec2 q = px / uSpacing + uCam;
  float b0 = floor(q.y / 0.8660254), a0 = floor(q.x - 0.5 * b0 - 0.5);
  vec3 acc = vec3(0.0);
  float wpx = uWidthPx / uSpacing;
  for (int db = -1; db <= 2; db++) for (int da = -1; da <= 2; da++) {
    vec2 ab = vec2(a0 + float(da), b0 + float(db));
    vec2 c = cart(ab);
    int pc = pcOf(ab);
    float w = uW[pc];
    float d = length(q - c);
    // the note: a faint point always, a bright disc while it sounds
    float rad = 0.035 + 0.13 * w;
    acc += uCol[pc] * (0.10 * exp(-d * d / (0.0016)) + w * exp(-d * d / (rad * rad)) * 0.9);
    // edges to the next notes along the three axes, lit when both notes sound
    vec2 nb[3] = vec2[3](E1, E2, E2 - E1);
    for (int k = 0; k < 3; k++) {
      vec2 ab2 = ab + (k == 0 ? vec2(1.0, 0.0) : k == 1 ? vec2(0.0, 1.0) : vec2(-1.0, 1.0));
      int pc2 = pcOf(ab2);
      float ew = min(w, uW[pc2]);
      float ds = seg(q, c, c + nb[k]);
      acc += mix(uCol[pc], uCol[pc2], 0.5) * (0.03 * exp(-ds * ds / (wpx * wpx * 0.5)) + 1.2 * ew * exp(-ds * ds / (wpx * wpx * 2.0)));
    }
  }
  // the path the harmony has taken
  for (int i = 0; i + 1 < 48; i++) {
    if (i + 1 >= uTrailN) break;
    float ds = seg(q, uTrail[i], uTrail[i + 1]);
    float age = float(i) / 48.0;
    acc += vec3(0.9, 0.88, 0.82) * 0.5 * (1.0 - age) * exp(-ds * ds / (wpx * wpx * 1.5));
  }
  float edge = 1.0 - smoothstep(0.7, 1.0, r);
  o = vec4(acc * edge * uIntensity * reveal(), 1.0);
}`;
