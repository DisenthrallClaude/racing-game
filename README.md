# 霓虹飞车 · NEON DRIFT

A QQ-Speed–inspired arcade racer built on WebGL2 / Three.js, where **every pixel is
generated at runtime** — no textures, no models, no audio files. The entire game is
one JavaScript bundle that procedurally builds three photographic environments, a
full PBR material library, and a synthesised soundtrack of engine, tyres and wind.

```
npm install
npm run dev      # http://localhost:5173
npm run build && npm run preview
```

---

## The three circuits

| | 赛道 | 时间 / 天气 | 看点 |
|---|---|---|---|
| ★☆☆ | **樱花神社** SAKURA SHRINE | 黄昏 golden hour | 飞檐斗拱的木构古镇、五层宝塔、牌坊与鸟居横跨赛道、成串红灯笼、漫天樱花、湖上石拱桥、穿山隧道与窄桥 |
| ★★★ | **霓虹都市** NEON METROPOLIS | 雨夜 rain at night | 78 座逐窗发光的摩天楼、湿滑镜面路面、全息招牌、高架桥与地下隧道、26° 倾角飞跨弯 |
| ★★☆ | **云顶雪山** CLOUDTOP ALPINE | 极光黎明 aurora dawn | 极光帘幕、脊线窄桥与深渊、冰洞隧道、雪压木屋与石砌小教堂、运行中的缆车 |

Each circuit is authored in `src/track/layout.js` as a **closed polygon of
corners, each with the radius it should be rounded to**. The builder fillets
every corner with a true circular arc and joins them with straights, so the
corner radii are exactly what the design asks for — which is what decides
whether a corner is a flat-out sweeper (R > 250 m), a lift-and-turn (R ≈ 120 m)
or a drift hairpin (R < 70 m). Closure is automatic. Each corner also carries
elevation, road width, banking and surface type (road / bridge / tunnel), so the
same pipeline produces a lakeside village road, an elevated city expressway and
a knife-edge mountain crossing.

`.dev/curve.mjs` audits the result: it reports the radius distribution, counts
the drift-worthy corners and flags any fillet that could not fit between its
neighbours. The current layouts land at 10 / 13 / 17 drift-worthy corners with
minimum radii of 47 / 39 / 50 m. Boost pads are then placed from the geometry —
`World._pickBoostSpots` finds the longest genuinely straight runs and drops a
pad a third of the way into each — so they follow any layout change.

## Controls

| Key | |
|---|---|
| `W` `↑` | 加速 throttle |
| `S` `↓` | 刹车 · 倒车 brake / reverse |
| `A` `D` `←` `→` | 转向 steer |
| `SHIFT` | **漂移** — hold while turning to slide and charge nitro |
| `SPACE` | **氮气** — spend one charge for a boost |
| `C` | 切换视角 (chase / close / hood / cinematic) |
| `R` | 回到赛道 respawn |
| `ESC` | 暂停 |

Gamepad (stick + triggers + A/B) and on-screen touch controls are both supported.

**The core loop is the genre's:** hold a drift, the exhaust flames shift
blue → orange → magenta as the charge deepens, release to bank 1–3 nitro bars,
then dump them on the straight. Boost pads on the racing line stack on top.

---

## What is generated, and how

### Sky and lighting — `src/world/sky.js`
A single shader runs Rayleigh + Mie single-scattering for the atmosphere, so the
sun colour, horizon gradient and aerial perspective all stay physically consistent
from golden hour to a rainy midnight. On top of that:

* a **raymarched cloud deck** (14 steps, each with a 2-tap light march toward
  the sun) using Beer–Powder lighting, so dense cores stay dark while the edges
  glow. The dome is drawn last and depth-tested, so the raymarch only shades
  pixels the terrain and buildings did not already cover;
* a **procedural star field** in three density octaves plus a noise-dusted Milky
  Way band;
* **aurora curtains** built from domain-warped noise with a vertical falloff.

The finished dome is baked through `PMREMGenerator` into a prefiltered environment
map, so every PBR surface in the world — car paint, wet asphalt, glass towers,
lake water — receives correct image-based lighting from the actual sky above it.

### Materials — `src/util/tex.js`
A procedural PBR foundry. Each recipe writes albedo, height and roughness per
texel; the height field is then Sobel-filtered into a tangent-space normal map.
Asphalt is cellular aggregate in a dark binder with tyre-polished lanes; barrel
roof tiles get a real convex profile and lapped rows; marble is domain-warped
veining; snow carries drift shapes and a sparkle layer that cuts roughness where
it glints. Everything tiles by construction.

### Terrain — `src/world/terrain.js`
One analytic height field (domain-warped ridged multifractal) drives the mesh,
the off-road physics and every scatter decision. It is *carved* around the track:
the ground rises to meet the verge, drops into a basin under elevated sections so
pylons have somewhere to land, and releases back into untouched landscape further
out. Three concentric LOD rings reach 6.5 km with overlapping seams. The material
splats grass / rock / snow from per-vertex weights, projects rock triplanar on
cliff faces so strata stay vertical, and breaks up tiling with two octaves of
large-scale tint drift.

### Water — `src/world/water.js`
Five layered Gerstner waves with analytically derived normals. Depth is read from
a baked terrain-height texture, giving Beer–Lambert extinction from shallow
turquoise to deep navy, plus a shore foam band that follows the real waterline and
scrolls with the swell.

### Architecture — `src/world/architecture.js`
Three culture packs, all parametric:

* **dynasty** — the signature sweeping roof is a parametric surface: a concave
  slope from ridge to eave, flaring upward with the corners kicking highest and
  the eaves stretching outward as they rise. Timber halls stack it over plastered
  walls, red columns and dougong bracket sets; pagodas repeat it up seven
  diminishing tiers under a ringed finial; paifang gates straddle the road.
* **metro** — towers with random setbacks and a per-window emissive shader: each
  pane is an independent cell that may be lit, may flicker on its own slow cycle,
  and may blink, tinted warm or cool. Roof beacons, holographic billboards and
  street lamps fill the skyline.
* **alpine** — timber chalets under snow-loaded gables, a stone chapel with a bell
  spire, and cable cars whose gondolas actually run their catenary.

### Vegetation and atmosphere — `src/world/flora.js`
Instanced forests (one draw call per species) of lofted tapering trunks and
canopies built from alpha cards on a rough sphere — including alpha-tested depth
materials so trees cast leaf-shaped shadows rather than solid blocks. Tens of
thousands of crossed grass quads, boulders on the steep ground, and a wind shader
that bends everything by height with three superimposed gust frequencies. Petals,
snow, rain, fireflies and embers ride a camera-following particle field; birds
wheel overhead.

### Post-processing — `src/core/engine.js`
HDR linear buffer → cinematic composite → SMAA → ACES tonemap. The composite pass
generates its own bloom (bright pass into a four-level separable Gaussian
pyramid) and folds it in, rather than blending bloom back into the scene buffer
in place — one less full-screen blend, and the bloom texture stays available to
the grade. In the same pass: radial speed streaks with per-channel prismatic
offset, boost heat haze that refracts the frame, lift/gain/contrast/saturation
grading, corner desaturation with the vignette, and luminance-weighted film
grain. Each track ships its own grade.

### Physics — `src/game/vehicle.js`
Heading is a yaw angle turned by a bicycle model; grip pulls velocity toward that
heading, and *dropping grip is what makes the car slide*. Gravity is resolved
against the road normal, so banking genuinely pulls you into the corner and hills
cost or give speed. Leaving the tarmac drops grip and top speed; barriers scrub
speed and kick you back on. Suspension, body roll from lateral load and pitch from
acceleration are layered on as visual response.

### Opponents — `src/game/ai.js`
Each rival derives a racing line from track curvature (turn in wide, clip the
apex), brakes for the speed limit the upcoming corners impose, drifts through the
tight stuff to bank nitro and spends it on straights. A light rubber band keeps
the pack close without making it uncatchable.

### Audio — `src/core/audio.js`
Fully synthesised: four detuned oscillators through a resonant low-pass form the
engine, with a faked gearbox so the note climbs and snaps back at each shift;
band-passed noise gives tyre scrub and wind; nitro, impacts, laps and the
countdown are shaped noise bursts and blips.

---

## Layout

```
src/
  core/      engine (render pipeline + post FX), input, procedural audio
  util/      noise primitives, procedural PBR texture foundry
  world/     sky, terrain, water, flora, architecture, world assembly
  track/     layout builder, spline + road meshes, furniture, circuit definitions
  game/      vehicle physics & model, AI, race director, chase camera, effects
  ui/        HUD, speedometer, mini-map
```

## Performance

Quality presets (流畅 / 均衡 / 极致) scale pixel ratio, anti-aliasing, bloom and
shadow filtering. The heavy work is all front-loaded into world generation;
per-frame CPU cost is a handful of spline queries and a few hundred particles.
Everything else — wind, waves, clouds, windows, flames, crowds — animates on the
GPU.

Development harnesses (run against `npm run preview`):

* `.dev/curve.mjs` — track curvature and corner audit, pure Node, instant.
* `.dev/sim.mjs` — runs complete races headless with rendering stubbed out,
  driving the player with an AI controller; reports lap times, drift and nitro
  usage, stuck time and final standings.
* `.dev/shots.mjs` — steps the simulation deterministically and captures frames
  straight out of the WebGL colour buffer.
