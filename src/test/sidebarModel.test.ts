import * as assert from 'assert';
import { isHostToWebviewMessage } from '../core/messages/protocol';
import type { ModelSummary, ProviderShare } from '../core/storage/usageStore';
import type { AiUsageEvent } from '../core/usage/usageEvent';
import type { ProviderStatus } from '../core/usage/usageService';
import { LiveActivity } from '../core/view/liveActivity';
import { buildSidebarModel, SidebarModel } from '../core/view/sidebarModel';
import { largestRemainderPercents, toSidebarView } from '../core/view/sidebarView';

function event(id: string, status: AiUsageEvent['status'], extra: Partial<AiUsageEvent> = {}): AiUsageEvent {
	return { id, provider: 'claude-code', startedAt: '2026-10-01T10:00:00.000Z', source: 'actual', status, ...extra };
}

suite('LiveActivity', () => {
	test('tracks the most recent in-flight request and keeps the model across updates', () => {
		let now = 0;
		const live = new LiveActivity({ now: () => now });
		assert.strictEqual(live.current(), null);
		live.handle(event('a', 'started', { model: 'claude-sonnet-4' }));
		now = 10;
		live.handle(event('b', 'started', { provider: 'codex-cli', model: 'gpt-5' }));
		now = 20;
		live.handle(event('a', 'processing'));
		assert.deepStrictEqual(live.current(), { provider: 'claude-code', model: 'claude-sonnet-4', status: 'processing', tokens: null, updatedAt: 20 });
	});

	test('falls back to the last finished request, and drops stale in-flight ones', () => {
		let now = 0;
		const live = new LiveActivity({ now: () => now, staleMs: 100 });
		live.handle(event('a', 'started', { model: 'm' }));
		live.handle(event('a', 'failed'));
		assert.deepStrictEqual(live.current(), { provider: 'claude-code', model: 'm', status: 'failed', tokens: null, updatedAt: 0 });
		live.handle(event('b', 'processing'));
		assert.strictEqual(live.current()?.status, 'processing');
		now = 100;
		assert.strictEqual(live.current()?.status, 'failed');
		live.clear();
		assert.strictEqual(live.current(), null);
	});
});

suite('Sidebar model', () => {
	const statuses: ProviderStatus[] = [
		{ id: 'github-copilot', displayName: 'GitHub Copilot', state: 'unavailable', lastEventAt: null },
		{ id: 'claude-code', displayName: 'Claude Code', state: 'tracking', lastEventAt: 5 },
	];
	const providers: ProviderShare[] = [
		{ provider: 'github-copilot', requests: 1, tokens: 10, percent: 10 },
		{ provider: 'claude-code', requests: 2, tokens: 90, percent: 90 },
	];
	const models: ModelSummary[] = [
		{
			model: 'claude-sonnet-4', confidence: 'medium', factorLevel: 'class', tokenProvenance: { actual: 2, partial: 0, estimated: 0 }, methodologyVersions: ['1.0.0'],
			requests: 2, tokens: 90, energyWh: 0.4, carbonGrams: 0.1, waterLiters: 0.001,
		},
	];
	const today = { energyWh: 0.4, carbonGrams: 0.1, waterLiters: 0.001, tokens: 100, requests: 3 };
	const session = { ...today, requests: 1 };
	const emptyHistory = {
		available: false, todayMetrics: () => null, totals: () => session, periods: () => [], activity: () => [], providers: () => [], models: () => [],
	};

	test('gathers live, today, provider breakdown, models and detection in one place', () => {
		const model = buildSidebarModel({
			world: () => ({ worldState: 'ProcessingMedium', activeCount: 2 }),
			live: () => ({ provider: 'claude-code', model: 'claude-sonnet-4', status: 'processing', tokens: 1200, updatedAt: 1 }),
			history: { ...emptyHistory, available: true, todayMetrics: () => today, totals: () => session, providers: () => providers, models: () => models },
			statuses: () => statuses,
		});
		assert.deepStrictEqual(model, {
			worldState: 'ProcessingMedium',
			activeCount: 2,
			live: { provider: 'claude-code', providerName: 'Claude Code', model: 'claude-sonnet-4', status: 'processing', tokens: 1200, updatedAt: 1 },
			today,
			session,
			periods: [],
			activity: [],
			providers: [providers[1], providers[0]],
			models,
			providerStatuses: statuses,
			anyProviderDetected: true,
		});
	});

	test('reports the empty state when no provider is detected', () => {
		const model = buildSidebarModel({
			world: () => ({ worldState: 'Idle', activeCount: 0 }),
			live: () => null,
			history: emptyHistory,
			statuses: () => statuses.map(s => ({ ...s, state: 'unavailable' as const })),
		});
		assert.strictEqual(model.live, null);
		assert.strictEqual(model.today, null);
		assert.strictEqual(model.session, null, 'no session totals without history');
		assert.deepStrictEqual(model.periods, []);
		assert.strictEqual(model.activity, null);
		assert.strictEqual(model.anyProviderDetected, false);
	});
});

suite('Provider share rounding', () => {
	const sum = (values: number[]) => values.reduce((s, v) => s + v, 0);

	test('largest remainder always sums to 100 for any positive usage', () => {
		const cases: [number[], number[]][] = [
			[[1, 1, 1], [34, 33, 33]],
			[[61, 28, 11], [61, 28, 11]],
			[[2, 1], [67, 33]],
			[[9995, 5], [100, 0]],
			[[1, 1, 1, 1, 1, 1, 1], [15, 15, 14, 14, 14, 14, 14]],
			[[5, 0, 5], [50, 0, 50]],
			[[42], [100]],
		];
		for (const [values, expected] of cases) {
			const percents = largestRemainderPercents(values);
			assert.deepStrictEqual(percents, expected, JSON.stringify(values));
			assert.strictEqual(sum(percents), 100);
		}
	});

	test('no usage, negative or non-finite input yields 0 instead of a misleading share', () => {
		assert.deepStrictEqual(largestRemainderPercents([]), []);
		assert.deepStrictEqual(largestRemainderPercents([0, 0]), [0, 0]);
		assert.deepStrictEqual(largestRemainderPercents([-5, NaN, Infinity, 10]), [0, 0, 0, 100]);
	});
});

suite('Sidebar view', () => {
	const statuses: ProviderStatus[] = [
		{ id: 'github-copilot', displayName: 'GitHub Copilot', state: 'tracking', lastEventAt: 1 },
		{ id: 'claude-code', displayName: 'Claude Code', state: 'unavailable', lastEventAt: null },
		{ id: 'codex-cli', displayName: 'Codex CLI', state: 'stopped', lastEventAt: null },
	];
	const base: SidebarModel = {
		worldState: 'ProcessingHeavy',
		activeCount: 2,
		live: { provider: 'github-copilot', providerName: 'GitHub Copilot', model: 'gpt-4.1', status: 'processing', tokens: null, updatedAt: 5 },
		today: { energyWh: 1.24, carbonGrams: 0.38, waterLiters: 0.0084, tokens: 1_200_000, requests: 42 },
		session: null,
		periods: [],
		activity: null,
		providers: [
			{ provider: 'github-copilot', requests: 30, tokens: 2, percent: 66.7 },
			{ provider: 'codex-cli', requests: 5, tokens: 1, percent: 33.3 },
			{ provider: 'claude-code', requests: 7, tokens: 0, percent: 0 },
		],
		models: [],
		providerStatuses: statuses,
		anyProviderDetected: true,
	};

	test('formats today, rounds shares and lists detection without timestamps or paths', () => {
		const view = toSidebarView(base, { firstRun: true });
		assert.deepStrictEqual(view, {
			live: { providerName: 'GitHub Copilot', model: 'gpt-4.1', status: 'processing', tokens: null, updatedAt: 5 },
			today: {
				...base.today,
				text: { energy: '1.24 Wh', carbon: '0.38 g CO₂e', water: '8.4 ml', tokens: '1.2M', requests: '42' },
			},
			session: null,
			periods: [],
			activity: null,
			providers: [
				{ id: 'github-copilot', name: 'GitHub Copilot', tokens: 2, percent: 67 },
				{ id: 'codex-cli', name: 'Codex CLI', tokens: 1, percent: 33 },
				{ id: 'claude-code', name: 'Claude Code', tokens: 0, percent: null },
			],
			setup: {
				firstRun: true,
				providers: [
					{ id: 'github-copilot', name: 'GitHub Copilot', state: 'tracking' },
					{ id: 'claude-code', name: 'Claude Code', state: 'unavailable' },
					{ id: 'codex-cli', name: 'Codex CLI', state: 'stopped' },
				],
			},
		});
		assert.ok(isHostToWebviewMessage({ type: 'view', ...view }));
	});

	test('empty and unusual input still produces a valid view', () => {
		const empty = toSidebarView({ ...base, live: null, today: null, providers: [], providerStatuses: [] }, { firstRun: false });
		assert.deepStrictEqual(empty, { live: null, today: null, session: null, periods: [], activity: null, providers: [], setup: { firstRun: false, providers: [] } });
		const odd = toSidebarView({
			...base,
			live: { ...base.live!, provider: 'claude-code', providerName: 'Claude Code', model: `  x\u0000y${'z'.repeat(300)}` },
			providers: [{ provider: 'claude-code', requests: 1, tokens: 0, percent: 0 }],
		}, { firstRun: false });
		assert.strictEqual(odd.live?.model?.length, 128);
		assert.ok(odd.live?.model?.startsWith('xyz'));
		assert.deepStrictEqual(odd.providers, [{ id: 'claude-code', name: 'Claude Code', tokens: 0, percent: null }]);
		assert.ok(isHostToWebviewMessage({ type: 'view', ...odd }));
		const blankModel = toSidebarView({ ...base, live: { ...base.live!, model: '   ' } }, { firstRun: false });
		assert.strictEqual(blankModel.live?.model, null);
	});
});
