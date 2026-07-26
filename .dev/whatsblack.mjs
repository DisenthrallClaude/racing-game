// Identifies whatever is filling the dark part of the frame by hiding each
// candidate subsystem in turn and re-measuring that region of the image.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 400, height: 225 } });
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
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
  for (let i = 0; i < 600; i++) g._update(1 / 60);
  g.engine.render = r;
});

const out = await page.evaluate(() => {
  const g = window.__game;
  const e = g.engine;
  const rend = e.renderer;
  const gl = rend.getContext();
  const W = rend.domElement.width, H = rend.domElement.height;

  // Sample a block in the left-middle of the frame — the dark region.
  const probe = () => {
    e.render(1 / 60, { speed01: 0, boost01: 0 });
    const n = 24;
    const px = new Uint8Array(n * n * 4);
    gl.readPixels(Math.floor(W * 0.15), Math.floor(H * 0.42), n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = 0;
    for (let i = 0; i < n * n; i++) s += px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2];
    return +(s / (n * n * 3)).toFixed(1);
  };

  const byName = {};
  g.world.root.children.forEach((c, i) => { byName[c.name || `${c.type}#${i}`] = c; });

  const res = { children: Object.keys(byName), baseline: probe() };

  // Hide one subsystem at a time and see which one owns the dark pixels.
  for (const key of Object.keys(byName)) {
    const o = byName[key];
    if (!o.visible) continue;
    o.visible = false;
    res['without_' + key] = probe();
    o.visible = true;
  }
  return res;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
