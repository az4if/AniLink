import { normalizeAniZipApiData } from '../src/mapping/ani-zip-client.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual: ${JSON.stringify(actual)}`);
  }
}

const data = normalizeAniZipApiData({
  titles: { en: 'One Piece', ja: 'ONE PIECE', 'x-jat': 'Wan Pisu' },
  mappings: {
    animeplanet_id: 'one-piece', kitsu_id: 12, mal_id: 21, type: 'TV', anilist_id: 21,
    anisearch_id: 2227, anidb_id: 69, notifymoe_id: 69, livechart_id: 321,
    thetvdb_id: 81797, imdb_id: 'tt0388629', themoviedb_id: '37854'
  },
  episodeCount: 1264,
  specialCount: 4,
  images: [
    { coverType: 'Banner', url: 'https://example.com/banner.jpg' },
    { coverType: 'Poster', url: 'https://example.com/poster.jpg' },
    { coverType: 'Clearlogo', url: 'https://example.com/logo.png' }
  ],
  episodes: {
    1: {
      tvdbShowId: 81797, tvdbId: 361887, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1,
      title: { en: "I'm Luffy!", ja: '俺はルフィ!' }, airDate: '1999-10-20', airDateUtc: '1999-10-20T14:15:00Z',
      runtime: 25, overview: 'Episode overview', image: 'https://example.com/episode.jpg', anidbEid: 440, rating: '6.03', summary: 'Episode summary'
    }
  }
});

check('preserves language titles and every useful provider ID', {
  anidbId: data.anidbId, titles: data.titles, mappings: data.mappings
}, {
  anidbId: 69, titles: { en: 'One Piece', ja: 'ONE PIECE', 'x-jat': 'Wan Pisu' },
  mappings: { anilistId: 21, malId: 21, kitsuId: 12, animePlanetId: 'one-piece', anisearchId: 2227, livechartId: 321, tvdbId: 81797, tmdbId: 37854, imdbId: 'tt0388629', notifyMoeId: 69, type: 'TV' }
});
check('normalizes direct episode mapping and multilingual metadata', data.episodes[0], {
  number: 1, anidbEpisodeId: 440, tvdbShowId: 81797, tvdbEpisodeId: 361887, seasonNumber: 1,
  episodeNumber: 1, absoluteNumber: 1, titles: { en: "I'm Luffy!", ja: '俺はルフィ!' }, overview: 'Episode overview', summary: 'Episode summary',
  aired: '1999-10-20', airedUtc: '1999-10-20T14:15:00Z', runtime: 25, rating: 6.03, image: 'https://example.com/episode.jpg'
});
check('retains artwork with source and type', data.artworks.map((artwork) => [artwork.source, artwork.type, artwork.url]), [
  ['ani-zip', 'background', 'https://example.com/banner.jpg'], ['ani-zip', 'poster', 'https://example.com/poster.jpg'], ['ani-zip', 'logo', 'https://example.com/logo.png']
]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
