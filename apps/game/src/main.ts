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
import { bakeLocalProbe, exportProbe, loadBakedProbe, setupEnvironment } from './engine/environment';
import { applyHaze, createSun } from './engine/atmosphere';
import { createPost } from './engine/post';
import { initPhysics, createPhysicsWorld } from './physics/world';
import { Input } from './input/input';
import { Player } from './player/player';
import { STACK_TOP, buildLevel, loadLevelAssets } from './level/compound';
import { loadLevelMaterials } from './level/materials';
import { DecalPool } from './weapons/decals';
import { RaycastWeapon } from './weapons/weapon';
import { createHud } from './ui/hud';
import { installQaHooks } from './qa';
import { initNavigation, Navigation } from './ai/navmesh';
import { HitRegistry } from './combat/hittable';
import { Tracers } from './vfx/tracers';
import { ParticleFx } from './vfx/particles';
import { EnemyManager } from './ai/enemies';
import { RIFLEMAN, RUSHER, HEAVY, scaleArchetype, type Archetype } from './ai/archetypes';
import { AudioEngine } from './audio/audio';
import { loadSettings, saveSettings, DIFFICULTY_VALUE, type Settings, type Quality } from './game/settings';
import { createMenus } from './ui/menus';

const STEP_HZ = 60;

const app = document.getElementById('app');
if (!app) throw new Error('#app container not found');

// Boot stage timings (console, `?debug` only) — time-to-playable is a tracked budget.
const bootLog = new URLSearchParams(location.search).has('debug');
let bootLast = performance.now();
const bootMark = (stage: string): void => {
  if (!bootLog) return;
  const now = performance.now();
  console.info(`[boot] ${stage}: ${(now - bootLast).toFixed(0)} ms (t=${now.toFixed(0)})`);
  bootLast = now;
};

await initPhysics();
await initNavigation();
bootMark('wasm (physics + recast)');
const { renderer, backendName } = await createRenderer(app);
bootMark('renderer init');
const physics = createPhysicsWorld(STEP_HZ);

// --- Scene, camera, lighting ---
const scene = new THREE.Scene();

// 62° vertical ≈ 94° horizontal at 16:9 — wide enough for awareness without fisheye edges.
const FOV = 62;
const ADS_FOV = 46;
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 300);
scene.add(camera);
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// One sun for everything: extracted from the HDRI (sky + IBL), placed behind-right of the
// player's northward spawn view so the yard reads front-lit with long diagonal shadows.
const SUN_AZIMUTH = 0.7;
const [sky, levelMats, levelAssets] = await Promise.all([
  setupEnvironment(renderer, scene, SUN_AZIMUTH),
  loadLevelMaterials(),
  loadLevelAssets(),
]);
const sun = createSun(scene, sky);
applyHaze(scene, sky);

// --- World + navmesh ---
bootMark('assets + HDRI (download/decode/sun extract/PMREM)');
const level = buildLevel(scene, physics.world, levelMats, levelAssets);
bootMark('level build');
const nav = new Navigation(level.navMeshes);
bootMark('navmesh');
// Rapier only refreshes its query structures on step(): do it now so spawn ground-raycasts (and
// anything else that queries before the first step) see the level.
physics.world.updateSceneQueries();

// --- Player + weapon + combat services ---
const input = new Input(renderer.domElement);
const spawn = new THREE.Vector3(4, 0.9, 12.2); // behind the checker-barrier line, facing the yard
const player = new Player(physics.world, input, camera, spawn);

const registry = new HitRegistry();
const decals = new DecalPool(scene);
const playerTracers = new Tracers(scene, 32, 0xffe08a, 3, 3, 3.5); // own fire: every 3rd round, from 3.5 m out
const enemyTracers = new Tracers(scene, 48, 0xff7a3c, 5); // incoming fire: reads clearly
const particles = new ParticleFx(scene);
const hud = createHud();
const stats = createStatsOverlay(renderer, backendName);
const post = createPost(renderer, scene, camera);
const audio = new AudioEngine();
renderer.domElement.addEventListener('mousedown', () => audio.resume());

const weapon = new RaycastWeapon(camera, physics.world, decals, player.collider, {
  registry,
  tracers: playerTracers,
  sfx: audio,
  impactFx: (point, shotDir, surfaceNormal) => {
    if (surfaceNormal) particles.surfaceImpact(point, surfaceNormal);
    else particles.fleshImpact(point, shotDir); // exit spray continues along the shot
  },
  muzzleFx: (point, dir) => particles.muzzleSmoke(point, dir),
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
  fx: particles,
  player,
  sfx: audio,
});
const SPAWNS: [THREE.Vector3, Archetype][] = [
  [new THREE.Vector3(-16, 2.1, -10), RIFLEMAN], // west loading dock
  [new THREE.Vector3(13.5, 1, -15), HEAVY],
  [new THREE.Vector3(-3, 1, -1.5), RUSHER],
  [new THREE.Vector3(17, 2.1, 4), RIFLEMAN], // east loading dock
  [new THREE.Vector3(-11, 1, -16), RUSHER],
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
  // New bot capsules must be queryable immediately (QA states shoot before the first step).
  physics.world.updateSceneQueries();
}

player.onDamaged = (rel) => hud.damageFrom(rel);
player.onFootstep = () => audio.footstep();
player.onDied = () => {
  if (gameState === 'playing') lose();
};

// --- Settings + menus + game state ---
const settings = loadSettings();
const menus = createMenus(settings);
type GameState = 'menu' | 'playing' | 'paused' | 'won' | 'lost';
let gameState: GameState = 'menu';
let missionTime = 0;
let qaFreeze = false; // QA-only: freeze sim + VFX decay so transient effects persist into a capture
let qaAim = false; // QA-only: hold aim-down-sights without input

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
  weapon.resetPose();
  // Fresh round: no leftover tracers, puffs or bullet holes from the last one.
  playerTracers.clear();
  enemyTracers.clear();
  hud.reset();
  particles.clear();
  particles.warmPlume(STACK_TOP, 10);
  decals.clear();
  missionTime = 0;
  qaFreeze = false;
  qaAim = false;
  gameState = 'playing';
  hud.setMessage(null);
  menus.hideAll();
  audio.resume();
  audio.startAmbience();
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
    sun.setShadowQuality(null);
    usePost = false;
  } else {
    // CSS-pixel resolution on every tier: TRAA + sharpen resolve sub-pixel detail, and a retina
    // panel at 1.25–2× measured 20–36 fps on an M1 (vs ~60 at 1×) for little visible gain.
    renderer.setPixelRatio(1);
    sun.setShadowQuality(q === 'high' ? 4096 : 2048);
    post.setQuality(q);
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

// Local light probe from the middle of the yard. Shipped pre-baked (a live bake compiles every
// material for the cube pass: ~2.5 s of boot); `?bakeprobe` re-bakes live and exposes the file
// bytes for tools/assets/bake-probe.mjs. Falls back to a live bake if the asset is missing.
const PROBE_URL = '/assets/hdri/foundry_yard_probe.bin';
const rebake = new URLSearchParams(location.search).has('bakeprobe');
if (rebake || !(await loadBakedProbe(scene, PROBE_URL))) {
  weapon.setVisible(false); // keep the viewmodel out of the capture
  const probe = bakeLocalProbe(renderer, scene, sky, new THREE.Vector3(0, 2.4, 0));
  if (rebake) Object.assign(window, { __probeBytes: await exportProbe(renderer, probe) });
} else {
  sky.iblSky.dispose();
}
bootMark('light probe');

// Shader prewarm: compile every material × pass variant behind the boot, so the first DEPLOY,
// shot, impact and kill don't hitch on pipeline compiles. Bots are spawned, pooled effects are
// un-hidden, and the real post pipeline renders the yard from four directions.
async function prewarm(): Promise<void> {
  spawnEnemies();
  weapon.setVisible(true);
  const unhidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      o.visible = true;
      unhidden.push(o);
    }
  });
  // Only the active tier's pipelines: post tiers never draw to the canvas context, so compiling
  // it (or the other tier's graph) would just add seconds of boot. Switching tier in settings
  // compiles the new tier once.
  for (let i = 0; i < 4; i++) {
    player.setPose(0, 0.9, 0, (i * Math.PI) / 2, 0);
    player.updateCamera(1, 0, 0);
    if (usePost) post.render();
    else renderer.render(scene, camera);
  }
  for (const o of unhidden) o.visible = false;
  weapon.setVisible(false);
  enemies.clear();
  player.respawn(spawn);
}
await prewarm();
bootMark('shader prewarm');
particles.warmPlume(STACK_TOP, 10);
menus.showMenu();
const _aimKick = { pitch: 0, yaw: 0 };
let plumeTimer = 0;

// Main-menu backdrop: a slow, eased dolly across the yard toward the smokestack.
let menuT = 0;
const _menuFrom = new THREE.Vector3(-13, 2.1, 15);
const _menuTo = new THREE.Vector3(7, 1.7, 9);
const _menuLook = new THREE.Vector3(-4, 4.5, -18);
function menuFlythrough(dt: number): void {
  menuT += dt / 40; // 40 s per pass, ping-pong
  const t = 0.5 - 0.5 * Math.cos(Math.PI * (menuT % 2 < 1 ? menuT % 1 : 1 - (menuT % 1)));
  camera.position.lerpVectors(_menuFrom, _menuTo, t);
  camera.lookAt(_menuLook);
}

// --- Loop ---
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _pos = new THREE.Vector3();
const loop = createFixedLoop(STEP_HZ, {
  update: (dt) => {
    if (gameState !== 'playing' || qaFreeze) return;
    missionTime += dt;
    player.integrate(dt);
    enemies.integrate(dt);
    physics.step();
    player.sync();
  },
  render: (alpha, frameMs) => {
    const dt = frameMs / 1000;
    const playing = gameState === 'playing';
    const active = playing && !qaFreeze; // frozen: keep rendering, stop advancing sim + VFX
    const fx = active ? dt : 0;
    const fi = input.drain();

    // ADS slows look ~30% so fine aim stays controllable at the narrower FOV.
    if (input.isLocked && active) player.applyLook(fi.lookX, fi.lookY, 1 - 0.3 * weapon.adsFactor);
    weapon.update(
      qaAim ? dt : fx, // QA ADS pose keeps animating the aim-in while the sim is frozen
      active ? fi.firePressed : 0,
      active && fi.fireHeld,
      active && input.isDown('KeyR'),
      (active && fi.aimHeld) || qaAim,
    );
    weapon.consumeAimKick(_aimKick); // the non-recovering share of recoil moves real aim
    player.addAim(_aimKick.pitch, _aimKick.yaw);
    weapon.moveSpread01 = Math.min(1, player.speed / 5.2); // full move-penalty at walk speed
    // Sprint ↔ aim rules: sprinting lowers the gun (no ADS/fire until it's back up); aiming
    // blocks sprint and slows movement.
    weapon.setSprinting(player.sprinting);
    player.sprintAllowed = weapon.sprintAllowed;
    player.speedScale = weapon.moveSpeedScale;
    weapon.groundY = player.feetY;
    const wantFov = FOV - (FOV - ADS_FOV) * weapon.adsFactor + weapon.fovPunch;
    if (Math.abs(camera.fov - wantFov) > 0.05) {
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }
    if (active && fi.firePressed > 0) {
      player.eye(_pos);
      enemies.broadcastGunfire(_pos);
    }
    if (gameState === 'menu') menuFlythrough(dt);
    else player.updateCamera(alpha, weapon.recoil.pitch, weapon.recoil.yaw, weapon.recoil.roll);
    enemies.render(alpha, fx);

    // Smokestack plume: steady puffs while the world runs (menu included).
    plumeTimer -= gameState === 'menu' ? dt : fx;
    if (plumeTimer <= 0) {
      plumeTimer = 0.35;
      particles.plume(STACK_TOP);
    }
    playerTracers.update(fx);
    enemyTracers.update(fx);
    particles.update(gameState === 'menu' ? dt : fx);
    hud.update(fx);

    camera.getWorldDirection(_fwd);
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    player.eye(_pos);
    audio.setListener(_pos, _fwd, _up);

    if (active && enemies.aliveCount() === 0) win();

    hud.setVisible(playing);
    hud.setAim(player.sprinting ? 1 : weapon.adsFactor); // no crosshair while sprinting or aimed
    hud.setSpread(
      (window.innerHeight / 2) * (Math.tan(THREE.MathUtils.degToRad(weapon.spreadDeg) / 2) /
        Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)),
    );
    weapon.setVisible(playing);
    hud.setHealth(player.health, 100);
    hud.setObjective(`ELIMINATE HOSTILES — ${enemies.aliveCount()} / ${totalEnemies}`);

    if (usePost) post.render();
    else renderer.render(scene, camera);
    stats.sample(frameMs);
  },
});

renderer.setAnimationLoop(loop.frame);

// --- QA states (drive the game into a playable pose for the critic harness) ---
// Every gameplay state freezes the sim once posed: TRAA/GTAO need a few seconds of identical
// frames to converge, and live bots would otherwise move (or kill the player) mid-capture.
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
    // The real first frame a player sees after DEPLOY (no pose override).
    spawn: () => {
      startGame();
      player.updateCamera(1, 0, 0);
      qaFreeze = true;
    },
    overview: () => {
      startGame();
      player.setPose(14, 0.9, 13, yawToward(-1, -1), -0.12);
      player.updateCamera(1, 0, 0);
      qaFreeze = true;
    },
    // Wide establishing shot: buildings, skyline, sky/sun agreement.
    vista: () => {
      startGame();
      player.setPose(-6, 0.9, 15.5, yawToward(0.55, -1), 0.06);
      player.updateCamera(1, 0, 0);
      qaFreeze = true;
    },
    // Toward the west loading dock + ramp: concrete, props, shadowed facade.
    dock: () => {
      startGame();
      player.setPose(4, 0.9, 1, yawToward(-1, -0.55), -0.05);
      player.updateCamera(1, 0, 0);
      qaFreeze = true;
    },
    // Aim-down-sights sight picture on a target.
    ads: () => {
      startGame();
      const from = new THREE.Vector3(0, 0.9, 8);
      player.setPose(from.x, from.y, from.z, Math.PI, 0);
      player.eye(_qaEye);
      if (enemies.nearestAlive(_qaEye, _qaTmp)) aimAt(from, _qaTmp);
      qaAim = true;
      qaFreeze = true;
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
      qaFreeze = true;
    },
    // Freeze-frame the instant of firing so the (real, but transient) muzzle flash, tracer,
    // impact blood and hitmarker persist into the capture for the critic to judge.
    firefight: () => {
      startGame();
      const from = new THREE.Vector3(3, 0.9, 3);
      player.setPose(from.x, from.y, from.z, Math.PI, 0);
      player.eye(_qaEye);
      if (enemies.nearestAlive(_qaEye, _qaTmp)) {
        for (let i = 0; i < 3; i++) {
          aimAt(from, _qaTmp);
          weapon.fireOnce();
        }
        aimAt(from, _qaTmp);
        weapon.fireOnce(); // final shot: fresh flash / tracer / blood / hitmarker
      }
      // Age the transient VFX ~70 ms so the frozen frame shows puffs/sparks/tracers mid-flight.
      particles.update(0.07);
      playerTracers.update(0.02);
      enemyTracers.update(0.02);
      qaFreeze = true;
    },
  },
});
