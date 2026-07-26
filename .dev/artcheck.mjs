// Verifies the packed single-file build actually boots and races, wrapped the
// same way the Artifact host wraps it.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4180/';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().slice(0, 120)));

const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(URL) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u.slice(0, 120));
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 120000 });
console.log('menu reached — boot OK');

await page.click('[data-q="low"]');
await page.click('[data-track="sakura"]');
await page.click('#btn-start');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 900000 });
console.log('world built — race started');

const d = await page.evaluate(() => {
  const g = window.__game;
  const r = g.engine.render;
  g.engine.render = () => {};
  for (let i = 0; i < 900; i++) g._update(1 / 60);
  g.engine.render = r;
  const v = g.race.player.vehicle;
  return {
    raceState: g.race.state,
    kmh: +v.speedKmh.toFixed(0),
    onRoad: v.onRoad,
    progress: +v.progress.toFixed(0),
    aiKmh: g.race.entries.filter((e) => !e.isPlayer).map((e) => +e.vehicle.speedKmh.toFixed(0)),
    tracks: [...document.querySelectorAll('[data-track]')].map((e) => e.dataset.track),
  };
});
console.log('state ' + JSON.stringify(d));
console.log('external requests: ' + (external.length ? external.join(', ') : 'none'));
console.log('errors: ' + ([...new Set(errs)].slice(0, 10).join(' | ') || 'none'));
await browser.close();
