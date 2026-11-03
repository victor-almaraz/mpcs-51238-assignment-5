/**
 * GLSL ES 3.00 sources for the renderer (doc/visuals.md, Renderer).
 * Screen positions arrive in device pixels, origin top left. Fragment
 * outputs are premultiplied RGBA in sRGB encoding.
 */

const TO_CLIP = `
vec4 toClip(vec2 px, vec2 res) {
  vec2 c = px / res * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}`;

/** Instanced sprites: points (kind 0), rings (1), glyphs (2). */
export const SPRITE_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aPos;
layout(location = 2) in float aSize;
layout(location = 3) in float aWidth;
layout(location = 4) in vec4 aColor;
layout(location = 5) in float aGlyph;
uniform vec2 uRes;
uniform int uKind;
out vec2 vLocal;
out vec4 vColor;
out float vSize;
out float vWidth;
out float vGlyph;
${TO_CLIP}
void main() {
  float half_ = uKind == 0 ? aSize * 0.5 + 1.0 : uKind == 1 ? aSize + aWidth * 0.5 + 1.0 : aSize * 0.5;
  vLocal = aCorner * half_;
  vColor = aColor;
  vSize = aSize;
  vWidth = aWidth;
  vGlyph = aGlyph;
  gl_Position = toClip(aPos + vLocal, uRes);
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vLocal;
in vec4 vColor;
in float vSize;
in float vWidth;
in float vGlyph;
uniform int uKind;
uniform sampler2D uAtlas;
uniform float uAtlasCols;
out vec4 outColor;
void main() {
  float a;
  if (uKind == 0) {
    float r = vSize * 0.5;
    a = clamp(r + 0.5 - length(vLocal), 0.0, 1.0);
  } else if (uKind == 1) {
    float d = abs(length(vLocal) - vSize);
    a = clamp(vWidth * 0.5 + 0.5 - d, 0.0, 1.0);
  } else {
    vec2 uv = vLocal / vSize + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    float col = mod(vGlyph, uAtlasCols);
    float row = floor(vGlyph / uAtlasCols);
    a = texture(uAtlas, (vec2(col, row) + uv) / uAtlasCols).r;
  }
  a *= vColor.a;
  if (a <= 0.0) discard;
  outColor = vec4(vColor.rgb * a, a);
}`;

/** Instanced line segments. */
export const SEGMENT_VS = `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aEnds;
layout(location = 2) in float aWidth;
layout(location = 3) in vec4 aColor;
uniform vec2 uRes;
out float vDist;
out float vWidth;
out vec4 vColor;
${TO_CLIP}
void main() {
  vec2 p0 = aEnds.xy, p1 = aEnds.zw;
  vec2 d = p1 - p0;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float halfW = aWidth * 0.5 + 1.0;
  float t = aCorner.x * 0.5 + 0.5;
  vec2 p = mix(p0, p1, t) + n * aCorner.y * halfW;
  vDist = aCorner.y * halfW;
  vWidth = aWidth;
  vColor = aColor;
  gl_Position = toClip(p, uRes);
}`;

export const SEGMENT_FS = `#version 300 es
precision highp float;
in float vDist;
in float vWidth;
in vec4 vColor;
out vec4 outColor;
void main() {
  float a = clamp(vWidth * 0.5 + 0.5 - abs(vDist), 0.0, 1.0) * vColor.a;
  if (a <= 0.0) discard;
  outColor = vec4(vColor.rgb * a, a);
}`;

/** Full-screen triangle. */
export const FULLSCREEN_VS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }`;

export const FIELD_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec3 uStops[3];
uniform float uValue;
uniform float uOpacity;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
vec3 cmap(float t) {
  t = clamp(t, 0.0, 1.0) * 2.0;
  return t < 1.0 ? mix(uStops[0], uStops[1], t) : mix(uStops[1], uStops[2], t - 1.0);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = mix(uValue * 0.5, uValue, uv.y) + (noise(uv * 6.0) - 0.5) * 0.06;
  float a = uOpacity;
  outColor = vec4(cmap(t) * a, a);
}`;

/** Aurora band. uMode: 0 orbital (top), 1 map (±65°), 2 sky (northern horizon). */
export const AURORA_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uMode;
uniform vec4 uRect;      // map rect: x, y (top-left origin), width, height
uniform float uSkyR;
uniform float uPhase;
uniform float uIntensity;
uniform float uOpacity;
out vec4 outColor;
const float TAU = 6.2831853;
// One curtain (doc/visuals.md, Property meanings). s: position along the band, 0–1; e0: distance
// in pixels above the base line, toward the pole; height: fade length. Returns brightness and the
// green-to-violet mix.
vec2 curtain(float s, float e0, float height) {
  float wave = (sin(TAU * (s * 3.0 + uPhase)) * 0.35 + sin(TAU * (s * 7.0 - uPhase * 1.7)) * 0.15) * height * 0.5;
  float e = e0 - wave;
  float edge = height * 0.05;
  float glow = e < 0.0 ? exp(-(e * e) / (edge * edge)) : exp(-e / height);
  float line = exp(-(e * e) / (edge * edge * 1.5));
  float r = 0.5 + 0.5 * sin(TAU * (s * 83.0 + uPhase * 0.6)) * sin(TAU * (s * 31.0 - uPhase * 0.4) + 1.0);
  float rays = 0.35 + 0.65 * smoothstep(0.25, 0.95, r);
  float up = clamp(e / height, 0.0, 1.0);
  return vec2(glow * (1.0 - up * (1.0 - rays)) + 0.5 * line, clamp(e / (height * 1.6), 0.0, 1.0));
}
void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y); // top-left origin
  vec2 c = vec2(0.0);
  if (uMode == 0) {
    c = curtain(px.x / uRes.x, uRes.y * 0.22 - px.y, uRes.y * 0.08);
  } else if (uMode == 1) {
    float s = (px.x - uRect.x) / uRect.z;
    if (s >= 0.0 && s <= 1.0) {
      float height = uRect.w * (10.0 / 180.0);
      vec2 n = curtain(s, uRect.y + (0.5 - 60.0 / 180.0) * uRect.w - px.y, height);
      vec2 so = curtain(s + 0.37, px.y - (uRect.y + (0.5 + 60.0 / 180.0) * uRect.w), height);
      c = n.x >= so.x ? n : so;
    }
  } else {
    vec2 rel = px - uRes * 0.5;
    float theta = atan(-rel.x, -rel.y);
    float lim = radians(70.0);
    if (abs(theta) < lim) {
      c = curtain(theta / (2.0 * lim) + 0.5, uSkyR * 0.9 - length(rel), uSkyR * 0.12);
      c.x *= 1.0 - smoothstep(lim * 0.7, lim, abs(theta));
    }
  }
  vec3 col = mix(vec3(0.24, 1.0, 0.6), vec3(0.54, 0.36, 1.0), c.y);
  float a = clamp(c.x * uIntensity * uOpacity * 0.85, 0.0, 1.0);
  outColor = vec4(col * a, a);
}`;

/**
 * Wraps a user `mainImage` shader.
 * @param {string} glsl
 */
export function userShaderSource(glsl) {
  return `#version 300 es
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform float uOpacity;
out vec4 sphaerenmusikOut;
${glsl}
void main() {
  vec4 c = vec4(0.0);
  mainImage(c, gl_FragCoord.xy);
  c = clamp(c, 0.0, 1.0);
  float a = c.a * uOpacity;
  sphaerenmusikOut = vec4(c.rgb * a, a);
}`;
}

const SRGB_FNS = `
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }`;

/**
 * Desaturation and the flash guard's limit on change. uStep < 0 disables the limit.
 * uQuantize = 1 when the output target is 8-bit: a limited step then rounds toward
 * the previous frame, so storage rounding never enlarges it.
 */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform float uDesat;
uniform float uStep;
uniform float uQuantize;
out vec4 outColor;
${SRGB_FNS}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 lin = toLinear(texture(uScene, uv).rgb);
  float y = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin = mix(lin, vec3(y), uDesat);
  if (uStep < 0.0) {
    outColor = vec4(toSrgb(clamp(lin, 0.0, 1.0)), 1.0);
    return;
  }
  vec3 prevS = texture(uPrev, uv).rgb;
  vec3 prev = toLinear(prevS);
  vec3 s = toSrgb(clamp(prev + clamp(lin - prev, -uStep, uStep), 0.0, 1.0));
  if (uQuantize > 0.5) {
    vec3 code = s * 255.0;
    vec3 prevCode = floor(prevS * 255.0 + 0.5);
    s = mix(ceil(code), floor(code), step(prevCode, code)) / 255.0;
  }
  outColor = vec4(s, 1.0);
}`;

export const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uRes;
out vec4 outColor;
void main() { outColor = vec4(texture(uSrc, gl_FragCoord.xy / uRes).rgb, 1.0); }`;

/**
 * Guard box pass: the mean linear RGB of the whole pixels in each box of a
 * uDst grid. Pixel x belongs to box floor(x · dst / src), so every pixel counts once.
 */
export const GUARD_BOX_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
out vec4 outColor;
${SRGB_FNS}
void main() {
  ivec2 src = ivec2(uSrcSize);
  ivec2 dst = ivec2(uDstSize);
  ivec2 id = ivec2(gl_FragCoord.xy);
  ivec2 a = (id * src + dst - 1) / dst;
  ivec2 b = ((id + 1) * src + dst - 1) / dst;
  vec3 sum = vec3(0.0);
  for (int y = a.y; y < b.y; y++) {
    for (int x = a.x; x < b.x; x++) sum += toLinear(texelFetch(uSrc, ivec2(x, y), 0).rgb);
  }
  int n = (b.x - a.x) * (b.y - a.y);
  outColor = vec4(n > 0 ? sum / float(n) : vec3(0.0), 1.0);
}`;

/**
 * Guard cell pass: each cell of the guard grid averages its 8×8 boxes, weighted
 * by their pixel counts. uRowOffset places the grid in the shared readback target.
 */
export const GUARD_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBoxes;
uniform vec2 uSrcSize;
uniform vec2 uBoxSize;
uniform float uRowOffset;
out vec4 outColor;
void main() {
  ivec2 src = ivec2(uSrcSize);
  ivec2 box = ivec2(uBoxSize);
  ivec2 cell = ivec2(gl_FragCoord.xy) - ivec2(0, int(uRowOffset));
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      ivec2 id = cell * 8 + ivec2(i, j);
      ivec2 a = (id * src + box - 1) / box;
      ivec2 b = ((id + 1) * src + box - 1) / box;
      float n = float((b.x - a.x) * (b.y - a.y));
      sum += texelFetch(uBoxes, id, 0).rgb * n;
      total += n;
    }
  }
  outColor = vec4(total > 0.0 ? sum / total : vec3(0.0), 1.0);
}`;
