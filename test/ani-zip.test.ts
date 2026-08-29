import { normalizeAniZipRecord } from '../src/mapping/ani-zip.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

const record = normalizeAniZipRecord({
  anidb_id: '23', titles: { romaji: 'Cowboy Bebop' }, format: 'tv',
  idAL: 1, idMal: 1, tvdbId: 76885, tmdbTvId: 30991,
  tmdbMovieIds: ['100', 101], imdb_ids: ['tt0213338']
});

check('normalizes source IDs without discarding the original archive payload', record && {
  anidbId: record.anidbId, title: record.title, type: record.type, anilistId: record.anilistId,
  malId: record.malId, tvdbId: record.tvdbId, tmdbTvId: record.tmdbTvId,
  tmdbMovieIds: record.tmdbMovieIds, imdbIds: record.imdbIds, rawId: record.raw.anidb_id
}, {
  anidbId: 23, title: 'Cowboy Bebop', type: 'TV', anilistId: 1, malId: 1,
  tvdbId: 76885, tmdbTvId: 30991, tmdbMovieIds: [100, 101], imdbIds: ['tt0213338'], rawId: '23'
});
check('rejects archive records that cannot be tied to AniDB', normalizeAniZipRecord({ title: 'unmapped' }), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
