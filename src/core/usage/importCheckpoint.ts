import { retentionCutoff } from '../settings/retentionSettings';

// Saved checkpoints lag behind so logs still being read at shutdown are imported again (upserts are idempotent).
export const CHECKPOINT_MARGIN_MS = 60_000;

/**
 * Start of the background import: the last saved checkpoint, or the start of today on first
 * run (or when the stored value is unusable). Never older than the retention window.
 */
export function importSince(lastTrackedAt: unknown, now: number, startOfDay: (ms: number) => number, retentionDays: number): number {
	const valid = typeof lastTrackedAt === 'number' && Number.isFinite(lastTrackedAt) && lastTrackedAt >= 0 && lastTrackedAt <= now;
	const since = valid ? lastTrackedAt : startOfDay(now);
	const cutoff = retentionCutoff(now, retentionDays);
	return cutoff === undefined ? since : Math.max(since, cutoff);
}

/** Value to save while tracking runs at `now`. */
export function checkpointAt(now: number): number {
	return now - CHECKPOINT_MARGIN_MS;
}
