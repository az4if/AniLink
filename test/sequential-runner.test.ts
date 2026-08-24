import { sequentialCore } from '../src/mapping/sequential-runner.js';

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

async function main() {
  // --- ask -> get -> index -> wait -> next id, in order ------------------
  {
    const order: string[] = [];
    const DELAY = 30;

    const result = await sequentialCore(
      'test:basic',
      ['id1', 'id2', 'id3'],
      0,
      async (id) => {
        order.push(`index:${id}`);
      },
      undefined,
      DELAY
    );

    check('indexes every id in order', order, ['index:id1', 'index:id2', 'index:id3']);
    check('processed count matches', result.processed, 3);
    check('reports done + cursor reset to 0 on a full pass', { done: result.done, endCursor: result.endCursor }, { done: true, endCursor: 0 });
  }

  // --- the wait actually happens BETWEEN ids, not after the last one -----
  {
    const timestamps: number[] = [];
    const DELAY = 60;

    await sequentialCore(
      'test:timing',
      ['a', 'b', 'c'],
      0,
      async () => {
        timestamps.push(Date.now());
      },
      undefined,
      DELAY
    );

    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    // generous tolerance for CI/sandbox jitter -- just needs to be roughly DELAY, not 0
    check('waits ~DELAY between id 1 and id 2', gap1 >= DELAY - 15, true);
    check('waits ~DELAY between id 2 and id 3', gap2 >= DELAY - 15, true);
  }

  {
    // no trailing wait after the last id -- total time should be close to
    // 2 delays (between 3 items), not 3
    const start = Date.now();
    await sequentialCore('test:no-trailing-wait', ['x', 'y', 'z'], 0, async () => {}, undefined, 50);
    const elapsed = Date.now() - start;
    check('no delay after the final id (elapsed well under 3x DELAY)', elapsed < 50 * 3, true);
  }

  // --- resumes from a given start cursor, not always from 0 --------------
  {
    const indexed: string[] = [];
    await sequentialCore(
      'test:resume',
      ['id1', 'id2', 'id3', 'id4'],
      2, // resume from index 2, i.e. id3
      async (id) => {
        indexed.push(id);
      },
      undefined,
      1
    );
    check('resumes from the given cursor, skipping already-processed ids', indexed, ['id3', 'id4']);
  }

  // --- yields cooperatively, checkpointing the cursor, no crash ----------
  {
    const indexed: string[] = [];
    let yieldNow = false;

    const result = await sequentialCore(
      'test:yield',
      ['id1', 'id2', 'id3', 'id4', 'id5'],
      0,
      async (id) => {
        indexed.push(id);
        if (id === 'id2') yieldNow = true; // simulate a higher-priority job arriving
      },
      { shouldYield: () => yieldNow },
      1
    );

    check('stops right after the id being processed when yield is requested', indexed, ['id1', 'id2']);
    check('reports yielded, not done', { done: result.done, yielded: result.yielded }, { done: false, yielded: true });
    check('checkpoints the cursor at the right position to resume from', result.endCursor, 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
