import * as assert from 'assert';
import { CHECKPOINT_MARGIN_MS, checkpointAt, importSince } from '../core/usage/importCheckpoint';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-02T09:30:00.000Z');
const START_OF_DAY = Date.parse('2026-10-02T00:00:00.000Z');
const startOfDay = () => START_OF_DAY;

suite('Import checkpoint', () => {
	test('resumes from the last saved checkpoint', () => {
		const last = NOW - 3 * 60 * 60 * 1000;
		assert.strictEqual(importSince(last, NOW, startOfDay, 90), last);
	});

	test('first run (or an unusable value) imports from the start of today', () => {
		for (const stored of [undefined, null, 'yesterday', Number.NaN, -1, NOW + 1]) {
			assert.strictEqual(importSince(stored, NOW, startOfDay, 90), START_OF_DAY, String(stored));
		}
	});

	test('never imports beyond the retention window', () => {
		assert.strictEqual(importSince(NOW - 400 * DAY_MS, NOW, startOfDay, 7), NOW - 7 * DAY_MS);
		assert.strictEqual(importSince(NOW - 400 * DAY_MS, NOW, startOfDay, 0), NOW - 400 * DAY_MS, 'unlimited retention');
	});

	test('saved checkpoints lag behind so the end of a session is read again', () => {
		assert.strictEqual(checkpointAt(NOW), NOW - CHECKPOINT_MARGIN_MS);
		assert.ok(CHECKPOINT_MARGIN_MS > 2000, 'margin covers at least one poll interval');
	});
});
