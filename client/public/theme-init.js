/*
 * Pre-paint theme bootstrap.
 *
 * This has to run before the first paint — otherwise the first frame renders in
 * the light palette and then flips, which is the most visible way a themed app
 * looks unfinished.
 *
 * It lives in its own file rather than inline in index.html because the server
 * ships a strict Content-Security-Policy (`script-src 'self'`, helmet's default).
 * An inline script would be blocked by that policy, and the alternatives are worse:
 * a per-request nonce cannot be applied to a statically-built index.html without
 * templating it at runtime, and a hard-coded hash breaks on every edit to this file.
 *
 * Kept dependency-free and tiny, and it is served with `Cache-Control: no-cache`
 * alongside index.html so a change here cannot be masked by a stale cache.
 */
(function () {
  try {
    var stored = localStorage.getItem('ops.theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : prefersDark ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch (error) {
    /* Storage unavailable (private mode, blocked cookies): fall through to the
       CSS default rather than leaving the page unstyled. */
  }
})();
