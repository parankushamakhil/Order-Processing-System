import { useEffect, useRef } from 'react';

const SEQUENCE_TIMEOUT = 1400;

const IS_APPLE =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** The modifier key the user actually presses, for on-screen hints. */
export function modKeyLabel() {
  return IS_APPLE ? '⌘' : 'Ctrl';
}

export function isEditableTarget(target) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/**
 * Parse "mod+shift+k" into its parts. `mod` is deliberately platform-neutral:
 * bindings are written once and resolve to ⌘ on Apple hardware and Ctrl
 * everywhere else, so nobody has to remember which one this app cares about.
 */
function parseCombo(combo) {
  const parts = combo.toLowerCase().split('+');
  return {
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
    key: parts[parts.length - 1],
  };
}

/**
 * Global keyboard shortcuts.
 *
 * Two rules keep this from becoming the thing that breaks text inputs:
 *
 *  1. A single-key binding never fires while the user is typing. "?" must be a
 *     question mark in a search box, not a modal. Modifier combos are still
 *     honoured there, because ⌘K is a global intent even mid-sentence.
 *  2. `shift` is only enforced when a binding asks for it. `?` and `+` already
 *     carry shift on most layouts, and requiring it makes those bindings depend
 *     on the user's keyboard layout.
 *
 * Bindings may be sequences — `g o` jumps to Orders the way every tool with a
 * command palette does it, which keeps the single-key namespace free.
 */
export function useGlobalShortcuts(bindings, { enabled = true } = {}) {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return undefined;

    let pending = null;
    let timer = null;

    function clearPending() {
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function onKeyDown(event) {
      if (event.defaultPrevented || event.repeat) return;

      const editable = isEditableTarget(event.target);
      const hasMod = event.metaKey || event.ctrlKey;

      if (editable && !hasMod && pending === null) return;

      const press = {
        key: event.key.toLowerCase(),
        mod: hasMod,
        shift: event.shiftKey,
        alt: event.altKey,
      };

      const candidates = ref.current;

      for (const binding of candidates) {
        const steps = binding.combo.toLowerCase().split(/\s+/);

        if (pending !== null && steps.length === 2 && steps[0] === pending) {
          const second = parseCombo(steps[1]);
          if (second.key !== press.key) continue;
          if (second.mod && !press.mod) continue;
          clearPending();
          event.preventDefault();
          binding.run(event);
          return;
        }

        if (pending !== null) continue;

        if (steps.length === 1) {
          const combo = parseCombo(steps[0]);
          if (combo.key !== press.key) continue;
          if (combo.mod !== press.mod) continue;
          if (combo.alt !== press.alt) continue;
          if (combo.shift && !press.shift) continue;
          if (binding.when && !binding.when()) continue;
          event.preventDefault();
          binding.run(event);
          return;
        }
      }

      // A sequence prefix starts a chord: remember it briefly so `g` alone stays
      // harmless if nothing follows.
      if (pending === null && !editable && !hasMod) {
        const prefix = candidates.find((binding) => binding.combo.toLowerCase().split(/\s+/)[0] === press.key);
        const isSequence = prefix && prefix.combo.includes(' ');
        if (isSequence) {
          pending = press.key;
          clearTimeout(timer);
          timer = setTimeout(clearPending, SEQUENCE_TIMEOUT);
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearPending();
    };
  }, [enabled]);
}
