import * as assert from 'assert';
import { CARBON_EQUIVALENT_IDS, ENVIRONMENTAL_FACTORS, WATER_EQUIVALENT_IDS } from '../core/impact/data/environmentalFactors';
import { equivalentsOf } from '../core/impact/equivalents';
import { formatAmount } from '../core/impact/units';
import { LiveActivity } from '../core/view/liveActivity';
import { activityView } from '../core/view/sidebarView';

suite('Everyday comparisons', () => {
	test('formatAmount keeps about three significant digits and groups thousands', () => {
		const cases: [number, string][] = [
			[0, '0'], [-1, '0'], [NaN, '0'], [0.004, '<0.01'], [0.01, '0.01'], [0.7746, '0.775'], [1, '1'],
			[6.971, '6.97'], [46.47, '46.5'], [231.1, '231'], [999.4, '999'], [999.5, '1,000'], [1386.2, '1,386'], [112_528, '112,528'],
		];
		for (const [value, text] of cases) {
			assert.strictEqual(formatAmount(value), text, String(value));
		}
	});

	test('every comparison is sourced or states its assumption, with a positive unit value', () => {
		const { equivalents, sources } = ENVIRONMENTAL_FACTORS;
		for (const factor of [...Object.values(equivalents.carbon), ...Object.values(equivalents.water)]) {
			assert.ok(factor.perUnit > 0, factor.one);
			assert.ok(factor.assumptions.length > 0, `${factor.one} states its assumptions`);
			assert.ok(factor.limitations.length > 0, `${factor.one} states its limitations`);
			for (const id of factor.sources) {
				assert.ok(sources[id], `${factor.one} cites a known source ${id}`);
			}
		}
		assert.deepStrictEqual(Object.keys(equivalents.carbon), [...CARBON_EQUIVALENT_IDS]);
		assert.deepStrictEqual(Object.keys(equivalents.water), [...WATER_EQUIVALENT_IDS]);
	});

	test('transport compares CO₂e, household devices compare energy and water compares litres', () => {
		const { carbon, water } = equivalentsOf({ carbonGrams: 162.72 * 2, energyWh: 120, waterLiters: 0.25 });
		const byId = Object.fromEntries([...carbon, ...water].map(e => [e.id, e]));
		assert.strictEqual(byId.car.amountText, '2');
		assert.strictEqual(byId.kettle.amountText, '1');
		assert.strictEqual(byId.kettle.unit, 'kettle boil', 'singular for exactly one');
		assert.strictEqual(byId.led.amountText, '12');
		assert.strictEqual(byId.led.unit, 'hours of a 10 W LED bulb');
		assert.strictEqual(byId.tea.unit, 'mug of tea or coffee');
		assert.strictEqual(byId.bath.amountText, '<0.01');
	});

	test('no usage reads as zero, never as a misleading amount', () => {
		const { carbon, water } = equivalentsOf({ carbonGrams: 0, energyWh: NaN, waterLiters: -1 });
		assert.ok([...carbon, ...water].every(e => e.amount === 0 && e.amountText === '0'));
	});
});

suite('Live activity details', () => {
	test('the live request carries its reported tokens across lifecycle updates', () => {
		let now = 0;
		const live = new LiveActivity({ now: () => now });
		const base = { id: 'r', provider: 'claude-code', startedAt: '2026-10-01T10:00:00.000Z', source: 'actual' } as const;
		live.handle({ ...base, status: 'started' });
		assert.strictEqual(live.current()?.tokens, null);
		now = 5;
		live.handle({ ...base, status: 'processing', inputTokens: 1000, cachedInputTokens: 4000 });
		assert.strictEqual(live.current()?.tokens, 5000);
		live.handle({ ...base, status: 'completed', outputTokens: 300, inputTokens: 1000, cachedInputTokens: 4000 });
		assert.deepStrictEqual(live.current(), { provider: 'claude-code', model: null, status: 'completed', tokens: 5300, updatedAt: 5 });
	});

	test('a quick succession of completions from a per-call tool reads as an agent loop at work', () => {
		let now = 0;
		const live = new LiveActivity({ now: () => now, agentLoopGapMs: 15_000 });
		const call = (id: string, provider: 'claude-code' | 'github-copilot') =>
			live.handle({ id, provider, startedAt: '2026-10-01T10:00:00.000Z', source: 'actual', status: 'completed', outputTokens: 10 });
		call('a', 'claude-code');
		assert.strictEqual(live.current()?.status, 'completed', 'a single completion is just a completion');
		now = 6_000;
		call('b', 'claude-code');
		assert.strictEqual(live.current()?.status, 'processing');
		now = 20_999;
		assert.strictEqual(live.current()?.status, 'processing');
		now = 21_000;
		assert.strictEqual(live.current()?.status, 'completed', 'the loop ends once no call follows within the gap');
		now = 22_000;
		call('c', 'github-copilot');
		now = 23_000;
		call('d', 'github-copilot');
		assert.strictEqual(live.current()?.status, 'completed', 'tools that report in-flight requests are never inferred');
	});

	test('the activity summary names the window and handles silence', () => {
		const empty = activityView(Array.from({ length: 30 }, () => ({ requests: 0, tokens: 0, energyWh: 0, carbonGrams: 0, waterLiters: 0 })));
		assert.strictEqual(empty.summary, 'No activity in the last hour');
		assert.strictEqual(empty.bucketMinutes, 2);
		const busy = activityView([{ requests: 2, tokens: 1234.4, energyWh: 1, carbonGrams: 1, waterLiters: 1 }]);
		assert.deepStrictEqual([busy.tokens, busy.summary], [[1234], '1.2K tokens in the last 2 minutes']);
	});
});
