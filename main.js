import WindowManager from './WindowManager.js'
const T = THREE, PI2 = Math.PI * 2;

// ── Smooth noise (value noise with hermite interpolation) ──────────
const PERM = new Uint8Array(512);
for (let i = 0; i < 256; i++) PERM[i] = PERM[i + 256] = (i * 167 + 53) & 255;
function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }
function grad(h, x, y) {
  const a = h & 3;
  return (a === 0 ? x + y : a === 1 ? -x + y : a === 2 ? x - y : -x - y);
}
function noise2d(x, y) {
  const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x), yf = y - Math.floor(y);
  const u = fade(xf), v = fade(yf);
  const aa = PERM[PERM[xi] + yi], ab = PERM[PERM[xi] + yi + 1];
  const ba = PERM[PERM[xi + 1] + yi], bb = PERM[PERM[xi + 1] + yi + 1];
  return lerp(lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u),
              lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u), v);
}
function fbm(x, y, oct) {
  let v = 0, amp = 1, freq = 1, tot = 0;
  for (let i = 0; i < oct; i++) { v += noise2d(x * freq, y * freq) * amp; tot += amp; amp *= .5; freq *= 2; }
  return v / tot;
}

// ── Config ─────────────────────────────────────────────────────────
const C = {
  BG: 0x020110,
  // Particles per window
  FLOW_COUNT: 400,
  TRAIL_LEN: 14,
  // Flow field
  FLOW_SCALE: 0.0015,
  FLOW_SPEED: 1.4,
  FLOW_FORCE: 0.5,
  // Attraction to window center
  CENTER_PULL: 0.004,
  WANDER_RADIUS: 300,
  // Cross-window streams
  STREAM_PARTICLES: 80,
  STREAM_TRAIL: 20,
  // Background
  BG_PARTICLES: 350,
  // Visuals
  HUES: [.55, .82, .35, .08, .72, .95, .15, .45],
};

// ── Globals ────────────────────────────────────────────────────────
let camera, scene, renderer, world, windowManager, initialized = false;
let pixR = window.devicePixelRatio || 1;
let soT = { x: 0, y: 0 }, so = { x: 0, y: 0 };
let today = new Date(); today.setHours(0, 0, 0, 0); today = today.getTime();
const gTime = () => (Date.now() - today) / 1000;

let bgSystem = null;
let winLayers = [];
let streamLayers = [];

// ── Glow texture ───────────────────────────────────────────────────
function mkGlow(sz, softness) {
  const cv = document.createElement('canvas'); cv.width = cv.height = sz;
  const ctx = cv.getContext('2d'), c = sz / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(softness, 'rgba(220,235,255,0.7)');
  g.addColorStop(softness + .25, 'rgba(150,190,255,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, sz, sz);
  return new T.CanvasTexture(cv);
}

function mkSoftGlow(sz) {
  const cv = document.createElement('canvas'); cv.width = cv.height = sz;
  const ctx = cv.getContext('2d'), c = sz / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(.25, 'rgba(200,220,255,0.4)');
  g.addColorStop(.6, 'rgba(120,160,255,0.1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, sz, sz);
  return new T.CanvasTexture(cv);
}

let texMain, texTrail, texBg, texStream;

// ── Init ───────────────────────────────────────────────────────────
if (new URLSearchParams(location.search).get("clear")) { localStorage.clear(); }
else {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState != 'hidden' && !initialized) init(); });
  window.onload = () => { if (document.visibilityState != 'hidden') init(); };

  function init() {
    initialized = true;
    setTimeout(() => {
      texMain = mkGlow(64, .1);
      texTrail = mkSoftGlow(32);
      texBg = mkSoftGlow(16);
      texStream = mkGlow(48, .08);
      setupScene(); setupWM(); mkBackground(); resize();
      updateWS(false); render(); addEventListener('resize', resize);
    }, 500);
  }

  function setupScene() {
    camera = new T.OrthographicCamera(0, 0, innerWidth, innerHeight, -10000, 10000);
    camera.position.z = 2.5;
    scene = new T.Scene(); scene.background = new T.Color(C.BG);
    scene.add(camera);
    renderer = new T.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(pixR);
    world = new T.Object3D(); scene.add(world);
    renderer.domElement.id = "scene"; document.body.appendChild(renderer.domElement);
  }

  function setupWM() {
    windowManager = new WindowManager();
    windowManager.setWinShapeChangeCallback(updateWS);
    windowManager.setWinChangeCallback(() => rebuild());
    windowManager.init({}); rebuild();
  }

  // ── Background ambient particles ────────────────────────────────
  function mkBackground() {
    let n = C.BG_PARTICLES;
    let pos = new Float32Array(n * 3), col = new Float32Array(n * 3), vel = [];
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - .5) * 4000 + screen.width / 2;
      pos[i * 3 + 1] = (Math.random() - .5) * 4000 + screen.height / 2;
      pos[i * 3 + 2] = (Math.random() - .5) * 50;
      let c = new T.Color(); c.setHSL(.6 + Math.random() * .2, .5, .15 + Math.random() * .12);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      vel.push({ x: (Math.random() - .5) * .1, y: (Math.random() - .5) * .1 });
    }
    let g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    let m = new T.PointsMaterial({ size: 3, map: texBg, vertexColors: true, transparent: true,
      opacity: .7, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: false });
    let p = new T.Points(g, m); world.add(p);
    bgSystem = { points: p, geo: g, vel };
  }

  // ── Create flow particles for a window ──────────────────────────
  function createFlowSystem(cx, cy, hue, count, trailLen, tex, baseSize) {
    let particles = [];
    for (let i = 0; i < count; i++) {
      let angle = Math.random() * PI2;
      let r = Math.random() * C.WANDER_RADIUS;
      let x = cx + Math.cos(angle) * r;
      let y = cy + Math.sin(angle) * r;
      // trail: array of past positions
      let trail = [];
      for (let t = 0; t < trailLen; t++) trail.push({ x, y, z: 0 });
      let c = new T.Color();
      c.setHSL(hue + (Math.random() - .5) * .08, .8 + Math.random() * .15, .5 + Math.random() * .4);
      particles.push({
        x, y, z: (Math.random() - .5) * 20,
        vx: 0, vy: 0,
        trail, color: c,
        phase: Math.random() * PI2,
        size: baseSize * (.6 + Math.random() * .8)
      });
    }
    // Build points for head + all trail positions
    let total = count * (1 + trailLen);
    let pos = new Float32Array(total * 3);
    let col = new Float32Array(total * 3);
    let geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    let mat = new T.PointsMaterial({ size: baseSize, map: tex, vertexColors: true,
      transparent: true, opacity: .95, blending: T.AdditiveBlending,
      depthWrite: false, sizeAttenuation: false });
    let pts = new T.Points(geo, mat);
    world.add(pts);
    return { particles, geo, pts, mat, trailLen, count };
  }

  // ── Rebuild everything ──────────────────────────────────────────
  function rebuild() {
    let wins = windowManager.getWindows();
    // Cleanup
    winLayers.forEach(w => { world.remove(w.flow.pts); world.remove(w.connLine); });
    streamLayers.forEach(s => world.remove(s.flow.pts));
    winLayers = []; streamLayers = [];

    for (let i = 0; i < wins.length; i++) {
      let w = wins[i], hue = C.HUES[i % C.HUES.length];
      let cx = w.shape.x + w.shape.w * .5, cy = w.shape.y + w.shape.h * .5;
      let flow = createFlowSystem(cx, cy, hue, C.FLOW_COUNT, C.TRAIL_LEN, texMain, 7);
      // Soft connection lines
      let clMat = new T.LineBasicMaterial({ color: new T.Color().setHSL(hue, .7, .35),
        transparent: true, opacity: .12, blending: T.AdditiveBlending, depthWrite: false });
      let clGeo = new T.BufferGeometry();
      let cl = new T.LineSegments(clGeo, clMat);
      world.add(cl);
      winLayers.push({ flow, connLine: cl, hue, winId: w.id });
    }

    // Cross-window flowing streams
    for (let i = 0; i < wins.length; i++) {
      for (let j = i + 1; j < wins.length; j++) {
        let hMix = (C.HUES[i % 8] + C.HUES[j % 8]) / 2;
        let wA = wins[i], wB = wins[j];
        let cxA = wA.shape.x + wA.shape.w * .5, cyA = wA.shape.y + wA.shape.h * .5;
        let cxB = wB.shape.x + wB.shape.w * .5, cyB = wB.shape.y + wB.shape.h * .5;
        let midX = (cxA + cxB) / 2, midY = (cyA + cyB) / 2;
        let flow = createFlowSystem(midX, midY, hMix, C.STREAM_PARTICLES, C.STREAM_TRAIL, texStream, 6);
        // Initialize stream particles along the path between windows
        for (let p = 0; p < flow.particles.length; p++) {
          let frac = p / flow.particles.length;
          let px = cxA + (cxB - cxA) * frac + (Math.random() - .5) * 60;
          let py = cyA + (cyB - cyA) * frac + (Math.random() - .5) * 60;
          flow.particles[p].x = px; flow.particles[p].y = py;
          for (let t = 0; t < flow.trailLen; t++) {
            flow.particles[p].trail[t].x = px; flow.particles[p].trail[t].y = py;
          }
        }
        streamLayers.push({ flow, idxA: i, idxB: j });
      }
    }
  }

  function updateWS(easing = true) {
    soT = { x: -screenX, y: -screenY };
    if (!easing) so = soT;
  }

  // ── Update a flow system with noise field ───────────────────────
  function updateFlow(sys, cx, cy, time, pull, wanderR, flowScale, flowSpeed) {
    let ps = sys.particles;
    let pos = sys.geo.attributes.position.array;
    let col = sys.geo.attributes.color.array;
    let tl = sys.trailLen, n = sys.count;

    for (let i = 0; i < n; i++) {
      let p = ps[i];
      // Flow field force from noise
      let nx = p.x * flowScale;
      let ny = p.y * flowScale;
      let angle = fbm(nx + time * .12, ny + time * .08, 4) * PI2 * 2;
      let fx = Math.cos(angle) * C.FLOW_FORCE;
      let fy = Math.sin(angle) * C.FLOW_FORCE;

      // Gentle pull toward center
      let dx = cx - p.x, dy = cy - p.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      let pullF = pull;
      if (dist > wanderR) pullF += (dist - wanderR) * .002;
      fx += dx * pullF;
      fy += dy * pullF;

      // Smooth velocity (high damping = liquid feel)
      p.vx += fx * .15;
      p.vy += fy * .15;
      p.vx *= .92;
      p.vy *= .92;

      // Subtle sine wave undulation
      p.vx += Math.sin(time * .7 + p.phase) * .08;
      p.vy += Math.cos(time * .5 + p.phase * 1.3) * .08;

      // Update position
      p.x += p.vx * flowSpeed;
      p.y += p.vy * flowSpeed;
      p.z = Math.sin(time * .4 + p.phase) * 12;

      // Shift trail (unshift new, pop old)
      p.trail.pop();
      p.trail.unshift({ x: p.x, y: p.y, z: p.z });

      // Write head particle
      let idx = i * (1 + tl);
      pos[idx * 3] = p.x; pos[idx * 3 + 1] = p.y; pos[idx * 3 + 2] = p.z;
      // Head color: full brightness
      col[idx * 3] = p.color.r; col[idx * 3 + 1] = p.color.g; col[idx * 3 + 2] = p.color.b;

      // Write trail particles with fading color
      for (let t = 0; t < tl; t++) {
        let ti = idx + 1 + t;
        let tr = p.trail[t];
        pos[ti * 3] = tr.x; pos[ti * 3 + 1] = tr.y; pos[ti * 3 + 2] = tr.z;
        let fade = 1 - (t + 1) / (tl + 1);
        fade = fade * fade; // quadratic falloff for smoother trail
        col[ti * 3] = p.color.r * fade * .7;
        col[ti * 3 + 1] = p.color.g * fade * .7;
        col[ti * 3 + 2] = p.color.b * fade * .7;
      }
    }
    sys.geo.attributes.position.needsUpdate = true;
    sys.geo.attributes.color.needsUpdate = true;
  }

  // ── Update stream particles (flow between two windows) ──────────
  function updateStream(sys, cxA, cyA, cxB, cyB, time) {
    let ps = sys.particles;
    let pos = sys.geo.attributes.position.array;
    let col = sys.geo.attributes.color.array;
    let tl = sys.trailLen, n = sys.count;
    let midX = (cxA + cxB) / 2, midY = (cyA + cyB) / 2;
    let pathDx = cxB - cxA, pathDy = cyB - cyA;
    let pathLen = Math.sqrt(pathDx * pathDx + pathDy * pathDy);
    // Normal to path
    let normX = -pathDy / (pathLen || 1), normY = pathDx / (pathLen || 1);

    for (let i = 0; i < n; i++) {
      let p = ps[i];
      // Project onto path to find where particle is
      let relX = p.x - cxA, relY = p.y - cyA;
      let proj = (relX * pathDx + relY * pathDy) / (pathLen * pathLen || 1);

      // Flow along path direction with sine wave perpendicular offset
      let flowAngle = Math.atan2(pathDy, pathDx);
      let noiseVal = fbm(p.x * .003 + time * .1, p.y * .003 + time * .08, 3);

      // Force along the path (oscillating direction)
      let dir = Math.sin(time * .3 + i * .5) > 0 ? 1 : -1;
      let fx = Math.cos(flowAngle) * .4 * dir;
      let fy = Math.sin(flowAngle) * .4 * dir;

      // Perpendicular wave force
      fx += normX * noiseVal * .8;
      fy += normY * noiseVal * .8;

      // Pull back to path center
      let pathX = cxA + pathDx * Math.max(0, Math.min(1, proj));
      let pathY = cyA + pathDy * Math.max(0, Math.min(1, proj));
      let perpDist = Math.sqrt((p.x - pathX) * (p.x - pathX) + (p.y - pathY) * (p.y - pathY));
      if (perpDist > 80) {
        fx += (pathX - p.x) * .01;
        fy += (pathY - p.y) * .01;
      }

      // Pull back if too far past endpoints
      if (proj < -.1) { fx += pathDx * .003; fy += pathDy * .003; }
      if (proj > 1.1) { fx -= pathDx * .003; fy -= pathDy * .003; }

      p.vx += fx * .12; p.vy += fy * .12;
      p.vx *= .94; p.vy *= .94;
      p.x += p.vx; p.y += p.vy;
      p.z = Math.sin(time * .5 + p.phase + proj * 4) * 8;

      p.trail.pop();
      p.trail.unshift({ x: p.x, y: p.y, z: p.z });

      let idx = i * (1 + tl);
      pos[idx * 3] = p.x; pos[idx * 3 + 1] = p.y; pos[idx * 3 + 2] = p.z;
      col[idx * 3] = p.color.r; col[idx * 3 + 1] = p.color.g; col[idx * 3 + 2] = p.color.b;

      for (let t = 0; t < tl; t++) {
        let ti = idx + 1 + t, tr = p.trail[t];
        pos[ti * 3] = tr.x; pos[ti * 3 + 1] = tr.y; pos[ti * 3 + 2] = tr.z;
        let fade = 1 - (t + 1) / (tl + 1); fade *= fade;
        col[ti * 3] = p.color.r * fade * .65;
        col[ti * 3 + 1] = p.color.g * fade * .65;
        col[ti * 3 + 2] = p.color.b * fade * .65;
      }
    }
    sys.geo.attributes.position.needsUpdate = true;
    sys.geo.attributes.color.needsUpdate = true;
  }

  // ── Render ──────────────────────────────────────────────────────
  function render() {
    let time = gTime();
    windowManager.update();
    let f = .05;
    so.x += (soT.x - so.x) * f; so.y += (soT.y - so.y) * f;
    world.position.x = so.x; world.position.y = so.y;
    let wins = windowManager.getWindows();

    // Background drift
    if (bgSystem) {
      let bp = bgSystem.geo.attributes.position.array;
      for (let i = 0; i < C.BG_PARTICLES; i++) {
        let angle = fbm(bp[i * 3] * .0005 + time * .02, bp[i * 3 + 1] * .0005 + time * .015, 2) * PI2;
        bp[i * 3] += Math.cos(angle) * .12;
        bp[i * 3 + 1] += Math.sin(angle) * .1;
      }
      bgSystem.geo.attributes.position.needsUpdate = true;
    }

    // Per-window flow particles
    for (let w = 0; w < winLayers.length && w < wins.length; w++) {
      let L = winLayers[w], win = wins[w];
      let cx = win.shape.x + win.shape.w * .5, cy = win.shape.y + win.shape.h * .5;
      updateFlow(L.flow, cx, cy, time + w * 5, C.CENTER_PULL, C.WANDER_RADIUS,
        C.FLOW_SCALE, C.FLOW_SPEED);
      L.flow.mat.opacity = .85 + Math.sin(time * .8 + w) * .1;

      // Soft connection lines (sparse, only close neighbors)
      let ps = L.flow.particles;
      let lv = [], step = Math.max(1, Math.floor(C.FLOW_COUNT / 40));
      for (let a = 0; a < C.FLOW_COUNT; a += step) {
        for (let b = a + step; b < C.FLOW_COUNT; b += step) {
          let dx = ps[a].x - ps[b].x, dy = ps[a].y - ps[b].y;
          let d = Math.sqrt(dx * dx + dy * dy);
          if (d < 140) {
            lv.push(ps[a].x, ps[a].y, ps[a].z, ps[b].x, ps[b].y, ps[b].z);
          }
        }
        if (lv.length > 2400) break;
      }
      let lg = new T.BufferGeometry();
      if (lv.length) lg.setAttribute('position', new T.BufferAttribute(new Float32Array(lv), 3));
      L.connLine.geometry.dispose(); L.connLine.geometry = lg;
      L.connLine.material.opacity = .1 + Math.sin(time * .6 + w) * .04;
    }

    // Cross-window streams
    for (let s = 0; s < streamLayers.length; s++) {
      let S = streamLayers[s];
      if (S.idxA >= wins.length || S.idxB >= wins.length) continue;
      let wA = wins[S.idxA], wB = wins[S.idxB];
      let cxA = wA.shape.x + wA.shape.w * .5, cyA = wA.shape.y + wA.shape.h * .5;
      let cxB = wB.shape.x + wB.shape.w * .5, cyB = wB.shape.y + wB.shape.h * .5;
      updateStream(S.flow, cxA, cyA, cxB, cyB, time);
      S.flow.mat.opacity = .8 + Math.sin(time + s) * .12;
    }

    renderer.render(scene, camera);
    requestAnimationFrame(render);
  }

  function resize() {
    let w = innerWidth, h = innerHeight;
    camera = new T.OrthographicCamera(0, w, 0, h, -10000, 10000);
    camera.updateProjectionMatrix(); renderer.setSize(w, h);
  }
}