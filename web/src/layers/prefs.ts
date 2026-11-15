import type { EdgeStyle } from './EdgeGlow';
import type { Shape } from './Mascot';
import type { Placement, PolicyMode, RestMode, UnsureMode } from './types';

/**
 * Everything about the workspace that can be set: how the agent looks and behaves (the
 * employee's choices, made in its Settings) and the company's two rules (the manager's
 * choices, read from the server).
 */

export type GlowLevel = 'soft' | 'standard' | 'bold';
export type EyeStyle = 'oval' | 'dot' | 'wide';
export type OutlineStyle = 'layers' | 'blue';
export type LayoutStyle = 'sidebar' | 'focus';

export interface Settings {
  policyMode: PolicyMode;
  unsureMode: UnsureMode;
  /** When Layers notices a new direction: tell the employee, or branch quietly. */
  branchMode: 'ask' | 'auto';
  placement: Placement;
  shape: Shape;
  eyes: EyeStyle;
  rest: RestMode;
  outline: OutlineStyle;
  edge: EdgeStyle;
  glow: GlowLevel;
  layout: LayoutStyle;
  /** What the employee calls their agent. */
  name: string;
}

export const DEFAULT_NAME = 'Layers';
const NAME_KEY = 'layers.name';

/** The name is the employee's own choice, so it is remembered on their device. */
export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY)?.trim().slice(0, 16) || DEFAULT_NAME;
  } catch {
    return DEFAULT_NAME;
  }
}

export function saveName(name: string) {
  try {
    if (name === DEFAULT_NAME) localStorage.removeItem(NAME_KEY);
    else localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private windows can refuse storage. The name just won't be remembered.
  }
}

export const defaultSettings: Settings = {
  policyMode: 'approval',
  unsureMode: 'ask',
  branchMode: 'auto',
  placement: 'right',
  shape: 'drop',
  eyes: 'oval',
  rest: 'absorbed',
  outline: 'layers',
  edge: 'glow',
  glow: 'standard',
  layout: 'sidebar',
  name: DEFAULT_NAME,
};
