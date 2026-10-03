import * as assert from 'assert';
import { AI_PROVIDER_IDS, isAiUsageEvent, validateAiUsageEvent } from '../core/usage/usageEvent';

const base = {
	id: 'evt-1',
	provider: 'github-copilot',
	startedAt: '2026-10-01T10:00:00.000Z',
	source: 'actual',
	status: 'started',
};

suite('AiUsageEvent validation', () => {
	test('accepts a minimal started event without model or tokens', () => {
		assert.ok(isAiUsageEvent(base));
	});

	test('accepts every P0 provider id', () => {
		assert.deepStrictEqual([...AI_PROVIDER_IDS], ['github-copilot', 'github-copilot-cli', 'claude-code', 'codex-cli']);
		for (const provider of AI_PROVIDER_IDS) {
			assert.ok(isAiUsageEvent({ ...base, provider }), provider);
		}
	});

	test('accepts a processing event with model but no tokens', () => {
		assert.ok(isAiUsageEvent({ ...base, status: 'processing', model: 'gpt-4.1' }));
	});

	test('accepts a completed event with full token data', () => {
		const result = validateAiUsageEvent({
			...base,
			provider: 'claude-code',
			model: 'claude-sonnet-4',
			status: 'completed',
			completedAt: '2026-10-01T10:00:05.000Z',
			inputTokens: 1200,
			outputTokens: 340,
			cachedInputTokens: 800,
			cacheCreationTokens: 0,
		});
		assert.strictEqual(result.valid, true);
	});

	test('accepts completed/failed events with partial or estimated data', () => {
		assert.ok(isAiUsageEvent({ ...base, status: 'completed', source: 'estimated', outputTokens: 50 }));
		assert.ok(isAiUsageEvent({ ...base, status: 'failed', completedAt: '2026-10-01T10:00:01.000Z' }));
	});

	test('rejects non-objects', () => {
		for (const value of [null, undefined, 42, 'evt', []]) {
			assert.strictEqual(isAiUsageEvent(value), false);
		}
	});

	test('rejects missing required fields', () => {
		for (const key of ['id', 'provider', 'startedAt', 'source', 'status']) {
			const event: Record<string, unknown> = { ...base };
			delete event[key];
			assert.strictEqual(isAiUsageEvent(event), false, key);
		}
	});

	test('rejects invalid enum values and timestamps', () => {
		assert.strictEqual(isAiUsageEvent({ ...base, provider: 'cursor' }), false);
		assert.strictEqual(isAiUsageEvent({ ...base, source: 'guessed' }), false);
		assert.strictEqual(isAiUsageEvent({ ...base, status: 'done' }), false);
		assert.strictEqual(isAiUsageEvent({ ...base, startedAt: 'yesterday' }), false);
		assert.strictEqual(isAiUsageEvent({ ...base, id: '' }), false);
		assert.strictEqual(isAiUsageEvent({ ...base, model: '' }), false);
	});

	test('rejects negative, fractional or non-numeric token counts', () => {
		for (const bad of [-1, 1.5, '10', NaN]) {
			assert.strictEqual(isAiUsageEvent({ ...base, status: 'completed', inputTokens: bad }), false, String(bad));
		}
	});

	test('rejects inconsistent lifecycle timestamps', () => {
		assert.strictEqual(isAiUsageEvent({ ...base, status: 'completed', completedAt: '2026-10-01T09:59:59.000Z' }), false);
		assert.strictEqual(isAiUsageEvent({ ...base, status: 'processing', completedAt: '2026-10-01T10:00:05.000Z' }), false);
	});

	test('rejects unknown fields such as conversation content', () => {
		const result = validateAiUsageEvent({ ...base, prompt: 'secret code' });
		assert.strictEqual(result.valid, false);
		assert.ok(!result.valid && result.errors.some(e => e.includes('prompt')));
	});
});
