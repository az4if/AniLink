# Contributing / how this works

For deploy instructions, see [README.md](README.md). This is the "why is
it built this way" and "what's actually tested" doc.

## License

AniLink is distributed under the terms in [LICENSE.md](LICENSE.md) (a
custom, non-commercial license). By submitting a contribution, you agree
it's provided under those same terms and that the project maintainer may
distribute it as part of AniLink.

## Sources

The remote mapping sources are static downloads; the optional local
`ani.zip` source is imported without making a network request:

| Source | Owns |
|---|---|
| `anime-list-master.xml` (Anime-Lists/anime-lists) | tvdb/tmdb ids, season+offset, per-episode mapping-list overrides -- **primary**, richest source |
| Fribb-format JSON (Fribb/anime-lists) | anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/animecountdown/simkl ids, `type` -- plus gap-fills tvdb/tmdb/imdb/season/offset for anime the XML source left completely unmapped (never overwrites what XML already found) |
| `anime.json` (anime-and-manga/lists) | anilist/mal id, freshness-only -- fills gaps Fribb hasn't caught up on yet, never overwrites |
| `anime-airing.json` (anime-and-manga/lists) | `airing` / `episodeProgress` / `nextEpisodeAt`, currently-airing shows only |
| local `ani.zip` | optional AniDB cross-reference seed/gap-fill; the complete original JSON records are retained in `ani_zip_cache` |
| `api.ani.zip` | remote multilingual titles, provider-ID gap fills, direct AniDB/TVDB episode metadata, and artwork; raw responses remain separately cached |
| AniList GraphQL | episode totals, airing/release dates, titles and relation graph; normalized records remain in `anilist_cache` |

## Why no live AniDB API access

AniDB's website sits behind Cloudflare, which blocks datacenter/cloud IPs
by default, and AniDB's own policy is that its client API isn't meant to be
hit from a VPS anyway -- only a residential connection. Rather than fight
that, AniLink never calls AniDB directly. IDs come entirely from the
sources above. TVDB is preferred for actual episode data; mapped TMDB data
is the fallback when TVDB has no ID or has not been fetched yet.

Regular episode enumeration intentionally excludes specials/OVA/OP/ED/trailer
entries, because they have no safe shared numbering scheme. The AniList stage
does index their relation, title, release dates, and known episode count as
`relatedSpecials`; it does not force them into the regular-episode list.

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

Once on, three independent lanes:

1. **Every `MAPPING_SYNC_HOURS`** -- imports optional ani.zip and refreshes
   the four remote mapping sources
   and updates `mapping`. Knows exactly which anidb_ids are new since last
   time.
2. **Every `PROVIDER_SYNC_HOURS`** -- runs one ordered pipeline for each
   new or airing AniDB record: AniList first when mapped, TVDB when it has a
   TVDB ID, otherwise TMDB when it has a TMDB ID, then remote ani.zip every
   time. AniList validates known episode totals and airing/release dates, and
   records related seasons, OVAs, ONAs and specials without auto-merging
   them. The final stage
   supplies localized titles, direct episode mappings, artwork, and mapping
   gap fills. If neither provider ID exists, only the ani.zip stage runs,
   using the AniDB ID as the fallback lookup. `PROVIDER_FULL_SYNC_HOURS`
   runs that exact same pipeline for the full catalog.

Mapping jobs queue behind mapping jobs; the provider pipeline has one queue --
nothing in the same lane overlaps and corrupts a write. The lanes are
otherwise independent.

## The queue

Two queues, `src/scheduler/queue.ts`:

- **`jsonQueue`** -- local archive plus the four remote mapping sources. No external rate limit;
  exists so two of them can't write to the DB at once.
- **`providerQueue`** -- the ordered AniList → TVDB/TMDB fallback → ani.zip pass.
  One sequential queue makes the full and incremental behavior identical,
  resumable, and rate-limited through `INDEX_DELAY`.

"Step aside" is cooperative yielding, not getting killed mid-write: the
running job checks a `shouldYield()` flag between each unit of work and,
if true, saves exactly where it was (`indexer_state`) and stops. The next
run of that job resumes from there instead of starting over.

## What's built vs. pending

**Built:** full mapping ingest from the four remote sources plus optional
lossless ani.zip cross-reference import; the resolver
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
for the full episode list. Each episode's `title`/`overview` come back in
whatever language TVDB's default record happens to be; English
specifically (`titleEn`/`overviewEn`) is a second pass over
`GET /episodes/{id}/translations/eng` -- there's no bulk/batch translation
endpoint in the v4 API, so this is one extra request per episode, skipped
entirely for episodes whose own `nameTranslations`/`overviewTranslations`
arrays don't list `eng` at all, and run with modest fixed concurrency
(TVDB doesn't publish a documented v4 rate limit, unlike some other
providers -- see `TRANSLATION_CONCURRENCY` in tvdb-client.ts). Plus the
merge engine (`src/mapping/merge.ts`) that turns a fetched TVDB series +
episode list into the public `/mappings` response shape via
`reverseResolveRegular()` -- including the tvdb_id-shared-by-multiple-
anidb-entries case (Ghost in the Shell), where each entry gets its own
episode numbers off its own offset against the same shared TVDB data.
The full TVDB extended response (including aliases, remote IDs, trailers,
airing schedule and artwork) is retained in `tvdb_cache`, not narrowed to
the public schema. TMDB has equivalent full-payload caching in
`tmdb_cache`, including images/translations/credits and per-season episode
data. `merge.ts` uses TVDB as its preferred metadata/episode source,
falls back to TMDB, and returns provenance-preserving artwork from both.

AniList is queried through its GraphQL `Media` endpoint for the mapped ID.
The indexer stores the full normalized record in `anilist_cache`, including
episode count, status, dates, next airing event, localized names, and direct
relations. `anime_segment` then keeps a direct mapping at confidence 100;
related entries remain separate candidates with no inferred episode range.
This makes a combined franchise reviewable and prevents count/date heuristics
from incorrectly appending a sequel or special to the main episode list.

For titles with neither a TVDB nor TMDB mapping, ani.zip provides the
episode fallback. Related specials are indexed as references but still do
not receive fabricated regular-episode positions.

## Testing

```bash
npm test                                # resolver: 19 assertions against real XML data
npx tsx test/sources.test.ts            # Fribb + lists-main parsers against real JSON
npx tsx test/response.test.ts           # /mappings response shape
npx tsx test/merge.test.ts               # TVDB episode -> AniDB number reversal, incl. absolute numbering + English title/overview pass-through
npx tsx test/tvdb-client.test.ts         # login/token caching, pagination, 401-retry, English-translation fetch/skip/404-handling (mocked fetch, no real TVDB call)
npx tsx test/tmdb-client.test.ts         # TMDB full payload, artwork and season/absolute episode normalization (mocked fetch)
npx tsx test/ani-zip.test.ts             # local archive normalization and lossless raw record handling
npx tsx test/ani-zip-client.test.ts      # remote multilingual titles, mappings, episode data, and artwork normalization
npx tsx test/anilist-client.test.ts      # GraphQL metadata normalization and conservative relation/special segments
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
