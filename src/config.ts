import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const Config = {
  databaseUrl: required('DATABASE_URL'),
  port: Number(process.env.PORT ?? 3000),
  publicUrl: process.env.PUBLIC_URL ?? '',
  renderKeepAlive: (process.env.RENDER_KEEP_ALIVE ?? 'false').toLowerCase() === 'true',

  tvdb: {
    apiKey: process.env.TVDB_API_KEY ?? '',
    apiPin: process.env.TVDB_API_PIN ?? ''
  },

  anidb: {
    client: process.env.ANIDB_CLIENT ?? '',
    clientVersion: process.env.ANIDB_CLIENT_VERSION ?? '1'
  },

  adminKey: process.env.ADMIN_KEY ?? 'change-me'
};
