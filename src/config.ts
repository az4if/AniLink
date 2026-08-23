import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const Config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  publicUrl: process.env.PUBLIC_URL ?? '',
  renderKeepAlive: (process.env.RENDER_KEEP_ALIVE ?? 'false').toLowerCase() === 'true',

  tvdb: {
    apiKey: process.env.TVDB_API_KEY ?? '',
    apiPin: process.env.TVDB_API_PIN ?? ''
  },

  // All static-file mapping sources. Every one is overridable via env so a
  // fork/mirror URL can be swapped in without touching code.
  sources: {
    animeListMasterXmlUrl:
      process.env.ANIME_LIST_MASTER_XML_URL ??
      'https://raw.githubusercontent.com/Anime-Lists/anime-lists/refs/heads/master/anime-list-master.xml',

    // Fribb-format mapping JSON (anidb_id -> anilist/mal/kitsu/tvdb/tmdb/...).
    // az4if's mirror is used by default since it's kept in sync; point this
    // at the upstream Fribb/anime-lists repo instead if you'd rather.
    fribbJsonUrl:
      process.env.FRIBB_JSON_URL ??
      'https://raw.githubusercontent.com/az4if/anime-lists-fribb/refs/heads/master/anime-list-full.json',

    // anime-and-manga/lists -- lean {idAL, idAniDB, idMal} triples, updated
    // daily. Used only as a freshness backfill for ids Fribb hasn't caught
    // up on yet (e.g. an anime that aired days ago) -- never overwrites an
    // id Fribb already supplied.
    animeJsonUrl: process.env.ANIME_JSON_URL ?? 'https://raw.githubusercontent.com/anime-and-manga/lists/main/anime.json',

    // Same repo's currently-airing snapshot -- gives "episodes aired so far"
    // and next-episode timing for the ~300 shows currently airing. See the
    // `airing`/`episodeProgress` column comments in schema.ts for what this
    // can and can't tell you.
    animeAiringJsonUrl:
      process.env.ANIME_AIRING_JSON_URL ?? 'https://raw.githubusercontent.com/anime-and-manga/lists/main/anime-airing.json'
  },

  adminKey: process.env.ADMIN_KEY ?? 'change-me'
};
