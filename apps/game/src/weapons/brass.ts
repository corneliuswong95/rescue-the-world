/**
 * Spent 5.56 casings: a fixed pool of instances in ONE InstancedMesh (one draw call).
 * Each casing is thrown from the ejection port back-right with spin, falls under gravity,
 * bounces once off a horizontal ground plane, settles, then shrinks away after ~2 s.
 * Simulation state lives in typed arrays; `update` allocates nothing.
 */
import * as THREE from 'three/webgpu';

const COUNT = 30;
const GRAVITY = 9.81;
const LIFE = 2.2; // seconds until gone
const FADE = 0.35; // final shrink-out
const SPEED = 4;
const NEAR_CULL = 0.38; // m from the eye

/** Bottleneck case: rim, body, shoulder, neck — ~45 mm long, ~9.6 mm across. */
function caseGeometry(): THREE.BufferGeometry {
  const pts = [
    [0.0, -0.0225],
    [0.0047, -0.0225],
    [0.0047, -0.0212],
    [0.0041, -0.0205],
    [0.0047, -0.0195],
    [0.0048, 0.0105],
    [0.0032, 0.0145],
    [0.0031, 0.0225],
    [0.0, 0.0225],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 10);
  g.rotateX(Math.PI / 2); // case axis along z
  return g;
}

export class BrassPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly vel = new Float32Array(COUNT * 3);
  private readonly spin = new Float32Array(COUNT * 3);
  private readonly rot = new Float32Array(COUNT * 3);
  private readonly age = new Float32Array(COUNT).fill(LIFE);
  private readonly bounced = new Uint8Array(COUNT);
  private next = 0;

  private readonly _m = new THREE.Matrix4();
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _s = new THREE.Vector3();

  constructor() {
    // Fired brass is tarnished, not mirror-bright.
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xa8854f, metalness: 0.8, roughness: 0.45 });
    this.mesh = new THREE.InstancedMesh(caseGeometry(), mat, COUNT);
    this.mesh.frustumCulled = false; // instances span the play space; bounds aren't tracked
    this.mesh.castShadow = false;
    this.mesh.name = 'brass';
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < COUNT; i++) this.mesh.setMatrixAt(i, this._m);
  }

  /**
   * Ejects a casing at world `port`, thrown along world `dir` (unit), recycling the oldest.
   */
  eject(port: THREE.Vector3, dir: THREE.Vector3, speedScale = 1): void {
    const i = this.next;
    this.next = (i + 1) % COUNT;
    const s = SPEED * speedScale * (0.85 + Math.random() * 0.3);
    this.pos[i * 3] = port.x;
    this.pos[i * 3 + 1] = port.y;
    this.pos[i * 3 + 2] = port.z;
    this.vel[i * 3] = dir.x * s;
    this.vel[i * 3 + 1] = dir.y * s;
    this.vel[i * 3 + 2] = dir.z * s;
    this.spin[i * 3] = (Math.random() - 0.5) * 40;
    this.spin[i * 3 + 1] = (Math.random() - 0.5) * 60;
    this.spin[i * 3 + 2] = (Math.random() - 0.5) * 20;
    this.rot[i * 3] = this.rot[i * 3 + 1] = this.rot[i * 3 + 2] = 0;
    this.age[i] = 0;
    this.bounced[i] = 0;
  }

  /**
   * Integrates every live casing against a horizontal ground plane at `groundY`. Casings within
   * NEAR_CULL of `eye` are hidden: at that range they'd fill the sight picture.
   */
  update(dt: number, groundY: number, eye: THREE.Vector3): void {
    if (dt <= 0) return;
    let dirty = false;
    for (let i = 0; i < COUNT; i++) {
      if (this.age[i] >= LIFE) continue;
      dirty = true;
      this.age[i] += dt;
      const k = i * 3;
      const resting = this.bounced[i] === 2;
      if (!resting) {
        this.vel[k + 1] -= GRAVITY * dt;
        this.pos[k] += this.vel[k] * dt;
        this.pos[k + 1] += this.vel[k + 1] * dt;
        this.pos[k + 2] += this.vel[k + 2] * dt;
        this.rot[k] += this.spin[k] * dt;
        this.rot[k + 1] += this.spin[k + 1] * dt;
        this.rot[k + 2] += this.spin[k + 2] * dt;
        const floor = groundY + 0.0048;
        if (this.pos[k + 1] < floor) {
          this.pos[k + 1] = floor;
          if (this.bounced[i] === 0) {
            // One lively bounce, then it lies on its side.
            this.vel[k] *= 0.45;
            this.vel[k + 1] = -this.vel[k + 1] * 0.32;
            this.vel[k + 2] *= 0.45;
            this.spin[k] *= 0.4;
            this.spin[k + 1] *= 0.4;
            this.spin[k + 2] *= 0.4;
            this.bounced[i] = 1;
          } else {
            this.rot[k] = 0; // lies with its axis horizontal, keeping its heading
            this.rot[k + 2] = 0;
            this.bounced[i] = 2;
          }
        }
      }
      this._p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      const near = this._p.distanceToSquared(eye) < NEAR_CULL * NEAR_CULL;
      const shrink = near ? 0 : THREE.MathUtils.clamp((LIFE - this.age[i]) / FADE, 0, 1);
      this._q.setFromEuler(this._e.set(this.rot[k], this.rot[k + 1], this.rot[k + 2]));
      this._s.setScalar(shrink);
      this._m.compose(this._p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this._m.makeScale(0, 0, 0);
    for (let i = 0; i < COUNT; i++) {
      this.age[i] = LIFE;
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
