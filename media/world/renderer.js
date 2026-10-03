// Pixel-world renderer for "Pale Blue Pixel". Two layers are cached at logical resolution: space
// (drawn once) and the globe (redrawn only when the sun or the clouds have moved, every few seconds).
// Each frame blits them with nearest-neighbour integer scaling and draws the moving layer on top.
// Frames come from requestAnimationFrame, capped at maxFps and stopped while hidden, still or
// idle (idle only wakes about once a second for twinkling stars, clouds and the odd satellite).
(function () {
	'use strict';

	const Scene = window.CarbonBitScene;
	const Effects = window.CarbonBitEffects;
	const { WIDTH, HEIGHT } = Scene;

	const MIN_FPS = 1;
	const MAX_FPS = 60;
	const DEFAULT_CONFIG = Object.freeze({ animationEnabled: true, maxFps: 30, visualMode: 'environmental' });
	const VISUAL_MODES = ['environmental', 'neutral', 'minimal'];
	const IDLE_FRAME_MS = 1000;
	// Longer waits sleep on a timer so no animation frame wakes up only to be skipped.
	const TIMER_THRESHOLD_MS = 20;
	const TIMER_LEAD_MS = 10;
	// Day and night follow the wall clock, read at most once a minute and extrapolated in between.
	const CLOCK_MS = 60_000;
	// Southern-hemisphere timezones, so the marker sits on the right half of the planet.
	const SOUTHERN_ZONES = /^(Australia|Antarctica)\/|^Pacific\/(Auckland|Chatham|Fiji|Tongatapu)|^America\/(Sao_Paulo|Argentina|Buenos_Aires|Santiago|Montevideo|Asuncion|Lima|La_Paz)|^Africa\/(Johannesburg|Maputo|Harare|Windhoek|Lusaka|Gaborone)|^Indian\/(Mauritius|Reunion|Antananarivo)/;

	const DESCRIPTIONS = Object.freeze({
		Idle: 'Pixel planet, idle: the Earth from space with drifting clouds; your place is marked and the data center is quiet.',
		RequestStarting: 'Pixel planet: a request leaves your place and arcs over the Earth toward a data center.',
		ProcessingLight: 'Pixel planet: the data center works on a light request; a small glow and a little cooling vapour.',
		ProcessingMedium: 'Pixel planet: the data center works on a medium request; a steady glow and more cooling vapour.',
		ProcessingHeavy: 'Pixel planet: the data center works on a heavy request; its power glow and cooling vapour are at their busiest.',
		ResponseArriving: 'Pixel planet: the reply arcs back over the Earth to your place.',
		Failed: 'Pixel planet: the request did not complete; the data center shows an amber light.',
	});

	// Short, calm text alternative for the canvas (role=img).
	function describeState(state, activeCount) {
		const text = Object.prototype.hasOwnProperty.call(DESCRIPTIONS, state) ? DESCRIPTIONS[state] : DESCRIPTIONS.Idle;
		const count = Number.isInteger(activeCount) ? activeCount : 0;
		return count > 1 && state !== 'Idle' ? `${text} ${count} requests in flight.` : text;
	}

	function clampFps(value) {
		return typeof value === 'number' && Number.isFinite(value)
			? Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(value)))
			: DEFAULT_CONFIG.maxFps;
	}

	// Without cached layers (tests, first paint) everything is drawn directly.
	function drawScene(ctx, frame, layers) {
		if (layers && layers.background) {
			ctx.drawImage(layers.background, 0, 0);
		} else {
			Scene.drawBackground(ctx);
		}
		if (layers && layers.globe) {
			ctx.drawImage(layers.globe, 0, 0);
		} else {
			Scene.drawGlobe(ctx, frame.epoch, frame.place);
		}
		Effects.drawDynamic(ctx, frame);
	}

	function stillFrame(state, mode, epoch, place) {
		return {
			state,
			prevState: state,
			elapsed: Effects.STILL_ELAPSED[state],
			t: 0,
			level: 1,
			activeCount: 0,
			still: true,
			mode: mode || DEFAULT_CONFIG.visualMode,
			epoch: typeof epoch === 'number' ? epoch : 0,
			place: place || Scene.DEFAULT_PLACE,
		};
	}

	function drawIdleScene(ctx, epoch, place) {
		drawScene(ctx, stillFrame('Idle', DEFAULT_CONFIG.visualMode, epoch, place));
	}

	// onFrame(now) draws and returns the minimum gap in ms before the next frame, or null to stop.
	function createFrameScheduler(env, onFrame) {
		let maxFps = DEFAULT_CONFIG.maxFps;
		let running = false;
		let frameId = 0;
		let timerId = 0;
		let lastFrame = -Infinity;
		let minGap = 0;

		function cancel() {
			if (frameId) {
				env.cancelAnimationFrame(frameId);
				frameId = 0;
			}
			if (timerId) {
				env.clearTimeout(timerId);
				timerId = 0;
			}
		}

		function request(delay) {
			cancel();
			if (delay > TIMER_THRESHOLD_MS) {
				timerId = env.setTimeout(() => {
					timerId = 0;
					frameId = env.requestAnimationFrame(tick);
				}, delay - TIMER_LEAD_MS);
			} else {
				frameId = env.requestAnimationFrame(tick);
			}
		}

		function tick(now) {
			frameId = 0;
			if (!running) {
				return;
			}
			const gap = Math.max(minGap, 1000 / maxFps);
			// 1 ms tolerance absorbs vsync jitter without ever exceeding the cap meaningfully.
			if (now - lastFrame < gap - 1) {
				request(gap - (now - lastFrame));
				return;
			}
			lastFrame = now;
			const next = onFrame(now);
			if (next === null) {
				running = false;
				return;
			}
			minGap = next;
			request(Math.max(next, 1000 / maxFps));
		}

		return Object.freeze({
			setMaxFps(fps) {
				maxFps = clampFps(fps);
			},
			wake() {
				running = true;
				minGap = 0;
				if (!frameId || timerId) {
					request(0);
				}
			},
			stop() {
				running = false;
				cancel();
			},
			isRunning: () => running,
		});
	}

	function createLayer(draw) {
		const layer = document.createElement('canvas');
		layer.width = WIDTH;
		layer.height = HEIGHT;
		const layerCtx = layer.getContext('2d');
		if (!layerCtx) {
			return null;
		}
		draw(layerCtx);
		return { canvas: layer, ctx: layerCtx };
	}

	// The viewer's approximate place: longitude from the UTC offset, hemisphere from the zone name.
	// Used only to draw the marker; it never leaves the webview.
	function localPlace() {
		const date = new Date();
		let zone = '';
		try {
			zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
		} catch {
			// The marker falls back to the northern hemisphere.
		}
		return { lon: -date.getTimezoneOffset() / 4, south: SOUTHERN_ZONES.test(zone) };
	}

	// Mounts the world on a canvas and returns a controller fed by sidebar.js.
	function mountWorld(canvas) {
		const frameEl = canvas.parentElement;
		const ctx = canvas.getContext('2d');
		if (!frameEl || !ctx) {
			return Object.freeze({ setWorld() {}, setConfig() {} });
		}

		const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
		let reducedMotion = Boolean(motionQuery && motionQuery.matches);
		let config = DEFAULT_CONFIG;
		let state = 'Idle';
		let prevState = 'Idle';
		let since = now();
		let level = 1;
		let activeCount = 0;
		let sized = false;
		const place = localPlace();
		let clockEpoch = new Date().getTime();
		let clockReadAt = now();
		let background = null;
		let globe = null;
		let globeKey = null;

		const scheduler = createFrameScheduler(window, renderFrame);

		function now() {
			return window.performance.now();
		}

		function animated() {
			return config.animationEnabled && !reducedMotion && config.visualMode !== 'minimal';
		}

		function readClock(time, force) {
			if (force || time - clockReadAt >= CLOCK_MS) {
				clockReadAt = time;
				clockEpoch = new Date().getTime();
			}
		}

		function epochAt(time) {
			return clockEpoch + Math.max(0, time - clockReadAt);
		}

		function layersFor(epoch) {
			background = background || createLayer(layerCtx => Scene.drawBackground(layerCtx));
			const key = Scene.globeKey(epoch);
			if (key !== globeKey) {
				globeKey = key;
				if (globe) {
					globe.ctx.clearRect(0, 0, WIDTH, HEIGHT);
					Scene.drawGlobe(globe.ctx, epoch, place);
				} else {
					globe = createLayer(layerCtx => Scene.drawGlobe(layerCtx, epoch, place));
				}
			}
			return { background: background && background.canvas, globe: globe && globe.canvas };
		}

		function frameAt(time) {
			const epoch = epochAt(time);
			if (!animated()) {
				return { ...stillFrame(state, config.visualMode, epoch, place), prevState, level, activeCount };
			}
			return { state, prevState, elapsed: Math.max(0, time - since), t: time, level, activeCount, still: false, mode: config.visualMode, epoch, place };
		}

		function paint(time) {
			if (sized) {
				readClock(time, false);
				const frame = frameAt(time);
				drawScene(ctx, frame, layersFor(frame.epoch));
			}
		}

		function renderFrame(time) {
			paint(time);
			if (!animated()) {
				return null;
			}
			return Effects.isSettled(frameAt(time)) ? IDLE_FRAME_MS : 0;
		}

		function refresh() {
			// Minimal mode hides the world, so it is not drawn at all.
			if (document.hidden || config.visualMode === 'minimal') {
				scheduler.stop();
				return;
			}
			readClock(now(), true);
			if (animated()) {
				scheduler.wake();
			} else {
				scheduler.stop();
				paint(now());
			}
		}

		// Backing store = largest integer multiple of the logical grid that fits, in device pixels.
		function resize() {
			if (frameEl.clientWidth === 0 || frameEl.clientHeight === 0) {
				return;
			}
			const dpr = window.devicePixelRatio || 1;
			const fit = Math.min(
				Math.floor((frameEl.clientWidth * dpr) / WIDTH),
				Math.floor((frameEl.clientHeight * dpr) / HEIGHT),
			);
			const scale = Math.max(1, fit);
			canvas.width = WIDTH * scale;
			canvas.height = HEIGHT * scale;
			// The integer backing store keeps every art pixel; CSS then fills the frame with nearest-neighbour
			// upscaling, so a narrow sidebar on a 1x screen shows a full-width world instead of a small stamp.
			canvas.style.width = `${Math.floor(Math.min(frameEl.clientWidth, (frameEl.clientHeight * WIDTH) / HEIGHT))}px`;
			ctx.setTransform(scale, 0, 0, scale, 0, 0);
			ctx.imageSmoothingEnabled = false;
			sized = true;
			if (!document.hidden && config.visualMode !== 'minimal') {
				paint(now());
			}
		}

		function watchPixelRatio() {
			window
				.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
				.addEventListener('change', () => {
					resize();
					watchPixelRatio();
				}, { once: true });
		}

		new ResizeObserver(resize).observe(frameEl);
		watchPixelRatio();
		document.addEventListener('visibilitychange', refresh);
		if (motionQuery) {
			motionQuery.addEventListener('change', (event) => {
				reducedMotion = event.matches;
				refresh();
			});
		}
		resize();
		refresh();

		return Object.freeze({
			setWorld(nextState, nextActiveCount) {
				if (!Effects.WORLD_STATES.includes(nextState)) {
					return;
				}
				activeCount = Number.isInteger(nextActiveCount) && nextActiveCount > 0 ? nextActiveCount : 0;
				if (nextState !== state) {
					prevState = state;
					state = nextState;
					since = now();
					if (state === 'RequestStarting') {
						level = 1;
					}
				}
				level = Effects.LOAD_LEVEL[state] || level;
				refresh();
			},
			setConfig(next) {
				config = Object.freeze({
					animationEnabled: typeof next.animationEnabled === 'boolean' ? next.animationEnabled : DEFAULT_CONFIG.animationEnabled,
					maxFps: clampFps(next.maxFps),
					visualMode: VISUAL_MODES.includes(next.visualMode) ? next.visualMode : DEFAULT_CONFIG.visualMode,
				});
				scheduler.setMaxFps(config.maxFps);
				refresh();
			},
		});
	}

	window.CarbonBitWorld = Object.freeze({ WIDTH, HEIGHT, drawScene, drawIdleScene, createFrameScheduler, mountWorld, describeState, localPlace });
})();
