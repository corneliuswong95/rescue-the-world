/**
 * Placeholder full-auto hitscan weapon. Feel bits: viewmodel kick, muzzle flash, shared pooled
 * tracers, view-recoil the player camera consumes. Combat: magazine + reserve ammo with reload,
 * damage routed through the HitRegistry (headshot multiplier), hitmarker + blood callbacks.
 * Fully pooled — no per-shot allocation.
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { DecalPool } from './decals';
import type { Tracers } from '../vfx/tracers';
import type { HitRegistry } from '../combat/hittable';

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
  /** Spawn a blood burst at an enemy hit. */
  blood: (point: THREE.Vector3, dir: THREE.Vector3) => void;
  /** Player landed a hit on something damageable. */
  onHitmarker: (headshot: boolean, killed: boolean) => void;
  /** Ammo changed (mag, reserve, reloading). */
  onAmmo: (mag: number, reserve: number, reloading: boolean) => void;
}

function makeFlashTexture(): THREE.CanvasTexture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,250,230,1)');
  g.addColorStop(0.3, 'rgba(255,200,90,0.9)');
  g.addColorStop(0.7, 'rgba(255,120,30,0.3)');
  g.addColorStop(1, 'rgba(255,80,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class RaycastWeapon {
  readonly recoil: ViewRecoil = { pitch: 0, yaw: 0 };

  private mag = MAG_SIZE;
  private reserve = START_RESERVE;
  private reloadTimer = 0;
  private cooldown = 0;
  private prevReload = false;

  private readonly viewmodel = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private readonly muzzleFlash: THREE.Mesh;
  private flashTimer = 0;
  private kick = 0;
  private readonly baseVmPos = new THREE.Vector3(0.17, -0.16, -0.62);

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
    this.buildViewmodel();
    this.camera.add(this.viewmodel);

    const flashMat = new THREE.MeshBasicMaterial({
      map: makeFlashTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.muzzleFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.35), flashMat);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.renderOrder = 4;
    this.muzzle.add(this.muzzleFlash);

    this.hooks.onAmmo(this.mag, this.reserve, false);
  }

  private buildViewmodel(): void {
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x565d66, roughness: 0.5, metalness: 0.55 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x34383f, roughness: 0.4, metalness: 0.7 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.11, 0.4), gunMat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.32), accent);
    barrel.position.set(0, 0.02, -0.34);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.16, 0.08), accent);
    grip.position.set(0, -0.11, 0.08);
    grip.rotation.x = 0.25;
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.09), accent);
    mag.position.set(0, -0.12, -0.05);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 0.1), accent);
    sight.position.set(0, 0.08, -0.05);

    this.viewmodel.add(body, barrel, grip, mag, sight);
    this.viewmodel.scale.setScalar(0.85);
    this.viewmodel.position.copy(this.baseVmPos);

    this.muzzle.position.set(0, 0.02, -0.52);
    this.viewmodel.add(this.muzzle);

    this.viewmodel.traverse((o) => {
      o.renderOrder = 5;
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
    });
  }

  update(dt: number, firePressed: number, fireHeld: boolean, reloadHeld: boolean): void {
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

    this.recoil.pitch = THREE.MathUtils.damp(this.recoil.pitch, 0, 9, dt);
    this.recoil.yaw = THREE.MathUtils.damp(this.recoil.yaw, 0, 9, dt);
    this.kick = THREE.MathUtils.damp(this.kick, 0, 14, dt);
    this.viewmodel.position.z = this.baseVmPos.z + this.kick * 0.05;
    this.viewmodel.rotation.x = this.kick * 0.18;

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.muzzleFlash.visible = false;
    }
  }

  private startReload(): void {
    if (this.reloadTimer > 0 || this.mag >= MAG_SIZE || this.reserve <= 0) return;
    this.reloadTimer = RELOAD_TIME;
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

  /** Fire a single shot immediately, ignoring cooldown/ammo (QA harness only). */
  fireOnce(): void {
    this.fire();
  }

  private fire(): void {
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
        this.hooks.blood(this._hit, this._dir);
        this.hooks.onHitmarker(headshot, killed);
      } else {
        this._normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        this.decals.spawn(this._hit, this._normal);
      }
      endPoint = this._hit;
    } else {
      endPoint = this._hit.copy(this._origin).addScaledVector(this._dir, MAX_RANGE);
    }

    this.muzzle.getWorldPosition(this._muzzleWorld);
    this.hooks.tracers.spawn(this._muzzleWorld, endPoint);

    this.muzzleFlash.visible = true;
    this.muzzleFlash.rotation.z = Math.random() * Math.PI;
    this.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.5);
    this.flashTimer = 0.04;

    this.recoil.pitch += 0.016;
    this.recoil.yaw += (Math.random() - 0.5) * 0.008;
    this.kick = Math.min(1, this.kick + 0.7);
  }
}
