import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') console.log(`[${t}] ${m.text().slice(0, 900)}`);
});
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 120000 });
await page.click('[data-q="low"]');
await page.click('[data-track="sakura"]');
await page.click('#btn-start');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 900000 });
console.log('world ready');

await page.evaluate(() => {
  const g = window.__game;
  const r = g.engine.render;
  g.engine.render = () => {};
  for (let i = 0; i < 260; i++) g._update(1 / 60);
  g.engine.render = r;
});

const out = await page.evaluate(() => {
  const g = window.__game;
  const e = g.engine;
  const rend = e.renderer;
  const gl = rend.getContext();
  const W = rend.domElement.width, H = rend.domElement.height;
  const mean = () => {
    const n = 32;
    const px = new Uint8Array(n * n * 4);
    gl.readPixels(((W - n) / 2) | 0, ((H - n) / 2) | 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < n * n; i++) s += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
    return +(s / (n * n * 3)).toFixed(1);
  };
  const res = { glErrors: [] };

  rend.setRenderTarget(null);
  rend.render(e.scene, e.camera);
  res.direct = mean();

  // scene -> composer read buffer -> copy back to screen
  const rt = e.composer.readBuffer;
  res.rtSize = [rt.width, rt.height];
  rend.setRenderTarget(rt);
  rend.clear();
  rend.render(e.scene, e.camera);
  rend.setRenderTarget(null);
  const cp = e.cinematic;
  cp.copyUniforms.tDiffuse.value = rt.texture;
  cp.fsQuad.material = cp.copyMat;
  cp.fsQuad.render(rend);
  res.sceneToRT = mean();

  // same, but with the sky mesh hidden, to test the depth-tested dome
  const sky = g.world.sky.mesh;
  sky.visible = false;
  rend.setRenderTarget(rt);
  rend.clear();
  rend.render(e.scene, e.camera);
  rend.setRenderTarget(null);
  cp.fsQuad.material = cp.copyMat;
  cp.fsQuad.render(rend);
  res.sceneToRT_noSky = mean();
  sky.visible = true;

  // --- drive the composer's passes by hand -------------------------------
  const [rp, cpPass, smaa, outp] = e.composer.passes;
  const read = e.composer.readBuffer, write = e.composer.writeBuffer;

  rp.renderToScreen = false;
  rp.render(rend, write, read, 0.016);
  rend.setRenderTarget(null);
  cp.copyUniforms.tDiffuse.value = read.texture;
  cp.fsQuad.material = cp.copyMat;
  cp.fsQuad.render(rend);
  res.afterRenderPass = mean();

  rp.render(rend, write, read, 0.016);
  cpPass.renderToScreen = true;
  cpPass.render(rend, write, read, 0.016);
  res.afterCinematicToScreen = mean();

  // Debug taps: 1 = raw tDiffuse, 2 = bloom pyramid only, 3 = sanitised input
  for (const mode of [1, 2, 3]) {
    cpPass.uniforms.uDebug.value = mode;
    rp.render(rend, write, read, 0.016);
    cpPass.render(rend, write, read, 0.016);
    res['debug' + mode] = mean();
  }
  cpPass.uniforms.uDebug.value = 0;

  // same, but with every cinematic effect neutralised
  const u = cpPass.uniforms;
  const saved = {
    bloom: u.uBloom.value, speed: u.uSpeed.value, boost: u.uBoost.value,
    vig: u.uVignette.value, grain: u.uGrain.value,
    sat: u.uSaturation.value, con: u.uContrast.value,
    lift: u.uLift.value.clone(), gain: u.uGain.value.clone(),
  };
  u.uBloom.value = 0; u.uSpeed.value = 0; u.uBoost.value = 0;
  u.uVignette.value = 0; u.uGrain.value = 0;
  u.uSaturation.value = 1; u.uContrast.value = 1;
  u.uLift.value.set(0, 0, 0); u.uGain.value.set(1, 1, 1);
  rp.render(rend, write, read, 0.016);
  cpPass.render(rend, write, read, 0.016);
  res.cinematicNeutral = mean();
  res.savedUniforms = {
    bloom: saved.bloom, speed: saved.speed, boost: saved.boost,
    vig: saved.vig, grain: saved.grain, sat: saved.sat, con: saved.con,
    lift: saved.lift.toArray(), gain: saved.gain.toArray(),
  };
  u.uBloom.value = saved.bloom; u.uSpeed.value = saved.speed; u.uBoost.value = saved.boost;
  u.uVignette.value = saved.vig; u.uGrain.value = saved.grain;
  u.uSaturation.value = saved.sat; u.uContrast.value = saved.con;
  u.uLift.value.copy(saved.lift); u.uGain.value.copy(saved.gain);

  // straight copy of the read buffer through the copy material, for reference
  rp.render(rend, write, read, 0.016);
  rend.setRenderTarget(null);
  cp.copyUniforms.tDiffuse.value = read.texture;
  cp.fsQuad.material = cp.copyMat;
  cp.fsQuad.render(rend);
  res.copyOfReadBuffer = mean();

  res.programs = rend.info.programs.length;
  let err;
  while ((err = gl.getError()) !== gl.NO_ERROR) res.glErrors.push(err);
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
