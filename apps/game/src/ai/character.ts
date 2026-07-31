/**
 * Animated enemy character: one shared glTF template loaded once, cloned per enemy (skeleton +
 * meshes) via SkeletonUtils. Each instance owns an AnimationMixer with crossfading Idle /
 * Running / Death clips, driven by the enemy FSM.
 *
 * Currently uses three's CC0 "RobotExpressive" (Tomás Laulhé / Don McCurdy — see CREDITS.md) as
 * a reliable placeholder; swapping to a Quaternius CC0 soldier is a drop-in (same clip roles) —
 * QUALITY_BACKLOG.
 */
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

const TARGET_HEIGHT = 1.75; // metres, to match the capsule

let template: THREE.Object3D | null = null;
let clips: THREE.AnimationClip[] = [];
let scaleFactor = 1;

export async function loadCharacterTemplate(
  url = '/assets/models/RobotExpressive.glb',
): Promise<void> {
  const gltf = await new GLTFLoader().loadAsync(url);
  template = gltf.scene;
  clips = gltf.animations;
  const box = new THREE.Box3().setFromObject(template);
  const h = box.max.y - box.min.y;
  scaleFactor = h > 0 ? TARGET_HEIGHT / h : 1;
}

function findClip(...names: string[]): THREE.AnimationClip | null {
  for (const n of names) {
    const c = THREE.AnimationClip.findByName(clips, n);
    if (c) return c;
  }
  return null;
}

export type AnimState = 'idle' | 'run' | 'dead';

export class CharacterInstance {
  readonly root = new THREE.Group();
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions: Partial<Record<AnimState, THREE.AnimationAction>> = {};
  private current: AnimState | null = null;

  constructor() {
    if (!template) throw new Error('loadCharacterTemplate() must be awaited first');
    const model = cloneSkinned(template);
    model.scale.setScalar(scaleFactor);
    // Model origin is at the feet; enemy group origin is the capsule centre.
    model.position.y = -0.9;
    model.rotation.y = Math.PI; // RobotExpressive faces +Z; enemies face -Z at yaw 0
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.root.add(model);

    this.mixer = new THREE.AnimationMixer(model);
    const idle = findClip('Idle');
    const run = findClip('Running', 'Walking');
    const death = findClip('Death');
    if (idle) this.actions.idle = this.mixer.clipAction(idle);
    if (run) this.actions.run = this.mixer.clipAction(run);
    if (death) {
      const a = this.mixer.clipAction(death);
      a.loop = THREE.LoopOnce;
      a.clampWhenFinished = true;
      this.actions.dead = a;
    }
    this.play('idle');
  }

  play(state: AnimState): void {
    if (state === this.current) return;
    const next = this.actions[state];
    if (!next) return;
    const prev = this.current ? this.actions[this.current] : undefined;
    next.reset();
    next.enabled = true;
    if (state === 'dead') next.setEffectiveTimeScale(1).setEffectiveWeight(1);
    next.fadeIn(0.2);
    next.play();
    if (prev && prev !== next) prev.fadeOut(0.2);
    this.current = state;
  }

  update(dt: number): void {
    this.mixer.update(dt);
  }

  /** Stop + uncache the mixer. Does NOT dispose geometry/materials (shared with the template). */
  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
  }
}
