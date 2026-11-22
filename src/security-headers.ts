import helmet from "@fastify/helmet";

import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Security headers (#520).
//
// This is a JSON API, but the interactive docs at /docs are served from the
// same origin, so the policy has to be strict for API responses while still
// letting Swagger UI load its own assets: its scripts are external files under
// /docs/static and it styles the page with inline style attributes, hence
// 'self' for scripts and 'unsafe-inline' for styles only.
//
// `upgrade-insecure-requests` is deliberately not set: the docs must keep
// working when the API is reached over plain HTTP in local development or
// through a TLS-terminating proxy. HSTS still applies when the request is
// actually served over HTTPS.
// ---------------------------------------------------------------------------

/**
 * Registers the hardening headers on every response:
 *
 * - `X-Content-Type-Options: nosniff`, so an error body is never sniffed as HTML
 * - a restrictive `Content-Security-Policy`, including for the docs page
 * - `Referrer-Policy: no-referrer`
 *
 * Call during server construction, before the routes are registered, so the
 * hooks cover the docs and the error handlers too.
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
        // helmet merges this with its defaults; null removes the default
        // directive for the reason described above.
        upgradeInsecureRequests: null,
      },
    },
    // The API is deliberately callable cross-origin (see CORS in server.ts), so
    // the same-origin default would contradict that policy for consumers that
    // do not use CORS.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
  });
}
