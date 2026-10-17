/**
 * Pooled hitscan tracers drawn as travelling streaks: a short, HDR-bright bolt that flies from
 * the muzzle to the impact at a visible (slowed) speed — reads like real tracer fire instead of
 * an instant full-length laser line. Each streak is two crossed soft-edged ribbons whose
 * brightness tapers from a hot head to a transparent tail, so it reads from any angle.
 * Shared by the player weapon and enemy fire. Ring-buffer pool, no per-shot/per-frame allocation.
 */
import * as THREE from 'three/webgpu';
import { float, uv, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SPEED = 380; // m/s — well below real muzzle velocity so the eye can track it
const STREAK = 3.2; // m

interface Tracer {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  length: number; // muzzle → impact distance
  head: number; // distance travelled by the bolt's head; < 0 = inactive
}

export class Tracers {
  private readonly items: Tracer[] = [];
  private cursor = 0;
  private shots = 0;

  private static readonly _up = new THREE.Vector3(0, 1, 0);

  /**
   * @param every draw a tracer for one shot in `every` (real belts/mags load every 3rd–5th round)
   */
  constructor(
    scene: THREE.Scene,
    count = 32,
    color: THREE.ColorRepresentation = 0xffd27a,
    hdr = 5,
    private readonly every = 1,
    /** Metres of the path near the muzzle never drawn (the player's own tracers start ahead of
     * the viewmodel, or a world-space stub hangs beside the gun once it kicks/moves). */
    private readonly minTail = 0,
  ) {
    // Two crossed ribbons, origin at the tail → scale.y is the visible length.
    const a = new THREE.PlaneGeometry(0.03, 1).translate(0, 0.5, 0);
    const b = a.clone().rotateY(Math.PI / 2);
    const geo = mergeGeometries([a, b]);
    a.dispose();
    b.dispose();
    const c = new THREE.Color(color);
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const along = uv().y; // 0 tail → 1 head
    const across = float(1).sub(uv().x.sub(0.5).abs().mul(2)); // soft ribbon edges
    mat.colorNode = vec3(c.r, c.g, c.b).mul(hdr).mul(along.pow(1.6)).mul(across.pow(1.5));
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 3;
      m.frustumCulled = false;
      scene.add(m);
      this.items.push({ mesh: m, from: new THREE.Vector3(), dir: new THREE.Vector3(), length: 0, head: -1 });
    }
  }

  spawn(from: THREE.Vector3, to: THREE.Vector3): void {
    if (this.shots++ % this.every !== 0) return;
    const it = this.items[this.cursor];
    this.cursor = (this.cursor + 1) % this.items.length;
    it.dir.subVectors(to, from);
    it.length = it.dir.length();
    if (it.length < 1e-3) return;
    it.dir.multiplyScalar(1 / it.length);
    it.from.copy(from);
    it.head = 0;
    it.mesh.quaternion.setFromUnitVectors(Tracers._up, it.dir);
    this.place(it);
  }

  clear(): void {
    for (const it of this.items) {
      it.head = -1;
      it.mesh.visible = false;
    }
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (it.head < 0) continue;
      it.head += SPEED * dt;
      if (it.head - STREAK >= it.length) {
        it.head = -1;
        it.mesh.visible = false;
      } else {
        this.place(it);
      }
    }
  }

  private place(it: Tracer): void {
    const head = Math.min(it.head + 0.6, it.length); // a short lead so frame 0 is visible
    const tail = Math.max(this.minTail, it.head - STREAK);
    const len = head - tail;
    it.mesh.visible = len > 1e-3;
    it.mesh.position.copy(it.from).addScaledVector(it.dir, tail);
    it.mesh.scale.set(1, len, 1);
  }
}
