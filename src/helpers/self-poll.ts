import { Config } from '../config.js';

const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 min -- comfortably under Render's 15 min idle timeout

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts a loop that pings this instance's own /health endpoint every 10
 * minutes. Only useful on Render's free web service tier, which spins the
 * instance down after 15 minutes with no inbound traffic -- a self-ping
 * counts as traffic and keeps it warm.
 *
 * Not needed (and not started) on:
 *  - localhost / your own machine -- nothing sleeps
 *  - a paid Render instance or any other always-on host
 *  - anywhere PUBLIC_URL isn't set, since there's nothing to ping
 *
 * This does NOT replace the external scheduler (cron-job.org) that triggers
 * the actual indexer jobs -- it only keeps the process alive so that when
 * cron-job.org's job-ping arrives, the instance is already warm.
 */
export function startKeepAlive(): void {
  if (!Config.renderKeepAlive) return;

  if (!Config.publicUrl) {
    console.warn('[keep-alive] RENDER_KEEP_ALIVE=true but PUBLIC_URL is empty -- skipping self-ping.');
    return;
  }

  if (timer) return; // already running

  console.log(`[keep-alive] enabled, pinging ${Config.publicUrl}/health every ${PING_INTERVAL_MS / 60000}min`);

  timer = setInterval(async () => {
    try {
      const res = await fetch(`${Config.publicUrl}/health`);
      console.log(`[keep-alive] self-ping -> ${res.status}`);
    } catch (err) {
      console.warn('[keep-alive] self-ping failed:', (err as Error).message);
    }
  }, PING_INTERVAL_MS);

  // Don't let this timer keep the process alive on its own during shutdown.
  timer.unref?.();
}

export function stopKeepAlive(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
