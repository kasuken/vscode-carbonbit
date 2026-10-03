import * as assert from 'assert';
import { Confidence, confidenceFor, FactorLevel, TokenProvenance } from '../core/impact/confidence';
import { ENVIRONMENTAL_FACTORS, EnergyFactor, EnvironmentalFactorData } from '../core/impact/data/environmentalFactors';
import { ImpactEngine } from '../core/impact/impactEngine';
import type { AiUsageEvent } from '../core/usage/usageEvent';

function ev(fields: Partial<AiUsageEvent>): AiUsageEvent {
	return { id: 'a', provider: 'github-copilot', startedAt: '2026-10-01T10:00:00.000Z', completedAt: '2026-10-01T10:00:05.000Z', source: 'actual', status: 'completed', ...fields };
}

function close(actual: number, expected: number, message?: string): void {
	assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);
}

const engine = new ImpactEngine();
const G_PER_KWH = ENVIRONMENTAL_FACTORS.carbonIntensity.gramsCo2ePerKWh;
const L_PER_KWH = ENVIRONMENTAL_FACTORS.waterIntensity.litersPerKWh;

suite('Impact engine', () => {
	test('computes energy, carbon and water from token counts with the class factor', () => {
		const estimate = engine.estimate(ev({ model: 'claude-sonnet-4.5', inputTokens: 1000, outputTokens: 500 }))!;
		// medium class: 1000 x 0.00015 + 500 x 0.0006 Wh
		close(estimate.energyWh, 0.45);
		close(estimate.carbonGrams, 0.45 / 1000 * G_PER_KWH);
		close(estimate.waterLiters, 0.45 / 1000 * L_PER_KWH);
		assert.strictEqual(estimate.factorLevel, 'class');
		assert.strictEqual(estimate.confidence, 'medium');
		assert.strictEqual(estimate.methodology, 'carbonbit-impact');
		assert.strictEqual(estimate.methodologyVersion, ENVIRONMENTAL_FACTORS.methodology.version);
		assert.strictEqual(estimate.estimated, true);
	});

	test('scales by visualization class and falls back to the generic factor', () => {
		const out = (model: string | undefined) => engine.estimate(ev({ model, inputTokens: 0, outputTokens: 1000 }))!;
		close(out('gpt-4o-mini').energyWh, 0.15);
		close(out('gpt-4.1').energyWh, 0.6);
		close(out('Claude-Opus-5-5').energyWh, 1.8);
		const unknown = out('some-future-model');
		close(unknown.energyWh, 0.6);
		assert.deepStrictEqual([unknown.factorLevel, unknown.confidence, unknown.model.normalized], ['generic', 'low', 'some-future-model']);
		assert.deepStrictEqual([out(undefined).factorLevel, out(undefined).confidence], ['generic', 'low']);
	});

	test('weights cached and cache-creation tokens per methodology', () => {
		const estimate = engine.estimate(ev({ model: 'gpt-4.1', inputTokens: 1000, cachedInputTokens: 10_000, cacheCreationTokens: 2000, outputTokens: 0 }))!;
		// 1000 + 10000 x 0.1 + 2000 x 1 = 4000 weighted input tokens
		close(estimate.energyWh, 4000 * 0.00015);
	});

	test('handles missing and partial token counts', () => {
		assert.strictEqual(engine.estimate(ev({ model: 'gpt-4.1' })), undefined);
		assert.strictEqual(engine.estimate(ev({ status: 'started', completedAt: undefined })), undefined);
		const inputOnly = engine.estimate(ev({ model: 'gpt-4.1', inputTokens: 900 }))!;
		close(inputOnly.energyWh, 900 * 0.00015);
		assert.deepStrictEqual([inputOnly.tokenSource, inputOnly.confidence], ['partial', 'low']);
		const cachedOnly = engine.estimate(ev({ model: 'gpt-4.1', cachedInputTokens: 1000 }))!;
		close(cachedOnly.energyWh, 100 * 0.00015);
	});

	test('keeps failed requests that have usage', () => {
		const failed = engine.estimate(ev({ status: 'failed', model: 'gpt-4.1', inputTokens: 1000, outputTokens: 10 }))!;
		assert.ok(failed.energyWh > 0);
	});

	test('estimated token counts lower confidence', () => {
		const estimated = engine.estimate(ev({ source: 'estimated', model: 'gpt-4.1', inputTokens: 1000, outputTokens: 100 }))!;
		assert.deepStrictEqual([estimated.tokenSource, estimated.confidence], ['estimated', 'low']);
	});

	test('prefers model-specific, then family, then class factors', () => {
		const factor = (wh: number): EnergyFactor => ({ label: `test ${wh}`, whPerInputToken: 0, whPerOutputToken: wh, sources: [], assumptions: [], limitations: [] });
		const data: EnvironmentalFactorData = {
			...ENVIRONMENTAL_FACTORS,
			energy: { ...ENVIRONMENTAL_FACTORS.energy, models: { 'claude-sonnet-4.5': factor(1) }, families: { 'claude-sonnet': factor(2) } },
		};
		const custom = new ImpactEngine(data);
		const run = (model: string, source: AiUsageEvent['source'] = 'actual') => custom.estimate(ev({ model, source, inputTokens: 0, outputTokens: 1 }))!;
		assert.deepStrictEqual([run('claude-sonnet-4-5').factorLevel, run('claude-sonnet-4-5').energyWh, run('claude-sonnet-4-5').confidence], ['model', 1, 'high']);
		assert.strictEqual(run('claude-sonnet-4-5', 'estimated').confidence, 'medium');
		assert.deepStrictEqual([run('claude-sonnet-4').factorLevel, run('claude-sonnet-4').energyWh, run('claude-sonnet-4').confidence], ['family', 2, 'medium']);
		assert.strictEqual(run('claude-sonnet-9', 'estimated').confidence, 'low');
		assert.strictEqual(run('claude-opus-4').factorLevel, 'class');
	});

	test('explains every estimate and marks fallbacks', () => {
		const known = engine.estimate(ev({ model: 'claude-sonnet-4.5', inputTokens: 10, outputTokens: 10 }))!;
		assert.deepStrictEqual(known.reasons.map(r => [r.kind, r.code]), [
			['tokens', 'actual'], ['model', 'model'], ['energy', 'class'], ['carbonIntensity', 'generic'], ['water', 'generic'],
		]);
		assert.match(known.reasons[1].text, /claude-sonnet-4\.5/);
		assert.match(known.reasons[2].text, /Model-class estimate \(medium\)/);
		assert.match(known.reasons[3].text, /Generic infrastructure estimate/);

		const unknown = engine.estimate(ev({ model: 'mystery', source: 'estimated', inputTokens: 10 }))!;
		assert.deepStrictEqual(unknown.reasons.map(r => r.code), ['estimated', 'unknown', 'generic', 'generic', 'generic']);
		assert.match(unknown.reasons[1].text, /not recognized; generic fallback/);
		assert.match(unknown.reasons[2].text, /Generic inference estimate/);
		assert.strictEqual(unknown.estimated, true);
	});

	test('is deterministic', () => {
		const event = ev({ model: 'gpt-5', inputTokens: 12_345, outputTokens: 678, cachedInputTokens: 9000 });
		assert.deepStrictEqual(engine.estimate(event), new ImpactEngine().estimate({ ...event }));
	});
});

suite('Confidence', () => {
	test('combines factor level with token provenance', () => {
		const expected: Record<FactorLevel, Record<TokenProvenance, Confidence>> = {
			model: { actual: 'high', estimated: 'medium', partial: 'medium' },
			family: { actual: 'medium', estimated: 'low', partial: 'low' },
			class: { actual: 'medium', estimated: 'low', partial: 'low' },
			generic: { actual: 'low', estimated: 'low', partial: 'low' },
		};
		for (const [level, row] of Object.entries(expected) as [FactorLevel, Record<TokenProvenance, Confidence>][]) {
			for (const [tokens, confidence] of Object.entries(row) as [TokenProvenance, Confidence][]) {
				assert.strictEqual(confidenceFor(level, tokens), confidence, `${level}/${tokens}`);
			}
		}
	});
});

suite('Environmental factor data', () => {
	test('every published value has provenance', () => {
		const data = ENVIRONMENTAL_FACTORS;
		assert.match(data.methodology.version, /^\d+\.\d+\.\d+$/);
		assert.ok(!Number.isNaN(Date.parse(data.methodology.effectiveDate)));
		for (const [id, source] of Object.entries(data.sources)) {
			assert.ok(source.url.startsWith('https://'), id);
			assert.ok(source.title && source.author && source.usedFor, id);
		}
		const factors = [
			...Object.values(data.energy.models), ...Object.values(data.energy.families),
			...Object.values(data.energy.classes), data.energy.generic, data.carbonIntensity, data.waterIntensity,
		];
		for (const factor of factors) {
			assert.ok(factor.sources.length > 0, factor.label);
			assert.ok(factor.sources.every(s => Object.hasOwn(data.sources, s)), factor.label);
			assert.ok(factor.assumptions.length > 0 && factor.limitations.length > 0, factor.label);
		}
		for (const factor of [...Object.values(data.energy.classes), data.energy.generic]) {
			assert.ok(factor.whPerInputToken > 0 && factor.whPerOutputToken > 0, factor.label);
		}
		assert.ok(data.tokenWeights.assumptions.length > 0);
		assert.ok(data.carbonIntensity.gramsCo2ePerKWh > 0 && data.waterIntensity.litersPerKWh > 0);
	});
});
