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
    apiPin: process.env.TVDB_API_PIN ?? '',
    // Base URL for the TVDB v4 API itself. NOT the same thing as
    // TVDB_API_KEY (the long-lived credential from
    // thetvdb.com/api-information) and NOT the same thing as the Bearer
    // token the app exchanges that key for at runtime -- see the docstring
    // on getToken() in tvdb-client.ts.
    baseUrl: process.env.TVDB_API_URL ?? 'https://api4.thetvdb.com/v4'
  },

  tmdb: {
    // TMDB v4 Read Access Token. This is deliberately separate from TVDB;
    // an empty value simply skips TMDB enrichment rather than failing a run.
    apiKey: process.env.TMDB_API_KEY ?? '',
    baseUrl: process.env.TMDB_API_URL ?? 'https://api.themoviedb.org/3',
    imageBaseUrl: process.env.TMDB_IMAGE_URL ?? 'https://image.tmdb.org/t/p'
  },

  aniZip: {
    apiUrl: process.env.ANI_ZIP_API_URL ?? 'https://api.ani.zip'
  },

  // Delay after each single "ask this provider for one anime's episode
  // data, get the response, index it" step, before moving to the next id.
  // Shared by the TVDB and TMDB per-id provider loops. See
  // sequential-runner.ts.
  indexDelayMs: Number(process.env.INDEX_DELAY ?? 5) * 1000,

  // All static-file mapping sources. Every one is overridable via env so a
  // fork/mirror URL can be swapped in without touching code.
  sources: {
    // A local, optional archive. Its importer understands common JSON
    // layouts and preserves every original entry in ani_zip_cache.
    aniZipPath: process.env.ANI_ZIP_PATH ?? `${process.cwd()}/ani.zip`,
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

  // Unset or empty -> POST /indexer/* is open, no key required (see
  // requireAdmin in indexer.routes.ts). Set a real value before deploying
  // publicly.
  adminKey: process.env.ADMIN_KEY ?? '',

  // CORS. "*" (the default) allows any origin. Set to a comma-separated
  // allow-list -- e.g. "https://domainone.com,https://domaintwo.com" -- to
  // restrict browser access to those origins only. See src/index.ts for
  // how this is parsed and applied.
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  // Per-IP rate limit, applied to every route. 0 disables it (unlimited).
  // See src/helpers/rate-limit.ts.
  rateLimit: {
    limit: Number(process.env.RATE_LIMIT ?? 100),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_SEC ?? 60) * 1000
  },

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
    // Unified pipeline timing.
    providerSyncHours: Number(process.env.PROVIDER_SYNC_HOURS ?? 6),
    providerFullSyncHours: Number(process.env.PROVIDER_FULL_SYNC_HOURS ?? 24 * 30)
  }
};
