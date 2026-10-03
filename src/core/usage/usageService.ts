import type { AiProviderAdapter, AiUsageEventListener, Disposable, UsageEventOrigin } from '../providers/provider';
import { ProviderRegistry } from '../providers/providerRegistry';
import type { AiProviderId, AiUsageEvent } from './usageEvent';

export type ProviderTrackingState = 'stopped' | 'tracking' | 'unavailable' | 'failed';

export interface ProviderStatus {
	id: AiProviderId;
	displayName: string;
	state: ProviderTrackingState;
	/** Epoch ms when CarbonBit last received a live event from this provider; `null` if none yet. */
	lastEventAt: number | null;
}

export interface UsageServiceOptions {
	now?: () => number;
	/**
	 * While started, unavailable providers are re-detected this often, so a tool used for the
	 * first time after activation is tracked without a manual refresh. 0 disables it.
	 */
	redetectIntervalMs?: number;
}

export const DEFAULT_REDETECT_INTERVAL_MS = 30_000;

const MAX_TRACKED_EVENT_IDS = 1000;

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
	}
	return 'unknown error';
}

/**
 * Shared usage pipeline: owns the provider registry, starts/stops adapters independently
 * (one failing adapter never blocks the others) and publishes deduplicated events.
 */
export class UsageService implements Disposable {
	private readonly registry = new ProviderRegistry();
	private readonly states = new Map<AiProviderId, ProviderTrackingState>();
	private readonly listeners = new Set<AiUsageEventListener>();
	private readonly lastSignatures = new Map<string, string>();
	private readonly lastEventAt = new Map<AiProviderId, number>();
	private readonly registrySubscription: Disposable;
	private readonly now: () => number;
	private readonly redetectIntervalMs: number;
	private redetectTimer: ReturnType<typeof setInterval> | undefined;
	private redetecting = false;
	private running = false;

	/** `log` must only receive metadata, never conversation content. */
	constructor(private readonly log: (message: string) => void = () => { }, options: UsageServiceOptions = {}) {
		this.now = options.now ?? Date.now;
		this.redetectIntervalMs = options.redetectIntervalMs ?? DEFAULT_REDETECT_INTERVAL_MS;
		this.registrySubscription = this.registry.onUsageEvent((event, origin) => this.publish(event, origin ?? 'live'));
	}

	register(adapter: AiProviderAdapter): void {
		this.registry.register(adapter);
		this.states.set(adapter.id, 'stopped');
	}

	async start(): Promise<void> {
		this.running = true;
		await Promise.all(this.registry.list().map(adapter => this.startAdapter(adapter)));
		if (this.running && this.redetectIntervalMs > 0 && !this.redetectTimer) {
			this.redetectTimer = setInterval(() => { void this.redetect(); }, this.redetectIntervalMs);
			// Re-detection alone must not keep the host process alive.
			this.redetectTimer.unref?.();
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		clearInterval(this.redetectTimer);
		this.redetectTimer = undefined;
		await Promise.all(this.registry.list().map(async adapter => {
			try {
				await adapter.stop();
			} catch (error) {
				this.log(`${adapter.displayName}: stop failed (${describeError(error)})`);
			}
			this.states.set(adapter.id, 'stopped');
		}));
	}

	/**
	 * Reads new data from tracking adapters and re-checks detection of unavailable or failed ones.
	 * Adapters that were never started (or were stopped) are left alone.
	 */
	async refresh(): Promise<void> {
		await Promise.all(this.registry.list().map(async adapter => {
			const state = this.states.get(adapter.id);
			if (state === 'tracking') {
				try {
					await adapter.refresh?.();
				} catch (error) {
					this.log(`${adapter.displayName}: refresh failed (${describeError(error)})`);
				}
			} else if (state === 'unavailable' || state === 'failed') {
				if (state === 'failed') {
					await adapter.stop().catch(() => undefined);
				}
				await this.startAdapter(adapter);
			}
		}));
	}

	getStatuses(): ProviderStatus[] {
		return this.registry.list().map(({ id, displayName }) => ({
			id,
			displayName,
			state: this.states.get(id) ?? 'stopped',
			lastEventAt: this.lastEventAt.get(id) ?? null,
		}));
	}

	onUsageEvent(listener: AiUsageEventListener): Disposable {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	dispose(): void {
		void this.stop();
		this.registrySubscription.dispose();
		this.registry.dispose();
		this.listeners.clear();
		this.lastSignatures.clear();
	}

	/** Starts providers whose logs appeared since; quiet while they stay unavailable. */
	private async redetect(): Promise<void> {
		if (this.redetecting) {
			return;
		}
		this.redetecting = true;
		try {
			await Promise.all(this.registry.list().map(async adapter => {
				if (this.states.get(adapter.id) === 'unavailable' && await adapter.isAvailable().catch(() => false) && this.running) {
					await this.startAdapter(adapter);
				}
			}));
		} finally {
			this.redetecting = false;
		}
	}

	private async startAdapter(adapter: AiProviderAdapter): Promise<void> {
		try {
			if (!(await adapter.isAvailable())) {
				this.states.set(adapter.id, 'unavailable');
				this.log(`${adapter.displayName}: tracking unavailable`);
				return;
			}
			await adapter.start();
			this.states.set(adapter.id, 'tracking');
			this.log(`${adapter.displayName}: tracking started`);
		} catch (error) {
			this.states.set(adapter.id, 'failed');
			this.log(`${adapter.displayName}: tracking failed (${describeError(error)})`);
		}
	}

	private publish(event: AiUsageEvent, origin: UsageEventOrigin): void {
		const signature = JSON.stringify(event);
		if (this.lastSignatures.get(event.id) === signature) {
			return;
		}
		this.lastSignatures.delete(event.id);
		this.lastSignatures.set(event.id, signature);
		// Imported history is not a sign of current activity.
		if (origin === 'live') {
			this.lastEventAt.set(event.provider, this.now());
		}
		if (this.lastSignatures.size > MAX_TRACKED_EVENT_IDS) {
			this.lastSignatures.delete(this.lastSignatures.keys().next().value as string);
		}
		for (const listener of [...this.listeners]) {
			try {
				listener(event, origin);
			} catch (error) {
				this.log(`usage listener failed (${describeError(error)})`);
			}
		}
	}
}
