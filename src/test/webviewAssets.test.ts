import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { isHostToWebviewMessage, isWebviewToHostMessage, WORLD_STATES } from '../core/messages/protocol';
import { VISUAL_MODES } from '../core/settings/visualModeSettings';
import { periodView } from '../core/view/sidebarView';
import { createFakeDocument } from './fakeDom';
import { createBrowser, root, WORLD_SCRIPTS } from './fakeBrowser';

const MINUTE = 60_000;
const TOTALS = { energyWh: 0.84, carbonGrams: 0.24, waterLiters: 0.0042, tokens: 124000, requests: 17 };
const PERIODS = (['today', 'last30Days', 'previousMonth', 'projectedYear'] as const).map((id, i) => periodView({
	id,
	totals: { ...TOTALS, carbonGrams: TOTALS.carbonGrams * 10 ** i, waterLiters: TOTALS.waterLiters * 10 ** i },
	from: Date.parse('2026-09-01T12:00:00.000Z'),
	basisDays: id === 'projectedYear' ? 12 : null,
}));
const VIEW = {
	type: 'view',
	live: { providerName: 'Claude Code', model: 'claude-sonnet-4', status: 'processing', tokens: '12K', updatedAt: Date.now() - 5 * MINUTE },
	today: {
		...TOTALS,
		text: { energy: '0.84 Wh', carbon: '0.24 g CO₂e', water: '4.2 ml', tokens: '124K', requests: '17' },
	},
	session: { ...TOTALS, requests: 3, text: { energy: '0.1 Wh', carbon: '0.03 g CO₂e', water: '0.5 ml', tokens: '9K', requests: '3' } },
	periods: PERIODS,
	activity: { bucketMinutes: 2, tokens: [0, 0, 400, 10_000, 0, 2500], summary: '13K tokens in the last 12 minutes' },
	providers: [
		{ id: 'github-copilot', name: 'GitHub Copilot', tokens: 76_000, percent: 61 },
		{ id: 'claude-code', name: 'Claude Code', tokens: 48_000, percent: 39 },
	],
	setup: { firstRun: false, providers: [{ id: 'claude-code', name: 'Claude Code', state: 'tracking' }] },
};

type Listener = (event: { data: unknown }) => void;

// Runs media/icons.js (optional) and media/sidebar.js against minimal DOM/VS Code API stubs.
function loadSidebarScript(world?: unknown, options: { icons?: boolean; state?: unknown } = {}) {
	const posted: unknown[] = [];
	const saved: unknown[] = [];
	const document = createFakeDocument();
	let onMessage: Listener | undefined;
	const window: Record<string, unknown> = {
		CarbonBitWorld: world,
		addEventListener: (type: string, listener: Listener) => {
			if (type === 'message') {
				onMessage = listener;
			}
		},
	};
	const context = vm.createContext({
		acquireVsCodeApi: () => ({
			postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))),
			getState: () => options.state,
			setState: (state: unknown) => saved.push(JSON.parse(JSON.stringify(state))),
		}),
		document,
		window,
	});
	const scripts = [...(options.icons ? ['icons.js'] : []), 'sidebar.js'];
	for (const file of scripts) {
		vm.runInContext(fs.readFileSync(path.join(root, 'media', file), 'utf8'), context, { filename: file });
	}
	return {
		posted,
		saved,
		body: document.body,
		el: (id: string) => document.getElementById(id)!,
		text: (id: string) => document.elements.get(id)?.text,
		send: (data: unknown) => onMessage?.({ data }),
	};
}

suite('Webview assets', () => {
	test('sidebar.js only posts valid webview -> host messages', () => {
		const { posted } = loadSidebarScript();
		assert.deepStrictEqual(posted, [{ type: 'ready' }]);
		assert.ok(posted.every(isWebviewToHostMessage));
		assert.ok(isHostToWebviewMessage(VIEW), 'test fixture follows the protocol');
	});

	test('sidebar.js has its own label for every world state', () => {
		const sidebar = loadSidebarScript();
		for (const worldState of WORLD_STATES) {
			sidebar.send({ type: 'state', worldState, activeCount: 0 });
			const label = sidebar.text('status');
			assert.ok(label, worldState);
			assert.ok(worldState === 'Idle' || label !== 'Idle', `${worldState} falls back to Idle`);
			assert.strictEqual(sidebar.el('now').dataset.state, worldState, 'the status marker follows the world');
		}
		sidebar.send({ type: 'state', worldState: 'ProcessingHeavy', activeCount: 1 });
		assert.strictEqual(sidebar.text('status'), 'Generating\u2026');
	});

	test('sidebar.js renders the selected period as text, today by default, and placeholders without history', () => {
		const sidebar = loadSidebarScript();
		sidebar.send({ ...VIEW });
		assert.strictEqual(sidebar.text('metric-energy'), '0.84 Wh');
		assert.strictEqual(sidebar.text('metric-carbon'), '0.24 g CO\u2082e');
		assert.strictEqual(sidebar.text('metric-water'), '4.2 ml');
		assert.strictEqual(sidebar.text('metric-tokens'), '124K');
		assert.strictEqual(sidebar.text('metric-requests'), '17');
		sidebar.send({ ...VIEW, today: null, periods: [] });
		for (const id of ['metric-energy', 'metric-carbon', 'metric-water', 'metric-tokens', 'metric-requests']) {
			assert.strictEqual(sidebar.text(id), '\u2014', id);
		}
		assert.strictEqual(sidebar.el('carbon-equivalents').children.length, 0);
	});

	test('sidebar.js shows everyday comparisons with pixel icons for CO2e and water', () => {
		const sidebar = loadSidebarScript(undefined, { icons: true });
		sidebar.send({ ...VIEW });
		const carbon = sidebar.el('carbon-equivalents').children;
		assert.deepStrictEqual(carbon.map(li => li.className), PERIODS[0].carbon.map(e => `equivalent equivalent-${e.id}`));
		assert.deepStrictEqual(carbon.map(li => li.text), PERIODS[0].carbon.map(e => `${e.amount} ${e.unit}`), 'icons are hidden from assistive technology');
		assert.ok(carbon.every(li => li.children[0].tagName === 'svg' && li.children[0].children.length > 0));
		assert.deepStrictEqual(sidebar.el('water-equivalents').children.map(li => li.text), PERIODS[0].water.map(e => `${e.amount} ${e.unit}`));
		const plain = loadSidebarScript();
		plain.send({ ...VIEW });
		assert.strictEqual(plain.el('carbon-equivalents').children[0].text, `${PERIODS[0].carbon[0].amount} ${PERIODS[0].carbon[0].unit}`, 'works without icons');
	});

	test('period tabs switch figures, follow the keyboard and remember the choice', () => {
		const sidebar = loadSidebarScript();
		sidebar.send({ ...VIEW });
		sidebar.el('period-last30Days').click();
		assert.strictEqual(sidebar.text('metric-carbon'), PERIODS[1].totals.text.carbon);
		assert.strictEqual(sidebar.el('period-last30Days').getAttribute('aria-selected'), 'true');
		assert.strictEqual(sidebar.el('period-today').getAttribute('tabindex'), '-1');
		assert.strictEqual(sidebar.el('footprint-panel').getAttribute('aria-labelledby'), 'period-last30Days');
		sidebar.el('period-last30Days').keydown('ArrowRight');
		assert.strictEqual(sidebar.text('period-note'), 'September 2026');
		assert.strictEqual(sidebar.el('period-note').hidden, false);
		sidebar.el('period-previousMonth').keydown('End');
		assert.strictEqual(sidebar.text('period-note'), 'From 12 days of usage');
		assert.strictEqual(sidebar.text('metric-water'), PERIODS[3].totals.text.water);
		sidebar.el('period-projectedYear').keydown('ArrowRight');
		assert.strictEqual(sidebar.el('period-today').getAttribute('aria-selected'), 'true', 'wraps around');
		assert.strictEqual(sidebar.el('period-note').hidden, true);
		assert.deepStrictEqual(sidebar.saved.at(-1), { period: 'today' });

		const restored = loadSidebarScript(undefined, { state: { period: 'previousMonth' } });
		restored.send({ ...VIEW });
		assert.strictEqual(restored.text('metric-carbon'), PERIODS[2].totals.text.carbon);
		const invalid = loadSidebarScript(undefined, { state: { period: 'forever' } });
		invalid.send({ ...VIEW });
		assert.strictEqual(invalid.text('metric-carbon'), PERIODS[0].totals.text.carbon);
	});

	test('sidebar.js shows the latest request with tokens, a +N active indicator and how long ago when idle', () => {
		const sidebar = loadSidebarScript();
		sidebar.send({ ...VIEW, live: null });
		assert.strictEqual(sidebar.text('live-source'), 'No AI requests yet');
		sidebar.send({ type: 'state', worldState: 'ProcessingMedium', activeCount: 3 });
		sidebar.send({ ...VIEW });
		assert.strictEqual(sidebar.text('live-source'), 'Claude Code claude-sonnet-4 12K tokens');
		assert.strictEqual(sidebar.text('status'), 'Generating\u2026');
		assert.strictEqual(sidebar.text('live-more'), '+2 active');
		assert.strictEqual(sidebar.el('live-more').hidden, false);
		sidebar.send({ type: 'state', worldState: 'RequestStarting', activeCount: 1 });
		assert.strictEqual(sidebar.el('live-more').hidden, true);
		sidebar.send({ ...VIEW, live: { providerName: 'Codex CLI', model: null, status: 'failed', tokens: null, updatedAt: Date.now() - 3 * 60 * MINUTE } });
		sidebar.send({ type: 'state', worldState: 'Idle', activeCount: 0 });
		assert.strictEqual(sidebar.text('live-source'), 'Last request: Codex CLI (failed) 3 h ago');
		assert.strictEqual(sidebar.text('status'), 'Idle');
		sidebar.send({ ...VIEW, live: { ...VIEW.live, updatedAt: Date.now() } });
		assert.match(sidebar.text('live-source') ?? '', /just now$/);
	});

	test('sidebar.js draws the last hour as stepped bars with a text summary and session counters', () => {
		const sidebar = loadSidebarScript();
		sidebar.send({ ...VIEW });
		const bars = sidebar.el('activity-bars');
		assert.strictEqual(bars.children.length, VIEW.activity.tokens.length);
		const heights = bars.children.map(b => parseInt(b.style.height, 10));
		assert.deepStrictEqual(heights.map(h => h % 2), heights.map(() => 0), 'whole pixel steps');
		assert.strictEqual(heights[0], 0);
		assert.ok(heights[2] > 0, 'small bursts stay visible');
		assert.strictEqual(Math.max(...heights), heights[3]);
		assert.ok(bars.children.at(-1)!.className.includes('bar-now'));
		assert.strictEqual(bars.getAttribute('aria-label'), VIEW.activity.summary);
		assert.strictEqual(sidebar.text('activity-summary'), VIEW.activity.summary);
		assert.deepStrictEqual(['session-requests', 'session-tokens', 'session-carbon'].map(sidebar.text), ['3', '9K', '0.03 g CO\u2082e']);
		sidebar.send({ ...VIEW, activity: null, session: null });
		assert.strictEqual(bars.children.length, 0);
		assert.strictEqual(sidebar.text('session-requests'), '\u2014');
	});

	test('sidebar.js renders provider shares as text with a decorative stacked bar', () => {
		const sidebar = loadSidebarScript();
		sidebar.send({
			...VIEW,
			providers: [
				{ id: 'github-copilot', name: 'GitHub Copilot', tokens: 9995, percent: 100 },
				{ id: 'codex-cli', name: 'Codex CLI', tokens: 5, percent: 0 },
				{ id: 'claude-code', name: 'Claude Code', tokens: 0, percent: null },
			],
		});
		const list = sidebar.el('providers');
		assert.deepStrictEqual(list.children.map(li => li.text), [
			'GitHub Copilot 100%',
			'Codex CLI <1%',
			'Claude Code no token data',
		]);
		assert.ok(list.find('swatch').every(s => s.attributes.get('aria-hidden') === 'true'));
		const stack = sidebar.el('providers-bar');
		assert.deepStrictEqual(stack.children.map(c => [c.className, c.style.flexGrow]), [['segment provider-github-copilot', '100']]);
		assert.strictEqual(stack.hidden, false);
		assert.strictEqual(sidebar.text('providers-caption'), 'Share of today\u2019s tokens');

		sidebar.send({ ...VIEW, providers: [{ id: 'claude-code', name: 'Claude Code', tokens: 0, percent: null }] });
		assert.strictEqual(sidebar.text('providers-caption'), 'No token usage recorded today');
		assert.strictEqual(stack.hidden, true);
		sidebar.send({ ...VIEW, providers: [] });
		assert.strictEqual(list.children.length, 0);
	});

	test('sidebar.js shows onboarding with detected tools on first run, and the empty state afterwards', () => {
		const sidebar = loadSidebarScript();
		const tools = [
			{ id: 'github-copilot', name: 'GitHub Copilot', state: 'tracking' },
			{ id: 'claude-code', name: 'Claude Code', state: 'unavailable' },
			{ id: 'codex-cli', name: 'Codex CLI', state: 'failed' },
			{ id: 'github-copilot-cli', name: 'Copilot CLI', state: 'stopped' },
		];
		sidebar.send({ ...VIEW, setup: { firstRun: true, providers: tools } });
		assert.strictEqual(sidebar.el('onboarding').hidden, false);
		assert.strictEqual(sidebar.el('empty').hidden, true);
		assert.deepStrictEqual(sidebar.el('onboarding-tools').children.map(li => li.text), [
			'GitHub Copilot Detected', 'Claude Code Not detected', 'Codex CLI Tracking unavailable', 'Copilot CLI Checking',
		]);

		sidebar.send({ ...VIEW, setup: { firstRun: false, providers: tools } });
		assert.strictEqual(sidebar.el('onboarding').hidden, true);
		assert.strictEqual(sidebar.el('empty').hidden, true, 'a detected tool means no empty state');

		const none = tools.map(t => ({ ...t, state: 'unavailable' }));
		sidebar.send({ ...VIEW, setup: { firstRun: false, providers: [...none.slice(0, 3), { ...none[3], state: 'stopped' }] } });
		assert.strictEqual(sidebar.el('empty').hidden, true, 'still checking');
		sidebar.send({ ...VIEW, live: null, today: null, periods: [], providers: [], setup: { firstRun: false, providers: none } });
		assert.strictEqual(sidebar.el('empty').hidden, false);
		assert.deepStrictEqual(sidebar.el('empty-tools').children.map(li => li.text), ['GitHub Copilot', 'Claude Code', 'Codex CLI', 'Copilot CLI']);
		assert.strictEqual(sidebar.text('metric-energy'), '\u2014', 'metrics stay visible in the empty state');
	});

	test('sidebar.js buttons post only whitelisted actions', () => {
		const sidebar = loadSidebarScript();
		for (const id of ['onboarding-start', 'onboarding-methodology', 'empty-refresh', 'action-details', 'action-methodology', 'unknown']) {
			sidebar.el(id).click();
		}
		assert.deepStrictEqual(sidebar.posted, [
			{ type: 'ready' },
			{ type: 'dismissOnboarding' },
			{ type: 'command', command: 'carbonbit.showMethodology' },
			{ type: 'command', command: 'carbonbit.refreshUsage' },
			{ type: 'command', command: 'carbonbit.showDetails' },
			{ type: 'command', command: 'carbonbit.showMethodology' },
		]);
		assert.ok(sidebar.posted.every(isWebviewToHostMessage));
	});

	test('sidebar.js applies visual modes without losing metrics or status', () => {
		const sidebar = loadSidebarScript();
		sidebar.send({ type: 'state', worldState: 'ProcessingLight', activeCount: 1 });
		sidebar.send({ ...VIEW });
		const before = ['status', 'live-source', 'metric-energy', 'metric-carbon', 'providers'].map(id => sidebar.text(id));
		for (const visualMode of [...VISUAL_MODES, 'dark']) {
			sidebar.send({ type: 'config', animationEnabled: true, maxFps: 30, visualMode });
			assert.strictEqual(sidebar.body.dataset.mode, visualMode === 'dark' ? 'environmental' : visualMode);
			assert.deepStrictEqual(['status', 'live-source', 'metric-energy', 'metric-carbon', 'providers'].map(id => sidebar.text(id)), before, visualMode);
		}
	});

	test('sidebar.js forwards state and config to the world and ignores malformed config', () => {
		const calls: unknown[][] = [];
		const sidebar = loadSidebarScript({
			mountWorld: () => ({
				setWorld: (...args: unknown[]) => calls.push(['setWorld', ...args]),
				setConfig: (config: unknown) => calls.push(['setConfig', JSON.parse(JSON.stringify(config))]),
			}),
		});
		sidebar.send({ type: 'config', animationEnabled: false, maxFps: 12, visualMode: 'neutral' });
		sidebar.send({ type: 'config', animationEnabled: 'no', maxFps: 12, visualMode: 'neutral' });
		sidebar.send({ type: 'state', worldState: 'ProcessingHeavy', activeCount: 2 });
		sidebar.send({ type: 'state', worldState: 'Sleeping', activeCount: 0 });
		assert.deepStrictEqual(calls, [
			['setConfig', { animationEnabled: false, maxFps: 12, visualMode: 'neutral' }],
			['setWorld', 'ProcessingHeavy', 2],
			['setWorld', 'Idle', 0],
		]);
	});

	test('a failing pixel world never takes the numbers down with it', () => {
		const broken = loadSidebarScript({ mountWorld: () => { throw new Error('boom'); } });
		broken.send({ type: 'state', worldState: 'ProcessingHeavy', activeCount: 1 });
		broken.send({ ...VIEW });
		assert.strictEqual(broken.text('status'), 'Generating\u2026');
		assert.strictEqual(broken.text('metric-carbon'), '0.24 g CO\u2082e');
		const throwing = loadSidebarScript({
			mountWorld: () => ({ setWorld: () => { throw new Error('draw'); }, setConfig: () => { throw new Error('config'); } }),
			describeState: () => { throw new Error('label'); },
		});
		throwing.send({ type: 'config', animationEnabled: true, maxFps: 30, visualMode: 'neutral' });
		throwing.send({ type: 'state', worldState: 'Failed', activeCount: 0 });
		throwing.send({ ...VIEW });
		assert.strictEqual(throwing.text('status'), 'Failed');
		assert.strictEqual(throwing.body.dataset.mode, 'neutral');
	});

	test('pixel icons cover every comparison on a 12x12 grid with theme-coloured outlines only', () => {
		const context = vm.createContext({ window: {} });
		vm.runInContext(fs.readFileSync(path.join(root, 'media', 'icons.js'), 'utf8'), context);
		const icons = (context.window as { CarbonBitIcons: { ids: string[]; ICONS: Record<string, string[]> } }).CarbonBitIcons;
		const ids = [...PERIODS[0].carbon, ...PERIODS[0].water].map(e => e.id);
		assert.deepStrictEqual([...icons.ids].sort(), [...ids].sort());
		for (const id of ids) {
			const rows = icons.ICONS[id];
			assert.strictEqual(rows.length, 12, id);
			assert.ok(rows.every(r => r.length === 12 && /^[.oa-zA-Z]+$/.test(r)), id);
		}
	});

	test('package ships runtime assets and excludes sources and tests', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
		assert.ok(fs.existsSync(path.join(root, pkg.main)), pkg.main);
		for (const file of ['sidebar.js', 'sidebar.css', 'details.js', 'details.css', 'icons.js', 'carbonbit.svg', ...WORLD_SCRIPTS.map(f => path.relative('media', f))]) {
			assert.ok(fs.existsSync(path.join(root, 'media', file)), file);
		}

		const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8')
			.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
		for (const pattern of ['src/**', 'out/test/**', '**/*.map', '**/*.ts']) {
			assert.ok(ignore.includes(pattern), `.vscodeignore should exclude ${pattern}`);
		}
		for (const pattern of ignore) {
			assert.ok(!/^(\*\*\/)?(media|out)(\/\*\*)?$/.test(pattern), `.vscodeignore must not exclude ${pattern}`);
		}
	});
});

suite('Sidebar with the pixel world', () => {
	test('reduced motion keeps status and metrics text up to date', () => {
		const browser = createBrowser({ reducedMotion: true });
		browser.state('ProcessingHeavy', 3);
		browser.send({ ...VIEW });
		assert.strictEqual(browser.text('status'), 'Generating\u2026');
		assert.strictEqual(browser.text('live-more'), '+2 active');
		assert.strictEqual(browser.text('metric-energy'), '0.84 Wh');
		assert.strictEqual(browser.pending(), 0, 'the text needs no timers of its own');
	});

});
