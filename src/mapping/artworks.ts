export type Artwork = {
  url: string;
  thumbnail: string | null;
  width: number | null;
  height: number | null;
  language: string | null;
  type: 'poster' | 'background' | 'logo' | 'icon' | 'screencap' | 'photo' | 'clearart' | 'unknown';
  source: 'tvdb' | 'tmdb' | 'ani-zip';
  providerType: number | string | null;
  score: number | null;
  includesText: boolean | null;
};

const TVDB_TYPES: Record<number, Artwork['type']> = {
  1: 'background', 2: 'poster', 3: 'background', 5: 'icon', 6: 'background',
  7: 'poster', 8: 'background', 10: 'icon', 11: 'screencap', 12: 'screencap',
  13: 'photo', 14: 'poster', 15: 'background', 16: 'background', 18: 'icon',
  19: 'icon', 20: 'background', 21: 'background', 22: 'clearart', 23: 'logo',
  24: 'clearart', 25: 'logo', 26: 'icon', 27: 'poster'
};

export function tvdbArtworkType(type: unknown): Artwork['type'] {
  return typeof type === 'number' ? TVDB_TYPES[type] ?? 'unknown' : 'unknown';
}

export function tmdbArtworkType(type: 'poster' | 'backdrop' | 'logo'): Artwork['type'] {
  return type === 'backdrop' ? 'background' : type;
}

/** Stable dedupe while retaining both provider variants of the same image. */
export function uniqueArtworks(artworks: Artwork[]): Artwork[] {
  const seen = new Set<string>();
  return artworks.filter((artwork) => {
    const key = `${artwork.source}|${artwork.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
