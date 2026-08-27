/**
 * A bare, headerless request (Node's default fetch User-Agent is literally
 * "node") is exactly the kind of thing bot-detection heuristics flag on
 * some hosts, independent of whether the request is otherwise legitimate --
 * this project already ran into that with AniDB's Cloudflare protection.
 * Every outbound fetch this project makes (XML/JSON source downloads, and
 * eventually TVDB) should go through this instead of the bare global
 * `fetch`, so they all present as an ordinary browser request rather than
 * an unmistakably-automated one.
 */
export function fetchWithHeaders(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: 'application/json, text/xml, application/xml, */*',
      ...init.headers
    }
  });
}
