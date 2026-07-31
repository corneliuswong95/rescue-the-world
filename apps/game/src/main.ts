/**
 * OPERATOR — M1 "greybox playground" (feel first).
 *
 * Boots the WebGPU renderer (auto WebGL2 fallback), a fixed-60 Hz Rapier sim decoupled from
 * the render loop, a kinematic capsule player (WASD + sprint + crouch + jump, momentum,
 * head-bob, Pointer-Lock look), a collidable greybox room, and a placeholder full-auto hitscan
 * weapon with pooled tracers/decals + view recoil. This milestone is about *movement and
 * shooting feel*, not looks. Art/IBL/post arrive in M3.
 */
import * as THREE from 'three/webgpu';
import { createRenderer } from './engine/renderer';
import { createStatsOverlay } from './engine/stats';
import { createFixedLoop } from './engine/loop';
import { initPhysics, createPhysicsWorld } from './physics/world';
import { Input } from './input/input';
import { Player } from './player/player';
import { buildGreybox } from './level/greybox';
import { DecalPool } from './weapons/decals';
import { RaycastWeapon } from './weapons/weapon';
import { createHud } from './ui/hud';
import { installQaHooks } from './qa';

const STEP_HZ = 60;

const app = document.getElementById('app');
if (!app) throw new Error('#app container not found');

// --- Physics + renderer both need async init before we build anything ---
await initPhysics();
const { renderer, backendName } = await createRenderer(app);
const physics = createPhysicsWorld(STEP_HZ);

// --- Scene, camera, lighting ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x223141);
scene.fog = new THREE.Fog(0x223141, 55, 170);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera); // so the viewmodel (a child of the camera) is traversed and rendered
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x3a352c, 1.6);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2e0, 3.0);
sun.position.set(12, 18, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -28;
sun.shadow.camera.right = 28;
sun.shadow.camera.top = 28;
sun.shadow.camera.bottom = -28;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);

// --- World geometry + player + weapon ---
buildGreybox(scene, physics.world);

const input = new Input(renderer.domElement);
const spawn = new THREE.Vector3(0, 0.9, 8); // feet on the floor (centre = STAND_HALF + RADIUS)
const player = new Player(physics.world, input, camera, spawn);

const decals = new DecalPool(scene);
const weapon = new RaycastWeapon(scene, camera, physics.world, decals, player.collider);

const hud = createHud();
const stats = createStatsOverlay(renderer, backendName);

// --- Loop: fixed-step sim, interpolated render ---
const loop = createFixedLoop(STEP_HZ, {
  update: (dt) => {
    player.integrate(dt);
    physics.step();
    player.sync();
  },
  render: (alpha, frameMs) => {
    const fi = input.drain();
    if (input.isLocked) player.applyLook(fi.lookX, fi.lookY);
    weapon.update(frameMs / 1000, fi.firePressed, fi.fireHeld);
    player.updateCamera(alpha, weapon.recoil.pitch, weapon.recoil.yaw);
    hud.setLocked(input.isLocked);
    renderer.render(scene, camera);
    stats.sample(frameMs);
  },
});

renderer.setAnimationLoop(loop.frame);

// --- QA states for the Playwright critic harness ---
function poseAndRender(x: number, y: number, z: number, yaw: number, pitch: number, crouch = 0): void {
  player.setPose(x, y, z, yaw, pitch, crouch);
  player.updateCamera(1, 0, 0); // sync camera immediately so QA raycasts are correct
}

// Yaw such that "forward" = (-sin y, 0, -cos y) points along a given XZ heading.
const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

installQaHooks({
  states: {
    // Standing near the middle, looking across the cover cluster toward the ramp/platform.
    default: () => poseAndRender(9, 0.9, 7, yawToward(-1, -0.55), -0.06),
    // Crouched, looking across the room (lowered viewpoint vs. default).
    crouch: () => poseAndRender(2, 0.9, 14, yawToward(-0.3, -1), 0.03, 1),
    // West wall peppered with impact decals, to show hit feedback registers.
    impacts: () => {
      const px = -11;
      const pz = 0;
      const baseYaw = yawToward(-1, 0); // face the west wall (x = -20)
      poseAndRender(px, 0.9, pz, baseYaw, -0.02);
      for (let i = 0; i < 16; i++) {
        const yaw = baseYaw + (Math.random() - 0.5) * 0.26;
        const pitch = -0.02 + (Math.random() - 0.5) * 0.16;
        poseAndRender(px, 0.9, pz, yaw, pitch);
        weapon.fireOnce();
      }
      poseAndRender(px, 0.9, pz, baseYaw, -0.02);
    },
  },
});
