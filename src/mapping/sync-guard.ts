/**
 * Sanity check on a source's size before it is allowed to touch the DB.
 *
 * Upstream files are community-maintained and occasionally break: a truncated
 * download, a repo force-push, an API returning an error page that happens to
 * parse. Most ingests here are upserts, but `ingestAiring` clears flags and the
 * catalog sync deletes rows that vanished, so a half-empty file would quietly
 * damage good data. Comparing the row count with the last successful run is a
 * cheap, source-agnostic tripwire.
 */

export const DEFAULT_MAX_DROP_PERCENT = 10;

export type RowCountVerdict = { ok: true } | { ok: false; reason: string; dropPercent: number | null };

export function evaluateRowCount(
  previous: number | null | undefined,
  next: number,
  maxDropPercent: number = DEFAULT_MAX_DROP_PERCENT,
  minRows = 1
): RowCountVerdict {
  // A bad env value (NaN) must not silently disable the guard.
  const limit = Number.isFinite(maxDropPercent) && maxDropPercent >= 0 ? maxDropPercent : DEFAULT_MAX_DROP_PERCENT;

  if (!Number.isFinite(next) || next < minRows) {
    return { ok: false, reason: `source produced ${next} rows (minimum ${minRows})`, dropPercent: null };
  }
  if (previous === null || previous === undefined || previous <= 0) return { ok: true };

  const dropPercent = ((previous - next) / previous) * 100;
  if (dropPercent > limit) {
    return {
      ok: false,
      reason: `row count fell from ${previous} to ${next} (-${dropPercent.toFixed(1)}%, limit ${limit}%)`,
      dropPercent
    };
  }
  return { ok: true };
}

export class SyncGuardError extends Error {
  readonly sourceKey: string;
  readonly dropPercent: number | null;

  constructor(sourceKey: string, reason: string, dropPercent: number | null) {
    super(`[sync-guard] ${sourceKey}: refusing to apply -- ${reason}. Existing data was left untouched; re-run with force=true once you have checked the upstream source.`);
    this.name = 'SyncGuardError';
    this.sourceKey = sourceKey;
    this.dropPercent = dropPercent;
  }
}

/** Throws SyncGuardError when the verdict is not ok. */
export function assertSaneRowCount(
  sourceKey: string,
  previous: number | null | undefined,
  next: number,
  maxDropPercent?: number,
  minRows?: number
): void {
  const verdict = evaluateRowCount(previous, next, maxDropPercent, minRows);
  if (!verdict.ok) throw new SyncGuardError(sourceKey, verdict.reason, verdict.dropPercent);
}
