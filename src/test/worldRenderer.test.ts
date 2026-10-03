import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { WORLD_STATES } from '../core/messages/protocol';
import { createBrowser, dynamicCalls, EPOCH, type Frame, frameOf, RecordingContext, root, WORLD_SCRIPTS } from './fakeBrowser';

const HOUR = 3_600_000;
const PLACES = [{ lon: 30, south: false }, { lon: -75, south: false }, { lon: 151, south: true }];

suite('Pixel world renderer', () => {
	test('world scripts are self-contained primitives with no external assets', () => {
		for (const file of WORLD_SCRIPTS) {
			const source = fs.readFileSync(path.join(root, file), 'utf8');
			assert.ok(!/https?:|url\(|new Image|fetch\(|XMLHttpRequest|import\(|eval\(|new Function/.test(source), file);
		}
	});

	test('draws the whole scene deterministically on integer pixels, for every state, place and hour', () => {
		const browser = createBrowser();
		for (const place of PLACES) {
			for (const epoch of [EPOCH, EPOCH + 9 * HOUR]) {
				for (const state of WORLD_STATES) {
					const a = new RecordingContext();
					const b = new RecordingContext();
					browser.globals.CarbonBitWorld.drawScene(a, frameOf(state, { epoch, place }));
					browser.globals.CarbonBitWorld.drawScene(b, frameOf(state, { epoch, place }));
					assert.deepStrictEqual(a.calls, b.calls, `${state} at ${place.lon}`);
					for (const call of a.calls) {
						assert.ok(call.slice(2).every(Number.isInteger), `${state}: ${JSON.stringify(call)}`);
						assert.match(String(call[1]), /^#[0-9a-f]{6}$/, `${state}: colour ${String(call[1])}`);
						const [x, y] = call.slice(2) as number[];
						assert.ok(x >= -8 && x < 168 && y >= -2 && y < 92, `${state}: off-canvas ${JSON.stringify(call)}`);
					}
				}
			}
		}
		const idle = new RecordingContext();
		browser.globals.CarbonBitWorld.drawIdleScene(idle, EPOCH);
		assert.ok(idle.count('fillRect') > 1000, 'the idle scene paints space, stars and the whole planet');
	});

	test('keeps a limited 16-bit palette with no red anywhere', () => {
		const browser = createBrowser();
		const used = new Set<string>();
		for (const state of WORLD_STATES) {
			for (const still of [false, true]) {
				const ctx = new RecordingContext();
				browser.globals.CarbonBitWorld.drawScene(ctx, frameOf(state, { still, activeCount: 3, elapsed: 5000 }));
				ctx.calls.forEach(c => used.add(String(c[1])));
			}
		}
		assert.ok(used.size <= 64, `uses ${used.size} colours`);
		const { P } = browser.globals.CarbonBitScene;
		const { C } = browser.globals.CarbonBitEffects;
		for (const color of used) {
			assert.ok(Object.values(P).includes(color) || Object.values(C).includes(color), `${color} is not in the palette`);
			const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
			assert.ok(!(r > 180 && g < 110 && b < 110), `${color} reads as an alarming red`);
		}
	});

	test('the planet shows real day and night, recognisable continents and the moon phase', () => {
		const browser = createBrowser();
		const { sunAt, moonPhaseAt, MAP, cellIndex } = browser.globals.CarbonBitScene;
		// Around the September equinox the sun is over the equator, at the longitude where it is noon.
		const sun = sunAt(Date.UTC(2026, 8, 22, 12));
		assert.ok(Math.abs(sun.lat) < 2 && Math.abs(sun.lon) < 1, JSON.stringify(sun));
		assert.ok(sunAt(Date.UTC(2026, 5, 21, 12)).lat > 23, 'June solstice: sun over the Tropic of Cancer');
		assert.ok(Math.abs(sunAt(Date.UTC(2026, 8, 22, 18)).lon + 90) < 1, '18:00 UTC: noon at 90° W');
		// A known full moon (2026-03-03) and new moon (2026-03-19).
		assert.ok(Math.abs(moonPhaseAt(Date.UTC(2026, 2, 3, 12)) - 0.5) < 0.05);
		assert.ok(Math.min(moonPhaseAt(Date.UTC(2026, 2, 19, 2)), 1 - moonPhaseAt(Date.UTC(2026, 2, 19, 2))) < 0.05);
		const land = (lon: number, lat: number) => MAP[cellIndex(lon, lat)] >= 2;
		for (const [lon, lat, name] of [[2, 47, 'France'], [20, 0, 'Congo'], [-100, 40, 'USA'], [-60, -10, 'Brazil'], [135, -25, 'Australia'], [80, 22, 'India']] as const) {
			assert.ok(land(lon, lat), `${name} is land`);
		}
		for (const [lon, lat, name] of [[-30, 30, 'Atlantic'], [-150, 0, 'Pacific'], [75, -20, 'Indian Ocean'], [5, 38, 'Mediterranean']] as const) {
			assert.ok(!land(lon, lat), `${name} is sea`);
		}
		// Over one day the visible face swings between mostly day and mostly night, with city lights. (Seen
		// from mid-northern latitudes in October, part of the face stays dark even at noon, as it should.)
		const { P, drawGlobe } = browser.globals.CarbonBitScene;
		const night = [P.oceanNight, P.landNight, P.desertNight, P.iceNight, P.cloudNight, P.city];
		const shares = Array.from({ length: 24 }, (_, hour) => {
			const ctx = new RecordingContext();
			drawGlobe(ctx, Date.UTC(2026, 9, 3, hour), PLACES[0]);
			const width = (colors?: string[]) => ctx.calls.filter(c => c[0] === 'fillRect' && (!colors || colors.includes(String(c[1])))).reduce((n, c) => n + Number(c[4]), 0);
			return { night: width(night) / width(), city: width([P.city]) };
		});
		const nights = shares.map(s => s.night);
		assert.ok(Math.min(...nights) < 0.35, 'some hour shows the face mostly in daylight');
		assert.ok(Math.max(...nights) > 0.65, 'some hour shows the face mostly at night');
		assert.ok(Math.max(...nights) - Math.min(...nights) > 0.3, 'the terminator sweeps across the face');
		assert.ok(shares.some(s => s.night > 0.5 && s.city > 0), 'city lights on the night side');
	});

	test('your place comes from the timezone and sits on the planet, a good arc away from a data-center region', () => {
		for (const [offsetMinutes, timeZone, lon, south] of [[-120, 'Europe/Rome', 30, false], [300, 'America/New_York', -75, false], [-600, 'Australia/Sydney', 150, true]] as const) {
			const browser = createBrowser({ offsetMinutes, timeZone });
			assert.deepStrictEqual({ ...browser.globals.CarbonBitWorld.localPlace() }, { lon, south });
			const { CX, CY, R, geometry } = browser.globals.CarbonBitScene;
			const geo = geometry({ lon, south });
			for (const point of [geo.you, geo.hub]) {
				assert.ok((point.x + 0.5 - CX) ** 2 + (point.y + 0.5 - CY) ** 2 < R * R, `${timeZone}: marker on the disk`);
			}
			assert.ok(Math.hypot(geo.hub.x - geo.you.x, geo.hub.y - geo.you.y) > 25, `${timeZone}: the data center is far enough for a visible arc`);
			const apex = Math.min(...geo.arc.map(p => p.y));
			assert.ok(apex < Math.min(geo.you.y, geo.hub.y) - 8, `${timeZone}: the request arcs over the planet`);
		}
	});

	test('caches space once and the globe only when it changes, and blits them with crisp integer scaling', () => {
		const browser = createBrowser();
		browser.state('ProcessingHeavy', 2);
		browser.advance(1000);
		const [space, globe] = browser.layers;
		const spaceRects = space.count('fillRect');
		const globeRects = globe.count('fillRect');
		assert.ok(spaceRects > 50 && globeRects > 500);
		browser.advance(1500);
		assert.strictEqual(space.count('fillRect'), spaceRects, 'space is never redrawn');
		assert.strictEqual(globe.count('fillRect'), globeRects, 'the globe is not redrawn per frame');
		assert.strictEqual(browser.layers.length, 2);
		assert.strictEqual(browser.main.imageSmoothingEnabled, false);
		assert.strictEqual(browser.canvas.width, 320);
		assert.strictEqual(browser.canvas.height, 180);
		assert.strictEqual(browser.canvas.style.width, '320px', 'the canvas fills its frame');
		assert.ok(browser.main.calls.some(c => c[0] === 'setTransform' && c[1] === 2 && c[4] === 2));
		const perFrame = browser.main.count('fillRect') / browser.frames();
		assert.ok(perFrame < globeRects / 2 && perFrame < 500, `per-frame work is the moving layer only (${perFrame} rects vs ${globeRects} for the globe)`);
	});

	test('clouds drift and the terminator moves: the globe is redrawn every few seconds, not every frame', () => {
		const browser = createBrowser();
		browser.state('Idle', 0);
		browser.advance(2000);
		const globe = browser.layers[1];
		const before = globe.count('clearRect');
		browser.advance(20_000);
		const redraws = globe.count('clearRect') - before;
		const step = browser.globals.CarbonBitScene.GLOBE_STEP_MS;
		assert.ok(redraws >= Math.floor(20_000 / step) - 1 && redraws <= Math.ceil(20_000 / step) + 1, `${redraws} redraws in 20 s`);
		const a = new RecordingContext();
		const b = new RecordingContext();
		browser.globals.CarbonBitScene.drawGlobe(a, EPOCH, PLACES[0]);
		browser.globals.CarbonBitScene.drawGlobe(b, EPOCH + 60_000, PLACES[0]);
		assert.notDeepStrictEqual(a.calls, b.calls, 'a minute later the clouds have moved');
	});

	test('reads the wall clock rarely and follows it between reads', () => {
		const browser = createBrowser();
		browser.state('ProcessingMedium', 1);
		const reads = browser.clockReads();
		browser.advance(30_000);
		assert.ok(browser.clockReads() - reads <= 1, `read the clock ${browser.clockReads() - reads} times in 30 s`);
	});

	test('every world state has a distinct treatment, animated and still', () => {
		const browser = createBrowser();
		for (const still of [false, true]) {
			const drawn = WORLD_STATES.map(state => JSON.stringify(dynamicCalls(browser, frameOf(state, { still }))));
			assert.strictEqual(new Set(drawn).size, WORLD_STATES.length, `still=${still}`);
		}
	});

	test('effect density grows with model class and concurrent requests', () => {
		const browser = createBrowser();
		const size = (state: string, activeCount = 1) => dynamicCalls(browser, frameOf(state, { activeCount, mode: 'neutral' })).length;
		assert.ok(size('ProcessingLight') < size('ProcessingMedium'));
		assert.ok(size('ProcessingMedium') < size('ProcessingHeavy'));
		assert.ok(size('ProcessingMedium', 1) < size('ProcessingMedium', 3));
		assert.ok(size('ProcessingLight') > size('Idle'));
	});

	test('a request leaves your place, work shows at the data center, and the reply comes home in green', () => {
		const browser = createBrowser();
		const { C } = browser.globals.CarbonBitEffects;
		const geo = browser.globals.CarbonBitScene.geometry();
		const near = (calls: unknown[][], color: string, point: { x: number; y: number }, radius: number) =>
			calls.some(c => c[1] === color && Math.abs(Number(c[2]) - point.x) <= radius && Math.abs(Number(c[3]) - point.y) <= radius);
		const starting = dynamicCalls(browser, frameOf('RequestStarting', { elapsed: 100 }));
		assert.ok(near(starting, C.request, geo.you, 4), 'the request starts at your place');
		const heavy = dynamicCalls(browser, frameOf('ProcessingHeavy'));
		assert.ok(near(heavy, C.power, geo.hub, 10), 'power glows around the data center');
		assert.ok(near(heavy, C.vapour, geo.hub, 16), 'cooling vapour rises from the data center');
		const reply = dynamicCalls(browser, frameOf('ResponseArriving', { elapsed: 1250 }));
		assert.ok(near(reply, C.reply, geo.you, 6), 'the reply lands at your place');
	});

	test('failure and completion use restrained indicators and settle back to an identical idle', () => {
		const browser = createBrowser();
		const { C, IDLE_SETTLE_MS } = browser.globals.CarbonBitEffects;
		const colors = (frame: Frame) => new Set(dynamicCalls(browser, frame).map(c => c[1]));
		assert.ok(colors(frameOf('Failed', { elapsed: 100 })).has(C.warn));
		assert.ok(colors(frameOf('Failed', { elapsed: 800 })).has(C.warnDim), 'a slow blink, not a flash');
		assert.ok(colors(frameOf('Idle', { prevState: 'Failed', elapsed: 100 })).has(C.warnDim));
		assert.ok(colors(frameOf('ResponseArriving', { elapsed: 1250 })).has(C.reply));
		const calm = JSON.stringify(dynamicCalls(browser, frameOf('Idle', { elapsed: IDLE_SETTLE_MS })));
		for (const prevState of ['Failed', 'ResponseArriving', 'ProcessingHeavy']) {
			assert.strictEqual(JSON.stringify(dynamicCalls(browser, frameOf('Idle', { prevState, elapsed: IDLE_SETTLE_MS }))), calm, prevState);
		}
	});

	test('idle stays alive: stars twinkle and a satellite passes now and then', () => {
		const browser = createBrowser();
		const idle = (t: number) => JSON.stringify(dynamicCalls(browser, frameOf('Idle', { elapsed: 5000, t })));
		const distinct = new Set([0, 1000, 2000, 3000, 4000, 5000, 20_000].map(idle));
		assert.ok(distinct.size >= 3, 'idle frames vary over time');
		assert.strictEqual(JSON.stringify(dynamicCalls(browser, frameOf('Idle', { elapsed: 5000, still: true, t: 0 }))),
			JSON.stringify(dynamicCalls(browser, frameOf('Idle', { elapsed: 5000, still: true, t: 99_999 }))), 'still frames never move');
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
		browser.advance(1500);
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

	test('environmental mode tints the atmosphere calmly under heavy load; neutral mode never does', () => {
		const browser = createBrowser();
		const { C } = browser.globals.CarbonBitEffects;
		const haze = (frame: Frame) => dynamicCalls(browser, frame).filter(c => c[1] === C.haze || c[1] === C.hazeDim);
		const heavy = (overrides: Partial<Frame>) => frameOf('ProcessingHeavy', { elapsed: 5000, ...overrides });
		assert.ok(haze(heavy({ mode: 'environmental' })).length > 0);
		assert.ok(haze(heavy({ mode: 'environmental', still: true })).length > 0, 'still frames keep the cue');
		assert.strictEqual(haze(heavy({ mode: 'neutral' })).length, 0);
		for (const state of WORLD_STATES.filter(s => s !== 'ProcessingHeavy')) {
			assert.strictEqual(haze(frameOf(state, { mode: 'environmental' })).length, 0, state);
		}
		// No flashing: once faded in, the tint is identical on every frame.
		assert.deepStrictEqual(haze(heavy({ mode: 'environmental', t: 1 })), haze(heavy({ mode: 'environmental', t: 98_765 })));
		assert.ok(haze(heavy({ mode: 'environmental', elapsed: 100 })).length < haze(heavy({ mode: 'environmental' })).length, 'fades in');
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

	test('describes every state calmly and the canvas label follows the world', () => {
		const browser = createBrowser();
		const { describeState } = browser.globals.CarbonBitWorld;
		const texts = WORLD_STATES.map(state => describeState(state, 1));
		assert.strictEqual(new Set(texts).size, WORLD_STATES.length);
		for (const text of texts) {
			assert.ok(/^Pixel planet/.test(text) && text.length < 200, text);
			assert.ok(!/(guilt|bad|danger|alarm|warning|destroy|pollut)/i.test(text), text);
		}
		assert.match(describeState('ProcessingHeavy', 3), /3 requests in flight\.$/);
		assert.strictEqual(describeState('Sleeping', 0), describeState('Idle', 0));
		browser.state('ResponseArriving', 1);
		assert.strictEqual(browser.canvas.getAttribute('aria-label'), describeState('ResponseArriving', 1));
	});
});
