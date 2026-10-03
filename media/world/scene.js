// "Pale Blue Pixel": the static parts of the world. A starfield, a small pixel Earth seen from
// space with real day and night, drifting clouds, city lights and the moon in its real phase.
// Everything is drawn with integer fillRect runs from a limited palette and ordered dithering.
(function () {
	'use strict';

	const WIDTH = 160;
	const HEIGHT = 90;
	const CX = 80;
	const CY = 47;
	const R = 37;
	const MOON = Object.freeze({ x: 138, y: 15, r: 5 });

	const P = Object.freeze({
		space0: '#060a18', space1: '#0b1330', space2: '#14204a',
		star: '#eef3ff', starDim: '#6f7fae', starBlue: '#9cc8ff',
		oceanShallow: '#3f8fd0', ocean: '#2a6cb3', oceanDeep: '#1c4c8c', oceanNight: '#0a1a38',
		grass: '#5ba344', grassDark: '#3f8233', forest: '#2f6d34', forestDark: '#225126', jungle: '#3f8f2c',
		desert: '#dcb86c', desertDark: '#b38e4c', ice: '#eef4f8', iceShade: '#b4c6d6',
		landNight: '#0e2117', desertNight: '#272215', iceNight: '#28324c',
		cloud: '#f5f8fc', cloudShade: '#c4d0df', cloudNight: '#222d49',
		city: '#ffd27a', atmo: '#8fd6ff', atmoDim: '#3c78b4',
		moon: '#ece6cf', moonShade: '#a49d86', moonDark: '#1f2540',
	});

	// 4x4 ordered dither thresholds in [0, 1).
	const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
	function bayer(x, y) {
		return BAYER[(y & 3) * 4 + (x & 3)];
	}

	function hash(a, b) {
		let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
		h = Math.imul(h ^ (h >>> 13), 1274126177);
		return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
	}

	// ---- Earth map: coarse continents as [lon, lat] polygons, rasterised to 2-degree cells. ----
	const LAND = [
		// North America
		[[-168, 66], [-162, 70], [-156, 71.5], [-140, 70], [-128, 70], [-115, 68], [-95, 69], [-85, 70], [-80, 63], [-90, 58], [-95, 60],
			[-82, 53], [-79, 52], [-75, 62], [-65, 60], [-60, 55], [-56, 52], [-60, 47], [-66, 44], [-70, 42], [-74, 40], [-76, 35], [-81, 31],
			[-80, 25], [-83, 29], [-89, 30], [-95, 29], [-97, 26], [-97, 22], [-94, 18], [-90, 21], [-87, 21], [-88, 16], [-84, 15], [-83, 10],
			[-79, 9], [-80, 7], [-85, 10], [-92, 14], [-96, 16], [-105, 20], [-112, 28], [-117, 32], [-121, 35], [-124, 40], [-124, 46],
			[-123, 49], [-130, 55], [-136, 58], [-145, 60], [-152, 59], [-158, 57], [-165, 55], [-160, 59], [-165, 62]],
		[[-80, 63], [-62, 66], [-70, 71], [-80, 73], [-90, 72]],
		[[-90, 76], [-62, 82], [-80, 83], [-95, 80]],
		[[-118, 69], [-102, 69], [-102, 73], [-118, 73]],
		[[-85, 22], [-80, 23], [-74, 20], [-78, 20]],
		// South America
		[[-80, 9], [-75, 11], [-63, 11], [-52, 5], [-50, 0], [-35, -5], [-35, -9], [-39, -14], [-41, -22], [-48, -26], [-53, -34], [-58, -38],
			[-65, -41], [-66, -47], [-69, -52], [-73, -53], [-75, -47], [-73, -38], [-71, -30], [-70, -18], [-76, -14], [-81, -5], [-80, 0],
			[-78, 3], [-77, 7]],
		// Eurasia
		[[-9, 43], [-9, 37], [-5, 36], [0, 38], [3, 42], [8, 44], [12, 42], [16, 38], [18, 40], [13, 45], [19, 42], [23, 37], [26, 40], [29, 41],
			[36, 36], [35, 32], [34, 28], [39, 22], [43, 13], [52, 16], [57, 19], [59, 22], [56, 26], [52, 24], [48, 30], [50, 30], [57, 26],
			[62, 25], [67, 25], [73, 21], [77, 8], [80, 13], [80, 16], [87, 22], [92, 22], [94, 17], [98, 16], [98, 8], [103, 1], [104, 1.5],
			[101, 7], [100, 13], [105, 9], [109, 12], [108, 16], [106, 20], [110, 21], [117, 23], [121, 28], [122, 31], [120, 36], [122, 37],
			[118, 38], [121, 40], [125, 40], [127, 35], [129, 35], [130, 43], [135, 44], [140, 48], [141, 53], [137, 54], [143, 59], [155, 59],
			[156, 51], [163, 57], [163, 61], [170, 60], [180, 65], [180, 69], [170, 70], [160, 71], [150, 72], [140, 73], [130, 71], [120, 73],
			[113, 74], [105, 78], [95, 76], [87, 75], [80, 73], [70, 73], [67, 69], [60, 69], [55, 68], [45, 68], [40, 66], [35, 69], [28, 71],
			[20, 70], [15, 68], [12, 65], [8, 63], [5, 61], [5, 58], [8, 58], [10, 59], [12, 56], [10, 55], [9, 57], [8, 54], [4, 52], [2, 51],
			[-2, 48], [-4, 48], [-1, 46], [-2, 43.5]],
		[[-5, 50], [1, 51], [2, 53], [-1, 55], [-2, 58], [-5, 58.5], [-6, 56], [-5, 54], [-3, 53], [-5, 52]],
		[[-10, 52], [-6, 52], [-6, 55], [-8, 55], [-10, 54]],
		[[-24, 64], [-22, 66], [-14, 66], [-14, 64], [-20, 63.5]],
		[[130, 31], [132, 34], [136, 34], [140, 35], [141, 38], [142, 42], [145, 44], [141, 45], [140, 41], [139, 38], [136, 37], [133, 35], [130, 34]],
		[[95, 5], [98, 4], [106, -6], [104, -5], [96, 3]],
		[[109, 1], [111, -3], [116, -4], [119, 1], [117, 7], [115, 5]],
		[[105, -6], [114, -7], [114, -8.5], [106, -7]],
		[[131, -1], [141, -3], [150, -10], [143, -9], [138, -8], [132, -4]],
		[[120, 18], [122, 18], [126, 7], [122, 7], [120, 12]],
		// Africa
		[[-17, 21], [-16, 28], [-10, 30], [-6, 36], [0, 36], [10, 37], [11, 34], [20, 31], [25, 32], [32, 31], [34, 28], [37, 20], [43, 12],
			[51, 12], [48, 5], [40, -3], [40, -11], [35, -20], [33, -26], [28, -33], [20, -35], [18, -32], [12, -18], [13, -10], [9, -1], [9, 4],
			[4, 6], [-5, 5], [-10, 6], [-15, 11], [-17, 15]],
		[[44, -25], [47, -25], [50, -15], [49, -12], [44, -17]],
		// Oceania
		[[114, -22], [114, -34], [118, -35], [124, -34], [131, -31], [135, -35], [138, -35], [141, -38], [146, -39], [150, -37], [153, -31],
			[153, -25], [150, -22], [146, -19], [145, -15], [142, -11], [141, -17], [136, -12], [132, -11], [130, -15], [125, -15], [122, -18], [118, -20]],
		[[172, -34], [178, -38], [176, -41], [171, -46], [167, -46], [171, -41], [174, -38]],
	];
	const WATER = [
		[[47, 45], [53, 45], [54, 40], [53, 37], [50, 37], [49, 40]],
		[[28, 45], [33, 46], [38, 47], [41, 42], [36, 41], [29, 41]],
	];
	const ICE = [
		[[-73, 78], [-60, 82], [-30, 83], [-20, 80], [-20, 72], [-30, 68], [-42, 60], [-50, 64], [-55, 70], [-68, 76]],
		[[-180, -90], [180, -90], [180, -70], [150, -68], [120, -66], [90, -66], [60, -67], [30, -69], [0, -70], [-30, -75], [-60, -73],
			[-60, -64], [-65, -66], [-75, -72], [-100, -73], [-140, -76], [-180, -78]],
	];
	const DESERT = [
		[[-15, 18], [-15, 28], [0, 31], [30, 31], [35, 22], [35, 15], [15, 15], [0, 16]],
		[[36, 30], [47, 30], [56, 22], [52, 17], [43, 17], [38, 24]],
		[[55, 45], [75, 45], [110, 45], [110, 40], [90, 37], [60, 37]],
		[[118, -20], [135, -18], [143, -25], [140, -32], [122, -30]],
		[[-118, 35], [-104, 35], [-104, 28], [-112, 28]],
	];
	const CITIES = [
		[-74, 41], [-118, 34], [-88, 42], [-79, 44], [-99, 19], [-47, -24], [-58, -35], [-74, 5], [-77, -12], [0, 51], [2, 49], [-4, 40],
		[13, 52], [12, 42], [37, 56], [29, 41], [31, 30], [3, 6], [28, -26], [37, -1], [55, 25], [51, 36], [67, 25], [77, 29], [73, 19],
		[88, 23], [90, 24], [100, 14], [104, 1], [107, -6], [121, 15], [121, 31], [116, 40], [127, 37], [140, 36], [135, 35], [151, -34],
		[145, -38], [-122, 47], [-95, 30], [-84, 34], [-122, 38], [-80, 26], [114, 22], [104, 31], [74, 31], [9, 45], [19, 50], [-43, -23],
	];

	const COLS = 180;
	const ROWS = 90;
	const T = Object.freeze({ deep: 0, shallow: 1, grass: 2, grassVar: 3, forest: 4, jungle: 5, desert: 6, ice: 7 });
	// [lit, shade, night] per surface type, then clouds.
	const SHADES = [
		[P.ocean, P.oceanDeep, P.oceanNight],
		[P.oceanShallow, P.ocean, P.oceanNight],
		[P.grass, P.grassDark, P.landNight],
		[P.grassDark, P.forest, P.landNight],
		[P.forest, P.forestDark, P.landNight],
		[P.jungle, P.forest, P.landNight],
		[P.desert, P.desertDark, P.desertNight],
		[P.ice, P.iceShade, P.iceNight],
	];
	const CLOUD_SHADES = [P.cloud, P.cloudShade, P.cloudNight];

	function inPolygon(lon, lat, poly) {
		let inside = false;
		for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
			const [xi, yi] = poly[i];
			const [xj, yj] = poly[j];
			if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
				inside = !inside;
			}
		}
		return inside;
	}

	function boxed(polys) {
		return polys.map(poly => ({
			poly,
			minLon: Math.min(...poly.map(p => p[0])), maxLon: Math.max(...poly.map(p => p[0])),
			minLat: Math.min(...poly.map(p => p[1])), maxLat: Math.max(...poly.map(p => p[1])),
		}));
	}

	function inAny(lon, lat, polys) {
		return polys.some(b => lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat && inPolygon(lon, lat, b.poly));
	}

	function cellIndex(lon, lat) {
		const wrapped = ((((lon + 180) % 360) + 360) % 360);
		const col = Math.min(COLS - 1, Math.floor(wrapped / 2));
		const row = Math.min(ROWS - 1, Math.max(0, Math.floor((90 - lat) / 2)));
		return row * COLS + col;
	}

	function buildMap() {
		const land = boxed(LAND);
		const water = boxed(WATER);
		const ice = boxed(ICE);
		const desert = boxed(DESERT);
		const isLand = new Uint8Array(COLS * ROWS);
		for (let row = 0; row < ROWS; row++) {
			const lat = 89 - row * 2;
			for (let col = 0; col < COLS; col++) {
				const lon = -179 + col * 2;
				isLand[row * COLS + col] = (inAny(lon, lat, land) && !inAny(lon, lat, water)) || inAny(lon, lat, ice) ? 1 : 0;
			}
		}
		const types = new Uint8Array(COLS * ROWS);
		for (let row = 0; row < ROWS; row++) {
			const lat = 89 - row * 2;
			for (let col = 0; col < COLS; col++) {
				const lon = -179 + col * 2;
				const i = row * COLS + col;
				if (!isLand[i]) {
					let coast = false;
					for (let dr = -1; dr <= 1 && !coast; dr++) {
						for (let dc = -1; dc <= 1 && !coast; dc++) {
							const r = row + dr;
							coast = r >= 0 && r < ROWS && isLand[r * COLS + ((col + dc + COLS) % COLS)] === 1;
						}
					}
					types[i] = coast ? T.shallow : T.deep;
				} else if (inAny(lon, lat, ice) || Math.abs(lat) >= 72) {
					types[i] = T.ice;
				} else if (inAny(lon, lat, desert)) {
					types[i] = T.desert;
				} else if (lat > 52) {
					types[i] = T.forest;
				} else if (Math.abs(lat) < 12) {
					types[i] = T.jungle;
				} else {
					types[i] = hash(col, row) < 0.3 ? T.grassVar : T.grass;
				}
			}
		}
		return types;
	}

	// Value noise that wraps around the globe, weighted by latitude: wet tropics and
	// mid-latitude storm tracks, drier subtropics. 0 = clear, 1 = thin, 2 = dense.
	function buildClouds() {
		function lattice(spacing, salt) {
			const cols = COLS / spacing;
			return (row, col) => {
				const fy = row / spacing;
				const fx = col / spacing;
				const y0 = Math.floor(fy);
				const x0 = Math.floor(fx);
				const ty = fy - y0;
				const tx = fx - x0;
				const v = (y, x) => hash(((x % cols) + cols) % cols + salt, y + salt * 7);
				const sy = ty * ty * (3 - 2 * ty);
				const sx = tx * tx * (3 - 2 * tx);
				const top = v(y0, x0) * (1 - sx) + v(y0, x0 + 1) * sx;
				const bottom = v(y0 + 1, x0) * (1 - sx) + v(y0 + 1, x0 + 1) * sx;
				return top * (1 - sy) + bottom * sy;
			};
		}
		const coarse = lattice(10, 11);
		const fine = lattice(5, 29);
		const finer = lattice(3, 47);
		const field = new Uint8Array(COLS * ROWS);
		for (let row = 0; row < ROWS; row++) {
			const lat = Math.abs(89 - row * 2);
			const weight = 0.55 + 0.3 * Math.exp(-((lat / 9) ** 2)) + 0.25 * Math.exp(-(((lat - 55) / 12) ** 2)) - 0.2 * Math.exp(-(((lat - 24) / 8) ** 2));
			for (let col = 0; col < COLS; col++) {
				const n = (0.55 * coarse(row, col) + 0.3 * fine(row, col) + 0.15 * finer(row, col)) * weight;
				field[row * COLS + col] = n > 0.47 ? 2 : n > 0.42 ? 1 : 0;
			}
		}
		return field;
	}

	const MAP = buildMap();
	const CLOUDS = buildClouds();
	const CITY_CELLS = new Set(CITIES.map(([lon, lat]) => cellIndex(lon, lat)));

	// ---- Sun and moon from the wall clock (simple almanac, good to about a degree). ----
	const DEG = Math.PI / 180;
	const DAY_MS = 86_400_000;
	function sunAt(epoch) {
		const date = new Date(epoch);
		const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
		const dayOfYear = (epoch - startOfYear) / DAY_MS;
		const declination = -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
		const utcHours = (epoch % DAY_MS) / 3_600_000;
		return { lat: declination, lon: -15 * (utcHours - 12) };
	}

	const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);
	const SYNODIC_MS = 29.530588853 * DAY_MS;
	function moonPhaseAt(epoch) {
		return ((((epoch - NEW_MOON_EPOCH) % SYNODIC_MS) + SYNODIC_MS) % SYNODIC_MS) / SYNODIC_MS;
	}

	function unit(lat, lon) {
		return [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];
	}

	// ---- Where things are. `place` is the viewer's approximate position from the timezone. ----
	const DEFAULT_PLACE = Object.freeze({ lon: 0, south: false });
	// Regions where large cloud data centers cluster. The hub is drawn at the one about a fifth of the
	// way round the planet from you, preferring east or west, so the arc reads well; it is illustrative, not where your
	// requests actually ran.
	const HUB_REGIONS = [
		[-77, 39], [-120, 45], [-94, 41], [-6, 53], [8, 50], [5, 52], [104, 1], [140, 36], [151, -34], [73, 19], [-47, -23], [28, -26],
	];
	const HUB_DISTANCE = 70;
	// East-west pairs make cleaner arcs than north-south ones.
	const HUB_LATITUDE_WEIGHT = 0.6;
	const ARC_SAMPLES = 40;
	const ARC_LIFT = 0.15;
	// Screen-space arch on top of the 3D lift, like a flight path drawn on a map.
	const ARC_ARCH = 17;
	const geometries = new Map();

	function placeOf(place) {
		const lon = place && Number.isFinite(place.lon) ? Math.round(Math.max(-180, Math.min(180, place.lon))) : 0;
		return { lon, south: Boolean(place && place.south) };
	}

	function geometry(rawPlace) {
		const place = placeOf(rawPlace);
		const key = `${place.lon}:${place.south}`;
		if (geometries.has(key)) {
			return geometries.get(key);
		}
		const youLat = place.south ? -33 : 46;
		const a = unit(youLat, place.lon);
		const angle = (v, w) => Math.acos(Math.max(-1, Math.min(1, v[0] * w[0] + v[1] * w[1] + v[2] * w[2]))) / DEG;
		const hub = HUB_REGIONS
			.map(([lon, lat]) => ({ lon, lat, off: Math.abs(angle(a, unit(lat, lon)) - HUB_DISTANCE) + HUB_LATITUDE_WEIGHT * Math.abs(lat - youLat) }))
			.reduce((best, region) => (region.off < best.off ? region : best));
		const b = unit(hub.lat, hub.lon);
		// Look at the midpoint of you and the hub, tilted a little toward your pole.
		const mid = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
		const lon0 = Math.atan2(mid[1], mid[0]) / DEG;
		const lat0 = Math.asin(mid[2] / Math.hypot(...mid)) / DEG + (place.south ? -6 : 6);
		const sin0 = Math.sin(lat0 * DEG);
		const cos0 = Math.cos(lat0 * DEG);

		function project(v, lift) {
			const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
			const dLon = Math.atan2(v[1], v[0]) - lon0 * DEG;
			const cl = Math.cos(lat * DEG);
			const x = cl * Math.sin(dLon);
			const y = cos0 * Math.sin(lat * DEG) - sin0 * cl * Math.cos(dLon);
			return { x: Math.floor(CX + x * R * lift), y: Math.floor(CY - y * R * lift) };
		}

		// Inverse orthographic projection, once per pixel of the disk.
		const surface = [];
		const rim = [];
		for (let py = CY - R - 2; py <= CY + R + 2; py++) {
			for (let px = CX - R - 2; px <= CX + R + 2; px++) {
				const dx = (px + 0.5 - CX) / R;
				const dy = (py + 0.5 - CY) / R;
				const r2 = dx * dx + dy * dy;
				if (r2 <= 1) {
					const X = dx;
					const Y = -dy;
					const Z = Math.sqrt(1 - r2);
					const lat = Math.asin(Z * sin0 + Y * cos0) / DEG;
					const lon = lon0 + Math.atan2(X, Z * cos0 - Y * sin0) / DEG;
					surface.push({ x: px, y: py, z: Z, lat, lon, normal: unit(lat, lon), cell: cellIndex(lon, lat) });
				} else if (r2 <= ((R + 1.3) / R) ** 2) {
					const len = Math.sqrt(r2);
					const X = dx / len;
					const Y = -dy / len;
					const lat = Math.asin(Y * cos0) / DEG;
					const lon = lon0 + Math.atan2(X, -Y * sin0) / DEG;
					rim.push({ x: px, y: py, normal: unit(lat, lon), outer: r2 > ((R + 0.6) / R) ** 2 });
				}
			}
		}

		const omega = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
		// The arch bulges sideways from the chord, on the side facing away from the planet's centre
		// (upwards when the chord runs through it), so the arc always lifts off the surface.
		const start = project(a, 1);
		const end = project(b, 1);
		const chord = Math.hypot(end.x - start.x, end.y - start.y) || 1;
		let nx = (end.y - start.y) / chord;
		let ny = (start.x - end.x) / chord;
		const flip = Math.abs(ny) > 0.5 ? ny > 0 : nx * ((start.x + end.x) / 2 - CX) < 0 || (nx < 0 && Math.abs((start.x + end.x) / 2 - CX) < 1);
		if (flip) {
			nx = -nx;
			ny = -ny;
		}
		const arc = [];
		for (let i = 0; i <= ARC_SAMPLES; i++) {
			const u = i / ARC_SAMPLES;
			const wa = Math.sin((1 - u) * omega) / Math.sin(omega);
			const wb = Math.sin(u * omega) / Math.sin(omega);
			const lifted = project([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb], 1 + ARC_LIFT * Math.sin(Math.PI * u));
			const bump = ARC_ARCH * Math.sin(Math.PI * u);
			const point = { x: lifted.x + Math.round(nx * bump), y: lifted.y + Math.round(ny * bump) };
			const last = arc[arc.length - 1];
			if (!last || last.x !== point.x || last.y !== point.y) {
				arc.push(point);
			}
		}
		const result = Object.freeze({ place, surface, rim, arc: Object.freeze(arc), you: arc[0], hub: arc[arc.length - 1] });
		geometries.set(key, result);
		return result;
	}

	// ---- Drawing ----
	// Consecutive pixels of one colour on a row become one rect.
	function createRuns(ctx) {
		let color = null;
		let x0 = 0;
		let y0 = 0;
		let x1 = 0;
		function flush() {
			if (color !== null) {
				ctx.fillStyle = color;
				ctx.fillRect(x0, y0, x1 - x0, 1);
			}
			color = null;
		}
		return {
			put(x, y, c) {
				if (c === color && y === y0 && x === x1) {
					x1++;
					return;
				}
				flush();
				color = c;
				x0 = x;
				y0 = y;
				x1 = x + 1;
			},
			flush,
		};
	}

	const STARS = (() => {
		const stars = [];
		for (let i = 0; stars.length < 46 && i < 400; i++) {
			const x = Math.floor(hash(i, 3) * WIDTH);
			const y = Math.floor(hash(i, 5) * HEIGHT);
			const near = (x + 0.5 - CX) ** 2 + (y + 0.5 - CY) ** 2 < (R + 5) ** 2;
			const moon = Math.abs(x - MOON.x) < 9 && Math.abs(y - MOON.y) < 9;
			if (!near && !moon) {
				const kind = hash(i, 9);
				stars.push({ x, y, color: kind < 0.15 ? P.starBlue : kind < 0.45 ? P.star : P.starDim, big: kind > 0.96 });
			}
		}
		return Object.freeze(stars);
	})();

	// Space: two dithered bands of night and a faint glow hugging the planet; then the stars.
	function drawBackground(ctx) {
		ctx.fillStyle = P.space0;
		ctx.fillRect(0, 0, WIDTH, HEIGHT);
		const runs = createRuns(ctx);
		for (let y = 0; y < HEIGHT; y++) {
			for (let x = 0; x < WIDTH; x++) {
				const d = Math.sqrt((x + 0.5 - CX) ** 2 + (y + 0.5 - CY) ** 2) - R;
				const glow = d < 6 ? 1 - d / 6 : 0;
				const band = y / HEIGHT;
				let c = null;
				if (glow > bayer(x, y) * 1.2) {
					c = glow > 0.6 ? P.space2 : P.space1;
				} else if (band > 0.55 + bayer(x, y) * 0.5) {
					c = P.space1;
				}
				if (c) {
					runs.put(x, y, c);
				}
			}
		}
		runs.flush();
		for (const star of STARS) {
			ctx.fillStyle = star.color;
			ctx.fillRect(star.x, star.y, 1, 1);
			if (star.big) {
				ctx.fillStyle = P.starDim;
				ctx.fillRect(star.x - 1, star.y, 1, 1);
				ctx.fillRect(star.x + 1, star.y, 1, 1);
				ctx.fillRect(star.x, star.y - 1, 1, 1);
				ctx.fillRect(star.x, star.y + 1, 1, 1);
			}
		}
	}

	// Light bands: lit, shade and night, with dithered edges at the terminator.
	function band(s, x, y, z) {
		let level;
		if (s > 0.3) {
			level = 0;
		} else if (s > 0.08) {
			level = (s - 0.08) / 0.22 > bayer(x, y) ? 0 : 1;
		} else if (s > -0.1) {
			level = (s + 0.1) / 0.18 > bayer(x, y) ? 1 : 2;
		} else {
			level = 2;
		}
		// The limb is one step darker, which rounds the sphere.
		return level === 0 && z < 0.24 ? 1 : level;
	}

	const CLOUD_MS_PER_DEGREE = 6000;
	// The globe changes slowly (sun 1 degree per 4 minutes, clouds 1 degree per 6 seconds).
	const GLOBE_STEP_MS = 4000;

	function globeKey(epoch) {
		return Math.floor(epoch / GLOBE_STEP_MS);
	}

	function drawGlobe(ctx, epoch, rawPlace) {
		const geo = geometry(rawPlace);
		const at = globeKey(epoch) * GLOBE_STEP_MS;
		const sun = unit(sunAt(at).lat, sunAt(at).lon);
		const drift = Math.floor(at / CLOUD_MS_PER_DEGREE / 2) % COLS;
		const runs = createRuns(ctx);
		for (const p of geo.surface) {
			const n = p.normal;
			const s = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
			const level = band(s, p.x, p.y, p.z);
			const row = Math.floor(p.cell / COLS);
			const col = p.cell % COLS;
			const cloud = CLOUDS[row * COLS + ((col - drift + COLS) % COLS)];
			let color;
			if (cloud === 2) {
				color = CLOUD_SHADES[level];
			} else if (cloud === 1 && bayer(p.x, p.y) < 0.75) {
				// Thin cloud edges: one step greyer, so clouds read soft instead of checkered.
				color = CLOUD_SHADES[Math.min(2, level + 1)];
			} else if (level === 2 && s < -0.06 && CITY_CELLS.has(p.cell)) {
				color = P.city;
			} else {
				color = SHADES[MAP[p.cell]][level];
			}
			runs.put(p.x, p.y, color);
		}
		runs.flush();
		for (const p of geo.rim) {
			const n = p.normal;
			const s = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
			if (s > 0.05 && !p.outer) {
				ctx.fillStyle = P.atmo;
				ctx.fillRect(p.x, p.y, 1, 1);
			} else if (s > -0.2 && (!p.outer || bayer(p.x, p.y) < 0.5)) {
				ctx.fillStyle = P.atmoDim;
				ctx.fillRect(p.x, p.y, 1, 1);
			}
		}
		drawMoon(ctx, moonPhaseAt(at));
	}

	function drawMoon(ctx, phase) {
		const runs = createRuns(ctx);
		const lit = Math.cos(2 * Math.PI * phase);
		for (let y = MOON.y - MOON.r; y <= MOON.y + MOON.r; y++) {
			for (let x = MOON.x - MOON.r; x <= MOON.x + MOON.r; x++) {
				const mx = (x + 0.5 - MOON.x) / MOON.r;
				const my = (y + 0.5 - MOON.y) / MOON.r;
				if (mx * mx + my * my > 1) {
					continue;
				}
				const w = Math.sqrt(1 - my * my);
				const on = phase < 0.5 ? mx > lit * w : mx < -lit * w;
				const crater = (x - MOON.x === -2 && y - MOON.y === -1) || (x - MOON.x === 1 && y - MOON.y === 2) || (x - MOON.x === 2 && y - MOON.y === -2);
				runs.put(x, y, on ? (crater ? P.moonShade : P.moon) : P.moonDark);
			}
		}
		runs.flush();
	}

	window.CarbonBitScene = Object.freeze({
		WIDTH, HEIGHT, CX, CY, R, P, MOON, STARS, GLOBE_STEP_MS, DEFAULT_PLACE,
		bayer, hash, createRuns, geometry, sunAt, moonPhaseAt, globeKey, drawBackground, drawGlobe,
		// Exposed for tests: the land/ocean map and city cells.
		MAP, COLS, ROWS, cellIndex,
	});
})();
