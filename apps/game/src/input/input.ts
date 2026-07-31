/**
 * Input: keyboard state + Pointer-Lock mouse-look with sub-frame delta accumulation.
 *
 * Mouse deltas accumulate as they arrive (Pointer Lock can deliver several `mousemove`s per
 * animation frame) and are drained once per frame by the player — this is the "sub-frame input
 * sampling" the quality bar asks for. Look stays responsive because it is consumed every render
 * frame, not gated on the fixed sim step.
 */
export interface FrameInput {
  /** Accumulated mouse delta since the last drain, in raw pixels. */
  lookX: number;
  lookY: number;
  /** Fire events (mousedown) that occurred since the last drain. */
  firePressed: number;
  fireHeld: boolean;
}

export class Input {
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private firePressed = 0;
  private fireHeld = false;
  private locked = false;

  constructor(canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      // Don't trap browser shortcuts (e.g. Cmd/Ctrl+R) — only swallow when locked.
      this.keys.add(e.code);
      if (this.locked && MOVEMENT_CODES.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) {
        canvas.requestPointerLock();
        return;
      }
      if (e.button === 0) {
        this.firePressed += 1;
        this.fireHeld = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.keys.clear();
        this.fireHeld = false;
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
  }

  get isLocked(): boolean {
    return this.locked;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Read and reset the per-frame accumulated input. */
  drain(): FrameInput {
    const out: FrameInput = {
      lookX: this.lookX,
      lookY: this.lookY,
      firePressed: this.firePressed,
      fireHeld: this.fireHeld,
    };
    this.lookX = 0;
    this.lookY = 0;
    this.firePressed = 0;
    return out;
  }
}

const MOVEMENT_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'Space',
  'ShiftLeft',
  'ControlLeft',
  'KeyC',
]);
