import type { Confidence } from '../impact/confidence';
import {
	hasExactKeys,
	isDisplayText,
	isNonNegativeInteger,
	isOneOf,
	isPeriodView,
	isPlainObject,
	isProviderShareView,
	isTodayText,
	isTodayView,
	MAX_MODEL_LENGTH,
	MAX_NAME_LENGTH,
	MAX_TEXT_LENGTH,
	type PeriodView,
	type ProviderShareView,
	type TodayText,
	type TodayView,
} from './protocol';

/** Details webview protocol (PRD §17, §30). Aggregates and methodology only; never prompts, responses, code or paths. */

export const DETAILS_TABS = ['overview', 'methodology'] as const;
export type DetailsTab = (typeof DETAILS_TABS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const satisfies readonly Confidence[];

/** `why` explains the confidence level itself; the rest follow the estimate reasons (PRD §17). */
export const EXPLANATION_KINDS = ['why', 'tokens', 'model', 'energy', 'carbonIntensity', 'water', 'methodology'] as const;
export type ExplanationKind = (typeof EXPLANATION_KINDS)[number];

export interface ExplanationLine {
	kind: ExplanationKind;
	label: string;
	value: string;
}

/** A confidence level and why it has that level; `null` confidence means nothing could be estimated. */
export interface EstimateView {
	confidence: Confidence | null;
	lines: ExplanationLine[];
}

export interface ModelDetailView {
	/** `null` when the provider didn't report a model. */
	model: string | null;
	requests: number;
	tokens: number;
	text: TodayText;
	estimate: EstimateView;
}

/** The sidebar's provider share plus request count and formatted tokens. */
export interface ProviderDetailView extends ProviderShareView {
	requests: number;
	tokensText: string;
}

/** Live figures; sent on ready and on (throttled) usage changes while the panel is visible. */
export interface DetailsMessage {
	type: 'details';
	/** `null` when usage history is unavailable. */
	today: TodayView | null;
	/** Same periods and comparisons as the sidebar. */
	periods: PeriodView[];
	/** Confidence of today's combined estimate. */
	overall: EstimateView;
	models: ModelDetailView[];
	providers: ProviderDetailView[];
}

export type DetailsView = Omit<DetailsMessage, 'type'>;

export interface ConfidenceLevelView {
	level: string;
	/** Confidence with actual token counts. */
	actual: Confidence;
	/** Confidence with partial or estimated token counts. */
	reduced: Confidence;
}

export interface FactorView {
	name: string;
	value: string;
	/** Source ids, see `sources`. */
	sources: string[];
}

export interface SourceView {
	id: string;
	citation: string;
	usedFor: string;
	url: string;
}

/** Static methodology, rendered from the same factor data the impact engine uses. */
export interface MethodologyMessage {
	type: 'methodology';
	id: string;
	version: string;
	effectiveDate: string;
	summary: string;
	collection: string[];
	levels: ConfidenceLevelView[];
	factors: FactorView[];
	assumptions: string[];
	limitations: string[];
	sources: SourceView[];
}

export type MethodologyView = Omit<MethodologyMessage, 'type'>;

export interface ShowTabMessage {
	type: 'show';
	tab: DetailsTab;
}

export type HostToDetailsMessage = DetailsMessage | MethodologyMessage | ShowTabMessage;

export type DetailsToHostMessage = { type: 'ready' } | { type: 'openMethodologyDocument' };

export const MAX_LONG_TEXT_LENGTH = 400;
export const MAX_MODEL_ROWS = 100;
const MAX_ITEMS = 32;
const PERIOD_LIMIT = 8;
const MAX_URL_LENGTH = 300;

function isArrayOf<T>(value: unknown, isItem: (item: unknown) => item is T, max = MAX_ITEMS): value is T[] {
	return Array.isArray(value) && value.length <= max && value.every(isItem);
}

const isLongText = (value: unknown): value is string => isDisplayText(value, MAX_LONG_TEXT_LENGTH);
const isShortText = (value: unknown): value is string => isDisplayText(value, MAX_TEXT_LENGTH);

function isHttpsUrl(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_URL_LENGTH && /^https:\/\/[^\s"'<>\\]+$/.test(value);
}

function isExplanationLine(value: unknown): value is ExplanationLine {
	return isPlainObject(value)
		&& hasExactKeys(value, ['kind', 'label', 'value'])
		&& isOneOf(EXPLANATION_KINDS, value.kind)
		&& isDisplayText(value.label, MAX_NAME_LENGTH)
		&& isLongText(value.value);
}

function isEstimateView(value: unknown): value is EstimateView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['confidence', 'lines'])
		&& (value.confidence === null || isOneOf(CONFIDENCE_LEVELS, value.confidence))
		&& isArrayOf(value.lines, isExplanationLine, EXPLANATION_KINDS.length);
}

function isModelDetailView(value: unknown): value is ModelDetailView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['model', 'requests', 'tokens', 'text', 'estimate'])
		&& (value.model === null || isDisplayText(value.model, MAX_MODEL_LENGTH))
		&& isNonNegativeInteger(value.requests)
		&& isNonNegativeInteger(value.tokens)
		&& isTodayText(value.text)
		&& isEstimateView(value.estimate);
}

function isProviderDetailView(value: unknown): value is ProviderDetailView {
	if (!isPlainObject(value) || !hasExactKeys(value, ['id', 'name', 'tokens', 'percent', 'requests', 'tokensText'])) {
		return false;
	}
	const { requests, tokensText, ...share } = value;
	return isProviderShareView(share) && isNonNegativeInteger(requests) && isShortText(tokensText);
}

function isConfidenceLevelView(value: unknown): value is ConfidenceLevelView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['level', 'actual', 'reduced'])
		&& isDisplayText(value.level, MAX_NAME_LENGTH)
		&& isOneOf(CONFIDENCE_LEVELS, value.actual)
		&& isOneOf(CONFIDENCE_LEVELS, value.reduced);
}

function isFactorView(value: unknown): value is FactorView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['name', 'value', 'sources'])
		&& isDisplayText(value.name, MAX_NAME_LENGTH)
		&& isLongText(value.value)
		&& isArrayOf(value.sources, isShortText);
}

function isSourceView(value: unknown): value is SourceView {
	return isPlainObject(value)
		&& hasExactKeys(value, ['id', 'citation', 'usedFor', 'url'])
		&& isShortText(value.id)
		&& isLongText(value.citation)
		&& isLongText(value.usedFor)
		&& isHttpsUrl(value.url);
}

export function isHostToDetailsMessage(value: unknown): value is HostToDetailsMessage {
	if (!isPlainObject(value)) {
		return false;
	}
	switch (value.type) {
		case 'details':
			return hasExactKeys(value, ['type', 'today', 'periods', 'overall', 'models', 'providers'])
				&& (value.today === null || isTodayView(value.today))
				&& isArrayOf(value.periods, isPeriodView, PERIOD_LIMIT)
				&& isEstimateView(value.overall)
				&& isArrayOf(value.models, isModelDetailView, MAX_MODEL_ROWS)
				&& isArrayOf(value.providers, isProviderDetailView);
		case 'methodology':
			return hasExactKeys(value, ['type', 'id', 'version', 'effectiveDate', 'summary', 'collection', 'levels', 'factors', 'assumptions', 'limitations', 'sources'])
				&& isShortText(value.id)
				&& isShortText(value.version)
				&& isShortText(value.effectiveDate)
				&& isLongText(value.summary)
				&& isArrayOf(value.collection, isLongText)
				&& isArrayOf(value.levels, isConfidenceLevelView)
				&& isArrayOf(value.factors, isFactorView)
				&& isArrayOf(value.assumptions, isLongText)
				&& isArrayOf(value.limitations, isLongText)
				&& isArrayOf(value.sources, isSourceView);
		case 'show':
			return hasExactKeys(value, ['type', 'tab']) && isOneOf(DETAILS_TABS, value.tab);
		default:
			return false;
	}
}

export function isDetailsToHostMessage(value: unknown): value is DetailsToHostMessage {
	return isPlainObject(value)
		&& (value.type === 'ready' || value.type === 'openMethodologyDocument')
		&& hasExactKeys(value, ['type']);
}
