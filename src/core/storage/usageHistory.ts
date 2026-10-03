import { ImpactEngine } from '../impact/impactEngine';
import type { PeriodCoverage, PeriodId, TodayMetrics } from '../messages/protocol';
import type { Disposable } from '../providers/provider';
import { retentionCutoff } from '../settings/retentionSettings';
import type { AiUsageEvent } from '../usage/usageEvent';
import type { ModelSummary, ProviderShare, UsageRecord, UsageStore, UsageTotals } from './usageStore';

/** `session`: requests started since this extension host activated. `today`: since local midnight. */
export type UsagePeriod = 'session' | 'today';

const DAY_MS = 24 * 60 * 60 * 1000;
const ROLLING_DAYS = 30;

/** Totals of one reporting period (PRD §16); `projectedYear` is extrapolated, the others are recorded. */
export interface PeriodSummary {
	id: PeriodId;
	totals: UsageTotals;
	/** Start of the period (epoch ms); for `projectedYear`, the first request the projection uses. */
	from: number;
	/** `projectedYear` only: days of recorded usage (1-30) the projection is based on; 0 without usage. */
	basisDays: number | null;
	/**
	 * How much of the period the recorded history covers, judged by the earliest stored request:
	 * a zero total only means "no usage" when the whole period is covered.
	 */
	coverage: PeriodCoverage;
	/** Earliest stored request (epoch ms), when it falls inside the period; otherwise `null`. */
	dataFrom: number | null;
}

// Today is always covered: tracking is live. Other periods depend on how far back history goes.
function coverageOf(firstEver: number | null, from: number, to: number): { coverage: PeriodCoverage; dataFrom: number | null } {
	if (firstEver === null || firstEver >= to) {
		return { coverage: 'none', dataFrom: null };
	}
	return firstEver > from ? { coverage: 'partial', dataFrom: firstEver } : { coverage: 'full', dataFrom: null };
}

export interface UsageHistoryOptions {
	impact?: ImpactEngine;
	now?: () => number;
	/** Defaults to `now()` at construction. */
	sessionStart?: number;
	/** Start of the local day containing `ms`; injectable for timezone-independent tests. */
	startOfDay?: (ms: number) => number;
	/** Start of the local month `offset` months from the one containing `ms`. */
	startOfMonth?: (ms: number, offset: number) => number;
	log?: (message: string) => void;
	/** See `carbonbit.dataRetentionDays`; 0 keeps everything. */
	retentionDays?: number;
}

export function localStartOfMonth(ms: number, offset: number): number {
	const day = new Date(ms);
	return new Date(day.getFullYear(), day.getMonth() + offset, 1).getTime();
}

function scaleTotals(totals: UsageTotals, factor: number): UsageTotals {
	return {
		requests: Math.round(totals.requests * factor),
		tokens: Math.round(totals.tokens * factor),
		energyWh: totals.energyWh * factor,
		carbonGrams: totals.carbonGrams * factor,
		waterLiters: totals.waterLiters * factor,
	};
}

export function localStartOfDay(ms: number): number {
	const day = new Date(ms);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

const TERMINAL = new Set(['completed', 'failed']);
const EMPTY_TOTALS: UsageTotals = { requests: 0, tokens: 0, energyWh: 0, carbonGrams: 0, waterLiters: 0 };

function toEvent(record: UsageRecord): AiUsageEvent {
	const event: AiUsageEvent = {
		id: record.id,
		provider: record.provider,
		startedAt: new Date(record.startedAt).toISOString(),
		source: record.source,
		status: record.status,
	};
	if (record.model !== null) { event.model = record.model; }
	if (record.completedAt !== null) { event.completedAt = new Date(record.completedAt).toISOString(); }
	if (record.inputTokens !== null) { event.inputTokens = record.inputTokens; }
	if (record.outputTokens !== null) { event.outputTokens = record.outputTokens; }
	if (record.cachedInputTokens !== null) { event.cachedInputTokens = record.cachedInputTokens; }
	if (record.cacheCreationTokens !== null) { event.cacheCreationTokens = record.cacheCreationTokens; }
	return event;
}

function definedFields(event: AiUsageEvent): Partial<AiUsageEvent> {
	return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
}

/**
 * Persists usage events (one row per request id, updated through its lifecycle) and answers
 * session/today aggregates. Storage errors are logged and never thrown to callers.
 */
export class UsageHistory implements Disposable {
	private readonly impact: ImpactEngine;
	private readonly now: () => number;
	private readonly startOfDay: (ms: number) => number;
	private readonly startOfMonth: (ms: number, offset: number) => number;
	private readonly log: (message: string) => void;
	private readonly loggedFailures = new Set<string>();
	private retentionDays: number;
	readonly sessionStart: number;

	constructor(private store: UsageStore | undefined, options: UsageHistoryOptions = {}) {
		this.impact = options.impact ?? new ImpactEngine();
		this.now = options.now ?? Date.now;
		this.startOfDay = options.startOfDay ?? localStartOfDay;
		this.startOfMonth = options.startOfMonth ?? localStartOfMonth;
		this.log = options.log ?? (() => { });
		this.sessionStart = options.sessionStart ?? this.now();
		this.retentionDays = options.retentionDays ?? 0;
	}

	get available(): boolean {
		return this.store !== undefined;
	}

	/** Storage operations that have failed at least once since activation (for diagnostics). */
	get failedOperations(): string[] {
		return [...this.loggedFailures];
	}

	record(event: AiUsageEvent): void {
		// Replayed provider history must not resurrect pruned requests.
		const cutoff = retentionCutoff(this.now(), this.retentionDays);
		if (cutoff !== undefined && Date.parse(event.startedAt) < cutoff) {
			return;
		}
		this.run('record', undefined, store => {
			const existing = store.get(event.id);
			// Late or replayed in-flight updates must not reopen a finished request.
			if (existing && TERMINAL.has(existing.status) && !TERMINAL.has(event.status)) {
				return;
			}
			const merged: AiUsageEvent = existing ? { ...toEvent(existing), ...definedFields(event) } : event;
			if (!TERMINAL.has(merged.status)) {
				delete merged.completedAt;
			}
			const estimate = this.impact.estimate(merged);
			store.upsert({
				id: merged.id,
				provider: merged.provider,
				model: merged.model ?? null,
				startedAt: Date.parse(merged.startedAt),
				completedAt: merged.completedAt ? Date.parse(merged.completedAt) : null,
				status: merged.status,
				source: merged.source,
				inputTokens: merged.inputTokens ?? null,
				outputTokens: merged.outputTokens ?? null,
				cachedInputTokens: merged.cachedInputTokens ?? null,
				cacheCreationTokens: merged.cacheCreationTokens ?? null,
				energyWh: estimate?.energyWh ?? null,
				carbonGrams: estimate?.carbonGrams ?? null,
				waterLiters: estimate?.waterLiters ?? null,
				confidence: estimate?.confidence ?? null,
				tokenProvenance: estimate?.tokenSource ?? null,
				factorLevel: estimate?.factorLevel ?? null,
				methodologyVersion: estimate?.methodologyVersion ?? null,
				updatedAt: this.now(),
			});
		});
	}

	totals(period: UsagePeriod): UsageTotals {
		const from = this.periodStart(period);
		return this.run('totals', { ...EMPTY_TOTALS }, store => store.totals(from, Number.MAX_SAFE_INTEGER));
	}

	models(period: UsagePeriod): ModelSummary[] {
		const from = this.periodStart(period);
		return this.run('models', [], store => store.byModel(from, Number.MAX_SAFE_INTEGER));
	}

	providers(period: UsagePeriod): ProviderShare[] {
		const from = this.periodStart(period);
		return this.run('providers', [], store => store.byProvider(from, Number.MAX_SAFE_INTEGER));
	}

	/** Today's totals for the sidebar; `null` when history is unavailable. */
	todayMetrics(): TodayMetrics | null {
		if (!this.store) {
			return null;
		}
		const { energyWh, carbonGrams, waterLiters, tokens, requests } = this.totals('today');
		return { energyWh, carbonGrams, waterLiters, tokens, requests };
	}

	/**
	 * Today, the last 30 days (rolling), the previous calendar month and a projected year.
	 * The projection scales the last 30 days by 365 / days of recorded usage in them (at least one day),
	 * so a fresh install isn't diluted by days before CarbonBit was tracking.
	 */
	periods(): PeriodSummary[] {
		const now = this.now();
		const end = Number.MAX_SAFE_INTEGER;
		const rollingFrom = now - ROLLING_DAYS * DAY_MS;
		const rolling = this.run('totals', { ...EMPTY_TOTALS }, store => store.totals(rollingFrom, end));
		const first = this.run('first', null, store => store.firstStartedAt(rollingFrom, end));
		const spanDays = first === null ? 0 : Math.min(ROLLING_DAYS, Math.max(1, (now - first) / DAY_MS));
		const previousFrom = this.startOfMonth(now, -1);
		const previousTo = this.startOfMonth(now, 0);
		const firstEver = this.run('first', null, store => store.firstStartedAt(0, end));
		return [
			{ id: 'today', totals: this.totals('today'), from: this.startOfDay(now), basisDays: null, coverage: 'full', dataFrom: null },
			{ id: 'last30Days', totals: rolling, from: rollingFrom, basisDays: null, ...coverageOf(firstEver, rollingFrom, end) },
			{
				id: 'previousMonth',
				totals: this.run('totals', { ...EMPTY_TOTALS }, store => store.totals(previousFrom, previousTo)),
				from: previousFrom,
				basisDays: null,
				...coverageOf(firstEver, previousFrom, previousTo),
			},
			{
				id: 'projectedYear',
				totals: spanDays > 0 ? scaleTotals(rolling, 365 / spanDays) : { ...EMPTY_TOTALS },
				from: first ?? now,
				basisDays: Math.ceil(spanDays),
				// The note already says how many days the projection rests on.
				coverage: spanDays > 0 ? 'full' : 'none',
				dataFrom: null,
			},
		];
	}

	/** Totals of the last `count` clock-aligned `bucketMs` slices, oldest first; the last one is in progress. */
	activity(bucketMs: number, count: number): UsageTotals[] {
		const from = (Math.floor(this.now() / bucketMs) - (count - 1)) * bucketMs;
		return this.run('activity', Array.from({ length: count }, () => ({ ...EMPTY_TOTALS })), store => store.buckets(from, from + count * bucketMs, bucketMs));
	}

	/** Updates the retention window and prunes immediately; returns how many requests were removed. */
	setRetentionDays(retentionDays: number): number {
		this.retentionDays = retentionDays;
		return this.pruneExpired();
	}

	/** Deletes requests started before the retention window; returns how many were removed. */
	pruneExpired(): number {
		const cutoff = retentionCutoff(this.now(), this.retentionDays);
		if (cutoff === undefined) {
			return 0;
		}
		return this.run('prune', 0, store => store.deleteStartedBefore(cutoff));
	}

	/** Removes all stored usage; returns whether it succeeded. */
	clear(): boolean {
		return this.run('clear', false, store => {
			store.clear();
			return true;
		});
	}

	dispose(): void {
		const store = this.store;
		this.store = undefined;
		try {
			store?.close();
		} catch {
			// Nothing left to do with a database that can't close.
		}
	}

	private periodStart(period: UsagePeriod): number {
		return period === 'session' ? this.sessionStart : this.startOfDay(this.now());
	}

	private run<T>(operation: string, fallback: T, action: (store: UsageStore) => T): T {
		const store = this.store;
		if (!store) {
			return fallback;
		}
		try {
			return action(store);
		} catch (error) {
			// One line per failing operation, so a broken disk can't flood the log.
			if (!this.loggedFailures.has(operation)) {
				this.loggedFailures.add(operation);
				const code = error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'unknown error';
				this.log(`storage: ${operation} failed (${code})`);
			}
			return fallback;
		}
	}
}
