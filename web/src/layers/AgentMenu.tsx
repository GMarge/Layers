import { useEffect, useRef } from 'react';
import type { Point } from './useSpringPosition';

interface Props {
  /** Where the right-click happened, in viewport pixels. */
  at: Point;
  label: string;
  onChoose(): void;
  onClose(): void;
}

/** The one-line menu a right-click on the agent opens: hide him, or bring him back. */
export function AgentMenu({ at, label, onChoose, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector('button')?.focus({ preventScroll: true });

    const onDown = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape closes only the menu, not whatever the agent was saying behind it.
      e.stopImmediatePropagation();
      close.current();
    };
    const shut = () => close.current();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', shut);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', shut);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // Opens at the pointer like any context menu, nudged to stay on screen.
  const left = Math.max(8, Math.min(at.x + 2, window.innerWidth - 200));
  const top = Math.max(8, Math.min(at.y + 2, window.innerHeight - 52));

  return (
    <div
      ref={ref}
      className="agent-menu"
      role="menu"
      aria-label="Layers"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" onClick={onChoose}>
        <span>{label}</span>
        <kbd aria-hidden="true">Alt L</kbd>
      </button>
    </div>
  );
}
