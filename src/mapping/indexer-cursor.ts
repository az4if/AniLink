import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export async function readCursor(jobName: string): Promise<number> {
  const row = await db.query.indexerState.findFirst({ where: eq(schema.indexerState.jobName, jobName) });
  return row?.cursor ?? 0;
}

export async function writeCursor(jobName: string, cursor: number): Promise<void> {
  await db
    .insert(schema.indexerState)
    .values({ jobName, cursor, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.indexerState.jobName, set: { cursor, updatedAt: new Date() } });
}
