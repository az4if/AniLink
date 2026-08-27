<p align="center"><img src="public/favicon.png" width="120" height="120" alt="AniLink"></p>
<h1 align="center">AniLink</h1>

<p align="center">AniDB &lt;-&gt; TVDB/TMDB/AniList/MAL/Kitsu id and episode mapping API.</p>

Runs as a single always-on Node process (Render web service or your own
machine) -- no serverless, since the indexer runs long throttled loops that
a serverless function would just get killed mid-way through.

## Deploy

1. **Get a Postgres database.** Supabase or Neon, not Render's own free
   Postgres -- that one is deleted 30 days after creation, which will
   quietly wipe out a mirror that took real time to build.
2. **Clone this repo, install, configure.**
   ```bash
   npm install
   cp .env.example .env
   ```
   Open `.env` and set `DATABASE_URL` at minimum. Everything else has a
   working default -- see [Environment variables](#environment-variables)
   for what each one does.
3. **Create the schema.**
   ```bash
   npm run db:generate   # generates SQL from src/db/schema.ts
   npm run db:migrate    # applies it -- same command works against
                          # Supabase, Neon, self-hosted, or local Postgres
   ```
   **Re-run `db:migrate` every time you pull code that changed
   `src/db/schema.ts`.** A schema that's out of sync with the code is the
   single most common cause of `Internal Server Error` -- see
   [Troubleshooting](#troubleshooting).
4. **Seed the mapping table** (takes a few minutes, all four sources are
   static file downloads, no rate limit):
   ```bash
   npm run dev   # starts the server
   ```
   ```bash
   curl -X POST http://localhost:3000/indexer/mapping/sync -H "x-admin-key: change-me"
   ```
   (`change-me` is the default `ADMIN_KEY` -- change it in `.env` before
   deploying anywhere public.)
5. **Confirm it actually worked:**
   ```bash
   curl http://localhost:3000/indexer/status
   ```
   `rowCounts.mapping` should read somewhere around 16,000-17,000 once the
   sync finishes. If it reads 0 or the request errors, see
   [Troubleshooting](#troubleshooting) before doing anything else.
6. **Deploy the app itself** wherever you like (Render, your own box, etc).
   Set the same env vars there. If the host sleeps when idle (Render free
   tier), also set `RENDER_KEEP_ALIVE=true` and `PUBLIC_URL` to your
   deployed URL.
7. **Turn on scheduling** -- see [The schedule](#the-schedule-in-plain-terms)
   below. Nothing runs automatically until you do this step.

## Environment variables

| Var | Default | What it does |
|---|---|---|
| `DATABASE_URL` | *(required)* | Postgres connection string. Same format for every provider. |
| `PORT` | `3000` | What port the API listens on. |
| `ADMIN_KEY` | `change-me` | Required as `x-admin-key` header on every `POST /indexer/*` route. **Change this before deploying publicly.** |
| `PUBLIC_URL` | *(empty)* | Only used by the Render keep-alive self-ping. Leave blank on localhost. |
| `RENDER_KEEP_ALIVE` | `false` | Set `true` only on Render's free tier, so the instance doesn't sleep after 15 min idle. |
| `ENABLE_SCHEDULER` | `false` | Turns on the in-process scheduler. See [The schedule](#the-schedule-in-plain-terms). |
| `MAPPING_SYNC_HOURS` | `3` | How often the XML/Fribb/ids/airing sources refresh together. |
| `TVDB_SYNC_HOURS` | `6` | How often the "new + currently-airing only" TVDB pass runs. |
| `TVDB_FULL_SYNC_HOURS` | `720` (30 days) | How often TVDB re-checks *everything*, not just new/airing. |
| `INDEX_DELAY` | `5` | Seconds to wait between each individual TVDB request (ask id 1, wait, ask id 2, wait, ...). |
| `TVDB_API_KEY` / `TVDB_API_PIN` | *(empty)* | From thetvdb.com/api-information. PIN is only needed for "user-supported" keys -- see below. |
| `ANIME_LIST_MASTER_XML_URL` | Anime-Lists/anime-lists | Only set if pointing at a fork/mirror. |
| `FRIBB_JSON_URL` | Fribb/anime-lists | Same. |
| `ANIME_JSON_URL` | anime-and-manga/lists | Same. |
| `ANIME_AIRING_JSON_URL` | anime-and-manga/lists | Same. |

`TVDB_API_PIN`: most keys created today don't need one at all -- try
without it first (leave it blank). If TVDB's login rejects the key with a
"pin required" error, that specific key was issued under the
"user-supported" funding model and needs a personal PIN from a
thetvdb.com/subscribe subscription.

## The schedule, in plain terms

Nothing runs automatically until `ENABLE_SCHEDULER=true` is set. That's the
single most common reason a fresh deploy looks like it's "not indexing" --
it isn't broken, it's just never been told to start. (The alternative to
this switch: an outside service like cron-job.org calling the
`POST /indexer/*` URLs below on a timer instead. Either works; you need one
of them.)

Once it's on, two alarm clocks:

1. **Every `MAPPING_SYNC_HOURS`** (default 3) -- re-downloads all four
   mapping sources (XML, Fribb, lists-main ids, lists-main airing) and
   updates the `mapping` table. After each run, it knows exactly which
   anidb_ids are brand new since last time.
2. **Every `TVDB_SYNC_HOURS`** (default 6) -- asks TVDB for episode data,
   but *only* for anime that are either currently airing (always worth
   rechecking) or have never been asked about before. The very first time
   this runs, "never asked before" means *everything*, so it's slow --
   every subsequent run only touches the small new+airing subset, so it's
   fast. There's also **`TVDB_FULL_SYNC_HOURS`** (default 30 days) which
   ignores that shortcut and re-asks about every single mapped anime,
   catching anything that slipped through (e.g. an anime that gained a
   TVDB mapping later on).

These never run at the same time as each other within their own lane --
mapping jobs queue behind mapping jobs, TVDB jobs queue behind TVDB jobs --
so nothing can corrupt a write by overlapping itself. The two lanes are
otherwise independent of each other.

## The queue

Two separate queues (`src/scheduler/queue.ts`):

- **`jsonQueue`** -- the four mapping sources. No external rate limit here,
  this queue exists purely so two of them can't write to the DB at once.
- **`tvdbQueue`** -- TVDB jobs. This one matters for a real reason: TVDB
  has one shared rate budget, so if a fast, urgent job (like the
  new+airing check) needs to run while a slow full sweep is in progress,
  the slow one has to make room.

"Make room" means cooperative yielding, not getting killed mid-write: the
running job checks a `shouldYield()` flag between each unit of work and, if
true, saves exactly where it was (in `indexer_state`) and stops -- the next
run of that same job picks up right where it left off instead of starting
over.

## API

**`GET /mappings?anidb_id=18278`** (also accepts `mal_id`, `anilist_id`,
`thetvdb_id`) -- the public endpoint. Returns:

```jsonc
{
  "ids": { "anidb": 23, "mal": 1, "anilist": 1, "tvdb": 76885, /* ...and more */ },
  "type": "TV",
  "title": "Cowboy Bebop",
  "airing": false,
  "episodeProgress": null,
  "nextEpisodeAt": null,
  "description": null,  // pending the TVDB fetcher -- see below
  "image": null,         // pending the TVDB fetcher
  "episodes": []         // pending the TVDB fetcher
}
```

If a `tvdb_id` genuinely doesn't exist for an anime (no TVDB entry at all --
true for about 56% of the catalog, mostly movies/OVAs/very obscure titles),
that's not an error or a bug: `ids.tvdb` is just `null`, meaning "TVDB
coverage for this anime doesn't exist," and TVDB-derived fields stay empty
permanently for it. The monthly full resync (`TVDB_FULL_SYNC_HOURS`) will
pick it up automatically the moment any of the four mapping sources
*does* find a tvdb_id for it later -- nothing extra to do.

**`GET /health`** -- `200` + `database: "ok"` when the DB answers, `503` +
`database: "error"` when it doesn't. Self-heals automatically once the DB
comes back; no restart needed.

**`GET /indexer/status`** -- the "is this actually running?" endpoint. For
each job: has it ever run, when did it last checkpoint, and current row
counts. Check this first, always, before assuming something's broken.

**`GET /indexer/queue/status`** -- what's running/pending in both queues
right now.

**`POST /indexer/mapping/sync`**, **`/mapping/refresh`**,
**`/mapping/fribb-refresh`**, **`/mapping/lists-refresh`**,
**`/tvdb/incremental`**, **`/tvdb/full`** -- manual triggers, all
admin-key gated (`x-admin-key` header), all go through the same queues the
scheduler uses.

## Troubleshooting

**`Internal Server Error` on any route that touches the database.** Almost
always a schema mismatch -- code expects a table/column that doesn't exist
on your actual deployed database yet. Run `npm run db:migrate` against the
same `DATABASE_URL` your deployment uses. `GET /indexer/status` will also
directly name the missing table/column in its response instead of just
failing blank, if you want to confirm before migrating.

**Database isn't growing / nothing seems to be indexing.** Check
`GET /indexer/status`. If `scheduler.enabled` is `false` and you don't have
an external pinger hitting `/indexer/*`, that's the whole story -- nothing
was ever told to run. Set `ENABLE_SCHEDULER=true` (and redeploy), or
configure a pinger, then check `/indexer/status` again after a few minutes.

**A DB connection blip.** The app reconnects on its own; nothing to do. If
`/health` shows `503` and doesn't recover within a minute or two of your
database actually being reachable again, that's worth reporting as a bug --
it isn't expected behavior.

## How it works

Three of the four mapping sources are static file downloads (XML, Fribb,
lists-main) -- no live scraping, no auth needed for any of them:

| Source | Owns |
|---|---|
| `anime-list-master.xml` (Anime-Lists/anime-lists) | tvdb/tmdb ids, season+offset, per-episode mapping-list overrides -- **primary**, richest source |
| Fribb-format JSON (Fribb/anime-lists) | anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/animecountdown/simkl ids, `type` -- plus gap-fills tvdb/tmdb/imdb/season/offset for anime the XML source left completely unmapped (never overwrites what XML already found) |
| `anime.json` (anime-and-manga/lists) | anilist/mal id, freshness-only -- fills gaps Fribb hasn't caught up on yet, never overwrites |
| `anime-airing.json` (anime-and-manga/lists) | `airing` / `episodeProgress` / `nextEpisodeAt`, for currently-airing shows only |

**No live AniDB API access.** AniDB's website sits behind Cloudflare, which
blocks datacenter/cloud IPs by default, and AniDB's own policy is that its
client API isn't meant to be hit from a VPS anyway -- only a residential
connection. Rather than fight that, AniLink never calls AniDB directly. IDs
come entirely from the sources above; TVDB (once its fetcher exists) is
canonical for actual episode data, not just enrichment. Trade-off:
specials/OVA/OP/ED/trailer episodes aren't mappable this way, since those
only exist as distinct entries because of AniDB's own numbering scheme.
Not supported for v1.

**The resolver** (`src/mapping/resolver.ts`) is the piece that turns an
AniDB-style regular episode number into the matching TVDB season/episode,
using the per-episode `mapping-list` overrides when present and a plain
season+offset formula otherwise. It also runs in reverse
(`reverseResolveRegular`) -- given a TVDB episode TVDB actually has, work
out which regular-episode number it corresponds to. That's what lets
episode enumeration be driven entirely by TVDB's own episode list once
fetched, instead of needing a separately-sourced total episode count.
Tested against a round-trip property across all 430,332 unambiguous
episodes in the real XML file (a small number of destinations are
genuinely ambiguous in the source data itself -- e.g. Ghost in the Shell
explicitly maps six different AniDB catalog entries to the same one TVDB
episode -- and are excluded from that count rather than miscounted as
passing).

**Outbound requests** use a real browser `User-Agent` (`src/helpers/fetch.ts`)
rather than Node's bare default, since a headerless automated request is
exactly what some bot-detection heuristics flag regardless of whether the
request is otherwise legitimate.

## What's built vs. pending

Built: full mapping ingest from all four sources, the resolver (forward +
reverse, tested against real data), the job queue and scheduler (tested,
including a regression test for a real `setInterval` 32-bit overflow bug
found during development), the resumable/rate-limited per-id runner TVDB
will use, `/mappings`, `/health`, and the full `/indexer/*` diagnostic and
control surface.

Pending: the actual TVDB API client. `src/mapping/tvdb-index.ts` has a
clearly-marked stub where it goes -- the selection logic (which ids need
fetching), the rate limiting, the resumable queue-integrated loop around it
are all real and tested; only the actual HTTP call to TVDB itself isn't
written yet. Once it exists, `description`/`image`/`episodes` in the
`/mappings` response populate automatically, no other code needs to change.

Also open: episode data for the ~56% of the catalog with no TVDB mapping at
all. Nothing sources episode lists for those right now.

## Testing

```bash
npm test                                # resolver: 19 assertions against real XML data
npx tsx test/sources.test.ts            # Fribb + lists-main parsers against real JSON
npx tsx test/response.test.ts           # /mappings response shape
npx tsx test/queue.test.ts              # JobQueue: FIFO, priority preemption, dedup
npx tsx test/scheduler.test.ts          # regression test for the setInterval overflow bug
npx tsx test/sequential-runner.test.ts  # per-id ask/get/index/wait loop timing + resume + yield
npx tsx test/tvdb-targets.test.ts       # "first run = everything, later runs = new+airing" (needs DATABASE_URL)
npx tsx test/fribb-gapfill.test.ts      # Fribb gap-fill never overwrites XML data (needs DATABASE_URL)
```

`test/stress.manual.ts` runs every one of the ~16,865 real
`anime-list-master.xml` entries through the resolver just to check nothing
throws: 0 crashes, 9,400 anime with no TVDB association, 74 using absolute
numbering, 1,428 with per-episode overrides.
