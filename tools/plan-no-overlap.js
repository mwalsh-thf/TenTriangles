// Plans the "No overlap" (puzzle) choreography and writes it into index.html.
//
//   node tools/plan-no-overlap.js
//
// The page's states are fixed, so the search runs here once rather than in
// the browser. Re-run it whenever STATES in index.html change.
//
// Pieces move like a sliding puzzle inside the square that holds every icon
// (BOUNDS): straight and diagonal slides on the 100-unit grid and quarter turns, one
// move at a time, never overlapping another piece or leaving the square.
// Moves whose swept areas can't touch are then allowed to run together.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

const src = html.slice(html.indexOf('const STATES = ['), html.indexOf('const IDS'));
const STATES = new Function(src + '; return STATES;')();

const GRID = 100, LEG = 200;
const BOUNDS = [100, 900];      // square that contains all six icons
const TOUCH = 0.02;             // resting edges touch exactly; allow float noise
const SLIDE = 0, TURN = 1;

// --- Geometry --------------------------------------------------------------
// A piece is {px, py, o}: the right-angle vertex P on the grid and its
// orientation o (0–3): legs point along o·90° and o·90° + 90°.
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const verts = ({ px, py, o }) => {
  const [ax, ay] = DIRS[o], [bx, by] = DIRS[(o + 1) % 4];
  return [px, py, px + ax * LEG, py + ay * LEG, px + bx * LEG, py + by * LEG];
};
function fromTri(pts) {
  for (let r = 0; r < 3; r++) {
    const P = pts[r], A = pts[(r + 1) % 3], B = pts[(r + 2) % 3];
    const ax = A[0] - P[0], ay = A[1] - P[1], bx = B[0] - P[0], by = B[1] - P[1];
    if (Math.abs(ax * bx + ay * by) > 1) continue;
    const sx = Math.sign(ax + bx), sy = Math.sign(ay + by); // bisector quadrant
    const o = sx > 0 ? (sy > 0 ? 0 : 3) : (sy > 0 ? 1 : 2);
    return { px: P[0], py: P[1], o };
  }
}
const key = p => `${p.px},${p.py},${p.o}`;
const same = (a, b) => a.px === b.px && a.py === b.py && a.o === b.o;

// Penetration depth via separating axes; 0 if apart or only touching.
function penetration(A, B) {
  let best = Infinity;
  for (const P of [A, B]) for (let e = 0; e < 3; e++) {
    const x1 = P[e * 2], y1 = P[e * 2 + 1], x2 = P[((e + 1) % 3) * 2], y2 = P[((e + 1) % 3) * 2 + 1];
    let nx = y1 - y2, ny = x2 - x1; const l = Math.hypot(nx, ny); nx /= l; ny /= l;
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (let k = 0; k < 3; k++) {
      const pa = A[k * 2] * nx + A[k * 2 + 1] * ny, pb = B[k * 2] * nx + B[k * 2 + 1] * ny;
      if (pa < amin) amin = pa; if (pa > amax) amax = pa;
      if (pb < bmin) bmin = pb; if (pb > bmax) bmax = pb;
    }
    const ov = Math.min(amax, bmax) - Math.max(amin, bmin);
    if (ov <= TOUCH) return 0;
    best = Math.min(best, ov);
  }
  return best - TOUCH;
}
const inBounds = V => V.every(v => v >= BOUNDS[0] - 1e-6 && v <= BOUNDS[1] + 1e-6);

// --- Moves -----------------------------------------------------------------
// A move is a slide by (dx, dy) or a quarter turn (±π/2) about a pivot.
// sweep() samples the triangle along the way, endpoints included.
function applyMove(p, m) {
  if (m.type === SLIDE) return { px: p.px + m.dx, py: p.py + m.dy, o: p.o };
  const c = Math.cos(m.th), s = Math.sin(m.th);
  const rx = p.px - m.cx, ry = p.py - m.cy;
  return { px: Math.round(m.cx + rx * c - ry * s), py: Math.round(m.cy + rx * s + ry * c), o: (p.o + (m.th > 0 ? 1 : 3)) % 4 };
}
function sweep(p, m) {
  const V0 = verts(p), out = [];
  const steps = m.type === SLIDE ? Math.max(2, Math.ceil(Math.hypot(m.dx, m.dy) / 5)) : 36;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (m.type === SLIDE) out.push(V0.map((v, i) => v + (i % 2 ? m.dy : m.dx) * t));
    else {
      const c = Math.cos(m.th * t), s = Math.sin(m.th * t), V = [];
      for (let i = 0; i < 6; i += 2) {
        const rx = V0[i] - m.cx, ry = V0[i + 1] - m.cy;
        V.push(m.cx + rx * c - ry * s, m.cy + rx * s + ry * c);
      }
      out.push(V);
    }
  }
  return out;
}
// Single-step moves from a pose that stay inside BOUNDS, with cost, swept
// samples and their bounding box. Geometry only, so cached per pose.
const edgeCache = new Map();
function edges(p) {
  const k = key(p);
  if (edgeCache.has(k)) return edgeCache.get(k);
  const ms = [];
  for (const [dx, dy] of DIRS) ms.push([{ type: SLIDE, dx: dx * GRID, dy: dy * GRID }, 1]);
  // diagonal slides let a piece glide along its long edge into a half-square
  for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]])
    ms.push([{ type: SLIDE, dx: dx * GRID, dy: dy * GRID }, 1.4]);
  const V = verts(p);
  const mx = (V[2] + V[4]) / 2, my = (V[3] + V[5]) / 2;
  for (const th of [Math.PI / 2, -Math.PI / 2]) {
    ms.push([{ type: TURN, cx: p.px, cy: p.py, th }, 2.5]); // hinge on the corner
    ms.push([{ type: TURN, cx: mx, cy: my, th }, 2.5]);     // flip within its square
  }
  const out = [];
  for (const [m, cost] of ms) {
    const S = sweep(p, m);
    if (!S.every(inBounds)) continue;
    const xs = S.flatMap(v => [v[0], v[2], v[4]]), ys = S.flatMap(v => [v[1], v[3], v[5]]);
    out.push({ m, cost, q: applyMove(p, m), S, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  edgeCache.set(k, out);
  return out;
}
const boxOf = V => [Math.min(V[0], V[2], V[4]), Math.min(V[1], V[3], V[5]), Math.max(V[0], V[2], V[4]), Math.max(V[1], V[3], V[5])];
const boxesMeet = (a, b) => a[0] < b[2] - TOUCH && b[0] < a[2] - TOUCH && a[1] < b[3] - TOUCH && b[1] < a[3] - TOUCH;
function edgeClear(e, obstacles) {
  for (const O of obstacles) {
    if (!boxesMeet(e.box, O.box)) continue;
    for (const V of e.S) if (penetration(V, O.V) > 0) return false;
  }
  return true;
}
const asObstacles = poses => poses.map(p => { const V = verts(p); return { V, box: boxOf(V) }; });

// Dijkstra for one piece among static obstacles; goal(pose) ends the search.
function findPath(start, goal, obstacles) {
  const O = asObstacles(obstacles);
  const dist = new Map([[key(start), 0]]);
  const queue = [{ p: start, d: 0, path: [] }];
  while (queue.length) {
    let bi = 0; for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[bi].d) bi = i;
    const cur = queue.splice(bi, 1)[0];
    if (cur.d > dist.get(key(cur.p))) continue;
    if (goal(cur.p)) return cur.path;
    for (const e of edges(cur.p)) {
      const d = cur.d + e.cost, k = key(e.q);
      if (dist.has(k) && dist.get(k) <= d) continue;
      if (!edgeClear(e, O)) continue;
      dist.set(k, d);
      queue.push({ p: e.q, d, path: [...cur.path, { from: cur.p, m: e.m }] });
    }
  }
  return null;
}

// Every pose reachable from `start` (moves are reversible).
function reachable(start, obstacles) {
  const O = asObstacles(obstacles);
  const seen = new Set([key(start)]), stack = [start];
  while (stack.length) {
    const p = stack.pop();
    for (const e of edges(p)) {
      const k = key(e.q);
      if (seen.has(k) || !edgeClear(e, O)) continue;
      seen.add(k); stack.push(e.q);
    }
  }
  return seen;
}

// Merge consecutive slides in the same direction into one long slide.
function merge(path) {
  const out = [];
  for (const step of path) {
    const prev = out[out.length - 1];
    if (prev && prev.m.type === SLIDE && step.m.type === SLIDE &&
        prev.m.dx * step.m.dy === prev.m.dy * step.m.dx && prev.m.dx * step.m.dx + prev.m.dy * step.m.dy > 0)
      prev.m = { type: SLIDE, dx: prev.m.dx + step.m.dx, dy: prev.m.dy + step.m.dy };
    else out.push({ from: step.from, m: { ...step.m } });
  }
  return out;
}

// --- Solve one transition ----------------------------------------------------
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solve(from, to, seed) {
  const rand = rng(seed);
  const cur = from.map(p => ({ ...p }));
  const filledBy = to.map(() => -1);           // target → piece sitting on it
  cur.forEach((p, i) => { const j = to.findIndex(t => same(t, p)); if (j >= 0) filledBy[j] = i; });
  const done = i => filledBy.includes(i);
  const overlaps = (pose, i) => cur.some((q, k) => k !== i && penetration(verts(pose), verts(q)) > 0);
  const moves = [];
  const run = (i, path) => {
    for (const step of merge(path)) { moves.push({ piece: i, from: step.from, m: step.m }); cur[i] = applyMove(cur[i], step.m); }
  };
  // After placing piece i on target j, can every other open target still be
  // reached by some unplaced piece past the placed ones?
  const stillSolvable = (i, j) => {
    const placed = cur.filter((_, k) => k === i ? false : done(k)).concat([to[j]]);
    const free = cur.filter((_, k) => k !== i && !done(k)).map(key);
    return to.every((t, r) => r === j || filledBy[r] >= 0 ||
      (set => free.some(f => set.has(f)))(reachable(t, placed)));
  };

  for (let guard = 0; guard < 150; guard++) {
    if (filledBy.every(i => i >= 0)) return moves;
    // 1) Move some unplaced piece onto a free, unobstructed target, as long
    //    as that doesn't wall off the targets still to fill.
    const options = [];
    for (let i = 0; i < cur.length; i++) if (!done(i)) {
      for (let j = 0; j < to.length; j++) if (filledBy[j] < 0 && !overlaps(to[j], i)) {
        const path = findPath(cur[i], p => same(p, to[j]), cur.filter((_, k) => k !== i));
        if (path) options.push({ i, j, path, cost: path.length + rand() * 0.5 });
      }
    }
    options.sort((a, b) => a.cost - b.cost);
    const pick = options.find(o => stillSolvable(o.i, o.j));
    if (pick) { run(pick.i, pick.path); filledBy[pick.j] = pick.i; continue; }

    // 2) Otherwise park a piece somewhere out of the way of open targets.
    const open = to.filter((_, j) => filledBy[j] < 0).map(verts);
    const blockers = cur.map((p, i) => i).filter(i => !done(i) && open.some(T => penetration(verts(cur[i]), T) > 0));
    const pool = blockers.length && rand() < 0.8 ? blockers : cur.map((_, i) => i);
    const i = pool[Math.floor(rand() * pool.length)];
    const wasTarget = filledBy.indexOf(i);
    // Somewhere clear of every open target, or failing that, of more of them.
    const blocked = p => open.filter(T => penetration(verts(p), T) > 0).length;
    const now = wasTarget >= 0 ? 1 : blocked(cur[i]);
    const others = cur.filter((_, k) => k !== i);
    const path = findPath(cur[i], p => !same(p, cur[i]) && blocked(p) === 0, others) ||
      findPath(cur[i], p => !same(p, cur[i]) && blocked(p) < now, others);
    if (path) {
      if (wasTarget >= 0) filledBy[wasTarget] = -1;
      run(i, path);
    } else if (options.length) {
      const o = options[0]; run(o.i, o.path); filledBy[o.j] = o.i;
    }
  }
  return null;
}

// --- Scheduling --------------------------------------------------------------
// Each move waits for every earlier move whose swept area it could touch
// (and for its own piece's previous move); everything else runs alongside.
// Because conflicting moves never share time, any easing is safe.
const moveDur = m => m.type === SLIDE ? 0.6 + 0.4 * Math.hypot(m.dx, m.dy) / LEG : 1;
function schedule(moves) {
  const S = moves.map(mv => sweep(mv.from, mv.m));
  const touch = (a, b) => S[a].some(A => S[b].some(B => penetration(A, B) > 0));
  const end = [];
  moves.forEach((mv, k) => {
    let start = 0;
    for (let n = 0; n < k; n++)
      if (moves[n].piece === mv.piece || touch(n, k)) start = Math.max(start, end[n]);
    mv.t0 = start; mv.t1 = start + moveDur(mv.m); end.push(mv.t1);
  });
  return Math.max(0, ...end);
}

// Sample the finished timeline (linear in time, so overlap-freedom here
// holds for any per-move easing) and check bounds and overlaps.
function check(from, moves, T, N = 20000) {
  let worst = 0, out = 0;
  for (let k = 0; k <= N; k++) {
    const t = (k / N) * T;
    const V = from.map((p, i) => {
      let pose = p, mid = null;
      for (const mv of moves) if (mv.piece === i) {
        if (t >= mv.t1) pose = applyMove(pose, mv.m);
        else if (t > mv.t0) {
          const S = sweep(pose, mv.m), u = (t - mv.t0) / (mv.t1 - mv.t0);
          mid = S[Math.round(u * (S.length - 1))]; break;
        } else break;
      }
      return mid || verts(pose);
    });
    for (const v of V) for (const z of v) out = Math.max(out, BOUNDS[0] - z, z - BOUNDS[1]);
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) worst = Math.max(worst, penetration(V[i], V[j]));
  }
  return { worst, out: Math.max(0, out) };
}

// --- Run ---------------------------------------------------------------------
const POSES = STATES.map(s => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(id => fromTri(s.tris[id])));
const results = [];
for (let s = 0; s < POSES.length; s++) {
  const from = POSES[s], to = POSES[(s + 1) % POSES.length];
  // Try many seeds; schedule the solutions with the fewest moves and keep
  // whichever finishes soonest.
  const found = [];
  for (let seed = 1; seed <= 150; seed++) {
    const moves = solve(from, to, seed * 977 + s);
    if (moves) found.push(moves);
  }
  found.sort((a, b) => a.length - b.length);
  let best = null;
  for (const moves of found.slice(0, 6)) {
    const T = schedule(moves);
    if (!best || T < best.T) best = { moves, T };
  }
  if (!best) { console.log(`transition ${s + 1}: FAILED`); process.exitCode = 1; continue; }
  const c = check(from, best.moves, best.T);
  const ok = c.worst === 0 && c.out < 1e-6;
  if (!ok) process.exitCode = 1;
  console.log(`transition ${s + 1}: ${ok ? 'ok' : 'FAILED'} · ${best.moves.length} moves · length ${best.T.toFixed(2)} · max overlap ${c.worst.toFixed(3)} · out of bounds ${c.out.toFixed(2)}`);
  results.push(best);
}
if (process.exitCode) process.exit();

// Each transition is stored in its own plan time (0…1) plus its length
// relative to the longest, so pieces move at one speed throughout.
const longest = Math.max(...results.map(r => r.T));
const r4 = x => Math.round(x * 1e4) / 1e4;
// Per transition, per starting piece: [start, end, 0, dx, dy] for a slide or
// [start, end, 1, pivotX, pivotY, turn] for a quarter turn.
const plans = results.map(({ moves, T }) => ({
  len: r4(T / longest),
  pieces: POSES[0].map((_, i) => moves.filter(mv => mv.piece === i).map(mv =>
    mv.m.type === SLIDE
      ? [r4(mv.t0 / T), r4(mv.t1 / T), SLIDE, mv.m.dx, mv.m.dy]
      : [r4(mv.t0 / T), r4(mv.t1 / T), TURN, mv.m.cx, mv.m.cy, mv.m.th > 0 ? 1 : -1])),
}));

const begin = '// NO_OVERLAP_PLANS:begin', end = '// NO_OVERLAP_PLANS:end';
const a = html.indexOf(begin), b = html.indexOf(end);
if (a < 0 || b < 0) throw new Error('Markers not found in index.html');
const body = 'const NO_OVERLAP_PLANS = [\n' + plans.map(p => '  ' + JSON.stringify(p)).join(',\n') + ',\n];\n';
fs.writeFileSync(FILE, html.slice(0, a) + begin + '\n' + body + html.slice(b));
console.log('Wrote NO_OVERLAP_PLANS to index.html');
