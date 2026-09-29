// Salmon ShaderMaterial. Two placement modes share the swimming, colouring and lighting code:
//   SCHOOL  — InstancedBufferGeometry; every fish is placed on the GPU from per-slot school uniforms (centre, heading,
//             radius, mill/bag state) plus static per-fish offsets, so thousands of fish cost the CPU a few uniform
//             writes. LOD_NEAR / LOD_FAR split fish by distance to the camera.
//   JUMPER  — InstancedMesh with CPU instance matrices (jumping fish, chum finning at the surface).
// Vertex-shader swimming: a travelling body wave growing toward the tail, tail beat, C-curl, roll; pink humps.
// Ocean-bright species colouring in the fragment shader from fish-local coordinates. Lighting follows the scene's sun
// and hemisphere lights, with a mirror-silver flank reflecting the sky (or the water column below the surface).
// SPEC §4.3: fog chunks, kodiak_underwater, tone mapping + colour space at the end.

import * as THREE from 'three';

export const SLOTS = 8;

// Ocean-bright colours (sRGB). Index = SPECIES_INDEX.
const LOOK = {
  back: ['#2c515d', '#465f55', '#1f4677', '#2d4f67', '#3a5452'],
  flank: ['#c8d2d6', '#c3cbc6', '#d6dde2', '#cfd7dc', '#c2cac8'],
  belly: '#eef1f1',
  fin: ['#3a4448', '#3e4540', '#35404a', '#3a444a', '#3b433f'],
  bar: '#6d6a58',
  spot: '#16191b',
};

const COMMON_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <kodiak_underwater_pars_vertex>
attribute float aPart;
uniform float uTime;
uniform float uSpeciesLen[5];
varying vec3 vLocal;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vPart;
varying float vSpecies;
varying float vSeed;
varying float vWet;

mat3 fishBasis(float heading, float pitch, float roll) {
  float ch = cos(heading), sh = sin(heading);
  float cp = cos(pitch), sp = sin(pitch);
  float cr = cos(roll), sr = sin(roll);
  mat3 Y = mat3(vec3(ch, 0.0, sh), vec3(0.0, 1.0, 0.0), vec3(-sh, 0.0, ch));
  mat3 X = mat3(vec3(1.0, 0.0, 0.0), vec3(0.0, cp, sp), vec3(0.0, -sp, cp));
  mat3 Z = mat3(vec3(cr, sr, 0.0), vec3(-sr, cr, 0.0), vec3(0.0, 0.0, 1.0));
  return Y * X * Z;
}

// Body wave + C-curl + pink hump, in unit fish space. Returns the displaced position; rotates n.
vec3 swim(vec3 p, inout vec3 n, float beatHz, float beatAmp, float bend, float phase, float hump) {
  float s = clamp(p.z + 0.5, 0.0, 1.0);
  float env = 0.1 + 0.9 * s * s;
  float amp = 0.03 * beatAmp;
  float w = 6.2831853 * (beatHz * uTime + phase) - s * 5.4;
  float lat = amp * env * sin(w) + bend * (s - 0.3) * abs(s - 0.3) * 0.55;
  float slope = amp * (env * -5.4 * cos(w) + 1.8 * s * sin(w)) + bend * abs(s - 0.3) * 1.1;
  p.x += lat;
  float a = -atan(slope);
  float ca = cos(a), sa = sin(a);
  n = vec3(ca * n.x + sa * n.z, n.y, -sa * n.x + ca * n.z);
  if (hump > 0.0 && p.y > 0.0 && aPart < 2.5) {
    float bell = smoothstep(0.08, 0.3, s) * (1.0 - smoothstep(0.36, 0.62, s));
    p.y *= 1.0 + hump * 0.75 * bell;
  }
  return p;
}
`;

const SCHOOL_VERT = /* glsl */ `
attribute vec4 aFishA; // unit offset xyz, rank
attribute vec4 aFishB; // random, speed jitter, size jitter, slot
uniform vec4 uSlotA[${SLOTS}]; // centre xyz, radius
uniform vec4 uSlotB[${SLOTS}]; // heading, speed, thickness, fill
uniform vec4 uSlotC[${SLOTS}]; // mill 0..1, thrash 0..1, presence, bag drying 0..1
uniform vec4 uSlotD[${SLOTS}]; // cumulative species mix: pink, +chum, +sockeye, +coho (king = rest)
uniform vec4 uSlotE[${SLOTS}]; // bag ellipse angle, b/a, hump, mill direction
uniform float uLodDist;
uniform float uMaxDist;

void main() {
  int slot = int(aFishB.w + 0.5);
  vec4 A = uSlotA[slot];
  vec4 B = uSlotB[slot];
  vec4 C = uSlotC[slot];
  vec4 D = uSlotD[slot];
  vec4 E = uSlotE[slot];
  if (aFishA.w >= B.w * C.z) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float u = aFishB.x;
  float jit = aFishB.y;
  float species = u < D.x ? 0.0 : u < D.y ? 1.0 : u < D.z ? 2.0 : u < D.w ? 3.0 : 4.0;
  float len = uSpeciesLen[int(species)] * (0.88 + 0.24 * aFishB.z);
  float t = uTime;
  float ph = u * 43.7;
  float R = A.w;
  float thick = B.z;
  vec3 o = aFishA.xyz;
  // Migrating: a school elongated along its heading, every fish roughly parallel.
  vec2 fwd = vec2(sin(B.x), -cos(B.x));
  vec2 rgt = vec2(cos(B.x), sin(B.x));
  vec2 wob = vec2(sin(t * 0.21 + ph), cos(t * 0.17 + ph * 1.3)) * 0.1;
  R *= 0.78;
  vec2 lm = (o.x + wob.x) * 0.6 * R * rgt + (o.z + wob.y) * R * fwd;
  vec3 pMig = vec3(lm.x, o.y * thick * 0.5, lm.y);
  vec2 dMig = normalize(fwd + rgt * 0.18 * sin(t * (0.6 + jit) + ph));
  // Milling: a slowly turning doughnut.
  float msign = E.w < 0.0 ? -1.0 : 1.0;
  float a0 = atan(o.z, o.x);
  float a = a0 + t * msign * (0.5 + 0.45 * jit) / max(mix(0.22, 0.92, length(o.xz)) * R, 2.0);
  // A living mill: the ring breathes, bulges into lobes and drifts, so it never reads as a perfect doughnut.
  float lobe = 1.0 + 0.22 * sin(2.0 * a + t * 0.05 + E.w) + 0.12 * sin(3.0 * a - t * 0.07);
  float rr = (mix(0.2, 0.95, length(o.xz)) + 0.12 * sin(t * (0.23 + 0.2 * jit) + ph)) * R * lobe;
  vec3 pMil = vec3(cos(a) * rr, o.y * thick * 0.5, sin(a) * rr);
  vec2 dMil = normalize(vec2(-sin(a), cos(a)) * msign + 0.25 * vec2(sin(t * 0.8 + ph), cos(t * 0.7 + ph * 1.7)));
  float mill = C.x;
  vec3 lp = mix(pMig, pMil, mill);
  vec2 dir = normalize(mix(dMig, dMil, mill) + vec2(1e-4, 0.0));
  float pitch = 0.08 * sin(t * (0.9 + jit) + ph * 2.0);
  float roll = 0.28 * sin(t * (0.7 + 0.8 * jit) + ph);
  float thrash = C.y;
  float beatHz = mix(2.1, 3.4, jit) * mix(1.0, 1.8, B.y);
  float beatAmp = 1.0 + 0.4 * B.y;
  vec3 centre = A.xyz;
  if (thrash > 0.0) {
    // Crowded in a drying bag: packed into the ellipse, rolling, flipping, boiling at the surface.
    float ca = cos(E.x), sa = sin(E.x);
    vec2 q = o.xz * (0.92 + 0.08 * sin(t * 1.3 + ph));
    vec2 e = vec2(q.x * A.w, q.y * A.w * E.y);
    vec2 bxz = vec2(e.x * ca - e.y * sa, e.x * sa + e.y * ca);
    float layer = (o.y * 0.5 + 0.5);
    float by = -(0.12 + layer * max(0.25, -A.y * 1.6));
    float pop = smoothstep(0.82, 1.0, sin(t * (0.9 + 1.4 * jit) + ph * 3.0)) * step(0.45, jit) * C.w;
    by = mix(by, 0.02, pop);
    vec3 pBag = vec3(bxz.x, by - A.y, bxz.y);
    lp = mix(lp, pBag, clamp(thrash * 3.0, 0.0, 1.0));
    float da = ph * 6.2831 + t * (0.6 + 1.6 * jit) * (fract(u * 7.0) < 0.5 ? 1.0 : -1.0) + 1.3 * sin(t * (2.0 + 2.0 * jit) + ph);
    dir = normalize(mix(dir, vec2(sin(da), -cos(da)), clamp(thrash * 2.0, 0.0, 1.0)));
    roll += thrash * 1.35 * sin(t * (2.2 + 3.0 * jit) + ph) + pop * 1.2;
    pitch += thrash * 0.5 * sin(t * (1.7 + 2.0 * jit) + ph * 2.0) + pop * 0.5;
    beatHz = mix(beatHz, 7.5 + 4.0 * jit, thrash);
    beatAmp = mix(beatAmp, 2.4, thrash);
  }
  centre += lp;
  // Only the bag breaks the surface; free-swimming fish stay a metre down even at the top of a thick school.
  if (thrash <= 0.0) centre.y = min(centre.y, -1.0);
  float dist = distance(centre, cameraPosition);
#ifdef LOD_NEAR
  if (dist > uLodDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#else
  if (dist <= uLodDist || dist > uMaxDist) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
#endif
  float heading = atan(dir.x, -dir.y);
  float hump = (species < 0.5 && aFishB.z > 0.5) ? E.z : 0.0;
  vec3 n = normal;
  vec3 p = swim(position, n, beatHz, beatAmp, 0.0, ph, hump);
  mat3 Rm = fishBasis(heading, pitch, roll);
  vec3 wp = centre + Rm * (p * len);
  vNormalW = normalize(Rm * n);
  vWorldPos = wp;
  vLocal = position;
  vPart = aPart;
  vSpecies = species;
  vSeed = u;
  vWet = thrash;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
  #include <kodiak_underwater_vertex>
}
`;

const JUMPER_VERT = /* glsl */ `
attribute vec4 aJumpA; // species, bend, beat Hz, beat amplitude
attribute vec4 aJumpB; // seed, hump, wetness, unused

void main() {
  vec3 n = normal;
  vec3 p = swim(position, n, aJumpA.z, aJumpA.w, aJumpA.y, aJumpB.x * 17.0, aJumpB.y);
  vec4 wp4 = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vec3 wp = wp4.xyz;
  vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  vWorldPos = wp;
  vLocal = position;
  vPart = aPart;
  vSpecies = aJumpA.x;
  vSeed = aJumpB.x;
  vWet = aJumpB.z;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
  #include <kodiak_underwater_vertex>
}
`;

const FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <kodiak_underwater_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform float uEnvScale;
uniform vec3 uBack[5];
uniform vec3 uFlank[5];
uniform vec3 uFin[5];
uniform vec3 uBelly;
uniform vec3 uBar;
uniform vec3 uSpotColor;
#ifdef USE_KENV
uniform sampler2D envMap;
#include <cube_uv_reflection_fragment>
#endif
varying vec3 vLocal;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vPart;
varying float vSpecies;
varying float vSeed;
varying float vWet;

// Arithmetic hash (no sin): cheap and stable across GPUs.
vec2 hash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Irregular round/oval spots. The domain is squeezed along x (stretch < 1 = ovals along the body); spot centres are
// jittered within the middle half of their cell and radii stay <= 0.36 cell, so the 2x2 block of cells around p
// always contains the nearest spot.
float spots(vec2 p, float size, float stretch, float seed) {
  p.x *= stretch;
  vec2 i = floor(p - 0.5);
  vec2 f = p - 0.5 - i;
  float m = 8.0;
  for (int y = 0; y <= 1; y++) {
    for (int x = 0; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 h = hash2(i + g + seed);
      vec2 d = g - 0.25 + 0.5 * h - f;
      float r = min(0.36, size * (0.6 + 0.6 * h.x));
      m = min(m, length(d) / r);
    }
  }
  float w = max(fwidth(m), 0.05);
  return 1.0 - smoothstep(1.0 - w, 1.0 + w, m);
}

float D_GGX(float a, float NoH) {
  float a2 = a * a;
  float d = NoH * NoH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

vec3 envColor(vec3 r, float under, float rough) {
  float up = clamp(r.y, -1.0, 1.0);
  vec3 sky = mix(uHorizonColor, uSkyColor, sqrt(max(up, 0.0)));
#ifdef USE_KENV
  // Fully submerged fish only mirror the water column: skip the env fetch for them.
  if (under < 0.999) sky = textureCubeUV(envMap, vec3(r.x, max(r.y, 0.02), r.z), rough).rgb;
#endif
  vec3 sea = mix(uHorizonColor * 0.3, uWaterScatter * 0.6, smoothstep(0.0, 0.35, -up));
  vec3 above = mix(sky, sea, smoothstep(0.0, 0.08, -up));
  // Below the surface the flank mirrors the bright surface overhead and the dark water column around it.
  vec3 below = up >= 0.0 ? mix(uWaterScatter * 1.3, uSkyColor * 0.55, smoothstep(0.45, 0.97, up)) : uWaterScatter * 0.3;
  return mix(above, below, under) * uEnvScale;
}

void main() {
  int sp = int(vSpecies + 0.5);
  vec3 lp = vLocal;
  float s = lp.z + 0.5;
  float y = lp.y;
  float part = vPart;
  vec3 back = uBack[sp];
  vec3 flank = uFlank[sp];
  float lat = 0.006 - 0.012 * s;
  // Narrow dark back, broad mirror-silver flank, white belly.
  float backT = smoothstep(lat + 0.018, lat + 0.062, y + 0.006 * sin(s * 23.0 + vSeed * 9.0));
  float bellyT = (1.0 - smoothstep(lat - 0.08, lat - 0.035, y));
  vec3 albedo = mix(flank, back, backT);
  albedo = mix(albedo, uBelly, bellyT);
  // Mirror silver, but not chrome: a little diffuse body colour keeps the form readable.
  float metal = mix(0.82, 0.35, backT) * (1.0 - 0.25 * bellyT);
  float rough = mix(0.2, 0.42, backT);
  float spot = 0.0;
  vec2 sp2 = vec2(lp.z, lp.y);
#if defined( SCHOOL ) && !defined( LOD_NEAR )
  // Far school fish: a few pixels each; countershading only.
  if (part > 0.5) {
    albedo = uFin[sp];
    metal = 0.2;
    rough = 0.45;
  }
#else
  if (part < 0.5) {
    if (sp == 0) spot = spots(sp2 * 26.0, 0.3, 0.62, vSeed * 13.0) * smoothstep(0.1, 0.45, backT) * smoothstep(0.3, 0.7, s);
    else if (sp == 3) spot = spots(sp2 * 46.0, 0.26, 1.0, vSeed * 7.0) * smoothstep(0.55, 0.9, backT) * smoothstep(0.25, 0.5, s);
    else if (sp == 4) spot = spots(sp2 * 34.0, 0.3, 0.85, vSeed * 5.0) * smoothstep(0.35, 0.8, backT);
    else if (sp == 2) spot = 0.25 * spots(sp2 * 70.0, 0.18, 1.0, vSeed) * smoothstep(0.7, 1.0, backT);
    if (sp == 1) {
      // Chum: faint vertical bars on the flank (the ocean-bright ghost of the spawning calico).
      float bars = smoothstep(0.45, 0.9, sin(s * 40.0 + sin(y * 38.0 + s * 5.0) * 0.45));
      bars *= (1.0 - backT) * (1.0 - bellyT) * smoothstep(0.2, 0.32, s) * (1.0 - smoothstep(0.66, 0.8, s));
      albedo = mix(albedo, uBar, bars * 0.2);
      metal *= 1.0 - bars * 0.15;
    }
    // Gill cover edge and lateral line.
    float gill = 1.0 - smoothstep(0.0, 0.006, abs(s - 0.165 - 0.3 * y * y * 30.0));
    gill *= step(abs(y), 0.07);
    albedo *= 1.0 - 0.28 * gill;
    float ll = (1.0 - smoothstep(0.0, 0.0035, abs(y - lat))) * smoothstep(0.2, 0.3, s) * (1.0 - smoothstep(0.8, 0.95, s));
    albedo *= 1.0 - 0.15 * ll;
    // Eye.
    vec2 ed = vec2(s - 0.066, y - 0.014);
    float er = length(ed);
    float side = smoothstep(0.004, 0.012, abs(lp.x));
    float iris = (1.0 - smoothstep(0.012, 0.015, er)) * side;
    float pupil = (1.0 - smoothstep(0.0065, 0.0085, er)) * side;
    albedo = mix(albedo, vec3(0.55, 0.52, 0.42), iris);
    albedo = mix(albedo, vec3(0.01), pupil);
    metal = mix(metal, 0.2, iris);
    rough = mix(rough, 0.08, pupil);
    // Dark snout tip and back line.
    albedo *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, s));
  } else if (part < 1.5) {
    albedo = uFin[sp];
    metal = 0.05;
    rough = 0.7;
    if (sp == 0 || sp == 3 || sp == 4) spot = 0.8 * spots(sp2 * 40.0, 0.28, 1.0, vSeed * 3.0) * step(0.02, y);
  } else if (part < 2.5) {
    // Caudal fin: dusky, darker toward the trailing edge; never mirror-bright.
    albedo = uFin[sp] * mix(0.95, 0.6, smoothstep(0.42, 0.5, lp.z));
    metal = 0.05;
    rough = 0.72;
    // Tail spots: pink big black ovals on both lobes, coho the upper lobe only, king both lobes, chum silver streaks.
    if (sp == 0) spot = spots(sp2 * 20.0, 0.3, 0.6, vSeed * 11.0);
    else if (sp == 3) spot = spots(sp2 * 42.0, 0.3, 0.8, vSeed * 2.0) * smoothstep(0.0, 0.03, y);
    else if (sp == 4) spot = spots(sp2 * 40.0, 0.3, 0.8, vSeed * 4.0);
  } else {
    albedo = mix(uFlank[sp], uBelly, 0.4) * 0.85;
    metal = 0.1;
    rough = 0.55;
  }
  albedo = mix(albedo, uSpotColor, spot * 0.92);
  metal *= 1.0 - spot;
  rough = mix(rough, 0.5, spot);
#endif

#if defined( SCHOOL ) && !defined( LOD_NEAR )
  float sheen = 1.0;
#else
  // Scale sheen: fine diamond lattice modulating the mirror, faded out before it can alias.
  vec2 sc = vec2(lp.z * 260.0, lp.y * 170.0);
  float lattice = abs(sin(sc.x + sc.y)) * abs(sin(sc.x - sc.y));
  float aa = 1.0 - smoothstep(0.4, 1.2, fwidth(sc.x));
  float sheen = mix(1.0, 0.8 + 0.35 * lattice, aa * (1.0 - backT) * step(part, 0.5));
#endif
  rough = max(0.06, rough - vWet * 0.12 * (1.0 - step(0.5, part)));

  vec3 N = normalize(vNormalW);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(uSunDir);
  float under = (1.0 - smoothstep(-0.25, 0.02, vWorldPos.y));
  // Refracted, scattered sunlight under the surface: broad and soft, never a crisp specular rim.
  rough = mix(rough, max(rough, 0.55), under);
  // Sunlight reaching the fish through the water above it.
  vec3 sunAtt = exp(-uWaterAbsorb * max(0.0, -vWorldPos.y) * 1.25);
  vec3 sun = uSunRadiance * sunAtt * step(0.0, L.y);
#ifdef SCHOOL
  // Cruising schools are shadows under the surface: the broken, scattered sun reaching them is weak and cold (the
  // warm low sun must not paint them orange). The drying bag (vWet) keeps full sun for the money shot.
  float school = under * (1.0 - clamp(vWet * 3.0, 0.0, 1.0));
  sun *= mix(vec3(1.0), vec3(0.45, 0.58, 0.64), school);
#endif
  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-3);
  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  float hemiW = 0.5 + 0.5 * N.y;
  vec3 hemi = mix(uHemiGround, uHemiSky, hemiW);
  hemi = mix(hemi, uWaterScatter * 2.2 * (0.35 + 0.65 * hemiW), under * 0.7);
  vec3 F0 = mix(vec3(0.04), mix(albedo, vec3(0.94, 0.96, 0.98), 0.55), metal);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - VoH, 5.0);
  float a = rough * rough;
  float k = a * 0.5;
  float Vis = 0.25 / max((NoL * (1.0 - k) + k) * (NoV * (1.0 - k) + k), 0.05);
  vec3 spec = sun * NoL * D_GGX(max(a, 0.01), NoH) * Vis * F * sheen * (1.0 - 0.75 * under);
  vec3 diffuse = albedo * (1.0 - metal) * (sun * NoL + hemi) * RECIPROCAL_PI;
  vec3 R = reflect(-V, N);
  vec3 Fe = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - NoV, 5.0);
  // Thin-film hint on the silver: faint rose/green shift with angle.
  vec3 irid = 1.0 + 0.07 * cos(6.2831853 * (NoV * 1.3 + vec3(0.0, 0.33, 0.67)));
  vec3 envc = envColor(R, under, rough) * Fe * sheen * mix(vec3(1.0), irid, metal) * mix(1.0, 0.45, backT * under);
  vec3 col = diffuse + spec + envc;
  // In-water haze: submerged fish lose contrast toward the water colour with depth, beyond the view-path
  // attenuation of kodiak_underwater.
  float haze = 1.0 - exp(-max(0.0, -vWorldPos.y) * 0.22);
  col = mix(col, uWaterScatter * (0.6 + 0.8 * uEnvScale), haze * 0.55);
#ifdef SCHOOL
  // Soft blue-green shadows rather than lit objects: toward a darkened water-column colour with depth, which keeps
  // them readable (darker than the water around them) over both turquoise shallows and deep water.
  float deep = (1.0 - exp(-max(0.0, -vWorldPos.y) * 0.6)) * school;
  col = mix(col, uWaterScatter * 0.55, deep * 0.5);
#endif
  gl_FragColor = vec4(col, 1.0);
  #include <kodiak_underwater_fragment>
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createSalmonMaterial(ctx, { mode = 'school', lod = 'near' } = {}) {
  const sky = ctx.systems.sky;
  const envMap = sky?.envMap?.isTexture ? sky.envMap : null;
  const envDefines = envMap && sky?.envMapDefines ? sky.envMapDefines : null;
  const u = ctx.uniforms;
  const col = (h) => new THREE.Color(h);
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
  Object.assign(uniforms, {
    uTime: u.uTime,
    uSunDir: u.uSunDir,
    uSkyColor: u.uSkyColor,
    uHorizonColor: u.uHorizonColor,
    uWaterAbsorb: u.uWaterAbsorb,
    uWaterScatter: u.uWaterScatter,
    uSunRadiance: { value: new THREE.Color(2.4, 2.25, 2.0) },
    uHemiSky: { value: new THREE.Color(0.6, 0.7, 0.85) },
    uHemiGround: { value: new THREE.Color(0.2, 0.22, 0.18) },
    uEnvScale: { value: 1 },
    uSpeciesLen: { value: [0.52, 0.7, 0.6, 0.66, 0.95] },
    uBack: { value: LOOK.back.map(col) },
    uFlank: { value: LOOK.flank.map(col) },
    uFin: { value: LOOK.fin.map(col) },
    uBelly: { value: col(LOOK.belly) },
    uBar: { value: col(LOOK.bar) },
    uSpotColor: { value: col(LOOK.spot) },
  });
  const defines = {};
  if (envDefines) {
    Object.assign(defines, envDefines, { USE_KENV: '' });
    uniforms.envMap = { value: envMap };
  }
  let vert;
  if (mode === 'school') {
    defines.SCHOOL = '';
    if (lod === 'near') defines.LOD_NEAR = '';
    uniforms.uSlotA = { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) };
    uniforms.uSlotB = { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) };
    uniforms.uSlotC = { value: Array.from({ length: SLOTS }, () => new THREE.Vector4()) };
    uniforms.uSlotD = { value: Array.from({ length: SLOTS }, () => new THREE.Vector4(1, 1, 1, 1)) };
    uniforms.uSlotE = { value: Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 1, 0, 1)) };
    uniforms.uLodDist = { value: 22 };
    uniforms.uMaxDist = { value: 260 };
    vert = COMMON_VERT + SCHOOL_VERT;
  } else {
    vert = COMMON_VERT + JUMPER_VERT;
  }
  const mat = new THREE.ShaderMaterial({
    name: `kodiak-salmon-${mode}${mode === 'school' ? `-${lod}` : ''}`,
    uniforms,
    defines,
    vertexShader: vert,
    fragmentShader: FRAG,
    fog: true,
    side: THREE.FrontSide,
  });
  return mat;
}

// Shared per-frame lighting inputs (called once per frame for all salmon materials, which share these uniform
// objects).
export function createSalmonLighting(ctx, materials) {
  const shared = materials[0].uniforms;
  for (const m of materials.slice(1)) {
    m.uniforms.uSunRadiance = shared.uSunRadiance;
    m.uniforms.uHemiSky = shared.uHemiSky;
    m.uniforms.uHemiGround = shared.uHemiGround;
    m.uniforms.uEnvScale = shared.uEnvScale;
    m.uniforms.uSpeciesLen = shared.uSpeciesLen;
  }
  const tmp = new THREE.Color();
  return function updateLighting() {
    const sky = ctx.systems.sky;
    const sun = sky?.sunLight;
    const hemi = sky?.hemiLight;
    if (sun?.color) shared.uSunRadiance.value.copy(sun.color).multiplyScalar(sun.intensity ?? 1);
    else shared.uSunRadiance.value.copy(ctx.uniforms.uSunColor.value).multiplyScalar(2.4 * (ctx.uniforms.uDaylight.value ?? 1));
    if (hemi?.color) {
      shared.uHemiSky.value.copy(hemi.color).multiplyScalar(hemi.intensity ?? 1);
      shared.uHemiGround.value.copy(hemi.groundColor ?? tmp.setRGB(0.2, 0.2, 0.2)).multiplyScalar(hemi.intensity ?? 1);
    }
    shared.uEnvScale.value = 0.35 + 0.65 * (ctx.uniforms.uDaylight.value ?? 1);
  };
}
