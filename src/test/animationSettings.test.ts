import * as assert from 'assert';
import { DEFAULT_ANIMATION_SETTINGS, MAX_FPS, MIN_FPS, normalizeAnimationSettings } from '../core/settings/animationSettings';
import { DEFAULT_VISUAL_MODE, normalizeVisualMode, VISUAL_MODES } from '../core/settings/visualModeSettings';

suite('Animation settings', () => {
	test('defaults match PRD §36', () => {
		assert.deepStrictEqual(DEFAULT_ANIMATION_SETTINGS, { enabled: true, maxFps: 30 });
		assert.deepStrictEqual(normalizeAnimationSettings(undefined, undefined), DEFAULT_ANIMATION_SETTINGS);
	});

	test('keeps valid values', () => {
		assert.deepStrictEqual(normalizeAnimationSettings(false, 12), { enabled: false, maxFps: 12 });
	});

	test('clamps, rounds and falls back for invalid user input', () => {
		assert.strictEqual(normalizeAnimationSettings(true, 0).maxFps, MIN_FPS);
		assert.strictEqual(normalizeAnimationSettings(true, 500).maxFps, MAX_FPS);
		assert.strictEqual(normalizeAnimationSettings(true, 24.6).maxFps, 25);
		assert.strictEqual(normalizeAnimationSettings(true, '15').maxFps, 30);
		assert.strictEqual(normalizeAnimationSettings(true, NaN).maxFps, 30);
		assert.strictEqual(normalizeAnimationSettings('no', 30).enabled, true);
	});
});

suite('Visual mode setting', () => {
	test('defaults to environmental and only accepts PRD §36 modes', () => {
		assert.strictEqual(DEFAULT_VISUAL_MODE, 'environmental');
		assert.deepStrictEqual([...VISUAL_MODES], ['environmental', 'neutral', 'minimal']);
		for (const mode of VISUAL_MODES) {
			assert.strictEqual(normalizeVisualMode(mode), mode);
		}
		for (const bad of [undefined, null, '', 'Neutral', 'dark', 1, {}]) {
			assert.strictEqual(normalizeVisualMode(bad), 'environmental', String(bad));
		}
	});
});
