// "Pale Blue Pixel": the moving layer. A request is light that leaves your place on the planet and
// arcs over the curve of the Earth to a data center; the hub glows with the work and vents cooling
// vapour; the reply comes home in green. Every frame is a pure function of the frame object.
(function () {
	'use strict';

	const S = window.CarbonBitScene;
	const P = S.P;

	const WORLD_STATES = Object.freeze(['Idle', 'RequestStarting', 'ProcessingLight', 'ProcessingMedium', 'ProcessingHeavy', 'ResponseArriving', 'Failed']);
	const LOAD_LEVEL = Object.freeze({ ProcessingLight: 1, ProcessingMedium: 2, ProcessingHeavy: 3 });

	// Signal colours carry one meaning each: cyan request, green reply, gold power, amber attention.
	const C = Object.freeze({
		request: '#9cf0ff', requestDim: '#4cc3e6', core: '#ffffff', shadow: '#0b1530', reply: '#93f2a6', replyDim: '#3d9c5b',
		power: '#ffd75e', powerDim: '#a8862f', warn: '#f2b84b', warnDim: '#7d5f2a',
		hub: '#59647a', hubDark: '#2b3245', hubLit: '#c4ecff', you: '#ffffff', youDim: '#9fb4d6',
		vapour: '#e3ebf3', vapourDim: '#8797ad', haze: '#a28a6e', hazeDim: '#6b5c4b', satellite: '#c9d2e0', panel: '#4f7fc0',
	});

	const IDLE_SETTLE_MS = 900;
	const STARTING_MS = 800;
	const RESPONSE_MS = 1300;
	const PACKET_MS = [0, 1500, 1050, 750];
	const VAPOUR_MS = [0, 2600, 2100, 1700];
	const HAZE_FADE_MS = 1500;
	const SATELLITE_MS = 90_000;
	const BEACON_MS = 4000;
	const STILL_ELAPSED = Object.freeze({
		Idle: IDLE_SETTLE_MS, RequestStarting: STARTING_MS, ProcessingLight: 5000, ProcessingMedium: 5000,
		ProcessingHeavy: 5000, ResponseArriving: 1000, Failed: 300,
	});

	function isProcessing(state) {
		return Object.prototype.hasOwnProperty.call(LOAD_LEVEL, state);
	}

	// More concurrent requests mean more light on the arc, up to four streams.
	function density(frame) {
		const level = isProcessing(frame.state) ? LOAD_LEVEL[frame.state] : 1;
		return Math.min(4, Math.max(level, frame.activeCount || 0));
	}

	function isSettled(frame) {
		return frame.state === 'Idle' && frame.elapsed >= IDLE_SETTLE_MS;
	}

	function px(ctx, color, x, y, w, h) {
		ctx.fillStyle = color;
		ctx.fillRect(x, y, w || 1, h || 1);
	}

	function arcPoint(geo, u) {
		const arc = geo.arc;
		return arc[Math.max(0, Math.min(arc.length - 1, Math.round(u * (arc.length - 1))))];
	}

	// The path over the planet, revealed from `from` to `to` (0..1), with a dark shadow so it
	// reads over land, ocean and clouds alike.
	function drawTrace(ctx, geo, color, from, to) {
		const arc = geo.arc;
		const first = Math.round(from * (arc.length - 1));
		const last = Math.round(to * (arc.length - 1));
		for (let i = first; i <= last; i++) {
			px(ctx, C.shadow, arc[i].x, arc[i].y - 1, 1, 3);
		}
		for (let i = first; i <= last; i++) {
			px(ctx, color, arc[i].x, arc[i].y);
		}
	}

	function drawPacket(ctx, geo, u, color, dim, backwards) {
		const head = arcPoint(geo, u);
		const tail = arcPoint(geo, backwards ? Math.min(1, u + 0.07) : Math.max(0, u - 0.07));
		px(ctx, dim, tail.x, tail.y, 2, 2);
		px(ctx, C.shadow, head.x - 1, head.y - 1, 4, 4);
		px(ctx, color, head.x, head.y, 2, 2);
		px(ctx, C.core, head.x, head.y, 1, 1);
	}

	// You: a map pin whose tip marks your place; its head lights up when something happens.
	const PIN = ['.ooo.', 'ohhho', 'ohhho', '.oho.', '..o..'];
	function drawYou(ctx, geo, color, ring) {
		const { x, y } = geo.you;
		const top = y - PIN.length + 1;
		PIN.forEach((row, dy) => {
			for (let dx = 0; dx < row.length; dx++) {
				if (row[dx] !== '.') {
					px(ctx, row[dx] === 'o' ? C.shadow : ring || color, x - 2 + dx, top + dy);
				}
			}
		});
		px(ctx, color, x, top + 1);
	}

	// A thin circle of light, e.g. where a reply lands.
	function drawRing(ctx, x, y, radius, color) {
		for (let i = 0; i < 16; i++) {
			const a = (i / 16) * Math.PI * 2;
			px(ctx, color, Math.round(x + 0.5 + Math.cos(a) * radius), Math.round(y + 0.5 + Math.sin(a) * radius));
		}
	}

	// The data center: a small hall with a roof line and up to three lit windows.
	function drawHub(ctx, geo, lit, light) {
		const { x, y } = geo.hub;
		px(ctx, C.shadow, x - 4, y - 3, 9, 6);
		px(ctx, C.hub, x - 3, y - 2, 7, 1);
		px(ctx, C.hubDark, x - 3, y - 1, 7, 3);
		for (let i = 0; i < 3; i++) {
			px(ctx, i < lit ? light : C.hub, x - 2 + i * 2, y, 1, 1);
		}
	}

	// Power: light spilling around the hub, dithered thinner with distance; wider with load.
	function drawGlow(ctx, geo, radius, inner, outer) {
		const { x, y } = geo.hub;
		const runs = S.createRuns(ctx);
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const d = Math.sqrt(dx * dx + dy * dy) / radius;
				// The hall itself (and its shadow) stays readable.
				if (d > 1 || (Math.abs(dx) <= 4 && dy >= -3 && dy <= 2)) {
					continue;
				}
				if (1 - d > S.bayer(x + dx, y + dy) * 0.9) {
					runs.put(x + dx, y + dy, d < 0.55 ? inner : outer);
				}
			}
		}
		runs.flush();
	}

	// Cooling vapour: puffs rise from the hub and thin out.
	function drawVapour(ctx, geo, level, frame) {
		const { x, y } = geo.hub;
		const period = VAPOUR_MS[level];
		for (let i = 0; i < level; i++) {
			const age = frame.still ? (i + 0.5) / level : ((frame.t / period) + i / level) % 1;
			const rise = Math.floor(age * 12);
			const drift = Math.floor(age * 5) + i;
			const big = age < 0.55;
			px(ctx, age < 0.7 ? C.vapour : C.vapourDim, x + drift, y - 4 - rise, big ? 2 : 1, big ? 2 : 1);
		}
	}

	// Environmental mode only: under heavy load the atmosphere takes on a calm, static warm tint.
	function drawHaze(ctx, frame) {
		const geo = S.geometry(frame.place);
		const coverage = frame.still ? 1 : Math.min(1, frame.elapsed / HAZE_FADE_MS);
		const runs = S.createRuns(ctx);
		for (const p of geo.rim) {
			if (S.bayer(p.x, p.y) < coverage * 0.75) {
				runs.put(p.x, p.y, p.outer ? C.hazeDim : C.haze);
			}
		}
		runs.flush();
	}

	// Life while idle: a few stars twinkle and a satellite crosses now and then.
	function drawIdleLife(ctx, frame) {
		if (frame.still) {
			return;
		}
		const second = Math.floor(frame.t / 1000);
		S.STARS.forEach((star, i) => {
			if (i % 7 === 0 && S.hash(second, i) < 0.35) {
				px(ctx, P.space0, star.x, star.y);
			}
		});
		const cross = (frame.t % SATELLITE_MS) / 30_000;
		if (cross < 1) {
			const x = Math.floor(-6 + cross * (S.WIDTH + 12));
			const y = 6 + Math.floor(cross * 10);
			px(ctx, C.panel, x - 2, y, 2, 1);
			px(ctx, C.satellite, x, y, 1, 1);
			px(ctx, C.panel, x + 1, y, 2, 1);
		}
	}

	function drawBeacon(ctx, geo, frame) {
		const pulse = !frame.still && frame.t % BEACON_MS < 350;
		drawYou(ctx, geo, C.you, pulse ? C.youDim : null);
	}

	function drawDynamic(ctx, frame) {
		const geo = S.geometry(frame.place);
		const state = WORLD_STATES.includes(frame.state) ? frame.state : 'Idle';
		drawIdleLife(ctx, frame);

		if (state === 'Idle') {
			drawHub(ctx, geo, 1, C.hubDark);
			drawBeacon(ctx, geo, frame);
			// A short echo of what just happened, then the same calm frame whatever came before.
			if (frame.elapsed < IDLE_SETTLE_MS) {
				if (frame.prevState === 'Failed') {
					drawHub(ctx, geo, 1, C.warnDim);
				} else if (frame.prevState === 'ResponseArriving') {
					drawYou(ctx, geo, C.you, C.replyDim);
				} else if (isProcessing(frame.prevState)) {
					drawGlow(ctx, geo, 6, C.powerDim, C.powerDim);
				}
			}
			return;
		}

		if (state === 'RequestStarting') {
			const u = frame.still ? 0.5 : Math.min(1, frame.elapsed / STARTING_MS);
			drawTrace(ctx, geo, C.requestDim, 0, u);
			drawHub(ctx, geo, 1, C.hubDark);
			drawYou(ctx, geo, C.you, C.request);
			drawPacket(ctx, geo, u, C.request, C.requestDim, false);
			return;
		}

		if (isProcessing(state)) {
			const level = LOAD_LEVEL[state];
			const streams = density(frame);
			if (level === 3 && (frame.mode || 'environmental') === 'environmental') {
				drawHaze(ctx, frame);
			}
			// The glow breathes gently (one pixel) so the hall looks busy without flashing.
			const breath = frame.still ? 0 : Math.floor(frame.t / 700) % 2;
			drawGlow(ctx, geo, 5 + level * 2 + breath, level >= 2 ? C.power : C.powerDim, C.powerDim);
			drawTrace(ctx, geo, C.requestDim, 0, 1);
			drawHub(ctx, geo, level, C.hubLit);
			drawVapour(ctx, geo, level, frame);
			for (let i = 0; i < streams; i++) {
				const u = frame.still ? (i + 0.5) / streams : ((frame.t / PACKET_MS[level]) + i / streams) % 1;
				drawPacket(ctx, geo, u, C.request, C.requestDim, false);
			}
			drawYou(ctx, geo, C.you, null);
			return;
		}

		if (state === 'ResponseArriving') {
			const progress = frame.still ? 0.9 : Math.min(1, frame.elapsed / RESPONSE_MS);
			drawTrace(ctx, geo, C.replyDim, 0, 1 - progress * 0.8);
			drawHub(ctx, geo, 1, C.reply);
			const replies = 1 + Math.min(2, Math.max(0, (frame.activeCount || 0) - 1));
			for (let i = 0; i < replies; i++) {
				const u = Math.max(0, 1 - progress - i * 0.12);
				drawPacket(ctx, geo, u, C.reply, C.replyDim, true);
			}
			drawYou(ctx, geo, C.you, progress > 0.7 ? C.reply : null);
			if (progress > 0.7) {
				drawRing(ctx, geo.you.x, geo.you.y, 4, C.replyDim);
			}
			return;
		}

		// Failed: the hub shows a slow amber light; the request stops halfway and fades.
		const on = frame.still || frame.elapsed % 1000 < 650;
		drawTrace(ctx, geo, C.warnDim, 0, 0.5);
		drawHub(ctx, geo, 3, on ? C.warn : C.warnDim);
		px(ctx, C.warnDim, arcPoint(geo, 0.5).x, arcPoint(geo, 0.5).y, 2, 2);
		drawYou(ctx, geo, C.you, null);
	}

	window.CarbonBitEffects = Object.freeze({
		WORLD_STATES, LOAD_LEVEL, STILL_ELAPSED, IDLE_SETTLE_MS, C, isSettled, density, drawDynamic,
	});
})();
