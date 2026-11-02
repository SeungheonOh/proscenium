/**
 * The isotopy.xyz intro as a window's opening: a beam
 * leaves a short strip at an edge of the screen, fans open toward the new
 * window, runs through blue, a color storm and a magenta grade with datamosh
 * and pixel-sort smears, then dissolves through an ordered dither while the
 * window settles as one-bit dither, which then dithers into the window itself.
 * On the site the mark is a 3D loop; here the window is the mark, and its own
 * pixels color the beam where it crosses it. It stays on the screen edge it
 * left from while the camera moves the window, and its pixels stay the site's
 * size on screen.
 *
 * The site renders at one Nth of the screen and keeps its previous frame for
 * the datamosh. An effect has no memory, so each pixel walks back through the
 * frames instead: while its block kept the last frame, it steps inward along
 * its ray, until a frame refreshed it or it leaves the beam.
 */

import { effectShader } from "proscenium";

/** Seconds of the site's intro, then of the dither into the window. */
export const INTRO = 4;
export const DURATION = INTRO + 0.6;

const SOURCE = `
float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float h11(float x){ return h21(vec2(x, 17.31)); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
float bayer2(vec2 a){ a = floor(a); return fract(dot(a, vec2(0.5, a.y * 0.75))); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a){ return bayer4(0.5 * a) * 0.25 + bayer2(a); }

const vec3 INK = vec3(18.0 / 255.0, 20.0 / 255.0, 23.0 / 255.0);
const vec3 FG = vec3(232.0 / 255.0, 236.0 / 255.0, 241.0 / 255.0);
float ease(float x){ x = clamp(x, 0.0, 1.0); return 1.0 - pow(1.0 - x, 3.0); }
float win(float t, float a, float b, float c, float d){ return smoothstep(a, b, t) * (1.0 - smoothstep(c, d, t)); }
vec3 blues(float s){ return s < 0.2 ? vec3(0.04, 0.09, 0.22) : s < 0.45 ? vec3(0.10, 0.30, 0.58) : s < 0.72 ? vec3(0.27, 0.56, 0.82) : vec3(0.70, 0.46, 0.38); }
vec3 mosaic(float t){ vec3 a = vec3(0.05, 0.12, 0.30), b = vec3(0.16, 0.38, 0.72), c = vec3(0.20, 0.72, 0.70), d = vec3(0.86, 0.86, 0.50), e = vec3(0.95, 0.92, 0.80);
  t = clamp(t, 0.0, 1.0); return t < 0.25 ? mix(a, b, t / 0.25) : t < 0.5 ? mix(b, c, (t - 0.25) / 0.25) : t < 0.75 ? mix(c, d, (t - 0.5) / 0.25) : mix(d, e, (t - 0.75) / 0.25); }
vec3 gmap(float l){ vec3 a = vec3(0.16, 0.07, 0.36), b = vec3(0.45, 0.12, 0.52), c = vec3(0.88, 0.30, 0.48), d = vec3(1.0, 0.60, 0.42), e = vec3(1.0, 0.88, 0.76);
  l = clamp(l, 0.0, 1.0); return l < 0.25 ? mix(a, b, l / 0.25) : l < 0.5 ? mix(b, c, (l - 0.25) / 0.25) : l < 0.75 ? mix(c, d, (l - 0.5) / 0.25) : mix(d, e, (l - 0.75) / 0.25); }
vec3 neon(float h){ return h < 0.22 ? vec3(0.30, 0.95, 1.0) : h < 0.42 ? vec3(0.25, 1.0, 0.72) : h < 0.6 ? vec3(1.0, 0.92, 0.35) : h < 0.78 ? vec3(1.0, 0.55, 0.22) : h < 0.9 ? vec3(0.45, 1.0, 0.40) : vec3(1.0, 0.30, 0.30); }

// Everything below is in low-resolution pixels: CELL local units each.
vec2 SRC; vec2 AXIS; float DIST0; float LO; float HI; float CELL; vec2 BOX;
// The point on the screen edge the beam leaves from, the edge's inward normal, and how far the beam reaches.
vec2 EDGE; vec2 NORMAL; float REACH;

// (shade, hit): the window's lightness at Q, and whether Q is on it.
vec2 windowAt(vec2 q){
  if (q.x < 0.0 || q.y < 0.0 || q.x > BOX.x || q.y > BOX.y) return vec2(0.0);
  vec4 c = content(q * CELL);
  if (c.a < 0.5) return vec2(0.0);
  return vec2(clamp(dot(c.rgb / c.a, vec3(0.299, 0.587, 0.114)), 0.0, 1.0), 1.0);
}
float rowOf(vec2 q, out float a, out float r){
  vec2 d = q - SRC; r = length(d) + 1e-4;
  a = atan(AXIS.x * d.y - AXIS.y * d.x, dot(AXIS, d));
  return floor(a * DIST0 / 2.0);
}
// Where the ray from the source through Q leaves the window's far side, or 0 if it misses it.
float reachOf(vec2 q){
  vec2 d = normalize(q - SRC);
  d = vec2(abs(d.x) < 1e-6 ? 1e-6 : d.x, abs(d.y) < 1e-6 ? 1e-6 : d.y);
  vec2 t0 = -SRC / d, t1 = (BOX - SRC) / d;
  vec2 lo = min(t0, t1), hi = max(t0, t1);
  float tn = max(lo.x, lo.y), tf = min(hi.x, hi.y);
  return tf > max(tn, 0.0) ? tf : 0.0;
}
// How far the fan has opened at T, 0 a needle and 1 the window's whole silhouette.
float openAt(float t){ return ease((t - 0.75) / 0.7); }
// Whether Q is inside the beam at time T. Opening, its rows waver as on the site; open,
// it is exactly the window as seen from the source, every ray ending at its far side.
float beamAt(vec2 q, float t){
  float a, r; float bin = rowOf(q, a, r);
  float open = openAt(t), settle = 1.0 - open;
  float waver = 1.0 + settle * (0.18 * (h11(bin * 0.13 + 1.0) - 0.5) + 0.06 * sin(r * 0.05 + t * 9.0));
  float lo = mix(-0.0025, LO, open) * waver, hi = mix(0.0025, HI, open) * waver;
  float exit = reachOf(q);
  float front = min(ease((t - 0.3) / 0.55) * REACH, exit);
  // the rays start at the screen edge they left from, so panning past it shows nothing behind
  return step(lo, a) * step(a, hi) * step(r, front) * step(0.5, exit)
    * step(0.0, dot(q - EDGE, NORMAL));
}
// What the beam shows at Q at time T, before lines and glows: the site's "fresh".
vec3 freshAt(vec2 q, float t, float fr, vec2 V){
  float pBlue = win(t, 0.7, 1.0, 1.7, 2.1), pStorm = win(t, 1.25, 1.55, 2.2, 2.55), pMag = win(t, 2.0, 2.35, 2.95, 3.35);
  float hit = V.y;
  vec2 bq = floor(q / 8.0) * 8.0 + 4.0;
  vec3 bg = mosaic(fbm(bq * 0.018 + vec2(-t * 0.6, 0.0) + h21(floor(q / 32.0)) * 0.4) * 1.15 - 0.1) * (0.55 + 0.6 * h21(floor(q / 4.0)));
  vec3 fresh = hit > 0.5 ? blues(V.x) : bg * (0.6 + 0.4 * pBlue);
  vec3 spk = mosaic(h21(q + fr * 1.37) * 0.8 + 0.1 * fbm(q * 0.05));
  vec3 storm = floor(clamp(mix(fresh, spk, 0.55) * 1.2, 0.0, 1.0) * 4.0 + 0.5) / 4.0;
  fresh = mix(fresh, storm, pStorm * (hit > 0.5 ? 0.45 : 0.85));
  float a, r; float bin = rowOf(q, a, r);
  float lum = hit > 0.5 ? 0.25 + 0.75 * V.x : 0.12 + 0.45 * fbm(vec2(r * 0.004 - t * 0.8, bin * 0.05));
  return mix(fresh, gmap(floor(lum * 6.0 + 0.5) / 6.0), pMag);
}
vec2 snap(vec2 q){ return floor(q) + 0.5; }

vec4 effect(vec2 position){
  vec4 world = content(position);
  // Where the window lies on the screen now, so the beam leaves the same screen edge
  // however the camera moves: laid out in output pixels as the site lays it out, then
  // taken into the window's own space.
  vec2 screen = output_size;
  float PIX = max(2.0, floor(min(screen.x, screen.y) / 300.0 + 0.5));
  float zoom = length(to_output(vec2(1.0, 0.0)) - to_output(vec2(0.0)));
  CELL = PIX / zoom; BOX = size / CELL;
  vec2 q = snap(position / CELL);
  float clock = time, t = min(clock, ${INTRO}.0), fr = floor(t * 30.0);
  vec2 edgeOut = edge.xy * screen, target = to_output(size * 0.5);
  float dist = length(target - edgeOut);
  vec2 T = (target - edgeOut) / dist;
  float emit = max(18.0, screen.y * 0.07), half_ = emit * 0.5 + 1.0, far = 0.0;
  vec2 corners[4];
  corners[0] = to_output(vec2(0.0)); corners[1] = to_output(vec2(size.x, 0.0));
  corners[2] = to_output(vec2(0.0, size.y)); corners[3] = to_output(size);
  for (int i = 0; i < 4; i++) {
    vec2 k = corners[i] - target;
    half_ = max(half_, abs(T.x * k.y - T.y * k.x));
  }
  // the source sits behind the edge, so the beam leaves the strip already as wide as it
  vec2 srcOut = edgeOut - T * (emit * 0.5 * dist / (half_ - emit * 0.5));
  for (int i = 0; i < 4; i++) far = max(far, length(corners[i] - srcOut));
  REACH = (far + 4.0) / PIX;
  SRC = from_output(srcOut) / CELL; EDGE = from_output(edgeOut) / CELL;
  NORMAL = normalize(from_output(edgeOut + edge.zw) / CELL - EDGE);
  AXIS = normalize(from_output(target) / CELL - SRC); DIST0 = length(from_output(target) / CELL - SRC);
  // the window's silhouette from the source: the angles of its corners about the axis
  LO = 10.0; HI = -10.0;
  for (int i = 0; i < 4; i++) {
    vec2 k = vec2(mod(float(i), 2.0), floor(float(i) / 2.0)) * BOX - SRC;
    float ak = atan(AXIS.x * k.y - AXIS.y * k.x, dot(AXIS, k));
    LO = min(LO, ak); HI = max(HI, ak);
  }
  float th = bayer8(q);
  // the window dithers in at the end
  if (th < clamp((clock - ${INTRO}.0) / 0.6, 0.0, 1.0) * 1.001) return world;
  vec2 V = windowAt(q);
  vec4 col = vec4(0.0);

  if (t < ${INTRO}.0) {
    float a, r; float bin = rowOf(q, a, r);
    vec2 dir = (q - SRC) / r;
    float inBeam = beamAt(q, t);
    float open = openAt(t);
    float front = min(ease((t - 0.3) / 0.55) * REACH, reachOf(q));
    float pNeedle = win(t, 0.3, 0.4, 0.9, 1.3), pBlue = win(t, 0.7, 1.0, 1.7, 2.1), pStorm = win(t, 1.25, 1.55, 2.2, 2.55);
    float pMag = win(t, 2.0, 2.35, 2.95, 3.35);
    if (inBeam > 0.5) {
      // datamosh: walk back through the frames this block kept, dragged outward along the ray
      vec2 p = q; float fk = fr, tk = t; bool ink = false;
      for (int i = 0; i < 24; i++) {
        float kStorm = win(tk, 1.25, 1.55, 2.2, 2.55), kMag = win(tk, 2.0, 2.35, 2.95, 3.35), kBlue = win(tk, 0.7, 1.0, 1.7, 2.1);
        vec2 blk = floor(p / (h21(floor(p / 48.0)) < 0.5 ? 8.0 : 16.0));
        float hb = h21(blk + fk * 0.731), hb2 = h21(blk * 1.7 + fk * 0.317);
        if (hb < 0.10 + 0.3 * kStorm + 0.25 * kMag) break;
        // two display frames to each of the site's 30 a second
        p = snap(p - normalize(p - SRC) * 2.0 * (2.0 + 9.0 * hb2) * (kBlue + kStorm + 0.7 * kMag));
        fk -= 1.0; tk = fk / 30.0;
        if (tk < 0.3 || beamAt(p, tk) < 0.5) { ink = true; break; }
      }
      vec3 c = ink ? INK : freshAt(p, tk, fk, p == q ? V : windowAt(p));
      // radial smears: some rows stretch their content along the ray
      float smearOn = step(0.62, h11(floor(bin / 2.0) + floor(fr / 3.0) * 7.0)) * (pStorm + pMag);
      if (smearOn > 0.0) {
        float L = 20.0 + 160.0 * h11(bin + 3.0);
        vec2 sp = snap(SRC + dir * floor(r / L) * L);
        c = mix(c, freshAt(sp, t, fr - 1.0, windowAt(sp)), 0.8 * min(smearOn, 1.0));
      }
      // glowing lines running along the beam
      float lineOn = step(0.93 - 0.05 * pStorm, h11(bin + 11.0));
      float segL = 80.0 + 260.0 * h11(bin + 13.0), speed = 300.0 + 900.0 * h11(bin + 17.0);
      float seg = fract((r - t * speed) / (segL * 3.0) + h11(bin + 19.0));
      float glow = lineOn * smoothstep(0.0, 0.05, seg) * smoothstep(0.45, 0.3, seg) * (pBlue * 0.5 + pStorm + 0.9 * pMag);
      vec3 lineCol = mix(neon(h11(bin + 23.0)), vec3(1.0, 0.62, 0.28), pMag);
      c = mix(c, lineCol, clamp(glow, 0.0, 1.0) * 0.85);
      // the needle core and the hot front
      float core = exp(-pow(a * r / 1.2, 2.0)) * pNeedle * 1.1;
      float frontGlow = exp(-max(front - r, 0.0) / 10.0) * step(r, front) * win(t, 0.3, 0.4, 1.0, 1.4);
      c += vec3(0.75, 0.95, 1.0) * (core + frontGlow * 0.8);
      // RGB fringe across row edges
      if (pStorm + pMag > 0.0) { vec2 fq = snap(q + dir * 2.0); c.r = mix(c.r, freshAt(fq, t, fr - 1.0, V).r, 0.35 * (pStorm + pMag)); }
      col = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
    // the emitter: a short glowing strip on the edge the rays leave from
    vec2 E = EDGE, eN = NORMAL, eT = vec2(-eN.y, eN.x), eq = q - E;
    vec2 pe = E + eT * dot(eq, eT) - SRC;
    float aE = atan(AXIS.x * pe.y - AXIS.y * pe.x, dot(AXIS, pe));
    float early = 0.25 * ease((t - 0.25) / 0.2);
    float onStrip = step(min(mix(-0.0025, LO, open), LO * early), aE) * step(aE, max(mix(0.0025, HI, open), HI * early));
    float strip = clamp(onStrip * exp(-max(dot(eq, eN), 0.0) / 2.5) * win(t, 0.25, 0.35, 2.9, 3.5), 0.0, 1.0);
    col = col * (1.0 - strip) + vec4(0.85, 0.97, 1.0, 1.0) * strip;
    // resolve: the beam dissolves through the dither while the window settles as one-bit dither
    float wb = smoothstep(2.75 + 0.5 * h11(bin * 0.5 + 31.0), 3.55 + 0.4 * h11(bin * 0.5 + 31.0), t);
    col *= step(th + 0.004, 1.0 - wb);
    float wl = smoothstep(2.55 + 0.55 * h11(floor(q.y / 3.0) + 41.0), 3.1 + 0.55 * h11(floor(q.y / 3.0) + 41.0), t);
    if (V.y > 0.5 && th < wl) col = vec4(mix(INK, FG, step(th + 0.002, V.x)), 1.0);
  } else if (V.y > 0.5) {
    col = vec4(mix(INK, FG, step(th + 0.002, V.x)), 1.0);
  }
  return col;
}
`;

export const isotopy = effectShader({
  uniforms: { amount: 1, edge: 4 },
  reads: { time: true, output: true },
  // The beam runs from a screen edge to the window, wherever the camera puts the two:
  // the effect may draw anywhere on the output.
  extent: { pixel: 8192 },
  gate: "amount",
  source: SOURCE,
});

type Vec2 = [number, number];
export type IsotopyUniforms = { amount: number; edge: [number, number, number, number] };
export interface ScreenRect { x: number; y: number; width: number; height: number }

/** An edge point the beam can leave from: far enough from the target, and facing it. */
function pickEdge(width: number, height: number, target: Vec2, random: () => number) {
  const sides: { n: Vec2; at: (s: number) => Vec2 }[] = [
    { n: [1, 0], at: (s) => [0, s * height] },
    { n: [-1, 0], at: (s) => [width, s * height] },
    { n: [0, 1], at: (s) => [s * width, 0] },
    { n: [0, -1], at: (s) => [s * width, height] },
  ];
  for (let i = 0; i < 200; i++) {
    const side = sides[Math.floor(random() * 4)]!;
    const at = side.at(0.08 + 0.84 * random());
    const dx = target[0] - at[0], dy = target[1] - at[1], d = Math.hypot(dx, dy);
    if (d < Math.min(width, height) * 0.45 || (dx * side.n[0] + dy * side.n[1]) / d < 0.55) continue;
    return { edge: at, n: side.n };
  }
  return { edge: [0, height / 2 + height * 0.2] as Vec2, n: [1, 0] as Vec2 };
}

/** A repeatable random sequence, so a window's beam leaves from the same edge on every render. */
export function seeded(seed: number): () => number {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The effect's uniforms for a window shown at RECT on an output WIDTH × HEIGHT,
 * in logical pixels: the screen edge its beam leaves from, which RANDOM picks
 * facing the window, as fractions of the output and the edge's inward normal.
 */
export function isotopyUniforms(rect: ScreenRect, width: number, height: number,
                                random: () => number): IsotopyUniforms {
  const target: Vec2 = [rect.x + rect.width / 2, rect.y + rect.height / 2];
  const { edge, n } = pickEdge(width, height, target, random);
  return { amount: 1, edge: [edge[0] / width, edge[1] / height, n[0], n[1]] };
}
