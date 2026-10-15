import { useCallback, useEffect, useState } from 'react';

/**
 * A hash router in twenty lines.
 *
 * A real app would use a routing library, but the property that matters here is
 * that the current view lives in the URL: refresh keeps you where you were, the
 * back button works, and a view can be linked to. Doing it with the hash costs
 * no dependency and no server rewrite rules; the trade is that a production
 * build would move to history-based routes for cleaner URLs.
 */
function parse() {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return raw || null;
}

/**
 * Unknown hashes resolve to the default route rather than rendering nothing.
 * That matters in practice: any in-page anchor (a skip link, a footnote) would
 * otherwise blank the view.
 */
function resolve(validRoutes, defaultRoute) {
  const parsed = parse();
  return parsed && validRoutes.includes(parsed) ? parsed : defaultRoute;
}

export function useHashRoute(defaultRoute, validRoutes = [defaultRoute]) {
  const [route, setRoute] = useState(() => resolve(validRoutes, defaultRoute));

  useEffect(() => {
    const sync = () => setRoute(resolve(validRoutes, defaultRoute));
    window.addEventListener('hashchange', sync);
    if (!parse()) window.history.replaceState(null, '', `#/${defaultRoute}`);
    return () => window.removeEventListener('hashchange', sync);
    // validRoutes is a stable literal at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultRoute, validRoutes.join(',')]);

  const navigate = useCallback((next) => {
    if (parse() === next) return;
    window.location.hash = `#/${next}`;
  }, []);

  // A new view should start at the top, which the browser does not do for hash
  // changes on its own.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }, [route]);

  return [route, navigate];
}
