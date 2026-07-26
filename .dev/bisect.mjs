import { chromium } from 'playwright';

const OUT = '/tmp/claude-0/-home-user-racing-game/e03bf388-f146-5787-903b-357ca539de5e/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
await page.click('#btn-start');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });
await page.waitForTimeout(3000);

const r = await page.evaluate(() => {
  const g = window.__game;
  const e = g.engine;
  const gl = e.renderer.getContext();
  const W = e.renderer.domElement.width, H = e.renderer.domElement.height;
  const sample = () => {
    // average a small block in the middle-lower area (likely ground/sky)
    const n = 16;
    const px = new Uint8Array(n * n * 4);
    gl.readPixels((W / 2) | 0, (H / 2) | 0, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < n * n; i++) s += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
    return +(s / (n * n * 3)).toFixed(1);
  };

  const names = ['render', 'bloom', 'cinematic', 'smaa', 'output'];
  const passes = e.composer.passes;
  const out = {};

  e.renderer.setRenderTarget(null);
  e.renderer.render(e.scene, e.camera);
  out.direct = sample();

  // Progressive: enable only the first k passes, last enabled renders to screen.
  for (let k = 1; k <= passes.length; k++) {
    passes.forEach((p, i) => { p.enabled = i < k; });
    e.composer.render(0.016);
    out[`upto_${names.slice(0, k).join('+')}`] = sample();
  }
  passes.forEach((p) => { p.enabled = true; });

  // Also: full chain with each single pass disabled.
  for (let k = 1; k < passes.length; k++) {
    passes.forEach((p, i) => { p.enabled = i !== k; });
    e.composer.render(0.016);
    out[`without_${names[k]}`] = sample();
  }
  passes.forEach((p) => { p.enabled = true; });

  return out;
});
console.log(JSON.stringify(r, null, 2));
console.log('--- errors ---');
console.log(errs.slice(0, 20).join('\n') || '(none)');
await browser.close();
