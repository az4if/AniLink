import { Config } from '../config.js';
import { fetchWithHeaders } from '../helpers/fetch.js';

export type TvdbEpisode = {
  seasonNumber: number;
  number: number;
  absoluteNumber: number | null;
  name: string | null;
  overview: string | null;
  // English specifically, regardless of whatever language `name`/`overview`
  // above happen to be (TVDB doesn't document what determines that -- see
  // fetchSeriesSummary()'s neighbor, fillEnglishTranslations(), below).
  // null when no English translation exists for this episode at all, which
  // does happen (recently-aired/simulcast episodes especially) -- not an
  // error.
  titleEn: string | null;
  overviewEn: string | null;
  aired: string | null;
  image: string | null;
};

export type TvdbSeriesData = {
  status: string | null;
  image: string | null;
  overview: string | null;
  episodes: TvdbEpisode[];
};

type CachedToken = { token: string; fetchedAt: number };
let cachedToken: CachedToken | null = null;

// TVDB tokens are valid ~1 month (per /login's swagger description).
// Refresh well before that so a long-running process never hands out a
// token that's about to expire mid-batch.
const TOKEN_MAX_AGE_MS = 25 * 24 * 60 * 60 * 1000; // 25 days

async function login(): Promise<string> {
  if (!Config.tvdb.apiKey) {
    throw new Error('TVDB_API_KEY is not set -- get one at https://thetvdb.com/api-information');
  }

  const res = await fetchWithHeaders(`${Config.tvdb.baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apikey: Config.tvdb.apiKey,
      ...(Config.tvdb.apiPin ? { pin: Config.tvdb.apiPin } : {})
    })
  });

  if (!res.ok) {
    throw new Error(`TVDB login failed: HTTP ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data?: { token?: string } };
  if (!body.data?.token) throw new Error('TVDB login response had no token');
  return body.data.token;
}

/**
 * The API key (TVDB_API_KEY, set once in .env) is exchanged for a
 * Bearer token via POST /login -- that token, not the key itself, is what
 * every other request needs. Cached in-memory across calls (this is a
 * single always-on process, see README) and only re-fetched when stale or
 * after a 401, rather than logging in before every single request.
 */
async function getToken(forceRefresh: boolean): Promise<string> {
  if (!forceRefresh && cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_MAX_AGE_MS) {
    return cachedToken.token;
  }
  const token = await login();
  cachedToken = { token, fetchedAt: Date.now() };
  return token;
}

/** Authenticated GET against the TVDB v4 API. On a 401 (stale/revoked token), forces exactly one fresh login + retry before giving up. */
async function tvdbGet(path: string, forceNewToken = false): Promise<any> {
  const token = await getToken(forceNewToken);
  const res = await fetchWithHeaders(`${Config.tvdb.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401 && !forceNewToken) {
    return tvdbGet(path, true);
  }
  if (!res.ok) {
    throw new Error(`TVDB GET ${path} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Series-level fields (status/image/overview). Deliberately `?short=true`
 * on /extended -- this skips characters/artwork/etc, which this project
 * has no use for, keeping the payload small. Episode data is NOT taken
 * from here: /extended's embedded episode list doesn't let you pin the
 * season-type to "official" the way the dedicated episodes endpoint does,
 * and for long-running anime (many hundreds of episodes) it isn't
 * reliably paginated the way /series/{id}/episodes/{season-type} is.
 */
async function fetchSeriesSummary(tvdbId: number): Promise<Omit<TvdbSeriesData, 'episodes'>> {
  const body = await tvdbGet(`/series/${tvdbId}/extended?short=true`);
  const series = body?.data ?? {};
  return {
    status: series.status?.name ?? null,
    image: series.image ?? null,
    overview: series.overview ?? null
  };
}

// A hard ceiling on pagination, not an expected count -- guards against an
// unexpected API change (e.g. `links.next` never going falsy) turning into
// an infinite loop. No real anime has anywhere near this many episodes.
const MAX_EPISODE_PAGES = 50;

type EpisodeWithMeta = TvdbEpisode & { _id: number; _hasEng: boolean };

// TheTVDB's v4 docs don't publish a request-per-second limit (unlike e.g.
// TMDB, which documents ~50/s). Rather than guess a number that might be
// too aggressive, this keeps translation fetches to a small fixed
// concurrency -- slower than it needs to be, most likely, but never a
// burst large enough to risk tripping abuse detection.
const TRANSLATION_CONCURRENCY = 8;

/**
 * English name/overview aren't in the base episode list -- TVDB only
 * exposes them via GET /episodes/{id}/translations/eng, one call PER
 * EPISODE, with no bulk/batch variant in the v4 API. For a long-running
 * anime that's potentially hundreds of extra requests per sync, so this
 * skips any episode whose own `nameTranslations`/`overviewTranslations`
 * arrays (TVDB's own record of which languages exist for it) don't list
 * "eng" at all -- no point spending a request to confirm what TVDB
 * already told us. The rest run with the fixed concurrency above rather
 * than fully serial (slow) or fully parallel (see above).
 *
 * A failure fetching any one episode's translation (no English
 * translation exists -- a 404 -- or a transient error) just leaves that
 * episode's titleEn/overviewEn null. One episode's translation being
 * unavailable shouldn't fail the whole series fetch.
 */
async function fillEnglishTranslations(episodes: EpisodeWithMeta[]): Promise<void> {
  const candidates = episodes.filter((ep) => ep._hasEng);
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      const ep = candidates[cursor++];
      try {
        const body = await tvdbGet(`/episodes/${ep._id}/translations/eng`);
        ep.titleEn = body?.data?.name ?? null;
        ep.overviewEn = body?.data?.overview ?? null;
      } catch {
        // left null -- see docstring above.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(TRANSLATION_CONCURRENCY, candidates.length) }, worker));
}

/**
 * All episodes for a series under TVDB's "official" season-type -- the
 * numbering scheme this project's schema (defaultTvdbSeason,
 * tvdbEpisodeOffset, mapping-list) is defined against. Paginated per the
 * v4 spec (`page` query param, `links.next` in the response); walked until
 * a page comes back empty or `links.next` is falsy. English title/overview
 * are filled in as a second pass once the full list is known -- see
 * fillEnglishTranslations().
 */
async function fetchAllEpisodes(tvdbId: number): Promise<TvdbEpisode[]> {
  const episodes: EpisodeWithMeta[] = [];

  for (let page = 0; page < MAX_EPISODE_PAGES; page++) {
    const body = await tvdbGet(`/series/${tvdbId}/episodes/official?page=${page}`);
    const pageEpisodes: any[] = body?.data?.episodes ?? [];
    if (pageEpisodes.length === 0) break;

    for (const ep of pageEpisodes) {
      episodes.push({
        seasonNumber: ep.seasonNumber,
        number: ep.number,
        absoluteNumber: ep.absoluteNumber ?? null,
        name: ep.name ?? null,
        overview: ep.overview ?? null,
        titleEn: null,
        overviewEn: null,
        aired: ep.aired ?? null,
        image: ep.image ?? null,
        _id: ep.id,
        _hasEng: Boolean(ep.nameTranslations?.includes('eng') || ep.overviewTranslations?.includes('eng'))
      });
    }

    if (!body?.links?.next) break;
  }

  await fillEnglishTranslations(episodes);
  return episodes.map(({ _id, _hasEng, ...rest }) => rest);
}

/** Everything this project needs for one tvdb_id: series summary + its full official-order episode list. Two requests (summary, then episode pages) -- see fetchSeriesSummary()'s docstring for why they're separate calls. */
export async function fetchTvdbSeries(tvdbId: number): Promise<TvdbSeriesData> {
  const summary = await fetchSeriesSummary(tvdbId);
  const episodes = await fetchAllEpisodes(tvdbId);
  return { ...summary, episodes };
}
