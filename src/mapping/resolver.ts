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
