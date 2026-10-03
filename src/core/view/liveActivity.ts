import type { AiProviderId, AiUsageEvent, AiUsageStatus } from '../usage/usageEvent';
import { DEFAULT_WORLD_TIMINGS, PER_CALL_PROVIDERS } from '../world/worldStateEngine';

export interface LiveRequest {
	provider: AiProviderId;
	model: string | null;
	status: AiUsageStatus;
	/** All tokens reported so far (input, output and cache); `null` until the provider reports any. */
	tokens: number | null;
	/** Epoch ms of the last update received for this request. */
	updatedAt: number;
}

export interface LiveActivityOptions {
	now?: () => number;
	/** In-flight requests without updates for this long are ignored (matches the world engine). */
	staleMs?: number;
	/** Consecutive completions this close together read as one working agent loop (matches the world engine). */
	agentLoopGapMs?: number;
	perCallProviders?: ReadonlySet<AiProviderId>;
}

const DEFAULT_STALE_MS = 5 * 60_000;
const MAX_ACTIVE = 100;

function tokensOf(event: AiUsageEvent): number | null {
	const counts = [event.inputTokens, event.outputTokens, event.cachedInputTokens, event.cacheCreationTokens]
		.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
	return counts.length ? counts.reduce((sum, n) => sum + n, 0) : null;
}

/** Remembers the most recent request (provider, model, status) for the live status line (PRD §27). */
export class LiveActivity {
	private readonly now: () => number;
	private readonly staleMs: number;
	private readonly active = new Map<string, LiveRequest>();
	private readonly agentLoopGapMs: number;
	private readonly perCallProviders: ReadonlySet<AiProviderId>;
	private readonly lastCompletedAt = new Map<AiProviderId, number>();
	private lastFinished: LiveRequest | null = null;
	private lastFinishedInLoop = false;

	constructor(options: LiveActivityOptions = {}) {
		this.now = options.now ?? Date.now;
		this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
		this.agentLoopGapMs = options.agentLoopGapMs ?? DEFAULT_WORLD_TIMINGS.agentLoopGapMs;
		this.perCallProviders = options.perCallProviders ?? PER_CALL_PROVIDERS;
	}

	handle(event: AiUsageEvent): void {
		const previous = this.active.get(event.id);
		const request: LiveRequest = {
			provider: event.provider,
			model: event.model ?? previous?.model ?? null,
			status: event.status,
			tokens: tokensOf(event) ?? previous?.tokens ?? null,
			updatedAt: this.now(),
		};
		this.active.delete(event.id);
		if (event.status === 'completed' || event.status === 'failed') {
			// Tools that log each call only once it is done never report "processing"; a quick
			// succession of completions is an agent loop at work, as the world shows it.
			const previous = this.lastCompletedAt.get(event.provider);
			this.lastFinishedInLoop = event.status === 'completed'
				&& this.perCallProviders.has(event.provider)
				&& previous !== undefined
				&& request.updatedAt - previous < this.agentLoopGapMs;
			if (event.status === 'completed') {
				this.lastCompletedAt.set(event.provider, request.updatedAt);
			}
			this.lastFinished = request;
			return;
		}
		this.active.set(event.id, request);
		if (this.active.size > MAX_ACTIVE) {
			this.active.delete(this.active.keys().next().value as string);
		}
	}

	/** Most recently updated in-flight request, else the last finished one, else `null`. */
	current(): LiveRequest | null {
		const now = this.now();
		let latest: LiveRequest | undefined;
		for (const [id, request] of this.active) {
			if (now - request.updatedAt >= this.staleMs) {
				this.active.delete(id);
			} else if (!latest || request.updatedAt >= latest.updatedAt) {
				latest = request;
			}
		}
		if (latest) {
			return { ...latest };
		}
		if (!this.lastFinished) {
			return null;
		}
		const working = this.lastFinishedInLoop && now - this.lastFinished.updatedAt < this.agentLoopGapMs;
		return { ...this.lastFinished, ...(working ? { status: 'processing' as const } : {}) };
	}

	clear(): void {
		this.active.clear();
		this.lastCompletedAt.clear();
		this.lastFinished = null;
		this.lastFinishedInLoop = false;
	}
}
