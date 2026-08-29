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
   out-of-sync schema is the #1 cause of `Internal Server Error`.
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

   Host sleeps when idle (Render free tier)? Also set
   `RENDER_KEEP_ALIVE=true` and `PUBLIC_URL`.
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
| `PUBLIC_URL` | *(empty)* | Render keep-alive self-ping target. Blank on localhost. |
| `RENDER_KEEP_ALIVE` | `false` | `true` only on Render free tier. |
| `ENABLE_SCHEDULER` | `false` | Turns on the in-process scheduler. |
| `MAPPING_SYNC_HOURS` | `3` | XML/Fribb/ids/airing refresh cadence. |
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
| GET | `/mappings?anidb_id=` | also accepts `mal_id`, `anilist_id`, `thetvdb_id` |
| GET | `/health` | `200` when DB reachable, `503` when not -- self-heals, no restart needed |
| GET | `/indexer/status` | job history + row counts. Check this first for any issue. |
| GET | `/indexer/queue/status` | what's running/pending right now |
| POST | `/indexer/mapping/sync` | all 4 mapping sources |
| POST | `/indexer/mapping/refresh` | XML only |
| POST | `/indexer/mapping/fribb-refresh` | Fribb only |
| POST | `/indexer/mapping/lists-refresh` | lists-main ids + airing |
| POST | `/indexer/mapping/ani-zip-refresh` | optional local ani.zip import |
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
    { "number": 1, "season": 1, "episode": 1, "absoluteNumber": 1, "title": "Asteroid Blues", "titleEn": "Asteroid Blues", "titles": { "en": "Asteroid Blues", "ja": "アステロイド・ブルース" }, "anidbEpisodeId": 881, "overview": "...", "overviewEn": "...", "aired": "1998-04-03", "image": null }
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
