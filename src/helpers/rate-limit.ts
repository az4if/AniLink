import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
  // Max requests per IP per window. 0 disables limiting entirely (every
  // request skips straight through, no bucket bookkeeping at all).
  limit: number;
  // Window length, ms.
  windowMs: number;
};

/**
 * Simple in-memory fixed-window rate limiter, keyed by client IP. One
 * process, one Map -- same "no external dependency, single instance"
 * assumption the rest of this codebase makes (see JobQueue, self-poll).
 * If AniLink ever runs as multiple instances behind a shared load
 * balancer, this would need to move to a shared store (e.g. Postgres,
 * already a dependency) to stay accurate across processes.
 */
export function rateLimiter({ limit, windowMs }: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();

  // Periodic sweep so the map doesn't grow forever with one-off IPs.
  const sweepMs = Math.max(windowMs, 60_000);
  setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(ip);
    }
  }, sweepMs).unref();

  return async (c, next) => {
    if (limit === 0) return next(); // unlimited -- skip bucket bookkeeping entirely

    const ip = getClientIp(c);
    const now = Date.now();

    let bucket = buckets.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count++;

    const remaining = Math.max(limit - bucket.count, 0);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > limit) {
      const retryAfterSec = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1);
      c.header('Retry-After', String(retryAfterSec));
      return c.json({ error: 'Too many requests', retryAfterSeconds: retryAfterSec }, 429);
    }

    return next();
  };
}

/**
 * Best-effort client IP: X-Forwarded-For (set by Render's proxy and most
 * hosts that sit in front of this process) first, then X-Real-IP, falling
 * back to the raw socket address for direct/local connections.
 */
function getClientIp(c: Context): string {
  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp;

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // conninfo isn't available in every runtime/test context -- fall through
  }

  return 'unknown';
}
