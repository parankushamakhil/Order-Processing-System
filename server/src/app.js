import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { corsOrigins, isProd, serveClient } from './config/index.js';
import { ForbiddenError } from './errors/index.js';
import { logger } from './lib/logger.js';
import { requestContext } from './middleware/context.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The client build output, resolved from the server's own location. */
export const CLIENT_DIST = path.resolve(here, '../../client/dist');

/**
 * Static hosting for the built SPA, in the same process as the API.
 *
 * Two deliberate choices:
 *
 *  - **Cache-Control is set per file kind.** Vite emits content-hashed filenames
 *    under /assets, so those are immutable for a year; index.html must never be
 *    cached or a deploy silently keeps serving the previous build.
 *  - **The fallback is a RegExp.** Express 5 removed the `*` string pattern, and
 *    the negative lookahead keeps /api and /healthz out of the fallback so an
 *    unknown API path still returns the API's JSON 404 envelope rather than the
 *    SPA's HTML.
 */
function mountClient(app) {
  if (!fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
    logger.warn('SERVE_CLIENT is on but no client build was found; serving the API only', {
      expected: CLIENT_DIST,
      hint: 'run `npm run build --workspace client` before starting, or set SERVE_CLIENT=false',
    });
    return;
  }

  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        if (name === 'index.html') res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    }),
  );

  app.get(/^\/(?!api\/|healthz).*/, (req, res, next) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'), (error) => (error ? next(error) : undefined));
  });

  logger.info('serving client build', { directory: CLIENT_DIST });
}

/**
 * Is this `Origin` the app's own origin?
 *
 * A request whose Origin is this service's own origin is not cross-origin, and
 * CORS has nothing to say about it — so it must not be run through the
 * allowlist.
 *
 * This is not hypothetical politeness. Vite emits `crossorigin` on the module
 * script and the stylesheet of the built SPA, so a browser DOES send an `Origin`
 * header on those same-origin requests. Treating "has an Origin header" as "is
 * cross-origin" therefore rejected the app's own assets with a 403 JSON body:
 * the production build loaded no CSS and no JavaScript, while `curl` — which
 * sends no Origin — saw a perfectly healthy server. Found by opening the
 * production build in a browser, which is the only place it could be found
 * ("absent Origin means same-origin" is the kind of assumption that passes every
 * API test ever written).
 *
 * Compared on host (which includes the port). The scheme is deliberately not
 * compared: behind a TLS-terminating proxy the forwarded scheme and the
 * browser's Origin can disagree in ways that have nothing to do with who is
 * calling, and an attacker cannot forge the Host of a request they did not send.
 */
function isOwnOrigin(req, origin) {
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false; // unparseable Origin: let the allowlist below deal with it
  }
}

/**
 * The app is built by a factory and never calls listen(), so tests can drive it
 * with supertest without binding a port and without a separate test-only wiring.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(requestContext);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'", 'data:', 'blob:', 'https://images.unsplash.com', 'https:'],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Built once, not per request. Same-origin callers bypass it entirely (see
  // isOwnOrigin); everything else must match the configured allowlist.
  const corsHandler = cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) return callback(null, true);
      return callback(new ForbiddenError(`Origin not allowed: ${origin}`));
    },
  });

  app.use((req, res, next) =>
    isOwnOrigin(req, req.get('Origin')) ? next() : corsHandler(req, res, next),
  );

  app.use(
    express.json({
      limit: '100kb',
      // The raw bytes are needed to verify the payment webhook's HMAC. Verify the
      // ORIGINAL bytes, not a re-serialisation: JSON.stringify(parsed) is not
      // guaranteed to reproduce what was signed.
      verify(req, res, buffer) {
        req.rawBody = buffer;
      },
    }),
  );

  app.use(healthRoutes);
  app.use('/api', apiRoutes);

  // After the API routes, before the 404 handler: the SPA is the fallback, not a
  // competitor to the API.
  if (serveClient) mountClient(app);

  app.use(notFoundHandler);
  // Express identifies error handlers by arity, so this must stay last and keep
  // its four parameters.
  app.use(errorHandler);

  if (isProd) {
    // Behind a proxy the client address is the first hop.
    app.set('trust proxy', 1);
  }

  return app;
}
