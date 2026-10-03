import * as assert from 'assert';
import { modelClassOf } from '../core/impact/modelRegistry';
import type { AiUsageEvent } from '../core/usage/usageEvent';
import { classifyIntensity, FALLBACK_INTENSITY, HEAVY_TOKENS, MEDIUM_TOKENS } from '../core/world/worldIntensity';

function ev(fields: Partial<AiUsageEvent>): AiUsageEvent {
	return { id: 'a', provider: 'github-copilot', startedAt: '2026-10-01T10:00:00.000Z', source: 'actual', status: 'processing', ...fields };
}

suite('World intensity', () => {
	test('uses the model registry visualization class by default', () => {
		const cases: [string | undefined, string][] = [
			['gpt-4o-mini', 'small'], ['o3-mini', 'small'], ['claude-3.5-haiku', 'small'], ['gemini-2.0-flash', 'small'],
			['claude-opus-4', 'frontier'], ['gemini-2.5-pro', 'frontier'], ['o1', 'frontier'],
			['claude-sonnet-4', 'medium'], ['gpt-4.1-2025-04-14', 'medium'], ['GPT-4o', 'medium'],
			['some-future-model', 'unknown'], ['auto', 'unknown'], [undefined, 'unknown'],
		];
		for (const [model, expected] of cases) {
			assert.strictEqual(modelClassOf(model), expected, String(model));
		}
	});

	test('maps model class and request size to intensity', () => {
		assert.strictEqual(classifyIntensity(ev({ model: 'gpt-4o-mini' })), 'light');
		assert.strictEqual(classifyIntensity(ev({ model: 'claude-sonnet-4' })), 'medium');
		assert.strictEqual(classifyIntensity(ev({ model: 'claude-opus-4', inputTokens: 10 })), 'heavy');
		// The heavier signal wins.
		assert.strictEqual(classifyIntensity(ev({ model: 'gpt-4o-mini', inputTokens: HEAVY_TOKENS })), 'heavy');
		assert.strictEqual(classifyIntensity(ev({ model: 'gpt-4o-mini', inputTokens: MEDIUM_TOKENS - 1, outputTokens: 1 })), 'medium');
	});

	test('unknown models fall back to request size, then to the documented default', () => {
		assert.strictEqual(FALLBACK_INTENSITY, 'medium');
		assert.strictEqual(classifyIntensity(ev({ model: 'some-future-model' })), 'medium');
		assert.strictEqual(classifyIntensity(ev({ status: 'started' })), 'medium');
		assert.strictEqual(classifyIntensity(ev({ model: 'some-future-model', inputTokens: 500, outputTokens: 50 })), 'light');
		assert.strictEqual(classifyIntensity(ev({ outputTokens: HEAVY_TOKENS })), 'heavy');
	});

	test('accepts an injected model classifier', () => {
		assert.strictEqual(classifyIntensity(ev({ model: 'some-future-model' }), () => 'frontier'), 'heavy');
		assert.strictEqual(classifyIntensity(ev({ model: 'claude-opus-4' }), () => 'unknown'), 'medium');
	});
});
