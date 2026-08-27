import { readFileSync } from 'node:fs';
import { toFribbDbRow, type FribbEntry } from '../src/mapping/fribb.js';
import { toAiringFields } from '../src/mapping/lists.js';

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

const dir = new URL('.', import.meta.url).pathname;

// --- Fribb-format JSON --------------------------------------------------
{
  const entries: FribbEntry[] = JSON.parse(readFileSync(dir + 'fribb.sample.json', 'utf-8'));
  const withId = entries.filter((e): e is FribbEntry & { anidb_id: number } => typeof e.anidb_id === 'number');
  console.log(`Fribb JSON: ${entries.length} total entries, ${withId.length} with an anidb_id`);

  const cowboyBebop = withId.find((e) => e.anidb_id === 23)!;
  check('Cowboy Bebop (TV) shapes correctly', toFribbDbRow(cowboyBebop), {
    anidbId: 23,
    anilistId: 1,
    malId: 1,
    kitsuId: 1,
    livechartId: 3418,
    anisearchId: 1572,
    simklId: 37089,
    animeNewsNetworkId: 13,
    animeCountdownId: 37089,
    animePlanetId: 'cowboy-bebop',
    type: 'TV',
    tvdbId: 76885,
    tmdbTvId: 30991,
    tmdbMovieIds: null,
    imdbIds: ['tt0213338'],
    defaultTvdbSeason: 1,
    tvdbEpisodeOffset: null,
    defaultTmdbSeason: 1,
    tmdbEpisodeOffset: null
  });

  const mononoke = withId.find((e) => e.anidb_id === 7)!;
  check('Princess Mononoke (MOVIE) shapes correctly, no crash on themoviedb_id.movie array', toFribbDbRow(mononoke), {
    anidbId: 7,
    anilistId: 164,
    malId: 164,
    kitsuId: 142,
    livechartId: 3081,
    anisearchId: 3320,
    simklId: 36228,
    animeNewsNetworkId: 197,
    animeCountdownId: 36228,
    animePlanetId: 'princess-mononoke',
    type: 'MOVIE',
    tvdbId: null,
    tmdbTvId: null,
    tmdbMovieIds: [128],
    imdbIds: ['tt0119698'],
    defaultTvdbSeason: null,
    tvdbEpisodeOffset: null,
    defaultTmdbSeason: null,
    tmdbEpisodeOffset: null
  });

  // sanity: toFribbDbRow should never throw across the whole real file
  let crashes = 0;
  for (const e of withId) {
    try {
      toFribbDbRow(e);
    } catch {
      crashes++;
    }
  }
  check('toFribbDbRow never throws across all real entries', crashes, 0);
}

// --- lists-main: anime-airing.json ---------------------------------------
{
  const entries: { idAniDB?: number; titles?: { romaji?: string }; nextEpisode?: { episodeNumber?: number; date?: number } }[] =
    JSON.parse(readFileSync(dir + 'lists-airing.sample.json', 'utf-8'));
  console.log(`\nanime-airing.json: ${entries.length} currently-airing entries`);

  const onePiece = entries.find((e) => e.idAniDB === 69)!;
  const fields = toAiringFields(onePiece);
  check('One Piece episodeProgress = nextEpisode - 1', fields.episodeProgress, onePiece.nextEpisode!.episodeNumber! - 1);
  check('One Piece nextEpisodeAt is a real Date', fields.nextEpisodeAt instanceof Date, true);
  check('One Piece nextEpisodeAt round-trips the unix seconds', fields.nextEpisodeAt!.getTime() / 1000, onePiece.nextEpisode!.date);

  const missingEpisode = toAiringFields({});
  check('missing nextEpisode -> nulls, not a crash', missingEpisode, { episodeProgress: null, nextEpisodeAt: null });
}

// --- lists-main: anime.json (id triples) ----------------------------------
{
  const entries: { idAL?: number; idAniDB?: number; idMal?: number }[] = JSON.parse(
    readFileSync(dir + 'lists-anime.sample.json', 'utf-8')
  );
  const withAnidbId = entries.filter((e) => typeof e.idAniDB === 'number');
  console.log(`\nanime.json: ${entries.length} total, ${withAnidbId.length} with idAniDB (rest are AniList/MAL-only, no AniDB match -- outside our catalog, correctly skipped by ingestListsIds)`);
  check('some entries have an idAniDB to backfill from', withAnidbId.length > 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
