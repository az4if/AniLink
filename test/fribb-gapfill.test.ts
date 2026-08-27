import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { ingestFribb } from '../src/mapping/fribb.js';

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
  const FAKE_ANIDB_ID = 999999001;
  await db
    .insert(schema.mapping)
    .values({
      anidbId: FAKE_ANIDB_ID,
      tvdbId: 111111,
      defaultTvdbSeason: 7,
      tvdbEpisodeOffset: 99,
      source: 'anime-lists-xml'
    })
    .onConflictDoUpdate({
      target: schema.mapping.anidbId,
      set: { tvdbId: 111111, defaultTvdbSeason: 7, tvdbEpisodeOffset: 99 }
    });

  await ingestFribb([
    {
      anidb_id: FAKE_ANIDB_ID,
      anilist_id: 424242,
      tvdb_id: 76885,
      season: { tvdb: 1 },
      episode_offset: { tvdb: 0 }
    }
  ]);

  const afterFakeXmlData = await db.query.mapping.findFirst({ where: eq(schema.mapping.anidbId, FAKE_ANIDB_ID) });
  check('Fribb does NOT overwrite a tvdb_id XML already set', afterFakeXmlData?.tvdbId, 111111);
  check('Fribb does NOT overwrite a season XML already set', afterFakeXmlData?.defaultTvdbSeason, 7);
  check('Fribb does NOT overwrite an offset XML already set', afterFakeXmlData?.tvdbEpisodeOffset, 99);
  check('Fribb DOES set fields XML never had at all (anilist_id)', afterFakeXmlData?.anilistId, 424242);

  const FAKE_ANIDB_ID_2 = 999999002;
  await db.insert(schema.mapping).values({ anidbId: FAKE_ANIDB_ID_2, source: 'anime-lists-xml' }).onConflictDoNothing();

  await ingestFribb([
    {
      anidb_id: FAKE_ANIDB_ID_2,
      tvdb_id: 76885,
      season: { tvdb: 1 },
      episode_offset: { tvdb: 0 }
    }
  ]);

  const afterGap = await db.query.mapping.findFirst({ where: eq(schema.mapping.anidbId, FAKE_ANIDB_ID_2) });
  check('Fribb fills a tvdb_id when XML had none at all', afterGap?.tvdbId, 76885);
  check('Fribb fills a season when XML had none at all', afterGap?.defaultTvdbSeason, 1);

  await db.delete(schema.mapping).where(eq(schema.mapping.anidbId, FAKE_ANIDB_ID));
  await db.delete(schema.mapping).where(eq(schema.mapping.anidbId, FAKE_ANIDB_ID_2));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main();
