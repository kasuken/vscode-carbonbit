import type { AiUsageEvent } from '../usage/usageEvent';
import { Confidence, confidenceFor, FactorLevel, TokenProvenance } from './confidence';
import { ENVIRONMENTAL_FACTORS, EnergyFactor, EnvironmentalFactorData } from './data/environmentalFactors';
import { defaultModelRegistry, ModelRegistry, ModelResolution } from './modelRegistry';

export type ReasonKind = 'tokens' | 'model' | 'energy' | 'carbonIntensity' | 'water';

/** One line of the "why this confidence" explanation (PRD §17). */
export interface EstimateReason {
	kind: ReasonKind;
	code: string;
	text: string;
}

/** PRD §13 `EnvironmentalImpact`, plus the provenance needed to explain it. Always an estimate. */
export interface ImpactEstimate {
	energyWh: number;
	carbonGrams: number;
	waterLiters: number;
	confidence: Confidence;
	methodology: string;
	methodologyVersion: string;
	factorLevel: FactorLevel;
	tokenSource: TokenProvenance;
	model: ModelResolution;
	reasons: EstimateReason[];
	estimated: true;
}

const TOKEN_TEXT: Record<TokenProvenance, string> = {
	actual: 'Token usage: actual (reported by the provider)',
	estimated: 'Token usage: estimated',
	partial: 'Token usage: partial (missing input or output count treated as 0)',
};

/** The model resolution and energy factor an estimate for a model name would use. */
export interface ModelFactor {
	model: ModelResolution;
	level: FactorLevel;
	factor: EnergyFactor;
}

export class ImpactEngine {
	constructor(
		readonly factors: EnvironmentalFactorData = ENVIRONMENTAL_FACTORS,
		private readonly registry: ModelRegistry = defaultModelRegistry,
	) {}

	/**
	 * Estimates the impact of one request from its token counts, whatever its status, so
	 * failed/cancelled requests with usage are kept. `undefined` when the event has no token counts.
	 */
	estimate(event: AiUsageEvent): ImpactEstimate | undefined {
		const { inputTokens, outputTokens, cachedInputTokens, cacheCreationTokens } = event;
		if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && cacheCreationTokens === undefined) {
			return undefined;
		}
		const { model, level, factor } = this.describeModel(event.model);
		const tokenSource: TokenProvenance = event.source === 'estimated' ? 'estimated'
			: inputTokens === undefined || outputTokens === undefined ? 'partial' : 'actual';

		const weights = this.factors.tokenWeights;
		const weightedInput = (inputTokens ?? 0)
			+ (cachedInputTokens ?? 0) * weights.cachedInput
			+ (cacheCreationTokens ?? 0) * weights.cacheCreation;
		const energyWh = weightedInput * factor.whPerInputToken + (outputTokens ?? 0) * factor.whPerOutputToken;
		const energyKWh = energyWh / 1000;
		const { carbonIntensity, waterIntensity, methodology } = this.factors;

		return {
			energyWh,
			carbonGrams: energyKWh * carbonIntensity.gramsCo2ePerKWh,
			waterLiters: energyKWh * waterIntensity.litersPerKWh,
			confidence: confidenceFor(level, tokenSource),
			methodology: methodology.id,
			methodologyVersion: methodology.version,
			factorLevel: level,
			tokenSource,
			model,
			reasons: [
				{ kind: 'tokens', code: tokenSource, text: TOKEN_TEXT[tokenSource] },
				{ kind: 'model', code: model.match, text: modelText(model) },
				{ kind: 'energy', code: level, text: `Energy model: ${factor.label}` },
				{ kind: 'carbonIntensity', code: 'generic', text: `Carbon intensity: ${carbonIntensity.label}` },
				{ kind: 'water', code: 'generic', text: `Water: ${waterIntensity.label}` },
			],
			estimated: true,
		};
	}

	describeModel(name: string | undefined): ModelFactor {
		const model = this.registry.resolve(name);
		const { models, families, classes, generic } = this.factors.energy;
		if (model.canonicalModel && Object.hasOwn(models, model.canonicalModel)) {
			return { model, level: 'model', factor: models[model.canonicalModel] };
		}
		if (model.family && Object.hasOwn(families, model.family)) {
			return { model, level: 'family', factor: families[model.family] };
		}
		if (model.modelClass !== 'unknown') {
			return { model, level: 'class', factor: classes[model.modelClass] };
		}
		return { model, level: 'generic', factor: generic };
	}
}

/** How a model name was matched, e.g. `gpt-4.1 (matched gpt-4.1 family, medium class)`. */
export function describeModelMatch(model: ModelResolution): string {
	switch (model.match) {
		case 'model':
			return `${model.canonicalModel} (${model.family} family, ${model.modelClass} class)`;
		case 'family':
			return `${model.normalized} (matched ${model.family} family, ${model.modelClass} class)`;
		default:
			return model.normalized
				? `${model.normalized} (not recognized; generic fallback)`
				: 'not reported (generic fallback)';
	}
}

function modelText(model: ModelResolution): string {
	return `Model: ${describeModelMatch(model)}`;
}
