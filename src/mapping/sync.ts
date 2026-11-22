import { ingestAniZip } from './ani-zip.js';
import { ingestMapping } from './ingest.js';
import { ingestFribb } from './fribb.js';
import { ingestListsIds, ingestAiring } from './lists.js';
import { ingestCatalog, fillMappingFromCatalog } from './catalog-ingest.js';
import { applyMappingOverrides } from './overrides-apply.js';
import type { SourceSyncOptions } from './guarded-source.js';
import type { YieldCtx } from './chunked-runner.js';

type SyncResult = { steps: Record<string, unknown>; errors: string[] };

/** Runs one step; a failure is recorded and the sync carries on, since the sources are independent. */
function stepRunner(result: SyncResult) {
  return async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const value = await fn();
      result.steps[name] = value;
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${name}: ${message}`);
      console.error(`[sync] ${name} failed:`, message);
      return null;
    }
  };
}

const wasProcessed = (r: { skipped?: string } | null) => r !== null && !r.skipped;

/**
 * The one definition of "refresh the mapping table", shared by the scheduler
 * and every manual route (it used to be copy-pasted in three places).
 *
 * Order: ani.zip -> XML -> Fribb -> lists ids -> catalog gap-fill -> airing ->
 * overrides. Overrides run LAST so a manual correction always beats whatever
 * the sources just wrote.
 *
 * Unchanged sources are skipped, but a source is never skipped when something
 * upstream of it in this chain changed: new XML rows still need Fribb's and
 * lists-main's gap-fills, and newly-added rows still need their airing flag.
 * Each step is isolated -- one broken source no longer aborts the others.
 */
export async function runMappingSync(ctx: YieldCtx, options: SourceSyncOptions = {}): Promise<SyncResult> {
  const result: SyncResult = { steps: {}, errors: [] };
  const step = stepRunner(result);
  let upstreamChanged = false;
  const force = () => Boolean(options.force || upstreamChanged);

  await step('aniZip', () => ingestAniZip(undefined, ctx));

  const xml = await step('xml', () => ingestMapping(undefined, ctx, { force: force() }));
  upstreamChanged ||= wasProcessed(xml);

  const fribb = await step('fribb', () => ingestFribb(undefined, ctx, { force: force() }));
  upstreamChanged ||= wasProcessed(fribb);

  const ids = await step('listsIds', () => ingestListsIds(undefined, ctx, { force: force() }));
  upstreamChanged ||= wasProcessed(ids);

  await step('catalogFill', () => fillMappingFromCatalog());
  await step('airing', () => ingestAiring(undefined, { force: force() }));
  await step('overrides', () => applyMappingOverrides());

  return result;
}

/** Refreshes the anime-offline-database catalog, then re-fills and re-applies overrides on `mapping`. */
export async function runCatalogSync(ctx: YieldCtx, options: SourceSyncOptions = {}): Promise<SyncResult> {
  const result: SyncResult = { steps: {}, errors: [] };
  const step = stepRunner(result);

  const catalog = await step('catalog', () => ingestCatalog(ctx, options));
  if (catalog && catalog.done) {
    await step('catalogFill', () => fillMappingFromCatalog());
    await step('overrides', () => applyMappingOverrides());
  }
  return result;
}
