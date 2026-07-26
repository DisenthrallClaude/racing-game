// Headless physics/race validation: runs a full race with rendering stubbed
// out, so it costs seconds instead of minutes. Drives the player with an AI
// controller and reports whether every car makes progress and completes laps.

import { chromium } from 'playwright';

const TRACKS = (process.env.TRACKS || 'sakura,metro,alpine').split(',');
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
await page.waitForSelector('#menu:not(.hidden)', { timeout: 120000 });
await page.click('[data-q="low"]');

for (const track of TRACKS) {
  console.log(`\n=== ${track} ===`);
  await page.click(`[data-track="${track}"]`);
  await page.click('#btn-start');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 900000 });

  const res = await page.evaluate(async ({ seconds }) => {
    const g = window.__game;
    const race = g.race;
    const realRender = g.engine.render;
    g.engine.render = () => {};

    // Drive the player with the same controller the rivals use, so the test
    // exercises the physics rather than a scripted key pattern.
    return (async () => {
      const AIDriver = race.entries.find((e) => e.ai)?.ai?.constructor;
      const pv = race.player.vehicle;
      const bot = AIDriver ? new AIDriver(pv, g.world.track, { skill: 0.9, aggression: 1.0, seed: 5 }) : null;

      const samples = [];
      let stuckFrames = 0, minSpeedRun = 0, maxNitro = 0, driftFrames = 0, boostFrames = 0;
      const N = seconds * 60;
      for (let i = 0; i < N; i++) {
        const ctx = { time: race.time, vehicles: race.entries.map((e) => e.vehicle) };
        const input = bot ? bot.update(1 / 60, ctx) : { throttle: 1, brake: 0, steer: 0, drift: false, boost: false };
        race.update(1 / 60, input);
        if (pv.speed < 2) { minSpeedRun++; stuckFrames = Math.max(stuckFrames, minSpeedRun); }
        else minSpeedRun = 0;
        maxNitro = Math.max(maxNitro, pv.nitro);
        if (pv.drifting) driftFrames++;
        if (pv.boostTimer > 0) boostFrames++;
        if (i % 900 === 0) {
          samples.push({
            t: +(i / 60).toFixed(0),
            kmh: +pv.speedKmh.toFixed(0),
            lap: race.player.lap,
            prog: +pv.progress.toFixed(0),
            lat: +pv.lateral.toFixed(1),
            onRoad: pv.onRoad,
            nitro: pv.nitro,
            pos: race.player.position,
          });
        }
        if (race.state === 'finished') break;
      }
      g.engine.render = realRender;
      return {
        driftSec: +(driftFrames / 60).toFixed(1),
        boostSec: +(boostFrames / 60).toFixed(1),
        maxNitro,
        samples,
        longestStuckSec: +(stuckFrames / 60).toFixed(1),
        finished: race.state === 'finished',
        playerLap: race.player.lap,
        playerBest: race.player.bestLap === Infinity ? null : +race.player.bestLap.toFixed(2),
        raceTime: +race.time.toFixed(1),
        standings: (race.standings || []).map((e) => ({
          n: e.name, p: e.position, lap: e.lap, prog: +e.vehicle.progress.toFixed(0),
          onRoad: e.vehicle.onRoad, kmh: +e.vehicle.speedKmh.toFixed(0),
        })),
      };
    })();
  }, { seconds: 420 });

  console.log(JSON.stringify(res, null, 1));
  // The results modal appears on a delay after the finish; wait it out, then
  // dismiss it the way a player would.
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    document.getElementById('results').classList.add('hidden');
    window.__game.toMenu();
  });
  await page.waitForTimeout(300);
}
console.log('\n--- errors ---');
console.log([...new Set(errs)].slice(0, 15).join('\n') || '(none)');
await browser.close();
