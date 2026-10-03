import { CARBON_EQUIVALENT_IDS, type CarbonEquivalentId, WATER_EQUIVALENT_IDS, type WaterEquivalentId } from '../impact/data/environmentalFactors';
import { MAX_FPS, MIN_FPS } from '../settings/animationSettings';
import { isVisualMode, type VisualMode } from '../settings/visualModeSettings';
import { AI_PROVIDER_IDS, AI_USAGE_STATUSES, type AiProviderId, type AiUsageStatus } from '../usage/usageEvent';
import type { ProviderTrackingState } from '../usage/usageService';

/** World states from PRD §21, as string literals so they survive postMessage. */
export const WORLD_STATES = [
	'Idle',
	'RequestStarting',
	'ProcessingLight',
	'ProcessingMedium',
	'ProcessingHeavy',
	'ResponseArriving',
	'Failed',
] as const;
export type WorldState = (typeof WORLD_STATES)[number];

/** Aggregate-only daily totals. Never carries prompts, responses, code or file names. */
export interface TodayMetrics {
	energyWh: number;
	carbonGrams: number;
	waterLiters: number;
	tokens: number;
	requests: number;
}

/** Pre-formatted display strings, so host and webview never disagree on units. */
export interface TodayText {
	energy: string;
	carbon: string;
	water: string;
	tokens: string;
	requests: string;
}

export interface TodayView extends TodayMetrics {
	text: TodayText;
}

/** Most recent request; metadata only. */
export interface LiveView {
	providerName: string;
	model: string | null;
	status: AiUsageStatus;
	/** Formatted token count of this request; `null` until the provider reports one. */
	tokens: string | null;
	/** Epoch ms of the last update, so the webview can say how long ago it was. */
	updatedAt: number;
}

/** Reporting periods for the footprint (PRD §16). */
export const PERIOD_IDS = ['today', 'last30Days', 'previousMonth', 'projectedYear'] as const;
export type PeriodId = (typeof PERIOD_IDS)[number];

/** One everyday comparison, e.g. amount `1.16` and unit `km driving (petrol car)`. */
export interface EquivalentView<Id extends string = string> {
	id: Id;
	amount: string;
	unit: string;
}

export interface PeriodView {
	id: PeriodId;
	label: string;
	/** Short qualifier, e.g. the month name or what a projection is based on. */
	note: string | null;
	totals: TodayView;
	carbon: EquivalentView<CarbonEquivalentId>[];
	water: EquivalentView<WaterEquivalentId>[];
}

/** Recent activity for the live chart; aggregates only. */
export interface ActivityView {
	bucketMinutes: number;
	/** Tokens per clock-aligned bucket, oldest first; the last bucket is still filling. */
	tokens: number[];
	/** E.g. `124K tokens in the last hour`. */
	summary: string;
}

export interface ProviderShareView {
	id: AiProviderId;
	name: string;
	tokens: number;
	/** Integer share of today's tokens (all shares sum to 100); `null` when the provider reported no tokens. */
	percent: number | null;
}

export const PROVIDER_TRACKING_STATES = ['stopped', 'tracking', 'unavailable', 'failed'] as const satisfies readonly ProviderTrackingState[];

export interface ProviderSetupView {
	id: AiProviderId;
	name: string;
	state: ProviderTrackingState;
}

export interface SetupView {
	/** Onboarding not dismissed yet. */
	firstRun: boolean;
	/** Every supported provider and its detection state. */
	providers: ProviderSetupView[];
}

/** World animation input; sent on every world transition. */
export interface StateMessage {
	type: 'state';
	worldState: WorldState;
	/** In-flight requests; drives animation density and the "+N active" indicator (PRD §27). */
	activeCount: number;
}

/** Text content of the sidebar (PRD §27-29, §41-42); sent on usage changes, throttled by the host. */
export interface ViewMessage {
	type: 'view';
	live: LiveView | null;
	/** `null` when usage history is unavailable. */
	today: TodayView | null;
	/** Requests since VS Code started; `null` when usage history is unavailable. */
	session: TodayView | null;
	/** Footprint per period with everyday comparisons; empty when usage history is unavailable. */
	periods: PeriodView[];
	activity: ActivityView | null;
	providers: ProviderShareView[];
	setup: SetupView;
}

export type SidebarView = Omit<ViewMessage, 'type'>;

/** Renderer settings; sent before the first state and again whenever they change. */
export interface ConfigMessage {
	type: 'config';
	animationEnabled: boolean;
	/** Integer frame-rate cap in [MIN_FPS, MAX_FPS]. */
	maxFps: number;
	visualMode: VisualMode;
}

export type HostToWebviewMessage = StateMessage | ViewMessage | ConfigMessage;

export interface ReadyMessage {
	type: 'ready';
}

/** The only commands the sidebar may run; ids must match `contributes.commands`. */
export const SIDEBAR_COMMANDS = [
	'carbonbit.showDetails',
	'carbonbit.showMethodology',
	'carbonbit.refreshUsage',
	'carbonbit.openDiagnostics',
] as const;
export type SidebarCommand = (typeof SIDEBAR_COMMANDS)[number];

export interface CommandMessage {
	type: 'command';
	command: SidebarCommand;
}

export interface DismissOnboardingMessage {
	type: 'dismissOnboarding';
}

export type WebviewToHostMessage = ReadyMessage | CommandMessage | DismissOnboardingMessage;

export const MAX_NAME_LENGTH = 64;
export const MAX_MODEL_LENGTH = 128;
export const MAX_TEXT_LENGTH = 32;
const MAX_PROVIDERS = 16;
export const MAX_ACTIVITY_BUCKETS = 120;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Exact key match: extra fields are rejected so no unexpected data can cross the boundary.
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value);
	return actual.length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(value, k));
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isNonNegativeInteger(value: unknown): value is number {
	return isNonNegativeNumber(value) && Number.isInteger(value);
}

export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isWorldState(value: unknown): value is WorldState {
	return isOneOf(WORLD_STATES, value);
}

// Short, single-line display text: no control characters, bounded length.
export function isDisplayText(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function isArrayOf<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
	return Array.isArray(value) && value.length <= MAX_PROVIDERS && value.every(isItem);
}

export function isTodayText(value: unknown): value is TodayText {
	return isPlainObject(value)
		&& hasExactKeys(value, ['energy', 'carbon', 'water', 'tokens', 'requests'])
		&& Object.values(value).every(text => isDisplayText(text, MAX_TEXT_LENGTH));
}

export function isTodayView(value: unknown): value is TodayView {
	if (!isPlainObject(value) || !hasExactKeys(value, ['energyWh', 'carbonGrams', 'waterLiters', 'tokens', 'requests', 'text'])) {
		return false;
	}
	const { text, ...metrics } = value;
	return isTodayMetrics(metrics) && isTodayText(text);
}

function isLiveView(value: unknown): value is LiveView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['providerName', 'model', 'status', 'tokens', 'updatedAt'])
		&& isDisplayText(value.providerName, MAX_NAME_LENGTH)
		&& (value.model === null || isDisplayText(value.model, MAX_MODEL_LENGTH))
		&& isOneOf(AI_USAGE_STATUSES, value.status)
		&& (value.tokens === null || isDisplayText(value.tokens, MAX_TEXT_LENGTH))
		&& isNonNegativeInteger(value.updatedAt);
}

function isEquivalentView<Id extends string>(ids: readonly Id[]) {
	return (value: unknown): value is EquivalentView<Id> => isPlainObject(value)
		&& hasExactKeys(value, ['id', 'amount', 'unit'])
		&& isOneOf(ids, value.id)
		&& isDisplayText(value.amount, MAX_TEXT_LENGTH)
		&& isDisplayText(value.unit, MAX_NAME_LENGTH);
}

export function isPeriodView(value: unknown): value is PeriodView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['id', 'label', 'note', 'totals', 'carbon', 'water'])
		&& isOneOf(PERIOD_IDS, value.id)
		&& isDisplayText(value.label, MAX_NAME_LENGTH)
		&& (value.note === null || isDisplayText(value.note, MAX_NAME_LENGTH))
		&& isTodayView(value.totals)
		&& isArrayOf(value.carbon, isEquivalentView(CARBON_EQUIVALENT_IDS))
		&& isArrayOf(value.water, isEquivalentView(WATER_EQUIVALENT_IDS));
}

function isActivityView(value: unknown): value is ActivityView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['bucketMinutes', 'tokens', 'summary'])
		&& isNonNegativeInteger(value.bucketMinutes)
		&& value.bucketMinutes > 0
		&& Array.isArray(value.tokens)
		&& value.tokens.length <= MAX_ACTIVITY_BUCKETS
		&& value.tokens.every(isNonNegativeInteger)
		&& isDisplayText(value.summary, MAX_NAME_LENGTH);
}

export function isProviderShareView(value: unknown): value is ProviderShareView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['id', 'name', 'tokens', 'percent'])
		&& isOneOf(AI_PROVIDER_IDS, value.id)
		&& isDisplayText(value.name, MAX_NAME_LENGTH)
		&& isNonNegativeInteger(value.tokens)
		&& (value.percent === null || (isNonNegativeInteger(value.percent) && value.percent <= 100));
}

function isProviderSetupView(value: unknown): value is ProviderSetupView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['id', 'name', 'state'])
		&& isOneOf(AI_PROVIDER_IDS, value.id)
		&& isDisplayText(value.name, MAX_NAME_LENGTH)
		&& isOneOf(PROVIDER_TRACKING_STATES, value.state);
}

function isSetupView(value: unknown): value is SetupView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['firstRun', 'providers'])
		&& typeof value.firstRun === 'boolean'
		&& isArrayOf(value.providers, isProviderSetupView);
}

function isTodayMetrics(value: unknown): value is TodayMetrics {
	return isPlainObject(value)
		&& hasExactKeys(value, ['energyWh', 'carbonGrams', 'waterLiters', 'tokens', 'requests'])
		&& isNonNegativeNumber(value.energyWh)
		&& isNonNegativeNumber(value.carbonGrams)
		&& isNonNegativeNumber(value.waterLiters)
		&& isNonNegativeInteger(value.tokens)
		&& isNonNegativeInteger(value.requests);
}

export function isHostToWebviewMessage(value: unknown): value is HostToWebviewMessage {
	if (!isPlainObject(value)) {
		return false;
	}
	switch (value.type) {
		case 'state':
			return hasExactKeys(value, ['type', 'worldState', 'activeCount'])
				&& isWorldState(value.worldState)
				&& isNonNegativeInteger(value.activeCount);
		case 'view':
			return hasExactKeys(value, ['type', 'live', 'today', 'session', 'periods', 'activity', 'providers', 'setup'])
				&& (value.live === null || isLiveView(value.live))
				&& (value.today === null || isTodayView(value.today))
				&& (value.session === null || isTodayView(value.session))
				&& isArrayOf(value.periods, isPeriodView)
				&& (value.activity === null || isActivityView(value.activity))
				&& isArrayOf(value.providers, isProviderShareView)
				&& isSetupView(value.setup);
		case 'config':
			return hasExactKeys(value, ['type', 'animationEnabled', 'maxFps', 'visualMode'])
				&& typeof value.animationEnabled === 'boolean'
				&& isNonNegativeInteger(value.maxFps)
				&& value.maxFps >= MIN_FPS
				&& value.maxFps <= MAX_FPS
				&& isVisualMode(value.visualMode);
		default:
			return false;
	}
}

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
	if (!isPlainObject(value)) {
		return false;
	}
	switch (value.type) {
		case 'ready':
		case 'dismissOnboarding':
			return hasExactKeys(value, ['type']);
		case 'command':
			return hasExactKeys(value, ['type', 'command']) && isOneOf(SIDEBAR_COMMANDS, value.command);
		default:
			return false;
	}
}
