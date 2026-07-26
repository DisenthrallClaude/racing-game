// Visual verification harness.
//
// Steps the simulation deterministically (no reliance on wall-clock frame
// rate), then grabs each frame straight out of the WebGL colour buffer with
// readPixels — the page compositor cannot keep up under software GL, which
// otherwise yields half-drawn screenshots.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { encodePNG } from './png.mjs';

const OUT = process.env.OUT || '/tmp/claude-0/-home-user-racing-game/e03bf388-f146-5787-903b-357ca539de5e/scratchpad';
const TRACKS = (process.env.TRACKS || 'sakura,metro,alpine').split(',');
const W = +(process.env.W || 720), H = +(process.env.H || 405);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 600)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 120000 });
await page.click('[data-q="low"]');

async function grab(name) {
  const r = await page.evaluate((direct) => {
    const g = window.__game;
    const rend = g.engine.renderer;
    const v = g.race?.player?.vehicle;
    if (direct) {
      // Bypass post-processing entirely, to isolate scene vs pipeline issues.
      rend.setRenderTarget(null);
      rend.render(g.engine.scene, g.engine.camera);
    } else {
      // Force one complete synchronous frame, then read it back.
      g.engine.render(1 / 60, {
        speed01: v ? Math.max(0, v.speed / v.stats.topSpeed - 0.35) * 1.3 : 0,
        boost01: v && v.boostTimer > 0 ? 1 : 0,
      });
    }
    const gl = rend.getContext();
    const w = rend.domElement.width, h = rend.domElement.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < px.length; i += step) {
      s += String.fromCharCode.apply(null, px.subarray(i, i + step));
    }
    return { w, h, data: btoa(s) };
  }, !!process.env.DIRECT);
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(`${OUT}/${name}.png`, encodePNG(buf, r.w, r.h));
  // brightness report so a black frame is obvious in the log
  let sum = 0;
  for (let i = 0; i < buf.length; i += 4) sum += buf[i] + buf[i + 1] + buf[i + 2];
  console.log(`  ${name}: ${r.w}x${r.h} meanRGB=${(sum / (buf.length / 4 * 3)).toFixed(1)}`);
}

for (const track of TRACKS) {
  console.log(`\n=== ${track} ===`);
  const t0 = Date.now();
  await page.click(`[data-track="${track}"]`);
  await page.click('#btn-start');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 900000 });
  console.log(`world built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const drive = async (frames, keys) => {
    await page.evaluate(({ frames, keys }) => {
      const g = window.__game;
      g.input.keys = new Set(keys);
      const realRender = g.engine.render;
      g.engine.render = () => {};
      try {
        for (let i = 0; i < frames; i++) g._update(1 / 60);
      } finally {
        g.engine.render = realRender;
        g.input.keys = new Set();
      }
    }, { frames, keys });
  };

  await drive(300, []);                                    // countdown

  if (process.env.POSTDIAG) {
    const d = await page.evaluate(() => {
      const g = window.__game;
      const e = g.engine;
      const rend = e.renderer;
      const gl = rend.getContext();
      const W = rend.domElement.width, H = rend.domElement.height;
      const mean = () => {
        const n = 24;
        const px = new Uint8Array(n * n * 4);
        gl.readPixels(((W - n) / 2) | 0, ((H - n) / 2) | 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0;
        for (let i = 0; i < n * n; i++) s += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
        return +(s / (n * n * 3)).toFixed(1);
      };
      const out = {};
      rend.setRenderTarget(null);
      rend.render(e.scene, e.camera);
      out.direct = mean();

      const passes = e.composer.passes;
      const names = passes.map((p) => p.constructor.name);
      out.passNames = names;
      for (let k = 1; k <= passes.length; k++) {
        passes.forEach((p, i) => { p.enabled = i < k; });
        e.composer.render(0.016);
        out['upto' + k] = mean();
      }
      passes.forEach((p, i) => { p.enabled = i !== 2 || true; });
      // restore: everything on except SMAA at low quality
      passes.forEach((p) => { p.enabled = true; });
      if (g.selected.quality === 'low') e.smaa.enabled = false;

      // Peek at the bloom pyramid: draw mip 0 straight to screen.
      const cp = e.cinematic;
      cp.copyUniforms.tDiffuse.value = cp.mips[0].a.texture;
      cp.fsQuad.material = cp.copyMat;
      rend.setRenderTarget(null);
      cp.fsQuad.render(rend);
      out.bloomMip0 = mean();
      out.bloomStrength = cp.uniforms.uBloom.value;
      out.threshold = cp.brightUniforms.uThreshold.value;
      out.exposure = rend.toneMappingExposure;
      return out;
    });
    console.log('  POSTDIAG ' + JSON.stringify(d));
  }

  await grab(`${track}-1-grid`);

  await drive(420, ['ArrowUp']);
  await grab(`${track}-2-drive`);

  await drive(120, ['ArrowUp', 'ArrowLeft', 'ShiftLeft']);
  await grab(`${track}-3-drift`);

  await drive(15, ['ArrowUp']);
  await drive(80, ['ArrowUp', 'Space']);
  await grab(`${track}-4-boost`);

  await page.evaluate(() => { window.__game.chase.mode = 'cinematic'; window.__game.chase.initialised = false; });
  await drive(200, ['ArrowUp']);
  await grab(`${track}-5-cine`);

  // A high wide shot to check the skyline, architecture and horizon.
  await page.evaluate(() => {
    const g = window.__game;
    const v = g.race.player.vehicle;
    const c = g.engine.camera;
    c.position.set(v.position.x - 90, v.position.y + 75, v.position.z - 90);
    c.lookAt(v.position.x, v.position.y + 6, v.position.z);
    c.fov = 62; c.updateProjectionMatrix();
    g.world.update(0.016, c, v.position);
  });
  await grab(`${track}-6-wide`);

  const d = await page.evaluate(() => {
    const g = window.__game;
    const v = g.race.player.vehicle;
    const info = g.engine.renderer.info;
    return {
      raceState: g.race.state, kmh: +v.speedKmh.toFixed(0),
      onRoad: v.onRoad, offroad: v.offroad, grounded: v.grounded,
      nitro: v.nitro, lap: g.race.player.lap, pos: g.race.player.position,
      progress: +v.progress.toFixed(0),
      aiKmh: g.race.entries.filter((e) => !e.isPlayer).map((e) => +e.vehicle.speedKmh.toFixed(0)),
      aiOnRoad: g.race.entries.filter((e) => !e.isPlayer).map((e) => e.vehicle.onRoad),
      programs: info.programs.length, geometries: info.memory.geometries, textures: info.memory.textures,
      trackLen: +g.world.track.length.toFixed(0),
    };
  });
  console.log('  ' + JSON.stringify(d));

  await page.evaluate(() => { window.__game.chase.mode = 'chase'; window.__game.toMenu(); });
  await page.waitForTimeout(400);
}

console.log('\n--- errors ---');
console.log([...new Set(errs)].slice(0, 20).join('\n') || '(none)');
await browser.close();
