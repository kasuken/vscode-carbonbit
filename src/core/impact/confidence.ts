export type Confidence = 'high' | 'medium' | 'low';

/** PRD §14 hierarchy, most to least specific. */
export type FactorLevel = 'model' | 'family' | 'class' | 'generic';

/** `partial`: actual counts with input or output missing (treated as 0). */
export type TokenProvenance = 'actual' | 'estimated' | 'partial';

const BASE: Record<FactorLevel, Confidence> = { model: 'high', family: 'medium', class: 'medium', generic: 'low' };
const LOWER: Record<Confidence, Confidence> = { high: 'medium', medium: 'low', low: 'low' };

/** Factor level sets the ceiling (PRD §14); anything but complete actual token counts lowers it one step. */
export function confidenceFor(level: FactorLevel, tokens: TokenProvenance): Confidence {
	return tokens === 'actual' ? BASE[level] : LOWER[BASE[level]];
}
