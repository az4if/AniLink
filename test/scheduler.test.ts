import { every, jsonQueue } from '../src/scheduler/index.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Catches exactly the bug that shipped: setInterval's delay argument is a
  // 32-bit signed int (max ~2,147,483,647ms / ~24.8 days). Node doesn't
  // throw on overflow -- it silently clamps to firing every 1ms, which is
  // how the original scheduler ended up hammering the job queue nonstop
  // instead of running monthly. This test fails loudly if that regresses.
  let overflowWarning = false;
  const onWarning = (w: Error) => {
    if (w.name === 'TimeoutOverflowWarning') overflowWarning = true;
  };
  process.on('warning', onWarning);

  // Absurdly large -- 100,000 hours is ~11.4 years, nowhere near
  // expressible as a single setInterval delay in ms.
  let hugeIntervalFireCount = 0;
  every(jsonQueue, 100_000, 'test:huge-interval-job', 1, async () => {
    hugeIntervalFireCount++;
  });

  // Tiny -- fires almost immediately, proving `every()` still works at all
  // (not just "doesn't crash").
  let tinyIntervalFireCount = 0;
  every(jsonQueue, 1 / 3_600_000, 'test:tiny-interval-job', 1, async () => {
    tinyIntervalFireCount++;
  });

  await sleep(400);
  process.off('warning', onWarning);

  check('no TimeoutOverflowWarning from a 100,000-hour interval', overflowWarning, false);
  check('the huge-interval job still runs its immediate startup fire (not spamming beyond that)', hugeIntervalFireCount, 1);
  check('the tiny-interval job actually fires', tinyIntervalFireCount >= 1, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0); // the timers inside every() are .unref()'d, but exit explicitly to be sure
}

main();
