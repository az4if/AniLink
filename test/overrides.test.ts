import { buildOverridePatch, changedFields, decodeOverrideValue, encodeOverrideValue, isOverridableField, OVERRIDABLE_FIELDS, validateOverrideValue } from '../src/mapping/overrides.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}
const ok = (field: string, value: unknown) => validateOverrideValue(field, value);

console.log('validateOverrideValue');
check('integer id accepted', ok('tvdbId', 98765), { ok: true, value: 98765 });
check('null clears a nullable column', ok('malId', null), { ok: true, value: null });
check('undefined is treated as null', ok('malId', undefined), { ok: true, value: null });
check('string for an integer column rejected', ok('tvdbId', '98765').ok, false);
check('float rejected', ok('tvdbId', 1.5).ok, false);
check('NaN / Infinity rejected', [ok('tvdbId', NaN).ok, ok('tvdbId', Infinity).ok], [false, false]);
check('text trimmed', ok('animePlanetId', '  cowboy-bebop '), { ok: true, value: 'cowboy-bebop' });
check('empty text rejected (use null to clear)', ok('title', '   ').ok, false);
check('boolean column takes booleans only', [ok('tvdbAbsolute', true).ok, ok('tvdbAbsolute', 'yes').ok], [true, false]);
check('boolean NOT NULL column cannot be cleared', ok('tvdbAbsolute', null).ok, false);
check('int[] accepted', ok('tmdbMovieIds', [1, 2]), { ok: true, value: [1, 2] });
check('empty int[] stored as null, matching how the sources store "none"', ok('tmdbMovieIds', []), { ok: true, value: null });
check('int[] with a non-integer rejected', ok('tmdbMovieIds', [1, 'a']).ok, false);
check('text[] trimmed', ok('imdbIds', [' tt0213338 ']), { ok: true, value: ['tt0213338'] });
check('text[] with an empty string rejected', ok('imdbIds', ['tt1', '']).ok, false);

console.log('field allow-list');
check('mappingList is NOT overridable (too large to hand-edit safely)', isOverridableField('mappingList'), false);
check('airing snapshot is NOT overridable (owned by the airing feed)', ['airing', 'episodeProgress', 'nextEpisodeAt'].map(isOverridableField), [false, false, false]);
check('primary key is NOT overridable', isOverridableField('anidbId'), false);
check('prototype keys are not mistaken for fields', ['constructor', 'toString', '__proto__'].map(isOverridableField), [false, false, false]);
{
  const r = ok('mappingList', []);
  check('rejection lists what IS allowed', !r.ok && r.error.includes('tvdbId'), true);
}
check('every offered field validates a null or a typed value without throwing', Object.keys(OVERRIDABLE_FIELDS).every((f) => typeof validateOverrideValue(f, null).ok === 'boolean'), true);

console.log('buildOverridePatch');
{
  const { patch, rejected } = buildOverridePatch([
    { field: 'tvdbId', value: 98765 },
    { field: 'malId', value: null },
    { field: 'bogus', value: 1 },
    { field: 'tvdbEpisodeOffset', value: 'twelve' }
  ]);
  check('valid overrides merge into one patch', patch, { tvdbId: 98765, malId: null });
  check('invalid ones are reported, not silently dropped', rejected.map((r) => r.field), ['bogus', 'tvdbEpisodeOffset']);
}
check('one bad value does not block the good ones', buildOverridePatch([{ field: 'malId', value: 'x' }, { field: 'kitsuId', value: 5 }]).patch, { kitsuId: 5 });

console.log('changedFields');
const row = { tvdbId: 111, malId: null, imdbIds: ['tt1'], tmdbMovieIds: null };
check('only differing columns are written', changedFields(row, { tvdbId: 111, malId: 5 }), { malId: 5 });
check('null vs undefined is not a change', changedFields({ malId: undefined }, { malId: null }), {});
check('arrays compare by value', changedFields(row, { imdbIds: ['tt1'] }), {});
check('arrays that differ are changes', changedFields(row, { imdbIds: ['tt1', 'tt2'] }), { imdbIds: ['tt1', 'tt2'] });
check('clearing a set column is a change', changedFields(row, { tvdbId: null }), { tvdbId: null });
check('already-correct row -> nothing to write (idempotent apply)', changedFields(row, { tvdbId: 111, malId: null }), {});

console.log('stored encoding (JSON text, so a value keeps its JSON type)');
for (const value of [98765, 'cowboy-bebop', '123', '001', [1, 2], ['tt1'], true, null]) {
  check(`round-trips ${JSON.stringify(value)}`, decodeOverrideValue(encodeOverrideValue(value)), value);
}
check('a numeric-looking slug stays a string (the reason it is not stored as jsonb)', typeof decodeOverrideValue(encodeOverrideValue('123')), 'string');
check('corrupt stored text decodes to undefined instead of throwing', decodeOverrideValue('{not json'), undefined);
check('encode never produces something that decodes to undefined (so undefined always means corrupt)', decodeOverrideValue(encodeOverrideValue(undefined)), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
