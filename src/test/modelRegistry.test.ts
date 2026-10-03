import * as assert from 'assert';
import { MODEL_ALIAS_DATA } from '../core/impact/data/modelAliases';
import { createModelRegistry, defaultModelRegistry, normalizeModelName } from '../core/impact/modelRegistry';

suite('Model registry', () => {
	const resolve = (model: string | undefined) => defaultModelRegistry.resolve(model);

	test('normalizes case, vendor prefixes, separators and snapshot suffixes', () => {
		assert.strictEqual(normalizeModelName('copilot/GPT-4.1'), 'gpt-4.1');
		assert.strictEqual(normalizeModelName('  Claude_Sonnet 4.5 '), 'claude-sonnet-4.5');
		assert.strictEqual(normalizeModelName('gpt-4.1-2025-04-14'), 'gpt-4.1');
		assert.strictEqual(normalizeModelName('claude-3-5-sonnet-20241022'), 'claude-3-5-sonnet');
		assert.strictEqual(normalizeModelName('claude-sonnet-4-latest'), 'claude-sonnet-4');
		assert.strictEqual(normalizeModelName('   '), undefined);
		assert.strictEqual(normalizeModelName(undefined), undefined);
	});

	test('resolves aliases and mixed casing to one canonical model', () => {
		for (const name of ['claude-opus-5.5', 'claude-opus-5-5', 'Claude-Opus-5-5', 'copilot/CLAUDE-5.5-OPUS']) {
			assert.deepStrictEqual(resolve(name), {
				normalized: normalizeModelName(name), canonicalModel: 'claude-opus-5.5', family: 'claude-opus', modelClass: 'frontier', match: 'model',
			}, name);
		}
		assert.strictEqual(resolve('claude-3-5-sonnet-20241022').canonicalModel, 'claude-3.5-sonnet');
		assert.strictEqual(resolve('gpt-4.1-2025-04-14').canonicalModel, 'gpt-4.1');
		assert.strictEqual(resolve('claude-4-sonnet').canonicalModel, 'claude-sonnet-4');
	});

	test('matches unlisted versions by family', () => {
		const cases: [string, string, string][] = [
			['claude-sonnet-4.7', 'claude-sonnet', 'medium'],
			['claude-opus-6', 'claude-opus', 'frontier'],
			['claude-haiku-5', 'claude-haiku', 'small'],
			['gpt-5.1-codex-mini', 'gpt-mini', 'small'],
			['gpt-5.2', 'gpt-5', 'frontier'],
			['o1-preview', 'openai-o', 'frontier'],
			['gemini-2.5-flash-lite', 'gemini-flash', 'small'],
			['gemini-3-pro', 'gemini-pro', 'frontier'],
		];
		for (const [name, family, modelClass] of cases) {
			const result = resolve(name);
			assert.deepStrictEqual([result.match, result.family, result.modelClass, result.canonicalModel], ['family', family, modelClass, undefined], name);
		}
	});

	test('keeps unknown names and assigns the unknown fallback', () => {
		assert.deepStrictEqual(resolve('Some-Future-Model'), { normalized: 'some-future-model', modelClass: 'unknown', match: 'unknown' });
		assert.deepStrictEqual(resolve('auto'), { normalized: 'auto', modelClass: 'unknown', match: 'unknown' });
		assert.deepStrictEqual(resolve('constructor'), { normalized: 'constructor', modelClass: 'unknown', match: 'unknown' });
		assert.deepStrictEqual(resolve(undefined), { modelClass: 'unknown', match: 'unknown' });
		assert.deepStrictEqual(resolve(''), { modelClass: 'unknown', match: 'unknown' });
	});

	test('alias data is consistent', () => {
		const lower = (key: string) => key === key.toLowerCase();
		for (const [alias, target] of Object.entries(MODEL_ALIAS_DATA.aliases)) {
			assert.ok(lower(alias), alias);
			assert.ok(Object.hasOwn(MODEL_ALIAS_DATA.models, target), `${alias} -> ${target}`);
		}
		for (const [model, family] of Object.entries(MODEL_ALIAS_DATA.models)) {
			assert.ok(lower(model), model);
			assert.ok(Object.hasOwn(MODEL_ALIAS_DATA.families, family), `${model} -> ${family}`);
			// The family pattern must agree with the explicit mapping, so family fallback stays consistent.
			const byPattern = createModelRegistry({ ...MODEL_ALIAS_DATA, models: {}, aliases: {} }).resolve(model);
			assert.strictEqual(byPattern.family, family, model);
		}
	});

	test('accepts injected alias data', () => {
		const registry = createModelRegistry({
			version: 'test',
			families: { tiny: { pattern: '^tiny', modelClass: 'small' } },
			models: { 'tiny-1': 'tiny' },
			aliases: { 't1': 'tiny-1' },
		});
		assert.strictEqual(registry.resolve('T1').canonicalModel, 'tiny-1');
		assert.strictEqual(registry.resolve('tiny-2').match, 'family');
		assert.strictEqual(registry.resolve('gpt-4.1').match, 'unknown');
	});
});
