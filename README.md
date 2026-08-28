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
   curl -X POST http://localhost:3000/indexer/mapping/sync -H "x-admin-key: change-me"
   ```
   Change `ADMIN_KEY` in `.env` before deploying publicly.
5. **Confirm it worked:**
   ```bash
   curl http://localhost:3000/indexer/status
   ```
   `rowCounts.mapping` should read ~16,000-17,000 once the sync finishes.
   0 or an error -> see [Troubleshooting](#troubleshooting).
6. **Deploy** wherever you like, with the same env vars. Host sleeps when
   idle (Render free tier)? Also set `RENDER_KEEP_ALIVE=true` and
   `PUBLIC_URL`.
7. **Turn on scheduling:** set `ENABLE_SCHEDULER=true`. Nothing runs
   automatically until this is set.

## Environment variables

| Var | Default | What it does |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string. |
| `PORT` | `3000` | API port. |
| `ADMIN_KEY` | `change-me` | Required as `x-admin-key` on every `POST /indexer/*`. Change before deploying publicly. |
| `PUBLIC_URL` | *(empty)* | Render keep-alive self-ping target. Blank on localhost. |
| `RENDER_KEEP_ALIVE` | `false` | `true` only on Render free tier. |
| `ENABLE_SCHEDULER` | `false` | Turns on the in-process scheduler. |
| `MAPPING_SYNC_HOURS` | `3` | XML/Fribb/ids/airing refresh cadence. |
| `TVDB_SYNC_HOURS` | `6` | TVDB new+airing pass cadence. |
| `TVDB_FULL_SYNC_HOURS` | `720` | TVDB full-catalog pass cadence. |
| `INDEX_DELAY` | `5` | Seconds between individual TVDB requests. |
| `TVDB_API_KEY` / `TVDB_API_PIN` | *(empty)* | thetvdb.com/api-information. Most keys don't need a PIN -- leave blank and only add one if login rejects the key. |
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
| POST | `/indexer/tvdb/incremental` | new + airing tvdb_ids |
| POST | `/indexer/tvdb/full` | every mapped tvdb_id |

`POST` routes require an `x-admin-key` header matching `ADMIN_KEY`.

`GET /mappings` response:

```jsonc
{
  "ids": { "anidb": 23, "mal": 1, "anilist": 1, "tvdb": 76885, /* ...and more */ },
  "type": "TV",
  "title": "Cowboy Bebop",
  "airing": false,
  "episodeProgress": null,
  "nextEpisodeAt": null,
  "description": null,  // pending -- see CONTRIBUTING.md
  "image": null,
  "episodes": []
}
```

`ids.tvdb: null` means TVDB coverage doesn't exist for that anime (~56% of
the catalog) -- not an error.

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
