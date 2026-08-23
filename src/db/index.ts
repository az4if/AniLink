import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Config } from '../config.js';
import * as schema from './schema.js';

// max: keep this low. We're a single small always-on process, not a
// request-per-invocation serverless function, so we don't need a big pool.
const client = postgres(Config.databaseUrl, { max: 5 });

export const db = drizzle(client, { schema });
export { schema };
