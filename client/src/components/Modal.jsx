import { useCallback, useEffect, useId, useRef } from 'react';
import { XIcon } from './icons.jsx';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog with a real focus contract:
 *
 *  - focus moves in on open (to the panel, or the first focusable child)
 *  - Tab and Shift+Tab cycle inside the panel and cannot escape to the page
 *  - Escape and a backdrop click close it
 *  - focus returns to whatever opened it, so keyboard users are not dumped at
 *    the top of the document
 *  - the page behind does not scroll
 *
 * Those five behaviours are the difference between a dialog and a div that looks
 * like one, and they are the ones most often skipped.
 *
 * Exported because a dialog is not the only layer that needs this contract — the
 * command palette is another. Its two extra needs are why this takes options:
 * `focusRef` for layers whose entry point is a specific control (the palette
 * input, not the first button in the panel), and `onEscape`, which lets a layer
 * consume Escape for itself — the palette clears its query on the first press and
 * only closes on the second. That hook must run at the document in the capture
 * phase to beat React's root listener, so Escape cannot be handled in a React
 * `onKeyDown` without it. Pass a `useCallback`, or the effect re-runs each render.
 */
export function useDialogBehavior({ open, onClose, panelRef, focusRef, onEscape }) {
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement;
    const panel = panelRef.current;
    const first = focusRef?.current ?? panel?.querySelector(FOCUSABLE);
    (first ?? panel)?.focus?.({ preventScroll: true });

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (onEscape?.() === true) return;
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const focusable = Array.from(panel.querySelectorAll(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus({ preventScroll: true });
    };
  }, [open, onClose, panelRef, focusRef, onEscape]);
}

export function Modal({ open, onClose, title, subtitle, children, footer, wide = false }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useDialogBehavior({ open, onClose, panelRef });

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className={`modal${wide ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="modal__header">
          <div style={{ minWidth: 0 }}>
            <h2 className="modal__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={onClose}
              aria-label="Close dialog"
            >
              <XIcon size={16} />
            </button>
          </div>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

/** A modal that arrives from the side — the right affordance for a record. */
export function Drawer({ open, onClose, title, subtitle, children, footer }) {
  const panelRef = useRef(null);
  const titleId = useId();
  useDialogBehavior({ open, onClose, panelRef });

  if (!open) return null;

  return (
    <div className="drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="drawer__header">
          <div style={{ minWidth: 0 }}>
            <h2 className="modal__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="card__subtitle">{subtitle}</p> : null}
          </div>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--ghost btn--icon"
              onClick={onClose}
              aria-label="Close panel"
            >
              <XIcon size={16} />
            </button>
          </div>
        </header>
        <div className="drawer__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </aside>
    </div>
  );
}

/** Confirm-before-destroy, so destructive admin actions are never one click. */
export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = 'Confirm', tone = 'danger', busy }) {
  const handleConfirm = useCallback(() => onConfirm(), [onConfirm]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn btn--default" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn btn--${tone}`}
            onClick={handleConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-muted">{body}</p>
    </Modal>
  );
}
