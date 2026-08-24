export type YieldCtx = { shouldYield: () => boolean };
export type JobFn = (ctx: YieldCtx) => Promise<void>;

type QueuedJob = { id: string; priority: number; run: JobFn; enqueuedAt: number };

export type QueueStatus = { name: string; running: string | null; pending: string[] };

/**
 * Single-flight priority queue: only one job runs at a time. When a
 * higher-priority job is enqueued while a lower-priority one is running,
 * the running job isn't killed -- it's asked to cooperatively yield via
 * `ctx.shouldYield()`, which it should check at safe checkpoints (between
 * chunks of work) and, if true, save its progress and return early. The
 * queue then runs the higher-priority job next. A yielded job is
 * responsible for re-enqueueing itself if it wants to finish later -- see
 * chunked-runner.ts, which pairs naturally with this (it checkpoints to
 * `indexer_state` exactly when shouldYield() flips true).
 *
 * Same-priority jobs run FIFO, which alone is enough to satisfy "only one
 * of these at a time" for a queue where nothing is ever higher priority
 * than anything else (see jsonQueue in scheduler/index.ts).
 */
export class JobQueue {
  readonly name: string;
  private pending: QueuedJob[] = [];
  private running: QueuedJob | null = null;
  private yieldRequested = false;

  constructor(name: string) {
    this.name = name;
  }

  /** No-ops if a job with this id is already running or pending -- avoids piling up duplicate scheduled triggers. */
  enqueue(id: string, priority: number, run: JobFn): void {
    if (this.running?.id === id || this.pending.some((j) => j.id === id)) {
      console.log(`[queue:${this.name}] ${id} already queued or running, skipping duplicate enqueue`);
      return;
    }

    this.pending.push({ id, priority, run, enqueuedAt: Date.now() });
    this.pending.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);

    if (this.running && priority > this.running.priority) {
      console.log(
        `[queue:${this.name}] ${id} (priority ${priority}) requests yield from running ${this.running.id} (priority ${this.running.priority})`
      );
      this.yieldRequested = true;
    }

    void this.drain();
  }

  status(): QueueStatus {
    return { name: this.name, running: this.running?.id ?? null, pending: this.pending.map((j) => j.id) };
  }

  private async drain(): Promise<void> {
    if (this.running) return; // a drain() is already in progress

    const next = this.pending.shift();
    if (!next) return;

    this.running = next;
    this.yieldRequested = false;
    console.log(`[queue:${this.name}] starting ${next.id} (priority ${next.priority})`);

    try {
      await next.run({ shouldYield: () => this.yieldRequested });
    } catch (err) {
      console.error(`[queue:${this.name}] ${next.id} failed:`, err);
    } finally {
      console.log(`[queue:${this.name}] finished ${next.id}`);
      this.running = null;
      void this.drain();
    }
  }
}
