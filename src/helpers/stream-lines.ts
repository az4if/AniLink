/**
 * Splits a web ReadableStream of bytes into text lines without ever holding
 * the whole body in memory. Used for the (tens of MB) JSONL catalog source.
 *
 * - UTF-8 sequences that straddle a chunk boundary are decoded correctly
 *   (TextDecoder in streaming mode).
 * - `\r\n` and `\n` both terminate a line; the terminator is not yielded.
 * - `onChunk` sees every raw byte chunk exactly once, which is how callers
 *   hash the body while parsing it (see catalog-ingest.ts).
 *
 * Uses getReader() rather than `for await` on the stream so it type-checks
 * and runs identically on every supported Node version.
 */
export async function* streamLines(
  body: ReadableStream<Uint8Array>,
  onChunk?: (chunk: Uint8Array) => void
): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finished = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.(value);
      buffer += decoder.decode(value, { stream: true });

      let start = 0;
      let newline = buffer.indexOf('\n', start);
      while (newline !== -1) {
        yield stripCarriageReturn(buffer.slice(start, newline));
        start = newline + 1;
        newline = buffer.indexOf('\n', start);
      }
      buffer = buffer.slice(start);
    }

    buffer += decoder.decode(); // flush any trailing partial sequence
    if (buffer.length > 0) yield stripCarriageReturn(buffer);
    finished = true;
  } finally {
    // Consumer stopped early or something threw: don't leave the socket open.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
