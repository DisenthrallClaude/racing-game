// Curvature audit: reports the corner profile of every circuit so the
// layouts can be tuned to actually reward drifting.
import { TRACKS } from '../src/track/tracks.js';
import { Track } from '../src/track/track.js';
import { circuit } from '../src/track/layout.js';

const DRIFT_K = 0.007;   // AI/driver drift threshold candidate

for (const def of TRACKS) {
  const t = new Track(def);
  const clamped = def._clampReport || [];
  const ks = Array.from(t.curvature, Math.abs);
  const sorted = [...ks].sort((a, b) => a - b);
  const q = (p) => sorted[Math.floor(p * (sorted.length - 1))];
  const maxK = sorted[sorted.length - 1];

  // Count distinct corners above the drift threshold.
  let corners = 0, inCorner = false, cornerLens = [], cur = 0;
  for (const k of ks) {
    if (k > DRIFT_K) {
      if (!inCorner) { corners++; inCorner = true; cur = 0; }
      cur += t.sampleStep;
    } else if (inCorner) { inCorner = false; cornerLens.push(+cur.toFixed(0)); }
  }
  if (inCorner) cornerLens.push(+cur.toFixed(0));

  const pct = (thr) => (ks.filter((k) => k > thr).length / ks.length * 100).toFixed(1);

  console.log(`\n${def.id}  (${def.name})`);
  console.log(`  length ${t.length.toFixed(0)}m, samples ${t.count}`);
  console.log(`  min radius ${(1 / maxK).toFixed(0)}m   median radius ${(1 / (q(0.5) || 1e-9)).toFixed(0)}m`);
  console.log(`  radius at p90 ${(1 / (q(0.9) || 1e-9)).toFixed(0)}m  p99 ${(1 / (q(0.99) || 1e-9)).toFixed(0)}m`);
  console.log(`  %track with R<143m (k>0.007): ${pct(0.007)}   R<74m (k>0.0135): ${pct(0.0135)}   R<100m: ${pct(0.01)}`);
  console.log(`  drift-worthy corners: ${corners}  lengths(m): ${cornerLens.join(', ')}`);
  const elev = [];
  for (let i = 0; i < t.count; i++) elev.push(t.pos[i * 3 + 1]);
  console.log(`  elevation ${Math.min(...elev).toFixed(0)}..${Math.max(...elev).toFixed(0)}m`);
  const banks = Array.from(t.bank, (b) => Math.abs(b) * 180 / Math.PI);
  console.log(`  max bank ${Math.max(...banks).toFixed(1)}°`);
  if (def._clampReport?.length) console.log(`  !! fillets clamped: ` + JSON.stringify(def._clampReport));
}
