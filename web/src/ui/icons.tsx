const stroke = { stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

export const Check = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 5.3 4.1 7.4 8 3" strokeWidth="1.7" {...stroke} />
  </svg>
);

export const ArrowUp = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2" strokeWidth="1.8" {...stroke} />
  </svg>
);

export const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="m3 4.5 3 3 3-3" strokeWidth="1.6" {...stroke} />
  </svg>
);

export const Close = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 3l6 6M9 3l-6 6" strokeWidth="1.6" {...stroke} />
  </svg>
);
