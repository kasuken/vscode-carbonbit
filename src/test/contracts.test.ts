import * as assert from 'assert';
import type {
	CommandMessage,
	ConfigMessage,
	DismissOnboardingMessage,
	HostToWebviewMessage,
	ReadyMessage,
	StateMessage,
	TodayMetrics,
	ViewMessage,
	WebviewToHostMessage,
} from '../core/messages/protocol';
import { isHostToWebviewMessage, isWebviewToHostMessage, SIDEBAR_COMMANDS } from '../core/messages/protocol';
import type { AiProviderAdapter, AiUsageEventListener } from '../core/providers/provider';
import { AI_PROVIDER_IDS, isAiUsageEvent, type AiProviderId, type AiUsageEvent } from '../core/usage/usageEvent';

// Compile-time shape locks: renaming, retyping, adding or removing a field breaks `npm run compile`.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(): void { /* compile-time only */ }

assertType<Equal<AiUsageEvent, {
	id: string;
	provider: 'github-copilot' | 'github-copilot-cli' | 'claude-code' | 'codex-cli';
	model?: string;
	startedAt: string;
	completedAt?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	cacheCreationTokens?: number;
	source: 'actual' | 'estimated';
	status: 'started' | 'processing' | 'completed' | 'failed';
}>>();
assertType<Equal<keyof AiProviderAdapter, 'id' | 'displayName' | 'isAvailable' | 'start' | 'stop' | 'refresh' | 'onUsageEvent'>>();
assertType<Equal<Parameters<AiUsageEventListener>, [event: AiUsageEvent, origin?: 'live' | 'import']>>();
assertType<Equal<TodayMetrics, { energyWh: number; carbonGrams: number; waterLiters: number; tokens: number; requests: number }>>();
assertType<Equal<StateMessage, {
	type: 'state';
	worldState: 'Idle' | 'RequestStarting' | 'ProcessingLight' | 'ProcessingMedium' | 'ProcessingHeavy' | 'ResponseArriving' | 'Failed';
	activeCount: number;
}>>();
type TotalsLock = {
	energyWh: number; carbonGrams: number; waterLiters: number; tokens: number; requests: number;
	text: { energy: string; carbon: string; water: string; tokens: string; requests: string };
};
assertType<Equal<ViewMessage, {
	type: 'view';
	live: {
		providerName: string; model: string | null; status: 'started' | 'processing' | 'completed' | 'failed';
		tokens: string | null; updatedAt: number;
	} | null;
	today: TotalsLock | null;
	session: TotalsLock | null;
	periods: {
		id: 'today' | 'last30Days' | 'previousMonth' | 'projectedYear';
		label: string;
		note: string | null;
		totals: TotalsLock;
		carbon: { id: 'car' | 'train' | 'flight' | 'kettle' | 'phone' | 'led'; amount: string; unit: string }[];
		water: { id: 'tea' | 'shower' | 'laundry' | 'bath' | 'dishwasher' | 'drinking'; amount: string; unit: string }[];
	}[];
	activity: { bucketMinutes: number; tokens: number[]; summary: string } | null;
	providers: { id: AiProviderId; name: string; tokens: number; percent: number | null }[];
	setup: { firstRun: boolean; providers: { id: AiProviderId; name: string; state: 'stopped' | 'tracking' | 'unavailable' | 'failed' }[] };
}>>();
assertType<Equal<ReadyMessage, { type: 'ready' }>>();
assertType<Equal<CommandMessage, {
	type: 'command';
	command: 'carbonbit.showDetails' | 'carbonbit.showMethodology' | 'carbonbit.refreshUsage' | 'carbonbit.openDiagnostics';
}>>();
assertType<Equal<DismissOnboardingMessage, { type: 'dismissOnboarding' }>>();
assertType<Equal<ConfigMessage, { type: 'config'; animationEnabled: boolean; maxFps: number; visualMode: 'environmental' | 'neutral' | 'minimal' }>>();
assertType<Equal<HostToWebviewMessage, StateMessage | ViewMessage | ConfigMessage>>();
assertType<Equal<WebviewToHostMessage, ReadyMessage | CommandMessage | DismissOnboardingMessage>>();

function eventFixtures(provider: AiProviderId) {
	const started = { id: `${provider}-1`, provider, startedAt: '2026-10-01T10:00:00.000Z', source: 'estimated', status: 'started' } satisfies AiUsageEvent;
	return {
		valid: [
			started,
			{ ...started, status: 'processing', model: 'model-x' },
			{ ...started, status: 'completed', completedAt: '2026-10-01T10:00:03.000Z', outputTokens: 12 },
			{
				...started, source: 'actual', status: 'completed', model: 'model-x', completedAt: '2026-10-01T10:00:05.000Z',
				inputTokens: 100, outputTokens: 20, cachedInputTokens: 50, cacheCreationTokens: 0,
			},
			{ ...started, status: 'failed', completedAt: '2026-10-01T10:00:01.000Z' },
		] satisfies AiUsageEvent[],
		invalid: [
			{ ...started, tokensIn: 100 },
			{ ...started, input_tokens: 100 },
			{ ...started, inputTokens: '100' },
			{ ...started, startedAt: 1759312800000 },
			{ ...started, status: 'complete' },
			{ ...started, source: 'actual-ish' },
			{ ...started, provider: provider.toUpperCase() },
			{ ...started, response: 'generated code' },
		] as unknown[],
	};
}

suite('Contract compatibility', () => {
	for (const provider of AI_PROVIDER_IDS) {
		test(`usage event fixtures for ${provider}`, () => {
			const { valid, invalid } = eventFixtures(provider);
			for (const e of valid) {
				assert.ok(isAiUsageEvent(e), JSON.stringify(e));
				assert.ok(isAiUsageEvent(JSON.parse(JSON.stringify(e))), 'survives serialization');
			}
			for (const e of invalid) {
				assert.strictEqual(isAiUsageEvent(e), false, JSON.stringify(e));
			}
		});
	}

	test('message fixtures', () => {
		const today = { energyWh: 1.5, carbonGrams: 0.4, waterLiters: 0.01, tokens: 2000, requests: 3 } satisfies TodayMetrics;
		const text = { energy: '1.5 Wh', carbon: '0.4 g CO₂e', water: '10 ml', tokens: '2K', requests: '3' };
		const setup = { firstRun: false, providers: [{ id: 'claude-code', name: 'Claude Code', state: 'tracking' }] } as const;
		const period = {
			id: 'today', label: 'Today', note: null, totals: { ...today, text },
			carbon: [{ id: 'car', amount: '0.0025', unit: 'km driving (petrol car)' }],
			water: [{ id: 'tea', amount: '0.04', unit: 'mugs of tea or coffee' }],
		} as const;
		const view = {
			type: 'view',
			live: { providerName: 'Claude Code', model: 'claude-sonnet-4', status: 'processing', tokens: '2K', updatedAt: 1_759_312_800_000 },
			today: { ...today, text },
			session: { ...today, text },
			periods: [{ ...period, carbon: [...period.carbon], water: [...period.water] }],
			activity: { bucketMinutes: 2, tokens: [0, 1200, 800], summary: '2K tokens in the last 6 minutes' },
			providers: [{ id: 'claude-code', name: 'Claude Code', tokens: 2000, percent: 100 }],
			setup: { firstRun: false, providers: [...setup.providers] },
		} satisfies ViewMessage;
		const validHost = [
			{ type: 'state', worldState: 'Idle', activeCount: 0 },
			{ type: 'state', worldState: 'ProcessingHeavy', activeCount: 2 },
			view,
			{ type: 'view', live: null, today: null, session: null, periods: [], activity: null, providers: [], setup: { firstRun: true, providers: [] } },
			{ type: 'config', animationEnabled: true, maxFps: 30, visualMode: 'environmental' },
		] satisfies HostToWebviewMessage[];
		const invalidHost: unknown[] = [
			{ type: 'state', state: 'Idle', activeCount: 0 },
			{ type: 'state', worldState: 'Idle', activeCount: 0, today: null },
			{ type: 'state', worldState: 'Idle' },
			{ ...view, today },
			{ ...view, today: { ...today, text, energy: 1 } },
			{ ...view, live: { ...view.live, prompt: 'hi' } },
			{ ...view, live: { ...view.live, updatedAt: -1 } },
			{ ...view, periods: [{ ...period, id: 'forever' }] },
			{ ...view, periods: [{ ...period, carbon: [{ id: 'rocket', amount: '1', unit: 'launch' }] }] },
			{ ...view, periods: [{ ...period, water: [{ id: 'tea', amount: '1', unit: 'mug', path: '/home' }] }] },
			{ ...view, activity: { ...view.activity, tokens: [1.5] } },
			{ ...view, activity: { ...view.activity, bucketMinutes: 0 } },
			{ ...view, session: undefined },
			{ ...view, providers: [{ ...view.providers[0], file: '/home/me/x.ts' }] },
			{ ...view, setup: { ...setup, path: '/home' } },
			{ type: 'update', worldState: 'Idle', activeCount: 0 },
			{ type: 'config', enabled: true, maxFps: 30, visualMode: 'neutral' },
			{ type: 'config', animation: { enabled: true, maxFps: 30 } },
			{ type: 'config', animationEnabled: true, maxFps: 30 },
		];
		const validWebview = [
			{ type: 'ready' },
			{ type: 'dismissOnboarding' },
			...SIDEBAR_COMMANDS.map(command => ({ type: 'command', command }) as const),
		] satisfies WebviewToHostMessage[];
		const invalidWebview: unknown[] = [
			{ type: 'ready', payload: {} },
			{ kind: 'ready' },
			{ type: 'command', command: 'carbonbit.clearLocalData' },
			{ type: 'command', command: 'workbench.action.quit' },
			{ type: 'command', command: 'carbonbit.showDetails', args: [] },
			{ type: 'dismissOnboarding', forever: true },
		];

		for (const m of validHost) {
			assert.ok(isHostToWebviewMessage(structuredClone(m)), JSON.stringify(m));
		}
		for (const m of invalidHost) {
			assert.strictEqual(isHostToWebviewMessage(m), false, JSON.stringify(m));
		}
		for (const m of validWebview) {
			assert.ok(isWebviewToHostMessage(structuredClone(m)), JSON.stringify(m));
		}
		for (const m of invalidWebview) {
			assert.strictEqual(isWebviewToHostMessage(m), false, JSON.stringify(m));
		}
	});
});
