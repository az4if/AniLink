import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { getTvdbSyncTargets } from '../src/mapping/tvdb-targets.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const full = await getTvdbSyncTargets('full');
  console.log(`'full' target count: ${full.length}`);
  check("'full' returns at least some real tvdb_ids", full.length > 0, true);

  // On an empty tvdb_cache, 'incremental' should equal 'full' exactly --
  // this is the "first run processes everything" property, and it must
  // come from the query itself, not a special-cased "is this the first
  // run" flag.
  const incrementalBeforeAnyCache = await getTvdbSyncTargets('incremental');
  check("'incremental' on an empty tvdb_cache equals 'full' (first-run behavior)", new Set(incrementalBeforeAnyCache).size, new Set(full).size);
  check(
    "'incremental' and 'full' are the same SET of ids on an empty cache",
    [...incrementalBeforeAnyCache].sort((a, b) => a - b),
    [...full].sort((a, b) => a - b)
  );

  // Pick a real, non-airing, tvdb-mapped anime and mark its tvdb_id as
  // already cached. It should now disappear from 'incremental' -- unless
  // it happens to be airing, so pick one explicitly known not to be.
  const nonAiringMapped = await db.query.mapping.findFirst({
    where: eq(schema.mapping.anidbId, 23) // Cowboy Bebop -- finished decades ago, definitely not airing
  });
  if (!nonAiringMapped?.tvdbId) throw new Error('test setup assumption failed: expected anidb_id 23 to have a tvdb_id');

  await db.insert(schema.tvdbCache).values({ tvdbId: nonAiringMapped.tvdbId, lastScrapedAt: new Date() });

  const incrementalAfterCaching = await getTvdbSyncTargets('incremental');
  check(
    'a cached, non-airing tvdb_id drops out of the incremental set',
    incrementalAfterCaching.includes(nonAiringMapped.tvdbId),
    false
  );
  check('the incremental set shrank by exactly one', incrementalAfterCaching.length, incrementalBeforeAnyCache.length - 1);
  check("'full' is unaffected by caching -- still returns everything", (await getTvdbSyncTargets('full')).length, full.length);

  // An airing anime's tvdb_id should stay in 'incremental' even after being
  // cached -- airing shows always get rechecked regardless of cache state.
  const airingMapped = await db.query.mapping.findFirst({ where: eq(schema.mapping.airing, true) });
  if (airingMapped?.tvdbId) {
    await db
      .insert(schema.tvdbCache)
      .values({ tvdbId: airingMapped.tvdbId, lastScrapedAt: new Date() })
      .onConflictDoUpdate({ target: schema.tvdbCache.tvdbId, set: { lastScrapedAt: new Date() } });
    const incrementalWithAiringCached = await getTvdbSyncTargets('incremental');
    check('an airing anime stays in the incremental set even once cached', incrementalWithAiringCached.includes(airingMapped.tvdbId), true);
  } else {
    console.log('  (skipped: no airing+tvdb-mapped anime in the current dataset to test with)');
  }

  // cleanup
  await db.delete(schema.tvdbCache);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main();
