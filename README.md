<p align="center"><img src="public/favicon.png" width="120" height="120" alt="AniLink"></p>
<h1 align="center">AniLink</h1>

<p align="center">AniDB &lt;-&gt; TVDB/TMDB/AniList/MAL/Kitsu id and episode mapping API.</p>

Single always-on Node process (Render web service or your own machine). No
serverless -- the indexer runs long throttled loops a serverless function
would get killed mid-way through.

For how this works internally, why it's built this way, and testing, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Deploy

1. **Postgres:** Supabase or Neon. Not Render's own free Postgres -- deleted
   30 days after creation.
2. **Install + configure:**
   ```bash
   npm install
   cp .env.example .env
   ```
   Set `DATABASE_URL` in `.env`. Everything else has a working default --
   see [Environment variables](#environment-variables).
3. **Create the schema:**
   ```bash
   npm run db:generate
   npm run db:migrate
   ```
   Re-run `db:migrate` after any pull that changes `src/db/schema.ts` -- an
   out-of-sync schema is the #1 cause of `Internal Server Error`. (The
   catalog / overrides / source-state update added three tables:
   `catalog_entry`, `mapping_override`, `source_state`. Run `db:generate`
   once to create their migration, commit the new files in `drizzle/`, then
   `db:migrate`.)
4. **Seed the mapping table:**
   ```bash
   npm run dev
   curl -X POST http://localhost:3000/indexer/mapping/sync
   ```
   No `x-admin-key` header needed here since `ADMIN_KEY` is unset by
   default (open). Set `ADMIN_KEY` in `.env` and pass it as `x-admin-key`
   on every `POST /indexer/*` call **before deploying publicly** -- left
   unset, anyone can trigger these jobs.
5. **Fetch provider metadata, episodes, artwork, and validation data:** set
   `TVDB_API_KEY` in `.env` (register one at
   [thetvdb.com/api-information](https://thetvdb.com/api-information)) and
   optionally `TMDB_API_KEY`, then run the one ordered pipeline:
   ```bash
   curl -X POST http://localhost:3000/indexer/providers/incremental
   ```
   Each mapped entry first gets AniList validation metadata; it then uses
   TVDB when a TVDB ID exists, otherwise TMDB when mapped, and always ends
   with `api.ani.zip`. AniList and ani.zip need no API key. The pipeline
   saves artwork from both providers, multilingual titles, provider-ID gap
   fills, episode metadata, release dates, and relation/special references.
   It pauses for `INDEX_DELAY` seconds between entries, so run the first
   whole-catalog pass in the background.
6. **Confirm it worked:**
   ```bash
   curl http://localhost:3000/indexer/status
   ```
   `rowCounts.mapping` should read ~16,000-17,000 once the sync finishes.
   Run `curl -X POST http://localhost:3000/indexer/catalog/sync` once as well;
   `rowCounts.catalog_entry` should then read ~38,000 (see [Catalog](#catalog-anime-offline-database)).
   `rowCounts.tvdb_cache` grows as step 5 runs. 0 or an error -> see
   [Troubleshooting](#troubleshooting).
7. **Deploy** wherever you like, with the same env vars. On Render,
   create a **Web Service** from this repo and set:
   - **Build Command** -- runs once when building:
     ```
     npm install && npm run build
     ```
     (the `build` step runs `tsc`, producing `dist/`)
   - **Start Command** -- runs to actually launch your service, and
     re-runs on every restart:
     ```
     npm run db:migrate && npm start
     ```
     Running the migration here means the schema stays in sync
     automatically on every deploy/restart, instead of you having to
     re-run `db:migrate` by hand each time (see
     [Troubleshooting](#troubleshooting)).

   Host sleeps when idle (Render free tier, Hugging Face Spaces)? Also set
   `SELF_PING=true` and `PUBLIC_URL`.
8. **Turn on scheduling:** set `ENABLE_SCHEDULER=true`. Nothing runs
   automatically until this is set.

## Environment variables

| Var | Default | What it does |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string. |
| `PORT` | `3000` | API port. |
| `ADMIN_KEY` | *(empty)* | Required as `x-admin-key` on every `POST /indexer/*` -- but only if set. Unset or empty (the default) means those routes are **open, no key required**. Set a real value before deploying publicly. |
| `CORS_ORIGIN` | `*` | `*` allows any origin. Or a comma-separated allow-list, e.g. `https://domainone.com,https://domaintwo.com`, to restrict to specific origins only. |
| `RATE_LIMIT` | `100` | Max requests per IP per `RATE_LIMIT_WINDOW_SEC`, applied to every route. `0` disables it (unlimited). |
| `RATE_LIMIT_WINDOW_SEC` | `60` | Window (seconds) the `RATE_LIMIT` count applies to. |
| `COMPRESSION` | `true` | Brotli when the client sends `Accept-Encoding: br`, gzip otherwise. `false` disables it (e.g. if a proxy/CDN already compresses). |
| `COMPRESSION_MIN_BYTES` | `1024` | Responses smaller than this are sent uncompressed. |
| `BROTLI_QUALITY` | `4` | Brotli quality 0-11. 4 keeps most of the size win at near-gzip speed; 11 is far too slow per request. |
| `PUBLIC_URL` | *(empty)* | Self-ping target. Blank on localhost. |
| `SELF_PING` | `false` | `true` only on hosts that sleep when idle (Render free tier, Hugging Face Spaces). |
| `ENABLE_SCHEDULER` | `false` | Turns on the in-process scheduler. |
| `MAPPING_SYNC_HOURS` | `3` | XML/Fribb/ids/airing refresh cadence. Sources that have not changed are skipped, so this is cheap. |
| `CATALOG_SYNC_HOURS` | `24` | anime-offline-database catalog refresh cadence (the upstream file changes about weekly). |
| `SYNC_MAX_DROP_PERCENT` | `10` | A source whose row count fell by more than this since its last good run is **rejected** and the existing data left alone. See [Safety checks](#safety-checks-on-the-sources). |
| `FORCE_SOURCE_REFRESH` | `false` | `true` = ignore "unchanged" detection and the size guard on every sync. For debugging; prefer `?force=true` on a single call. |
| `AOD_URL` | cedya77/anime-offline-database `latest` release (`.jsonl`) | Catalog source. A URL ending in `.json` is read as the single-document `-minified.json` variant. `.zst` files are not supported. |
| `PROVIDER_SYNC_HOURS` | `6` | Unified AniList → TVDB/TMDB fallback → ani.zip incremental pass cadence. |
| `PROVIDER_FULL_SYNC_HOURS` | `720` | Unified provider full-catalog pass cadence. |
| `INDEX_DELAY` | `5` | Seconds between complete provider-pipeline entries, including AniList and ani.zip. |
| `TVDB_API_KEY` / `TVDB_API_PIN` | *(empty)* | thetvdb.com/api-information. Most keys don't need a PIN -- leave blank and only add one if login rejects the key. |
| `TVDB_API_URL` | `https://api4.thetvdb.com/v4` | Base URL for the TVDB v4 API. Not the same thing as `TVDB_API_KEY` -- only override this if you're pointing at something other than the real API. |
| `TMDB_API_KEY` | *(empty)* | TMDB v4 Read Access Token. Enables TMDB TV/movie metadata, episode fallback, and artwork indexing. |
| `TMDB_API_URL` / `TMDB_IMAGE_URL` | TMDB production URLs | Override only for a proxy/mock. |
| `ANI_ZIP_PATH` | `./ani.zip` | Optional local JSON-in-ZIP cross-reference source; full source records are retained. |
| `ANI_ZIP_API_URL` | `https://api.ani.zip` | Remote metadata enrichment source; no key required. |
| `ANILIST_API_URL` | `https://graphql.anilist.co` | AniList GraphQL endpoint for episode totals, release/air data, titles, and relations; no key required. |
| `ANIME_LIST_MASTER_XML_URL` | Anime-Lists/anime-lists | Override to point at a fork/mirror. |
| `FRIBB_JSON_URL` | Fribb/anime-lists | Same. |
| `ANIME_JSON_URL` | anime-and-manga/lists | Same. |
| `ANIME_AIRING_JSON_URL` | anime-and-manga/lists | Same. |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/mappings?anidb_id=` | Also accepts `mal_id`, `anilist_id`, `kitsu_id`, `anisearch_id`, `notifymoe_id`, `livechart_id`, `thetvdb_id`, `themoviedb_id`, `imdb_id`, and `animeplanet_id`. Titles with no AniDB id are answered from the [catalog](#catalog-anime-offline-database) when looked up by `mal_id`, `anilist_id`, `kitsu_id`, `anisearch_id`, `livechart_id`, or `animeplanet_id`. |
| GET | `/health` | `200` when DB reachable, `503` when not -- self-heals, no restart needed |
| GET | `/indexer/status` | job history + row counts. Check this first for any issue. |
| GET | `/indexer/queue/status` | what's running/pending right now |
| POST | `/indexer/mapping/sync` | all mapping sources + catalog gap-fill + overrides. `?force=true` re-processes unchanged sources and bypasses the size guard. |
| POST | `/indexer/mapping/refresh` | XML only (also accepts `?force=true`) |
| POST | `/indexer/mapping/fribb-refresh` | Fribb only (also accepts `?force=true`) |
| POST | `/indexer/mapping/lists-refresh` | lists-main ids + airing (also accepts `?force=true`) |
| POST | `/indexer/mapping/ani-zip-refresh` | optional local ani.zip import |
| POST | `/indexer/catalog/sync` | anime-offline-database catalog (also accepts `?force=true`) |
| GET | `/indexer/overrides` | stored manual corrections + the fields that can be overridden |
| PUT | `/indexer/overrides/:anidbId/:field` | add/replace a correction. Body `{ "value": <json>, "reason": "..." }`; `null` clears the field |
| DELETE | `/indexer/overrides/:anidbId/:field` | remove a correction (queues a forced sync to restore the source value) |
| POST | `/indexer/overrides/apply` | re-apply all corrections now |
| GET | `/indexer/reports` | data-quality counts: no AniList id, no TVDB/TMDB, no image, id conflicts, catalog-only |
| GET | `/indexer/reports/:kind` | the rows behind one report (`?limit=&offset=`) |
| POST | `/indexer/providers/incremental` | unified new + airing provider pass |
| POST | `/indexer/providers/full` | unified whole-catalog provider pass |

Every provider pass begins with AniList when an AniList ID is mapped, then
uses TVDB or TMDB as its episode provider. The final stage calls
[`api.ani.zip/mappings`](https://api.ani.zip/mappings?anilist_id=21). The
stored response retains the exact lookup URL under `providers.aniZip.url`.

`POST` routes require an `x-admin-key` header matching `ADMIN_KEY` -- unless
`ADMIN_KEY` is unset/empty, in which case they're open to anyone.

Generate a key and set it in `.env`:

```bash
openssl rand -hex 32
```

```
ADMIN_KEY=<paste-the-generated-key-here>
```

Then include it on every `POST /indexer/*` call:

```bash
curl -X POST http://localhost:3000/indexer/mapping/sync \
  -H "x-admin-key: your-admin-key-here"
```

`GET /mappings` response, once provider data has been fetched for this title
(see [Environment variables](#environment-variables) for `TVDB_API_KEY` --
without a key set, or before the first provider sync
finishes for a given title, `description`/`image`/`episodes` are `null`/
`[]` rather than faked):

```jsonc
{
  "ids": { "anidb": 23, "mal": 1, "anilist": 1, "tvdb": 76885, /* ...and more */ },
  "type": "TV",
  "title": "Cowboy Bebop",
  "titles": { "en": "Cowboy Bebop", "ja": "カウボーイビバップ" },
  "airing": false,
  "episodeProgress": null,
  "nextEpisodeAt": null,
  "description": "In the year 2071, a ragtag crew of bounty hunters...",
  "image": "https://artworks.thetvdb.com/banners/posters/76885-1.jpg",
  "artworks": [
    { "source": "tvdb", "type": "poster", "url": "...", "language": "eng" },
    { "source": "tmdb", "type": "background", "url": "...", "language": null },
    { "source": "ani-zip", "type": "logo", "url": "...", "language": null }
  ],
  "episodes": [
    { "number": 1, "season": 1, "episode": 1, "absoluteNumber": 1, "title": "Asteroid Blues", "titleEn": "Asteroid Blues", "titles": { "en": "Asteroid Blues", "ja": "アステロイド・ブルース" }, "anidbEpisodeId": 881, "overview": "...", "overviewEn": "...", "aired": "1998-04-03", "image": "https://artworks.thetvdb.com/banners/episodes/76885/219120.jpg", "imageSource": "tvdb" }
    /* ...and so on */
  ],
  "anilist": {
    "id": 1,
    "episodes": 26,
    "status": "FINISHED",
    "relations": [],
    "validation": { "expectedEpisodeCount": 26, "indexedEpisodeCount": 26, "episodeCountStatus": "match" }
  },
  "relatedSpecials": []
}
```

`episodes[].number` is the canonical AniDB regular-episode number
(`season`/`episode` are TVDB's own). `title`/`overview` are whatever
language TVDB's default record happens to be in; `titleEn`/`overviewEn`
are always English specifically (fetched via TVDB's per-episode
translations endpoint), `null` when no English translation exists for
that episode at all -- not an error. Specials aren't included -- see
CONTRIBUTING.md for why.

`episodes[].image` is the episode thumbnail and `episodes[].imageSource`
says which provider it came from (`tvdb`, `tmdb`, `ani-zip`; `anilist` and
`kitsu` are reserved for sources not wired up yet). The episode list itself
always comes from one provider, but if that provider has no thumbnail for an
episode, the same episode number's thumbnail from the next provider is used
(order: tvdb, tmdb, ani-zip). If nobody has one, both fields are `null` --
nothing is invented.

Responses are compressed with Brotli when the client sends
`Accept-Encoding: br`, otherwise gzip (see `COMPRESSION` below).

`anilist.validation` makes disagreement visible instead of silently joining
multiple related entries. `relatedSpecials` exposes referenced OVA, ONA, and
special entries with their release dates and known episode counts. They are
not injected into the main regular-episode list.

For an airing title, `episodeProgress` is a hard publication ceiling:
provider data for a scheduled next episode may be cached, but it is never
returned by `/mappings` until the current-airing feed advances to that
episode. A title at episode 1175 therefore returns at most episode 1175.

`ids.tvdb: null` means TVDB coverage doesn't exist for that anime (~56% of
the catalog) -- not an error. If its mapping has a TMDB ID, the TMDB pass
supplies the response description/image/episodes instead. Full unmodified
TVDB extended records and TMDB API records stay in `tvdb_cache` and
`tmdb_cache`. The ani.zip API response stays separately cached in
`ani_zip_cache`, preserving all language titles and fields such as direct
AniDB/TVDB episode IDs. AniList records and conservative relation segments
stay in `anilist_cache` and `anime_segment`. `artworks` is the normalized,
provenance-preserving view.

## Catalog (anime-offline-database)

AniLink's `mapping` table is keyed on AniDB, so a title with no AniDB id
cannot have a row there. About 60% of
[cedya77/anime-offline-database](https://github.com/cedya77/anime-offline-database)
has no AniDB id (roughly 18,000 of its 38,000 entries still carry an AniList or
MAL id), so it is kept in its own `catalog_entry` table and used three ways:

- **Lookup fallback.** `GET /mappings?anilist_id=...` (or `mal_id`,
  `kitsu_id`, ...) for a title with no AniDB entry returns the same response
  shape with the ids, title, type, episode count, status and poster the
  catalog knows. TVDB/TMDB ids and episodes are honestly empty.
- **Gap-fill.** Empty provider-id columns on `mapping` rows are filled from the
  catalog entry with the same AniDB id. Existing values are never overwritten;
  where the sources disagree, `GET /indexer/reports/id-conflicts` shows it.
- **Fallback image + extras.** Every `/mappings` response gains a `catalog`
  block (synonyms, tags, studios, season, score, related ids) and, when no
  better source supplied one, a poster (`artworks[].source: "aod"`). Posters
  are hotlinked provider CDN URLs (mostly MyAnimeList), and the dataset's shared
  "no picture" placeholder is dropped rather than served.

Data attribution: contains information from
[cedya77/anime-offline-database](https://github.com/cedya77/anime-offline-database),
the continuation of
[manami-project/anime-offline-database](https://github.com/manami-project/anime-offline-database),
made available under the
[ODbL v1.0](https://opendatacommons.org/licenses/odbl/1-0/) with contents under the
[DbCL v1.0](https://opendatacommons.org/licenses/dbcl/1-0/). Their licence asks for
attribution of both projects and applies share-alike terms to a database you
redistribute -- check that against AniLink's own licence below if you expose
this data publicly.

## Safety checks on the sources

The remote sources are community-maintained files, and they occasionally break.

- **Unchanged sources are skipped.** Each source's ETag / Last-Modified and a
  SHA-256 of its content are stored in `source_state`; an unchanged file costs
  one conditional request and no DB writes. A source is only marked as
  processed after it finished, so an interrupted run is retried, not skipped.
- **Shrunken sources are rejected.** If a source's row count dropped by more
  than `SYNC_MAX_DROP_PERCENT` (airing: 60%) since its last good run, or it is
  empty, the sync refuses it and keeps the existing data. `GET /indexer/status`
  shows each source's `lastStatus` / `lastError`. After checking that upstream
  really did shrink, re-run with `?force=true`.
- **One bad source no longer stops the others.** Each step of a mapping sync is
  isolated and failures are collected in the job result.

## Manual overrides

When a community source is wrong, fixing the `mapping` row directly does not
last -- the next sync overwrites it. An override is stored separately and
re-applied **after every sync**, so it always wins:

```bash
# pin the right TVDB series for AniDB 1234
curl -X PUT http://localhost:3000/indexer/overrides/1234/tvdbId \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{ "value": 98765, "reason": "xml maps this cour to the wrong series" }'

# force a wrong MAL id empty
curl -X PUT http://localhost:3000/indexer/overrides/1234/malId \
  -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{ "value": null, "reason": "points at a different cour" }'
```

Overridable fields: provider ids (`anilistId`, `malId`, `kitsuId`, `livechartId`,
`anisearchId`, `animePlanetId`, `animeNewsNetworkId`, `animeCountdownId`,
`simklId`, `notifyMoeId`, `tvdbId`, `tmdbTvId`, `tmdbMovieIds`, `imdbIds`),
`type`, `title`, and the season/offset columns (`defaultTvdbSeason`,
`tvdbEpisodeOffset`, `defaultTmdbSeason`, `tmdbEpisodeOffset`, `tvdbAbsolute`,
`tmdbAbsolute`). Rows whose values change are re-merged immediately.
`GET /indexer/reports` lists where corrections are most likely needed.

## Troubleshooting

**`Internal Server Error` on a DB route.** Schema out of sync. Run
`npm run db:migrate` against your deployed `DATABASE_URL`.
`GET /indexer/status` names the missing table/column instead of failing
blank, if you want to confirm first.

**Database not growing.** Check `GET /indexer/status`. If
`scheduler.enabled` is `false` and nothing external is pinging
`/indexer/*`, nothing was ever told to run -- set `ENABLE_SCHEDULER=true`.

**DB connection blip.** Self-heals automatically, nothing to do. If
`/health` stays `503` for minutes after the DB is actually reachable again,
that's a bug worth reporting.

## License

AniLink is licensed under a custom **Non-Commercial License** -- free to
use, modify, and self-host for personal, educational, or non-profit
purposes, with attribution. Commercial use requires prior written
permission from the copyright holder. See [LICENSE.md](LICENSE.md) for
full terms.
