// Pixel icons for the everyday comparisons, drawn as crisp SVG rects so they match the world.
// 12x12 grids: `o` is the outline and follows the theme text colour; letters map to PALETTE; `.` is empty.
(function () {
	'use strict';

	const SVG_NS = 'http://www.w3.org/2000/svg';
	const SIZE = 12;
	const PALETTE = Object.freeze({
		r: '#d65a4a', R: '#9c3b31', y: '#f2c14e', w: '#bfe3f0', b: '#4b8fc4', B: '#2f6592',
		s: '#b9c2cc', S: '#7f8a96', t: '#9a6a3c', T: '#d9b48a', c: '#6cc4dc', C: '#3a93b5',
		W: '#eef3f6', g: '#7cbf6b', G: '#4f8f45', p: '#8a74c9', k: '#5b6470',
	});

	const ICONS = Object.freeze({
		car: [
			'............',
			'............',
			'...oooooo...',
			'..owwowwwo..',
			'.orrrrrrrro.',
			'orrrrrrrrrro',
			'oyrrrrrrrrRo',
			'oRRRRRRRRRRo',
			'ooSSooooSSoo',
			'.oSSo..oSSo.',
			'..oo....oo..',
			'............',
		],
		train: [
			'..oooooooo..',
			'.obbbbbbbbo.',
			'.owwwwwwwwo.',
			'.owwwwwwwwo.',
			'.obbbbbbbbo.',
			'.obybbbbybo.',
			'.oBBBBBBBBo.',
			'..oooooooo..',
			'...o....o...',
			'..o......o..',
			'.o........o.',
			'oooooooooooo',
		],
		flight: [
			'............',
			'............',
			'oo....oo....',
			'oSo...oSo...',
			'oSSoooooSoo.',
			'oWWWWWWWWWWo',
			'oWbWbWbWbWWo',
			'.ooooooSooo.',
			'......oSo...',
			'......oo....',
			'............',
			'............',
		],
		kettle: [
			'...k..k.....',
			'....k..k....',
			'....oooo....',
			'..oooSSooo..',
			'.oossssssoo.',
			'oo.ossssso.o',
			'.oossssssoso',
			'..osssssso.o',
			'..osssssssoo',
			'..oSSSSSSSo.',
			'..oooooooo..',
			'............',
		],
		phone: [
			'...oooooo...',
			'..oSSSSSSo..',
			'..oSggggSo..',
			'..oSgSSgSo..',
			'..oSggggSo..',
			'..oSgSSgSo..',
			'..oSggggSo..',
			'..oSSSSSSo..',
			'..oSSooSSo..',
			'...oooooo...',
			'.....oo.....',
			'.....oo.....',
		],
		led: [
			'....oooo....',
			'...oyyyyo...',
			'..oyyWWyyo..',
			'..oyWWyyyo..',
			'..oyyyyyyo..',
			'..oyyyyyyo..',
			'...oyyyyo...',
			'....oyyo....',
			'....oSSo....',
			'....oSSo....',
			'....oSSo....',
			'.....oo.....',
		],
		tea: [
			'....k..k....',
			'.....k..k...',
			'............',
			'.oooooooo...',
			'.oTTTTTTooo.',
			'.otttttto.o.',
			'.otttttto.o.',
			'.oWWWWWWooo.',
			'.oWWWWWWo...',
			'..oWWWWo....',
			'...oooo.....',
			'............',
		],
		shower: [
			'..ooooo.....',
			'.oSo..oo....',
			'.oSo...oo...',
			'.oSo..ooooo.',
			'.oSo.oSSSSSo',
			'.oSo..ooooo.',
			'.oSo..c.c.c.',
			'.oSo.c.c.c..',
			'.oSo..c.c.c.',
			'.oSo.c.c.c..',
			'.oSo..c.c...',
			'.ooo........',
		],
		laundry: [
			'oooooooooooo',
			'oSSSSSoyoSSo',
			'oooooooooooo',
			'oSSSSSSSSSSo',
			'oSSoooooSSSo',
			'oSoccccCoSSo',
			'oSocWccCoSSo',
			'oSoccCCCoSSo',
			'oSSoooooSSSo',
			'oSSSSSSSSSSo',
			'oooooooooooo',
			'.oo......oo.',
		],
		bath: [
			'.oo.........',
			'oSo.........',
			'oo.oo.......',
			'o..oSo......',
			'o..oo.......',
			'o...........',
			'oooooooooooo',
			'ocWcccccWcco',
			'.oCccccccCo.',
			'..oooooooo..',
			'..oS....So..',
			'..oo....oo..',
		],
		dishwasher: [
			'oooooooooooo',
			'oSSSSSSSSyoo',
			'oooooooooooo',
			'oSSSSSSSSSSo',
			'oSoooooooSSo',
			'oSoWcWcWoSSo',
			'oSoWcWcWoSSo',
			'oSoWWWWWoSSo',
			'oSoooooooSSo',
			'oSSSSSSSSSSo',
			'oooooooooooo',
			'.oo......oo.',
		],
		drinking: [
			'...oooooo...',
			'...oSSSSo...',
			'....oooo....',
			'...owwwwo...',
			'..owwwwwwo..',
			'..occcccco..',
			'..occWccco..',
			'..occWccco..',
			'..occccCco..',
			'..occcCCco..',
			'..oCCCCCCo..',
			'...oooooo...',
		],
	});

	// One rect per horizontal run of the same colour keeps the DOM small.
	function runs(rows) {
		const result = [];
		rows.forEach((row, y) => {
			let x = 0;
			while (x < SIZE) {
				const key = row[x];
				let end = x + 1;
				while (end < SIZE && row[end] === key) {
					end++;
				}
				if (key === 'o' || Object.prototype.hasOwnProperty.call(PALETTE, key)) {
					result.push({ x, y, width: end - x, fill: key === 'o' ? 'currentColor' : PALETTE[key] });
				}
				x = end;
			}
		});
		return result;
	}

	function create(doc, id) {
		const rows = ICONS[id];
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
		svg.setAttribute('class', 'pixel-icon');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		svg.setAttribute('shape-rendering', 'crispEdges');
		for (const run of rows ? runs(rows) : []) {
			const rect = doc.createElementNS(SVG_NS, 'rect');
			rect.setAttribute('x', String(run.x));
			rect.setAttribute('y', String(run.y));
			rect.setAttribute('width', String(run.width));
			rect.setAttribute('height', '1');
			rect.setAttribute('fill', run.fill);
			svg.appendChild(rect);
		}
		return svg;
	}

	window.CarbonBitIcons = Object.freeze({ SIZE, ids: Object.freeze(Object.keys(ICONS)), ICONS, create });
})();
