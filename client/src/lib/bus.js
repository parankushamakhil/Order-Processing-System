/**
 * A minimal event bus for cross-view intents.
 *
 * The command palette needs to say "put this term in the catalogue search"
 * without the shell knowing that a catalogue exists or where its input lives —
 * prop-drilling a setter up through App would couple the two views for one
 * interaction. A named event keeps them decoupled: the palette announces an
 * intent, a view that cares subscribes, and if nothing is listening the app is
 * still correct.
 *
 * Deliberately not a state store. Anything that must survive a re-render belongs
 * in a context; this is for one-shot verbs.
 */
const listeners = new Map();
const parked = new Map();

/**
 * Subscribe. A parked intent — one published while nothing was listening — is
 * delivered immediately, then dropped: exactly one view handles it, once.
 */
export function on(type, handler) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(handler);

  if (parked.has(type)) {
    const detail = parked.get(type);
    parked.delete(type);
    handler(detail);
  }

  return () => listeners.get(type)?.delete(handler);
}

/**
 * Publish for a view that may not be mounted yet.
 *
 * The palette hands a product to the catalogue and *then* routes there: the
 * catalogue mounts one tick later, well after a plain emit has been and gone.
 * Parking the intent closes that window without the palette having to know
 * anything about mount timing.
 */
export function emitOnce(type, detail) {
  if (emit(type, detail) === 0) parked.set(type, detail);
}

export function emit(type, detail) {
  const handlers = listeners.get(type);
  if (!handlers) return 0;
  let notified = 0;
  handlers.forEach((handler) => {
    try {
      handler(detail);
      notified += 1;
    } catch (error) {
      // One broken subscriber must not stop the others, or a stray listener can
      // silently break every shortcut in the app.
      console.error(`[bus] listener for "${type}" threw`, error);
    }
  });
  return notified;
}

export const EVENTS = {
  /** Focus the catalogue search input, optionally seeding it with a term. */
  focusCatalogueSearch: 'catalogue:focus-search',
  /** Re-fetch whatever data the active view is showing. */
  refreshView: 'view:refresh',
};
