/** `carbonbit.visualMode` values (PRD §36-38). */
export const VISUAL_MODES = ['environmental', 'neutral', 'minimal'] as const;
export type VisualMode = (typeof VISUAL_MODES)[number];

export const DEFAULT_VISUAL_MODE: VisualMode = 'environmental';

export function isVisualMode(value: unknown): value is VisualMode {
	return typeof value === 'string' && (VISUAL_MODES as readonly string[]).includes(value);
}

export function normalizeVisualMode(value: unknown): VisualMode {
	return isVisualMode(value) ? value : DEFAULT_VISUAL_MODE;
}
