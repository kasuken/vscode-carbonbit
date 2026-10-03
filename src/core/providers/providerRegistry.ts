import { isAiUsageEvent, type AiProviderId } from '../usage/usageEvent';
import type { AiProviderAdapter, AiUsageEventListener, Disposable } from './provider';

/** Holds registered adapters and fans their usage events out to subscribers. */
export class ProviderRegistry implements Disposable {
	private readonly adapters = new Map<AiProviderId, { adapter: AiProviderAdapter; subscription: Disposable }>();
	private readonly listeners = new Set<AiUsageEventListener>();

	register(adapter: AiProviderAdapter): Disposable {
		if (this.adapters.has(adapter.id)) {
			throw new Error(`Provider already registered: ${adapter.id}`);
		}
		const subscription = adapter.onUsageEvent((event, origin) => {
			// Registry is the trust boundary: drop malformed events and events claiming another provider.
			if (!isAiUsageEvent(event) || event.provider !== adapter.id) {
				return;
			}
			const normalized = origin === 'import' ? 'import' : 'live';
			for (const listener of [...this.listeners]) {
				listener(event, normalized);
			}
		});
		const entry = { adapter, subscription };
		this.adapters.set(adapter.id, entry);
		return {
			dispose: () => {
				if (this.adapters.get(adapter.id) === entry) {
					this.adapters.delete(adapter.id);
					subscription.dispose();
				}
			},
		};
	}

	get(id: AiProviderId): AiProviderAdapter | undefined {
		return this.adapters.get(id)?.adapter;
	}

	list(): AiProviderAdapter[] {
		return [...this.adapters.values()].map(entry => entry.adapter);
	}

	onUsageEvent(listener: AiUsageEventListener): Disposable {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	dispose(): void {
		for (const { subscription } of this.adapters.values()) {
			subscription.dispose();
		}
		this.adapters.clear();
		this.listeners.clear();
	}
}
