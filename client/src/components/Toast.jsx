import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CheckCircleIcon,
  InfoIcon,
  XIcon,
} from './icons.jsx';

const ToastContext = createContext(null);

const TONE_ICON = {
  success: CheckCircleIcon,
  danger: AlertCircleIcon,
  warning: AlertTriangleIcon,
  info: InfoIcon,
};

const DURATION = { success: 4200, info: 4800, warning: 6000, danger: 8000 };

let nextId = 0;

/**
 * Toasts.
 *
 * Feedback that appears near the action that caused it, then leaves. The region
 * is a polite live area so a screen reader announces arrivals without
 * interrupting; `role="alert"` is used only for failures, which do merit an
 * interruption. Timers pause on hover and on keyboard focus, because a toast
 * that disappears while you are reading it is worse than no toast.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (tone, title, message) => {
      nextId += 1;
      const id = nextId;
      setToasts((current) => [...current.slice(-3), { id, tone, title, message }]);
      const timer = setTimeout(() => dismiss(id), DURATION[tone] ?? 5000);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  const pause = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  // Re-entering a toast gives it a short grace period rather than the full
  // duration again, so a user who hovers a stack does not keep it forever.
  const resume = useCallback(
    (id) => {
      if (timers.current.has(id)) return;
      const timer = setTimeout(() => dismiss(id), 1600);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  const api = useMemo(
    () => ({
      success: (title, message) => push('success', title, message),
      error: (title, message) => push('danger', title, message),
      warning: (title, message) => push('warning', title, message),
      info: (title, message) => push('info', title, message),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => {
          const ToneIcon = TONE_ICON[toast.tone] ?? InfoIcon;
          return (
            <div
              key={toast.id}
              className={`toast toast--${toast.tone}`}
              role={toast.tone === 'danger' ? 'alert' : 'status'}
              onMouseEnter={() => pause(toast.id)}
              onMouseLeave={() => resume(toast.id)}
              onFocus={() => pause(toast.id)}
              onBlur={() => resume(toast.id)}
            >
              <ToneIcon size={17} className="toast__icon" />
              <div className="toast__body">
                <p className="toast__title">{toast.title}</p>
                {toast.message ? <p className="toast__message">{toast.message}</p> : null}
              </div>
              <button
                type="button"
                className="btn btn--ghost btn--icon btn--sm"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
              >
                <XIcon size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}
