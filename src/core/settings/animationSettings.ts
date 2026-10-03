/** `carbonbit.animation.*` settings (PRD §35-36). */
export interface AnimationSettings {
	enabled: boolean;
	maxFps: number;
}

export const MIN_FPS = 1;
export const MAX_FPS = 60;

export const DEFAULT_ANIMATION_SETTINGS: Readonly<AnimationSettings> = Object.freeze({ enabled: true, maxFps: 30 });

/** Settings JSON is user-editable, so out-of-range or mistyped values fall back or are clamped. */
export function normalizeAnimationSettings(enabled: unknown, maxFps: unknown): AnimationSettings {
	return {
		enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_ANIMATION_SETTINGS.enabled,
		maxFps: typeof maxFps === 'number' && Number.isFinite(maxFps)
			? Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(maxFps)))
			: DEFAULT_ANIMATION_SETTINGS.maxFps,
	};
}
