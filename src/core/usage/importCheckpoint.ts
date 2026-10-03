import { retentionCutoff } from '../settings/retentionSettings';

// Saved checkpoints lag behind so logs still being read at shutdown are imported again (upserts are idempotent).
export const CHECKPOINT_MARGIN_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** History is backfilled at most this far back, even with unlimited retention. */
export const BACKFILL_DAYS = 365;
/** Bump to backfill history once more on existing installs. */
export const BACKFILL_VERSION = 1;

/** Whether the one-time history backfill (still) has to run; `stored` is the saved version. */
export function needsBackfill(stored: unknown): boolean {
	return !(typeof stored === 'number' && stored >= BACKFILL_VERSION);
}

/**
 * Start of the background import. Until the history backfill has completed once, everything the
 * tools' logs still hold, up to `BACKFILL_DAYS`; afterwards the last saved checkpoint, or the start
 * of today when it is unusable. Never older than the retention window. Re-reading overlapping
 * history is safe: requests are upserted by id.
 */
export function importSince(
	lastTrackedAt: unknown,
	now: number,
	startOfDay: (ms: number) => number,
	retentionDays: number,
	backfilled: unknown,
): number {
	const valid = typeof lastTrackedAt === 'number' && Number.isFinite(lastTrackedAt) && lastTrackedAt >= 0 && lastTrackedAt <= now;
	const since = needsBackfill(backfilled) ? now - BACKFILL_DAYS * DAY_MS : valid ? lastTrackedAt : startOfDay(now);
	const cutoff = retentionCutoff(now, retentionDays);
	return cutoff === undefined ? since : Math.max(since, cutoff);
}

/** Value to save while tracking runs at `now`. */
export function checkpointAt(now: number): number {
	return now - CHECKPOINT_MARGIN_MS;
}
