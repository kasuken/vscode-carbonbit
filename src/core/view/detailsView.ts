import { type Confidence, confidenceFor, type FactorLevel } from '../impact/confidence';
import type { EnergyFactor, EquivalentFactor, Provenance } from '../impact/data/environmentalFactors';
import { describeModelMatch, ImpactEngine } from '../impact/impactEngine';
import { formatTokens } from '../impact/units';
import {
	type DetailsView,
	type EstimateView,
	type ExplanationLine,
	MAX_LONG_TEXT_LENGTH,
	MAX_MODEL_ROWS,
	type MethodologyView,
	type ModelDetailView,
} from '../messages/detailsProtocol';
import { MAX_MODEL_LENGTH } from '../messages/protocol';
import type { ModelSummary, TokenProvenanceCounts } from '../storage/usageStore';
import type { SidebarModel } from './sidebarModel';
import { displayText, metricsText, periodView, providerShareViews, todayView } from './sidebarView';

const defaultEngine = new ImpactEngine();

/** PRD §14 hierarchy names. */
const LEVEL_TEXT: Record<FactorLevel, string> = {
	model: 'Model-specific measurement',
	family: 'Model-family measurement',
	class: 'Model-class estimate',
	generic: 'Generic inference estimate',
};
const FACTOR_LEVELS = Object.keys(LEVEL_TEXT) as FactorLevel[];
const CONFIDENCE_TEXT: Record<Confidence, string> = { high: 'High', medium: 'Medium', low: 'Low' };
const CONFIDENCE_ORDER: readonly Confidence[] = ['low', 'medium', 'high'];

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const line = (kind: ExplanationLine['kind'], label: string, value: string): ExplanationLine =>
	({ kind, label, value: displayText(value, MAX_LONG_TEXT_LENGTH) ?? '\u2014' });

function lowest(levels: (Confidence | null)[]): Confidence | null {
	const known = levels.filter((c): c is Confidence => c !== null);
	return known.length ? known.reduce((a, b) => (CONFIDENCE_ORDER.indexOf(a) <= CONFIDENCE_ORDER.indexOf(b) ? a : b)) : null;
}

function countText(parts: [number, string][]): string {
	return parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`).join(', ');
}

/** Distinguishes actual usage counters from estimated or missing ones. */
function tokenUsageText(requests: number, counts: TokenProvenanceCounts): string {
	const parts: [number, string][] = [
		[counts.actual, 'actual (reported by the provider)'],
		[counts.partial, 'partial (a missing input or output count is treated as 0)'],
		[counts.estimated, 'estimated by CarbonBit'],
		[Math.max(0, requests - counts.actual - counts.partial - counts.estimated), 'without token counts (not estimated)'],
	];
	const present = parts.filter(([n]) => n > 0);
	if (present.length === 0) {
		return 'No requests';
	}
	if (present.length === 1) {
		const [n, text] = present[0];
		return `${text[0].toUpperCase()}${text.slice(1)} for ${plural(n, 'request')}`;
	}
	return `Mixed: ${countText(present)}`;
}

const energyFactorText = (f: EnergyFactor) =>
	`${f.label}, ${f.whPerInputToken} Wh per input token and ${f.whPerOutputToken} Wh per output token`;
const sourcesText = (p: Provenance) => (p.sources.length ? ` (source: ${p.sources.join(', ')})` : '');

function sharedLines(engine: ImpactEngine, versions: string[]): ExplanationLine[] {
	const { carbonIntensity: carbon, waterIntensity: water, methodology } = engine.factors;
	const result = [
		line('carbonIntensity', 'Carbon intensity', `${carbon.label}: ${carbon.gramsCo2ePerKWh} g CO\u2082e per kWh${sourcesText(carbon)}`),
		line('water', 'Water', `${water.label}: ${water.litersPerKWh} L per kWh${sourcesText(water)}`),
	];
	if (versions.length) {
		result.push(line('methodology', 'Methodology', `${methodology.id} ${versions.map(v => `v${v}`).join(', ')}`));
	}
	return result;
}

function modelEstimate(summary: ModelSummary, engine: ImpactEngine): EstimateView {
	const described = engine.describeModel(summary.model ?? undefined);
	const level = summary.factorLevel;
	let why: string;
	let energy: string;
	if (summary.confidence === null || level === null) {
		why = 'Not estimated: no token counts were reported for this model.';
		energy = 'Not applied (no token counts)';
	} else {
		const start = confidenceFor(level, 'actual');
		why = summary.confidence === start
			? `${CONFIDENCE_TEXT[start]}: a ${LEVEL_TEXT[level].toLowerCase()} starts at ${CONFIDENCE_TEXT[start]} and all token counts are actual.`
			: `${CONFIDENCE_TEXT[summary.confidence]}: a ${LEVEL_TEXT[level].toLowerCase()} starts at ${CONFIDENCE_TEXT[start]}, lowered one step because some token counts are partial or estimated.`;
		// Factor values come from the current data; only show them if the stored level still matches.
		energy = described.level === level
			? `${energyFactorText(described.factor)}${sourcesText(described.factor)}`
			: LEVEL_TEXT[level];
	}
	return {
		confidence: summary.confidence,
		lines: [
			line('why', 'Confidence', why),
			line('tokens', 'Token usage', tokenUsageText(summary.requests, summary.tokenProvenance)),
			line('model', 'Model', describeModelMatch(described.model)),
			line('energy', 'Energy model', energy),
			...sharedLines(engine, summary.methodologyVersions),
		],
	};
}

function overallEstimate(models: ModelSummary[], engine: ImpactEngine): EstimateView {
	const confidence = lowest(models.map(m => m.confidence));
	const requests = models.reduce((sum, m) => sum + m.requests, 0);
	const counts: TokenProvenanceCounts = { actual: 0, partial: 0, estimated: 0 };
	for (const m of models) {
		counts.actual += m.tokenProvenance.actual;
		counts.partial += m.tokenProvenance.partial;
		counts.estimated += m.tokenProvenance.estimated;
	}
	const matches = models.map(m => engine.describeModel(m.model ?? undefined).model);
	const byLevel = (level: FactorLevel | null) => models.filter(m => m.factorLevel === level).length;
	const byConfidence = [...CONFIDENCE_ORDER].reverse().map((c): [number, string] => [models.filter(m => m.confidence === c).length, CONFIDENCE_TEXT[c]]);
	const versions = [...new Set(models.flatMap(m => m.methodologyVersions))].sort();

	const why = confidence === null
		? 'Not estimated: no token counts were reported today.'
		: `${CONFIDENCE_TEXT[confidence]}: the lowest confidence among today's models (${countText(byConfidence)}).`;
	const modelText = models.length === 0 ? 'No models today' : `${plural(models.length, 'model')}: ${countText([
		[matches.filter(m => m.match === 'model').length, 'recognized'],
		[matches.filter(m => m.match === 'family').length, 'matched by family'],
		[matches.filter(m => m.match === 'unknown' && m.normalized).length, 'not recognized (generic fallback)'],
		[matches.filter(m => !m.normalized).length, 'not reported (generic fallback)'],
	])}`;
	const energyText = [
		...FACTOR_LEVELS.map((level): [number, string] => [byLevel(level), `with a ${LEVEL_TEXT[level].toLowerCase()}`]),
		[byLevel(null), 'not estimated'] as [number, string],
	].filter(([n]) => n > 0).map(([n, text]) => `${plural(n, 'model')} ${text}`).join(', ');
	return {
		confidence,
		lines: [
			line('why', 'Confidence', why),
			line('tokens', 'Token usage', tokenUsageText(requests, counts)),
			line('model', 'Models', modelText),
			line('energy', 'Energy model', energyText || 'No estimates today'),
			...sharedLines(engine, versions),
		],
	};
}

/** Details content from the same model (and formatters) the sidebar uses, so figures always reconcile. */
export function toDetailsView(model: SidebarModel, engine: ImpactEngine = defaultEngine): DetailsView {
	const requestsBy = new Map(model.providers.map(p => [p.provider, p.requests]));
	return {
		today: model.today && todayView(model.today),
		periods: model.periods.map(periodView),
		overall: overallEstimate(model.models, engine),
		models: model.models.slice(0, MAX_MODEL_ROWS).map((m): ModelDetailView => ({
			model: displayText(m.model, MAX_MODEL_LENGTH),
			requests: m.requests,
			tokens: Math.max(0, Math.round(m.tokens)),
			text: metricsText(m),
			estimate: modelEstimate(m, engine),
		})),
		providers: providerShareViews(model).map(p => ({ ...p, requests: requestsBy.get(p.id) ?? 0, tokensText: formatTokens(p.tokens) })),
	};
}

const BASIS_UNIT: Record<EquivalentFactor['basis'], string> = { carbonGrams: 'g CO₂e', energyWh: 'Wh', waterLiters: 'L' };

function unique(lists: string[][]): string[] {
	return [...new Set(lists.flat())];
}

/** Methodology surface (PRD §30) built from the engine's factor data, never a second copy of it. */
export function methodologyView(engine: ImpactEngine = defaultEngine): MethodologyView {
	const data = engine.factors;
	const energy = [
		...Object.entries(data.energy.models).map(([id, f]): [string, EnergyFactor] => [`${f.label} (${id})`, f]),
		...Object.entries(data.energy.families).map(([id, f]): [string, EnergyFactor] => [`${f.label} (${id})`, f]),
		...Object.values(data.energy.classes).map((f): [string, EnergyFactor] => [f.label, f]),
		[data.energy.generic.label, data.energy.generic] as [string, EnergyFactor],
	];
	const provenance: Provenance[] = [data.tokenWeights, ...energy.map(([, f]) => f), data.carbonIntensity, data.waterIntensity];
	return {
		id: data.methodology.id,
		version: data.methodology.version,
		effectiveDate: data.methodology.effectiveDate,
		summary: data.methodology.summary,
		collection: [
			'CarbonBit reads usage metadata (provider, model, timing and token counts) from local logs of supported AI tools. Prompts, responses, code and file names are never stored or sent.',
			'Requests and tokens are usage counters. Energy, CO\u2082e and water are always estimates calculated from them.',
			'Actual: token counts reported by the provider.',
			'Partial: the provider reported input or output tokens but not both; the missing count is treated as 0.',
			'Estimated: token counts derived by CarbonBit instead of reported by the provider.',
			'Requests without any token counts are counted but get no impact estimate.',
		],
		levels: FACTOR_LEVELS.map(level => ({ level: LEVEL_TEXT[level], actual: confidenceFor(level, 'actual'), reduced: confidenceFor(level, 'partial') })),
		factors: [
			...energy.map(([name, f]) => ({
				name,
				value: `${f.whPerInputToken} Wh per input token, ${f.whPerOutputToken} Wh per output token`,
				sources: f.sources,
			})),
			{
				name: 'Cache token weights',
				value: `Cache reads count as ${data.tokenWeights.cachedInput} and cache writes as ${data.tokenWeights.cacheCreation} of an input token`,
				sources: data.tokenWeights.sources,
			},
			{ name: 'Carbon intensity', value: `${data.carbonIntensity.gramsCo2ePerKWh} g CO\u2082e per kWh: ${data.carbonIntensity.label}`, sources: data.carbonIntensity.sources },
			{ name: 'Water intensity', value: `${data.waterIntensity.litersPerKWh} L per kWh: ${data.waterIntensity.label}`, sources: data.waterIntensity.sources },
			// Comparisons carry their own assumptions inline so the shared lists stay about the estimate itself.
			...[...Object.values(data.equivalents.carbon), ...Object.values(data.equivalents.water)].map(e => ({
				name: `Comparison: ${e.one}`,
				value: [`${e.perUnit} ${BASIS_UNIT[e.basis]} each.`, ...e.assumptions, ...e.limitations].join(' '),
				sources: e.sources,
			})),
		],
		assumptions: unique(provenance.map(p => p.assumptions)),
		limitations: unique(provenance.map(p => p.limitations)),
		sources: Object.entries(data.sources).map(([id, s]) => ({
			id,
			citation: `${s.author}, \u201c${s.title}\u201d (${s.year})`,
			usedFor: s.usedFor,
			url: s.url,
		})),
	};
}
