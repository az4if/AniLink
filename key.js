/*
 * Public browser configuration for Ryuu.
 *
 * This file is intentionally safe to publish: AniList's browser OAuth flow only
 * needs the client ID. Never add an AniList client secret here; use a server-side
 * environment variable if you later add a backend authorization-code exchange.
 */
window.RYUU_CONFIG = Object.freeze({
  anilist: {
    clientId: 49840,
    redirectUrl: 'https://az4if.github.io/ryuu/',
    graphqlUrl: 'https://graphql.anilist.co',
    authorizeUrl: 'https://anilist.co/api/v2/oauth/authorize'
  },
  episodeMapper: {
    baseUrl: 'https://anime-public-db-mapper.vercel.app/'
  }
});
