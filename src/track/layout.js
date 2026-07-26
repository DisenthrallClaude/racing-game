// Circuit layout builder.
//
// A circuit is authored as a closed polygon of corner points, each carrying
// the radius its corner should be rounded to. The builder fillets every
// corner with a true circular arc and joins them with straights, so the
// resulting centre line has exactly the corner radii the designer asked for —
// which is what decides whether a corner is a flat-out sweeper (R > 250 m), a
// lift-and-turn (R ≈ 120 m) or a drift hairpin (R < 70 m).
//
// Closure is automatic: the polygon is closed, so the track is too.
//
//   { x: -420, z: 300, r: 55, y: 12, w: 18, kind: 'bridge', bank: 20 }
//
// Elevation, width, surface kind and banking interpolate along the path
// between consecutive corners.

const TAU = Math.PI * 2;
const smooth = (t) => t * t * (3 - 2 * t);

function sub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function len(a) { return Math.hypot(a[0], a[1]); }
function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function scale(a, k) { return [a[0] * k, a[1] * k]; }
function cross(a, b) { return a[0] * b[1] - a[1] * b[0]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

/**
 * @param {Array} corners  [{ x, z, r, y, w, kind, bank }]
 * @param {object} opts    { step: metres between control points }
 * @returns {Array} spline control points for Track
 */
export function circuit(corners, opts = {}) {
  const step = opts.step ?? 14;
  const n = corners.length;

  // --- 1. fillet every corner ---------------------------------------------
  const arcs = [];
  const report = [];
  circuit.lastReport = report;
  for (let i = 0; i < n; i++) {
    const prev = corners[(i - 1 + n) % n];
    const cur = corners[i];
    const next = corners[(i + 1) % n];

    const P = [prev.x, prev.z], C = [cur.x, cur.z], N = [next.x, next.z];
    const dIn = norm(sub(C, P));
    const dOut = norm(sub(N, C));

    // Interior turn angle at this corner.
    const turn = Math.atan2(cross(dIn, dOut), dot(dIn, dOut));
    const absTurn = Math.abs(turn);

    if (absTurn < 1e-4) {
      arcs.push({ i, C, dIn, dOut, turn: 0, r: 0, t: 0, start: C, end: C });
      continue;
    }
    // Tangent length needed for the requested radius; clamp so neighbouring
    // fillets can never overrun each other on a short edge.
    let r = cur.r ?? 80;
    const maxT = Math.min(len(sub(C, P)), len(sub(N, C))) * 0.45;
    let t = r * Math.tan(absTurn / 2);
    if (t > maxT) {
      t = maxT;
      r = t / Math.tan(absTurn / 2);
      // A corner that will not fit its edges silently becomes tighter than
      // designed, so record it for the layout audit.
      report.push({ corner: i, requested: cur.r, actual: Math.round(r) });
    }

    arcs.push({
      i, C, dIn, dOut, turn, r, t,
      start: add(C, scale(dIn, -t)),
      end: add(C, scale(dOut, t)),
    });
  }

  // --- 2. walk straights and arcs, emitting points -------------------------
  const raw = [];   // { p:[x,z], vi } where vi is a fractional corner index
  for (let i = 0; i < n; i++) {
    const a = arcs[i];
    const b = arcs[(i + 1) % n];

    // arc around corner i
    if (a.r > 0.001) {
      const sign = Math.sign(a.turn);
      // Centre is offset perpendicular to the incoming direction.
      const perp = [-a.dIn[1] * sign, a.dIn[0] * sign];
      const centre = add(a.start, scale(perp, a.r));
      const startAng = Math.atan2(a.start[1] - centre[1], a.start[0] - centre[0]);
      const arcLen = a.r * Math.abs(a.turn);
      const steps = Math.max(2, Math.ceil(arcLen / step));
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        const ang = startAng + sign * Math.abs(a.turn) * f;
        raw.push({
          p: [centre[0] + Math.cos(ang) * a.r, centre[1] + Math.sin(ang) * a.r],
          vi: i + (f - 0.5) * 0.5,      // the corner's own attributes dominate
        });
      }
    } else {
      raw.push({ p: a.C, vi: i });
    }

    // straight from arc i's end to arc i+1's start
    const s0 = a.end, s1 = b.start;
    const d = sub(s1, s0);
    const L = len(d);
    if (L > 0.5) {
      const steps = Math.max(1, Math.round(L / step));
      for (let k = 0; k < steps; k++) {
        const f = k / steps;
        raw.push({ p: add(s0, scale(d, f)), vi: i + 0.25 + f * 0.5 });
      }
    }
  }

  // --- 3. attach interpolated attributes -----------------------------------
  const attr = (vi, key, fallback) => {
    const i0 = Math.floor(vi);
    const f = smooth(vi - i0);
    const a = corners[((i0 % n) + n) % n][key];
    const b = corners[((i0 + 1) % n + n) % n][key];
    if (a === undefined && b === undefined) return fallback;
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (typeof a === 'string') return f < 0.5 ? a : b;
    return a + (b - a) * f;
  };

  return raw.map(({ p, vi }) => {
    // Explicit banking belongs to the corner arc only; letting it bleed down
    // the following straight would leave the car cambered on the straights.
    const nearest = ((Math.round(vi) % n) + n) % n;
    const onArc = Math.abs(vi - Math.round(vi)) <= 0.2501;
    return {
      p: [p[0], attr(vi, 'y', 0), p[1]],
      w: attr(vi, 'w', 20),
      kind: attr(vi, 'kind', 'road'),
      bank: onArc ? (corners[nearest].bank ?? null) : null,
    };
  });
}

/**
 * Helper for laying corners out around a loop: polar placement, but the
 * corner radius is independent of the loop radius, so hairpins are possible
 * anywhere.
 */
export function ring(entries, opts = {}) {
  const sx = opts.stretchX ?? 1;
  const sz = opts.stretchZ ?? 1;
  return entries.map((e) => {
    const a = (e.a * Math.PI) / 180;
    return {
      x: Math.cos(a) * e.d * sx,
      z: Math.sin(a) * e.d * sz,
      r: e.r, y: e.y, w: e.w, kind: e.kind, bank: e.bank,
    };
  });
}
