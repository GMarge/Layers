import { useEffect, useRef } from 'react';
import type { Point } from './useSpringPosition';

interface Props {
  /** Where the right-click happened, in viewport pixels. */
  at: Point;
  /** What the menu is called for a screen reader: the agent's name. */
  name: string;
  items: { label: string; hint?: string; onChoose(): void }[];
  onClose(): void;
}

/** The menu a right-click on the agent opens: its branch map, today so far, and hiding it. */
export function AgentMenu({ at, name, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector('button')?.focus({ preventScroll: true });

    const onArrow = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      e.preventDefault();
      buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    };

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
    window.addEventListener('keydown', onArrow);
    window.addEventListener('blur', shut);
    window.addEventListener('resize', shut);
    window.addEventListener('scroll', shut, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onArrow);
      window.removeEventListener('blur', shut);
      window.removeEventListener('resize', shut);
      window.removeEventListener('scroll', shut, true);
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  // Opens at the pointer like any context menu, nudged to stay on screen.
  const left = Math.max(8, Math.min(at.x + 2, window.innerWidth - 200));
  const top = Math.max(8, Math.min(at.y + 2, window.innerHeight - 20 - items.length * 32));

  return (
    <div
      ref={ref}
      className="agent-menu"
      role="menu"
      aria-label={name}
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button key={item.label} type="button" role="menuitem" onClick={item.onChoose}>
          <span>{item.label}</span>
          {item.hint && <kbd aria-hidden="true">{item.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}
