// Pixel-world renderer. The static background is cached once per time-of-day phase at logical
// resolution; each frame blits it with nearest-neighbour integer scaling and draws the dynamic
// layer on top. Frames come from requestAnimationFrame, capped at maxFps and stopped while hidden,
// still or idle (idle only wakes about once a second for drifting clouds and the odd keystroke).
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
	// The sky follows local time; the clock is read at most once a minute while animating.
	const CLOCK_MS = 60_000;
	const DEFAULT_HOUR = 12;

	const DESCRIPTIONS = Object.freeze({
		Idle: 'Pixel world, idle: a developer works at a desk; across the meadow the data center is quiet.',
		RequestStarting: 'Pixel world: a request leaves the desk and travels along the wire to the data center.',
		ProcessingLight: 'Pixel world: the data center is working on a light request; a few servers are lit.',
		ProcessingMedium: 'Pixel world: the data center is working on a medium request; more servers, cooling and power are active.',
		ProcessingHeavy: 'Pixel world: the data center is working on a heavy request; all servers, the cooling and the power line are busy.',
		ResponseArriving: 'Pixel world: the response travels back to the desk.',
		Failed: 'Pixel world: the request did not complete; the data center shows an amber status light.',
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

	function drawScene(ctx, frame, background) {
		if (background) {
			ctx.drawImage(background, 0, 0);
		} else {
			Scene.drawBackground(ctx, Scene.phaseOf(frame.hour));
		}
		Effects.drawDynamic(ctx, frame);
	}

	function stillFrame(state, mode, hour) {
		return {
			state,
			prevState: state,
			elapsed: Effects.STILL_ELAPSED[state],
			t: 0,
			level: 1,
			activeCount: 0,
			still: true,
			mode: mode || DEFAULT_CONFIG.visualMode,
			hour: typeof hour === 'number' ? hour : DEFAULT_HOUR,
		};
	}

	function drawIdleScene(ctx, hour) {
		drawScene(ctx, stillFrame('Idle', DEFAULT_CONFIG.visualMode, hour));
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

	function createBackgroundLayer(phase) {
		const layer = document.createElement('canvas');
		layer.width = WIDTH;
		layer.height = HEIGHT;
		const layerCtx = layer.getContext('2d');
		if (!layerCtx) {
			return null;
		}
		Scene.drawBackground(layerCtx, phase);
		return layer;
	}

	function localHour() {
		const date = new Date();
		return date.getHours() + date.getMinutes() / 60;
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
		// One cached layer per time-of-day phase, built the first time that phase is shown.
		const backgrounds = new Map();
		let hour = localHour();
		let clockReadAt = now();

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
				hour = localHour();
			}
		}

		function backgroundFor(phase) {
			if (!backgrounds.has(phase)) {
				backgrounds.set(phase, createBackgroundLayer(phase));
			}
			return backgrounds.get(phase);
		}

		function frameAt(time) {
			if (!animated()) {
				return { ...stillFrame(state, config.visualMode, hour), prevState, level, activeCount };
			}
			return { state, prevState, elapsed: Math.max(0, time - since), t: time, level, activeCount, still: false, mode: config.visualMode, hour };
		}

		function paint(time) {
			if (sized) {
				readClock(time, false);
				drawScene(ctx, frameAt(time), backgroundFor(Scene.phaseOf(hour)));
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

	window.CarbonBitWorld = Object.freeze({ WIDTH, HEIGHT, drawScene, drawIdleScene, createFrameScheduler, mountWorld, describeState });
})();
