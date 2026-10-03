// Dynamic pixel-world layer. Every function here is a pure function of the frame
// { state, prevState, elapsed, t, level, activeCount, still, mode, hour }, so a given frame always
// draws the same pixels: no randomness, no stored particle state.
(function () {
	'use strict';

	const S = window.CarbonBitScene;
	const G = S.GEOMETRY;
	const { rect } = S;

	const WORLD_STATES = Object.freeze(['Idle', 'RequestStarting', 'ProcessingLight', 'ProcessingMedium', 'ProcessingHeavy', 'ResponseArriving', 'Failed']);
	const LOAD_LEVEL = Object.freeze({ ProcessingLight: 1, ProcessingMedium: 2, ProcessingHeavy: 3 });
	const IDLE_SETTLE_MS = 900;
	// Moment drawn for each state when the world is not animating (setting off or reduced motion).
	const STILL_ELAPSED = Object.freeze({
		Idle: IDLE_SETTLE_MS,
		RequestStarting: 450,
		ProcessingLight: 5000,
		ProcessingMedium: 5000,
		ProcessingHeavy: 5000,
		ResponseArriving: 1600,
		Failed: 1000,
	});

	const LIT_RACKS = [0, 2, 4, 6];
	const UNITS_LIT = [0, 3, 4, 5];
	const BLINK_MS = [0, 420, 260, 150];
	const FAN_MS = [0, 240, 140, 70];
	const VAPOR_MS = [0, 2800, 2100, 1500];
	const WATER_MS = [0, 260, 150, 80];
	const POWER_MS = [0, 1600, 1000, 620];
	const PACKET_MS = 800;
	const TRAFFIC_MS = 2400;
	const RACK_FADE_MS = 1500;
	const HAZE_FADE_MS = 1500;
	const BIRD_FLIGHT_MS = 900;

	function isProcessing(state) {
		return Object.prototype.hasOwnProperty.call(LOAD_LEVEL, state);
	}

	function isSettled(frame) {
		return frame.state === 'Idle' && frame.elapsed >= IDLE_SETTLE_MS;
	}

	function settlingFrom(frame, state) {
		return frame.state === 'Idle' && frame.prevState === state && frame.elapsed < IDLE_SETTLE_MS;
	}

	function loadLevel(frame) {
		return LOAD_LEVEL[frame.state] || Math.min(3, Math.max(1, frame.level || 1));
	}

	// Concurrent requests: one extra step per additional request, capped so busy periods stay calm.
	function extra(frame) {
		return Math.min(2, Math.max(0, (frame.activeCount || 0) - 1));
	}

	// Model class first, then concurrency.
	function density(frame) {
		return Math.min(5, loadLevel(frame) + extra(frame));
	}

	// Cooling and power follow the model class while processing and linger briefly after.
	function plantLevel(frame) {
		if (isProcessing(frame.state)) {
			return LOAD_LEVEL[frame.state];
		}
		if (frame.state === 'ResponseArriving' && frame.elapsed < 900) {
			return loadLevel(frame);
		}
		return 0;
	}

	function step(frame, ms) {
		return frame.still ? 0 : Math.floor(frame.t / ms);
	}

	// --- Sky: clouds, haze, vapour, the bird -----------------------------------------------------

	// Clouds are built once from overlapping lobes into [dx, dy, w, shade] runs.
	function buildCloud(lobes) {
		const width = Math.max(...lobes.map(([cx, , r]) => cx + r + 1));
		const height = Math.max(...lobes.map(([, cy]) => cy)) + 2;
		const inside = (x, y) => y >= 0 && y < height && lobes.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r + r);
		const out = [];
		for (let y = 0; y < height; y++) {
			let run = null;
			for (let x = 0; x <= width; x++) {
				let shade = null;
				if (inside(x, y)) {
					if (!inside(x, y - 1)) {
						shade = 0;
					} else if (y >= height - 1 || !inside(x, y + 1) || (!inside(x + 1, y) && y > height / 2)) {
						shade = 2;
					} else {
						shade = 1;
					}
				}
				if (run && run[3] === shade) {
					run[2]++;
				} else {
					if (run && run[3] !== null) {
						out.push(run);
					}
					run = [x, y, 1, shade];
				}
			}
			if (run && run[3] !== null) {
				out.push(run);
			}
		}
		return { width, runs: out };
	}

	const CLOUDS = [
		{ shape: buildCloud([[4, 4, 3], [10, 3, 4], [16, 3, 4], [21, 5, 2]]), x: 14, y: 6, ms: 1700 },
		{ shape: buildCloud([[3, 3, 2], [7, 2, 3], [11, 3, 2]]), x: 98, y: 1, ms: 3400 },
		{ shape: buildCloud([[3, 3, 3], [8, 2, 3], [13, 3, 3]]), x: 126, y: 14, ms: 2500 },
	];

	function drawClouds(ctx, frame, pal) {
		const shades = [pal.cloud0, pal.cloud1, pal.cloud2];
		for (const cloud of CLOUDS) {
			const span = S.WIDTH + cloud.shape.width;
			const x = ((cloud.x + step(frame, cloud.ms)) % span) - cloud.shape.width;
			for (const [dx, dy, w, shade] of cloud.shape.runs) {
				const x0 = Math.max(0, x + dx);
				const x1 = Math.min(S.WIDTH, x + dx + w);
				if (x1 > x0) {
					rect(ctx, shades[shade], x0, cloud.y + dy, x1 - x0, 1);
				}
			}
		}
	}

	// Environmental mode only (PRD §24, §37): heavy processing makes the horizon briefly more
	// industrial. A static veil behind buildings that only grows in, so it never flickers.
	// Rows bottom-up as [x, y, w] runs; an ordered dither that thins out with height.
	const HAZE_ROWS = (function () {
		const rows = [];
		const ctx = {
			fillStyle: '',
			fillRect(x, y) {
				rows[rows.length - 1].push([x, y, 1]);
			},
		};
		for (let y = 49; y >= 26; y--) {
			const level = y >= 45 ? 7 : y >= 40 ? 5 : y >= 34 ? 3 : y >= 30 ? 2 : 1;
			rows.push([]);
			S.bayerRow(ctx, '', 0, S.WIDTH, y, level, S.occluded);
		}
		return rows;
	})();

	function drawHaze(ctx, frame, pal) {
		if (frame.mode !== 'environmental' || frame.state !== 'ProcessingHeavy') {
			return;
		}
		const shown = frame.still ? HAZE_ROWS.length : Math.ceil(Math.min(1, frame.elapsed / HAZE_FADE_MS) * HAZE_ROWS.length);
		ctx.fillStyle = pal.haze;
		for (let r = 0; r < shown; r++) {
			for (const [x, y, w] of HAZE_ROWS[r]) {
				ctx.fillRect(x, y, w, 1);
			}
		}
	}

	// Puffs grow, then thin out and fade as they rise.
	const PUFFS = Object.freeze({
		legend: { v: 'vapor', f: 'vaporFade' },
		emerging: ['vv', 'ff'],
		full: [' vv ', 'vvvf', ' ff '],
		large: [' vvv ', 'vvvvf', 'vvvff', ' fff '],
		thin: ['vf', ' f'],
		last: ['f'],
	});

	function drawPuff(ctx, pal, x, y, p, large) {
		let shape = PUFFS.last;
		if (p < 0.18) {
			shape = PUFFS.emerging;
		} else if (p < 0.6) {
			shape = large ? PUFFS.large : PUFFS.full;
		} else if (p < 0.85) {
			shape = PUFFS.thin;
		}
		S.sprite(ctx, pal, PUFFS.legend, shape, x - Math.floor(shape[0].length / 2), y - shape.length + 1);
	}

	function drawVapor(ctx, frame, pal) {
		const level = plantLevel(frame);
		if (!level) {
			return;
		}
		const period = VAPOR_MS[level];
		const puffs = level + (level === 3 ? 1 : 0);
		G.coolers.slice(0, level).forEach((coolerX, unit) => {
			for (let k = 0; k < puffs; k++) {
				const age = frame.still
					? ((k + 0.5) / puffs) * period
					: (frame.t + unit * 530 + (k * period) / puffs) % period;
				// Only puffs emitted after processing began, so vapour never pops in mid-air.
				if (isProcessing(frame.state) && !frame.still && age > frame.elapsed) {
					continue;
				}
				const p = age / period;
				const rise = Math.floor(p * 14);
				drawPuff(ctx, pal, coolerX + 5 + Math.floor(rise / 3), G.coolerY - 2 - rise, p, level === 3);
			}
		});
	}

	const BIRD = Object.freeze({
		legend: { b: 'bird', y: 'birdBeak' },
		perch: [' bb  ', 'ybbbb', ' bbb '],
		up: ['b   b', ' bbb '],
		down: [' bbb ', 'b   b'],
	});

	function ease(u) {
		return u * u * (3 - 2 * u);
	}

	function drawFlyingBird(ctx, pal, frame, x, y) {
		const rows = Math.floor(frame.elapsed / 110) % 2 ? BIRD.up : BIRD.down;
		S.sprite(ctx, pal, BIRD.legend, rows, Math.round(x), Math.round(y));
	}

	// The bird on the wire leaves when data starts flowing and glides back once it is quiet again.
	function drawBird(ctx, frame, pal) {
		const [px, py] = G.perch;
		const perchX = px - 2;
		const perchY = py - 3;
		if (frame.state === 'RequestStarting') {
			if (!frame.still && frame.elapsed < BIRD_FLIGHT_MS) {
				const u = ease(frame.elapsed / BIRD_FLIGHT_MS);
				drawFlyingBird(ctx, pal, frame, perchX + (48 - perchX) * u, perchY + (5 - perchY) * u);
			}
			return;
		}
		if (frame.state !== 'Idle') {
			return;
		}
		const returning = frame.prevState !== 'Idle' && !frame.still && frame.elapsed < IDLE_SETTLE_MS;
		if (returning && frame.elapsed < IDLE_SETTLE_MS * 0.8) {
			const u = ease(frame.elapsed / (IDLE_SETTLE_MS * 0.8));
			drawFlyingBird(ctx, pal, frame, 100 + (perchX - 100) * u, 4 + (perchY - 4) * u);
			return;
		}
		// Now and then it looks the other way.
		const turned = !frame.still && step(frame, 1000) % 13 === 0;
		S.sprite(ctx, pal, BIRD.legend, BIRD.perch, perchX, perchY, turned);
	}

	// --- Data center: coolers, water, power, racks, status lamp ---------------------------------

	function drawCoolers(ctx, frame, pal) {
		const level = plantLevel(frame);
		if (!level || frame.still) {
			return;
		}
		const turned = step(frame, FAN_MS[level]) % 2 === 1;
		if (!turned) {
			return;
		}
		for (const x of G.coolers.slice(0, level)) {
			S.drawFanHousing(ctx, pal, x);
			S.drawFan(ctx, pal, x, true);
		}
	}

	function drawWater(ctx, frame, pal) {
		const level = plantLevel(frame);
		if (!level) {
			return;
		}
		const offset = step(frame, WATER_MS[level]);
		G.water.forEach(([x, y], i) => {
			const phase = (i + offset) % 4;
			if (phase === 0) {
				rect(ctx, pal.water, x, y, 1, 1);
			} else if (phase === 1 && level > 1) {
				rect(ctx, pal.waterTrail, x, y, 1, 1);
			}
		});
	}

	function drawPower(ctx, frame, pal) {
		const level = frame.state === 'RequestStarting' ? 1 : plantLevel(frame);
		if (!level) {
			return;
		}
		const route = G.power;
		const pulses = isProcessing(frame.state) ? Math.min(4, density(frame)) : 1;
		for (let i = 0; i < pulses; i++) {
			const u = frame.still ? (i + 0.5) / pulses : (frame.t / POWER_MS[level] + i / pulses) % 1;
			const at = Math.floor(u * (route.length - 1));
			const [tx, ty] = route[Math.max(0, at - 2)];
			rect(ctx, pal.powerTrail, tx, ty, 1, 1);
			const [mx, my] = route[Math.max(0, at - 1)];
			rect(ctx, pal.power, mx, my, 1, 1);
			const [x, y] = route[at];
			rect(ctx, pal.power, x, y, 1, 1);
		}
		const [ex, ey] = route[route.length - 1];
		rect(ctx, pal.power, ex, ey, 1, 1);
		if (frame.state === 'ProcessingHeavy' && !frame.still && step(frame, 110) % 4 === 0) {
			rect(ctx, pal.power, ex - 2, ey - 1, 1, 1);
			rect(ctx, pal.power, ex + 2, ey - 2, 1, 1);
		}
	}

	function litRacks(frame) {
		if (frame.state === 'RequestStarting') {
			return Math.min(2, Math.floor(frame.elapsed / 300));
		}
		if (isProcessing(frame.state)) {
			return Math.min(G.racks.length, LIT_RACKS[LOAD_LEVEL[frame.state]] + extra(frame));
		}
		if (frame.state === 'ResponseArriving') {
			return Math.round(LIT_RACKS[loadLevel(frame)] * (1 - Math.min(1, frame.elapsed / RACK_FADE_MS)));
		}
		return 0;
	}

	function drawRacks(ctx, frame, pal) {
		const lit = litRacks(frame);
		const level = isProcessing(frame.state) ? LOAD_LEVEL[frame.state] : 1;
		const units = isProcessing(frame.state) ? UNITS_LIT[level] : 2;
		const blink = step(frame, BLINK_MS[level]);
		for (let r = 0; r < lit; r++) {
			const x = G.racks[r];
			rect(ctx, pal.tileLit, x, 70, 7, 1);
			rect(ctx, pal.rackCap, x, 51, 7, 1);
			for (let j = 0; j < units; j++) {
				const y = G.units[j];
				rect(ctx, pal.led, x + 1, y, 1, 1);
				for (let k = 0; k < 3; k++) {
					const h = S.hash(r * 8 + j, k + blink * 3);
					if (h % 3 !== 0) {
						rect(ctx, h % 2 ? pal.ledBusy : pal.led, x + 3 + k, y, 1, 1);
					}
				}
			}
		}
		// Idle heartbeat: one standby light at a time, slowly walking the hall.
		if (frame.state === 'Idle' && !frame.still) {
			const r = step(frame, 2000) % G.racks.length;
			if (step(frame, 1000) % 2 === 0) {
				rect(ctx, pal.led, G.racks[r] + 1, G.units[0], 1, 1);
			}
		}
	}

	function drawLamp(ctx, frame, pal) {
		let color = null;
		if (frame.state === 'RequestStarting' || isProcessing(frame.state)) {
			color = pal.ledBusy;
		} else if (frame.state === 'ResponseArriving') {
			color = pal.done;
		}
		if (color) {
			rect(ctx, color, G.lamp.x, G.lamp.y, 2, 2);
		}
	}

	// --- The link between desk and data center -----------------------------------------------------

	function linkIndex(u) {
		return Math.round(Math.min(1, Math.max(0, u)) * (G.link.length - 1));
	}

	// u runs 0..1 from the sender; inbound packets travel data center -> desk.
	function drawPacket(ctx, pal, u, inbound, big) {
		const head = linkIndex(inbound ? 1 - u : u);
		const back = inbound ? 1 : -1;
		const trail = G.link[Math.min(G.link.length - 1, Math.max(0, head + back * 2))];
		const [x, y] = G.link[head];
		rect(ctx, inbound ? pal.replyTrail : pal.dataTrail, trail[0], trail[1], 1, 1);
		if (big) {
			const mid = G.link[Math.min(G.link.length - 1, Math.max(0, head + back))];
			rect(ctx, inbound ? pal.replyTrail : pal.dataTrail, mid[0], mid[1], 1, 1);
			rect(ctx, inbound ? pal.reply : pal.data, x, y - 1, 2, 2);
		} else {
			rect(ctx, inbound ? pal.reply : pal.data, x, y, 1, 1);
		}
	}

	function burst(frame) {
		const count = 1 + density(frame);
		const spacing = 150;
		return { count, spacing, doneAt: (count - 1) * spacing + PACKET_MS };
	}

	function arrived(frame, b) {
		let n = 0;
		for (let i = 0; i < b.count; i++) {
			if (frame.elapsed - i * b.spacing >= PACKET_MS) {
				n++;
			}
		}
		return n;
	}

	function drawLink(ctx, frame, pal) {
		let busy = false;
		if (frame.state === 'RequestStarting' || frame.state === 'ResponseArriving') {
			const b = burst(frame);
			const inbound = frame.state === 'ResponseArriving';
			for (let i = 0; i < b.count; i++) {
				const u = (frame.elapsed - i * b.spacing) / PACKET_MS;
				if (u >= 0 && u < 1) {
					drawPacket(ctx, pal, u, inbound, true);
					busy = true;
				}
			}
		} else if (isProcessing(frame.state)) {
			const n = density(frame);
			for (let i = 0; i < n; i++) {
				const u = frame.still ? (i + 0.5) / n : (frame.t / TRAFFIC_MS + i / n) % 1;
				drawPacket(ctx, pal, u, i % 2 === 1, false);
			}
			busy = true;
		}
		if (busy && (frame.still || step(frame, 180) % 2 === 0)) {
			rect(ctx, pal.data, G.router.x + 1, G.router.y, 1, 1);
		}
	}

	// --- The room: developer and screen -----------------------------------------------------------

	function isTyping(frame) {
		if (frame.state === 'RequestStarting') {
			return true;
		}
		// Occasional short bursts keep the idle scene alive without drawing attention.
		return frame.state === 'Idle' && !frame.still && step(frame, 1000) % 9 < 2;
	}

	function drawDeveloper(ctx, frame, pal) {
		if (!isTyping(frame)) {
			return;
		}
		const fast = frame.state === 'RequestStarting';
		const side = frame.still ? 0 : step(frame, fast ? 120 : 500) % 2;
		const shoulder = G.shoulders[side];
		rect(ctx, pal.hood, shoulder.x, shoulder.y - 1, 2, 1);
	}

	// Screen pixels the developer's head leaves visible.
	function screenFill(ctx, color, rows) {
		for (const [x, y, w] of G.screenSpans) {
			if (y < G.screen.y + rows) {
				rect(ctx, color, x, y, w, 1);
			}
		}
	}

	function screenLine(ctx, color, x, y, w) {
		for (const [sx, sy, sw] of G.screenSpans) {
			if (sy === y) {
				const x0 = Math.max(x, sx);
				const x1 = Math.min(x + w, sx + sw);
				if (x1 > x0) {
					rect(ctx, color, x0, y, x1 - x0, 1);
				}
			}
		}
	}

	const REPLY_LINES = [[51, 26, 7], [53, 26, 5], [55, 26, 6], [57, 26, 2]];
	const CHECK = [[37, 51], [36, 52], [33, 52], [34, 53], [35, 53], [34, 54]];

	function drawScreen(ctx, frame, pal) {
		const s = G.screen;
		if (frame.state === 'Idle') {
			// A slow cursor blink after the last line of code.
			if (!frame.still && step(frame, 1000) % 2 === 0) {
				screenLine(ctx, pal.codeA, 38, 55, 1);
			}
			return;
		}
		screenFill(ctx, pal.screen, s.h);
		screenLine(ctx, pal.screenGlow, s.x, s.y, s.w);
		if (frame.state === 'RequestStarting') {
			const typed = frame.still ? 8 : Math.min(8, 2 + Math.floor(frame.elapsed / 60));
			screenLine(ctx, pal.codeA, 27, 52, typed);
			if (frame.still || frame.elapsed > 360) {
				for (const [x, y] of [[36, 52], [37, 53], [36, 54]]) {
					screenLine(ctx, pal.data, x, y, 1);
				}
			}
		} else if (isProcessing(frame.state)) {
			const active = step(frame, 320) % 3;
			for (let i = 0; i < 3; i++) {
				screenLine(ctx, i === active ? pal.data : pal.codeDim, 29 + i * 3, 53, 2);
			}
		} else if (frame.state === 'ResponseArriving') {
			const b = burst(frame);
			const lines = frame.still ? REPLY_LINES.length : Math.ceil((arrived(frame, b) / b.count) * REPLY_LINES.length);
			for (let i = 0; i < lines; i++) {
				const [y, x, w] = REPLY_LINES[i];
				screenLine(ctx, pal.reply, x, y, w);
			}
		} else if (frame.state === 'Failed') {
			screenLine(ctx, pal.warn, 27, 53, 6);
			screenLine(ctx, pal.codeDim, 27, 55, 4);
		}
	}

	// A small check on the screen when the reply is complete; it fades as the world settles.
	function drawCompletion(ctx, frame, pal) {
		const done = frame.state === 'ResponseArriving' && (frame.still || frame.elapsed >= burst(frame).doneAt);
		if (!done && !settlingFrom(frame, 'ResponseArriving')) {
			return;
		}
		for (const [x, y] of CHECK) {
			screenLine(ctx, pal.done, x, y, 1);
		}
	}

	// Amber, slow and small: a failed request is noted, not alarmed about.
	function drawFailure(ctx, frame, pal) {
		const settling = settlingFrom(frame, 'Failed');
		if (frame.state !== 'Failed' && !settling) {
			return;
		}
		const dim = settling || (!frame.still && Math.floor(frame.elapsed / 700) % 2 === 1);
		const color = dim ? pal.warnDim : pal.warn;
		rect(ctx, color, G.lamp.x, G.lamp.y, 2, 2);
		rect(ctx, color, G.racks[2] + 1, G.units[0], 1, 1);
		if (frame.state === 'Failed' && !frame.still && frame.elapsed < 900) {
			// The last packet stalls on the wire and fades out.
			const [x, y] = G.link[linkIndex(0.4)];
			if (frame.elapsed < 450) {
				rect(ctx, pal.data, x, y - 1, 2, 2);
			} else {
				rect(ctx, pal.dataTrail, x, y, 1, 1);
			}
		}
	}

	function drawDynamic(ctx, frame) {
		const pal = S.palette(S.phaseOf(frame.hour));
		drawClouds(ctx, frame, pal);
		drawHaze(ctx, frame, pal);
		drawVapor(ctx, frame, pal);
		drawBird(ctx, frame, pal);
		drawCoolers(ctx, frame, pal);
		drawWater(ctx, frame, pal);
		drawPower(ctx, frame, pal);
		drawRacks(ctx, frame, pal);
		drawLamp(ctx, frame, pal);
		drawLink(ctx, frame, pal);
		drawDeveloper(ctx, frame, pal);
		drawScreen(ctx, frame, pal);
		drawCompletion(ctx, frame, pal);
		drawFailure(ctx, frame, pal);
	}

	window.CarbonBitEffects = Object.freeze({
		WORLD_STATES,
		LOAD_LEVEL,
		IDLE_SETTLE_MS,
		STILL_ELAPSED,
		drawDynamic,
		isSettled,
	});
})();
