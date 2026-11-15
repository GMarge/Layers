export type GlowMode = 'ambient' | 'checking' | 'unsure' | 'policy' | 'knowledge' | 'working' | 'done';
export type EdgeStyle = 'glow' | 'stack';

/**
 * The perimeter of the screen. `glow` is soft light in the logo's colours with a
 * thin ring; `stack` adds the logo's flat offset bands along the left and bottom.
 * Purely visual: it never takes pointer events.
 */
export function EdgeGlow({ mode, variant, quiet }: { mode: GlowMode; variant: EdgeStyle; quiet: boolean }) {
  return (
    <div className="edge" data-mode={mode} data-variant={variant} data-quiet={quiet ? '' : undefined} aria-hidden="true">
      <i className="edge__bloom edge__bloom--a" />
      <i className="edge__bloom edge__bloom--b" />
      <i className="edge__ring" />
      <i className="edge__stack" />
      <i className="edge__sweep edge__sweep--soft" />
      <i className="edge__sweep" />
    </div>
  );
}
