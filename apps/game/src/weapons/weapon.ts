/**
 * Full-auto hitscan carbine. Feel bits: procedural viewmodel (hip/ADS, kick, breathing sway,
 * animated reload — see viewmodel.ts), muzzle flash, shared pooled tracers, view-recoil the
 * player camera consumes. Combat: magazine + reserve ammo with reload,
 * damage routed through the HitRegistry (headshot multiplier), hitmarker + blood callbacks.
 * Fully pooled — no per-shot allocation.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { DecalPool } from './decals';
import { Viewmodel } from './viewmodel';
import { MuzzleFlash } from '../vfx/muzzleFlash';
import type { Tracers } from '../vfx/tracers';
import type { HitRegistry } from '../combat/hittable';
import type { Sfx } from '../audio/audio';

const FIRE_INTERVAL = 0.086; // seconds between shots (~700 RPM)
const MAX_RANGE = 200;
const MAG_SIZE = 30;
const START_RESERVE = 150;
const RELOAD_TIME = 1.9;
const BODY_DAMAGE = 26;
const HEAD_MULT = 2.3;

export interface ViewRecoil {
  pitch: number;
  yaw: number;
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
  readonly recoil: ViewRecoil = { pitch: 0, yaw: 0 };

  private mag = MAG_SIZE;
  private reserve = START_RESERVE;
  private reloadTimer = 0;
  private cooldown = 0;
  private prevReload = false;

  /** Carbine + gloved hands (createRifle('viewmodel') inside), attached to the camera. */
  private readonly viewmodel = new Viewmodel();
  private readonly muzzleFlash = new MuzzleFlash(0.16);
  private readonly muzzleLight: THREE.PointLight;
  private kick = 0;
  private ads = 0; // 0 hip … 1 aimed

  /** 0 (hip) … 1 (fully aimed) — the camera reads this to zoom FOV. */
  get adsFactor(): number {
    return this.ads;
  }

  /** Hide the viewmodel outside of play (so it doesn't intrude on menus). */
  setVisible(visible: boolean): void {
    this.viewmodel.root.visible = visible;
  }

  // scratch
  private readonly _origin = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _hit = new THREE.Vector3();
  private readonly _muzzleWorld = new THREE.Vector3();
  private readonly _normal = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: RAPIER_NS.World,
    private readonly decals: DecalPool,
    private readonly playerCollider: RAPIER_NS.Collider,
    private readonly hooks: WeaponHooks,
  ) {
    this.camera.add(this.viewmodel.root);

    this.viewmodel.muzzle.add(this.muzzleFlash.root);

    // Flash light sits half a metre down-range: it lights the surroundings and the gun from the
    // front, instead of blowing out the optic at inverse-square range.
    this.muzzleLight = new THREE.PointLight(0xffc27a, 0, 8, 2);
    this.muzzleLight.position.set(0, 0, -0.5);
    this.viewmodel.muzzle.add(this.muzzleLight);

    // Dim, short-range fill so the viewmodel always reads (standard FP treatment).
    const fill = new THREE.PointLight(0xdfeaff, 0.9, 1.8, 2.4);
    fill.position.set(0.1, 0.15, -0.15);
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
    this.cooldown -= dt;

    if (reloadHeld && !this.prevReload) this.startReload();
    this.prevReload = reloadHeld;

    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    } else {
      const wantsFire = fireHeld || firePressed > 0;
      if (wantsFire && this.cooldown <= 0) {
        if (this.mag > 0) {
          this.fire();
          this.mag -= 1;
          this.cooldown = FIRE_INTERVAL;
          this.hooks.onAmmo(this.mag, this.reserve, false);
        } else {
          this.startReload(); // auto-reload on empty
        }
      }
    }

    // Aim-down-sights: reloading forces hip.
    const wantAds = aimHeld && this.reloadTimer <= 0;
    this.ads = THREE.MathUtils.damp(this.ads, wantAds ? 1 : 0, 16, dt);

    this.recoil.pitch = THREE.MathUtils.damp(this.recoil.pitch, 0, 9, dt);
    this.recoil.yaw = THREE.MathUtils.damp(this.recoil.yaw, 0, 9, dt);
    this.kick = THREE.MathUtils.damp(this.kick, 0, 14, dt);

    const reload = this.reloadTimer > 0 ? 1 - this.reloadTimer / RELOAD_TIME : -1;
    this.viewmodel.update(dt, this.ads, this.kick, reload);

    this.muzzleFlash.update(dt);
    this.muzzleLight.intensity = THREE.MathUtils.damp(this.muzzleLight.intensity, 0, 30, dt);
  }

  private startReload(): void {
    if (this.reloadTimer > 0 || this.mag >= MAG_SIZE || this.reserve <= 0) return;
    this.reloadTimer = RELOAD_TIME;
    this.hooks.sfx.reload();
    this.hooks.onAmmo(this.mag, this.reserve, true);
  }

  private finishReload(): void {
    const need = MAG_SIZE - this.mag;
    const take = Math.min(need, this.reserve);
    this.mag += take;
    this.reserve -= take;
    this.reloadTimer = 0;
    this.hooks.onAmmo(this.mag, this.reserve, false);
  }

  /** Back to a neutral hip pose (new round / respawn): no carried-over ADS, kick or flash. */
  resetPose(): void {
    this.ads = 0;
    this.kick = 0;
    this.recoil.pitch = this.recoil.yaw = 0;
    this.muzzleFlash.hide();
    this.muzzleLight.intensity = 0;
    this.viewmodel.update(0, 0, 0, -1);
  }

  /** Fire a single shot immediately, ignoring cooldown/ammo (QA harness only). */
  fireOnce(): void {
    this.fire();
  }

  private fire(): void {
    this.hooks.sfx.gunshot(); // player's weapon: centred

    // Ray from the camera centre (crosshair), excluding the player's own collider.
    this.camera.getWorldPosition(this._origin);
    this.camera.getWorldDirection(this._dir);

    const ray = new RAPIER.Ray(this._origin, this._dir);
    const hit = this.world.castRayAndGetNormal(
      ray,
      MAX_RANGE,
      true,
      undefined,
      undefined,
      this.playerCollider,
    );

    let endPoint: THREE.Vector3;
    if (hit) {
      const t = hit.timeOfImpact;
      this._hit.copy(this._origin).addScaledVector(this._dir, t);
      const target = this.hooks.registry.get(hit.collider.handle);
      if (target) {
        const headshot = this._hit.y >= target.headY();
        const dmg = BODY_DAMAGE * (headshot ? HEAD_MULT : 1);
        const killed = target.onHit(dmg, this._hit, headshot);
        this.hooks.impactFx(this._hit, this._dir, null);
        this.hooks.sfx.impact(this._hit, true);
        this.hooks.onHitmarker(headshot, killed);
      } else {
        this._normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        this.decals.spawn(this._hit, this._normal);
        this.hooks.impactFx(this._hit, this._dir, this._normal);
        this.hooks.sfx.impact(this._hit, false);
      }
      endPoint = this._hit;
    } else {
      endPoint = this._hit.copy(this._origin).addScaledVector(this._dir, MAX_RANGE);
    }

    this.viewmodel.muzzle.getWorldPosition(this._muzzleWorld);
    this.hooks.tracers.spawn(this._muzzleWorld, endPoint);
    this.hooks.muzzleFx(this._muzzleWorld, this._dir);

    this.muzzleFlash.fire();
    this.muzzleLight.intensity = 3;

    const steady = 1 - 0.4 * this.ads;
    this.recoil.pitch += 0.016 * steady;
    this.recoil.yaw += (Math.random() - 0.5) * 0.008 * steady;
    this.kick = Math.min(1, this.kick + 0.7);
  }
}
