import { chromium } from 'playwright';

const OUT = '/tmp/claude-0/-home-user-racing-game/e03bf388-f146-5787-903b-357ca539de5e/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url()));
page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
await page.click('#btn-start');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });
await page.waitForTimeout(4000);

const r = await page.evaluate(() => {
  const g = window.__game;
  const THREE = g.engine.renderer;
  const cam = g.engine.camera;
  const scene = g.engine.scene;
  const info = g.engine.renderer.info;
  info.autoReset = false;
  info.reset();
  g.engine.renderer.setRenderTarget(null);
  g.engine.renderer.render(scene, cam);
  const direct = { calls: info.render.calls, tris: info.render.triangles };

  // read the centre pixel after a DIRECT render (no composer)
  const gl = g.engine.renderer.getContext();
  const px = new Uint8Array(4);
  gl.readPixels(400, 250, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);

  info.reset();
  g.engine.composer.render(0.016);
  const composed = { calls: info.render.calls, tris: info.render.triangles };
  const px2 = new Uint8Array(4);
  gl.readPixels(400, 250, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px2);

  let meshes = 0, visible = 0;
  scene.traverse((o) => { if (o.isMesh || o.isPoints || o.isInstancedMesh) { meshes++; if (o.visible) visible++; } });

  return {
    direct, composed,
    pixelDirect: Array.from(px), pixelComposed: Array.from(px2),
    camPos: cam.position.toArray().map((v) => +v.toFixed(1)),
    carPos: g.race.player.vehicle.position.toArray().map((v) => +v.toFixed(1)),
    meshes, visible,
    passes: g.engine.composer.passes.map((p) => `${p.constructor.name}:${p.enabled}`),
    fog: !!scene.fog,
    env: !!scene.environment,
    capsHalfFloat: !!g.engine.renderer.extensions.get('EXT_color_buffer_half_float'),
    isWebGL2: g.engine.renderer.capabilities.isWebGL2,
  };
});
console.log(JSON.stringify(r, null, 2));
await page.screenshot({ path: `${OUT}/diag.png` });
console.log('--- errors ---');
console.log(errs.slice(0, 30).join('\n') || '(none)');
await browser.close();
