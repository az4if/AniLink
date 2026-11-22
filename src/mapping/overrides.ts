/**
 * Manual corrections to `mapping` rows that survive every re-sync.
 *
 * Community sources are sometimes wrong (a season mapped to the wrong TVDB
 * series, a MAL id that points at a different cour). Fixing the row directly
 * does not last: the next sync overwrites it. An override is stored separately
 * and re-applied AFTER every sync, so the correction always wins.
 *
 * Pure validation/diff logic lives here; overrides-apply.ts does the DB work.
 */

type FieldKind = 'int' | 'text' | 'bool' | 'int[]' | 'text[]';

/**
 * Columns of `mapping` an override may set (property names of the Drizzle
 * table). Deliberately excludes `mappingList` (per-episode data too large to
 * hand-edit safely) and the airing snapshot (owned by the airing feed).
 */
export const OVERRIDABLE_FIELDS = {
  anilistId: 'int',
  malId: 'int',
  kitsuId: 'int',
  livechartId: 'int',
  anisearchId: 'int',
  animePlanetId: 'text',
  animeNewsNetworkId: 'int',
  animeCountdownId: 'int',
  simklId: 'int',
  notifyMoeId: 'int',
  tvdbId: 'int',
  tmdbTvId: 'int',
  tmdbMovieIds: 'int[]',
  imdbIds: 'text[]',
  type: 'text',
  title: 'text',
  defaultTvdbSeason: 'int',
  tvdbEpisodeOffset: 'int',
  defaultTmdbSeason: 'int',
  tmdbEpisodeOffset: 'int',
  tvdbAbsolute: 'bool',
  tmdbAbsolute: 'bool'
} as const satisfies Record<string, FieldKind>;

export type OverridableField = keyof typeof OVERRIDABLE_FIELDS;

// Columns declared NOT NULL in the schema: an override may set them but not clear them.
const NOT_NULLABLE: ReadonlySet<string> = new Set(['tvdbAbsolute', 'tmdbAbsolute']);

export function isOverridableField(field: string): field is OverridableField {
  return Object.prototype.hasOwnProperty.call(OVERRIDABLE_FIELDS, field);
}

export type ValueCheck = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Validates one override value for a field. `null` means "force this column to
 * empty" (useful for an id that is simply wrong) and is allowed everywhere
 * except NOT NULL columns.
 */
export function validateOverrideValue(field: string, value: unknown): ValueCheck {
  if (!isOverridableField(field)) {
    return { ok: false, error: `"${field}" cannot be overridden. Allowed: ${Object.keys(OVERRIDABLE_FIELDS).join(', ')}` };
  }
  if (value === null || value === undefined) {
    return NOT_NULLABLE.has(field) ? { ok: false, error: `${field} cannot be cleared; set true or false` } : { ok: true, value: null };
  }

  switch (OVERRIDABLE_FIELDS[field]) {
    case 'int':
      return Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, error: `${field} must be an integer or null` };
    case 'text':
      return typeof value === 'string' && value.trim() !== ''
        ? { ok: true, value: value.trim() }
        : { ok: false, error: `${field} must be a non-empty string or null` };
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: `${field} must be true or false` };
    case 'int[]':
      return Array.isArray(value) && value.every((item) => Number.isSafeInteger(item))
        ? { ok: true, value: value.length > 0 ? value : null }
        : { ok: false, error: `${field} must be an array of integers or null` };
    case 'text[]':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')
        ? { ok: true, value: value.length > 0 ? value.map((item: string) => item.trim()) : null }
        : { ok: false, error: `${field} must be an array of non-empty strings or null` };
  }
}

export type OverrideInput = { field: string; value: unknown };
export type Rejected = { field: string; error: string };

/** Validates a set of overrides for ONE anime and merges them into a single column patch. */
export function buildOverridePatch(overrides: readonly OverrideInput[]): { patch: Record<string, unknown>; rejected: Rejected[] } {
  const patch: Record<string, unknown> = {};
  const rejected: Rejected[] = [];
  for (const { field, value } of overrides) {
    const check = validateOverrideValue(field, value);
    if (check.ok) patch[field] = check.value;
    else rejected.push({ field, error: check.error });
  }
  return { patch, rejected };
}

function sameValue(a: unknown, b: unknown): boolean {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Subset of `patch` whose values differ from what the row currently holds -- the only columns worth writing. */
export function changedFields(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (!sameValue(current[field], value)) changed[field] = value;
  }
  return changed;
}

/** Overrides are stored as JSON text (see schema.ts); these two keep the encoding in one place. */
export function encodeOverrideValue(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * Corrupt stored text yields `undefined` (JSON.parse never returns it, and
 * encode never writes it). Callers MUST treat that as "reject", not as null --
 * see applyMappingOverrides -- because validation reads undefined as "clear".
 */
export function decodeOverrideValue(stored: string): unknown {
  try {
    return JSON.parse(stored);
  } catch {
    return undefined;
  }
}
