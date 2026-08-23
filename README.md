<p align="center"><img src="public/favicon.png" width="120" height="120" alt="AniLink"></p>
<h1 align="center">AniLink</h1>

AniDB &lt;-&gt; TVDB/TMDB/AniList/MAL episode mapping API. AniDB's episode list is
canonical; TVDB/TMDB data enriches it (title/overview/image) where a mapping
exists. Same design as zenshin-API, rebuilt so the mapping-resolution logic
is transparent and testable instead of a black box.

Runs as a single always-on Node process (Render web service or your own
machine) -- no serverless, since the indexer needs to run long throttled
loops that a serverless function would just get killed mid-way through.

## What's actually built right now

- [x] Postgres schema (`src/db/schema.ts`) -- `mapping`, `anidb_cache`,
      `tvdb_cache`, `anime` (final/served), `indexer_state` (resumable cursors)
- [x] `anime-list-master.xml` parser (`src/mapping/xml-parser.ts`)
- [x] The season-offset / mapping-list resolver (`src/mapping/resolver.ts`)
      -- **tested against real data**, see below
- [x] Mapping ingest job + `POST /indexer/mapping/refresh`
- [x] `GET /mappings` read API (anidb_id / mal_id / anilist_id / thetvdb_id)
- [x] Render free-tier keep-alive (`src/helpers/self-poll.ts`)
- [ ] AniDB episode fetcher + cache (rate-limited)
- [ ] TVDB episode fetcher + cache (token refresh)
- [ ] Merge engine (resolver + both caches -> `anime.data`)
- [ ] Fribb JSON + lists-main cross-reference (fills `type`, catches
      brand-new anime before anime-lists-xml has them)
- [ ] `/indexer/anidb/*`, `/indexer/tvdb/*`, `/indexer/merge/run` routes
- [ ] External scheduler wiring (cron-job.org hitting the routes above)

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

Seed the mapping table (takes a few minutes, no rate limit -- it's one XML
file):

```bash
curl -X POST http://localhost:3000/indexer/mapping/refresh \
  -H "x-admin-key: $ADMIN_KEY"
```

or run it directly without the server: `npm run ingest:mapping`.

## Verifying the resolver

The resolver is the piece that actually answers "how do I turn an AniDB
episode number into a TVDB one" -- so it's tested against real entries
pulled from `anime-list-master.xml`, not made-up fixtures:

```bash
npm test
```

Covers: plain offset, explicit per-episode overrides (including one-to-many
`;1-1+2;` combined episodes), range+offset rules, a show that's entirely
mapped into TVDB's specials season, and Rizelmine -- which uses absolute
numbering AND has explicit range overrides that take priority over it. All
18 assertions currently pass against the real file.

`test/stress.manual.ts` runs every one of the ~16,865 real entries through
the resolver (both providers, episodes 1-30, both seasons) just to check
nothing throws. Currently: 0 crashes, 9,400 anime with no TVDB association,
74 using absolute numbering, 1,428 with per-episode overrides.

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
