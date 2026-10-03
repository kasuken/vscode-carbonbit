import * as assert from 'assert';
import { BACKFILL_DAYS, BACKFILL_VERSION, CHECKPOINT_MARGIN_MS, checkpointAt, importSince, needsBackfill } from '../core/usage/importCheckpoint';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T09:30:00.000Z');
const START_OF_DAY = Date.parse('2026-10-02T00:00:00.000Z');
const startOfDay = () => START_OF_DAY;

suite('Import checkpoint', () => {
	test('resumes from the last saved checkpoint', () => {
		const last = NOW - 3 * 60 * 60 * 1000;
		assert.strictEqual(importSince(last, NOW, startOfDay, 90, BACKFILL_VERSION), last);
	});

	test('first run (or an unusable value) imports from the start of today', () => {
		for (const stored of [undefined, null, 'yesterday', Number.NaN, -1, NOW + 1]) {
			assert.strictEqual(importSince(stored, NOW, startOfDay, 90, BACKFILL_VERSION), START_OF_DAY, String(stored));
		}
	});

	test('never imports beyond the retention window', () => {
		assert.strictEqual(importSince(NOW - 400 * DAY_MS, NOW, startOfDay, 7, BACKFILL_VERSION), NOW - 7 * DAY_MS);
		assert.strictEqual(importSince(NOW - 400 * DAY_MS, NOW, startOfDay, 0, BACKFILL_VERSION), NOW - 400 * DAY_MS, 'unlimited retention');
	});

	test('until the backfill has run once, history is imported up to the retention window', () => {
		for (const stored of [undefined, null, 0, 'yes', BACKFILL_VERSION - 1]) {
			assert.strictEqual(needsBackfill(stored), true, String(stored));
			assert.strictEqual(importSince(undefined, NOW, startOfDay, 90, stored), NOW - 90 * DAY_MS, 'first run reads 90 days back');
			assert.strictEqual(importSince(NOW - 60_000, NOW, startOfDay, 90, stored), NOW - 90 * DAY_MS, 'existing installs backfill once too');
		}
		assert.strictEqual(importSince(undefined, NOW, startOfDay, 7, undefined), NOW - 7 * DAY_MS);
		assert.strictEqual(importSince(undefined, NOW, startOfDay, 0, undefined), NOW - BACKFILL_DAYS * DAY_MS, 'unlimited retention is capped');
		assert.strictEqual(needsBackfill(BACKFILL_VERSION), false);
		assert.strictEqual(importSince(NOW - 60_000, NOW, startOfDay, 90, BACKFILL_VERSION), NOW - 60_000, 'afterwards: checkpoint as before');
	});

	test('saved checkpoints lag behind so the end of a session is read again', () => {
		assert.strictEqual(checkpointAt(NOW), NOW - CHECKPOINT_MARGIN_MS);
		assert.ok(CHECKPOINT_MARGIN_MS > 2000, 'margin covers at least one poll interval');
	});
});
