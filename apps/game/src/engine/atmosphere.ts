/**
 * Sun key light + aerial perspective, both driven by the sun extracted from the HDRI
 * (engine/environment.ts) so sky, shadows and haze agree.
 *
 * - Sun: one shadow-casting DirectionalLight whose orthographic shadow frustum is fitted to the
 *   yard + building tops (4096² on high ≈ 1.5 cm texels — crisp contact shadows).
 * - Haze: exponential distance fog with height falloff (thicker near the ground), tinted
 *   toward the sun colour when looking sunward (forward scattering). Subtle at this scale — it
 *   separates foreground from the far buildings rather than "fogging" the scene.
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, dot, exp, float, fog, max, mix, positionWorld, pow, uniform, vec3 } from 'three/tsl';
import type { SkyLight } from './environment';

const SUN_INTENSITY = 4.2;
const SHADOW_HALF = 30; // m — covers the 40 m yard plus the shadow-casting building tops

export interface Sun {
  light: THREE.DirectionalLight;
  setShadowQuality: (mapSize: number | null) => void;
}

export function createSun(scene: THREE.Scene, sky: SkyLight): Sun {
  const light = new THREE.DirectionalLight(sky.sunColor, SUN_INTENSITY);
  light.position.copy(sky.sunDirection).multiplyScalar(60);
  light.target.position.set(0, 0, 0);
  scene.add(light, light.target);

  const cam = light.shadow.camera;
  cam.left = cam.bottom = -SHADOW_HALF;
  cam.right = cam.top = SHADOW_HALF;
  cam.near = 20;
  cam.far = 110;
  light.shadow.bias = -0.00025;
  light.shadow.normalBias = 0.025;
  light.shadow.radius = 2;

  return {
    light,
    setShadowQuality(mapSize: number | null): void {
      light.castShadow = mapSize !== null;
      if (mapSize === null || light.shadow.mapSize.x === mapSize) return;
      light.shadow.mapSize.set(mapSize, mapSize);
      if (light.shadow.map) {
        light.shadow.map.dispose();
        light.shadow.map = null; // rebuilt at the new resolution on next render
      }
    },
  };
}

export function applyHaze(scene: THREE.Scene, sky: SkyLight): void {
  const sunDir = uniform(sky.sunDirection);
  const sunTint = uniform(new THREE.Vector3(sky.sunColor.r, sky.sunColor.g, sky.sunColor.b));
  const view = positionWorld.sub(cameraPosition);
  const dist = view.length();
  const heightFalloff = exp(max(positionWorld.y, 0).mul(-0.07));
  const density = float(1).sub(exp(dist.mul(-0.003))).mul(heightFalloff);
  const scatter = pow(max(dot(view.normalize(), sunDir), 0), 14);
  const haze = mix(vec3(0.5, 0.58, 0.68), sunTint.mul(0.8), scatter);
  scene.fogNode = fog(haze, density);
}
