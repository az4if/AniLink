import { assertSaneRowCount, evaluateRowCount, SyncGuardError, DEFAULT_MAX_DROP_PERCENT } from '../src/mapping/sync-guard.js';
import { loadGuardedSource, type SourceStore } from '../src/mapping/guarded-source.js';
import { sha256Hex, type Fetcher, type SourceFingerprint } from '../src/helpers/conditional-fetch.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('evaluateRowCount');
check('no baseline yet -> ok', evaluateRowCount(null, 500).ok, true);
check('baseline 0 -> ok', evaluateRowCount(0, 500).ok, true);
check('small drop within the limit -> ok', evaluateRowCount(1000, 950).ok, true);
check('growth -> ok', evaluateRowCount(1000, 5000).ok, true);
check('exactly at the limit -> ok', evaluateRowCount(1000, 900, 10).ok, true);
{
  const v = evaluateRowCount(1000, 899, 10);
  check('just past the limit -> rejected', v.ok, false);
  check('reason names both counts', !v.ok && v.reason.includes('1000') && v.reason.includes('899'), true);
}
check('empty source is always rejected, even with no baseline', evaluateRowCount(null, 0).ok, false);
check('NaN limit falls back to the default instead of disabling the guard', evaluateRowCount(1000, 500, Number.NaN).ok, false);
check('default limit is 10%', DEFAULT_MAX_DROP_PERCENT, 10);
check('looser per-source limit accepts a bigger swing (airing)', evaluateRowCount(300, 150, 60).ok, true);

console.log('assertSaneRowCount');
{
  let error: unknown = null;
  try {
    assertSaneRowCount('fribb', 20000, 100);
  } catch (err) {
    error = err;
  }
  check('throws SyncGuardError', error instanceof SyncGuardError, true);
  check('message names the source and the way out', (error as Error).message.includes('fribb') && (error as Error).message.includes('force=true'), true);
  let ok = true;
  try {
    assertSaneRowCount('fribb', 20000, 19990);
  } catch {
    ok = false;
  }
  check('does not throw on a sane count', ok, true);
}

// --- loadGuardedSource with an in-memory store and a scripted fetcher -------
type Call = { method: string; key: string; detail?: unknown };
function memoryStore(initial?: { fingerprint: SourceFingerprint; rowCount: number }) {
  let state: { fingerprint: SourceFingerprint | null; rowCount: number | null } = initial ?? { fingerprint: null, rowCount: null };
  const calls: Call[] = [];
  const store: SourceStore = {
    async load(key) {
      calls.push({ method: 'load', key });
      return state;
    },
    async commit(key, fingerprint, rowCount) {
      calls.push({ method: 'commit', key, detail: rowCount });
      state = { fingerprint, rowCount };
    },
    async record(key, status, message) {
      calls.push({ method: 'record', key, detail: [status, message] });
    }
  };
  return { store, calls, get state() { return state; } };
}

const parseCount = { parse: (text: string) => JSON.parse(text) as number[], count: (rows: number[]) => rows.length };
const body = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => i));
const serve = (text: string, etag = '"v1"'): Fetcher => async () => new Response(text, { status: 200, headers: { etag } });

console.log('loadGuardedSource');
{
  const m = memoryStore();
  const result = await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'l', ...parseCount, fetcher: serve(body(100)) });
  check('first load returns data and a commit callback', [result.skipped, !result.skipped && result.rowCount], [false, 100]);
  check('nothing is committed until the caller says so', m.calls.some((c) => c.method === 'commit'), false);
  if (!result.skipped) await result.commit();
  check('commit stores the row count baseline', m.state.rowCount, 100);
  check('commit stores the content hash', m.state.fingerprint?.contentHash, sha256Hex(body(100)));
}
{
  const m = memoryStore({ fingerprint: { etag: '"v1"', lastModified: null, contentHash: sha256Hex(body(100)), contentLength: 0 }, rowCount: 100 });
  const result = await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'l', ...parseCount, fetcher: serve(body(100), '"v2"') });
  check('same bytes -> skipped as same-content', [result.skipped, result.skipped && result.reason], [true, 'same-content']);
  check('skip is recorded as unchanged', m.calls.find((c) => c.method === 'record')?.detail, ['unchanged', null]);
}
{
  const m = memoryStore({ fingerprint: { etag: '"v1"', lastModified: null, contentHash: sha256Hex(body(100)), contentLength: 0 }, rowCount: 100 });
  let error: unknown = null;
  try {
    await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'l', ...parseCount, fetcher: serve(body(40), '"v3"') });
  } catch (err) {
    error = err;
  }
  check('a shrunken source is rejected with SyncGuardError', error instanceof SyncGuardError, true);
  check('rejection is recorded', (m.calls.find((c) => c.method === 'record')?.detail as unknown[])[0], 'rejected');
  check('rejection leaves the stored baseline untouched', m.state.rowCount, 100);
}
{
  const m = memoryStore({ fingerprint: { etag: '"v1"', lastModified: null, contentHash: sha256Hex(body(100)), contentLength: 0 }, rowCount: 100 });
  const result = await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'l', ...parseCount, force: true, fetcher: serve(body(40), '"v3"') });
  check('force overrides the guard', [result.skipped, !result.skipped && result.rowCount], [false, 40]);
}
{
  const m = memoryStore();
  let error: unknown = null;
  try {
    await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'l', ...parseCount, fetcher: serve('not json') });
  } catch (err) {
    error = err;
  }
  check('unparseable body throws', error instanceof Error, true);
  check('parse failure is recorded as an error', (m.calls.find((c) => c.method === 'record')?.detail as unknown[])[0], 'error');
}
{
  const m = memoryStore();
  let error: unknown = null;
  const failing: Fetcher = async () => new Response('x', { status: 500 });
  try {
    await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'thing.json', ...parseCount, fetcher: failing });
  } catch (err) {
    error = err;
  }
  check('HTTP failure throws with the label', (error as Error).message, 'Failed to download thing.json: HTTP 500');
  check('HTTP failure is recorded as an error', (m.calls.find((c) => c.method === 'record')?.detail as unknown[])[0], 'error');
}
{
  const m = memoryStore();
  let error: unknown = null;
  try {
    await loadGuardedSource(m.store, { key: 's', url: 'u', label: 'l', ...parseCount, fetcher: serve('[]') });
  } catch (err) {
    error = err;
  }
  check('an empty list is rejected even on the very first run', error instanceof SyncGuardError, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
