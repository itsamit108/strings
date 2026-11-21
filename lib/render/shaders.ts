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
out vec4 o;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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
  vec3 col = pow(clamp(bg + mapped, 0.0, 1.0), vec3(1.0 / 2.2));
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}`;
