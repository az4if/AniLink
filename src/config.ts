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

  // Delay after each single "ask this provider for one anime's episode
  // data, get the response, index it" step, before moving to the next id.
  // Named generically (not TVDB_INDEX_DELAY) since any future per-id
  // provider loop uses the same sequential-runner.ts and the same knob --
  // right now that's just TVDB. See sequential-runner.ts.
  indexDelayMs: Number(process.env.INDEX_DELAY ?? 5) * 1000,

  // All static-file mapping sources. Every one is overridable via env so a
  // fork/mirror URL can be swapped in without touching code.
  sources: {
    animeListMasterXmlUrl:
      process.env.ANIME_LIST_MASTER_XML_URL ??
      'https://raw.githubusercontent.com/Anime-Lists/anime-lists/refs/heads/master/anime-list-master.xml',

    // Fribb-format mapping JSON (anidb_id -> anilist/mal/kitsu/tvdb/tmdb/...).
    // Upstream Fribb/anime-lists repo.
    fribbJsonUrl:
      process.env.FRIBB_JSON_URL ??
      'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json',

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

  adminKey: process.env.ADMIN_KEY ?? 'change-me',

  // In-process scheduler. Off by default -- on a free-tier host that sleeps
  // when idle, an external pinger (cron-job.org) hitting POST /indexer/*
  // is more reliable than a timer inside a process that might not be
  // running when the timer fires. Turn this on for an always-on host
  // (paid Render, your own machine) if you'd rather not run an external
  // pinger. Either way, the same jobs go through the same priority queues.
  scheduler: {
    enabled: (process.env.ENABLE_SCHEDULER ?? 'false').toLowerCase() === 'true',
    // XML + Fribb + lists-main ids + lists-main airing, all refreshed together
    mappingSyncHours: Number(process.env.MAPPING_SYNC_HOURS ?? 3),
    // TVDB, new + currently-airing tvdb_ids only (naturally == everything
    // on the very first run, since nothing's cached yet -- see tvdb-targets.ts)
    tvdbSyncHours: Number(process.env.TVDB_SYNC_HOURS ?? 6),
    // TVDB, full resync of every mapped tvdb_id regardless of cache state
    tvdbFullSyncHours: Number(process.env.TVDB_FULL_SYNC_HOURS ?? 24 * 30)
  }
};
