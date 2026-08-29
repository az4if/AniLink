import { parseAnimeListXmlFile } from '../src/mapping/xml-parser.js';
import { resolveEpisode, reverseResolveRegular, type ResolvedEpisode } from '../src/mapping/resolver.js';
import { fileURLToPath } from 'node:url';

const rows = parseAnimeListXmlFile(fileURLToPath(new URL('./anime-list-master.sample.xml', import.meta.url)));
const byId = new Map(rows.map((r) => [r.anidbId, r]));

let pass = 0;
let fail = 0;

function check(label: string, actual: ResolvedEpisode, expected: ResolvedEpisode) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
}

console.log(`Parsed ${rows.length} anime from anime-list-master.xml\n`);

// --- Cowboy Bebop (anidbid=23) ---------------------------------------
// <anime anidbid="23" tvdbid="76885" defaulttvdbseason="1" episodeoffset="">
//   <mapping-list><mapping anidbseason="0" tvdbseason="0" start="1" end="3" offset="1">;4-0;</mapping></mapping-list>
{
  const row = byId.get(23)!;
  console.log('Cowboy Bebop (23)');
  check('regular ep5 -> plain default offset', resolveEpisode(row, { season: 1, number: 5 }, 'tvdb'), {
    mode: 'season-episode', season: 1, episodes: [5]
  });
  check('special S1 -> range+offset(+1)', resolveEpisode(row, { season: 0, number: 1 }, 'tvdb'), {
    mode: 'season-episode', season: 0, episodes: [2]
  });
  check('special S3 -> range+offset(+1)', resolveEpisode(row, { season: 0, number: 3 }, 'tvdb'), {
    mode: 'season-episode', season: 0, episodes: [4]
  });
  check('special S4 -> explicit override to 0 = unmapped', resolveEpisode(row, { season: 0, number: 4 }, 'tvdb'), {
    mode: 'unmapped'
  });
  check('special S5 -> outside range, no default for specials = unmapped', resolveEpisode(row, { season: 0, number: 5 }, 'tvdb'), {
    mode: 'unmapped'
  });
}

// --- .hack//Sign (anidbid=24) -----------------------------------------
// <mapping-list><mapping anidbseason="0" tvdbseason="0">;2-6;</mapping></mapping-list>
{
  const row = byId.get(24)!;
  console.log('.hack//Sign (24)');
  check('special S2 -> explicit single pair', resolveEpisode(row, { season: 0, number: 2 }, 'tvdb'), {
    mode: 'season-episode', season: 0, episodes: [6]
  });
  check('special S1 -> not covered = unmapped', resolveEpisode(row, { season: 0, number: 1 }, 'tvdb'), {
    mode: 'unmapped'
  });
  check('regular ep3 -> plain default offset', resolveEpisode(row, { season: 1, number: 3 }, 'tvdb'), {
    mode: 'season-episode', season: 1, episodes: [3]
  });
}

// --- Chobits (anidbid=12) ----------------------------------------------
// <mapping-list><mapping anidbseason="0" tvdbseason="0">;1-3;2-4;</mapping></mapping-list>
{
  const row = byId.get(12)!;
  console.log('Chobits (12)');
  check('special S1 -> explicit', resolveEpisode(row, { season: 0, number: 1 }, 'tvdb'), {
    mode: 'season-episode', season: 0, episodes: [3]
  });
  check('special S2 -> explicit', resolveEpisode(row, { season: 0, number: 2 }, 'tvdb'), {
    mode: 'season-episode', season: 0, episodes: [4]
  });
  check('special S3 -> uncovered = unmapped', resolveEpisode(row, { season: 0, number: 3 }, 'tvdb'), {
    mode: 'unmapped'
  });
}

// --- Initial D Battle Stage (anidbid=11) -------------------------------
// <anime anidbid="11" tvdbid="70900" defaulttvdbseason="0" episodeoffset="2"> -- whole show lives in TVDB's specials
{
  const row = byId.get(11)!;
  console.log('Initial D Battle Stage (11)');
  check('regular ep1 -> default season IS tvdb specials, offset+2', resolveEpisode(row, { season: 1, number: 1 }, 'tvdb'), {
    mode: 'season-episode', season: 0, episodes: [3]
  });
  check('special S1 -> no rule, no default for specials = unmapped', resolveEpisode(row, { season: 0, number: 1 }, 'tvdb'), {
    mode: 'unmapped'
  });
}

// --- Rizelmine (anidbid=19) -- absolute numbering WITH explicit range overrides ----
// <anime ... defaulttvdbseason="a" tmdbseason="a">
//   <mapping anidbseason="1" tvdbseason="1" start="1" end="12"/>
//   <mapping anidbseason="1" tvdbseason="2" start="13" end="24" offset="-12"/>
{
  const row = byId.get(19)!;
  console.log('Rizelmine (19)');
  check('ep1 -> range rule wins over absolute flag', resolveEpisode(row, { season: 1, number: 1 }, 'tvdb'), {
    mode: 'season-episode', season: 1, episodes: [1]
  });
  check('ep12 -> still season 1 range', resolveEpisode(row, { season: 1, number: 12 }, 'tvdb'), {
    mode: 'season-episode', season: 1, episodes: [12]
  });
  check('ep13 -> season 2 range, offset -12', resolveEpisode(row, { season: 1, number: 13 }, 'tvdb'), {
    mode: 'season-episode', season: 2, episodes: [1]
  });
  check('ep24 -> season 2 range, offset -12', resolveEpisode(row, { season: 1, number: 24 }, 'tvdb'), {
    mode: 'season-episode', season: 2, episodes: [12]
  });
  check('ep25 -> outside every range, falls to absolute', resolveEpisode(row, { season: 1, number: 25 }, 'tvdb'), {
    mode: 'absolute', anidbNumber: 25
  });
}

// --- Round-trip property, across the WHOLE real catalog -----------------
// For every anime and every regular episode 1..30, whatever resolveEpisode
// maps it to, reverseResolveRegular should map straight back to the
// original number -- UNLESS multiple different anidb numbers were
// explicitly mapped to the exact same destination in the source data
// itself (real example: Ghost in the Shell, anidbId=61, maps six different
// catalog entries to the same single TVDB episode -- see mapping-list
// above). That's genuine information loss in anime-lists-xml, not
// something reverseResolveRegular can recover -- so those destinations are
// tracked separately rather than treated as failures.
{
  console.log('Round-trip property (resolveEpisode -> reverseResolveRegular) across all 16,865 real entries');

  // first pass: find every destination more than one n forward-resolves to.
  // Sweeps 1..30 (covers ordinary regular numbering) PLUS every number that
  // actually appears as an explicit mapping-list key on that row (covers
  // the Dragon Ball Z Gaiden case: explicit keys 401/402/403 coexist with a
  // default-offset rule that ALSO lands on the same destination for n=1/2 --
  // a genuine collision in the source data that a fixed 1..30 sweep alone
  // would miss entirely, since 401+ is outside that range).
  const destinationSources = new Map<string, Set<number>>(); // "anidbId|target|season|episode" -> {n, n, ...}
  for (const row of rows) {
    const explicitKeys = new Set<number>();
    for (const entry of row.mappingList) {
      if (entry.explicit) for (const k of Object.keys(entry.explicit)) explicitKeys.add(Number(k));
    }
    const candidates = new Set([...Array.from({ length: 30 }, (_, i) => i + 1), ...explicitKeys]);

    for (const target of ['tvdb', 'tmdb'] as const) {
      for (const n of candidates) {
        const forward = resolveEpisode(row, { season: 1, number: n }, target);
        if (forward.mode !== 'season-episode') continue;
        for (const ep of forward.episodes) {
          const key = `${row.anidbId}|${target}|${forward.season}|${ep}`;
          if (!destinationSources.has(key)) destinationSources.set(key, new Set());
          destinationSources.get(key)!.add(n);
        }
      }
    }
  }
  const ambiguousDestinations = [...destinationSources.values()].filter((s) => s.size > 1).length;
  const uniqueDestinations = destinationSources.size - ambiguousDestinations;

  // second pass: round-trip only the unambiguous destinations, still using
  // the same 1..30 sweep as the actual regression check (that's the space
  // reverseResolveRegular is meant to cover in practice)
  let checked = 0;
  let mismatches = 0;
  for (const row of rows) {
    for (const target of ['tvdb', 'tmdb'] as const) {
      for (let n = 1; n <= 30; n++) {
        const forward = resolveEpisode(row, { season: 1, number: n }, target);
        if (forward.mode !== 'season-episode') continue;
        for (const ep of forward.episodes) {
          const key = `${row.anidbId}|${target}|${forward.season}|${ep}`;
          if (destinationSources.get(key)!.size > 1) continue; // known-ambiguous, skip
          checked++;
          const back = reverseResolveRegular(row, { season: forward.season, number: ep }, target);
          if (back !== n) {
            mismatches++;
            if (mismatches <= 8) {
              console.log(`  MISMATCH anidbId=${row.anidbId} n=${n} target=${target} -> forward ${JSON.stringify(forward)} -> back ${back}`);
            }
          }
        }
      }
    }
  }
  console.log(`  ${uniqueDestinations} unique destinations, ${ambiguousDestinations} ambiguous (multiple anidb numbers -> same destination in the source data, e.g. Ghost in the Shell)`);
  check(`round-trip holds across all ${checked} unambiguous real episodes`, mismatches, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
