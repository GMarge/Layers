import { useEffect, useRef } from 'react';

export interface ToastState {
  id: number;
  text: string;
}

export function Toast({ toast, onClose }: { toast: ToastState | null; onClose: () => void }) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => close.current(), 5200);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.id}>
      {toast.text}
    </div>
  );
}
