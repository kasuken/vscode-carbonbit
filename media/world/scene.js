// Static pixel-world layer ("Two Rooms, One Wire", see docs/WORLD_ART.md): palette, geometry and
// everything that never moves. The renderer caches drawBackground(ctx, phase) once per time-of-day
// phase; effects.js draws the living layer on top. All drawing is integer fillRect runs.
(function () {
	'use strict';

	const WIDTH = 160;
	const HEIGHT = 90;
	const PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night']);

	// Master palette: eight short ramps. Every pixel in the world comes from here or a sky set below.
	const RAMP = Object.freeze({
		ink: '#1a1b29', slate0: '#2a2e43', slate1: '#434a66', slate2: '#666f8f', slate3: '#949cb5', slate4: '#c7cede', white: '#eef2f8',
		earth0: '#38251f', earth1: '#5c3c2a', earth2: '#88593a', earth3: '#b98556', earth4: '#e2b886',
		green0: '#1d3b31', green1: '#2c5a3d', green2: '#478147', green3: '#72ad55', green4: '#a6d66d',
		teal0: '#4a7166', teal1: '#5f8a79', teal2: '#7fa68b',
		rose0: '#682c37', rose1: '#9a4844', rose2: '#c66f5a',
		skin: '#f0bf92', skinShade: '#c68862', blue: '#3e8ccf', blueDark: '#2b5e98', cyan: '#8ee4ff',
		sun: '#ffd65a', sunCore: '#fff3c4', amber: '#ee9843', amberDim: '#a5693d', haze: '#b9a98f',
	});

	// Outdoor colours are lit by the sky, so each phase tints them (a palette swap, not a filter).
	const OUTDOOR = {
		mtn: 'slate3', mtnShade: 'slate2', snow: 'white', snowShade: 'slate4',
		hill: 'teal1', hillShade: 'teal0', hillLight: 'teal2',
		pine: 'green1', pineDark: 'green0', pineLight: 'green2',
		meadow: 'green2', meadowLight: 'green3', grass: 'green4', grassMid: 'green3', grassDark: 'green2',
		soil: 'earth1', soilDark: 'earth0', pebble: 'earth2', pebbleLight: 'earth3',
		leaf: 'green2', leafDark: 'green1', leafLight: 'green3', leafDeep: 'green0', trunk: 'earth1', trunkDark: 'earth0',
		petal: 'white', petalWarm: 'sun',
		roof: 'rose1', roofDark: 'rose0', roofLight: 'rose2',
		log: 'earth2', logDark: 'earth1', logLight: 'earth3', logDeep: 'earth0',
		stone: 'slate3', stoneDark: 'slate2', stoneLight: 'slate4',
		concrete: 'slate4', concreteShade: 'slate3', concreteDark: 'slate2', concreteLight: 'white',
		metal: 'slate2', metalDark: 'slate1', metalLight: 'slate3', metalDeep: 'slate0',
		tank: 'slate4', tankShade: 'slate3', tankDark: 'slate2', tankLight: 'white', tankMark: 'blue',
		pole: 'earth1', poleLight: 'earth2', insulator: 'slate4', cable: 'ink',
		pipe: 'slate3', pipeDark: 'slate1', pipeLight: 'slate4',
		conduit: 'slate1', conduitCore: 'slate0',
		vapor: 'white', vaporFade: 'slate4', haze: 'haze', bird: 'slate0', birdBeak: 'amber',
	};

	// Lit interiors and signal colours never change with the hour.
	const FIXED = {
		wall: 'earth4', wallShade: 'earth3', wainscot: 'earth2', trim: 'earth1', floor: 'earth2', floorDark: 'earth1',
		desk: 'earth3', deskTop: 'earth4', deskDark: 'earth1',
		bezel: 'ink', screen: 'slate0', screenGlow: 'slate1', codeA: 'cyan', codeB: 'green4', codeC: 'sun', codeDim: 'slate2',
		hair: 'earth0', hairLight: 'earth1', skin: 'skin', skinShade: 'skinShade', hood: 'blue', hoodDark: 'blueDark',
		chair: 'slate1', chairDark: 'slate0', chairLight: 'slate2',
		mug: 'white', mugShade: 'slate4', plant: 'green3', plantDark: 'green2', pot: 'rose1', potDark: 'rose0',
		router: 'slate1', routerDark: 'slate0',
		dcWall: 'slate0', dcSeam: 'ink', rack: 'ink', unit: 'slate1', unitShade: 'slate0', rackCap: 'slate2',
		tray: 'slate2', trayDark: 'slate1', tile: 'slate1', tileSeam: 'slate0', tileLit: 'slate2', ceilingLamp: 'slate4',
		lampOff: 'slate1', ledDim: 'green1', led: 'green4', ledBusy: 'cyan',
		data: 'cyan', dataTrail: 'blue', reply: 'green4', replyTrail: 'green2',
		power: 'sun', powerTrail: 'amber', water: 'cyan', waterTrail: 'blue',
		warn: 'amber', warnDim: 'amberDim', done: 'green4',
	};

	// Hand-tuned skies (zenith to horizon) and cloud ramps (light, body, shade) per phase.
	const SKIES = Object.freeze({
		dawn: { sky: ['#3b4886', '#68669f', '#a9809f', '#dd9e93', '#f4c9a3'], cloud: ['#fde9da', '#e9b9b1', '#a98aa9'], tint: ['#f2a08c', 0.12] },
		day: { sky: ['#3f6cc0', '#5486d6', '#72a3e4', '#98c4ef', '#c3e1f5'], cloud: ['#ffffff', '#dce7f6', '#a8bfe0'], tint: null },
		dusk: { sky: ['#252a5c', '#463c7c', '#83508a', '#c7706e', '#eda16e'], cloud: ['#f6c39a', '#c47f86', '#6b4b7a'], tint: ['#57305e', 0.3] },
		night: { sky: ['#0b1024', '#10183a', '#162248', '#1d2c57', '#263866'], cloud: ['#4a5682', '#37436c', '#29345a'], tint: ['#0d1530', 0.58] },
	});

	function phaseOf(hour) {
		if (typeof hour !== 'number' || !Number.isFinite(hour)) {
			return 'day';
		}
		const h = ((Math.floor(hour) % 24) + 24) % 24;
		if (h >= 5 && h < 7) {
			return 'dawn';
		}
		if (h >= 7 && h < 18) {
			return 'day';
		}
		if (h >= 18 && h < 20) {
			return 'dusk';
		}
		return 'night';
	}

	function mix(a, b, t) {
		const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
		let out = '#';
		for (let i = 0; i < 3; i++) {
			const v = Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t);
			out += v.toString(16).padStart(2, '0');
		}
		return out;
	}

	function buildPalette(phase) {
		const sky = SKIES[phase];
		const pal = {};
		for (const [key, ramp] of Object.entries(OUTDOOR)) {
			pal[key] = sky.tint ? mix(RAMP[ramp], sky.tint[0], sky.tint[1]) : RAMP[ramp];
		}
		for (const [key, ramp] of Object.entries(FIXED)) {
			pal[key] = RAMP[ramp];
		}
		sky.sky.forEach((color, i) => {
			pal[`sky${i}`] = color;
		});
		sky.cloud.forEach((color, i) => {
			pal[`cloud${i}`] = color;
		});
		pal.sun = RAMP.sun;
		pal.sunCore = RAMP.sunCore;
		pal.moon = '#e9ecd6';
		pal.moonShade = '#b3b8a6';
		pal.star = '#e2e8ff';
		pal.starDim = '#7c88ba';
		// The house window shows the same sky as outside.
		pal.glass = sky.sky[3];
		pal.glassLight = sky.sky[4];
		return Object.freeze(pal);
	}

	const PALETTES = Object.freeze(Object.fromEntries(PHASES.map(phase => [phase, buildPalette(phase)])));

	function palette(phase) {
		return PALETTES[phase] || PALETTES.day;
	}

	// --- Geometry shared with effects.js (logical pixels) -------------------------------------------

	const GROUND_Y = 76;
	const RACK_X = Object.freeze([91, 100, 109, 118, 127, 136]);
	const UNIT_Y = Object.freeze([54, 57, 60, 63, 66]);
	const COOLERS = Object.freeze([125, 109, 93]);

	// Developer seen from behind, at (23, 56). h hair, s skin, b hoodie, w/c/C chair.
	const DEVELOPER = Object.freeze({
		x: 23,
		y: 56,
		legend: { h: 'hair', H: 'hairLight', s: 'skin', S: 'skinShade', b: 'hood', B: 'hoodDark', w: 'chairLight', c: 'chair', C: 'chairDark' },
		rows: [
			'       hhhh       ',
			'     hHHhhhhh     ',
			'    hHHhhhhhhh    ',
			'    shHhhhhhhs    ',
			'    Shhhhhhhhs    ',
			'     hhhhhhhh     ',
			'     bBSssSBb     ',
			'   bbbBBBBBBbbb   ',
			'  bbbbbBBBBbbbbb  ',
			'  Bbbbbbbbbbbbbb  ',
			'  Bbbwwwwwwwwbbb  ',
			'  BbBccccccccbBb  ',
			'   BBccccccccBB   ',
			'   CCCCCCCCCCCC   ',
		],
	});

	const SCREEN = Object.freeze({ x: 25, y: 50, w: 14, h: 10 });

	// Screen pixels not hidden by the developer's head, as [x, y, w] runs per row.
	function screenSpans() {
		const spans = [];
		for (let y = SCREEN.y; y < SCREEN.y + SCREEN.h; y++) {
			const row = DEVELOPER.rows[y - DEVELOPER.y] || '';
			let start = -1;
			for (let x = SCREEN.x; x <= SCREEN.x + SCREEN.w; x++) {
				const open = x < SCREEN.x + SCREEN.w && (row[x - DEVELOPER.x] || ' ') === ' ';
				if (open && start < 0) {
					start = x;
				} else if (!open && start >= 0) {
					spans.push(Object.freeze([start, y, x - start]));
					start = -1;
				}
			}
		}
		return Object.freeze(spans);
	}

	function sag(x0, y0, x1, y1, depth, steps) {
		const points = [];
		for (let i = 0; i <= steps; i++) {
			const u = i / steps;
			points.push([Math.round(x0 + (x1 - x0) * u), Math.round(y0 + (y1 - y0) * u + 4 * depth * u * (1 - u))]);
		}
		return points;
	}

	function line(x0, y0, x1, y1) {
		const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
		const points = [];
		for (let i = 0; i <= n; i++) {
			points.push([Math.round(x0 + ((x1 - x0) * i) / Math.max(1, n)), Math.round(y0 + ((y1 - y0) * i) / Math.max(1, n))]);
		}
		return points;
	}

	// Concatenates segments into one 8-connected pixel path without repeats.
	function path(...segments) {
		const out = [];
		for (const segment of segments) {
			for (const [x, y] of segment) {
				const last = out[out.length - 1];
				if (last && last[0] === x && last[1] === y) {
					continue;
				}
				if (last && (Math.abs(last[0] - x) > 1 || Math.abs(last[1] - y) > 1)) {
					out.push(...line(last[0], last[1], x, y).slice(1, -1));
				}
				out.push([x, y]);
			}
		}
		return Object.freeze(out.map(p => Object.freeze(p)));
	}

	// Data: router -> wall -> wire over the pole -> data center cable tray.
	const LINK = path(line(45, 50, 50, 50), sag(50, 50, 63, 41, 1.5, 26), line(63, 41, 70, 41), sag(70, 41, 85, 50, 2, 30), line(85, 50, 90, 50), line(90, 49, 142, 49));
	// Electricity: buried line from the grid (right edge) up into the data center floor.
	const POWER = path(line(159, 84, 116, 84), line(116, 83, 116, 71));
	// Cooling water: tank -> pipe -> the nearest rooftop cooler.
	const WATER = path(line(149, 40, 138, 40));
	const WIRE_SPAN = sag(70, 41, 85, 50, 2, 30);

	const GEOMETRY = Object.freeze({
		GROUND_Y,
		racks: RACK_X,
		units: UNIT_Y,
		coolers: COOLERS,
		coolerY: 37,
		link: LINK,
		power: POWER,
		water: WATER,
		router: Object.freeze({ x: 41, y: 50 }),
		lamp: Object.freeze({ x: 87, y: 53 }),
		screen: SCREEN,
		screenSpans: screenSpans(),
		developer: DEVELOPER,
		// The bird's spot on the wire between the pole and the data center.
		perch: Object.freeze(WIRE_SPAN.find(p => p[0] === 77)),
		shoulders: Object.freeze([{ x: 26, y: 62 }, { x: 37, y: 62 }]),
	});

	// --- Primitives ---------------------------------------------------------------------------------

	function rect(ctx, color, x, y, w, h) {
		ctx.fillStyle = color;
		ctx.fillRect(x, y, w, h);
	}

	// Deterministic 0..999 noise for texture placement.
	function hash(x, y) {
		let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
		h = Math.imul(h ^ (h >>> 13), 1274126177);
		return ((h ^ (h >>> 16)) >>> 0) % 1000;
	}

	// Character-map sprite: legend maps characters to palette keys, ' ' is transparent.
	function sprite(ctx, pal, legend, rows, x, y, mirror) {
		for (let r = 0; r < rows.length; r++) {
			const row = mirror ? [...rows[r]].reverse().join('') : rows[r];
			let c = 0;
			while (c < row.length) {
				const ch = row[c];
				let end = c + 1;
				while (end < row.length && row[end] === ch) {
					end++;
				}
				if (ch !== ' ') {
					rect(ctx, pal[legend[ch]], x + c, y + r, end - c, 1);
				}
				c = end;
			}
		}
	}

	// Draws a row of per-pixel colours (null = skip) as merged runs.
	function runs(ctx, y, x0, colors) {
		let c = 0;
		while (c < colors.length) {
			const color = colors[c];
			let end = c + 1;
			while (end < colors.length && colors[end] === color) {
				end++;
			}
			if (color) {
				rect(ctx, color, x0 + c, y, end - c, 1);
			}
			c = end;
		}
	}

	// 4x4 ordered (Bayer) dither: level 0..16 of a colour over whatever is below.
	const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

	function bayerRow(ctx, color, x0, x1, y, level, skip) {
		ctx.fillStyle = color;
		for (let x = x0; x < x1; x++) {
			if (BAYER[y & 3][x & 3] < level && !(skip && skip(x, y))) {
				ctx.fillRect(x, y, 1, 1);
			}
		}
	}

	// Ordered dither: one colour every `step` pixels along a row.
	function ditherRow(ctx, color, x0, x1, y, step, offset) {
		ctx.fillStyle = color;
		for (let x = x0 + offset; x < x1; x += step) {
			ctx.fillRect(x, y, 1, 1);
		}
	}

	// Shaded round foliage/cloud lobe: light from the upper left.
	function lobe(ctx, cx, cy, r, dark, mid, light, deep) {
		for (let dy = -r; dy <= r; dy++) {
			const colors = [];
			const half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.35);
			for (let dx = -half; dx <= half; dx++) {
				const d = dx + dy * 1.4;
				let color = mid;
				if (d < -r * 0.9 && (dx + dy) % 2 === 0) {
					color = light;
				} else if (d < -r * 1.25) {
					color = light;
				} else if (d > r * 1.1) {
					color = deep || dark;
				} else if (d > r * 0.45) {
					color = dark;
				}
				colors.push(color);
			}
			runs(ctx, cy + dy, cx - half, colors);
		}
	}

	// --- Backdrop -----------------------------------------------------------------------------------

	const SKY_EDGES = [12, 23, 32, 40];

	function drawSky(ctx, pal) {
		let top = 0;
		for (let i = 0; i < 5; i++) {
			const bottom = i < 4 ? SKY_EDGES[i] : 66;
			rect(ctx, pal[`sky${i}`], 0, top, WIDTH, bottom - top);
			top = bottom;
		}
		// Four-row Bayer ramp across each band edge.
		SKY_EDGES.forEach((edge, i) => {
			bayerRow(ctx, pal[`sky${i + 1}`], 0, WIDTH, edge - 2, 2);
			bayerRow(ctx, pal[`sky${i + 1}`], 0, WIDTH, edge - 1, 6);
			bayerRow(ctx, pal[`sky${i}`], 0, WIDTH, edge, 6);
			bayerRow(ctx, pal[`sky${i}`], 0, WIDTH, edge + 1, 2);
		});
	}

	function disc(ctx, color, cx, cy, widths) {
		ctx.fillStyle = color;
		widths.forEach((w, i) => ctx.fillRect(cx - Math.floor(w / 2), cy + i, w, 1));
	}

	const STARS = [[6, 5], [19, 13], [31, 3], [44, 9], [57, 2], [63, 17], [79, 6], [91, 13], [101, 3], [124, 20], [135, 4], [143, 15], [154, 7], [12, 24], [52, 27], [86, 22], [148, 27], [27, 18], [71, 26], [108, 25]];

	function drawCelestial(ctx, pal, phase) {
		if (phase === 'night') {
			STARS.forEach(([x, y], i) => rect(ctx, i % 3 === 0 ? pal.star : pal.starDim, x, y, 1, 1));
			for (const [x, y] of [[38, 6], [128, 12]]) {
				rect(ctx, pal.starDim, x - 1, y, 3, 1);
				rect(ctx, pal.starDim, x, y - 1, 1, 3);
				rect(ctx, pal.star, x, y, 1, 1);
			}
			// Full moon with a soft dithered halo.
			const mx = 114;
			const my = 6;
			for (let dy = -2; dy <= 10; dy++) {
				for (let dx = -6; dx <= 6; dx++) {
					const d = dx * dx + (dy - 4) * (dy - 4);
					if (d > 16 && d <= 34 && (dx + dy) % 2 === 0) {
						rect(ctx, pal.sky2, mx + dx, my + dy, 1, 1);
					}
				}
			}
			disc(ctx, pal.moon, mx, my + 1, [3, 5, 7, 7, 7, 5, 3]);
			rect(ctx, pal.moonShade, mx + 2, my + 3, 1, 3);
			rect(ctx, pal.moonShade, mx + 1, my + 6, 2, 1);
			rect(ctx, pal.moonShade, mx - 2, my + 3, 2, 1);
			rect(ctx, pal.moonShade, mx - 1, my + 5, 1, 1);
			return;
		}
		if (phase === 'dawn') {
			for (const [x, y] of [[22, 4], [97, 7], [141, 3]]) {
				rect(ctx, pal.starDim, x, y, 1, 1);
			}
		}
		const low = phase !== 'day';
		const cx = phase === 'dawn' ? 60 : phase === 'dusk' ? 80 : 70;
		const cy = low ? 30 : 7;
		for (let dy = -3; dy <= 9; dy++) {
			for (let dx = -6; dx <= 6; dx++) {
				const d = dx * dx + (dy - 3) * (dy - 3);
				if (d > 14 && d <= 36 && (dx + dy) % 2 === 0) {
					rect(ctx, low ? pal.sky4 : pal.sky3, cx + dx, cy + dy, 1, 1);
				}
			}
		}
		disc(ctx, pal.sun, cx, cy, [3, 5, 7, 7, 7, 5, 3]);
		disc(ctx, pal.sunCore, cx - 1, cy + 1, [2, 3, 2]);
	}

	// Alternating peaks and valleys; odd entries are peaks.
	const RIDGE = [[0, 45], [11, 37], [21, 42], [33, 32], [46, 41], [58, 34], [67, 40], [78, 30], [91, 41], [103, 33], [115, 40], [128, 29], [141, 38], [152, 33], [160, 41]];

	function ridgeTop(x) {
		for (let i = 0; i < RIDGE.length - 1; i++) {
			const [x0, y0] = RIDGE[i];
			const [x1, y1] = RIDGE[i + 1];
			if (x >= x0 && x <= x1) {
				return Math.round(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0));
			}
		}
		return 45;
	}

	function drawMountains(ctx, pal) {
		for (let x = 0; x < WIDTH; x++) {
			const top = ridgeTop(x);
			const k = RIDGE.findIndex((p, i) => i % 2 === 1 && x >= RIDGE[i - 1][0] && x <= RIDGE[i + 1][0]);
			const [px, py] = RIDGE[k];
			const colors = [];
			for (let y = top; y < 58; y++) {
				// Shadow side: right of a ridge line that leans out from each summit.
				const shaded = x > px + Math.floor((y - py) * 0.55) - (hash(x, y) % 7 === 0 ? 1 : 0);
				const snowLine = py + 4 + (hash(x, 3) % 3);
				const snowy = py <= 34 && y < snowLine && y - top < 4;
				colors.push(snowy ? (shaded ? pal.snowShade : pal.snow) : shaded ? pal.mtnShade : pal.mtn);
			}
			// Vertical run-merge for this column.
			let c = 0;
			while (c < colors.length) {
				let end = c + 1;
				while (end < colors.length && colors[end] === colors[c]) {
					end++;
				}
				rect(ctx, colors[c], x, top + c, 1, end - c);
				c = end;
			}
		}
		// Atmospheric veil at the foot of the range.
		for (let y = 46; y < 54; y++) {
			bayerRow(ctx, pal.sky4, 0, WIDTH, y, y - 45);
		}
	}

	function hillTop(x) {
		return 52 + Math.round(2.2 * Math.sin(x * 0.065 + 0.6) + 1.4 * Math.sin(x * 0.17 + 2.1));
	}

	function drawHills(ctx, pal) {
		for (let x = 0; x < WIDTH; x++) {
			const top = hillTop(x);
			rect(ctx, pal.hillLight, x, top, 1, 1);
			rect(ctx, pal.hill, x, top + 1, 1, 66 - top);
			if (hillTop(x + 1) > top || x % 3 === 0) {
				rect(ctx, pal.hillShade, x, top + 3 + (x % 2), 1, 1);
			}
		}
		ditherRow(ctx, pal.hillShade, 0, WIDTH, 58, 2, 0);
	}

	function drawTreeline(ctx, pal) {
		rect(ctx, pal.pine, 0, 63, WIDTH, 4);
		for (let i = 0; i < 24; i++) {
			const cx = i * 7 + (hash(i, 1) % 3);
			const top = 58 + (hash(i, 2) % 3);
			const widths = [1, 3, 3, 5, 5, 7];
			widths.forEach((w, r) => {
				rect(ctx, pal.pine, cx - Math.floor(w / 2), top + r, w, 1);
				rect(ctx, pal.pineLight, cx - Math.floor(w / 2), top + r, 1, 1);
				rect(ctx, pal.pineDark, cx + Math.floor(w / 2), top + r, 1, 1);
			});
		}
		ditherRow(ctx, pal.pineDark, 0, WIDTH, 66, 2, 1);
	}

	function drawMeadow(ctx, pal) {
		rect(ctx, pal.meadow, 0, 67, WIDTH, GROUND_Y - 67);
		ditherRow(ctx, pal.pineDark, 0, WIDTH, 67, 4, 0);
		ditherRow(ctx, pal.meadowLight, 0, WIDTH, 70, 4, 2);
		ditherRow(ctx, pal.meadowLight, 0, WIDTH, 72, 2, 1);
		rect(ctx, pal.meadowLight, 0, 73, WIDTH, GROUND_Y - 73);
		for (let x = 0; x < WIDTH; x += 3) {
			const h = hash(x, 70);
			if (h < 260) {
				rect(ctx, pal.meadow, x, 69 + (h % 4), 2, 1);
			}
		}
	}

	function drawGround(ctx, pal) {
		rect(ctx, pal.grass, 0, GROUND_Y, WIDTH, 1);
		rect(ctx, pal.grassMid, 0, GROUND_Y + 1, WIDTH, 1);
		rect(ctx, pal.grassDark, 0, GROUND_Y + 2, WIDTH, 1);
		rect(ctx, pal.soil, 0, GROUND_Y + 3, WIDTH, HEIGHT - GROUND_Y - 3);
		ditherRow(ctx, pal.grassDark, 0, WIDTH, GROUND_Y + 3, 2, 0);
		ditherRow(ctx, pal.grassDark, 0, WIDTH, GROUND_Y + 4, 4, 1);
		ditherRow(ctx, pal.soilDark, 0, WIDTH, HEIGHT - 1, 2, 1);
		// Buried stones, lit from above.
		for (let i = 0; i < 26; i++) {
			const x = (i * 37 + (hash(i, 9) % 11)) % (WIDTH - 4);
			const y = 81 + (hash(i, 5) % 7);
			if (y >= 83 && y <= 85 && x > 112) {
				continue;
			}
			const w = 2 + (hash(i, 7) % 3);
			rect(ctx, pal.soilDark, x, y + 1, w, 1);
			rect(ctx, pal.pebble, x, y, w, 1);
			rect(ctx, pal.pebbleLight, x, y, 1, 1);
		}
		// Power conduit: casing and dark core; effects.js runs current through the core.
		rect(ctx, pal.conduit, 117, 83, WIDTH - 117, 3);
		rect(ctx, pal.conduit, 115, 71, 3, 15);
		for (const [x, y] of POWER) {
			rect(ctx, pal.conduitCore, x, y, 1, 1);
		}
		for (let x = 121; x < WIDTH; x += 9) {
			rect(ctx, pal.metal, x, 83, 1, 3);
		}
	}

	function drawGrassTufts(ctx, pal) {
		for (let x = 1; x < WIDTH - 1; x++) {
			const h = hash(x, GROUND_Y);
			if (h < 180) {
				rect(ctx, pal.grass, x, GROUND_Y - 1, 1, 1);
				if (h < 50) {
					rect(ctx, pal.grassMid, x + 1, GROUND_Y - 2, 1, 2);
				}
			} else if (h < 200 && (x < 50 || (x > 52 && x < 84))) {
				rect(ctx, h % 2 ? pal.petal : pal.petalWarm, x, GROUND_Y - 2, 1, 1);
				rect(ctx, pal.grassDark, x, GROUND_Y - 1, 1, 1);
			}
		}
	}

	// --- Midground ----------------------------------------------------------------------------------

	function drawTree(ctx, pal, cx, base) {
		rect(ctx, pal.trunk, cx - 1, base - 10, 3, 10);
		rect(ctx, pal.trunkDark, cx + 1, base - 10, 1, 10);
		rect(ctx, pal.leafDeep, cx - 3, base, 7, 1);
		lobe(ctx, cx + 3, base - 13, 4, pal.leafDark, pal.leaf, pal.leafLight, pal.leafDeep);
		lobe(ctx, cx - 3, base - 13, 4, pal.leafDark, pal.leaf, pal.leafLight, pal.leafDeep);
		lobe(ctx, cx, base - 17, 5, pal.leafDark, pal.leaf, pal.leafLight, pal.leafDeep);
	}

	function drawBush(ctx, pal, cx, base) {
		lobe(ctx, cx + 3, base - 2, 2, pal.leafDark, pal.leaf, pal.leafLight, pal.leafDeep);
		lobe(ctx, cx, base - 3, 3, pal.leafDark, pal.leaf, pal.leafLight, pal.leafDeep);
	}

	function drawPole(ctx, pal) {
		rect(ctx, pal.pole, 66, 40, 2, GROUND_Y - 40);
		rect(ctx, pal.poleLight, 66, 40, 1, GROUND_Y - 40);
		rect(ctx, pal.logDeep, 65, GROUND_Y - 1, 4, 1);
		rect(ctx, pal.pole, 61, 42, 12, 1);
		rect(ctx, pal.logDeep, 61, 43, 12, 1);
		rect(ctx, pal.logDeep, 64, 44, 1, 1);
		rect(ctx, pal.logDeep, 69, 44, 1, 1);
		for (const x of [63, 70]) {
			rect(ctx, pal.insulator, x, 41, 1, 1);
		}
	}

	function drawWire(ctx, pal) {
		for (const [x, y] of LINK) {
			if (x >= 50 && x <= 85) {
				rect(ctx, pal.cable, x, y, 1, 1);
			}
		}
		for (const x of [63, 70]) {
			rect(ctx, pal.insulator, x, 42, 1, 1);
		}
	}

	// --- The house: a cut-away room ------------------------------------------------------------------

	function drawHouse(ctx, pal) {
		// Roof: shingle courses on a trapezoid, ridge cap, deep eave shadow.
		for (let y = 31; y <= 45; y++) {
			const left = 14 - (y - 31);
			const right = 37 + (y - 31);
			const course = (y - 31) % 3;
			rect(ctx, course === 2 ? pal.roofDark : pal.roof, left, y, right - left + 1, 1);
			if (course !== 2) {
				const shift = Math.floor((y - 31) / 3) % 2 ? 2 : 0;
				for (let x = left + 2 + shift; x < right - 1; x += 5) {
					rect(ctx, pal.roofDark, x, y, 1, 1);
				}
				if (course === 0) {
					for (let x = left + 3 + shift; x < right - 1; x += 5) {
						rect(ctx, pal.roofLight, x, y, 2, 1);
					}
				}
			}
			rect(ctx, pal.roofLight, left, y, 1, 1);
			rect(ctx, pal.roofDark, right, y, 1, 1);
		}
		rect(ctx, pal.roofDark, 14, 30, 24, 1);
		rect(ctx, pal.roofLight, 15, 30, 20, 1);
		rect(ctx, pal.logDeep, 0, 45, 52, 1);

		// Posts and beam (outside, so tinted with the hour).
		rect(ctx, pal.logDark, 2, 46, 48, 2);
		rect(ctx, pal.log, 2, 46, 48, 1);
		for (const x of [2, 47]) {
			rect(ctx, pal.log, x, 46, 3, 26);
			rect(ctx, pal.logLight, x, 48, 1, 24);
			rect(ctx, pal.logDark, x + 2, 48, 1, 24);
		}

		// Interior: plank wall, wainscot, floor boards.
		rect(ctx, pal.wall, 5, 48, 42, 22);
		rect(ctx, pal.wallShade, 5, 48, 42, 1);
		ditherRow(ctx, pal.wallShade, 5, 47, 49, 2, 0);
		for (let x = 10; x < 47; x += 7) {
			rect(ctx, pal.wallShade, x, 50, 1, 14);
		}
		rect(ctx, pal.trim, 5, 64, 42, 1);
		rect(ctx, pal.wainscot, 5, 65, 42, 5);
		for (let x = 7; x < 47; x += 4) {
			rect(ctx, pal.trim, x, 66, 1, 4);
		}
		rect(ctx, pal.floor, 5, 70, 42, 2);
		for (let x = 6; x < 47; x += 6) {
			rect(ctx, pal.floorDark, x, 71, 3, 1);
		}

		// Window onto the same sky as outside.
		rect(ctx, pal.trim, 7, 51, 11, 10);
		rect(ctx, pal.glass, 8, 52, 9, 8);
		rect(ctx, pal.glassLight, 8, 52, 4, 1);
		rect(ctx, pal.glassLight, 8, 53, 1, 3);
		rect(ctx, pal.trim, 12, 52, 1, 8);
		rect(ctx, pal.trim, 8, 55, 9, 1);
		rect(ctx, pal.deskTop, 6, 61, 13, 1);
		rect(ctx, pal.wallShade, 7, 62, 11, 1);

		// Desk.
		rect(ctx, pal.deskTop, 19, 63, 26, 1);
		rect(ctx, pal.desk, 19, 64, 26, 2);
		rect(ctx, pal.deskDark, 19, 66, 26, 1);
		rect(ctx, pal.deskDark, 20, 67, 2, 3);
		rect(ctx, pal.deskDark, 42, 67, 2, 3);

		// Monitor with a resting screen of code.
		rect(ctx, pal.bezel, 24, 49, 16, 12);
		rect(ctx, pal.screen, SCREEN.x, SCREEN.y, SCREEN.w, SCREEN.h);
		rect(ctx, pal.screenGlow, SCREEN.x, SCREEN.y, SCREEN.w, 1);
		rect(ctx, pal.bezel, 31, 61, 2, 2);
		rect(ctx, pal.bezel, 29, 62, 6, 1);
		const code = [[51, 26, 5, 'codeA'], [51, 32, 3, 'codeC'], [53, 28, 7, 'codeB'], [55, 28, 4, 'codeA'], [55, 33, 4, 'codeC'], [57, 26, 2, 'codeB'], [57, 36, 2, 'codeA'], [59, 26, 1, 'codeC']];
		for (const [y, x, w, key] of code) {
			rect(ctx, pal[key], x, y, w, 1);
		}

		// Router on the wall: where the data leaves the room.
		rect(ctx, pal.router, 41, 50, 4, 2);
		rect(ctx, pal.routerDark, 41, 51, 4, 1);
		rect(ctx, pal.router, 44, 48, 1, 2);
		rect(ctx, pal.cable, 40, 54, 1, 1);
		rect(ctx, pal.cable, 40, 52, 1, 2);
		rect(ctx, pal.cable, 45, 50, 2, 1);

		// Plant and mug.
		rect(ctx, pal.pot, 20, 60, 4, 3);
		rect(ctx, pal.potDark, 20, 62, 4, 1);
		rect(ctx, pal.plantDark, 19, 57, 2, 3);
		rect(ctx, pal.plant, 21, 56, 2, 4);
		rect(ctx, pal.plantDark, 23, 58, 1, 2);
		rect(ctx, pal.plant, 18, 58, 1, 1);
		rect(ctx, pal.mug, 41, 60, 3, 3);
		rect(ctx, pal.mugShade, 43, 60, 1, 3);
		rect(ctx, pal.mug, 44, 61, 1, 1);

		sprite(ctx, pal, DEVELOPER.legend, DEVELOPER.rows, DEVELOPER.x, DEVELOPER.y);

		// Stone footing.
		rect(ctx, pal.stoneDark, 1, 72, 50, 4);
		for (let row = 0; row < 2; row++) {
			for (let x = 1 + row * 3; x < 50; x += 6) {
				rect(ctx, pal.stone, x, 72 + row * 2, Math.min(5, 51 - x), 1);
				rect(ctx, pal.stoneLight, x, 72 + row * 2, 1, 1);
			}
		}
	}

	// --- The data center: a cut-away hall --------------------------------------------------------------

	function drawCooler(ctx, pal, x) {
		const y = 37;
		rect(ctx, pal.concrete, x, y, 13, 7);
		rect(ctx, pal.concreteLight, x, y, 13, 1);
		rect(ctx, pal.concreteDark, x, y + 6, 13, 1);
		rect(ctx, pal.concreteShade, x + 12, y + 1, 1, 5);
		for (const sx of [x + 1, x + 10]) {
			rect(ctx, pal.concreteDark, sx, y + 2, 2, 1);
			rect(ctx, pal.concreteDark, sx, y + 4, 2, 1);
		}
		drawFanHousing(ctx, pal, x);
		drawFan(ctx, pal, x, false);
	}

	function drawFanHousing(ctx, pal, x) {
		const y = 37;
		rect(ctx, pal.metalDark, x + 4, y + 1, 5, 1);
		rect(ctx, pal.metalDark, x + 4, y + 5, 5, 1);
		rect(ctx, pal.metalDark, x + 3, y + 2, 1, 3);
		rect(ctx, pal.metalDark, x + 9, y + 2, 1, 3);
		rect(ctx, pal.metalDeep, x + 4, y + 2, 5, 3);
	}

	// Fan blades: '+' at rest, 'x' on alternate frames while spinning.
	function drawFan(ctx, pal, x, turned) {
		const cx = x + 6;
		const cy = 40;
		if (turned) {
			for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [-2, -1], [2, 1]]) {
				rect(ctx, pal.metal, cx + dx, cy + dy, 1, 1);
			}
		} else {
			rect(ctx, pal.metal, cx - 2, cy, 5, 1);
			rect(ctx, pal.metal, cx, cy - 1, 1, 3);
		}
		rect(ctx, pal.metalLight, cx, cy, 1, 1);
	}

	function drawRack(ctx, pal, x) {
		rect(ctx, pal.rack, x, 52, 7, 18);
		rect(ctx, pal.rackCap, x, 52, 7, 1);
		for (const y of UNIT_Y) {
			rect(ctx, pal.unit, x + 1, y, 5, 1);
			rect(ctx, pal.unitShade, x + 1, y + 1, 5, 1);
			rect(ctx, pal.unitShade, x + 1, y, 1, 1);
			ditherRow(ctx, pal.rack, x + 3, x + 6, y + 1, 2, 0);
		}
		rect(ctx, pal.unitShade, x + 1, 69, 5, 1);
		rect(ctx, pal.ledDim, x + 1, UNIT_Y[0], 1, 1);
	}

	function drawDataCenter(ctx, pal) {
		// Hall interior.
		rect(ctx, pal.dcWall, 90, 47, 55, 23);
		for (let x = 98; x < 145; x += 9) {
			rect(ctx, pal.dcSeam, x, 50, 1, 20);
		}
		rect(ctx, pal.trayDark, 90, 47, 55, 1);
		rect(ctx, pal.tray, 90, 48, 55, 1);
		rect(ctx, pal.trayDark, 90, 49, 55, 1);
		for (const x of RACK_X) {
			rect(ctx, pal.trayDark, x + 3, 50, 1, 2);
			rect(ctx, pal.ceilingLamp, x + 2, 47, 3, 1);
		}
		RACK_X.forEach(x => drawRack(ctx, pal, x));
		rect(ctx, pal.tile, 90, 70, 55, 2);
		for (let x = 92; x < 145; x += 4) {
			rect(ctx, pal.tileSeam, x, 70, 1, 2);
		}

		// Concrete shell: posts, roof slab, footing (outside, tinted with the hour).
		for (const x of [86, 145]) {
			rect(ctx, pal.concrete, x, 47, 4, 25);
			rect(ctx, pal.concreteLight, x, 47, 1, 25);
			rect(ctx, pal.concreteShade, x + 3, 47, 1, 25);
		}
		rect(ctx, pal.concreteDark, 84, 44, 67, 3);
		rect(ctx, pal.concreteLight, 84, 44, 67, 1);
		rect(ctx, pal.concrete, 84, 45, 67, 1);
		rect(ctx, pal.concreteDark, 85, 72, 65, 4);
		for (let x = 85; x < 150; x += 8) {
			rect(ctx, pal.concreteShade, x, 72, 7, 1);
		}

		// Status lamp housing and cable entry.
		const lamp = GEOMETRY.lamp;
		rect(ctx, pal.metalDark, lamp.x - 1, lamp.y - 1, 4, 4);
		rect(ctx, pal.lampOff, lamp.x, lamp.y, 2, 2);
		rect(ctx, pal.metalDark, 85, 49, 1, 3);
		for (const [x, y] of LINK) {
			if (x >= 86 && x <= 89) {
				rect(ctx, pal.cable, x, y, 1, 1);
			}
		}

		COOLERS.forEach(x => drawCooler(ctx, pal, x));
	}

	function drawTank(ctx, pal) {
		// Legs and bracing first, then the tank body.
		rect(ctx, pal.metalDark, 151, 55, 1, GROUND_Y - 55);
		rect(ctx, pal.metalDark, 157, 55, 1, GROUND_Y - 55);
		for (let i = 0; i < 6; i++) {
			rect(ctx, pal.metal, 152 + i, 58 + i, 1, 1);
			rect(ctx, pal.metal, 156 - i, 58 + i, 1, 1);
			rect(ctx, pal.metal, 152 + i, 66 + i, 1, 1);
			rect(ctx, pal.metal, 156 - i, 66 + i, 1, 1);
		}
		disc(ctx, pal.tankDark, 154, 34, [3, 7, 9]);
		rect(ctx, pal.tankShade, 153, 34, 1, 1);
		rect(ctx, pal.tankShade, 151, 35, 3, 1);
		rect(ctx, pal.tank, 150, 37, 9, 18);
		rect(ctx, pal.tankLight, 151, 37, 1, 18);
		rect(ctx, pal.tankShade, 156, 37, 2, 18);
		rect(ctx, pal.tankDark, 158, 37, 1, 18);
		rect(ctx, pal.tankDark, 150, 43, 9, 1);
		rect(ctx, pal.tankDark, 150, 51, 9, 1);
		rect(ctx, pal.tankDark, 150, 54, 9, 1);
		// Water drop emblem.
		disc(ctx, pal.tankMark, 154, 44, [1, 1, 3, 5, 5, 3]);
		rect(ctx, pal.tankLight, 153, 47, 1, 2);
		// Feed pipe to the nearest cooler.
		rect(ctx, pal.pipeLight, 138, 40, 12, 1);
		rect(ctx, pal.pipeDark, 138, 41, 12, 1);
		rect(ctx, pal.pipeDark, 149, 39, 1, 4);
	}

	// Everything static, in logical pixels; the caller sets the integer scale transform.
	function drawBackground(ctx, phase) {
		const p = PHASES.includes(phase) ? phase : 'day';
		const pal = palette(p);
		drawSky(ctx, pal);
		drawCelestial(ctx, pal, p);
		drawMountains(ctx, pal);
		drawHills(ctx, pal);
		drawTreeline(ctx, pal);
		drawMeadow(ctx, pal);
		drawGround(ctx, pal);
		drawForeground(ctx, pal);
		drawGrassTufts(ctx, pal);
	}

	function drawForeground(ctx, pal) {
		drawTree(ctx, pal, 78, 73);
		drawBush(ctx, pal, 55, 75);
		drawHouse(ctx, pal);
		drawDataCenter(ctx, pal);
		drawTank(ctx, pal);
		drawPole(ctx, pal);
		drawWire(ctx, pal);
	}

	// Pixels covered by buildings, trees and the pole, so far-away effects (haze) stay behind them.
	function buildOcclusion() {
		const bits = new Uint8Array(WIDTH * HEIGHT);
		const mask = {
			fillStyle: '',
			fillRect(x, y, w, h) {
				for (let yy = Math.max(0, y); yy < Math.min(HEIGHT, y + h); yy++) {
					for (let xx = Math.max(0, x); xx < Math.min(WIDTH, x + w); xx++) {
						bits[yy * WIDTH + xx] = 1;
					}
				}
			},
		};
		drawForeground(mask, PALETTES.day);
		return bits;
	}

	const OCCLUSION = buildOcclusion();

	function occluded(x, y) {
		return x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT || OCCLUSION[y * WIDTH + x] === 1;
	}

	window.CarbonBitScene = Object.freeze({
		WIDTH,
		HEIGHT,
		PHASES,
		P: PALETTES.day,
		PALETTES,
		GEOMETRY,
		phaseOf,
		palette,
		rect,
		hash,
		bayerRow,
		sprite,
		lobe,
		occluded,
		drawBackground,
		drawFan,
		drawFanHousing,
	});
})();
