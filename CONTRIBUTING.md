# Contributing / how this works

For deploy instructions, see [README.md](README.md). This is the "why is
it built this way" and "what's actually tested" doc.

## License

AniLink is distributed under the terms in [LICENSE.md](LICENSE.md) (a
custom, non-commercial license). By submitting a contribution, you agree
it's provided under those same terms and that the project maintainer may
distribute it as part of AniLink.

## Sources

Three of the four mapping sources are static file downloads -- no live
scraping, no auth needed:

| Source | Owns |
|---|---|
| `anime-list-master.xml` (Anime-Lists/anime-lists) | tvdb/tmdb ids, season+offset, per-episode mapping-list overrides -- **primary**, richest source |
| Fribb-format JSON (Fribb/anime-lists) | anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/animecountdown/simkl ids, `type` -- plus gap-fills tvdb/tmdb/imdb/season/offset for anime the XML source left completely unmapped (never overwrites what XML already found) |
| `anime.json` (anime-and-manga/lists) | anilist/mal id, freshness-only -- fills gaps Fribb hasn't caught up on yet, never overwrites |
| `anime-airing.json` (anime-and-manga/lists) | `airing` / `episodeProgress` / `nextEpisodeAt`, currently-airing shows only |

## Why no live AniDB API access

AniDB's website sits behind Cloudflare, which blocks datacenter/cloud IPs
by default, and AniDB's own policy is that its client API isn't meant to be
hit from a VPS anyway -- only a residential connection. Rather than fight
that, AniLink never calls AniDB directly. IDs come entirely from the
sources above; TVDB is canonical for actual episode data, not just
enrichment.

Trade-off: specials/OVA/OP/ED/trailer episodes aren't mappable this way,
since those only exist as distinct entries because of AniDB's own
numbering scheme. Not supported for v1.

## The resolver

`src/mapping/resolver.ts` turns an AniDB-style regular episode number into
the matching TVDB season/episode -- per-episode `mapping-list` overrides
when present, a plain season+offset formula otherwise.

It also runs in reverse (`reverseResolveRegular`): given a TVDB episode
TVDB actually has, work out which regular-episode number it corresponds
to. That's what lets episode enumeration be driven entirely by TVDB's own
episode list once fetched, instead of needing a separately-sourced total
episode count.

Tested against a round-trip property across all 430,332 unambiguous
episodes in the real XML file. A small number of destinations are
genuinely ambiguous in the source data itself (e.g. Ghost in the Shell
explicitly maps six different AniDB catalog entries to the same one TVDB
episode) and are excluded from that count rather than miscounted as
passing.

## Outbound requests

`src/helpers/fetch.ts` sets a real browser `User-Agent` on every fetch,
rather than Node's bare default -- a headerless automated request is
exactly what some bot-detection heuristics flag regardless of whether the
request is otherwise legitimate.

## The schedule, in plain terms

Nothing runs automatically until `ENABLE_SCHEDULER=true`. Alternative: an
outside pinger (cron-job.org) calling `POST /indexer/*` on a timer instead.
Either works; you need one of them.

Once on, two independent lanes:

1. **Every `MAPPING_SYNC_HOURS`** -- re-downloads all four mapping sources
   and updates `mapping`. Knows exactly which anidb_ids are new since last
   time.
2. **Every `TVDB_SYNC_HOURS`** -- asks TVDB for episode data, but only for
   anime that are currently airing or have never been asked about. First
   run, "never asked" means everything, so it's slow; every run after that
   only touches the small new+airing subset, so it's fast.
   **`TVDB_FULL_SYNC_HOURS`** ignores that shortcut and re-asks about
   every mapped anime, catching anything that slipped through (e.g. an
   anime that gained a TVDB mapping later on).

Mapping jobs queue behind mapping jobs, TVDB jobs queue behind TVDB jobs --
nothing in the same lane overlaps and corrupts a write. The two lanes are
otherwise independent.

## The queue

Two queues, `src/scheduler/queue.ts`:

- **`jsonQueue`** -- the four mapping sources. No external rate limit;
  exists so two of them can't write to the DB at once.
- **`tvdbQueue`** -- TVDB jobs. Matters for a real reason: TVDB has one
  shared rate budget, so a fast urgent job (new+airing check) needs to be
  able to make a slow full sweep step aside.

"Step aside" is cooperative yielding, not getting killed mid-write: the
running job checks a `shouldYield()` flag between each unit of work and,
if true, saves exactly where it was (`indexer_state`) and stops. The next
run of that job resumes from there instead of starting over.

## What's built vs. pending

**Built:** full mapping ingest from all four sources; the resolver
(forward + reverse, tested against real data); the job queue and
scheduler (tested, including a regression test for a real `setInterval`
32-bit overflow bug found during development -- a 30-day interval
overflows the 32-bit ms limit and silently fires every 1ms instead of
monthly); the resumable/rate-limited per-id runner TVDB uses;
`/mappings`, `/health`, and the full `/indexer/*` diagnostic and control
surface.

The TVDB v4 client (`src/mapping/tvdb-client.ts`) is also built: exchanges
`TVDB_API_KEY` for a Bearer token via `POST /login` (cached in-memory,
refreshed on expiry or a 401), then `GET /series/{id}/extended` for
status/image/overview and paginated `GET /series/{id}/episodes/official`
for the full episode list. Plus the merge engine
(`src/mapping/merge.ts`) that turns a fetched TVDB series + episode list
into the public `/mappings` response shape via `reverseResolveRegular()`
-- including the tvdb_id-shared-by-multiple-anidb-entries case (Ghost in
the Shell), where each entry gets its own episode numbers off its own
offset against the same shared TVDB data. `description`/`image`/
`episodes` populate automatically once `POST /indexer/tvdb/*` has run for
a title; `mappings.routes.ts` was already written to prefer `anime.data`
over the plain `mapping` fallback the moment it exists, so no route code
needed to change.

**Also open:** episode data for the ~56% of the catalog with no TVDB
mapping at all. Nothing sources episode lists for those right now.
Specials/OVA/OP/ED/trailer episodes also aren't mappable even for titles
with TVDB coverage -- see "Why no live AniDB API access" above; not
supported for v1.

## Testing

```bash
npm test                                # resolver: 19 assertions against real XML data
npx tsx test/sources.test.ts            # Fribb + lists-main parsers against real JSON
npx tsx test/response.test.ts           # /mappings response shape
npx tsx test/merge.test.ts              # TVDB episode -> AniDB number reversal, incl. absolute numbering
npx tsx test/tvdb-client.test.ts        # login/token caching, pagination, 401-retry (mocked fetch, no real TVDB call)
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

`test/merge-integration.manual.ts` (needs `DATABASE_URL`) exercises
`mergeTvdbIntoAnime()` against a real database, including the shared-
tvdb_id/different-offset case.

