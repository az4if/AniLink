<p align="center"><img src="public/favicon.png" width="120" height="120" alt="AniLink"></p>
<h1 align="center">AniLink</h1>

AniDB &lt;-&gt; TVDB/TMDB/AniList/MAL episode mapping API. AniDB's episode list is
canonical; TVDB/TMDB data enriches it (title/overview/image) where a mapping
exists. Same design as zenshin-API, rebuilt so the mapping-resolution logic
is transparent and testable instead of a black box.

Runs as a single always-on Node process (Render web service or your own
machine) -- no serverless, since the indexer needs to run long throttled
loops that a serverless function would just get killed mid-way through.

## Design decision: no live AniDB API access

AniDB's website (and likely its API subdomain) sits behind Cloudflare, which
blocks datacenter/cloud IPs by default -- and AniDB's own long-standing
policy is that its client API isn't meant to be hit from a VPS/cloud server
anyway, only a residential connection. Rather than fight that, AniLink
doesn't call AniDB at all:

- IDs (anidb_id, anilist_id, mal_id, tvdb_id, tmdb_id, ...) come from
  `anime-list-master.xml` + Fribb's JSON + `lists-main` -- all static file
  downloads, no live AniDB traffic.
- Episode *count* comes from AniList's public GraphQL API (no auth, no
  Cloudflare, cloud-host-friendly) or `lists-main` if it's already there.
- TVDB is canonical for actual episode data (title/overview/image/airdate),
  not just enrichment. Regular episodes are numbered 1..episodeCount and fed
  straight into the resolver -- AniDB's own regular-episode numbering is
  always sequential, so this produces the same result as fetching the list
  from AniDB directly would have.
- **Trade-off:** specials/OVA/OP/ED/trailer episodes aren't mappable this
  way -- those only exist as distinct entries because AniDB assigns them
  their own S1/T1/O1-style numbers, which is exactly what the
  `mapping-list` overrides in anime-lists-xml are keyed against. Not
  supported for v1.

## What's actually built right now

- [x] Postgres schema (`src/db/schema.ts`) -- `mapping`, `tvdb_cache`,
      `anime` (final/served), `indexer_state` (resumable cursors)
- [x] `anime-list-master.xml` parser + ingest (`src/mapping/xml-parser.ts`,
      `src/mapping/ingest.ts`) -- primary source, owns tvdb/tmdb ids,
      season/offset, and the per-episode mapping-list overrides
- [x] The season-offset / mapping-list resolver, forward AND reverse
      (`src/mapping/resolver.ts`) -- **tested against real data**, see below
- [x] Fribb-format JSON cross-reference (`src/mapping/fribb.ts`) -- backfills
      anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/animecountdown/
      simkl ids + type. Never touches tvdb/tmdb/season/offset -- those stay
      XML-owned.
- [x] lists-main cross-reference (`src/mapping/lists.ts`) -- id freshness
      backfill (fills gaps only, never overwrites Fribb) + currently-airing
      snapshot (`airing`/`episodeProgress`/`nextEpisodeAt`)
- [x] `GET /mappings` read API (anidb_id / mal_id / anilist_id / thetvdb_id)
      -- assembles ids/type/title/airing status live from `mapping`;
      description/image/episodes are honestly `null`/`[]` pending TVDB
- [x] `POST /indexer/mapping/refresh`, `/mapping/fribb-refresh`,
      `/mapping/lists-refresh` -- admin-key gated, all go through `jsonQueue`
- [x] `JobQueue` (`src/scheduler/queue.ts`) -- single-flight priority queue.
      A running lower-priority job cooperatively yields (checkpoints via
      `indexer_state`, doesn't get killed) when a higher-priority one
      arrives -- proven with a real preemption test, not just asserted
- [x] Resumable chunked runner (`src/mapping/chunked-runner.ts`) -- every
      mapping ingest job resumes from `indexer_state`'s cursor after a
      yield/interrupt, and reports which anidb_ids are newly-added
- [x] Sequential rate-limited runner (`src/mapping/sequential-runner.ts`) --
      the ask/get/index/wait/next-id loop for one-id-per-request providers
      (TVDB), as opposed to the bulk upserts chunked-runner.ts does for the
      static JSON/XML sources. Delay is `INDEX_DELAY` (seconds, default 5).
      Same resumable-cursor + yield-checkpoint contract as chunked-runner.ts.
      Not wired to a real provider yet (no TVDB client exists), but the
      loop itself -- ordering, per-id delay timing, no trailing wait after
      the last id, resuming from a given cursor, yielding mid-pass -- is
      tested with real timing measurements, not just asserted.
- [x] In-process scheduler (`src/scheduler/index.ts`, off by default --
      `ENABLE_SCHEDULER=true`) -- configurable cadences via env
      (`MAPPING_XML_SYNC_HOURS`=720, `MAPPING_IDS_SYNC_HOURS`=6,
      `AIRING_SYNC_HOURS`=1). Fixed a real bug along the way: `setInterval`'s
      delay is a 32-bit signed int, so a 30-day interval silently overflowed
      and fired every 1ms instead -- the scheduler now ticks on a fixed
      5-minute timer and compares elapsed time in plain arithmetic instead,
      which works for any interval. Regression-tested.
- [x] Render free-tier keep-alive (`src/helpers/self-poll.ts`)
- [x] Landing page + live API tester (`public/index.html`)
- [ ] **Open problem, split in two:**
      - For the **7,465 anime with a TVDB mapping**: solved, no external
        episode count needed. `reverseResolveRegular()` in resolver.ts
        inverts the same offset/mapping-list math, so once the TVDB fetcher
        exists, its own episode list is self-terminating -- verified by a
        round-trip test across all 430,332 unambiguous real episodes (879
        destinations are genuinely ambiguous in the *source* mapping data
        itself -- e.g. Ghost in the Shell explicitly maps six different
        AniDB catalog entries to the same one TVDB episode -- and are
        excluded from that count rather than miscounted as passing).
      - For the **9,400 anime with NO TVDB mapping (56% of the catalog)**:
        still unsolved. There's no episode data source for these at all
        right now -- `anime-airing.json` only covers the ~300 shows airing
        this moment. Whether that's acceptable (mapping-only, no episode
        list, for over half the catalog) or worth adding AniList's
        `Media.episodes` for is an open product decision, not yet made.
- [ ] TVDB episode fetcher + cache (token refresh) -- plugs into `tvdbQueue`
      the same way the mapping jobs plug into `jsonQueue`, and drives its
      per-id loop through `runSequential()` in sequential-runner.ts
- [ ] Merge engine (resolver + TVDB cache + episode count -> `anime.data`)
- [ ] `/indexer/tvdb/*`, `/indexer/merge/run` routes

## Scheduling & the job queue

Every mapping job (XML, Fribb, lists-main ids, airing) runs through
`jsonQueue` -- a single-flight priority queue (`src/scheduler/queue.ts`).
That's true whether the trigger is the in-process scheduler or a manual
`POST /indexer/*` call, so the two can never race and corrupt a write.

Two ways to trigger jobs, and you can use either or both:

1. **External pinger** (recommended on a host that sleeps when idle, e.g.
   Render's free tier) -- point cron-job.org or similar at
   `POST /indexer/mapping/refresh` etc. on whatever cadence you want.
2. **In-process scheduler** -- set `ENABLE_SCHEDULER=true` and it runs the
   same jobs on the cadences in `.env.example`
   (`MAPPING_XML_SYNC_HOURS`/`MAPPING_IDS_SYNC_HOURS`/`AIRING_SYNC_HOURS`).
   Better suited to an always-on host (paid tier, your own machine) where a
   timer inside the process can be trusted to actually fire.

Priority: airing (30) > ids (20) > xml (10) -- airing is both the most
time-sensitive (an episode can air within the hour) and the fastest job, so
it's allowed to preempt a slower one. "Preempt" here means cooperative
yielding, not killing a job mid-write: `chunked-runner.ts` checks
`shouldYield()` between chunks and, if true, checkpoints its position to
`indexer_state` and returns early rather than getting cut off mid-upsert.
The next run of that job picks up exactly where it left off. This is
proven with a real test (`test/queue.test.ts`) that watches a low-priority
job actually yield instead of either blocking the high-priority one or
being killed outright.

`tvdbQueue` exists for the same reason but isn't used by anything yet --
once the TVDB fetcher exists, its active/reconcile jobs plug into it
exactly the way the mapping jobs plug into `jsonQueue`.

`GET /indexer/queue/status` shows what's running/pending in both queues.

## Setup

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL at minimum
npm run db:generate    # generates SQL migration from schema.ts
npm run db:migrate     # applies it -- works against Supabase, Neon,
                        # self-hosted, or a local Postgres identically,
                        # it's all just DATABASE_URL
npm run dev
```

Seed the mapping table -- run in this order, since Fribb/lists-main backfill
onto rows the XML pass creates:

```bash
curl -X POST http://localhost:3000/indexer/mapping/refresh        -H "x-admin-key: $ADMIN_KEY"
curl -X POST http://localhost:3000/indexer/mapping/fribb-refresh  -H "x-admin-key: $ADMIN_KEY"
curl -X POST http://localhost:3000/indexer/mapping/lists-refresh  -H "x-admin-key: $ADMIN_KEY"
```

or without the server: `npm run ingest:mapping && npm run ingest:fribb && npm run ingest:lists`.

## Sources

All four are static-file downloads, no live scraping, no auth, all
overridable via env (see `.env.example`):

| Source | Default | Owns |
|---|---|---|
| `ANIME_LIST_MASTER_XML_URL` | Anime-Lists/anime-lists `anime-list-master.xml` | tvdb/tmdb ids, season+offset, per-episode mapping-list overrides -- **primary**, run this first |
| `FRIBB_JSON_URL` | Fribb/anime-lists (upstream) | anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/animecountdown/simkl ids, `type` |
| `ANIME_JSON_URL` | anime-and-manga/lists `anime.json` | anilist/mal id, freshness-only (fills gaps Fribb hasn't caught up on yet, never overwrites) |
| `ANIME_AIRING_JSON_URL` | anime-and-manga/lists `anime-airing.json` | `airing`/`episodeProgress`/`nextEpisodeAt` for currently-airing shows only |

Note on `anime-list-full.xml` (also in the Anime-Lists repo): it's a
*derived* subset of `anime-list-master.xml` that drops empty entries but
keeps "unknown" ones, meant for their own scraper tooling. Parsing
`anime-list-master.xml` directly (what this project does) already gives you
a superset of it, so there's no reason to also pull `full.xml`.

## Verifying the resolver and the source parsers

The resolver is the piece that actually answers "how do I turn an AniDB
episode number into a TVDB one" -- so it's tested against real entries
pulled from `anime-list-master.xml`, not made-up fixtures:

```bash
npm test                          # resolver: 19 assertions against real XML data
npx tsx test/sources.test.ts      # Fribb + lists-main parsers against real JSON
npx tsx test/response.test.ts     # /mappings response shape
npx tsx test/queue.test.ts        # JobQueue: FIFO, priority preemption, dedup
npx tsx test/scheduler.test.ts    # regression test for the setInterval overflow bug
npx tsx test/sequential-runner.test.ts  # per-id ask/get/index/wait loop timing + resume + yield
```

`test/resolver.test.ts` covers: plain offset, explicit per-episode overrides
(including one-to-many `;1-1+2;` combined episodes), range+offset rules, a
show that's entirely mapped into TVDB's specials season, Rizelmine -- which
uses absolute numbering AND has explicit range overrides that take priority
over it -- and a round-trip property test (`reverseResolveRegular` inverts
`resolveEpisode`) across all 430,332 unambiguous episodes in the real file,
which is what lets episode enumeration be driven by TVDB's own episode list
instead of a separately-sourced total count.

`test/sources.test.ts` covers: Fribb's TV vs MOVIE shape (the latter has
`themoviedb_id.movie` as an array instead of `themoviedb_id.tv`), that the
Fribb transform never throws across all ~15,800 real AniDB-matched entries,
and the airing-snapshot arithmetic (`episodeProgress = nextEpisode - 1`,
unix-seconds-to-Date conversion) against a real currently-airing entry.

`test/stress.manual.ts` runs every one of the ~16,865 real
`anime-list-master.xml` entries through the resolver (both providers,
episodes 1-30, both seasons) just to check nothing throws. Currently: 0
crashes, 9,400 anime with no TVDB association, 74 using absolute numbering,
1,428 with per-episode overrides.

## A note on `type`

`anime-list-master.xml` doesn't carry an anime `type` (TV/movie/OVA/etc) --
that comes from Fribb's JSON or `animetitles.xml` in a later cross-reference
pass. `ingestMapping()`'s upsert deliberately leaves `type` out of its
`ON CONFLICT DO UPDATE SET` so that pass, whenever it runs, isn't overwritten
by a mapping-only refresh.

## Deploying

Point `DATABASE_URL` at Supabase or Neon (not Render's own free Postgres --
it's deleted 30 days after creation, which will quietly nuke an
AniDB-rate-limited mirror that took days to build). Deploy the app itself to
Render's free web service tier with `RENDER_KEEP_ALIVE=true` and `PUBLIC_URL`
set to your Render URL, or just run it on your own always-on machine with
both left off.

Trigger the indexer routes on a schedule with a free external pinger like
cron-job.org rather than an in-process timer -- more reliable on a tier that
sleeps when idle, since the ping itself both wakes the instance and fires
the job.
