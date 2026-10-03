import type { WorldClock } from '../core/world/worldStateEngine';

/** Deterministic clock: timers fire only from `advance`, in due order. */
export class FakeClock implements WorldClock {
	private time = 0;
	private nextId = 1;
	private readonly timers = new Map<number, { due: number; callback: () => void }>();

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.nextId++;
		this.timers.set(id, { due: this.time + Math.max(0, ms), callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.timers.delete(handle as number);
	}

	get pendingTimers(): number {
		return this.timers.size;
	}

	advance(ms: number): void {
		const target = this.time + ms;
		for (;;) {
			let next: [number, { due: number; callback: () => void }] | undefined;
			for (const entry of this.timers) {
				if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) {
					next = entry;
				}
			}
			if (!next) {
				break;
			}
			this.timers.delete(next[0]);
			this.time = next[1].due;
			next[1].callback();
		}
		this.time = target;
	}
}
