import { equivalentsOf } from '../impact/equivalents';
import { formatCarbon, formatEnergy, formatTokens, formatWater } from '../impact/units';
import {
	type ActivityView,
	MAX_MODEL_LENGTH,
	MAX_NAME_LENGTH,
	type PeriodId,
	type PeriodView,
	type ProviderShareView,
	type SidebarView,
	type TodayMetrics,
	type TodayText,
	type TodayView,
} from '../messages/protocol';
import type { PeriodSummary } from '../storage/usageHistory';
import type { UsageTotals } from '../storage/usageStore';
import { ACTIVITY_BUCKET_MINUTES, type SidebarModel } from './sidebarModel';

/**
 * Integer percentages of `values` that always sum to 100 when any value is positive
 * (largest-remainder method; ties go to the earlier entry). Non-positive values get 0.
 */
export function largestRemainderPercents(values: readonly number[]): number[] {
	const safe = values.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
	const total = safe.reduce((sum, v) => sum + v, 0);
	if (total <= 0) {
		return safe.map(() => 0);
	}
	const exact = safe.map(v => (v / total) * 100);
	const result = exact.map(Math.floor);
	let missing = 100 - result.reduce((sum, v) => sum + v, 0);
	const order = exact
		.map((v, i) => ({ i, remainder: v - Math.floor(v) }))
		.filter(({ i }) => safe[i] > 0)
		.sort((a, b) => b.remainder - a.remainder || a.i - b.i);
	for (const { i } of order) {
		if (missing <= 0) {
			break;
		}
		result[i]++;
		missing--;
	}
	return result;
}

// Strips control characters and bounds the length so values always pass protocol validation.
export function displayText(value: string | null | undefined, maxLength: number): string | null {
	const clean = (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
	if (!clean) {
		return null;
	}
	return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** The one formatter for totals, so sidebar and details always show the same text. */
export function metricsText(totals: UsageTotals): TodayText {
	return {
		energy: formatEnergy(totals.energyWh).text,
		carbon: formatCarbon(totals.carbonGrams).text,
		water: formatWater(totals.waterLiters).text,
		tokens: formatTokens(totals.tokens),
		requests: String(totals.requests),
	};
}

// Exactly the protocol keys, integer counters, so any totals-like object passes validation.
export function todayView(today: TodayMetrics): TodayView {
	const metrics: TodayMetrics = {
		energyWh: Math.max(0, today.energyWh),
		carbonGrams: Math.max(0, today.carbonGrams),
		waterLiters: Math.max(0, today.waterLiters),
		tokens: Math.max(0, Math.round(today.tokens)),
		requests: Math.max(0, Math.round(today.requests)),
	};
	return { ...metrics, text: metricsText(metrics) };
}

const PERIOD_LABELS: Record<PeriodId, string> = {
	today: 'Today',
	last30Days: 'Last 30 days',
	previousMonth: 'Previous month',
	projectedYear: 'Projected year',
};

function periodNote(summary: PeriodSummary): string | null {
	switch (summary.id) {
		case 'previousMonth':
			return new Date(summary.from).toLocaleString('en', { month: 'long', year: 'numeric' });
		case 'projectedYear':
			return summary.basisDays ? `From ${summary.basisDays} day${summary.basisDays === 1 ? '' : 's'} of usage` : 'No usage to project yet';
		default:
			return null;
	}
}

/** A period's totals with its everyday comparisons (PRD §16). */
export function periodView(summary: PeriodSummary): PeriodView {
	const { carbon, water } = equivalentsOf(summary.totals);
	const toView = <Id extends string>(e: { id: Id; amountText: string; unit: string }) => ({ id: e.id, amount: e.amountText, unit: e.unit });
	return {
		id: summary.id,
		label: PERIOD_LABELS[summary.id],
		note: periodNote(summary),
		totals: todayView(summary.totals),
		carbon: carbon.map(toView),
		water: water.map(toView),
	};
}

export function activityView(buckets: UsageTotals[]): ActivityView {
	const tokens = buckets.map(b => Math.max(0, Math.round(b.tokens)));
	const total = tokens.reduce((sum, n) => sum + n, 0);
	const minutes = buckets.length * ACTIVITY_BUCKET_MINUTES;
	const span = minutes === 60 ? 'the last hour' : `the last ${minutes} minutes`;
	return {
		bucketMinutes: ACTIVITY_BUCKET_MINUTES,
		tokens,
		summary: total > 0 ? `${formatTokens(total)} tokens in ${span}` : `No activity in ${span}`,
	};
}

export function providerName(model: SidebarModel, id: string, fallback?: string): string {
	const status = model.providerStatuses.find(s => s.id === id);
	return displayText(status?.displayName ?? fallback ?? id, MAX_NAME_LENGTH) ?? id;
}

/** Today's provider shares as integer percentages that sum to 100. */
export function providerShareViews(model: SidebarModel): ProviderShareView[] {
	const percents = largestRemainderPercents(model.providers.map(p => p.tokens));
	return model.providers.map((p, i) => ({
		id: p.provider,
		name: providerName(model, p.provider),
		tokens: Math.max(0, Math.round(p.tokens)),
		percent: p.tokens > 0 ? percents[i] : null,
	}));
}

/** Privacy-safe sidebar text content from the host model. */
export function toSidebarView(model: SidebarModel, options: { firstRun: boolean }): SidebarView {
	return {
		live: model.live && {
			providerName: providerName(model, model.live.provider, model.live.providerName),
			model: displayText(model.live.model, MAX_MODEL_LENGTH),
			status: model.live.status,
			tokens: model.live.tokens === null ? null : formatTokens(model.live.tokens),
			updatedAt: Math.max(0, Math.round(model.live.updatedAt)),
		},
		today: model.today && todayView(model.today),
		session: model.session && todayView(model.session),
		periods: model.periods.map(periodView),
		activity: model.activity && activityView(model.activity),
		providers: providerShareViews(model),
		setup: {
			firstRun: options.firstRun,
			providers: model.providerStatuses.map(s => ({ id: s.id, name: providerName(model, s.id), state: s.state })),
		},
	};
}
