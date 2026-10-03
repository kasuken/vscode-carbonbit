import type { TodayMetrics, WorldState } from '../messages/protocol';
import type { ModelSummary, ProviderShare, UsageTotals } from '../storage/usageStore';
import type { PeriodSummary, UsageHistory } from '../storage/usageHistory';
import type { ProviderStatus } from '../usage/usageService';
import type { WorldSnapshot } from '../world/worldStateEngine';
import type { LiveRequest } from './liveActivity';

/** Live chart: the last hour in clock-aligned two-minute buckets. */
export const ACTIVITY_BUCKET_MINUTES = 2;
export const ACTIVITY_BUCKETS = 30;

export interface LiveRequestView extends LiveRequest {
	providerName: string;
}

/**
 * Everything the sidebar/details UI needs, gathered in one place (PRD §19, §27-30, §41-42).
 * Aggregates and metadata only; never prompts, responses, code or file names.
 */
export interface SidebarModel {
	worldState: WorldState;
	activeCount: number;
	/** Most recent request; `null` before any activity this session. */
	live: LiveRequestView | null;
	/** `null` when usage history is unavailable. */
	today: TodayMetrics | null;
	/** Since VS Code started; `null` when usage history is unavailable. */
	session: UsageTotals | null;
	/** Today, last 30 days, previous month, projected year; empty when usage history is unavailable. */
	periods: PeriodSummary[];
	/** Oldest first; `null` when usage history is unavailable. */
	activity: UsageTotals[] | null;
	/** Today's share by tokens, largest first. */
	providers: ProviderShare[];
	/** Today's per-model totals with confidence. */
	models: ModelSummary[];
	/** Detection/tracking per registered provider (onboarding and empty state). */
	providerStatuses: ProviderStatus[];
	anyProviderDetected: boolean;
}

export interface SidebarModelSources {
	world(): WorldSnapshot;
	live(): LiveRequest | null;
	history: Pick<UsageHistory, 'available' | 'todayMetrics' | 'totals' | 'periods' | 'activity' | 'providers' | 'models'>;
	statuses(): ProviderStatus[];
}

export function buildSidebarModel(sources: SidebarModelSources): SidebarModel {
	const { worldState, activeCount } = sources.world();
	const providerStatuses = sources.statuses();
	const live = sources.live();
	return {
		worldState,
		activeCount,
		live: live && {
			...live,
			providerName: providerStatuses.find(s => s.id === live.provider)?.displayName ?? live.provider,
		},
		today: sources.history.todayMetrics(),
		session: sources.history.available ? sources.history.totals('session') : null,
		periods: sources.history.available ? sources.history.periods() : [],
		activity: sources.history.available ? sources.history.activity(ACTIVITY_BUCKET_MINUTES * 60_000, ACTIVITY_BUCKETS) : null,
		providers: [...sources.history.providers('today')].sort((a, b) => b.tokens - a.tokens),
		models: sources.history.models('today'),
		providerStatuses,
		anyProviderDetected: providerStatuses.some(s => s.state === 'tracking'),
	};
}
