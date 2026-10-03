import * as assert from 'assert';
import * as fs from 'fs';
import type { StateMessage } from '../core/messages/protocol';
import type { AiProviderAdapter, AiUsageEventListener, Disposable, UsageEventOrigin } from '../core/providers/provider';
import type { AiProviderId, AiUsageEvent } from '../core/usage/usageEvent';
import { UsageService } from '../core/usage/usageService';
import { DEFAULT_WORLD_TIMINGS, WorldStateEngine } from '../core/world/worldStateEngine';
import { postWorldState } from '../sidebar/messageHandler';
import { assertNoContent, createHarness, readFixture } from './copilotChatHarness';
import { FakeClock } from './fakeClock';

class FakeAdapter implements AiProviderAdapter {
	readonly listeners = new Set<AiUsageEventListener>();
	started = false;
	stopped = false;

	constructor(
		readonly id: AiProviderId,
		readonly behavior: { available?: boolean; startThrows?: boolean; stopThrows?: boolean } = {},
		readonly displayName = id,
	) { }

	async isAvailable(): Promise<boolean> { return this.behavior.available ?? true; }
	async start(): Promise<void> {
		if (this.behavior.startThrows) {
			throw new Error('start failed');
		}
		this.started = true;
	}
	async stop(): Promise<void> {
		this.stopped = true;
		if (this.behavior.stopThrows) {
			throw new Error('stop failed');
		}
	}
	onUsageEvent(callback: AiUsageEventListener): Disposable {
		this.listeners.add(callback);
		return { dispose: () => { this.listeners.delete(callback); } };
	}
	emit(event: AiUsageEvent, origin?: UsageEventOrigin): void {
		this.listeners.forEach(listener => listener(event, origin));
	}
}

function event(provider: AiProviderId, status: AiUsageEvent['status'] = 'started'): AiUsageEvent {
	return { id: `${provider}-1`, provider, startedAt: '2026-10-01T10:00:00.000Z', source: 'actual', status };
}

suite('UsageService', () => {
	test('starts adapters independently and isolates failures', async () => {
		const logs: string[] = [];
		const service = new UsageService(message => logs.push(message));
		const copilot = new FakeAdapter('github-copilot');
		const claude = new FakeAdapter('claude-code', { startThrows: true });
		const codex = new FakeAdapter('codex-cli', { available: false });
		[copilot, claude, codex].forEach(adapter => service.register(adapter));
		const received: AiUsageEvent[] = [];
		service.onUsageEvent(e => received.push(e));

		await service.start();
		assert.deepStrictEqual(service.getStatuses().map(s => [s.id, s.state]),
			[['github-copilot', 'tracking'], ['claude-code', 'failed'], ['codex-cli', 'unavailable']]);
		assert.ok(copilot.started && !codex.started);
		assert.ok(logs.includes('claude-code: tracking failed (Error)'));

		copilot.emit(event('github-copilot'));
		assert.strictEqual(received.length, 1);
		service.dispose();
	});

	test('deduplicates repeated updates and drops invalid events', () => {
		const service = new UsageService();
		const adapter = new FakeAdapter('github-copilot');
		service.register(adapter);
		const received: AiUsageEvent[] = [];
		service.onUsageEvent(e => received.push(e));

		adapter.emit(event('github-copilot'));
		adapter.emit(event('github-copilot'));
		adapter.emit(event('github-copilot', 'completed'));
		adapter.emit({ ...event('github-copilot', 'failed'), prompt: 'leak' } as AiUsageEvent);
		assert.deepStrictEqual(received.map(e => e.status), ['started', 'completed']);
	});

	test('forwards the event origin; only live events count as recent provider activity', async () => {
		const service = new UsageService(() => { }, { now: () => 42 });
		const adapter = new FakeAdapter('claude-code');
		service.register(adapter);
		const received: [AiUsageEvent['status'], UsageEventOrigin | undefined][] = [];
		service.onUsageEvent((e, origin) => received.push([e.status, origin]));
		await service.start();

		adapter.emit(event('claude-code', 'completed'), 'import');
		assert.strictEqual(service.getStatuses()[0].lastEventAt, null);
		adapter.emit(event('claude-code', 'failed'));
		assert.deepStrictEqual(received, [['completed', 'import'], ['failed', 'live']]);
		assert.strictEqual(service.getStatuses()[0].lastEventAt, 42);
	});

	test('a failing listener does not block other listeners', () => {
		const logs: string[] = [];
		const service = new UsageService(message => logs.push(message));
		const adapter = new FakeAdapter('github-copilot');
		service.register(adapter);
		let delivered = 0;
		service.onUsageEvent(() => { throw new Error('boom'); });
		service.onUsageEvent(() => { delivered++; });
		adapter.emit(event('github-copilot'));
		assert.strictEqual(delivered, 1);
		assert.ok(logs.some(l => l.startsWith('usage listener failed')));
	});

	test('stops every adapter even when one fails to stop', async () => {
		const service = new UsageService(() => { });
		const a = new FakeAdapter('github-copilot', { stopThrows: true });
		const b = new FakeAdapter('codex-cli');
		service.register(a);
		service.register(b);
		await service.start();
		await service.stop();
		assert.ok(a.stopped && b.stopped);
		assert.ok(service.getStatuses().every(s => s.state === 'stopped'));
	});

	test('records the last event time per provider', () => {
		let now = 1000;
		const service = new UsageService(() => { }, { now: () => now });
		const copilot = new FakeAdapter('github-copilot');
		const codex = new FakeAdapter('codex-cli');
		service.register(copilot);
		service.register(codex);
		copilot.emit(event('github-copilot'));
		now = 2000;
		copilot.emit(event('github-copilot'));
		assert.deepStrictEqual(service.getStatuses().map(s => [s.id, s.lastEventAt]), [['github-copilot', 1000], ['codex-cli', null]]);
		service.dispose();
	});

	test('refresh re-reads tracking adapters and re-detects unavailable or failed ones', async () => {
		const logs: string[] = [];
		const service = new UsageService(message => logs.push(message));
		const tracking = new FakeAdapter('github-copilot');
		let refreshed = 0;
		Object.assign(tracking, { refresh: async () => { refreshed++; } });
		const brokenRefresh = new FakeAdapter('github-copilot-cli');
		Object.assign(brokenRefresh, { refresh: async () => { throw new Error('io'); } });
		const missing = new FakeAdapter('codex-cli', { available: false });
		const failing = new FakeAdapter('claude-code', { startThrows: true });
		[tracking, brokenRefresh, missing, failing].forEach(adapter => service.register(adapter));
		await service.start();

		missing.behavior.available = true;
		failing.behavior.startThrows = false;
		await service.refresh();
		assert.strictEqual(refreshed, 1);
		assert.ok(failing.stopped);
		assert.deepStrictEqual(service.getStatuses().map(s => s.state), ['tracking', 'tracking', 'tracking', 'tracking']);
		assert.ok(logs.some(l => l.includes('refresh failed (Error)')));
		service.dispose();
	});

	test('re-detects unavailable providers periodically while started, without repeating logs', async () => {
		const logs: string[] = [];
		const service = new UsageService(message => logs.push(message), { redetectIntervalMs: 5 });
		const later = new FakeAdapter('codex-cli', { available: false });
		service.register(later);
		await service.start();
		await new Promise(resolve => setTimeout(resolve, 30));
		assert.deepStrictEqual(logs, ['codex-cli: tracking unavailable']);

		// The tool is used for the first time after activation.
		later.behavior.available = true;
		const deadline = Date.now() + 2000;
		while (!later.started && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.deepStrictEqual(service.getStatuses().map(s => s.state), ['tracking']);
		assert.deepStrictEqual(logs, ['codex-cli: tracking unavailable', 'codex-cli: tracking started']);

		service.dispose();
	});

	test('refresh leaves stopped adapters alone', async () => {
		const service = new UsageService(() => { });
		const adapter = new FakeAdapter('github-copilot');
		service.register(adapter);
		await service.refresh();
		assert.ok(!adapter.started);
		assert.strictEqual(service.getStatuses()[0].state, 'stopped');
	});
});

suite('Copilot Chat vertical slice', () => {
	test('session file updates drive world states and intensity with safe diagnostics', async () => {
		const harness = createHarness();
		const logs: string[] = [];
		const service = new UsageService(message => logs.push(message));
		service.register(harness.adapter);
		const sent: StateMessage[] = [];
		const clock = new FakeClock();
		const world = new WorldStateEngine(snapshot => postWorldState(snapshot, m => {
			if (m.type === 'state') {
				sent.push(m);
			}
		}), { clock });
		service.onUsageEvent(e => world.handle(e));
		try {
			await service.start();
			assert.deepStrictEqual(service.getStatuses().map(s => s.state), ['tracking']);
			for (const line of readFixture('available.jsonl').split(/\r?\n/).filter(Boolean)) {
				fs.appendFileSync(harness.file(), line + '\n');
				await harness.adapter.refresh();
				clock.advance(1000);
			}
			clock.advance(DEFAULT_WORLD_TIMINGS.responseArrivingMs);
			// request_1 (gpt-4.1 -> medium) runs its lifecycle; request_2 (unknown model) arrives already completed.
			assert.deepStrictEqual(sent.map(m => `${m.worldState}/${m.activeCount}`), [
				'RequestStarting/1', 'ProcessingMedium/1', 'ResponseArriving/0', 'Idle/0', 'ResponseArriving/0', 'Idle/0',
			]);
			assertNoContent([...logs, ...harness.logs, sent]);
		} finally {
			world.dispose();
			service.dispose();
			await harness.cleanup();
		}
	});
});
