import type { WorldState } from '../messages/protocol';
import type { Disposable } from '../providers/provider';
import type { AiProviderId, AiUsageEvent } from '../usage/usageEvent';
import { classifyIntensity, Intensity, maxIntensity } from './worldIntensity';

export interface WorldSnapshot {
	worldState: WorldState;
	/** Requests currently in flight (started/processing, not yet finished or stale). */
	activeCount: number;
}

export interface WorldClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const systemClock: WorldClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WorldTimings {
	/** Minimum display time of each transient state (PRD §23: ~500-1000 ms). */
	requestStartingMs: number;
	responseArrivingMs: number;
	failedMs: number;
	/** An in-flight request with no update for this long is dropped, so the world can't stay busy forever. */
	staleRequestMs: number;
	/**
	 * Per-call providers: a completion within this long of the previous one means an agent loop is
	 * running, and the world keeps processing until this long after the last one. 0 disables it.
	 */
	agentLoopGapMs: number;
}

export const DEFAULT_WORLD_TIMINGS: WorldTimings = {
	requestStartingMs: 800,
	responseArrivingMs: 1500,
	failedMs: 2000,
	staleRequestMs: 5 * 60_000,
	// In real Claude Code / Copilot CLI logs ~75-80% of gaps between consecutive calls are below 15 s.
	agentLoopGapMs: 15_000,
};

/**
 * Providers that log one event per model call, mostly written once the call has finished (no
 * in-flight phase). Their agent loops are a series of completions with tool runs in between.
 * Per-turn providers (Copilot Chat, Codex CLI) report in-flight turns themselves.
 */
export const PER_CALL_PROVIDERS: ReadonlySet<AiProviderId> = new Set<AiProviderId>(['claude-code', 'github-copilot-cli']);

export interface WorldStateEngineOptions {
	clock?: WorldClock;
	classify?: (event: AiUsageEvent) => Intensity;
	timings?: Partial<WorldTimings>;
	/** Defaults to `PER_CALL_PROVIDERS`. */
	perCallProviders?: ReadonlySet<AiProviderId>;
}

type Pulse = 'Failed' | 'ResponseArriving' | 'RequestStarting';
// Highest priority first: an outcome is never hidden by a newer request starting.
const PULSE_PRIORITY: readonly Pulse[] = ['Failed', 'ResponseArriving', 'RequestStarting'];

const PROCESSING_STATE: Record<Intensity, WorldState> = {
	light: 'ProcessingLight',
	medium: 'ProcessingMedium',
	heavy: 'ProcessingHeavy',
};

// Bounds memory of finished ids kept to ignore late/repeated events.
const FINISHED_MEMORY = 500;

interface AgentLoop {
	lastCompletedAt: number;
	/** Shown until this epoch ms; 0 while only a single completion was seen. */
	until: number;
	intensity: Intensity;
}

/**
 * Explicit world-state machine (PRD §21-26) driven by normalized usage events.
 * State = highest-priority unexpired pulse, else the heaviest in-flight request or running agent
 * loop, else Idle. `activeCount` only counts requests that are reported in flight.
 */
export class WorldStateEngine implements Disposable {
	private readonly clock: WorldClock;
	private readonly classify: (event: AiUsageEvent) => Intensity;
	private readonly timings: WorldTimings;
	private readonly perCallProviders: ReadonlySet<AiProviderId>;
	private readonly active = new Map<string, { intensity: Intensity; lastSeen: number }>();
	private readonly finished = new Set<string>();
	private readonly pulseUntil = new Map<Pulse, number>();
	private readonly loops = new Map<AiProviderId, AgentLoop>();
	private timer: { handle: unknown } | undefined;
	private snapshot: WorldSnapshot = { worldState: 'Idle', activeCount: 0 };

	constructor(private readonly onChange: (snapshot: WorldSnapshot) => void, options: WorldStateEngineOptions = {}) {
		this.clock = options.clock ?? systemClock;
		this.classify = options.classify ?? (event => classifyIntensity(event));
		this.timings = { ...DEFAULT_WORLD_TIMINGS, ...options.timings };
		this.perCallProviders = options.perCallProviders ?? PER_CALL_PROVIDERS;
	}

	get current(): WorldSnapshot {
		return { ...this.snapshot };
	}

	handle(event: AiUsageEvent): void {
		if (this.finished.has(event.id)) {
			return;
		}
		const now = this.clock.now();
		if (event.status === 'completed' || event.status === 'failed') {
			const request = this.active.get(event.id);
			this.active.delete(event.id);
			this.rememberFinished(event.id);
			this.pulse(event.status === 'failed' ? 'Failed' : 'ResponseArriving', now);
			if (event.status === 'completed') {
				this.trackLoop(event, request?.intensity, now);
			}
		} else {
			const intensity = this.classify(event);
			const request = this.active.get(event.id);
			if (request) {
				// Never downgrade mid-request, so later partial updates can't make the world flicker.
				request.intensity = maxIntensity(request.intensity, intensity);
				request.lastSeen = now;
			} else {
				this.active.set(event.id, { intensity, lastSeen: now });
				this.pulse('RequestStarting', now);
			}
		}
		this.update();
	}

	dispose(): void {
		this.clearTimer();
	}

	private pulse(kind: Pulse, now: number): void {
		const duration = kind === 'Failed' ? this.timings.failedMs
			: kind === 'ResponseArriving' ? this.timings.responseArrivingMs
				: this.timings.requestStartingMs;
		this.pulseUntil.set(kind, Math.max(this.pulseUntil.get(kind) ?? 0, now + duration));
	}

	/**
	 * Per-call providers only log finished calls, so a lone completion is just a pulse. A second one
	 * within the gap shows an agent loop at work: keep processing between calls (tool runs, the next call).
	 */
	private trackLoop(event: AiUsageEvent, inFlight: Intensity | undefined, now: number): void {
		const gap = this.timings.agentLoopGapMs;
		if (gap <= 0 || !this.perCallProviders.has(event.provider)) {
			return;
		}
		const intensity = inFlight ? maxIntensity(inFlight, this.classify(event)) : this.classify(event);
		const loop = this.loops.get(event.provider);
		if (loop && now - loop.lastCompletedAt < gap) {
			// Never downgrade within a loop, so mixed call sizes don't make the world flicker.
			loop.intensity = maxIntensity(loop.intensity, intensity);
			loop.lastCompletedAt = now;
			loop.until = now + gap;
		} else {
			this.loops.set(event.provider, { lastCompletedAt: now, until: 0, intensity });
		}
	}

	private rememberFinished(id: string): void {
		this.finished.add(id);
		if (this.finished.size > FINISHED_MEMORY) {
			this.finished.delete(this.finished.values().next().value as string);
		}
	}

	private update(): void {
		const now = this.clock.now();
		for (const [id, request] of this.active) {
			if (now - request.lastSeen >= this.timings.staleRequestMs) {
				this.active.delete(id);
			}
		}
		for (const [provider, loop] of this.loops) {
			if (now - loop.lastCompletedAt >= this.timings.agentLoopGapMs && loop.until <= now) {
				this.loops.delete(provider);
			}
		}

		const next: WorldSnapshot = { worldState: this.computeState(now), activeCount: this.active.size };
		if (next.worldState !== this.snapshot.worldState || next.activeCount !== this.snapshot.activeCount) {
			this.snapshot = next;
			this.onChange({ ...next });
		}
		this.schedule(now);
	}

	private computeState(now: number): WorldState {
		const pulse = PULSE_PRIORITY.find(kind => (this.pulseUntil.get(kind) ?? 0) > now);
		if (pulse) {
			return pulse;
		}
		let intensity: Intensity | undefined;
		for (const request of this.active.values()) {
			intensity = intensity ? maxIntensity(intensity, request.intensity) : request.intensity;
		}
		for (const loop of this.loops.values()) {
			if (loop.until > now) {
				intensity = intensity ? maxIntensity(intensity, loop.intensity) : loop.intensity;
			}
		}
		return intensity ? PROCESSING_STATE[intensity] : 'Idle';
	}

	private schedule(now: number): void {
		this.clearTimer();
		let deadline = Infinity;
		for (const until of this.pulseUntil.values()) {
			if (until > now) {
				deadline = Math.min(deadline, until);
			}
		}
		for (const request of this.active.values()) {
			deadline = Math.min(deadline, request.lastSeen + this.timings.staleRequestMs);
		}
		// Only visible loops need a timer; a lone completion is forgotten lazily.
		for (const loop of this.loops.values()) {
			if (loop.until > now) {
				deadline = Math.min(deadline, loop.until);
			}
		}
		if (deadline !== Infinity) {
			this.timer = {
				handle: this.clock.setTimeout(() => {
					this.timer = undefined;
					this.update();
				}, deadline - now),
			};
		}
	}

	private clearTimer(): void {
		if (this.timer) {
			this.clock.clearTimeout(this.timer.handle);
			this.timer = undefined;
		}
	}
}
