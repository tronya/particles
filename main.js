import * as THREE from 'three';

// GPU particle simulation: every particle has its own position + velocity,
// updated each frame by forces (orbiting attractors, swirl, turbulence, drag, shell spring).
const SIZE = innerWidth < 700 ? 256 : 384; // texture side -> SIZE*SIZE particles
const COUNT = SIZE * SIZE;
const RADIUS = 1.6;
const MAX_SPREAD = 10;   // particles never get farther than this many planet radii from their planet
const R_MIN = 1.25;  // particles never get closer than this to the centre
const R_MAX = 3.9;   // ...or farther than this (doubled spread)
const GRAVITY = 3.9;

// ---- Planets: ours + 2 others, real gravity between them: they fall toward each other, fly past and separate again ----
// A weak pull toward the common centre keeps them bound, so after a flyby they only drift apart a little and come back.
// STATIC_PAIR = true: two planets stand still next to each other (centres PAIR_GAP apart), each with only its own gravity and no pull between them.
// STATIC_PAIR = false: the dynamic three-planet system (mutual gravity, flybys, gravity blackouts, gathering).
const STATIC_PAIR = true;
const PAIR_GAP = 9.5;   // centre-to-centre distance: about two planet diameters
const OTHERS = 2; // static: three planets standing in a triangle; dynamic mode uses the same three
// Per-planet interaction modes (set with the on-screen buttons): how a planet treats ITS OWN particles and how it treats OTHER planets' particles.
// 1 = attracts, -1 = repels, 0 = does nothing. A particle is held by the planet that attracts it most strongly (see the velocity shader).
const ownMode = new Array(24).fill(1);   // default: every planet attracts its own particles
const ownEff = new Array(24).fill(1);    // what the shader actually uses: ownMode, except 0 for a planet that is being dragged
const forMode = new Array(24).fill(0);   // default: no planet affects other planets' particles
const REPEL_K = 2.0;
const FOREIGN_RANGE = +new URLSearchParams(location.search).get('range') || 2.0; // ?range=1 gives the old zone               // how much farther a planet's influence on OTHER planets' particles reaches (distances are divided by this)                     // repulsion strength relative to gravity
const PLANETS = OTHERS + 1;       // max 24 (uniform array size)
const MAX_PLANETS = 24;
const planetScale = Array.from({ length: MAX_PLANETS }, (_, i) => (i === 0 || STATIC_PAIR ? 1 : 0.85));
const planetMassBase = Array.from({ length: MAX_PLANETS }, (_, i) => (i === 0 ? 1 : 0.7));
const planetMass = planetMassBase.slice();          // live mass: scaled by the planet's current gravity
const planetGrav = new Array(MAX_PLANETS).fill(1);  // 1 = normal gravity, 0 = gravity switched off
// Every planet loses ALL of its gravity for GRAV_OFF seconds once per GRAV_PERIOD; planets take turns, GRAV_STAGGER apart.
const GRAV_PERIOD = 30, GRAV_OFF = 15, GRAV_STAGGER = 10, GRAV_FADE = 0.4;
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function updateGravity(t) {
  for (let i = 0; i < PLANETS; i++) {
    const phase = (((t - GRAV_STAGGER * (i + 1)) % GRAV_PERIOD) + GRAV_PERIOD) % GRAV_PERIOD;
    const off = phase < GRAV_OFF ? smooth01(0, GRAV_FADE, phase) * (1 - smooth01(GRAV_OFF - GRAV_FADE, GRAV_OFF, phase)) : 0;
    planetGrav[i] = 1 - off;
    planetMass[i] = planetMassBase[i] * planetGrav[i];
  }
}
const PLANET_G = 14, SOFT = 1.6, LEASH = 0.035;
const planetCenters = Array.from({ length: MAX_PLANETS }, () => new THREE.Vector3());
const planetVels = Array.from({ length: MAX_PLANETS }, () => new THREE.Vector3());
planetCenters[1].set(6.5, 0.4, 0);   planetVels[1].set(-0.35, 0.05, 0.45);
planetCenters[2].set(-6.5, -0.4, 0.8); planetVels[2].set(0.35, -0.05, -0.45);
if (STATIC_PAIR) {
  // equilateral triangle with sides PAIR_GAP: violet (left), yellow-red (right), grey-white (top)
  const tri = PAIR_GAP * Math.sqrt(3) / 2;
  planetCenters[0].set(-PAIR_GAP / 2, -tri / 3, 0); planetCenters[1].set(PAIR_GAP / 2, -tri / 3, 0); planetCenters[2].set(0, (2 * tri) / 3, 0);
  for (let i = 0; i < 3; i++) planetVels[i].set(0, 0, 0);
} else { // zero total momentum so the system doesn't drift off screen
  const p = new THREE.Vector3();
  for (let i = 1; i < PLANETS; i++) p.addScaledVector(planetVels[i], planetMass[i]);
  planetVels[0].copy(p).multiplyScalar(-1 / planetMass[0]);
}
const _a = Array.from({ length: PLANETS }, () => new THREE.Vector3());
const _d = new THREE.Vector3();
// Gathering: after GATHER_AFTER seconds of free flight all planets are pulled into the centre and stay there for GATHER_FOR seconds,
// then they are kicked apart and fly freely again. The cycle repeats.
const urlParams = new URLSearchParams(location.search); // ?gatherAfter=10&gatherFor=10 shortens the cycle for testing
const GATHER_AFTER = +urlParams.get('gatherAfter') || 60, GATHER_FOR = +urlParams.get('gatherFor') || 60, GATHER_RAMP = 5;
const gatherCycle = GATHER_AFTER + GATHER_FOR;
const gatherPhase = (t) => t % gatherCycle - GATHER_AFTER;          // < 0 while flying freely, >= 0 while gathered
const gatherLevel = (t) => { const q = gatherPhase(t); return q < 0 ? 0 : smooth01(0, GATHER_RAMP, q); };
let wasGathered = false, isGathered = false;
function releaseKick() {
  const c = new THREE.Vector3();
  for (let i = 0; i < PLANETS; i++) c.add(planetCenters[i]);
  c.multiplyScalar(1 / PLANETS);
  for (let i = 0; i < PLANETS; i++) {
    const dir = planetCenters[i].clone().sub(c);
    if (dir.lengthSq() < 0.09) { const a = (i / PLANETS) * Math.PI * 2 + 0.5; dir.set(Math.cos(a), 0.2 * Math.sin(a * 2), Math.sin(a)); }
    planetVels[i].addScaledVector(dir.normalize(), 3.5);
  }
}
function stepPlanets(dt, gather) {
  const n = 4, h = dt / n; // sub-steps keep close flybys stable
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < PLANETS; i++) {
      _a[i].copy(planetCenters[i]).multiplyScalar(-(LEASH + gather * 0.9));
      for (let j = 0; j < PLANETS; j++) {
        if (i === j) continue;
        _d.copy(planetCenters[j]).sub(planetCenters[i]);
        const r2 = _d.lengthSq() + SOFT * SOFT;
        _a[i].addScaledVector(_d, (PLANET_G * planetMass[j]) / Math.pow(r2, 1.5));
      }
    }
    for (let i = 0; i < PLANETS; i++) {
      planetVels[i].addScaledVector(_a[i], h);
      planetVels[i].multiplyScalar(Math.exp(-gather * 0.7 * h)); // a little damping while gathering so they settle in the centre
      planetCenters[i].addScaledVector(planetVels[i], h);
    }
  }
}
const shift = new THREE.Vector3(); // (unused offset; kept for the points shader)
const extent = STATIC_PAIR ? 11.5 : 19;               // half-size of the area the planets stay in
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0x000000);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.z = 14;
const group = new THREE.Group();
scene.add(group);

const noise = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

// ---- ping-pong state textures (xyz position + colour group, xyz velocity) ----
const rtOpts = {
  type: THREE.FloatType, format: THREE.RGBAFormat,
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  depthBuffer: false, stencilBuffer: false,
};
const makeRT = () => new THREE.WebGLRenderTarget(SIZE, SIZE, rtOpts);
let posA = makeRT(), posB = makeRT(), velA = makeRT(), velB = makeRT();

const initData = new Float32Array(COUNT * 4);
const initVel = new Float32Array(COUNT * 4);
const weights = planetScale.slice(0, PLANETS).map((sc) => sc * sc);
const wSum = weights.reduce((a, b) => a + b, 0);
for (let i = 0; i < COUNT; i++) {
  // uniform random direction on the sphere
  let x, y, z, l;
  do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 0.01);
  l = Math.sqrt(l);
  let pick = Math.random() * wSum, planet = 0;
  while (planet < PLANETS - 1 && (pick -= weights[planet]) > 0) planet++;
  const sc = planetScale[planet], c = planetCenters[planet];
  const rn = RADIUS * (0.8 + Math.pow(Math.random(), 1.6) * 1.6); // spread across the whole (doubled) band, denser near the core // radius in the planet's own units
  const px = x / l * rn * sc, py = y / l * rn * sc, pz = z / l * rn * sc;
  initData.set([c.x + px, c.y + py, c.z + pz, planet * 3 + Math.floor(Math.random() * 3)], i * 4);
  const pv = planetVels[planet];
  // start on a roughly circular orbit in a random direction around the planet's centre
  const ax = Math.random() * 2 - 1, ay = Math.random() * 2 - 1, az = Math.random() * 2 - 1;
  let tx = py * az - pz * ay, ty = pz * ax - px * az, tz = px * ay - py * ax;
  const tl = Math.hypot(tx, ty, tz) || 1;
  const vs = Math.sqrt(GRAVITY / rn) * sc * (0.85 + Math.random() * 0.3);
  initVel.set([tx / tl * vs + pv.x, ty / tl * vs + pv.y, tz / tl * vs + pv.z, planet], i * 4);
}
const initTex = new THREE.DataTexture(initData, SIZE, SIZE, THREE.RGBAFormat, THREE.FloatType);
initTex.needsUpdate = true;
const initVelTex = new THREE.DataTexture(initVel, SIZE, SIZE, THREE.RGBAFormat, THREE.FloatType);
initVelTex.needsUpdate = true;

// ---- full-screen pass helper ----
const quadScene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
quadScene.add(quad);
const passVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
// Adaptive quality: when FPS is low, only the first `activeRows` rows of the state textures are simulated and drawn
let activeRows = SIZE;
function runPass(material, target) {
  quad.material = material;
  target.viewport.set(0, 0, SIZE, activeRows);
  renderer.setRenderTarget(target);
  renderer.render(quadScene, quadCam);
  renderer.setRenderTarget(null);
}

const copyMat = new THREE.ShaderMaterial({
  uniforms: { tSrc: { value: initTex } },
  vertexShader: passVert,
  fragmentShader: /* glsl */ `uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }`,
});
runPass(copyMat, posA);
copyMat.uniforms.tSrc.value = initVelTex;
runPass(copyMat, velA);

// ---- webcam portrait: every particle becomes one "pixel" of the live camera image ----
// (the particle at texel (x, y) of the state texture shows image pixel (x, y)); the physics is replaced by a damped spring to that pixel's position
const camState = { on: false, mix: 0, tex: null, video: null, stream: null, w: 4, h: 3 };
const CAM_HEIGHT = 14;                                    // world units the portrait is tall
const camSizeU = { value: new THREE.Vector2(18.7, CAM_HEIGHT) };   // world size of the camera image
const faceU = { value: new THREE.Vector4(0, 0, 9.3, 7) };          // face ellipse in world units: centre x, y, radii x, y (or the whole frame)
// Colour matching: a particle is drawn to the places of the camera image that have ITS colour (yellow -> yellow, blue -> blue ...)
const camGLSL = /* glsl */ `
  float hueOf(vec3 c) {
    float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
    if (d < 1e-4) return 0.0;
    float h = (mx == c.r) ? mod((c.g - c.b) / d, 6.0) : (mx == c.g) ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
    return h / 6.0;
  }
  float satOf(vec3 c) { float mx = max(c.r, max(c.g, c.b)); return (mx - min(c.r, min(c.g, c.b))) / max(mx, 1e-3); }
  vec3 groupColour(int pl, float gi) {   // the base colour of a colour group (planet 0: teal/violet/blue, 1: yellow-red family, 2: greys)
    if (pl == 0) return gi < 0.5 ? vec3(0.06, 0.88, 0.76) : gi < 1.5 ? vec3(0.62, 0.26, 1.00) : vec3(0.20, 0.62, 1.00);
    if (pl == 2) return vec3(0.25 + 0.35 * gi);
    float h = fract(0.065 + float(pl - 1) * 0.30 + (gi - 1.0) * 0.045);
    vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return mix(vec3(1.0), k, 0.85);
  }
  float colourMatch(vec3 cc, vec3 pc) {  // 0..1: how well the video colour cc suits the particle colour pc
    float sp = satOf(pc), sc = satOf(cc);
    float lc = dot(cc, vec3(0.299, 0.587, 0.114)), lp = dot(pc, vec3(0.299, 0.587, 0.114));
    if (sp < 0.25) { float dl = (lc - lp) / 0.22; return exp(-dl * dl) * (1.0 - smoothstep(0.15, 0.45, sc)); } // greys like grey/white pixels of similar brightness
    float dh = abs(hueOf(cc) - hueOf(pc)); dh = min(dh, 1.0 - dh);
    return exp(-dh * dh / 0.012) * smoothstep(0.10, 0.35, sc) * smoothstep(0.12, 0.40, max(cc.r, max(cc.g, cc.b)));
  }
  float lumAt(vec2 uv) { return dot(texture2D(tCam, uv).rgb, vec3(0.299, 0.587, 0.114)); }
  // what attracts a particle at this picture position: its own colour, or (shadow mode) darkness relative to the surroundings
  float camMatch(vec2 uv, vec3 pc) {
    vec3 cc = texture2D(tCam, uv).rgb;
    if (uShadow < 0.5) return colourMatch(cc, pc);
    float l = dot(cc, vec3(0.299, 0.587, 0.114));
    float e = 0.018;
    float m = 0.25 * (lumAt(uv + vec2(e, 0.0)) + lumAt(uv - vec2(e, 0.0)) + lumAt(uv + vec2(0.0, e)) + lumAt(uv - vec2(0.0, e)));
    float local = clamp((m - l) / 0.12, 0.0, 1.0);     // darker than its neighbourhood: eye sockets, nostrils, the line of the mouth, edges, hair
    float absd = smoothstep(0.30, 0.08, l);            // plain dark areas
    return clamp(max(local, absd), 0.0, 1.0);
  }`;
// ---- clock screensaver: the time is drawn (with a soft halo) into a mask texture; particles flow around the digits and gather on their outline ----
const clockState = { on: false, mix: 0, lastSec: -1 };
const clockCanvas = document.createElement('canvas'); clockCanvas.width = 1024; clockCanvas.height = 384;
const clockTex = new THREE.CanvasTexture(clockCanvas);
clockTex.magFilter = THREE.LinearFilter; clockTex.minFilter = THREE.LinearMipmapLinearFilter; clockTex.generateMipmaps = true;   // mip levels = long-range gravity toward the digits
const clockRectU = { value: new THREE.Vector2(20, 7.5) };   // world size of the clock mask
const clockViewU = { value: new THREE.Vector2(12, 9) };   // half extents of the visible area (world)
function drawClock() {
  const d = new Date(), txt = [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  const g = clockCanvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 1024, 384);
  g.font = '700 250px Menlo, "SF Mono", ui-monospace, Consolas, monospace';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.shadowColor = '#fff'; g.shadowBlur = 90; g.fillStyle = '#fff';
  g.fillText(txt, 512, 196); g.fillText(txt, 512, 196);       // soft halo around the digits (their "gravity well")
  g.shadowBlur = 0; g.fillText(txt, 512, 196);                // solid digits
  clockTex.needsUpdate = true;
  clockState.text = txt;
}
const shadowU = { value: 0 };   // 0 = colour matching, 1 = shadows only (the contour of the face)
const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blackTex.needsUpdate = true;

// ---- velocity update: the physics ----
const velMat = new THREE.ShaderMaterial({
  uniforms: {
    tPos: { value: null }, tVel: { value: null },
    uTime: { value: 0 }, uDt: { value: 0.016 }, uR: { value: RADIUS },
    uG: { value: GRAVITY }, uRMin: { value: R_MIN }, uRMax: { value: R_MAX },
    uCen: { value: planetCenters }, uCenVel: { value: planetVels }, uScale: { value: planetScale }, uMass: { value: planetMass }, uGrav: { value: planetGrav }, uN: { value: PLANETS }, uTidal: { value: STATIC_PAIR ? 0 : PLANET_G }, uSoft: { value: SOFT }, uBoost: { value: 0.5 },
    tCam: { value: blackTex }, uCam: { value: 0 }, uCamSize: camSizeU, uFace: faceU, uShadow: shadowU,
    tClock: { value: clockTex }, uClock: { value: 0 }, uClockRect: clockRectU, uClockView: clockViewU,
    uFarK: { value: 4.0 }, uTether: { value: 0.10 }, uOwnMode: { value: ownEff }, uForMode: { value: forMode }, uRepelK: { value: REPEL_K }, uMaxR: { value: MAX_SPREAD * RADIUS }, uForRange: { value: FOREIGN_RANGE },
  },
  vertexShader: passVert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tPos, tVel;
    uniform float uTime, uDt, uR, uG, uRMin, uRMax, uTidal, uSoft, uBoost, uFarK, uRepelK, uMaxR, uForRange, uTether;
    uniform float uCam, uClock;
    uniform vec2 uClockRect, uClockView;
    uniform sampler2D tClock;
    uniform vec2 uCamSize;
    uniform vec4 uFace;
    uniform float uShadow;
    uniform sampler2D tCam;
    ${camGLSL}
    uniform float uOwnMode[24];
    uniform float uForMode[24];
    uniform float uMass[24];
    uniform float uGrav[24];
    uniform vec3 uCen[24];
    uniform vec3 uCenVel[24];
    uniform float uScale[24];
    uniform int uN;
    varying vec2 vUv;
    ${noise.replace('const noise = /* glsl */ `', '').replace(/`;$/, '')}

    vec3 rotate(vec3 p, vec3 axis, float a) {
      float c = cos(a), s = sin(a);
      return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
    }

    // 3 attractors per colour group, each orbiting the sphere on its own axis
    vec3 attractor(float g, float k, float t) {
      float id = g * 3.0 + k;
      vec3 axis = normalize(vec3(sin(id * 12.9898 + 1.0), cos(id * 78.233 + 2.0), sin(id * 37.719 + 3.0)));
      vec3 base = normalize(vec3(cos(id * 4.1 + 0.5), sin(id * 2.3 + 1.7), cos(id * 5.7 + 2.2)));
      float speed = (0.45 + 0.4 * fract(sin(id * 91.7) * 437.5)) * (mod(id, 2.0) < 1.0 ? 1.0 : -1.0);
      return rotate(base, axis, t * speed);
    }

    void main() {
      vec4 P = texture2D(tPos, vUv);
      float g = P.w;
      vec4 V4 = texture2D(tVel, vUv);
      if (uClock > 0.5) {
        // clock screensaver: the digits act like a planet. Far away the particles fall toward them (gravity), at a certain distance
        // they are caught in a band around the glyph outline (attracted from outside, pushed back if they get too close),
        // and they circulate along the outline the way particles circle a planet.
        vec2 wp = P.xy;
        float hsh = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
        vec2 uvm = vec2(0.5 + wp.x / uClockRect.x, 0.5 + wp.y / uClockRect.y);
        vec2 uvc = clamp(uvm, 0.001, 0.999);
        float m0 = texture2D(tClock, uvc).r;
        vec2 dd = vec2(0.006, 0.006 * uClockRect.x / uClockRect.y);
        float mx = texture2D(tClock, clamp(uvm + vec2(dd.x, 0.0), 0.001, 0.999)).r - texture2D(tClock, clamp(uvm - vec2(dd.x, 0.0), 0.001, 0.999)).r;
        float my = texture2D(tClock, clamp(uvm + vec2(0.0, dd.y), 0.001, 0.999)).r - texture2D(tClock, clamp(uvm - vec2(0.0, dd.y), 0.001, 0.999)).r;
        vec2 gdir = vec2(mx, my) / (length(vec2(mx, my)) + 0.02);
        // long-range pull: gradient of a very blurred copy of the mask (mip level) points to the nearest digits; outside the mask: toward its centre
        float lod = 5.0;
        vec2 ec = vec2(exp2(lod) / 1024.0, exp2(lod) / 384.0);
        float cx = textureLod(tClock, clamp(uvm + vec2(ec.x, 0.0), 0.001, 0.999), lod).r - textureLod(tClock, clamp(uvm - vec2(ec.x, 0.0), 0.001, 0.999), lod).r;
        float cy = textureLod(tClock, clamp(uvm + vec2(0.0, ec.y), 0.001, 0.999), lod).r - textureLod(tClock, clamp(uvm - vec2(0.0, ec.y), 0.001, 0.999), lod).r;
        vec2 gc = vec2(cx, cy);
        vec2 toC = -wp / (uClockRect * 0.5);
        toC /= (length(toC) + 1e-3);
        vec2 farDir = length(gc) > 0.004 ? gc / length(gc) : toC;
        float farW = 1.0 - smoothstep(0.0, 0.06, m0);               // gravity acts outside the halo
        vec2 acc = farDir * 5.5 * farW;
        acc += gdir * (0.26 - m0) * 24.0 * step(0.005, m0);          // band: attract to the 0.26 contour, repel inside
        vec2 tdir = vec2(-gdir.y, gdir.x) * (hsh < 0.5 ? 1.0 : -1.0);
        acc += tdir * 2.6 * smoothstep(0.02, 0.18, m0) * (1.0 - smoothstep(0.35, 0.65, m0)); // circulate along the outline
        acc += (vec2(fract(hsh * 91.7 + uTime * 3.1), fract(hsh * 53.3 + uTime * 2.3)) - 0.5) * 1.5;
        vec3 vel = V4.xyz;
        vel.xy = (vel.xy + acc * uDt) * exp(-1.9 * uDt);
        vel.z += (-(P.z - (hsh - 0.5) * 0.8) * 14.0 - vel.z * 6.0) * uDt;
        vel.x -= (max(wp.x - uClockView.x * 0.96, 0.0) - max(-wp.x - uClockView.x * 0.96, 0.0)) * 14.0 * uDt;
        vel.y -= (max(wp.y - uClockView.y * 0.96, 0.0) - max(-wp.y - uClockView.y * 0.96, 0.0)) * 14.0 * uDt;
        float spk = length(vel);
        if (spk > 6.0) vel *= 6.0 / spk;
        gl_FragColor = vec4(vel, V4.w);
        return;
      }
      if (uCam > 0.5) {
        // camera mode: every particle looks around itself in the camera image and drifts toward places that have ITS colour,
        // stays inside the face (ellipse), and keeps circling so the picture stays alive
        int cown = int(floor(g / 3.0 + 0.001));
        vec3 pc = groupColour(cown, g - 3.0 * float(cown));
        vec2 wp = P.xy;
        float W = uCamSize.x, H = uCamSize.y;
        vec2 uv0 = clamp(vec2(0.5 - wp.x / W, 0.5 + wp.y / H), 0.001, 0.999);
        float s0 = camMatch(uv0, pc);
        vec2 gd = vec2(0.0);
        for (int k = 0; k < 8; k++) {
          float an = float(k) * 0.7853982;
          vec2 dir = vec2(cos(an), sin(an));
          vec2 wq1 = wp + dir * 0.8, wq2 = wp + dir * 2.4;
          float s1 = camMatch(clamp(vec2(0.5 - wq1.x / W, 0.5 + wq1.y / H), 0.001, 0.999), pc);
          float s2 = camMatch(clamp(vec2(0.5 - wq2.x / W, 0.5 + wq2.y / H), 0.001, 0.999), pc);
          gd += dir * ((s1 - s0) + 0.6 * (s2 - s0));
        }
        // each particle has its own slowly circling place on the face (uniform coverage, no pile-ups);
        // the colour match only shifts it a bounded distance toward the nearest places with its colour
        float hh = fract(sin(dot(vUv, vec2(12.9898, 78.233))) * 43758.5453);
        float h2 = fract(sin(dot(vUv, vec2(39.3468, 11.135))) * 24634.6345);
        float h3 = fract(sin(dot(vUv, vec2(73.156, 52.235))) * 12345.6789);
        vec2 shiftC = gd / (length(gd) + 0.15) * mix(2.2, 3.4, uShadow);   // in shadow mode the particles gather into the shadows more strongly
        float rr = sqrt(h2);
        float ang = h3 * 6.2831853 + uTime * (0.12 + 0.4 * hh) * (hh < 0.5 ? 1.0 : -1.0) + 0.5 * sin(uTime * 0.4 + hh * 30.0);
        vec2 home = uFace.xy + vec2(cos(ang) * uFace.z * rr, sin(ang) * uFace.w * rr);
        vec2 tgt2 = home + shiftC;
        vec3 acc = vec3((tgt2 - wp) * 45.0, -(P.z - (hh - 0.5) * 0.6) * 18.0);
        acc.xy += (vec2(fract(hh * 91.7 + uTime * 3.1), fract(hh * 53.3 + uTime * 2.3)) - 0.5) * 3.0;      // fine jitter
        vec3 pv = (V4.xyz + acc * uDt) * exp(-13.0 * uDt);
        float spc = length(pv);
        if (spc > 14.0) pv *= 14.0 / spc;
        gl_FragColor = vec4(pv, V4.w);
        return;
      }
      int own = int(floor(g / 3.0 + 0.001));
      // Every planet treats particles of its own colour (uOwnMode) and of the other planets (uForMode) as: 1 attract, -1 repel, 0 nothing.
      // A particle is held by the planet that attracts it most strongly; it only changes planet when another one clearly wins
      // (hysteresis, so it doesn't flicker), and with no attractor at all it flies free (still pushed by any repelling planet).
      int pi = int(floor(V4.w + 0.5));
      if (pi < 0 || pi >= uN) pi = own;
      float bestS;
      {
        float rg = (pi == own) ? 1.0 : uForRange;   // other planets reach uForRange times farther
        float dn = length(P.xyz - uCen[pi]) / (uScale[pi] * rg);
        float m = (pi == own) ? uOwnMode[pi] : uForMode[pi];
        bestS = m * uG / (dn * dn + 0.3);
      }
      vec3 rep = vec3(0.0); // acceleration (world units) from repelling planets
      for (int j = 0; j < 24; j++) {
        if (j >= uN) break;
        float sj = uScale[j];
        float m = (j == own) ? uOwnMode[j] : uForMode[j];
        vec3 dd = P.xyz - uCen[j];
        float rg = (j == own) ? 1.0 : uForRange;
        float dn = length(dd) / (sj * rg);
        if (j != pi) {
          float Sj = m * uG / (dn * dn + 0.3);
          if (Sj > max(bestS, 0.0) * 1.5 + 0.03) { pi = j; bestS = Sj; }
        }
        if (m < -0.001) {   // a negative value is a repulsion strength
          float d2 = dot(dd, dd) / (rg * rg) + 0.3 * sj * sj;
          rep += dd / max(length(dd), 1e-4) * ((-m) * uRepelK * uG * sj * sj * sj / d2);
        }
      }
      if (bestS < 0.0005) { // only particles that have no attracting planet at all coast (the old 0.03 threshold stranded far ones for good)
        // nothing attracts this particle: coast, pushed away by whatever repels it
        vec3 vv = (V4.xyz + rep * uDt) * exp(-0.35 * uDt);
        // soft wall at 80% of the maximum spread, so coasting / repelled particles turn back instead of leaving
        vec3 rel = P.xyz - uCen[pi];
        float rr = length(rel);
        float excess = max(rr / uScale[pi] - 0.8 * uMaxR, 0.0);
        vv -= rel / max(rr, 1e-4) * excess * 14.0 * uDt;
        float spf = length(vv);
        if (spf > 4.0) vv *= 4.0 / spf;
        gl_FragColor = vec4(vv, float(pi));
        return;
      }
      float s = uScale[pi];                     // planets are scaled copies of ours
      vec3 p = (P.xyz - uCen[pi]) / s;          // position in the planet's own units
      vec3 cv = uCenVel[pi];
      vec3 v = (V4.xyz - cv) / s; // velocity relative to the planet it orbits
      float r = length(p);
      vec3 n = p / max(r, 1e-4);
      vec3 f = vec3(0.0);
      float capture = 0.0;
      // near = 1 close to the planet (normal behaviour), 0 far away: there only plain gravity acts, so a particle
      // handed over to another planet drifts toward it gently instead of being yanked in by walls and attractors
      float w = smoothstep(uRMax * 2.4, uRMax * 1.3, r);

      for (int k = 0; k < 3; k++) {
        vec3 an = attractor(g, float(k), uTime);
        vec3 d = an * uR - p;
        float inv = 1.0 / pow(dot(d, d) + 0.12, 1.5);
        f += d * inv * 1.0 * w;              // pull toward the attractor
        f += cross(an, d) * inv * 1.3 * w;   // swirl around it
        capture += w / (1.0 + dot(d, d) * 5.0); // friction well: nearby particles get captured
      }

      // direction vector: every planet spins around its own axis (slowly precessing, each colour group tilted a little),
      // and particles gently align with that flow -> organised bands instead of random scatter
      float gi = g - 3.0 * float(pi);
      vec3 paxis = normalize(vec3(sin(float(pi) * 12.9 + 1.0), cos(float(pi) * 7.3 + 2.0), sin(float(pi) * 4.1 + 3.0)));
      paxis = rotate(paxis, normalize(vec3(0.3, 1.0, 0.2)), uTime * 0.05 + float(pi));
      vec3 tilt = normalize(cross(paxis, vec3(0.0, 1.0, 0.1)) + 1e-4);
      // the axis varies smoothly across the sphere (coherent jet-stream-like currents), so the flow fills the ball instead of one flat disc
      float tl = snoise(n * 1.1 + vec3(float(pi) * 3.0, gi * 5.0, uTime * 0.05)) * 1.6 + (gi - 1.0) * 0.4;
      vec3 gaxis = rotate(paxis, tilt, tl);
      float spin = sqrt(uG * uGrav[pi] / max(r, 0.8));
      vec3 flow = cross(gaxis, n) * spin * clamp(r / 1.6, 0.6, 1.4);
      vec3 dv = flow - v;
      f += (dv - n * dot(dv, n)) * 0.35 * uGrav[pi] * w; // tangential part only, so radial (wide) orbits stay free

      // per-group turbulence so layers don't move in lockstep
      vec3 q = p * 1.3 + vec3(0.0, uTime * 0.15, g * 7.0);
      f += vec3(snoise(q), snoise(q + 17.0), snoise(q + 41.0)) * 0.5;

      // diffusion: each particle gets its own random kicks, so streams stay thick instead of collapsing to a line
      vec3 hs = vec3(dot(vUv, vec2(127.1, 311.7)) + uTime * 37.0, dot(vUv, vec2(269.5, 183.3)) + uTime * 53.0, dot(vUv, vec2(419.2, 371.9)) + uTime * 29.0);
      f += (fract(sin(hs) * 43758.5453) - 0.5) * 0.35;

      // gravity of the planet's centre
      float mh = max((pi == own) ? uOwnMode[pi] : uForMode[pi], 0.0); // attraction strength of the holder (slider value / 100)
      f -= n * (uG * uGrav[pi] * mh / (r * r)); // scaled by the slider; 0 = no pull
      // far field: the plain pull of the planet (a bit boosted so a crossing takes seconds, not minutes) + light drag, no walls
      f -= n * (1.0 - w) * (uG * uFarK / (r * r + 1.0) + uTether) * mh; // + a small constant tether, so a particle at ANY distance slowly finds its way back

      // mutual gravity: real pull of the other planets (same law that moves the planets themselves)
      vec3 tid = vec3(0.0);
      for (int j = 0; j < 24; j++) {
        if (j >= uN) break;
        if (j == pi) continue;
        vec3 dd = uCen[j] - P.xyz;
        // much stronger pull inside 8R of that planet (zone doubled twice from 2R), fading smoothly to normal gravity as it moves away
        float dl = length(dd);
        float near = 1.0 - smoothstep(3.2 * uR * uScale[j], 8.0 * uR * uScale[j], dl);
        tid += dd * (uMass[j] * (1.0 + uBoost * near) / pow(dot(dd, dd) + uSoft * uSoft, 1.5));
      }
      f += tid * uTidal / s;
      f += rep / s; // repulsion from any repelling planet (converted to the holder's units)

      // soft walls of the orbit band: push back before the hard clamp kicks in
      f += n * 60.0 * max(uRMin + 0.08 - r, 0.0);
      f -= n * 12.0 * max(r - uRMax, 0.0) * w;     // soft outer wall: strong tides can pull particles out
      f -= n * 25.0 * max(r - 6.8, 0.0) * w;       // far leash so nothing is lost forever

      v += f * uDt;
      v *= exp(-(0.20 + 1.4 * min(capture, 1.5) + 0.25 * (1.0 - w)) * uDt);           // light drag
      float sp = length(v);
      if (sp > 3.5) v *= 3.5 / sp;
      if (sp < 0.55) v += (sp > 1e-4 ? v / sp : cross(n, vec3(0.0, 1.0, 0.3))) * (0.55 - sp) * 2.0 * uDt * 10.0; // never come to rest
      // every particle always belongs to its own planet: it can be pulled toward a close neighbour, but returns when that neighbour leaves
      int home = pi;
      gl_FragColor = vec4(v * s + cv, float(home));
    }`,
});

const posMat = new THREE.ShaderMaterial({
  uniforms: {
    tPos: { value: null }, tVel: { value: null }, uDt: { value: 0.016 },
    uRMin: { value: R_MIN }, uRMax: { value: R_MAX }, uCeil: { value: MAX_SPREAD * RADIUS }, uCam: { value: 0 },
    uCen: { value: planetCenters }, uScale: { value: planetScale },
  },
  vertexShader: passVert,
  fragmentShader: /* glsl */ `
    uniform sampler2D tPos, tVel; uniform float uDt, uRMin, uRMax, uCeil, uCam;
    uniform vec3 uCen[24]; uniform float uScale[24];
    varying vec2 vUv;
    void main() {
      vec4 P = texture2D(tPos, vUv);
      vec3 v = texture2D(tVel, vUv).xyz;
      int pi = int(floor(texture2D(tVel, vUv).w + 0.5));
      float s = uScale[pi];
      if (uCam > 0.5) { gl_FragColor = vec4(P.xyz + v * uDt, P.w); return; } // portrait: free of the planet bands
      vec3 rel = P.xyz - uCen[pi] + v * uDt;
      float r = length(rel);
      rel *= clamp(r, uRMin * s, uCeil * s) / max(r, 1e-4); // hard floor (no collapse into the core) and a very loose ceiling
      gl_FragColor = vec4(uCen[pi] + rel, P.w);
    }`,
});

// ---- render the particles as points ----
const refs = new Float32Array(COUNT * 2);
for (let i = 0; i < COUNT; i++) {
  refs[i * 2] = ((i % SIZE) + 0.5) / SIZE;
  refs[i * 2 + 1] = (Math.floor(i / SIZE) + 0.5) / SIZE;
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
geometry.setAttribute('ref', new THREE.BufferAttribute(refs, 2));
geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);

const pointsMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    tPos: { value: null }, tVel: { value: null },
    uSize: { value: 1.5 }, uPixelRatio: { value: renderer.getPixelRatio() },
    uCen: { value: planetCenters }, uCenVel: { value: planetVels }, uScale: { value: planetScale }, uShift: { value: shift }, uCamZ: { value: 14 }, tCam: { value: blackTex }, uCamMix: { value: 0 }, uCamSize: camSizeU, uFace: faceU, uShadow: shadowU,
    tClock: { value: clockTex }, uClockMix: { value: 0 }, uClockRect: clockRectU,
  },
  vertexShader: /* glsl */ `
    uniform sampler2D tPos, tVel;
    uniform sampler2D tClock;
    uniform vec2 uClockRect;
    uniform float uClockMix;
    uniform float uSize, uPixelRatio, uCamZ, uCamMix;
    uniform sampler2D tCam;
    uniform vec2 uCamSize;
    uniform vec4 uFace;
    uniform float uShadow;
    ${camGLSL}
    uniform vec3 uCen[24]; uniform vec3 uCenVel[24]; uniform float uScale[24]; uniform vec3 uShift;
    attribute vec2 ref;
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      vec4 P = texture2D(tPos, ref);
      vec3 v = texture2D(tVel, ref).xyz;
      float g = P.w;
      int pi = int(floor(g / 3.0 + 0.001));
      float gi = g - 3.0 * float(pi);
      int home = int(floor(texture2D(tVel, ref).w + 0.5));
      float sp = length(v - uCenVel[home]);
      vec4 mv = modelViewMatrix * vec4(P.xyz - uShift, 1.0);
      gl_Position = projectionMatrix * mv;

      // planet 0 keeps teal / violet / blue; every other planet gets its own hue family
      vec3 col;
      if (pi == 0) {
        col = gi < 0.5 ? vec3(0.06, 0.88, 0.76) : gi < 1.5 ? vec3(0.62, 0.26, 1.00) : vec3(0.20, 0.62, 1.00);
      } else if (pi == 2) {
        // grey-white planet: bright near the core, fading through greys to black toward the edge
        float rr = length(P.xyz - uCen[home]) / uScale[home];
        float t = clamp((rr - 1.0) / 2.4, 0.0, 1.0);
        float h2 = fract(sin(dot(ref, vec2(12.9898, 78.233))) * 43758.5453);
        // radial gradient white -> black, plus a per-particle spread so every shade of grey is present at every radius
        float tone = mix(1.0, 0.0, pow(t, 0.55)) * (0.30 + 0.70 * h2) + 0.55 * h2 * h2 * (1.0 - t);
        col = vec3(tone);
      } else {
        float h = fract(0.065 + float(pi - 1) * 0.30 + (gi - 1.0) * 0.045); // planet 1: yellow-red
        vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
        col = mix(vec3(1.0), k, 0.85);
      }
      vColor = mix(col, vec3(1.0), clamp(sp * 0.05, 0.0, 0.18)); // fast particles glow whiter

      float facing = normalize(normalMatrix * (P.xyz - uCen[home])).z;
      vAlpha = (0.30 + 0.70 * smoothstep(-1.0, 1.0, facing)) * (0.6 + 0.5 * clamp(sp, 0.0, 1.5));
      if (uCamMix > 0.001) {
        vec3 pcol = groupColour(pi, gi);
        vec2 uvp = clamp(vec2(0.5 - P.x / uCamSize.x, 0.5 + P.y / uCamSize.y), 0.001, 0.999);
        float sm = camMatch(uvp, pcol);
        vec2 qf = (P.xy - uFace.xy) / uFace.zw;
        float inFace = 1.0 - smoothstep(0.85, 1.15, length(qf));
        vColor = mix(vColor, pcol * 0.9, uCamMix);                       // particles keep their own colours
        vAlpha = mix(vAlpha, (mix(0.10, 0.015, uShadow) + mix(1.3, 2.0, uShadow) * sm) * (0.25 + 0.75 * inFace), uCamMix); // ...and shine where the picture matches them
      }
      if (uClockMix > 0.001) {
        vec2 uvc = vec2(0.5 + P.x / uClockRect.x, 0.5 + P.y / uClockRect.y);
        float mk = texture2D(tClock, clamp(uvc, 0.001, 0.999)).r;
        vec3 base = groupColour(pi, gi);
        vColor = mix(vColor, mix(base, vec3(1.0), 0.35 * smoothstep(0.1, 0.5, mk)) * 0.8, uClockMix);
        float ca = (0.34 + 1.4 * smoothstep(0.05, 0.30, mk)) * (1.0 - smoothstep(0.50, 0.80, mk)) * (0.5 + 0.5 * clamp(sp, 0.0, 1.5));
        vAlpha = mix(vAlpha, ca, uClockMix);
      }
      gl_PointSize = max(uSize * uPixelRatio * (0.6 * uCamZ / -mv.z), 1.5 * uPixelRatio);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vColor;
    varying float vAlpha;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      if (r > 0.5) discard;
      float a = smoothstep(0.5, 0.0, r) * vAlpha;
      gl_FragColor = vec4(vColor * a * 3.2, a);
    }`,
});
group.add(new THREE.Points(geometry, pointsMat));
group.rotation.z = 0.25;

// ---- Interaction: drag to spin, otherwise endless slow auto-rotation ----
let dragging = false, lastX = 0, lastY = 0;
let velY = STATIC_PAIR ? 0 : 0.0012, tiltX = STATIC_PAIR ? 0 : 0.15, targetTiltX = STATIC_PAIR ? 0 : 0.15;
const baseSpeed = 0.0012;
const ROLL_SPEED = 0;    // rad/s of the 2D roll: 0 = the view is fixed (set e.g. 0.15 for a slow roll)
let roll = 0, yaw = 0;

const el = renderer.domElement;
// Static pair: dragging grabs the nearest planet and moves it in the screen plane (the view itself stays flat 2D).
// Other modes: dragging spins the view as before.
const GRAB_RADIUS = 4.5;                 // world units around a planet centre where a click grabs it
let dragPlanet = -1;
const dragOffset = new THREE.Vector2();
const prevCenter = Array.from({ length: MAX_PLANETS }, () => new THREE.Vector2());
for (let i = 0; i < PLANETS; i++) prevCenter[i].set(planetCenters[i].x, planetCenters[i].y);

// pointer -> world position on the z = 0 plane the planets live in (camera looks at the origin)
function pointerToPlane(e, out) {
  const rect = el.getBoundingClientRect();
  const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  return out.set(nx * t * camera.aspect, ny * t);
}
const _p = new THREE.Vector2();
function nearestPlanet(e) {
  pointerToPlane(e, _p);
  let best = -1, bd = GRAB_RADIUS;
  for (let i = 0; i < PLANETS; i++) {
    const d = Math.hypot(planetCenters[i].x - _p.x, planetCenters[i].y - _p.y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

el.style.cursor = STATIC_PAIR ? 'default' : 'grab';
el.addEventListener('pointerdown', (e) => {
  if (STATIC_PAIR) {
    dragPlanet = nearestPlanet(e);
    if (dragPlanet >= 0) {
      pointerToPlane(e, _p);
      dragOffset.set(planetCenters[dragPlanet].x - _p.x, planetCenters[dragPlanet].y - _p.y);
      el.style.cursor = 'grabbing';
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events have no active pointer */ }
    }
    return;
  }
  dragging = true; lastX = e.clientX; lastY = e.clientY; try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthetic events have no active pointer */ }
});
const endDrag = () => { dragging = false; if (dragPlanet >= 0) { dragPlanet = -1; el.style.cursor = 'default'; } };
el.addEventListener('pointerup', endDrag);
el.addEventListener('pointercancel', endDrag);
el.addEventListener('pointermove', (e) => {
  if (STATIC_PAIR) {
    if (dragPlanet >= 0) {
      pointerToPlane(e, _p);
      // keep the planet inside the visible area
      const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
      const maxX = t * camera.aspect - 2, maxY = t - 2;
      planetCenters[dragPlanet].x = THREE.MathUtils.clamp(_p.x + dragOffset.x, -maxX, maxX);
      planetCenters[dragPlanet].y = THREE.MathUtils.clamp(_p.y + dragOffset.y, -maxY, maxY);
    } else if (!e.buttons) {
      el.style.cursor = nearestPlanet(e) >= 0 ? 'grab' : 'default';
    }
    return;
  }
  if (!dragging) return;
  velY = (e.clientX - lastX) * 0.005;
  targetTiltX = THREE.MathUtils.clamp(targetTiltX + (e.clientY - lastY) * 0.004, -0.9, 0.9);
  lastX = e.clientX; lastY = e.clientY;
});

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const t20 = Math.tan(THREE.MathUtils.degToRad(20));
  const fitAspect = STATIC_PAIR ? Math.min(w / h, 1) : Math.min(w / h, 1.6); // the rolling pair must fit in the shorter screen side
  camera.position.z = Math.max(9, (extent / t20) / Math.max(fitAspect, 0.5) * 0.8);
  pointsMat.uniforms.uCamZ.value = camera.position.z;
  {
    const halfH = t20 * camera.position.z, halfW = halfH * camera.aspect;
    clockViewU.value.set(halfW, halfH);
    const Wk = Math.min(halfW * 1.7, halfH * 1.7 * (1024 / 384) * 0.9);   // digits ~85% of the screen width, but never taller than ~45% of the height
    clockRectU.value.set(Wk, Wk * 384 / 1024);
  }
  camera.updateProjectionMatrix();
  pointsMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
let simTime = 0;
const fpsEl = document.getElementById('fps');
let lowFor = 0, highFor = 0;
let fpsFrames = 0, fpsLast = performance.now(), worst = 0, lastFrame = performance.now();
// ---- on-screen controls: for every planet two sliders, "own" and "others" (other planets' particles) ----
// -150 .. +150 with 0 in the middle: to the right = strength of attraction, to the left = strength of repulsion (100 = normal gravity)
const PLANET_DOT = ['#8f5bff', '#ffb02e', '#d8d8d8'];
const SLIDER_MAX = 150;
const controlsEl = document.getElementById('controls');
const modeSliders = [];
function fmtStrength(v) { return v === 0 ? '0' : (v > 0 ? '+' : '−') + Math.abs(v); }
function addSlider(card, planet, kind) {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('span'); lab.className = 'lab'; lab.textContent = kind === 'own' ? 'Свої' : 'Чужі';
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = -SLIDER_MAX; inp.max = SLIDER_MAX; inp.step = 5;
  inp.dataset.planet = planet; inp.dataset.kind = kind;
  inp.title = '← відштовхує | 0 | притягує →   (подвійний клік: початкове значення)';
  const val = document.createElement('span'); val.className = 'val';
  const apply = () => { const v = +inp.value; (kind === 'own' ? ownMode : forMode)[planet] = v / 100; val.textContent = fmtStrength(v); val.className = 'val ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'); };
  inp.addEventListener('input', apply);
  inp.addEventListener('dblclick', () => { inp.value = kind === 'own' ? 100 : 0; apply(); });
  row.append(lab, inp, val);
  card.appendChild(row);
  modeSliders.push({ inp, apply, planet, kind });
}
for (let i = 0; i < PLANETS; i++) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = '<span class="dot" style="background:' + PLANET_DOT[i % 3] + ';box-shadow:0 0 8px ' + PLANET_DOT[i % 3] + '"></span>Планета ' + (i + 1);
  card.appendChild(title);
  addSlider(card, i, 'own');
  addSlider(card, i, 'for');
  controlsEl.appendChild(card);
}
let _lastDragged = -2;
function markDragged() {
  if (_lastDragged === dragPlanet) return;
  _lastDragged = dragPlanet;
  [...controlsEl.children].forEach((c, i) => c.classList.toggle('dragging', i === dragPlanet));
}
function refreshButtons() {   // push the arrays into the sliders
  for (const m of modeSliders) { m.inp.value = Math.round((m.kind === 'own' ? ownMode : forMode)[m.planet] * 100); m.apply(); }
}
refreshButtons();

// ---- webcam: the "Камера" button ----
const camBtn = document.getElementById('camBtn'), camMsg = document.getElementById('camMsg');
const camTest = urlParams.get('camtest') === '1';   // ?camtest=1 feeds a synthetic moving picture instead of the real camera (for testing)
function say(t) { if (camMsg) { camMsg.textContent = t; camMsg.style.opacity = t ? 1 : 0; } }
function syntheticStream() {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d');
  let t = 0;
  setInterval(() => {
    t += 0.05;
    const gr = g.createLinearGradient(0, 0, 320, 240); gr.addColorStop(0, '#0b1030'); gr.addColorStop(1, '#2a1040');
    g.fillStyle = gr; g.fillRect(0, 0, 320, 240);
    const cx = 160 + Math.sin(t) * 40;
    g.fillStyle = '#ffcfa8'; g.beginPath(); g.arc(cx, 105, 48, 0, 7); g.fill();            // head
    g.fillStyle = '#3a7bd5'; g.beginPath(); g.ellipse(cx, 235, 95, 70, 0, 0, 7); g.fill();  // shoulders
    g.fillStyle = '#222'; g.beginPath(); g.arc(cx - 16, 98, 5, 0, 7); g.arc(cx + 16, 98, 5, 0, 7); g.fill(); // eyes
    g.fillStyle = '#c0392b'; g.fillRect(cx - 14, 125, 28, 5);                                // mouth
  }, 33);
  return c.captureStream(30);
}
async function startCamera() {
  try {
    say('Дозвольте доступ до камери у вікні браузера…');
    const stream = camTest ? syntheticStream() : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    await video.play();
    const tex = new THREE.VideoTexture(video);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    Object.assign(camState, { on: true, tex, video, stream, w: video.videoWidth || 640, h: video.videoHeight || 480 });
    camSizeU.value.set(CAM_HEIGHT * camState.w / camState.h, CAM_HEIGHT);
    loadFaceDetector();
    velMat.uniforms.tCam.value = tex; pointsMat.uniforms.tCam.value = tex;
    camBtn.classList.add('on'); camBtn.textContent = 'Камера: вимкнути';
    say('');
  } catch (e) {
    camState.on = false;
    const inClaudeApp = /Claude\//.test(navigator.userAgent);
    say(inClaudeApp
      ? 'У вбудованому вікні Claude камера заблокована. Відкрийте цю сторінку у звичайному браузері (Chrome/Safari): http://localhost:8765'
      : 'Немає доступу до камери (' + (e && e.name ? e.name : e) + '). Дозвольте камеру для цього сайту: значок замка біля адреси → Камера → Дозволити; і перевірте macOS: Системні налаштування → Конфіденційність → Камера.');
    setTimeout(() => say(''), 12000);
  }
}
// ---- face finding: MediaPipe face detector (loaded on demand); if it can't load, a simple skin-colour finder ----
const faceState = { detector: null, status: 'idle', lastDet: 0, lastSeen: -1e9, tgt: { cx: 0, cy: 0, rx: 9.3, ry: 7 } };
let faceOnly = true;
const forceSkin = urlParams.get('detector') === 'skin';   // ?detector=skin skips MediaPipe (used for the synthetic test picture)
async function loadFaceDetector() {
  if (forceSkin) { faceState.status = 'skin'; return; }
  faceState.status = 'loading';
  try {
    const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
    const vision = await import(base + '/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks(base + '/wasm');
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', delegate }, runningMode: 'VIDEO' });
    try { faceState.detector = await vision.FaceDetector.createFromOptions(fileset, opts('GPU')); }
    catch (_) { faceState.detector = await vision.FaceDetector.createFromOptions(fileset, opts('CPU')); }
    faceState.status = 'mediapipe';
  } catch (e) {
    faceState.status = 'skin'; // fallback
    console.warn('Face detector unavailable, using the skin-colour finder:', e);
  }
}
let skinCanvas = null;
function skinFace(video) {
  if (!skinCanvas) { skinCanvas = document.createElement('canvas'); skinCanvas.width = 80; skinCanvas.height = 60; }
  const g = skinCanvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, 0, 0, 80, 60);
  const d = g.getImageData(0, 0, 80, 60).data;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) {
    const i = (y * 80 + x) * 4, r = d[i], gg = d[i + 1], b = d[i + 2];
    const Y = 0.299 * r + 0.587 * gg + 0.114 * b, Cb = 128 - 0.1687 * r - 0.3313 * gg + 0.5 * b, Cr = 128 + 0.5 * r - 0.4187 * gg - 0.0813 * b;
    if (Y > 60 && Cb > 77 && Cb < 127 && Cr > 133 && Cr < 173) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; }
  }
  if (n < 80) return null;
  const mx = sx / n, my = sy / n, vx = Math.max(sxx / n - mx * mx, 1), vy = Math.max(syy / n - my * my, 1);
  const w = Math.sqrt(vx) * 4.2, h = Math.sqrt(vy) * 4.2;     // ~ +-2.1 sigma
  const sc = camState.w / 80;
  return { x: (mx - w / 2) * sc, y: (my - h / 2) * sc, w: w * sc, h: h * sc };
}
function runFaceDetection(now) {
  const v = camState.video;
  if (!camState.on || !v || v.readyState < 2 || now - faceState.lastDet < 70) return;
  faceState.lastDet = now;
  let box = null;
  try {
    if (faceState.detector) {
      const r = faceState.detector.detectForVideo(v, now);
      const d = r.detections && r.detections[0];
      if (d && d.boundingBox) box = { x: d.boundingBox.originX, y: d.boundingBox.originY, w: d.boundingBox.width, h: d.boundingBox.height };
    } else if (faceState.status === 'skin') box = skinFace(v);
  } catch (_) { /* ignore a single bad frame */ }
  if (!box) return;
  faceState.lastSeen = now;
  const Wc = camSizeU.value.x, Hc = camSizeU.value.y, W = camState.w, H = camState.h;
  const cxu = (box.x + box.w / 2) / W, cyv = 1 - (box.y + box.h / 2) / H;
  faceState.tgt = { cx: (0.5 - cxu) * Wc, cy: (cyv - 0.5) * Hc, rx: (box.w / W) * Wc * 0.62, ry: (box.h / H) * Hc * 0.78 };
}
// every frame: ease the ellipse toward the face (or toward the whole frame when no face / "only face" is off)
let _faceT = 0;
function updateFaceUniform(now) {
  const fdt = Math.min(0.5, Math.max(0, (now - _faceT) / 1000)); _faceT = now;
  const seen = now - faceState.lastSeen < 800;
  const Wc = camSizeU.value.x, Hc = camSizeU.value.y;
  const t = faceOnly && seen ? faceState.tgt : { cx: 0, cy: 0, rx: Wc * 0.5, ry: Hc * 0.5 };
  const f = faceU.value, k = 1 - Math.exp(-fdt * 9);   // time based: same speed at any frame rate
  f.x += (t.cx - f.x) * k; f.y += (t.cy - f.y) * k; f.z += (t.rx - f.z) * k; f.w += (t.ry - f.w) * k;
}
const clockBtn = document.getElementById('clockBtn');
function setClock(on) {
  clockState.on = on; clockState.lastSec = -1;
  if (on) drawClock();
  if (clockBtn) { clockBtn.classList.toggle('on', on); clockBtn.textContent = on ? 'Годинник: вимкнути' : 'Годинник (скрінсейвер)'; }
}
if (clockBtn) clockBtn.addEventListener('click', () => setClock(!clockState.on));
addEventListener('keydown', (e) => { if (e.code === 'KeyC' && !e.metaKey && !e.ctrlKey) setClock(!clockState.on); });
// double click = fullscreen (nice for a screensaver)
renderer.domElement.addEventListener('dblclick', (e) => { if (dragPlanet >= 0) return; if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); });
if (urlParams.get('clock') === '1') setClock(true);   // ?clock=1 starts as a clock screensaver
window.__clock = () => ({ on: clockState.on, text: clockState.text, rect: clockRectU.value.toArray().map((x) => +x.toFixed(1)), view: clockViewU.value.toArray().map((x) => +x.toFixed(1)) });
const modeBtn = document.getElementById('modeBtn');
if (modeBtn) modeBtn.addEventListener('click', () => {
  shadowU.value = shadowU.value ? 0 : 1;
  modeBtn.textContent = 'Режим: ' + (shadowU.value ? 'тіні (контур)' : 'кольори');
});
const faceBtn = document.getElementById('faceBtn');
if (faceBtn) faceBtn.addEventListener('click', () => { faceOnly = !faceOnly; faceBtn.textContent = 'Лише обличчя: ' + (faceOnly ? 'так' : 'ні'); });
window.__face = () => ({ status: faceState.status, faceOnly, ellipse: faceU.value.toArray().map((x) => +x.toFixed(2)), seenMsAgo: Math.round(performance.now() - faceState.lastSeen) });

function stopCamera() {
  camState.on = false;
  if (camState.stream) camState.stream.getTracks().forEach((t) => t.stop());
  camBtn.classList.remove('on'); camBtn.textContent = 'Камера: малювати мене';
}
if (camBtn) camBtn.addEventListener('click', () => (camState.on ? stopCamera() : startCamera()));
window.__camState = camState;

// ---- auto-hide the controls after IDLE_MS without interaction (fade + slide), show them again on any movement ----
const IDLE_MS = 5000;
let idleTimer = null;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(sleepUI, IDLE_MS);
}
function sleepUI() {
  // not while the user is dragging a planet / holding a button, nor while the pointer rests on the panel
  if (dragPlanet >= 0 || dragging || controlsEl.matches(':hover')) { idleTimer = setTimeout(sleepUI, 1000); return; }
  document.body.classList.add('idle');
}
for (const ev of ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel']) addEventListener(ev, wake, { passive: true });
wake();

// test helper: window.__reset() restores the default modes
window.__reset = () => { ownMode.fill(1); forMode.fill(0); refreshButtons(); };
window.__set = (planet, kind, v) => { (kind === 'own' ? ownMode : forMode)[planet] = v; refreshButtons(); };

// One simulation step: forces -> velocities -> positions. (Also callable from the console: window.__advance(seconds) fast-forwards.)
function simStep(dt) {
  velMat.uniforms.uCam.value = (camState.on && !clockState.on) ? 1 : 0;
  posMat.uniforms.uCam.value = (camState.on || clockState.on) ? 1 : 0;
  velMat.uniforms.uClock.value = clockState.on ? 1 : 0;
  // While a planet is being dragged its particles lose its gravity (the button value is untouched); on release the button value applies again
  for (let i = 0; i < PLANETS; i++) ownEff[i] = i === dragPlanet ? 0 : ownMode[i];
  // 1) update velocities from forces
  velMat.uniforms.tPos.value = posA.texture;
  velMat.uniforms.tVel.value = velA.texture;
  velMat.uniforms.uTime.value = simTime;
  velMat.uniforms.uDt.value = dt;
  if (!STATIC_PAIR) {
    updateGravity(simTime);
    isGathered = gatherPhase(simTime) >= 0;
    if (wasGathered && !isGathered) releaseKick();
    wasGathered = isGathered;
    stepPlanets(dt, gatherLevel(simTime));
  }
  runPass(velMat, velB);
  [velA, velB] = [velB, velA];

  // 2) integrate positions
  posMat.uniforms.tPos.value = posA.texture;
  posMat.uniforms.tVel.value = velA.texture;
  posMat.uniforms.uDt.value = dt;
  runPass(posMat, posB);
  [posA, posB] = [posB, posA];

  pointsMat.uniforms.tPos.value = posA.texture;
  pointsMat.uniforms.tVel.value = velA.texture;

}
// Debug helper: per colour-planet statistics of the simulated particles (count, NaNs, mean distance from own centre, how many are held by which planet)
window.__stats = () => {
  const px = new Float32Array(SIZE * SIZE * 4), vx = new Float32Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(posA, 0, 0, SIZE, SIZE, px);
  renderer.readRenderTargetPixels(velA, 0, 0, SIZE, SIZE, vx);
  const out = [];
  for (let pl = 0; pl < PLANETS; pl++) out.push({ planet: pl, n: 0, nan: 0, meanR: 0, maxR: 0, held: new Array(PLANETS).fill(0) });
  for (let i = 0; i < SIZE * SIZE; i++) {
    const g = px[i * 4 + 3], pl = Math.floor(g / 3 + 0.001);
    const o = out[pl]; if (!o) continue;
    o.n++;
    const x = px[i * 4], y = px[i * 4 + 1], z = px[i * 4 + 2];
    if (!Number.isFinite(x + y + z)) { o.nan++; continue; }
    const dist = Math.hypot(x - planetCenters[pl].x, y - planetCenters[pl].y, z - planetCenters[pl].z);
    o.meanR += dist; if (dist > o.maxR) o.maxR = dist;
    const h = Math.round(vx[i * 4 + 3]); if (h >= 0 && h < PLANETS) o.held[h]++;
  }
  for (const o of out) { o.meanR = +(o.meanR / Math.max(1, o.n - o.nan)).toFixed(2); o.maxR = +o.maxR.toFixed(2); }
  return out;
};
// Debug helper: smallest / largest distance of any particle from the planet that currently holds it (in planet-radius units of 1.6)
window.__bounds = () => {
  const px = new Float32Array(SIZE * SIZE * 4), vx = new Float32Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(posA, 0, 0, SIZE, SIZE, px);
  renderer.readRenderTargetPixels(velA, 0, 0, SIZE, SIZE, vx);
  let mn = 1e9, mx = 0, over = 0, under = 0, n = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    const h = Math.round(vx[i * 4 + 3]); const c = planetCenters[h]; if (!c) continue;
    const d = Math.hypot(px[i * 4] - c.x, px[i * 4 + 1] - c.y, px[i * 4 + 2] - c.z) / planetScale[h];
    if (!Number.isFinite(d)) continue;
    n++; if (d < mn) mn = d; if (d > mx) mx = d; if (d > R_MAX) over++; if (d < R_MIN - 1e-3) under++;
  }
  return { min: +mn.toFixed(3), max: +mx.toFixed(2), beyondBand: +(over / n * 100).toFixed(1) + '%', belowMin: under, R_MIN, R_MAX, hardCeiling: MAX_SPREAD * RADIUS };
};
// Debug helper for camera mode: where are the particles relative to the face ellipse, per colour planet
window.__camStats = () => {
  const px = new Float32Array(SIZE * SIZE * 4), vx = new Float32Array(SIZE * SIZE * 4);
  renderer.readRenderTargetPixels(posA, 0, 0, SIZE, SIZE, px); renderer.readRenderTargetPixels(velA, 0, 0, SIZE, SIZE, vx);
  const f = faceU.value; const out = [0, 1, 2].map(() => ({ n: 0, inside: 0, near: 0, far: 0, speed: 0, nan: 0 }));
  for (let i = 0; i < SIZE * SIZE; i++) {
    const pl = Math.floor(px[i * 4 + 3] / 3 + 0.001), o = out[pl]; if (!o) continue;
    const x = px[i * 4], y = px[i * 4 + 1]; o.n++;
    if (!Number.isFinite(x + y)) { o.nan++; continue; }
    const q = Math.hypot((x - f.x) / f.z, (y - f.y) / f.w);
    if (q < 1.05) o.inside++; else if (q < 2) o.near++; else o.far++;
    o.speed += Math.hypot(vx[i * 4], vx[i * 4 + 1], vx[i * 4 + 2]);
  }
  return out.map((o, i) => ({ planet: i, n: o.n, insideFace: o.inside, nearby: o.near, far: o.far, nan: o.nan, meanSpeed: +(o.speed / Math.max(1, o.n)).toFixed(2) }));
};
window.__advance = (seconds) => { for (let k = 0; k < seconds * 30; k++) { simTime += 1 / 30; simStep(1 / 30); } return simTime; };

renderer.setAnimationLoop(() => {
  const now = performance.now();
  worst = Math.max(worst, now - lastFrame); lastFrame = now;
  fpsFrames++;
  if (now - fpsLast >= 500) {
    const fps = fpsFrames * 1000 / (now - fpsLast);
    // quality controller
    const adaptive = urlParams.get('adaptive') !== '0'; // ?adaptive=0 turns the quality controller off
    // a hidden / throttled tab (or a one-off stall) is not a performance problem: never lower quality because of it
    const throttled = document.hidden || worst > 500;
    if (!adaptive || throttled) { /* keep current quality */ }
    else if (fps < 32 && activeRows > SIZE * 0.2) { activeRows = Math.max(Math.floor(SIZE * 0.2), Math.floor(activeRows * 0.85)); lowFor = 0; }
    else if (fps > 56 && activeRows < SIZE) { if (++highFor >= 2) { activeRows = Math.min(SIZE, Math.ceil(activeRows * 1.25)); highFor = 0; } }
    if (fps <= 56) highFor = 0;
    geometry.setDrawRange(0, activeRows * SIZE);
    fpsEl.textContent = `${fps.toFixed(0)} FPS · worst ${worst.toFixed(0)} ms · ${Math.round(activeRows / SIZE * 100)}%${isGathered ? ' · gathered' : ''}${planetGrav.slice(0, PLANETS).some((g) => g < 0.5) ? ' · no gravity: planet ' + planetGrav.slice(0, PLANETS).map((g, i) => (g < 0.5 ? i + 1 : 0)).filter(Boolean).join(',') : ''}`;
    fpsEl.className = fps < 30 ? 'bad' : fps < 50 ? 'warn' : '';
    fpsFrames = 0; fpsLast = now; worst = 0;
  }
  const dt = Math.min(clock.getDelta(), 1 / 30);
  simTime += dt;

  simStep(dt);
  markDragged();
  if (camState.on) { runFaceDetection(performance.now()); updateFaceUniform(performance.now()); }
  if (clockState.on) { const sec = Math.floor(Date.now() / 1000); if (sec !== clockState.lastSec) { clockState.lastSec = sec; drawClock(); } }
  clockState.mix += ((clockState.on ? 1 : 0) - clockState.mix) * Math.min(1, dt * 2.5);
  pointsMat.uniforms.uClockMix.value = clockState.mix;
  camState.mix += (((camState.on && !clockState.on) ? 1 : 0) - camState.mix) * Math.min(1, dt * 2.5);
  pointsMat.uniforms.uCamMix.value = camState.mix;

  if (STATIC_PAIR) {
    // planet velocity from the drag, so particles keep their motion relative to their planet (they get carried, not left behind)
    for (let i = 0; i < PLANETS; i++) {
      const vx = (planetCenters[i].x - prevCenter[i].x) / Math.max(dt, 1e-3);
      const vy = (planetCenters[i].y - prevCenter[i].y) / Math.max(dt, 1e-3);
      planetVels[i].x += (THREE.MathUtils.clamp(vx, -12, 12) - planetVels[i].x) * 0.5;
      planetVels[i].y += (THREE.MathUtils.clamp(vy, -12, 12) - planetVels[i].y) * 0.5;
      prevCenter[i].set(planetCenters[i].x, planetCenters[i].y);
    }
  }
  if (STATIC_PAIR) {
    // 2D look: the camera looks straight at the pair and slowly rolls around the view axis, so the planets stay side by side
    // (they never swing in depth). Dragging still turns the view, and it eases back to the flat 2D view when released.
    roll += ROLL_SPEED * dt;
    if (!dragging) { velY *= 0.9; yaw *= 0.97; targetTiltX *= 0.97; }
    yaw += velY;
    tiltX += (targetTiltX - tiltX) * 0.08;
    group.rotation.set(tiltX, yaw, roll);
  } else {
    if (!dragging) velY += (baseSpeed - velY) * 0.03;
    group.rotation.y += velY;
    tiltX += (targetTiltX - tiltX) * 0.08;
    if (!dragging) targetTiltX += (0.15 - targetTiltX) * 0.01;
    group.rotation.x = tiltX;
  }

  renderer.render(scene, camera);
});
