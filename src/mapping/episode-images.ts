/**
 * Which provider an episode thumbnail came from.
 *
 * `anilist` and `kitsu` are reserved for the next two sources (AniList
 * `streamingEpisodes`, Kitsu `/anime/{id}/episodes`) -- nothing produces them
 * yet, but the public contract can already name them so adding a source later
 * is not a response-shape change. `ani-zip` is the only value beyond the four
 * the API advertises: ani.zip's episode images are usually TVDB-hosted URLs,
 * but ani.zip is the provider that actually served them, which matches how
 * `artworks[].source` already labels them.
 */
export type EpisodeImageSource = 'tvdb' | 'tmdb' | 'anilist' | 'kitsu' | 'ani-zip';

/** One provider's episode list, tagged with who it is. */
export type EpisodeImageCandidate<T extends EpisodeImageLike> = {
  source: EpisodeImageSource;
  episodes: T[];
};

type EpisodeImageLike = { number: number; image: string | null };

function hasImage(image: string | null | undefined): image is string {
  return typeof image === 'string' && image.trim() !== '';
}

/**
 * Gives every episode of the primary provider a thumbnail, falling back to the
 * other providers' thumbnail for the SAME canonical episode number when the
 * primary has none, and records where each thumbnail came from.
 *
 * - The primary's own image always wins; `imageSource` is then the primary.
 * - Otherwise the first fallback (in the order given) that has an image for
 *   that canonical number is used, and `imageSource` is that fallback.
 * - If nobody has one, `image` and `imageSource` are both `null`. We never
 *   invent a thumbnail -- clients decide whether to show the series poster.
 *
 * Only `image` and `imageSource` are touched; every other episode field is
 * passed through untouched, so this cannot change which episode a record is.
 * Matching is by canonical `number`, the same key `enrichEpisodes` already
 * uses to join ani.zip onto TVDB.
 */
export function fillEpisodeImages<T extends EpisodeImageLike>(
  primary: EpisodeImageCandidate<T>,
  fallbacks: EpisodeImageCandidate<EpisodeImageLike>[]
): Array<T & { imageSource: EpisodeImageSource | null }> {
  const lookups = fallbacks.map((fallback) => {
    const byNumber = new Map<number, string>();
    for (const episode of fallback.episodes) {
      // first image per number wins, so a duplicate number can't override it
      if (hasImage(episode.image) && !byNumber.has(episode.number)) {
        byNumber.set(episode.number, episode.image);
      }
    }
    return { source: fallback.source, byNumber };
  });

  return primary.episodes.map((episode) => {
    if (hasImage(episode.image)) {
      return { ...episode, imageSource: primary.source };
    }
    for (const lookup of lookups) {
      const image = lookup.byNumber.get(episode.number);
      if (image) return { ...episode, image, imageSource: lookup.source };
    }
    return { ...episode, image: null, imageSource: null };
  });
}
