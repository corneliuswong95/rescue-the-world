# CREDITS — asset license ledger

Every third-party asset (model, texture, HDRI, animation, audio, font) **must** be listed here
with its source and license **before it ships**. CC0 or properly licensed only. **Never**
ingest assets from a commercial game (models, textures, audio, maps, UI, logos, or names).

All assets below are from **Poly Haven** (polyhaven.com) under **CC0** (public domain). Models
are re-encoded offline by `tools/assets/` (meshopt geometry + WebP textures, simplified where
noted) — content unchanged otherwise.

| Asset | Type | Source | License | Notes |
|---|---|---|---|---|
| qwantani_late_afternoon_puresky (2k) | HDRI | polyhaven.com/a/qwantani_late_afternoon_puresky | CC0 | Sky, IBL and sun direction (late-afternoon key). `public/assets/hdri/` |
| Universal Base Characters [Standard] — Superhero Male body | Rigged character mesh | Quaternius — quaternius.itch.io/universal-base-characters (free tier) | CC0 (License_Standard.txt in pack) | Enemy soldier body (no textures shipped). `public/assets/characters/soldier_body.glb` via `tools/assets/build-characters.mjs` |
| Universal Animation Library [Standard] — 15 clips | Animations | Quaternius — quaternius.itch.io/universal-animation-library (free tier) | CC0 (License.txt in pack) | Locomotion, crouch, aim, hit, death clips. `public/assets/characters/soldier_anims.glb` |
| Foundry Yard light probe | Baked data | Generated in-engine from the assets above (`tools/assets/bake-probe.mjs`) | CC0 (derived) | `public/assets/hdri/foundry_yard_probe.bin` |
| asphalt_02 (2k) | PBR texture | polyhaven.com/a/asphalt_02 | CC0 | Yard ground. `public/assets/textures/asphalt_02/` |
| dirty_concrete (2k) | PBR texture | polyhaven.com/a/dirty_concrete | CC0 | Sidewalks. `public/assets/textures/dirty_concrete/` |
| concrete_wall_008 (2k) | PBR texture | polyhaven.com/a/concrete_wall_008 | CC0 | Docks, ramps, curbs. `public/assets/textures/concrete_wall_008/` |
| Modular Factory Facade | Model kit | polyhaven.com/a/modular_factory_facade | CC0 | All four buildings (instanced bays/trims). |
| Concrete Road Barrier | Model | polyhaven.com/a/concrete_road_barrier | CC0 | Checker-painted low cover. Simplified to ~3.7k tris. |
| Concrete Road Barrier 02 | Model | polyhaven.com/a/concrete_road_barrier_02 | CC0 | Jersey-barrier cover. |
| Wooden Military Crate | Model | polyhaven.com/a/wooden_military_crate | CC0 | Crate stacks. |
| Old Military Crate | Model | polyhaven.com/a/old_military_crate | CC0 | Flat crate stack. |
| Barrel 01 | Model | polyhaven.com/a/Barrel_01 | CC0 | Drum clusters. |
| Barrel 03 | Model | polyhaven.com/a/barrel_03 | CC0 | Drum clusters. |
| Covered Car | Model | polyhaven.com/a/covered_car | CC0 | Tarped car cover. |
| Old Tyre | Model | polyhaven.com/a/old_tyre | CC0 | Dressing. |
| Exterior Aircon Unit | Model | polyhaven.com/a/exterior_aircon_unit | CC0 | Wall dressing. |
| Utility Box 02 | Model | polyhaven.com/a/utility_box_02 | CC0 | Wall dressing. |
| Metal Trash Can | Model | polyhaven.com/a/metal_trash_can | CC0 | Dumpsters. |
| Trash Bag | Model | polyhaven.com/a/trashbag | CC0 | Dressing. |
| Cardboard Box 01 | Model | polyhaven.com/a/cardboard_box_01 | CC0 | Dressing. |
| Portable Generator | Model | polyhaven.com/a/portable_generator | CC0 | Equipment corner. |
| Propane Tank | Model | polyhaven.com/a/propane_tank | CC0 | Equipment corner. |
| Security Light | Model | polyhaven.com/a/security_light | CC0 | Wall dressing. |
| Water Manhole Cover | Model | polyhaven.com/a/water_manhole_cover | CC0 | Ground detail. |
| Metal Jerrycan (green) | Model | polyhaven.com/a/metal_jerrycan_green | CC0 | Equipment corner. |
| Modular Fire Escape | Model | polyhaven.com/a/modular_fire_escape | CC0 | North building. |

**Note:** soldier *bodies and animations* are Quaternius CC0 (above); their uniforms, armour, helmet,
kit, the rifle, first-person hands and all their materials are **original geometry/shaders
authored in code** (`ai/soldier*.ts`, `weapons/*.ts`).
Real-world military equipment and CoD/other games were used only as visual *references* to
observe (rule 3), never as a source of files, patterns, markings or names.
