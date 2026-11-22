import { createHash } from 'node:crypto';
import { fetchWithHeaders } from './fetch.js';

/**
 * What we remember about the last successfully *processed* copy of a remote
 * source. Persisted by source-state.ts; this file is deliberately free of any
 * DB import so the logic can be unit tested on its own.
 */
export type SourceFingerprint = {
  etag: string | null;
  lastModified: string | null;
  contentHash: string | null;
  contentLength: number | null;
};

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type FetchOptions = {
  /** Skip change detection entirely and always hand back the body. */
  force?: boolean;
  /** Used in error messages, e.g. "anime-list-master.xml". */
  label?: string;
  /** Injectable for tests. Defaults to the browser-UA fetch used everywhere else. */
  fetcher?: Fetcher;
};

export type FetchTextResult =
  | { changed: false; reason: 'not-modified' | 'same-content'; fingerprint: SourceFingerprint }
  | { changed: true; body: string; fingerprint: SourceFingerprint };

export type FetchStreamResult =
  | { changed: false; reason: 'not-modified'; fingerprint: SourceFingerprint }
  | { changed: true; body: ReadableStream<Uint8Array>; headers: Pick<SourceFingerprint, 'etag' | 'lastModified'> };

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Conditional-request headers for a fingerprint we already hold. ETag is the
 * reliable validator so it wins; Last-Modified is only used when the server
 * never gave us an ETag.
 */
export function conditionalHeaders(prev: SourceFingerprint | null | undefined): Record<string, string> {
  if (!prev) return {};
  if (prev.etag) return { 'If-None-Match': prev.etag };
  if (prev.lastModified) return { 'If-Modified-Since': prev.lastModified };
  return {};
}

function headerFingerprint(headers: Headers): Pick<SourceFingerprint, 'etag' | 'lastModified'> {
  return { etag: headers.get('etag'), lastModified: headers.get('last-modified') };
}

/**
 * Downloads a text source only if it changed since `prev`.
 *
 * Two layers, because not every host honours conditional requests:
 *  1. Send If-None-Match / If-Modified-Since. A 304 costs almost nothing.
 *  2. If the server answers 200 anyway, hash the body and compare it with the
 *     stored hash, so the (much more expensive) parse + DB write is still skipped.
 *
 * The caller must persist `fingerprint` only AFTER it has processed the body
 * successfully. Persisting earlier would make a crash look like "already done"
 * and the next run would skip a source that never actually got ingested.
 */
export async function fetchTextIfChanged(
  url: string,
  prev: SourceFingerprint | null,
  options: FetchOptions = {}
): Promise<FetchTextResult> {
  const fetcher = options.fetcher ?? fetchWithHeaders;
  const label = options.label ?? url;
  const conditional = options.force ? {} : conditionalHeaders(prev);

  const res = await fetcher(url, { headers: conditional });
  if (res.status === 304 && prev) {
    return { changed: false, reason: 'not-modified', fingerprint: prev };
  }
  if (!res.ok) throw new Error(`Failed to download ${label}: HTTP ${res.status}`);

  const body = await res.text();
  const fingerprint: SourceFingerprint = {
    ...headerFingerprint(res.headers),
    contentHash: sha256Hex(body),
    contentLength: new TextEncoder().encode(body).length
  };

  if (!options.force && prev?.contentHash && prev.contentHash === fingerprint.contentHash) {
    return { changed: false, reason: 'same-content', fingerprint };
  }
  return { changed: true, body, fingerprint };
}

/**
 * Streaming variant for sources too large to hold as one string. Only layer 1
 * (conditional request) can be decided up front; the caller hashes the stream
 * while consuming it and does the same-content comparison itself afterwards.
 */
export async function fetchStreamIfChanged(
  url: string,
  prev: SourceFingerprint | null,
  options: FetchOptions = {}
): Promise<FetchStreamResult> {
  const fetcher = options.fetcher ?? fetchWithHeaders;
  const label = options.label ?? url;
  const conditional = options.force ? {} : conditionalHeaders(prev);

  const res = await fetcher(url, { headers: conditional });
  if (res.status === 304 && prev) {
    return { changed: false, reason: 'not-modified', fingerprint: prev };
  }
  if (!res.ok) throw new Error(`Failed to download ${label}: HTTP ${res.status}`);
  if (!res.body) throw new Error(`Failed to download ${label}: response had no body`);

  return { changed: true, body: res.body, headers: headerFingerprint(res.headers) };
}
