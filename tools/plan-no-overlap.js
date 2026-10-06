// Plans the "No overlap" choreography and writes it into index.html.
//
//   node tools/plan-no-overlap.js
//
// The page's states are fixed, so the search runs here once rather than in
// the browser. Re-run it whenever STATES in index.html change. Each piece
// gets a target, a time window, a curved path and a delayed turn; a seeded
// randomised search tunes them until no two triangles overlap at any time.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

// Pull the state data and helpers straight from the page.
const src = html.slice(html.indexOf('const STATES = ['), html.indexOf('let PLAN = [];'));
const { POSES, LEG, CENTROID_OFFSET, shortestTurn, assign } =
  new Function(src + '; return { POSES, LEG, CENTROID_OFFSET, shortestTurn, assign };')();

const TOUCH = 0.02; // resting edges touch exactly; allow only float noise
const smoother = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10);

function triPoints(x, y, a, out, o) {
  const ux = Math.cos(a), uy = Math.sin(a), c = Math.SQRT1_2;
  const Px = x - ux * CENTROID_OFFSET, Py = y - uy * CENTROID_OFFSET;
  out[o] = Px; out[o+1] = Py;
  out[o+2] = Px + (ux*c - uy*c) * LEG; out[o+3] = Py + (ux*c + uy*c) * LEG;
  out[o+4] = Px + (ux*c + uy*c) * LEG; out[o+5] = Py + (-ux*c + uy*c) * LEG;
}
function penetration(A, ao, B, bo) {
  let best = Infinity;
  for (let s = 0; s < 2; s++) {
    const P = s ? B : A, po = s ? bo : ao;
    for (let e = 0; e < 3; e++) {
      const x1 = P[po + e*2], y1 = P[po + e*2 + 1];
      const x2 = P[po + ((e+1)%3)*2], y2 = P[po + ((e+1)%3)*2 + 1];
      let nx = y1 - y2, ny = x2 - x1;
      const l = Math.hypot(nx, ny); nx /= l; ny /= l;
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let k = 0; k < 3; k++) {
        const pa = A[ao + k*2] * nx + A[ao + k*2 + 1] * ny;
        const pb = B[bo + k*2] * nx + B[bo + k*2 + 1] * ny;
        if (pa < amin) amin = pa; if (pa > amax) amax = pa;
        if (pb < bmin) bmin = pb; if (pb > bmax) bmax = pb;
      }
      const ov = Math.min(amax, bmax) - Math.max(amin, bmin);
      if (ov <= TOUCH) return 0;
      if (ov < best) best = ov;
    }
  }
  return best - TOUCH;
}
function poseAt(p, m, tau) {
  const k = smoother((tau - m.s) / m.dur), j = 1 - k;
  const b0 = j*j*j, b1 = 3*j*j*k, b2 = 3*j*k*k, b3 = k*k*k;
  const r = smoother((k - m.ra) / (m.rb - m.ra));
  return {
    x: b0*p.x + b1*(p.x + m.v1x) + b2*(m.q.x + m.v2x) + b3*m.q.x,
    y: b0*p.y + b1*(p.y + m.v1y) + b2*(m.q.y + m.v2y) + b3*m.q.y,
    a: p.a + m.d * r,
  };
}
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `times` are the τ values checked for overlaps; `init` warm-starts the search.
function plan(from, to, seed, times, init) {
  const n = from.length, N = times.length, rand = rng(seed);
  let match = assign(from.map(p => to.map(q =>
    Math.abs(shortestTurn(p.a, q.a, 1)) / (Math.PI/2) + 0.25 * Math.hypot(q.x - p.x, q.y - p.y) / LEG)));

  const M = from.map(() => ({}));
  const setTarget = (i, j) => {
    const m = M[i], p = from[i]; m.j = j; m.q = to[j];
    m.d0 = shortestTurn(p.a, m.q.a, i % 2 ? -1 : 1);
    m.still = Math.hypot(m.q.x - p.x, m.q.y - p.y) < 1 && Math.abs(m.d0) < 1e-3;
  };
  const fixD = m => { m.d = m.d0 + (m.alt ? -Math.sign(m.d0 || 1) * 2 * Math.PI : 0); };
  const straight = i => {
    const m = M[i], p = from[i];
    m.v1x = (m.q.x - p.x) / 3; m.v1y = (m.q.y - p.y) / 3; m.v2x = -m.v1x; m.v2y = -m.v1y;
  };
  const randomise = (i, keepStill) => {
    const m = M[i];
    m.alt = 0; fixD(m);
    m.dur = 0.35 + rand() * 0.45; m.s = rand() * (1 - m.dur);
    m.ra = 0; m.rb = 1;
    straight(i);
    if (m.still && keepStill) return;
    const R = 250;
    m.v1x += (rand()*2-1) * R; m.v1y += (rand()*2-1) * R;
    m.v2x += (rand()*2-1) * R; m.v2y += (rand()*2-1) * R;
    const a = rand() * 0.6; m.ra = a; m.rb = Math.min(1, a + 0.25 + rand() * 0.5);
  };
  from.forEach((_, i) => setTarget(i, match[i]));

  const T = M.map(() => new Float64Array(N * 6));
  const off = new Float64Array(n); // out-of-frame penalty per piece
  const sample = i => {
    let o = 0;
    for (let k = 0; k < N; k++) {
      const P = poseAt(from[i], M[i], times[k]);
      triPoints(P.x, P.y, P.a, T[i], k * 6);
      for (let v = 0; v < 6; v++) { const z = T[i][k*6+v]; if (z < 10) o += (10 - z) ** 2; else if (z > 990) o += (z - 990) ** 2; }
    }
    off[i] = o;
  };
  const pairCost = (i, j) => {
    let c = 0; const A = T[i], B = T[j];
    for (let k = 0; k < N; k++) {
      const o = k * 6;
      const dx = (A[o] + A[o+2] + A[o+4] - B[o] - B[o+2] - B[o+4]) / 3;
      const dy = (A[o+1] + A[o+3] + A[o+5] - B[o+1] - B[o+3] - B[o+5]) / 3;
      if (dx*dx + dy*dy > 300*300) continue;
      const pen = penetration(A, o, B, o); c += pen * pen;
    }
    return c;
  };
  const C = Array.from({ length: n }, () => new Float64Array(n));
  const rowCost = i => { let c = off[i]; for (let j = 0; j < n; j++) if (j !== i) c += C[i][j]; return c; };
  const refresh = i => { sample(i); for (let j = 0; j < n; j++) if (j !== i) C[i][j] = C[j][i] = pairCost(i, j); };
  const total = () => { let c = 0; for (let i = 0; i < n; i++) { c += off[i]; for (let j = i+1; j < n; j++) c += C[i][j]; } return c; };
  const pathLen = i => { // regulariser: control-point detours, turn, rotation squeeze
    const m = M[i], p = from[i];
    const sx = (m.q.x - p.x) / 3, sy = (m.q.y - p.y) / 3;
    return Math.hypot(m.v1x - sx, m.v1y - sy) + Math.hypot(m.v2x + sx, m.v2y + sy) + Math.abs(m.d) * 60;
  };
  const snap = m => ({ ...m });

  let best = null, bestCost = Infinity;
  for (let restart = 0; restart < 40 && bestCost > 0; restart++) {
    if (init && restart === 0) init.forEach((m, i) => { M[i] = snap(m); });
    else from.forEach((_, i) => randomise(i, true));
    from.forEach((_, i) => sample(i));
    for (let i = 0; i < n; i++) for (let j = i+1; j < n; j++) C[i][j] = C[j][i] = pairCost(i, j);
    let cost = total(), temp = 2000;
    for (let it = 0; it < 6000 && cost > 0; it++, temp *= 0.999) {
      const bad = []; for (let i = 0; i < n; i++) if (rowCost(i) > 0) bad.push(i);
      if (!bad.length) break;
      const i = bad[Math.floor(rand() * bad.length)];
      const r = rand();
      if (r < 0.06) { // swap targets with another piece
        const j = Math.floor(rand() * n); if (j === i) continue;
        const si = snap(M[i]), sj = snap(M[j]);
        const before = rowCost(i) + rowCost(j) - C[i][j];
        const ti = M[i].j; setTarget(i, M[j].j); setTarget(j, ti);
        randomise(i, false); randomise(j, false);
        refresh(i); refresh(j);
        const after = rowCost(i) + rowCost(j) - C[i][j];
        if (after < before || rand() < Math.exp((before - after) / temp)) cost += after - before;
        else { M[i] = si; M[j] = sj; refresh(i); refresh(j); }
        continue;
      }
      const saved = snap(M[i]), before = rowCost(i), m = M[i];
      if (r < 0.15) randomise(i, false);
      else {
        const big = rand() < 0.4, a = big ? 0.2 : 0.05, R = big ? 120 : 30;
        const which = Math.floor(rand() * 4);
        if (which === 0) { m.dur = Math.max(0.2, Math.min(1, m.dur + (rand()*2-1) * a)); m.s = Math.max(0, Math.min(1 - m.dur, m.s + (rand()*2-1) * a)); }
        else if (which === 1) { m.v1x += (rand()*2-1) * R; m.v1y += (rand()*2-1) * R; }
        else if (which === 2) { m.v2x += (rand()*2-1) * R; m.v2y += (rand()*2-1) * R; }
        else {
          m.ra = Math.max(0, Math.min(0.85, m.ra + (rand()*2-1) * a));
          m.rb = Math.max(m.ra + 0.15, Math.min(1, m.rb + (rand()*2-1) * a));
          if (rand() < 0.1 && Math.abs(m.d0) > 1e-3) { m.alt ^= 1; fixD(m); }
        }
      }
      refresh(i);
      const after = rowCost(i);
      if (after <= before || rand() < Math.exp((before - after) / temp)) cost += after - before;
      else { M[i] = saved; refresh(i); }
    }
    cost = total();
    if (cost < bestCost) { bestCost = cost; best = M.map(snap); }
  }
  if (bestCost > 0) return { moves: best, cost: bestCost };

  // Polish: shorten detours and spread windows while staying overlap-free.
  M.splice(0, n, ...best.map(snap));
  from.forEach((_, i) => sample(i));
  for (let i = 0; i < n; i++) for (let j = i+1; j < n; j++) C[i][j] = C[j][i] = pairCost(i, j);
  for (let it = 0; it < 3000; it++) {
    const i = Math.floor(rand() * n), m = M[i], saved = snap(m);
    const before = pathLen(i);
    const f = 0.85 + rand() * 0.1, p = from[i];
    const sx = (m.q.x - p.x) / 3, sy = (m.q.y - p.y) / 3;
    const w = Math.floor(rand() * 3);
    if (w === 0) { m.v1x = sx + (m.v1x - sx) * f; m.v1y = sy + (m.v1y - sy) * f; }
    else if (w === 1) { m.v2x = -sx + (m.v2x + sx) * f; m.v2y = -sy + (m.v2y + sy) * f; }
    else { m.dur = Math.min(1, m.dur * 1.05); m.s = Math.max(0, Math.min(1 - m.dur, m.s)); }
    refresh(i);
    if (rowCost(i) > 0 || (w < 2 && pathLen(i) > before)) { M[i] = saved; refresh(i); }
  }
  return { moves: M.map(snap), cost: total() };
}

// Fine-grained check; also returns the τ values where anything overlaps.
function verify(from, moves, N) {
  const A = new Float64Array(from.length * 6);
  let worst = 0, out = 0;
  const bad = [];
  for (let k = 0; k < N; k++) {
    const tau = k / (N - 1);
    from.forEach((p, i) => { const P = poseAt(p, moves[i], tau); triPoints(P.x, P.y, P.a, A, i * 6); });
    for (let v = 0; v < A.length; v++) out = Math.max(out, -A[v], A[v] - 1000);
    let w = 0;
    for (let i = 0; i < from.length; i++) for (let j = i+1; j < from.length; j++)
      w = Math.max(w, penetration(A, i*6, A, j*6));
    if (w > 0) bad.push(tau);
    worst = Math.max(worst, w);
  }
  return { worst, out, bad };
}

const r1 = x => Math.round(x * 10) / 10, r4 = x => Math.round(x * 1e4) / 1e4;
const plans = [];
for (let s = 0; s < POSES.length; s++) {
  const from = POSES[s], to = POSES[(s + 1) % POSES.length];
  const round = moves => moves.map(m => ({ ...m,
    s: r4(m.s), dur: r4(m.dur), v1x: r1(m.v1x), v1y: r1(m.v1y), v2x: r1(m.v2x), v2y: r1(m.v2y),
    ra: r4(m.ra), rb: r4(m.rb), d: r4(m.d) }));
  const times = Array.from({ length: 400 }, (_, k) => k / 399);
  let r;
  for (let seed = 1; seed <= 4; seed++) {
    r = plan(from, to, seed * 101 + s, times);
    if (r.cost === 0) break;
  }
  // Check the stored (rounded) plan finely; wherever it overlaps, add those
  // moments to the sampled set and carry on searching from where we are.
  let moves = round(r.moves), check;
  for (let round_ = 0; round_ < 30; round_++) {
    check = verify(from, moves, 30000);
    if (!check.bad.length && check.out === 0) break;
    times.push(...check.bad.filter((_, k) => k % Math.ceil(check.bad.length / 200) === 0));
    r = plan(from, to, round_ * 7919 + s, times, moves);
    moves = round(r.moves);
  }
  const ok = check.worst === 0 && check.out === 0;
  console.log(`transition ${s + 1}: ${ok ? 'ok' : 'FAILED'} · max overlap ${check.worst.toFixed(3)} · out of frame ${check.out.toFixed(1)} · ${times.length} samples`);
  if (!ok) process.exitCode = 1;
  // Store compactly: [target, start, duration, v1x, v1y, v2x, v2y, turnFrom, turnTo, turn]
  plans.push(moves.map(m => [m.j, m.s, m.dur, m.v1x, m.v1y, m.v2x, m.v2y, m.ra, m.rb, m.d]));
}

const begin = '// NO_OVERLAP_PLANS:begin', end = '// NO_OVERLAP_PLANS:end';
const a = html.indexOf(begin), b = html.indexOf(end);
if (a < 0 || b < 0) throw new Error('Markers not found in index.html');
const body = 'const NO_OVERLAP_PLANS = [\n' + plans.map(p => '  ' + JSON.stringify(p)).join(',\n') + ',\n];\n';
fs.writeFileSync(FILE, html.slice(0, a) + begin + '\n' + body + html.slice(b));
console.log('Wrote NO_OVERLAP_PLANS to index.html');
