# Development harnesses

These drive the built game in headless Chromium. Start the server first:

```
npm run build && npm run preview     # http://localhost:4173
```

| | |
|---|---|
| `node .dev/curve.mjs` | Track audit — corner radius distribution, count of drift-worthy corners, elevation, banking, and any fillet that could not fit between its neighbours. Pure Node, runs instantly, no browser. |
| `node .dev/sim.mjs` | Runs complete races with rendering stubbed out, driving the player with an AI controller. Reports lap times, drift and nitro usage, longest stuck interval and final standings. `TRACKS=sakura,metro` to narrow. |
| `node .dev/shots.mjs` | Steps the simulation deterministically and grabs each frame straight out of the WebGL colour buffer with `readPixels` — the page compositor cannot keep up under software GL and yields half-drawn screenshots. `DIRECT=1` bypasses post-processing; `POSTDIAG=1` bisects the pass chain. |
| `node .dev/gameprobe.mjs` | Render-pipeline probe: compares a direct scene render against each stage of the composer and reports where an image is lost. Useful when the screen goes black. |
| `png.mjs` | Minimal PNG encoder used by `shots.mjs`. |

Software rendering is slow: a world build takes ~30 s and a single 720x405
frame can take a minute, so allow several minutes per track.
