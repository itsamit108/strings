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
  o = vec4(acc * edge * uIntensity * (0.45 + 0.55 * loud), 1.0);
}`;

/**
 * RINGS
 * A ring leaves the centre twice every beat and travels outward, so the
 * centre is "now" and the outer rings are the last four seconds.
 * Each ring keeps what the song was doing when it left: how bright (loudness),
 * how bold (a hit), what colour (the notes), and its shape. The twelve notes
 * sit around the circle like hours on a clock, and a ring bulges toward the
 * notes that were sounding.
 */
export const RINGS_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uHist;
uniform sampler2D uShape;
uniform vec2 uCenterPx;
uniform float uRmax;
uniform float uTime;
uniform float uRingT;
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
  float e = uTime - dd * ${HISTORY_SECONDS.toFixed(1)};  // when the sound at this pixel left the centre
  float t = e / uRingT;
  float g = length(vec2(dFdx(t), dFdy(t)));
  float f = abs(fract(t + 0.5) - 0.5);
  float dist = f / max(g, 1e-4);
  vec4 hc = texture(uHist, vec2(dd, 8.5 / ${HIST_ROWS.toFixed(1)}));
  float hit = texture(uHist, vec2(dd, 9.5 / ${HIST_ROWS.toFixed(1)})).r;
  float w = uWidthPx * (1.0 + 1.8 * hit);
  float line = exp(-dist * dist / (w * w)) + 0.1 / (1.0 + dist * dist / (25.0 * w * w));
  float alive = step(0.0, e) * (1.0 - smoothstep(0.78, 1.0, dd));
  o = vec4(hc.rgb * line * alive * (0.08 + 0.92 * hc.a) * (1.0 + 1.4 * hit) * uIntensity, 1.0);
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
  // Scintillation: each star flickers at its own rate, deeper when there is more treble.
  float tw = 1.0 + uTwinkle * (0.55 * sin(uTime * (2.0 + 6.0 * g.y) + 6.2832 * g.z) + 0.3 * sin(uTime * (7.0 + 9.0 * g.w) + 3.0 * g.y));
  return kelvin(temp) * core * (0.08 + 0.9 * mag) * gain * max(tw, 0.0) * (1.0 + 3.0 * hitWave(pos));
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
  vec2 flow = vec2(uFlow.x, uFlow.y) * uUnit;
  vec3 s = stars(turn(p, uRot) - flow * 1.6, uUnit / 14.0, uStarDensity, 0.9, band)
         + stars(turn(p, uRot * 0.55) - flow * 0.7 + 911.0, uUnit / 34.0, uStarDensity * 0.8, 0.45, band);
  return neb + s;
}
void main() {
  vec2 uv = gl_FragCoord.xy * uInvRes;
  vec3 light = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0).rgb;
  // Glow: the same light, blurred. Each layer is read at four nearby points so it stays smooth.
  vec2 r1 = uInvRes * 2.5, r2 = uInvRes * 7.0;
  vec3 near = textureLod(uAccum, uv + r1 * vec2(1.0, 0.4), 1.5).rgb + textureLod(uAccum, uv + r1 * vec2(-0.4, 1.0), 1.5).rgb
            + textureLod(uAccum, uv + r1 * vec2(-1.0, -0.4), 1.5).rgb + textureLod(uAccum, uv + r1 * vec2(0.4, -1.0), 1.5).rgb;
  vec3 wide = textureLod(uAccum, uv + r2 * vec2(1.0, 0.4), 3.0).rgb + textureLod(uAccum, uv + r2 * vec2(-0.4, 1.0), 3.0).rgb
            + textureLod(uAccum, uv + r2 * vec2(-1.0, -0.4), 3.0).rgb + textureLod(uAccum, uv + r2 * vec2(0.4, -1.0), 3.0).rgb;
  vec3 bloom = 0.2 * near + 0.1 * wide;
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
  o = vec4(col * (sand + loose + rim) * inside * uIntensity, 1.0);
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
  o = vec4(col * (line + 0.03 * crest) * fadeOut * uIntensity, 1.0);
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
  o = vec4(col * line * inside * step(0.04, R) * (0.55 + 0.45 * k) * uIntensity, 1.0);
}`;
