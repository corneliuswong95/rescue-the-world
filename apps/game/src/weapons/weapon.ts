/**
 * Full-auto hitscan carbine.
 *
 * Gunfeel:
 *  - Recoil moves the aim. Every shot kicks along a fixed, learnable pattern (first five shots
 *    climb almost straight up, then a small left/right sway with a slight right bias). Most of
 *    each kick is a transient camera offset (`recoil`, recovers after release); the rest is a
 *    permanent aim change the player controller drains via `consumeAimKick()`.
 *  - Hip fire has a bloom cone (3° → 6° under sustained fire, +1.5° while moving via
 *    `moveSpread01`); ADS is near pin-point.
 *  - Visual punch: camera roll (`recoil.roll`) and a brief FOV kick (`fovPunch`).
 *  - Sprint (`setSprinting`): rifle cants low; no ADS, and firing waits for a ~0.2 s sprint-out.
 *  - Wall probe: a forward ray from the eye pulls the viewmodel back/low near geometry.
 *  - Spent brass ejects from the port (pooled, one draw).
 * Combat: magazine + reserve with tactical (1.7 s, keeps the chambered round → 30+1) and empty
 * (2.2 s, bolt release) reloads, each beat voiced via `Sfx.reloadBeat`; damage through the
 * HitRegistry (headshot multiplier).
 * One preallocated RAPIER.Ray serves every query — no per-shot/per-frame allocation on our side.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { DecalPool } from './decals';
import { RELOAD_SFX, Viewmodel, type ViewmodelState } from './viewmodel';
import { BrassPool } from './brass';
import { MuzzleFlash } from '../vfx/muzzleFlash';
import type { Tracers } from '../vfx/tracers';
import type { HitRegistry } from '../combat/hittable';
import type { Sfx } from '../audio/audio';

const DEG = Math.PI / 180;

const FIRE_INTERVAL = 0.086; // seconds between shots (~700 RPM)
const MAX_RANGE = 200;
const MAG_SIZE = 30;
const START_RESERVE = 150;
/** Tactical reload: a round stays chambered, so the gun ends at MAG_SIZE + 1. */
const TAC_RELOAD = 1.7;
/** Empty reload: bolt locked back, needs the bolt-release beat. */
const EMPTY_RELOAD = 2.2;
const BODY_DAMAGE = 26;
const HEAD_MULT = 2.3;

// Recoil (per shot).
const KICK_HIP = 0.6 * DEG;
const KICK_ADS = 0.3 * DEG;
const FIRST_SHOT = 1.5; // the first round jumps hardest
/** Share of each kick that is transient (returns after release) at hip … ADS. */
const RECOVERABLE_HIP = 0.65;
const RECOVERABLE_ADS = 0.78;
const ROLL_KICK = 0.4 * DEG;
/** Seconds without a shot before the pattern restarts and recovery speeds up. */
const BURST_GAP = 0.22;

// Spread (full cone angle, degrees).
const SPREAD_HIP = 3;
const SPREAD_PER_SHOT = 0.3;
const SPREAD_HIP_MAX = 6;
const SPREAD_MOVE = 1.5;
const SPREAD_ADS = 0.12;
const SPREAD_RECOVERY = 7; // deg/s back to base once the trigger is released

// Movement coupling.
const ADS_MOVE_SCALE = 0.55;
const SPRINT_OUT = 0.2; // s after sprint ends before the rifle can fire

/** Eye-to-wall distance (m) where the viewmodel starts pulling back (muzzle reach ≈ 0.85 m). */
const WALL_PROBE = 0.95;
const WALL_FULL = 0.45;

/** Eye height above the feet when standing (brass ground-plane fallback). */
const EYE_HEIGHT = 1.62;

/**
 * Horizontal kick (deg, + = left) for shot n of a burst: nearly vertical for the first five,
 * then a fixed ±0.06–0.1° sway with a slight right bias — the same every burst, so learnable.
 */
function patternYawDeg(n: number): number {
  const sway = 0.08 * Math.sin(n * 1.9 + 0.7);
  return n < 5 ? 0.35 * sway - 0.01 : sway - 0.025;
}

/** True when the reload clock passed time `t` between two frames. */
function crossed(prev: number, now: number, t: number): boolean {
  return prev < t && now >= t;
}

export interface ViewRecoil {
  pitch: number;
  yaw: number;
  /** Camera roll (rad), alternating per shot, decays quickly. */
  roll: number;
}

export interface WeaponHooks {
  registry: HitRegistry;
  tracers: Tracers;
  sfx: Sfx;
  /** Impact VFX at a hit point: `surfaceNormal` for hard surfaces, null for flesh. */
  impactFx: (point: THREE.Vector3, shotDir: THREE.Vector3, surfaceNormal: THREE.Vector3 | null) => void;
  /** Muzzle VFX (smoke wisp) at the muzzle's world position, firing along `dir`. */
  muzzleFx: (point: THREE.Vector3, dir: THREE.Vector3) => void;
  /** Player landed a hit on something damageable. */
  onHitmarker: (headshot: boolean, killed: boolean) => void;
  /** Ammo changed (mag, reserve, reloading). */
  onAmmo: (mag: number, reserve: number, reloading: boolean) => void;
}

export class RaycastWeapon {
  /** Transient view kick (rad) added on top of the player's look; recovers after release. */
  readonly recoil: ViewRecoil = { pitch: 0, yaw: 0, roll: 0 };
  /** 0 (still) … 1 (full speed): widens the hip-fire cone. Fed by the player controller. */
  moveSpread01 = 0;
  /** World y of the floor under the player (brass bounces here). Null → eye height − 1.62 m. */
  groundY: number | null = null;

  private mag = MAG_SIZE;
  private reserve = START_RESERVE;
  private reloadTimer = 0;
  private reloadDuration = TAC_RELOAD;
  private emptyReload = false;
  private cooldown = 0;
  private prevReload = false;
  private aimHeld = false;

  /** Carbine + gloved hands (createRifle('viewmodel') inside), attached to the camera. */
  private readonly viewmodel = new Viewmodel();
  private readonly vmState: ViewmodelState = {
    ads: 0,
    kick: 0,
    roll: 0,
    reload: -1,
    empty: false,
    obstruct: 0,
    sprint: 0,
  };
  private readonly muzzleFlash = new MuzzleFlash(0.11);
  private readonly muzzleLight: THREE.PointLight;
  private readonly brass = new BrassPool();
  private kick = 0;
  private ads = 0; // 0 hip … 1 aimed
  private shotIndex = 0; // position in the recoil pattern
  private sinceShot = 1; // seconds since the last shot
  private hipSpread = SPREAD_HIP;
  private fovKick = 0;
  private obstruct = 0; // 0 clear … 1 muzzle against a wall
  private sprintWanted = false;
  private sprint = 0; // 0 ready … 1 full sprint pose
  private sprintOut = 0; // s left before firing is allowed after a sprint
  /** Permanent aim change (rad) not yet handed to the player controller. */
  private readonly pendingAim = { pitch: 0, yaw: 0 };

  /** 0 (hip) … 1 (fully aimed) — the camera reads this to zoom FOV. */
  get adsFactor(): number {
    return this.ads;
  }

  /** Degrees to add to the camera FOV this frame (brief punch on every shot). */
  get fovPunch(): number {
    return this.fovKick;
  }

  /** Current full cone angle (degrees) of the shot spread — for a dynamic crosshair. */
  get spreadDeg(): number {
    return THREE.MathUtils.lerp(this.hipSpread + SPREAD_MOVE * this.moveSpread01, SPREAD_ADS, this.ads);
  }

  /** Move-speed multiplier the player should apply: 1 at hip … 0.55 fully aimed. */
  get moveSpeedScale(): number {
    return THREE.MathUtils.lerp(1, ADS_MOVE_SCALE, this.ads);
  }

  /** Whether the player may sprint right now (not while aiming). */
  get sprintAllowed(): boolean {
    return !this.aimHeld && this.ads < 0.25;
  }

  /** Player sprint state (feed `player.sprinting` every frame). */
  setSprinting(on: boolean): void {
    if (this.sprintWanted && !on) this.sprintOut = SPRINT_OUT;
    this.sprintWanted = on;
  }

  /**
   * Hands over (and clears) the permanent part of the recoil since the last call, in radians
   * (positive pitch = muzzle up, positive yaw = left). Add it to the player's look angles.
   */
  consumeAimKick(out: { pitch: number; yaw: number }): void {
    out.pitch = this.pendingAim.pitch;
    out.yaw = this.pendingAim.yaw;
    this.pendingAim.pitch = 0;
    this.pendingAim.yaw = 0;
  }

  /** Hide the viewmodel outside of play (so it doesn't intrude on menus). */
  setVisible(visible: boolean): void {
    this.viewmodel.root.visible = visible;
  }

  // scratch (the ray reads _rayOrigin/_rayDir by reference)
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDir = new THREE.Vector3(0, 0, -1);
  private readonly ray: RAPIER_NS.Ray;
  private readonly _hit = new THREE.Vector3();
  private readonly _muzzleWorld = new THREE.Vector3();
  private readonly _normal = new THREE.Vector3();
  private readonly _right = new THREE.Vector3();
  private readonly _up = new THREE.Vector3();
  private readonly _port = new THREE.Vector3();
  private readonly _eject = new THREE.Vector3();
  private readonly _portQ = new THREE.Quaternion();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: RAPIER_NS.World,
    private readonly decals: DecalPool,
    private readonly playerCollider: RAPIER_NS.Collider,
    private readonly hooks: WeaponHooks,
  ) {
    this.ray = new RAPIER.Ray(this._rayOrigin, this._rayDir);
    this.camera.add(this.viewmodel.root);

    this.viewmodel.muzzle.add(this.muzzleFlash.root);

    // Flash light sits down-range (further when aimed, so it can't light up the optic tube).
    this.muzzleLight = new THREE.PointLight(0xffc27a, 0, 8, 2);
    this.muzzleLight.position.set(0, 0, -0.5);
    this.viewmodel.muzzle.add(this.muzzleLight);

    // Dim, very short-range fill so the viewmodel reads in shade; sits beside the eye (not in
    // front of it) so walls the player hugs don't get a hotspot.
    const fill = new THREE.PointLight(0xdfeaff, 0.5, 0.7, 2);
    fill.position.set(0.14, 0.1, 0.04);
    this.camera.add(fill);

    this.hooks.onAmmo(this.mag, this.reserve, false);
  }

  update(
    dt: number,
    firePressed: number,
    fireHeld: boolean,
    reloadHeld: boolean,
    aimHeld: boolean,
  ): void {
    // Carry at most one frame of overshoot so the cyclic rate holds at any frame rate (no
    // quantising 700 RPM down to 600 at 60 fps) without banking shots while idle.
    this.cooldown = Math.max(this.cooldown - dt, -dt);
    this.sinceShot += dt;
    this.sprintOut = Math.max(0, this.sprintOut - dt);
    this.aimHeld = aimHeld;

    if (reloadHeld && !this.prevReload) this.startReload();
    this.prevReload = reloadHeld;

    const prevReloadT = this.reloadTimer > 0 ? this.reloadDuration - this.reloadTimer : -1;
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    } else {
      const wantsFire = fireHeld || firePressed > 0;
      const ready = !this.sprintWanted && this.sprintOut <= 0;
      if (wantsFire && ready && this.cooldown <= 0) {
        if (this.mag > 0) {
          this.fire();
          this.mag -= 1;
          this.cooldown += FIRE_INTERVAL;
          this.hooks.onAmmo(this.mag, this.reserve, false);
        } else {
          this.startReload(); // auto-reload on empty
        }
      }
    }
    const reloadT = this.reloadTimer > 0 ? this.reloadDuration - this.reloadTimer : -1;
    this.voiceReload(prevReloadT, reloadT);

    // Aim-down-sights: reloading, sprinting or a wall in the face forces hip.
    const wantAds = aimHeld && this.reloadTimer <= 0 && this.obstruct < 0.5 && !this.sprintWanted;
    this.ads = THREE.MathUtils.damp(this.ads, wantAds ? 1 : 0, 16, dt);
    this.sprint = THREE.MathUtils.damp(this.sprint, this.sprintWanted ? 1 : 0, 13, dt);

    // Recovery: barely while the trigger is held, brisk once released (transient part only).
    const released = this.sinceShot > BURST_GAP;
    if (released) this.shotIndex = 0;
    const rec = released ? 7 : 0.6;
    this.recoil.pitch = THREE.MathUtils.damp(this.recoil.pitch, 0, rec, dt);
    this.recoil.yaw = THREE.MathUtils.damp(this.recoil.yaw, 0, rec, dt);
    this.recoil.roll = THREE.MathUtils.damp(this.recoil.roll, 0, 14, dt);
    this.kick = THREE.MathUtils.damp(this.kick, 0, 14, dt);
    this.fovKick = THREE.MathUtils.damp(this.fovKick, 0, 26, dt);
    if (released) this.hipSpread = Math.max(SPREAD_HIP, this.hipSpread - SPREAD_RECOVERY * dt);

    this.probeWall(dt);

    const s = this.vmState;
    s.ads = this.ads;
    s.kick = this.kick;
    s.roll = this.recoil.roll;
    s.reload = reloadT;
    s.empty = this.emptyReload;
    s.obstruct = this.obstruct;
    s.sprint = this.sprint;
    this.viewmodel.update(dt, s);

    this.muzzleFlash.update(dt);
    this.muzzleLight.intensity = THREE.MathUtils.damp(this.muzzleLight.intensity, 0, 30, dt);

    if (!this.brass.mesh.parent) this.attachBrass();
    const ground = this.groundY ?? this._rayOrigin.y - EYE_HEIGHT;
    this.brass.update(dt, ground);
  }

  /** Brass lives in world space: hang it off the scene root once the camera is in a scene. */
  private attachBrass(): void {
    let root: THREE.Object3D = this.camera;
    while (root.parent) root = root.parent;
    if (root !== this.camera) root.add(this.brass.mesh);
  }

  /** Sound the reload beats the animation crosses this frame (mag-out plays at start). */
  private voiceReload(prev: number, now: number): void {
    if (now < 0) return;
    if (crossed(prev, now, RELOAD_SFX.magIn)) this.hooks.sfx.reloadBeat('magIn');
    if (crossed(prev, now, RELOAD_SFX.slap)) this.hooks.sfx.reloadBeat('slap');
    if (this.emptyReload && crossed(prev, now, RELOAD_SFX.bolt)) this.hooks.sfx.reloadBeat('bolt');
  }

  /** Forward ray from the eye; the closer the hit, the further the gun pulls back. */
  private probeWall(dt: number): void {
    this.camera.getWorldPosition(this._rayOrigin);
    this.camera.getWorldDirection(this._rayDir);
    const hit = this.world.castRay(this.ray, WALL_PROBE, true, undefined, undefined, this.playerCollider);
    const d = hit ? hit.timeOfImpact : WALL_PROBE;
    const target = THREE.MathUtils.smoothstep(WALL_PROBE - d, 0, WALL_PROBE - WALL_FULL);
    this.obstruct = THREE.MathUtils.damp(this.obstruct, target, 12, dt);
  }

  private startReload(): void {
    const cap = this.mag > 0 ? MAG_SIZE + 1 : MAG_SIZE;
    if (this.reloadTimer > 0 || this.mag >= cap || this.reserve <= 0) return;
    this.emptyReload = this.mag === 0;
    this.reloadDuration = this.emptyReload ? EMPTY_RELOAD : TAC_RELOAD;
    this.reloadTimer = this.reloadDuration;
    this.hooks.sfx.reload();
    this.hooks.onAmmo(this.mag, this.reserve, true);
  }

  private finishReload(): void {
    const cap = this.emptyReload ? MAG_SIZE : MAG_SIZE + 1;
    const take = Math.min(cap - this.mag, this.reserve);
    this.mag += take;
    this.reserve -= take;
    this.reloadTimer = 0;
    this.hooks.onAmmo(this.mag, this.reserve, false);
  }

  /**
   * Back to a neutral hip pose (new round / respawn): no carried-over ADS, kick, flash, brass
   * or half-finished reload (ammo counts are left as they are).
   */
  resetPose(): void {
    if (this.reloadTimer > 0) {
      this.reloadTimer = 0;
      this.hooks.onAmmo(this.mag, this.reserve, false);
    }
    this.ads = 0;
    this.kick = 0;
    this.recoil.pitch = this.recoil.yaw = this.recoil.roll = 0;
    this.pendingAim.pitch = this.pendingAim.yaw = 0;
    this.fovKick = 0;
    this.hipSpread = SPREAD_HIP;
    this.shotIndex = 0;
    this.obstruct = 0;
    this.sprint = this.sprintOut = 0;
    this.sprintWanted = false;
    this.muzzleFlash.hide();
    this.muzzleLight.intensity = 0;
    this.brass.clear();
    const s = this.vmState;
    s.ads = s.kick = s.roll = s.obstruct = s.sprint = 0;
    s.reload = -1;
    s.empty = false;
    this.viewmodel.update(0, s);
  }

  /** Fire a single shot immediately, ignoring cooldown/ammo (QA harness only). */
  fireOnce(): void {
    this.fire();
  }

  private fire(): void {
    this.hooks.sfx.gunshot(); // player's weapon: centred

    // Shot direction: crosshair ray bent by a random point in the spread cone.
    this.camera.getWorldPosition(this._rayOrigin);
    this.camera.getWorldDirection(this._rayDir);
    const half = this.spreadDeg * 0.5 * DEG * Math.sqrt(Math.random());
    const a = Math.random() * Math.PI * 2;
    const t = Math.tan(half);
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    this._rayDir
      .addScaledVector(this._right, Math.cos(a) * t)
      .addScaledVector(this._up, Math.sin(a) * t)
      .normalize();

    const hit = this.world.castRayAndGetNormal(
      this.ray,
      MAX_RANGE,
      true,
      undefined,
      undefined,
      this.playerCollider,
    );

    let endPoint: THREE.Vector3;
    if (hit) {
      const toi = hit.timeOfImpact;
      this._hit.copy(this._rayOrigin).addScaledVector(this._rayDir, toi);
      const target = this.hooks.registry.get(hit.collider.handle);
      if (target) {
        const headshot = this._hit.y >= target.headY();
        const dmg = BODY_DAMAGE * (headshot ? HEAD_MULT : 1);
        const killed = target.onHit(dmg, this._hit, headshot);
        this.hooks.impactFx(this._hit, this._rayDir, null);
        this.hooks.sfx.impact(this._hit, true);
        this.hooks.onHitmarker(headshot, killed);
      } else {
        this._normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        this.decals.spawn(this._hit, this._normal);
        this.hooks.impactFx(this._hit, this._rayDir, this._normal);
        this.hooks.sfx.impact(this._hit, false);
      }
      endPoint = this._hit;
    } else {
      endPoint = this._hit.copy(this._rayOrigin).addScaledVector(this._rayDir, MAX_RANGE);
    }

    this.viewmodel.muzzle.getWorldPosition(this._muzzleWorld);
    this.hooks.tracers.spawn(this._muzzleWorld, endPoint);
    this.hooks.muzzleFx(this._muzzleWorld, this._rayDir);

    // Aimed: a small flash and a dim light far down-range so neither washes out the optic.
    const aimed = this.ads > 0.5;
    this.muzzleFlash.fire(0.045, aimed ? 0.3 : 1);
    this.muzzleLight.position.z = aimed ? -1.2 : -0.5;
    this.muzzleLight.intensity = aimed ? 1.2 : 6;

    // Brass: out of the ejection port, back-right and a little up.
    const port = this.viewmodel.ejectionPort;
    port.getWorldPosition(this._port);
    port.getWorldQuaternion(this._portQ);
    this._eject.set(0.88, 0.42, 0.24).normalize().applyQuaternion(this._portQ);
    this.brass.eject(this._port, this._eject);

    // Recoil along the pattern: split into transient view kick + permanent aim change.
    const n = this.shotIndex;
    const pitch = THREE.MathUtils.lerp(KICK_HIP, KICK_ADS, this.ads) * (n === 0 ? FIRST_SHOT : n < 5 ? 1 : 0.85);
    const yaw = (patternYawDeg(n) + (Math.random() - 0.5) * 0.04) * DEG;
    const keep = THREE.MathUtils.lerp(RECOVERABLE_HIP, RECOVERABLE_ADS, this.ads);
    this.recoil.pitch += pitch * keep;
    this.recoil.yaw += yaw * keep;
    this.pendingAim.pitch += pitch * (1 - keep);
    this.pendingAim.yaw += yaw * (1 - keep);
    this.recoil.roll += (n % 2 === 0 ? 1 : -1) * ROLL_KICK * (0.7 + Math.random() * 0.3);
    this.fovKick = 1;
    this.kick = Math.min(1, this.kick + 0.7);
    this.hipSpread = Math.min(SPREAD_HIP_MAX, this.hipSpread + SPREAD_PER_SHOT);
    this.shotIndex = n + 1;
    this.sinceShot = 0;
  }
}
