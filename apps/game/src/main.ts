/**
 * OPERATOR — main entry / game controller.
 *
 * Wires the persistent systems (renderer, physics, navmesh, player, weapon, enemies, HUD,
 * audio, post) and the game lifecycle: menu → playing → paused → won/lost, with settings
 * (sensitivity/volume/quality/difficulty) and quality tiers that actually change perf.
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
import { RIFLEMAN, RUSHER, HEAVY, scaleArchetype, type Archetype } from './ai/archetypes';
import { AudioEngine } from './audio/audio';
import { loadSettings, saveSettings, DIFFICULTY_VALUE, type Settings, type Quality } from './game/settings';
import { createMenus } from './ui/menus';

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
const SPAWNS: [THREE.Vector3, Archetype][] = [
  [new THREE.Vector3(-14, 1, -11), RIFLEMAN],
  [new THREE.Vector3(12, 1, -12), HEAVY],
  [new THREE.Vector3(-5, 1, -3), RUSHER],
  [new THREE.Vector3(9, 1, 5), RIFLEMAN],
  [new THREE.Vector3(-16, 1, -12), RUSHER],
];
let totalEnemies = 0;
function spawnEnemies(): void {
  enemies.clear();
  const d = DIFFICULTY_VALUE[settings.difficulty];
  totalEnemies = 0;
  for (const [pos, arch] of SPAWNS) {
    enemies.spawn(pos, scaleArchetype(arch, d));
    totalEnemies += 1;
  }
}

player.onDamaged = (rel) => hud.damageFrom(rel);
player.onDied = () => {
  if (gameState === 'playing') lose();
};

// --- Settings + menus + game state ---
const settings = loadSettings();
const menus = createMenus(settings);
type GameState = 'menu' | 'playing' | 'paused' | 'won' | 'lost';
let gameState: GameState = 'menu';
let missionTime = 0;

function lockPointer(): void {
  try {
    renderer.domElement.requestPointerLock();
  } catch {
    /* headless / not a user gesture */
  }
}
function releasePointer(): void {
  if (document.pointerLockElement) document.exitPointerLock();
}
function startGame(): void {
  spawnEnemies();
  player.respawn(spawn);
  missionTime = 0;
  gameState = 'playing';
  hud.setMessage(null);
  menus.hideAll();
  audio.resume();
  lockPointer();
}
function pauseGame(): void {
  if (gameState !== 'playing') return;
  gameState = 'paused';
  menus.showPause();
}
function resumeGame(): void {
  if (gameState !== 'paused') return;
  gameState = 'playing';
  menus.hideAll();
  audio.resume();
  lockPointer();
}
function quitToMenu(): void {
  enemies.clear();
  gameState = 'menu';
  menus.showMenu();
  releasePointer();
}
function win(): void {
  gameState = 'won';
  menus.showWin(missionTime);
  releasePointer();
}
function lose(): void {
  gameState = 'lost';
  menus.showLose();
  releasePointer();
}

menus.onStart = startGame;
menus.onResume = resumeGame;
menus.onRestart = startGame;
menus.onQuitToMenu = quitToMenu;
menus.onSettingsChange = (s) => applySettings(s);

// Esc (or lost focus) while playing → pause.
document.addEventListener('pointerlockchange', () => {
  if (gameState === 'playing' && document.pointerLockElement !== renderer.domElement) {
    pauseGame();
  }
});

// --- Quality tiers (actually change perf) ---
let usePost = true;
function applyQuality(q: Quality): void {
  if (q === 'low') {
    renderer.setPixelRatio(1);
    sun.castShadow = false;
    usePost = false;
  } else {
    const pr = q === 'high' ? 2 : 1.5;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, pr));
    sun.castShadow = true;
    const m = q === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(m, m);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null; // force a rebuild at the new resolution
    }
    usePost = true;
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
}
function applySettings(s: Settings): void {
  Object.assign(settings, s);
  player.sensitivity = s.sensitivity;
  audio.setMasterVolume(s.volume);
  applyQuality(s.quality);
  saveSettings(settings);
}
applySettings(settings);
menus.showMenu();

// --- Loop ---
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const loop = createFixedLoop(STEP_HZ, {
  update: (dt) => {
    if (gameState !== 'playing') return;
    missionTime += dt;
    player.integrate(dt);
    enemies.integrate(dt);
    physics.step();
    player.sync();
  },
  render: (alpha, frameMs) => {
    const dt = frameMs / 1000;
    const playing = gameState === 'playing';
    const fx = playing ? dt : 0;
    const fi = input.drain();

    if (input.isLocked && playing) player.applyLook(fi.lookX, fi.lookY);
    weapon.update(
      dt,
      playing ? fi.firePressed : 0,
      playing && fi.fireHeld,
      playing && input.isDown('KeyR'),
      playing && fi.aimHeld,
    );
    const wantFov = 70 - 18 * weapon.adsFactor;
    if (Math.abs(camera.fov - wantFov) > 0.05) {
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
    if (playing && fi.firePressed > 0) {
      player.eye(_pos);
      enemies.broadcastGunfire(_pos);
    }
    player.updateCamera(alpha, weapon.recoil.pitch, weapon.recoil.yaw);
    enemies.render(alpha, fx);

    playerTracers.update(fx);
    enemyTracers.update(fx);
    particles.update(fx);
    hud.update(dt);

    camera.getWorldDirection(_fwd);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    player.eye(_pos);
    audio.setListener(_pos, _fwd, _up);

    if (playing && enemies.aliveCount() === 0) win();

    hud.setVisible(playing);
    hud.setHealth(player.health, 100);
    hud.setObjective(`ELIMINATE HOSTILES — ${enemies.aliveCount()} / ${totalEnemies}`);

    if (usePost) post.render();
    else renderer.render(scene, camera);
    stats.sample(frameMs);
  },
});

renderer.setAnimationLoop(loop.frame);

// --- QA states (drive the game into a playable pose for the critic harness) ---
const _qaTmp = new THREE.Vector3();
const _qaEye = new THREE.Vector3();
const yawToward = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

function aimAt(from: THREE.Vector3, target: THREE.Vector3): void {
  player.eye(_qaEye);
  const dx = target.x - _qaEye.x;
  const dy = target.y - _qaEye.y;
  const dz = target.z - _qaEye.z;
  player.setPose(from.x, from.y, from.z, yawToward(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
  player.updateCamera(1, 0, 0);
}

installQaHooks({
  states: {
    menu: () => {
      quitToMenu();
    },
    overview: () => {
      startGame();
      player.setPose(14, 0.9, 13, yawToward(-1, -1), -0.12);
      player.updateCamera(1, 0, 0);
    },
    combat: () => {
      startGame();
      const from = new THREE.Vector3(2, 0.9, 6);
      player.setPose(from.x, from.y, from.z, Math.PI, 0);
      player.eye(_qaEye);
      if (enemies.nearestAlive(_qaEye, _qaTmp)) {
        for (let i = 0; i < 6; i++) {
          aimAt(from, _qaTmp);
          weapon.fireOnce();
        }
        aimAt(from, _qaTmp);
      }
    },
  },
});
