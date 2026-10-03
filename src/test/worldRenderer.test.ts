import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { WORLD_STATES } from '../core/messages/protocol';
import { createBrowser, dynamicCalls, type Frame, frameOf, RecordingContext, root, WORLD_SCRIPTS } from './fakeBrowser';

const HOURS = [6, 12, 19, 23];

suite('Pixel world renderer', () => {
	test('world scripts are self-contained primitives with no external assets', () => {
		for (const file of WORLD_SCRIPTS) {
			const source = fs.readFileSync(path.join(root, file), 'utf8');
			assert.ok(!/https?:|url\(|new Image|fetch\(|XMLHttpRequest|import\(|eval\(|new Function/.test(source), file);
		}
	});

	test('draws the whole scene deterministically on integer pixels, at every hour', () => {
		const browser = createBrowser();
		for (const hour of HOURS) {
			for (const state of WORLD_STATES) {
				const a = new RecordingContext();
				const b = new RecordingContext();
				browser.globals.CarbonBitWorld.drawScene(a, frameOf(state, { hour }));
				browser.globals.CarbonBitWorld.drawScene(b, frameOf(state, { hour }));
				assert.deepStrictEqual(a.calls, b.calls, `${state} at ${hour}h`);
				for (const call of a.calls) {
					assert.ok(call.slice(2).every(Number.isInteger), `${state}: ${JSON.stringify(call)}`);
					assert.match(String(call[1]), /^#[0-9a-f]{6}$/, `${state}: colour ${String(call[1])}`);
				}
			}
		}
		const idle = new RecordingContext();
		browser.globals.CarbonBitWorld.drawIdleScene(idle);
		assert.ok(idle.count('fillRect') > 300, 'idle scene paints the full background');
	});

	test('keeps a limited palette: one master palette, swapped by time of day', () => {
		const browser = createBrowser();
		const { PALETTES, PHASES } = browser.globals.CarbonBitScene;
		for (const phase of PHASES) {
			const ctx = new RecordingContext();
			browser.globals.CarbonBitScene.drawBackground(ctx, phase);
			const used = new Set(ctx.calls.map(c => c[1]));
			// Daylight is the master palette; other phases add a tinted copy of the outdoor ramps only.
			assert.ok(used.size <= (phase === 'day' ? 40 : 64), `${phase} background uses ${used.size} colours`);
			const known = new Set(Object.values(PALETTES[phase]));
			for (const color of used) {
				assert.ok(known.has(color as string), `${phase}: ${String(color)} is not in the palette`);
			}
		}
	});

	test('the sky follows the hour: four distinct phases', () => {
		const browser = createBrowser();
		const { phaseOf } = browser.globals.CarbonBitScene;
		assert.deepStrictEqual([5, 6, 7, 12, 17, 18, 19, 20, 23, 0, 4].map(phaseOf),
			['dawn', 'dawn', 'day', 'day', 'day', 'dusk', 'dusk', 'night', 'night', 'night', 'night']);
		assert.strictEqual(phaseOf(Number.NaN), 'day');
		const drawn = HOURS.map(hour => {
			const ctx = new RecordingContext();
			browser.globals.CarbonBitWorld.drawIdleScene(ctx, hour);
			return JSON.stringify(ctx.calls);
		});
		assert.strictEqual(new Set(drawn).size, HOURS.length);
	});

	test('caches the static layer once and blits it with crisp integer scaling', () => {
		const browser = createBrowser();
		const backgroundRects = browser.layer.count('fillRect');
		assert.ok(backgroundRects > 300);
		browser.state('ProcessingHeavy', 2);
		browser.advance(1000);
		assert.strictEqual(browser.layer.count('fillRect'), backgroundRects, 'background is not redrawn per frame');
		assert.strictEqual(browser.main.imageSmoothingEnabled, false);
		assert.strictEqual(browser.canvas.width, 320);
		assert.strictEqual(browser.canvas.height, 180);
		assert.strictEqual(browser.canvas.style.width, '320px', 'the canvas fills its frame');
		assert.ok(browser.main.calls.some(c => c[0] === 'setTransform' && c[1] === 2 && c[4] === 2));
		assert.ok(browser.main.count('fillRect') / browser.frames() < backgroundRects / 4, 'per-frame work is the dynamic layer only');
	});

	test('reads the clock rarely and builds one background per phase', () => {
		const browser = createBrowser({ hour: 12 });
		const day = browser.layer.count('fillRect');
		browser.setHour(23);
		browser.advance(30_000);
		assert.strictEqual(browser.layer.count('fillRect'), day, 'the clock is not read every frame');
		browser.advance(31_000);
		const night = browser.layer.count('fillRect');
		assert.ok(night > day, 'night sky cached after the next clock read');
		browser.advance(120_000);
		assert.strictEqual(browser.layer.count('fillRect'), night);
		browser.setHour(12);
		browser.state('ProcessingLight');
		assert.strictEqual(browser.layer.count('fillRect'), night, 'a phase already shown is reused');
	});

	test('every world state has a distinct treatment, animated and still', () => {
		const browser = createBrowser();
		for (const hour of HOURS) {
			for (const still of [false, true]) {
				const drawn = WORLD_STATES.map(state => JSON.stringify(dynamicCalls(browser, frameOf(state, { still, hour }))));
				assert.strictEqual(new Set(drawn).size, WORLD_STATES.length, `still=${still} hour=${hour}`);
			}
		}
	});

	test('effect density grows with model class and concurrent requests', () => {
		const browser = createBrowser();
		for (const still of [false, true]) {
			const size = (state: string, activeCount = 1) => dynamicCalls(browser, frameOf(state, { activeCount, still, elapsed: 5000 })).length;
			assert.ok(size('ProcessingLight') < size('ProcessingMedium'), `still=${still}`);
			assert.ok(size('ProcessingMedium') < size('ProcessingHeavy'), `still=${still}`);
			assert.ok(size('ProcessingMedium', 1) < size('ProcessingMedium', 3), `still=${still}`);
			assert.ok(size('ProcessingLight') > size('Idle'), `still=${still}`);
		}
	});

	test('failure and completion use restrained indicators and settle back to an identical idle', () => {
		const browser = createBrowser();
		const { P } = browser.globals.CarbonBitScene;
		const { IDLE_SETTLE_MS } = browser.globals.CarbonBitEffects;
		const colors = (frame: Frame) => new Set(dynamicCalls(browser, frame).map(c => c[1]));
		assert.ok(colors(frameOf('Failed')).has(P.warn));
		assert.ok(colors(frameOf('Failed', { still: true })).has(P.warn));
		assert.ok(colors(frameOf('Idle', { prevState: 'Failed', elapsed: 100 })).has(P.warnDim));
		assert.ok(colors(frameOf('ResponseArriving', { elapsed: 1400 })).has(P.done));
		assert.ok(colors(frameOf('ResponseArriving', { still: true })).has(P.done));
		// No red anywhere: failure is amber, never alarming (PRD §56).
		for (const state of WORLD_STATES) {
			for (const color of colors(frameOf(state))) {
				const [r, g] = [parseInt(String(color).slice(1, 3), 16), parseInt(String(color).slice(3, 5), 16)];
				assert.ok(!(r > 200 && g < 90), `${state} uses an alarming red ${String(color)}`);
			}
		}
		// Failure blinks slowly (>= 0.7 s per phase), so it never flashes.
		const lamp = (elapsed: number) => JSON.stringify(dynamicCalls(browser, frameOf('Failed', { elapsed, t: 0 })).filter(c => c[1] === P.warn || c[1] === P.warnDim));
		assert.strictEqual(lamp(1000), lamp(1350));
		for (const hour of HOURS) {
			const calm = JSON.stringify(dynamicCalls(browser, frameOf('Idle', { elapsed: IDLE_SETTLE_MS, hour })));
			for (const prevState of WORLD_STATES) {
				const settled = JSON.stringify(dynamicCalls(browser, frameOf('Idle', { prevState, elapsed: IDLE_SETTLE_MS, hour })));
				assert.strictEqual(settled, calm, `${prevState} at ${hour}h`);
			}
		}
	});

	test('describes every state in calm words for assistive technology', () => {
		const { describeState } = createBrowser().globals.CarbonBitWorld;
		const texts = WORLD_STATES.map(state => describeState(state, 1));
		assert.strictEqual(new Set(texts).size, WORLD_STATES.length);
		for (const text of texts) {
			assert.ok(text.length > 20 && text.length < 160, text);
			assert.ok(!/!|error|warning|danger|alert|bad|waste/i.test(text), text);
		}
		assert.match(describeState('ProcessingHeavy', 3), /3 requests in flight/);
		assert.strictEqual(describeState('Unknown', 0), describeState('Idle', 0));
	});

	test('the canvas label follows the world state', () => {
		const browser = createBrowser({ reducedMotion: true });
		const { describeState } = browser.globals.CarbonBitWorld;
		for (const state of WORLD_STATES) {
			browser.state(state, 2);
			assert.strictEqual(browser.canvas.getAttribute('aria-label'), describeState(state, 2), state);
		}
	});

	test('frame rate respects the configured cap', () => {
		const browser = createBrowser();
		browser.state('ProcessingHeavy', 3);
		for (const [maxFps, min, max] of [[30, 28, 31], [10, 9, 11], [60, 57, 61], [2, 1, 3]]) {
			browser.config(true, maxFps);
			browser.advance(500);
			const before = browser.frames();
			browser.advance(1000);
			const drawn = browser.frames() - before;
			assert.ok(drawn >= min && drawn <= max, `maxFps=${maxFps} drew ${drawn}`);
		}
	});

	test('hidden views stop rendering and resume when visible', () => {
		const browser = createBrowser();
		browser.state('ProcessingMedium');
		browser.advance(200);
		browser.setHidden(true);
		const before = browser.frames();
		browser.state('ProcessingHeavy', 2);
		browser.advance(3000);
		assert.strictEqual(browser.frames(), before);
		assert.strictEqual(browser.pending(), 0, 'no frames or timers stay scheduled while hidden');
		browser.setHidden(false);
		browser.advance(500);
		assert.ok(browser.frames() - before >= 14);
	});

	test('idle settles to about one frame per second without per-vsync polling', () => {
		const browser = createBrowser();
		browser.state('ProcessingLight');
		browser.advance(500);
		browser.state('Idle', 0);
		browser.advance(1000);
		const frames = browser.frames();
		const callbacks = browser.rafCallbacks();
		browser.advance(10_000);
		assert.ok(browser.frames() - frames <= 11, `idle drew ${browser.frames() - frames}`);
		assert.ok(browser.rafCallbacks() - callbacks <= 22, 'idle sleeps on timers between frames');
		const idleFrames = browser.frames();
		browser.state('RequestStarting');
		browser.advance(100);
		assert.ok(browser.frames() - idleFrames >= 3, 'a new request wakes the loop immediately');
	});

	test('disabled animation draws one still frame per change and schedules nothing', () => {
		const browser = createBrowser();
		browser.config(false, 30);
		const before = browser.frames();
		browser.state('ProcessingHeavy', 2);
		assert.strictEqual(browser.frames(), before + 1);
		assert.strictEqual(browser.pending(), 0);
		browser.advance(2000);
		assert.strictEqual(browser.frames(), before + 1);
		browser.config(true, 30);
		browser.advance(1000);
		assert.ok(browser.frames() - before > 20);
	});

	test('prefers-reduced-motion keeps the world still and follows changes', () => {
		const browser = createBrowser({ reducedMotion: true });
		browser.state('ProcessingHeavy', 2);
		browser.advance(2000);
		assert.strictEqual(browser.pending(), 0);
		const still = browser.frames();
		browser.setReducedMotion(false);
		browser.advance(1000);
		assert.ok(browser.frames() - still > 20);
		browser.setReducedMotion(true);
		assert.strictEqual(browser.pending(), 0);
	});

	test('environmental mode adds a calm, static haze under heavy load; neutral mode never does', () => {
		const browser = createBrowser();
		const { P } = browser.globals.CarbonBitScene;
		const haze = (frame: Frame) => dynamicCalls(browser, frame).filter(c => c[1] === P.haze);
		const heavy = (overrides: Partial<Frame>) => frameOf('ProcessingHeavy', { elapsed: 5000, ...overrides });
		assert.ok(haze(heavy({ mode: 'environmental' })).length > 0);
		assert.ok(haze(heavy({ mode: 'environmental', still: true })).length > 0, 'still frames keep the cue');
		assert.strictEqual(haze(heavy({ mode: 'neutral' })).length, 0);
		for (const state of WORLD_STATES.filter(s => s !== 'ProcessingHeavy')) {
			assert.strictEqual(haze(frameOf(state, { mode: 'environmental' })).length, 0, state);
		}
		// No flashing: once faded in, the haze is identical on every frame.
		assert.deepStrictEqual(haze(heavy({ mode: 'environmental', t: 1 })), haze(heavy({ mode: 'environmental', t: 98_765 })));
		assert.ok(haze(heavy({ mode: 'environmental', elapsed: 100 })).length < haze(heavy({ mode: 'environmental' })).length, 'fades in');
		const neutral = dynamicCalls(browser, heavy({ mode: 'neutral' }));
		const environmental = dynamicCalls(browser, heavy({ mode: 'environmental' })).filter(c => c[1] !== P.haze);
		assert.deepStrictEqual(environmental, neutral, 'neutral keeps servers, electricity, cooling and data particles');
	});

	test('minimal mode stops drawing the world and resumes when switched back', () => {
		const browser = createBrowser();
		browser.state('ProcessingHeavy', 2);
		browser.advance(200);
		browser.config(true, 30, 'minimal');
		const before = browser.frames();
		assert.strictEqual(browser.pending(), 0);
		browser.state('ProcessingLight', 1);
		browser.advance(2000);
		assert.strictEqual(browser.frames(), before);
		assert.strictEqual(browser.body.dataset.mode, 'minimal');
		browser.config(true, 30, 'neutral');
		browser.advance(500);
		assert.ok(browser.frames() - before >= 14);
		assert.strictEqual(browser.body.dataset.mode, 'neutral');
	});
});
