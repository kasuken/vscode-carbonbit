import { ModelClass, modelClassOf as registryModelClassOf } from '../impact/modelRegistry';
import type { AiUsageEvent } from '../usage/usageEvent';

export const INTENSITIES = ['light', 'medium', 'heavy'] as const;
export type Intensity = (typeof INTENSITIES)[number];

export type { ModelClass };
export type ModelClassifier = (model: string | undefined) => ModelClass;

/** Request size (input + output tokens) at or above which a request reads as medium / heavy. */
export const MEDIUM_TOKENS = 8_000;
export const HEAVY_TOKENS = 40_000;

/** Used when neither the model class nor the request size is known. */
export const FALLBACK_INTENSITY: Intensity = 'medium';

const CLASS_INTENSITY: Record<Exclude<ModelClass, 'unknown'>, Intensity> = {
	small: 'light',
	medium: 'medium',
	frontier: 'heavy',
};

function sizeIntensity(event: AiUsageEvent): Intensity | undefined {
	if (event.inputTokens === undefined && event.outputTokens === undefined) {
		return undefined;
	}
	const tokens = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
	return tokens >= HEAVY_TOKENS ? 'heavy' : tokens >= MEDIUM_TOKENS ? 'medium' : 'light';
}

export function maxIntensity(a: Intensity, b: Intensity): Intensity {
	return INTENSITIES.indexOf(a) >= INTENSITIES.indexOf(b) ? a : b;
}

/**
 * Heavier of the model-class and request-size signals. Unknown model -> size only;
 * no signal at all (e.g. a partial `started` event) -> FALLBACK_INTENSITY.
 */
export function classifyIntensity(event: AiUsageEvent, modelClassOf: ModelClassifier = registryModelClassOf): Intensity {
	const modelClass = modelClassOf(event.model);
	const byModel = modelClass === 'unknown' ? undefined : CLASS_INTENSITY[modelClass];
	const bySize = sizeIntensity(event);
	if (byModel && bySize) {
		return maxIntensity(byModel, bySize);
	}
	return byModel ?? bySize ?? FALLBACK_INTENSITY;
}
