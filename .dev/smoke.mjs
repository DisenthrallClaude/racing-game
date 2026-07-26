import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:4173/';
const OUT = process.env.OUT || '/tmp/claude-0/-home-user-racing-game/e03bf388-f146-5787-903b-357ca539de5e/scratchpad';
const TRACK = process.env.TRACK || 'sakura';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') errors.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack?.split('\n').slice(0,4).join('\n')}`));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 60000 });
console.log('MENU OK');
await page.screenshot({ path: `${OUT}/01-menu.png` });

await page.click(`[data-track="${TRACK}"]`);
await page.click('#btn-start');
console.log('waiting for world build...');
await page.waitForSelector('#hud:not(.hidden)', { timeout: 300000 });
console.log('RACE STARTED');

// let the countdown finish and drive a bit
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/02-${TRACK}-start.png` });

await page.keyboard.down('ArrowUp');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/03-${TRACK}-drive.png` });
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(1800);
await page.screenshot({ path: `${OUT}/04-${TRACK}-drift.png` });
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('ArrowLeft');
await page.keyboard.press('Space');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/05-${TRACK}-boost.png` });
await page.waitForTimeout(3000);
await page.keyboard.up('ArrowUp');

const diag = await page.evaluate(() => {
  const g = window.__game;
  const v = g.race?.player?.vehicle;
  return {
    state: g.state,
    raceState: g.race?.state,
    speed: v?.speed,
    kmh: v?.speedKmh,
    pos: v ? [v.position.x.toFixed(1), v.position.y.toFixed(1), v.position.z.toFixed(1)] : null,
    onRoad: v?.onRoad,
    nitro: v?.nitro,
    progress: v?.progress?.toFixed(1),
    lap: g.race?.player?.lap,
    entries: g.race?.entries.length,
    drawCalls: g.engine.renderer.info.render.calls,
    triangles: g.engine.renderer.info.render.triangles,
    geometries: g.engine.renderer.info.memory.geometries,
    textures: g.engine.renderer.info.memory.textures,
    trackLength: g.world?.track?.length?.toFixed(0),
  };
});
console.log('DIAG', JSON.stringify(diag, null, 2));
console.log('\n--- console messages ---');
console.log(errors.slice(0, 40).join('\n') || '(none)');

await browser.close();
