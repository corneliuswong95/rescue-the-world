"""OPERATOR asset pipeline: fetch CC0 sources from Poly Haven and emit game-ready files.

    python3 tools/assets/build.py --tools <dir with node_modules/@gltf-transform/cli + sharp>
                                  [--cache <raw download dir>] [only-these-assets...]

Models  → apps/game/public/assets/models/<name>.glb   (meshopt geometry, WebP textures)
Textures→ apps/game/public/assets/textures/<name>/{color,normal,arm}.webp  (2K)
HDRI    → apps/game/public/assets/hdri/<name>_2k.hdr

Install the tool deps once (not a runtime dependency of the game):
    npm install --prefix <dir> @gltf-transform/cli@4
Every asset here must also be listed in CREDITS.md.
"""
import argparse
import json
import os
import subprocess
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PUBLIC = os.path.join(ROOT, "apps", "game", "public", "assets")
UA = {"User-Agent": "operator-fps-asset-pipeline/1.0"}

# Model: (max texture size, simplify error as a fraction of extent, keep node hierarchy)
MODELS = {
    "modular_factory_facade": (1024, 0.0001, True),  # kit: modules addressed by node name
    "concrete_road_barrier": (1024, 0.0015, False),
    "concrete_road_barrier_02": (1024, 0.001, False),
    "wooden_military_crate": (1024, 0.001, False),
    "old_military_crate": (1024, 0.001, False),
    "Barrel_01": (1024, 0.0001, False),
    "barrel_03": (1024, 0.0001, False),
    "covered_car": (1024, 0.0005, False),
    "old_tyre": (512, 0.0005, False),
    "exterior_aircon_unit": (1024, 0.001, False),
    "utility_box_02": (1024, 0.0005, False),
    "street_lamp_01": (1024, 0.001, False),
    "metal_trash_can": (1024, 0.001, False),
    "trashbag": (512, 0.001, False),
    "cardboard_box_01": (512, 0.002, False),
    "portable_generator": (1024, 0.001, False),
    "propane_tank": (512, 0.001, False),
    "security_light": (512, 0.001, False),
    "water_manhole_cover": (512, 0.001, False),
    "metal_jerrycan_green": (512, 0.001, False),
    "modular_fire_escape": (1024, 0.0005, False),
}
TEXTURES = ["asphalt_02", "dirty_concrete", "concrete_wall_008"]
HDRIS = ["kloofendal_38d_partly_cloudy_puresky"]

WEBP_JS = """
import sharp from 'sharp';
const [src, dst, q] = process.argv.slice(1);
await sharp(src).webp({ quality: Number(q) }).toFile(dst);
"""


def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def save(path, url):
    if os.path.exists(path):
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(fetch(url))


def files(asset):
    return json.loads(fetch(f"https://api.polyhaven.com/files/{asset}"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tools", required=True)
    ap.add_argument("--cache", default=os.path.join(ROOT, "tools", "assets", ".cache"))
    ap.add_argument("only", nargs="*")
    a = ap.parse_args()
    gt = os.path.join(a.tools, "node_modules", ".bin", "gltf-transform")
    want = lambda n: not a.only or n in a.only  # noqa: E731

    for name, (tex, err, keep) in MODELS.items():
        if not want(name):
            continue
        g = files(name)["gltf"]["1k"]["gltf"]
        d = os.path.join(a.cache, name)
        save(os.path.join(d, f"{name}.gltf"), g["url"])
        for rel, meta in g.get("include", {}).items():
            save(os.path.join(d, rel), meta["url"])
        out = os.path.join(PUBLIC, "models", f"{name.lower()}.glb")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cmd = [gt, "optimize", os.path.join(d, f"{name}.gltf"), out, "--compress", "meshopt",
               "--texture-compress", "webp", "--texture-size", str(tex),
               "--simplify-error", str(err), "--palette", "false"]
        if keep:
            cmd += ["--flatten", "false", "--join", "false", "--instance", "false"]
        subprocess.run(cmd, check=True, capture_output=True)
        print("model  ", name)

    js = os.path.join(a.tools, "webp.mjs")
    with open(js, "w") as f:
        f.write(WEBP_JS)
    for name in TEXTURES:
        if not want(name):
            continue
        fl = files(name)
        for key, role, q in (("Diffuse", "color", 82), ("nor_gl", "normal", 90), ("arm", "arm", 82)):
            src = os.path.join(a.cache, name, f"{role}.jpg")
            save(src, fl[key]["2k"]["jpg"]["url"])
            dst = os.path.join(PUBLIC, "textures", name, f"{role}.webp")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            subprocess.run(["node", js, src, dst, str(q)], check=True, cwd=a.tools)
        print("texture", name)

    for name in HDRIS:
        if want(name):
            save(os.path.join(PUBLIC, "hdri", f"{name}_2k.hdr"), files(name)["hdri"]["2k"]["hdr"]["url"])
            print("hdri   ", name)


if __name__ == "__main__":
    main()
