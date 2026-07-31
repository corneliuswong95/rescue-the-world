/**
 * M1 placeholder weapon: full-auto hitscan against the Rapier world, with the feel bits that
 * make a greybox fun to shoot — viewmodel kick, muzzle flash, pooled tracers, pooled impact
 * decals, and a view-recoil the player camera consumes. Not final art; this is the "crunchy to
 * shoot" bar from CLAUDE.md, kept cheap and fully pooled (no per-shot allocation).
 */
import * as THREE from 'three/webgpu';
import { RAPIER } from '../physics/world';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { DecalPool } from './decals';

const FIRE_INTERVAL = 0.086; // seconds between shots (~700 RPM)
const MAX_RANGE = 200;

export interface ViewRecoil {
  pitch: number;
  yaw: number;
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

/** Pooled hitscan tracers: thin fading beams from muzzle to impact. */
class Tracers {
  private readonly items: { mesh: THREE.Mesh; life: number }[] = [];
  private cursor = 0;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(scene: THREE.Scene, count = 24) {
    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6, 1, true);
    geo.translate(0, 0.5, 0); // origin at one end so we can scale length from the muzzle
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, this.mat.clone());
      m.visible = false;
      m.renderOrder = 3;
      scene.add(m);
      this.items.push({ mesh: m, life: 0 });
    }
  }

  private static readonly _dir = new THREE.Vector3();
  private static readonly _up = new THREE.Vector3(0, 1, 0);
  private static readonly _q = new THREE.Quaternion();

  spawn(from: THREE.Vector3, to: THREE.Vector3): void {
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    const dir = Tracers._dir.subVectors(to, from);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.multiplyScalar(1 / len);
    it.mesh.position.copy(from);
    it.mesh.quaternion.copy(Tracers._q.setFromUnitVectors(Tracers._up, dir));
    it.mesh.scale.set(1, len, 1);
    it.life = 1;
    it.mesh.visible = true;
    (it.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (it.life <= 0) continue;
      it.life -= dt / 0.05; // ~50 ms lifetime
      if (it.life <= 0) {
        it.mesh.visible = false;
        it.life = 0;
      } else {
        (it.mesh.material as THREE.MeshBasicMaterial).opacity = it.life * 0.9;
      }
    }
  }
}

export class RaycastWeapon {
  readonly recoil: ViewRecoil = { pitch: 0, yaw: 0 };

  private cooldown = 0;
  private readonly viewmodel = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private readonly muzzleFlash: THREE.Mesh;
  private flashTimer = 0;
  private kick = 0;
  private readonly tracers: Tracers;
  private readonly baseVmPos = new THREE.Vector3(0.17, -0.16, -0.62);

  // scratch
  private readonly _origin = new THREE.Vector3();
  private readonly _dir = new THREE.Vector3();
  private readonly _hit = new THREE.Vector3();
  private readonly _muzzleWorld = new THREE.Vector3();
  private readonly _normal = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly world: RAPIER_NS.World,
    private readonly decals: DecalPool,
    private readonly playerCollider: RAPIER_NS.Collider,
  ) {
    this.tracers = new Tracers(scene);
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

    // Muzzle at the tip of the barrel; the flash lives here.
    this.muzzle.position.set(0, 0.02, -0.52);
    this.viewmodel.add(this.muzzle);

    // Render the viewmodel after the world with a cleared depth feel: keep it small + near.
    this.viewmodel.traverse((o) => {
      o.renderOrder = 5;
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = false;
    });
  }

  update(dt: number, firePressed: number, fireHeld: boolean): void {
    this.cooldown -= dt;

    const wantsFire = fireHeld || firePressed > 0;
    if (wantsFire && this.cooldown <= 0) {
      this.fire();
      this.cooldown = FIRE_INTERVAL;
    }

    // Recover view-recoil and viewmodel kick (frame-rate independent).
    this.recoil.pitch = THREE.MathUtils.damp(this.recoil.pitch, 0, 9, dt);
    this.recoil.yaw = THREE.MathUtils.damp(this.recoil.yaw, 0, 9, dt);
    this.kick = THREE.MathUtils.damp(this.kick, 0, 14, dt);
    this.viewmodel.position.z = this.baseVmPos.z + this.kick * 0.05;
    this.viewmodel.rotation.x = this.kick * 0.18;

    // Muzzle flash decay.
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.muzzleFlash.visible = false;
    }

    this.tracers.update(dt);
  }

  /** Fire a single shot immediately, ignoring cooldown (used by the QA harness). */
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
      this._normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      this.decals.spawn(this._hit, this._normal);
      endPoint = this._hit;
    } else {
      endPoint = this._hit.copy(this._origin).addScaledVector(this._dir, MAX_RANGE);
    }

    // Tracer from muzzle to impact.
    this.muzzle.getWorldPosition(this._muzzleWorld);
    this.tracers.spawn(this._muzzleWorld, endPoint);

    // Muzzle flash.
    this.muzzleFlash.visible = true;
    this.muzzleFlash.rotation.z = Math.random() * Math.PI;
    const s = 0.8 + Math.random() * 0.5;
    this.muzzleFlash.scale.setScalar(s);
    this.flashTimer = 0.04;

    // View recoil + viewmodel kick.
    this.recoil.pitch += 0.016;
    this.recoil.yaw += (Math.random() - 0.5) * 0.008;
    this.kick = Math.min(1, this.kick + 0.7);
  }
}
