import * as assert from 'assert';
import type { AiProviderAdapter, AiUsageEventListener, Disposable } from '../core/providers/provider';
import { ProviderRegistry } from '../core/providers/providerRegistry';
import type { AiProviderId, AiUsageEvent } from '../core/usage/usageEvent';

class FakeAdapter implements AiProviderAdapter {
	readonly displayName = 'Fake';
	readonly listeners = new Set<AiUsageEventListener>();

	constructor(readonly id: AiProviderId) { }

	async isAvailable(): Promise<boolean> { return true; }
	async start(): Promise<void> { }
	async stop(): Promise<void> { }

	onUsageEvent(callback: AiUsageEventListener): Disposable {
		this.listeners.add(callback);
		return { dispose: () => { this.listeners.delete(callback); } };
	}

	emit(event: AiUsageEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function event(provider: AiProviderId): AiUsageEvent {
	return { id: `${provider}-1`, provider, startedAt: '2026-10-01T10:00:00.000Z', source: 'actual', status: 'started' };
}

suite('ProviderRegistry', () => {
	test('registers, lists and looks up providers', () => {
		const registry = new ProviderRegistry();
		const copilot = new FakeAdapter('github-copilot');
		const codex = new FakeAdapter('codex-cli');
		registry.register(copilot);
		registry.register(codex);
		assert.strictEqual(registry.get('github-copilot'), copilot);
		assert.strictEqual(registry.get('claude-code'), undefined);
		assert.deepStrictEqual(registry.list(), [copilot, codex]);
	});

	test('rejects duplicate provider ids', () => {
		const registry = new ProviderRegistry();
		registry.register(new FakeAdapter('claude-code'));
		assert.throws(() => registry.register(new FakeAdapter('claude-code')));
	});

	test('forwards adapter events to subscribers until the subscription is disposed', () => {
		const registry = new ProviderRegistry();
		const adapter = new FakeAdapter('github-copilot-cli');
		registry.register(adapter);
		const received: AiUsageEvent[] = [];
		const subscription = registry.onUsageEvent(e => received.push(e));

		adapter.emit(event('github-copilot-cli'));
		subscription.dispose();
		adapter.emit(event('github-copilot-cli'));

		assert.strictEqual(received.length, 1);
		assert.strictEqual(received[0].provider, 'github-copilot-cli');
	});

	test('disposing a registration unsubscribes from the adapter and frees the id', () => {
		const registry = new ProviderRegistry();
		const adapter = new FakeAdapter('codex-cli');
		const registration = registry.register(adapter);
		assert.strictEqual(adapter.listeners.size, 1);

		registration.dispose();
		registration.dispose();

		assert.strictEqual(adapter.listeners.size, 0);
		assert.strictEqual(registry.get('codex-cli'), undefined);
		assert.doesNotThrow(() => registry.register(new FakeAdapter('codex-cli')));
	});

	test('drops malformed events and events claiming another provider', () => {
		const registry = new ProviderRegistry();
		const adapter = new FakeAdapter('claude-code');
		registry.register(adapter);
		const received: AiUsageEvent[] = [];
		registry.onUsageEvent(e => received.push(e));

		const invalid: unknown[] = [
			{ ...event('claude-code'), prompt: 'secret' },
			{ ...event('claude-code'), status: 'done' },
			{ ...event('claude-code'), inputTokens: -1 },
			{ id: 'x' },
			null,
		];
		for (const bad of invalid) {
			adapter.emit(bad as AiUsageEvent);
		}
		adapter.emit(event('codex-cli'));
		adapter.emit(event('claude-code'));

		assert.deepStrictEqual(received, [event('claude-code')]);
	});

	test('dispose releases all adapters and listeners', () => {
		const registry = new ProviderRegistry();
		const adapter = new FakeAdapter('github-copilot');
		registry.register(adapter);
		let count = 0;
		registry.onUsageEvent(() => count++);

		registry.dispose();
		adapter.emit(event('github-copilot'));

		assert.strictEqual(adapter.listeners.size, 0);
		assert.strictEqual(registry.list().length, 0);
		assert.strictEqual(count, 0);
	});
});
