/**
 * Loads `.env` into process.env, if one exists.
 *
 * This module is imported by `config/index.js` as its first import, so the file
 * is read before the config schema parses the environment — every entry point
 * (API, seeds, scripts) gets it for free without repeating a bootstrap step.
 *
 * Three properties matter here and all are deliberate:
 *
 *  1. **Real environment variables always win.** The file only fills in names
 *     that are not already set. A deployment platform's dashboard value (or a
 *     one-off `MONGODB_URI=... npm start`) therefore overrides a stale local
 *     `.env` instead of being silently clobbered by it.
 *  2. **A missing file is not an error.** Production images ship no `.env` at
 *     all; configuration arrives from the environment. Absence must be quiet,
 *     or every container would crash on boot.
 *  3. **Resolution does not depend on the working directory.** Paths are built
 *     from this module's own location, so `node server/src/server.js` from the
 *     repo root and `npm start` from `server/` (npm sets the workspace as cwd)
 *     read exactly the same file.
 *
 * Order: `$ENV_FILE`, then `<repo root>/.env` (canonical — it sits beside
 * `.env.example` and is what `docker compose` reads), then `<server>/.env` for a
 * server-only checkout. Only the first file that exists is loaded; loading two
 * would make precedence depend on load order, which is not something anyone
 * should have to reason about.
 *
 * Prefers the runtime's own parser (Node >= 20.12) and falls back to a minimal
 * one so an older interpreter degrades to "works" rather than "crashes".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../..');

/** Files considered, in priority order. Exported so docs and tests can agree. */
export const ENV_CANDIDATES = [
  process.env.ENV_FILE ? path.resolve(process.cwd(), process.env.ENV_FILE) : null,
  path.join(REPO_ROOT, '.env'),
  path.resolve(here, '../.env'),
].filter(Boolean);

export const ENV_FILE = ENV_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;

if (ENV_FILE) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(ENV_FILE);
  } else {
    // Minimal `KEY=value` parser for older runtimes.
    for (const rawLine of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}
