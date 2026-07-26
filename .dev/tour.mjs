// Visits all three circuits, drives each one, and reports renderer stats,
// average frame time and any console errors.
import { chromium } from 'playwright';

const OUT = process.env.OUT || '/tmp/claude-0/-home-user-racing-game/e03bf388-f146-5787-903b-357ca539de5e/scratchpad';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 90000 });
await page.screenshot({ path: `${OUT}/00-menu.png` });

for (const track of ['sakura', 'metro', 'alpine']) {
  console.log(`\n=== ${track} ===`);
  await page.click(`[data-track="${track}"]`);
  await page.click('#btn-start');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 400000 });
  console.log('world built');

  // Skip the countdown by driving the clock; then drive.
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/${track}-1-grid.png` });

  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${OUT}/${track}-2-drive.png` });

  await page.keyboard.down('ArrowLeft');
  await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${OUT}/${track}-3-drift.png` });
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(500);
  await page.keyboard.press('Space');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/${track}-4-boost.png` });

  // Cinematic camera for a wide beauty shot.
  await page.keyboard.press('KeyC');
  await page.keyboard.press('KeyC');
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/${track}-5-cine.png` });
  await page.keyboard.press('KeyC');
  await page.keyboard.up('ArrowUp');

  const d = await page.evaluate(async () => {
    const g = window.__game;
    const v = g.race.player.vehicle;
    const info = g.engine.renderer.info;
    // measure frame time over 20 rAFs
    const t0 = performance.now();
    let n = 0;
    await new Promise((res) => {
      const tick = () => { if (++n >= 20) return res(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    const ms = (performance.now() - t0) / n;
    return {
      raceState: g.race.state,
      kmh: +v.speedKmh.toFixed(0),
      onRoad: v.onRoad, offroad: v.offroad, grounded: v.grounded,
      nitro: v.nitro, lap: g.race.player.lap,
      progress: +v.progress.toFixed(0),
      camMode: g.chase.mode,
      camDistToCar: +g.engine.camera.position.distanceTo(v.position).toFixed(1),
      frameMs: +ms.toFixed(1),
      programs: info.programs.length,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      trackLen: +g.world.track.length.toFixed(0),
    };
  });
  console.log(JSON.stringify(d));

  await page.evaluate(() => window.__game.toMenu());
  await page.waitForTimeout(800);
}

console.log('\n--- errors ---');
console.log([...new Set(errs)].slice(0, 20).join('\n') || '(none)');
await browser.close();
