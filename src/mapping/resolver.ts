import type { MappingRow } from './xml-parser.js';

export type Provider = 'tvdb' | 'tmdb';

/** An AniDB episode, normalized into the flat numbering space the XML format uses. */
export type AnidbEpisodeRef = {
  /** 0 = specials/trailers/other, 1 = regular episodes */
  season: 0 | 1;
  /** Regular: the episode number as-is. Specials: see toMappingNumber() below. */
  number: number;
};

export type ResolvedEpisode =
  // ordinary case -- one AniDB episode -> one or more provider episodes
  // (>1 only for the ";1-1+2;" combined-episode case)
  | { mode: 'season-episode'; season: number; episodes: number[] }
  // defaulttvdbseason="a" (or tmdb equivalent) -- caller must resolve this
  // against the provider's *absolute* episode order, which requires the
  // actual episode list from that provider (not available from mapping
  // data alone -- this is a contract for the merge stage, once TVDB/TMDB
  // episode data has been fetched).
  | { mode: 'absolute'; anidbNumber: number }
  // either explicitly mapped to 0 ("no equivalent exists"), or this anime
  // has no association with the target provider at all
  | { mode: 'unmapped' };

/**
 * AniDB numbers specials/trailers/other episodes in a flat space where the
 * *type* determines the offset, per the anime-lists README:
 *   Special   S1, S2, ...  -> 1, 2, ...     (no offset)
 *   Trailer   T1, T2, ...  -> 201, 202, ... (T1 = 201)
 *   Other     O1, O2, ...  -> 401, 402, ... (O1 = 401)
 * Credits/Parody episodes aren't covered by the mapping-list format and are
 * expected to stay AniDB-only.
 */
export function toMappingNumber(type: 'special' | 'trailer' | 'other', localNumber: number): number {
  switch (type) {
    case 'special':
      return localNumber;
    case 'trailer':
      return 200 + localNumber;
    case 'other':
      return 400 + localNumber;
  }
}

function seasonForTarget(row: MappingRow, target: Provider) {
  return target === 'tvdb'
    ? { id: row.tvdbId, defaultSeason: row.defaultTvdbSeason, absolute: row.tvdbAbsolute, offset: row.tvdbEpisodeOffset }
    : { id: row.tmdbTvId, defaultSeason: row.defaultTmdbSeason, absolute: row.tmdbAbsolute, offset: row.tmdbEpisodeOffset };
}

/**
 * Resolves one AniDB episode to its TVDB or TMDB equivalent for the given
 * mapping row. Priority order (matches anime-lists' documented behavior):
 *   1. An explicit individual-episode override in the mapping-list.
 *   2. A start/end/offset range rule in the mapping-list.
 *   3. The anime-level default season + episode offset (regular episodes only).
 *   4. Absolute numbering, if the anime uses it.
 *   5. Otherwise: unmapped.
 */
export function resolveEpisode(row: MappingRow, ep: AnidbEpisodeRef, target: Provider): ResolvedEpisode {
  const { id, defaultSeason, absolute, offset } = seasonForTarget(row, target);

  // No association with this provider at all (movie-only, hentai, one-off
  // OVA never added to TVDB, etc).
  if (!id) return { mode: 'unmapped' };

  const relevantEntries = row.mappingList.filter((entry) => {
    const entrySeason = target === 'tvdb' ? entry.tvdbSeason : entry.tmdbSeason;
    return entry.anidbSeason === ep.season && entrySeason !== null;
  });

  for (const entry of relevantEntries) {
    const entrySeason = (target === 'tvdb' ? entry.tvdbSeason : entry.tmdbSeason)!;

    // 1. explicit override takes priority over any range rule, per README
    if (entry.explicit && ep.number in entry.explicit) {
      const dsts = entry.explicit[ep.number];
      if (dsts.length === 1 && dsts[0] === 0) return { mode: 'unmapped' };
      return { mode: 'season-episode', season: entrySeason, episodes: dsts };
    }

    // 2. range + offset rule
    if (entry.start !== undefined && entry.end !== undefined && ep.number >= entry.start && ep.number <= entry.end) {
      return { mode: 'season-episode', season: entrySeason, episodes: [ep.number + (entry.offset ?? 0)] };
    }
  }

  // 3. default season + offset -- regular episodes only. Specials with no
  // matching mapping-list entry above have no default to fall back to;
  // that's the whole reason mapping-list exists.
  if (ep.season === 1 && defaultSeason !== null) {
    return { mode: 'season-episode', season: defaultSeason, episodes: [ep.number + offset] };
  }

  // 4. absolute numbering
  if (ep.season === 1 && absolute) {
    return { mode: 'absolute', anidbNumber: ep.number };
  }

  // 5. nothing matched
  return { mode: 'unmapped' };
}

/**
 * Inverts resolveEpisode(): given a real (season, episode) TVDB actually
 * has, returns the canonical regular-episode number it corresponds to.
 *
 * This is what lets episode enumeration be driven by TVDB's own (already
 * fetched) episode list instead of needing a separately-sourced total
 * episode count -- TVDB's episode list is self-terminating, so there's
 * nothing left to ask AniList (or anywhere else) for on a mapped show.
 *
 * Scoped to regular episodes (mirrors resolveEpisode's season===1 case) --
 * specials aren't reversed here for the same reason they aren't resolved
 * forward without AniDB's own numbering, see README.
 *
 * Absolute-numbered shows (tvdbAbsolute/tmdbAbsolute) aren't handled here:
 * TVDB's own episode objects carry an `absoluteNumber` field directly, so
 * for those shows the canonical number IS that field, no arithmetic (or
 * this function) needed once the TVDB client exists.
 */
export function reverseResolveRegular(row: MappingRow, tvdbEp: { season: number; number: number }, target: Provider): number | null {
  const relevantEntries = row.mappingList.filter((entry) => {
    const entrySeason = target === 'tvdb' ? entry.tvdbSeason : entry.tmdbSeason;
    return entry.anidbSeason === 1 && entrySeason === tvdbEp.season;
  });

  for (const entry of relevantEntries) {
    // invert an explicit override: find the anidb episode whose explicit
    // list *contains* this destination episode (not just equals it --
    // combined-episode entries like ";1-1+2;" mean episode 1 spans BOTH
    // destination episodes 1 and 2, and either one must reverse to 1)
    if (entry.explicit) {
      for (const [anidbNumStr, dsts] of Object.entries(entry.explicit)) {
        if (dsts.includes(tvdbEp.number)) return Number(anidbNumStr);
      }
    }
    // invert a range+offset rule
    if (entry.start !== undefined && entry.end !== undefined) {
      const candidate = tvdbEp.number - (entry.offset ?? 0);
      if (candidate >= entry.start && candidate <= entry.end) return candidate;
    }
  }

  // invert the anime-level default season + offset
  const { defaultSeason, offset } = seasonForTarget(row, target);
  if (defaultSeason === tvdbEp.season) return tvdbEp.number - offset;

  return null; // this TVDB episode isn't a mapped regular episode
}

