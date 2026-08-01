/**
 * Original stylized military soldier, authored in code (no ripped/mocap assets — CS/CoD are
 * *look* references only, per rule 3). A segmented rig (pelvis → torso → head/arms, hips → legs)
 * animated procedurally: idle breathing, a tactical-carry run cycle, and a death collapse. Holds
 * the authored rifle. Same interface the enemy expects: root / play / update / dispose, plus a
 * muzzle anchor for flashes and tracers. Archetype config tints + scales it for enemy types.
 */
import * as THREE from 'three/webgpu';
import { createRifle } from '../weapons/rifle';
import { mergeStaticByMaterial } from '../engine/merge';

export type AnimState = 'idle' | 'run' | 'dead';

export interface SoldierConfig {
  uniform: number;
  vest: number;
  helmet: number;
  scale: number;
}

const SKIN = new THREE.MeshStandardMaterial({ color: 0xa8815e, roughness: 0.75 });
const GEAR = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.6, metalness: 0.1 });

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class Soldier {
  readonly root = new THREE.Group();
  readonly muzzleAnchor = new THREE.Object3D();

  private readonly model = new THREE.Group();
  private readonly torso = new THREE.Group(); // pivot at pelvis
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly kneeL = new THREE.Group();
  private readonly kneeR = new THREE.Group();
  private readonly ownMat: THREE.Material[] = []; // per-soldier tinted materials

  private state: AnimState = 'idle';
  private phase = 0;
  private deathT = 0;

  constructor(cfg: SoldierConfig) {
    const uniform = this.mat(cfg.uniform, 0.85, 0.02);
    const vest = this.mat(cfg.vest, 0.55, 0.12);
    const helmet = this.mat(cfg.helmet, 0.6, 0.05);

    // Legs (pivot at hip y≈0.9).
    for (const [leg, knee, sx] of [
      [this.legL, this.kneeL, -0.11] as const,
      [this.legR, this.kneeR, 0.11] as const,
    ]) {
      leg.position.set(sx, 0.9, 0);
      leg.add(box(0.14, 0.44, 0.16, uniform, 0, -0.22, 0)); // thigh
      knee.position.set(0, -0.44, 0);
      knee.add(box(0.12, 0.42, 0.15, uniform, 0, -0.21, 0)); // shin
      knee.add(box(0.14, 0.1, 0.24, GEAR, 0, -0.44, -0.04)); // boot
      leg.add(knee);
      this.model.add(leg);
    }

    // Torso pivot at pelvis.
    this.torso.position.set(0, 0.9, 0);
    this.torso.add(box(0.34, 0.16, 0.2, uniform, 0, 0.06, 0)); // pelvis
    this.torso.add(box(0.4, 0.4, 0.24, uniform, 0, 0.34, 0)); // chest
    this.torso.add(box(0.42, 0.34, 0.26, vest, 0, 0.34, 0.005)); // plate carrier
    this.torso.add(box(0.16, 0.1, 0.12, GEAR, 0.14, 0.2, 0.14)); // side pouch
    // Shoulders + arms (holding the rifle in a tactical carry).
    this.torso.add(box(0.13, 0.34, 0.14, uniform, -0.26, 0.36, 0.02)); // left upper arm
    this.torso.add(box(0.12, 0.26, 0.12, uniform, -0.2, 0.16, -0.16)); // left forearm fwd
    this.torso.add(box(0.1, 0.1, 0.1, GEAR, -0.16, 0.08, -0.26)); // left glove on handguard
    this.torso.add(box(0.13, 0.34, 0.14, uniform, 0.26, 0.36, 0.02)); // right upper arm
    this.torso.add(box(0.12, 0.24, 0.12, uniform, 0.2, 0.18, -0.02)); // right forearm
    this.torso.add(box(0.1, 0.1, 0.1, GEAR, 0.14, 0.1, -0.08)); // right glove on grip
    // Head + helmet.
    this.torso.add(box(0.19, 0.2, 0.2, SKIN, 0, 0.66, 0.01)); // head
    this.torso.add(box(0.23, 0.14, 0.24, helmet, 0, 0.74, 0)); // helmet
    this.torso.add(box(0.24, 0.05, 0.02, GEAR, 0, 0.72, 0.12)); // NVG mount / brim

    // Rifle held at chest, barrel forward (-Z).
    const rifle = createRifle();
    rifle.group.position.set(0.02, 0.16, -0.14);
    this.muzzleAnchor.position.copy(rifle.muzzle);
    rifle.group.add(this.muzzleAnchor);
    mergeStaticByMaterial(this.torso); // ~13 body parts → ~5 draws; rifle group left intact
    this.torso.add(rifle.group);

    this.model.add(this.torso);
    this.model.position.y = -0.9; // feet at the capsule bottom
    this.model.scale.setScalar(cfg.scale);
    this.root.add(this.model);
  }

  private mat(color: number, roughness: number, metalness: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    this.ownMat.push(m);
    return m;
  }

  play(state: AnimState): void {
    if (state === this.state) return;
    if (state === 'dead') this.deathT = 0;
    this.state = state;
  }

  update(dt: number): void {
    if (this.state === 'dead') {
      this.deathT = Math.min(1, this.deathT + dt / 0.7);
      const t = this.deathT;
      const e = t * t * (3 - 2 * t); // smoothstep
      // Crumple forward and to the side — reads as a collapse, not a stiff fall.
      this.model.rotation.x = e * 1.45;
      this.model.rotation.z = e * 0.35;
      this.model.position.y = -0.9 - e * 0.12;
      this.torso.rotation.x = 0.2 + e * 0.5; // slump the upper body
      this.kneeL.rotation.x = e * 1.2;
      this.kneeR.rotation.x = e * 0.8;
      return;
    }

    if (this.state === 'run') {
      this.phase += dt * 9;
      const s = Math.sin(this.phase);
      this.legL.rotation.x = s * 0.7;
      this.legR.rotation.x = -s * 0.7;
      this.kneeL.rotation.x = Math.max(0, -s) * 1.1;
      this.kneeR.rotation.x = Math.max(0, s) * 1.1;
      this.model.position.y = -0.9 + Math.abs(Math.sin(this.phase)) * 0.04;
      this.torso.rotation.x = 0.14; // lean into the run
    } else {
      // Idle: gentle breathing + settle limbs.
      this.phase += dt * 1.6;
      const b = Math.sin(this.phase) * 0.02;
      this.model.position.y = -0.9 + b;
      this.torso.rotation.x = 0.02 + b;
      this.legL.rotation.x *= 1 - Math.min(1, dt * 8);
      this.legR.rotation.x *= 1 - Math.min(1, dt * 8);
      this.kneeL.rotation.x *= 1 - Math.min(1, dt * 8);
      this.kneeR.rotation.x *= 1 - Math.min(1, dt * 8);
    }
  }

  dispose(): void {
    // Geometries are all per-instance → safe to dispose. Materials: only the per-soldier
    // tinted ones (uniform/vest/helmet); SKIN/GEAR and the rifle materials are shared.
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const mat of this.ownMat) mat.dispose();
  }
}
