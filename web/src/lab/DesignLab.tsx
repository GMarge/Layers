import type { BackendStatus } from '../layers/apiService';
import type { EdgeStyle } from '../layers/EdgeGlow';
import type { Shape } from '../layers/Mascot';
import type { Placement, PolicyMode, RestMode, UnsureMode } from '../layers/types';
import { Chevron } from '../ui/icons';

/**
 * Prototype controls for reviewing the interface. Not part of the product:
 * press L to hide it, and it comes out before the final demo.
 */

export type LabScene = 'rest' | 'ask' | 'policy' | 'unsure' | 'knowledge' | 'working' | 'result' | 'settings';
export type GlowLevel = 'soft' | 'standard' | 'bold';
export type EyeStyle = 'oval' | 'dot' | 'wide';
export type OutlineStyle = 'layers' | 'blue';
export type LayoutStyle = 'sidebar' | 'focus';

export interface LabSettings {
  open: boolean;
  policyMode: PolicyMode;
  unsureMode: UnsureMode;
  placement: Placement;
  shape: Shape;
  eyes: EyeStyle;
  rest: RestMode;
  outline: OutlineStyle;
  edge: EdgeStyle;
  glow: GlowLevel;
  layout: LayoutStyle;
  reduceMotion: boolean;
}

export const defaultLab: LabSettings = {
  open: true,
  policyMode: 'approval',
  unsureMode: 'ask',
  placement: 'right',
  shape: 'drop',
  eyes: 'oval',
  rest: 'absorbed',
  outline: 'layers',
  edge: 'glow',
  glow: 'standard',
  layout: 'sidebar',
  reduceMotion: false,
};

const SCENES: [LabScene, string][] = [
  ['rest', 'Resting'],
  ['ask', 'Ask Layers'],
  ['policy', 'Policy gate'],
  ['unsure', 'Not sure'],
  ['knowledge', 'Team knowledge'],
  ['working', 'Agent working'],
  ['result', 'Result'],
  ['settings', 'Settings'],
];

function Seg<T extends string>(props: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="lab__row">
      <span className="lab__label">{props.label}</span>
      <div className="lab__seg" data-wrap={props.options.length > 3 ? '' : undefined} role="group" aria-label={props.label}>
        {props.options.map(([value, text]) => (
          <button key={value} type="button" aria-pressed={value === props.value} onClick={() => props.onChange(value)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  settings: LabSettings;
  floating: boolean;
  /** Null when the Layers server is not running and the scripted stand-in is in use. */
  backend: BackendStatus | null;
  awaitingManager: boolean;
  onChange: (next: LabSettings) => void;
  onScene: (scene: LabScene) => void;
  onDecide: (approved: boolean) => void;
}

export function DesignLab({ settings: s, floating, backend, awaitingManager, onChange, onScene, onDecide }: Props) {
  const set = <K extends keyof LabSettings>(key: K, value: LabSettings[K]) => onChange({ ...s, [key]: value });

  return (
    <section className={floating ? 'lab lab--floating' : 'lab'} aria-label="Design lab">
      <button type="button" className="lab__toggle" aria-expanded={s.open} onClick={() => set('open', !s.open)}>
        <span>Design lab</span>
        <kbd>L</kbd>
        <Chevron />
      </button>

      {s.open && (
        <div className="lab__body">
          <p className="lab__note">
            {!backend
              ? 'Scripted preview. The Layers server is not running.'
              : backend.agent
                ? `Live. DeepAgent on ${backend.model}.`
                : backend.model
                  ? 'Live server, but the model failed to load. Rules only.'
                  : 'Live server, rules only. No model key is set yet.'}
          </p>

          {backend && (
            <a className="lab__link" href="#manager" target="_blank" rel="noreferrer">
              Open the manager's view
            </a>
          )}

          <div className="lab__scenes">
            {SCENES.map(([scene, text]) => (
              <button key={scene} type="button" onClick={() => onScene(scene)}>
                {text}
              </button>
            ))}
          </div>

          {awaitingManager && (
            <div className="lab__row">
              <span className="lab__label">Manager</span>
              <div className="lab__seg" role="group" aria-label="Manager decision">
                <button type="button" onClick={() => onDecide(true)}>
                  Approve
                </button>
                <button type="button" onClick={() => onDecide(false)}>
                  Decline
                </button>
              </div>
            </div>
          )}

          <Seg
            label="Mascot"
            value={s.shape}
            options={[
              ['drop', 'Drop'],
              ['ghost', 'Ghost'],
              ['bean', 'Bean'],
              ['sheet', 'Sheet'],
              ['tile', 'Tile'],
            ]}
            onChange={(v) => set('shape', v)}
          />
          <Seg
            label="Eyes"
            value={s.eyes}
            options={[
              ['oval', 'Oval'],
              ['dot', 'Dot'],
              ['wide', 'Wide'],
            ]}
            onChange={(v) => set('eyes', v)}
          />
          <Seg
            label="Rests"
            value={s.rest}
            options={[
              ['absorbed', 'In box'],
              ['floating', 'Float'],
              ['hidden', 'Hidden'],
            ]}
            onChange={(v) => set('rest', v)}
          />
          <Seg
            label="Outline"
            value={s.outline}
            options={[
              ['layers', 'Layers'],
              ['blue', 'Blue'],
            ]}
            onChange={(v) => set('outline', v)}
          />
          <Seg
            label="Bubble"
            value={s.placement}
            options={[
              ['right', 'Side'],
              ['above', 'Above'],
            ]}
            onChange={(v) => set('placement', v)}
          />
          <Seg
            label="Edge"
            value={s.edge}
            options={[
              ['glow', 'Glow'],
              ['stack', 'Stack'],
            ]}
            onChange={(v) => set('edge', v)}
          />
          <Seg
            label="Strength"
            value={s.glow}
            options={[
              ['soft', 'Soft'],
              ['standard', 'Mid'],
              ['bold', 'Bold'],
            ]}
            onChange={(v) => set('glow', v)}
          />
          <Seg
            label="Layout"
            value={s.layout}
            options={[
              ['sidebar', 'Sidebar'],
              ['focus', 'Focus'],
            ]}
            onChange={(v) => set('layout', v)}
          />
          <Seg
            label="Policy"
            value={s.policyMode}
            options={[
              ['approval', 'Ask first'],
              ['warn', 'Warn'],
            ]}
            onChange={(v) => set('policyMode', v)}
          />
          <Seg
            label="Unsure"
            value={s.unsureMode}
            options={[
              ['ask', 'Ask me'],
              ['allow', 'Allow'],
              ['defer', 'Defer'],
            ]}
            onChange={(v) => set('unsureMode', v)}
          />
          <Seg
            label="Motion"
            value={s.reduceMotion ? 'reduced' : 'full'}
            options={[
              ['full', 'Full'],
              ['reduced', 'Reduced'],
            ]}
            onChange={(v) => set('reduceMotion', v === 'reduced')}
          />
        </div>
      )}
    </section>
  );
}
