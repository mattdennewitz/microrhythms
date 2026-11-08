/* The few things the core needs from the UI layer. The UI registers itself
 * at boot; until then the defaults keep the core usable on its own. */
import type { StackSnapshot } from './stack';

export interface UiBridge {
  /** Width in CSS px of the side panel covering the stage (0 when hidden). */
  panelWidth(): number;
  /** Keep slots 1–4 and which one is playing. */
  slots: Array<StackSnapshot | null>;
  activeSlot: number | null;
  togglePlay(): void | Promise<void>;
  toggleFlight(): void;
  syncAutopilot(): void;
  /** Refresh every control from state (after opening a project). */
  syncAll(): void;
}

const fallback: UiBridge = {
  panelWidth: () => 0,
  slots: [null, null, null, null],
  activeSlot: null,
  togglePlay() {},
  toggleFlight() {},
  syncAutopilot() {},
  syncAll() {},
};

/** Live binding: modules that import `ui` see whatever was registered last. */
export let ui: UiBridge = fallback;
export function registerUi(impl: UiBridge) { ui = impl; }
