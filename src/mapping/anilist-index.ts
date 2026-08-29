import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { fetchAniListMedia, type AniListMedia, type AniListRelation } from './anilist-client.js';

type SegmentValue = {
  segmentKey: string;
  anidbId: number;
  anilistId: number;
  relationType: string;
  format: string | null;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  episodeStart: number | null;
  episodeEnd: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
  updatedAt: Date;
};

function preferredTitle(title: AniListMedia['title'] | AniListRelation['title']): string | null {
  return title.english ?? title.romaji ?? title.native ?? null;
}

/**
 * Produces auditable segment records. Only the directly mapped AniList
 * entry receives an episode range; relations remain candidates so separate
 * cours, OVAs, ONAs and specials cannot be accidentally stitched together.
 */
export function buildAniListSegments(anidbId: number, media: AniListMedia): SegmentValue[] {
  const now = new Date();
  const direct: SegmentValue = {
    segmentKey: `${anidbId}:${media.id}`,
    anidbId,
    anilistId: media.id,
    relationType: 'SELF',
    format: media.format,
    title: preferredTitle(media.title),
    startDate: media.startDate,
    endDate: media.endDate,
    episodeStart: media.episodes === null ? null : 1,
    episodeEnd: media.episodes,
    confidence: 100,
    evidence: { kind: 'direct-mapping', anilistId: media.id },
    updatedAt: now
  };

  const related = media.relations.map((relation): SegmentValue => ({
    segmentKey: `${anidbId}:${relation.id}`,
    anidbId,
    anilistId: relation.id,
    relationType: relation.relationType,
    format: relation.format,
    title: preferredTitle(relation.title),
    startDate: relation.startDate,
    endDate: relation.endDate,
    episodeStart: null,
    episodeEnd: relation.episodes,
    confidence: ['PREQUEL', 'SEQUEL', 'PARENT'].includes(relation.relationType) ? 60 : 50,
    evidence: {
      kind: 'anilist-relation',
      relationType: relation.relationType,
      sourceAnilistId: media.id,
      relationAnilistId: relation.id
    },
    updatedAt: now
  }));

  return [direct, ...related];
}

/** Fetches AniList metadata, fills only missing mapping fields, and records relations without auto-combining them. */
export async function indexAniListForAnime(anidbId: number, anilistId: number): Promise<AniListMedia> {
  const media = await fetchAniListMedia(anilistId);
  const now = new Date();
  await db
    .insert(schema.anilistCache)
    .values({
      anilistId: media.id,
      rawData: media,
      format: media.format,
      status: media.status,
      episodeCount: media.episodes,
      nextEpisode: media.nextAiringEpisode?.episode ?? null,
      lastScrapedAt: now
    })
    .onConflictDoUpdate({
      target: schema.anilistCache.anilistId,
      set: {
        rawData: media,
        format: media.format,
        status: media.status,
        episodeCount: media.episodes,
        nextEpisode: media.nextAiringEpisode?.episode ?? null,
        lastScrapedAt: now
      }
    });

  const row = await db.query.mapping.findFirst({ where: eq(schema.mapping.anidbId, anidbId) });
  if (row) {
    await db
      .update(schema.mapping)
      .set({
        malId: row.malId ?? media.idMal,
        title: row.title ?? preferredTitle(media.title),
        type: row.type ?? media.format,
        updatedAt: now
      })
      .where(eq(schema.mapping.anidbId, anidbId));
  }

  for (const segment of buildAniListSegments(anidbId, media)) {
    await db
      .insert(schema.animeSegment)
      .values(segment)
      .onConflictDoUpdate({
        target: schema.animeSegment.segmentKey,
        set: {
          relationType: segment.relationType,
          format: segment.format,
          title: segment.title,
          startDate: segment.startDate,
          endDate: segment.endDate,
          episodeStart: segment.episodeStart,
          episodeEnd: segment.episodeEnd,
          confidence: segment.confidence,
          evidence: segment.evidence,
          updatedAt: now
        }
      });
  }

  return media;
}
