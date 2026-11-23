// Per-route-group rate limiting module.
//
// Different route groups have different computational costs:
// - Detail reads (GET /streams/:id) are cheap
// - List endpoints (GET /streams) are moderate
// - Summary endpoints (GET /streams/summary, GET /accounts/:address/summary) are expensive
//
// This module implements separate rate limit buckets per route group, so a
// client hammering /streams/summary does not exhaust its budget for cheaper
// detail reads.

import type { FastifyRequest, FastifyReply } from "fastify";
import { errorCodeForStatus } from "./error-redaction.js";

export type RouteGroup = "detail" | "list" | "summary" | "default";

export interface RouteGroupLimits {
  max: number;
  windowMs: number;
}

export interface RateLimiterConfig {
  // Per-group limits. Routes not matching a specific group use "default".
  groups: Record<RouteGroup, RouteGroupLimits>;
  // Maximum number of distinct client IPs to track in memory before evicting.
  maxTrackedClients: number;
  // Addresses that bypass rate limiting entirely.
  allowlist: readonly string[];
}

interface ClientWindow {
  requests: number;
  resetAt: number;
}

// Per-client, per-group rate limit state.
type ClientState = Map<RouteGroup, ClientWindow>;

/**
 * Determines which rate limit group a request belongs to based on its path.
 */
export function classifyRoute(pathname: string): RouteGroup {
  // Summary endpoints are the most expensive
  if (pathname.includes("/summary")) {
    return "summary";
  }
  // List endpoints
  if (pathname === "/streams" || pathname === "/v1/streams" || pathname === "/tokens" || pathname === "/v1/tokens") {
    return "list";
  }
  // Detail endpoints (single resource reads)
  if (pathname.match(/^\/(?:v1\/)?streams\/\d+(?:\/events|\/schedule)?$/)) {
    return "detail";
  }
  // Everything else uses the default bucket
  return "default";
}

/**
 * Checks if an address is in the allowlist.
 */
function isAllowlistedAddress(ip: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(ip);
}

/**
 * Creates a rate limiter hook for Fastify that enforces per-group limits.
 */
export function createRateLimiterHook(config: RateLimiterConfig) {
  const clientStates = new Map<string, ClientState>();

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();

    // Health, readiness, and metrics endpoints are never rate limited
    const pathname = request.raw.url?.split("?")[0];
    if (!pathname || pathname === "/health" || pathname === "/v1/health" || 
        pathname === "/ready" || pathname === "/v1/ready" || 
        pathname === "/metrics" || pathname === "/v1/metrics") {
      return;
    }

    // Allowlisted addresses bypass rate limiting
    if (config.allowlist.length > 0 && isAllowlistedAddress(request.ip, config.allowlist)) {
      return;
    }

    // Classify the route to determine which bucket to check
    const group = classifyRoute(pathname);
    const limits = config.groups[group];

    // Get or initialize client state
    let clientState = clientStates.get(request.ip);
    if (!clientState) {
      // Evict oldest clients if we've hit the tracking limit
      if (clientStates.size >= config.maxTrackedClients) {
        // Remove expired windows first
        for (const [ip, state] of clientStates) {
          let hasActive = false;
          for (const window of state.values()) {
            if (window.resetAt > now) {
              hasActive = true;
              break;
            }
          }
          if (!hasActive) {
            clientStates.delete(ip);
          }
        }
        // If still at capacity, evict the oldest entry
        if (clientStates.size >= config.maxTrackedClients) {
          const oldestIp = clientStates.keys().next().value;
          if (oldestIp !== undefined) {
            clientStates.delete(oldestIp);
          }
        }
      }
      clientState = new Map();
      clientStates.set(request.ip, clientState);
    }

    // Get or initialize the window for this group
    let window = clientState.get(group);
    if (!window || window.resetAt <= now) {
      window = { requests: 0, resetAt: now + limits.windowMs };
      clientState.set(group, window);
    }

    // Check if limit is exceeded
    if (window.requests >= limits.max) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      return reply
        .header("Retry-After", String(retryAfter))
        .status(429)
        .send({
          code: errorCodeForStatus(429),
          error: "rate limit exceeded",
          group,
          requestId: request.id,
        });
    }

    // Increment request count
    window.requests += 1;
  };
}
