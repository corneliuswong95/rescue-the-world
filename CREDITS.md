# CREDITS — asset license ledger

Every third-party asset (model, texture, HDRI, animation, audio, font) **must** be listed here
with its source and license **before it ships**. CC0 or properly licensed only. **Never**
ingest assets from a commercial game (models, textures, audio, maps, UI, logos, or names).

| Asset | Type | Source | License | Notes |
|---|---|---|---|---|
| kloofendal_43d_clear_puresky (1k) | HDRI | PolyHaven — polyhaven.com/a/kloofendal_43d_clear_puresky | CC0 | Scene IBL + skybox. `public/assets/hdri/kloofendal_puresky_1k.hdr` |
| Concrete034 (1K JPG) | PBR texture | ambientCG — ambientcg.com/view?id=Concrete034 | CC0 | Floor. Color/NormalGL/Roughness → `public/assets/textures/floor/` |
| Plaster001 (1K JPG) | PBR texture | ambientCG — ambientcg.com/view?id=Plaster001 | CC0 | Walls + relief on accent/pillar. `public/assets/textures/wall/` |
| Cardboard004 (1K JPG) | PBR texture | ambientCG — ambientcg.com/view?id=Cardboard004 | CC0 | Crates. `public/assets/textures/crate/` |

**Note:** the soldier + rifle + first-person viewmodel are **original geometry authored in code**
(`ai/soldier.ts`, `weapons/rifle.ts`), not third-party assets. CS/CoD were used only as visual
*references* to observe (rule 3), never as a source of files.
