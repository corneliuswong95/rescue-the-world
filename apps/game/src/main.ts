/**
 * OPERATOR — M2 "combat core".
 *
 * Builds on M1's greybox + player + weapon: adds a recast navmesh, enemy bots (perception +
 * FSM + fair fire) that path real geometry and die, damage routed through a hit registry,
 * player health with death/respawn, and a combat HUD (hitmarkers, ammo, damage direction,
 * objective). Still greybox art — the look/audio pass is M3.
 */
import * as THREE from 'three/webgpu';
import { createRenderer } from './engine/renderer';
import { createStatsOverlay } from './engine/stats';
import { createFixedLoop } from './engine/loop';
import { setupEnvironment } from './engine/environment';
import { createPost } from './engine/post';
import { initPhysics, createPhysicsWorld } from './physics/world';
import { Input } from './input/input';
import { Player } from './player/player';
import { buildGreybox } from './level/greybox';
import { loadLevelMaterials } from './level/materials';
import { DecalPool } from './weapons/decals';
import { RaycastWeapon } from './weapons/weapon';
import { createHud } from './ui/hud';
import { installQaHooks } from './qa';
import { initNavigation, Navigation } from './ai/navmesh';
import { HitRegistry } from './combat/hittable';
import { Tracers } from './vfx/tracers';
import { ParticleBursts } from './vfx/particles';
import { EnemyManager } from './ai/enemies';
import { RIFLEMAN, RUSHER, HEAVY, scaleArchetype } from './ai/archetypes';
import { AudioEngine } from './audio/audio';

const STEP_HZ = 60;

const app = document.getElementById('app');
if (!app) throw new Error('#app container not found');

await initPhysics();
await initNavigation();
const { renderer, backendName } = await createRenderer(app);
const physics = createPhysicsWorld(STEP_HZ);

// --- Scene, camera, lighting ---
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x45566b, 60, 180);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// IBL + skybox from a real HDRI. Provides the ambient fill so the hemisphere light can be
// gentle; the sun stays as the shadow-casting key.
await setupEnvironment(renderer, scene);

const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x3a352c, 0.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2e0, 1.7);
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

// --- World + navmesh ---
const levelMats = await loadLevelMaterials();
const collideMeshes = buildGreybox(scene, physics.world, levelMats);
const nav = new Navigation(collideMeshes);

// --- Player + weapon + combat services ---
const input = new Input(renderer.domElement);
const spawn = new THREE.Vector3(0, 0.9, 8);
const player = new Player(physics.world, input, camera, spawn);

const registry = new HitRegistry();
const decals = new DecalPool(scene);
const playerTracers = new Tracers(scene, 32, 0xffe08a);
const enemyTracers = new Tracers(scene, 48, 0xff5a3c);
const particles = new ParticleBursts(scene, 512);
const hud = createHud();
const stats = createStatsOverlay(renderer, backendName);
const post = createPost(renderer, scene, camera);
const audio = new AudioEngine();
renderer.domElement.addEventListener('mousedown', () => audio.resume());

const _fxDir = new THREE.Vector3();
const _audioFwd = new THREE.Vector3();
const _audioUp = new THREE.Vector3();
const _audioPos = new THREE.Vector3();
const weapon = new RaycastWeapon(camera, physics.world, decals, player.collider, {
  registry,
  tracers: playerTracers,
  sfx: audio,
  impactFx: (point, dir, flesh) => {
    _fxDir.copy(dir).multiplyScalar(-1);
    if (flesh) particles.burst(point, _fxDir, 12, 0x7a1216, 3.5, 1.1, 0.5);
    else particles.burst(point, _fxDir, 6, 0xb6a888, 2.4, 1.5, 0.28);
  },
  onHitmarker: (headshot, killed) => {
    hud.hitmarker(headshot, killed);
    audio.hitmarker(headshot);
  },
  onAmmo: (mag, reserve, reloading) => hud.setAmmo(mag, reserve, reloading),
});

// --- Enemies ---
const enemies = new EnemyManager({
  scene,
  world: physics.world,
  nav,
  registry,
  tracers: enemyTracers,
  player,
  sfx: audio,
});
const DIFFICULTY = 1; // 0 easy … 2 hard (wired to settings later)
const roster: [THREE.Vector3, typeof RIFLEMAN][] = [
  [new THREE.Vector3(-14, 1, -11), RIFLEMAN],
  [new THREE.Vector3(12, 1, -12), HEAVY],
  [new THREE.Vector3(-5, 1, -3), RUSHER],
  [new THREE.Vector3(9, 1, 5), RIFLEMAN],
  [new THREE.Vector3(-16, 1, -12), RUSHER],
];
for (const [pos, arch] of roster) enemies.spawn(pos, scaleArchetype(arch, DIFFICULTY));
const totalEnemies = roster.length;

// --- Death / respawn + objective ---
let respawnIn = 0;
let cleared = false;
player.onDamaged = (rel) => hud.damageFrom(rel);
player.onDied = () => {
  respawnIn = 2.6;
  hud.setMessage('YOU DIED');
};

// --- Loop ---
const loop = createFixedLoop(STEP_HZ, {
  update: (dt) => {
    player.integrate(dt);
    enemies.integrate(dt);
    physics.step();
    player.sync();
  },
  render: (alpha, frameMs) => {
    const dt = frameMs / 1000;
    const fi = input.drain();
    const alive = player.isAlive();

    if (input.isLocked && alive) player.applyLook(fi.lookX, fi.lookY);
    weapon.update(
      dt,
      alive ? fi.firePressed : 0,
      alive && fi.fireHeld,
      alive && input.isDown('KeyR'),
      alive && fi.aimHeld,
    );
    // ADS zooms the camera FOV.
    const wantFov = 70 - 18 * weapon.adsFactor;
    if (Math.abs(camera.fov - wantFov) > 0.05) {
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
    if (alive && fi.firePressed > 0) {
      player.eye(_qaTmp);
      enemies.broadcastGunfire(_qaTmp);
    }
    player.updateCamera(alpha, weapon.recoil.pitch, weapon.recoil.yaw);
    enemies.render(alpha, dt);

    playerTracers.update(dt);
    enemyTracers.update(dt);
    particles.update(dt);
    hud.update(dt);

    // Audio listener follows the camera.
    camera.getWorldDirection(_audioFwd);
    _audioUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    player.eye(_audioPos);
    audio.setListener(_audioPos, _audioFwd, _audioUp);

    // Respawn timer.
    if (respawnIn > 0) {
      respawnIn -= dt;
      if (respawnIn <= 0) {
        player.respawn(spawn);
        hud.setMessage(null);
      }
    }

    // HUD state.
    hud.setLocked(input.isLocked);
    hud.setHealth(player.health, 100);
    const left = enemies.aliveCount();
    if (left === 0 && !cleared) {
      cleared = true;
      hud.setMessage('HOSTILES ELIMINATED');
    }
    hud.setObjective(
      cleared ? 'SECTOR CLEAR' : `ELIMINATE HOSTILES — ${left} / ${totalEnemies}`,
    );

    post.render();
    stats.sample(frameMs);
  },
});

renderer.setAnimationLoop(loop.frame);

// --- QA states ---
const _qaTmp = new THREE.Vector3();
const _qaEye = new THREE.Vector3();

const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

function aimAt(from: THREE.Vector3, target: THREE.Vector3): void {
  player.setPose(from.x, from.y, from.z, yawToward(target.x - from.x, target.z - from.z), 0);
  player.eye(_qaEye);
  const dx = target.x - _qaEye.x;
  const dy = target.y - _qaEye.y;
  const dz = target.z - _qaEye.z;
  const horiz = Math.hypot(dx, dz);
  const pitch = Math.atan2(dy, horiz);
  player.setPose(from.x, from.y, from.z, yawToward(dx, dz), pitch);
  player.updateCamera(1, 0, 0);
}

installQaHooks({
  states: {
    // Survey the arena and the bots.
    overview: () => {
      player.setPose(14, 0.9, 13, yawToward(-1, -1), -0.12);
      player.updateCamera(1, 0, 0);
    },
    // Aim at the nearest bot and put a lethal burst into it (toppling body + blood + decals).
    combat: () => {
      const from = new THREE.Vector3(2, 0.9, 6);
      player.setPose(from.x, from.y, from.z, Math.PI, 0);
      player.eye(_qaEye);
      if (enemies.nearestAlive(_qaEye, _qaTmp)) {
        for (let i = 0; i < 6; i++) {
          aimAt(from, _qaTmp);
          weapon.fireOnce();
        }
        aimAt(from, _qaTmp); // settle aim on the target for the shot
      }
    },
  },
});
