import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { confidenceFor } from '../core/impact/confidence';
import { ENVIRONMENTAL_FACTORS } from '../core/impact/data/environmentalFactors';
import { ImpactEngine } from '../core/impact/impactEngine';
import {
	type DetailsView,
	EXPLANATION_KINDS,
	isDetailsToHostMessage,
	isHostToDetailsMessage,
	type MethodologyView,
} from '../core/messages/detailsProtocol';
import { openUsageStore } from '../core/storage/openUsageStore';
import { UsageHistory } from '../core/storage/usageHistory';
import type { ModelSummary } from '../core/storage/usageStore';
import type { AiUsageEvent } from '../core/usage/usageEvent';
import type { ProviderStatus } from '../core/usage/usageService';
import { methodologyView, toDetailsView } from '../core/view/detailsView';
import { buildSidebarModel, type SidebarModel } from '../core/view/sidebarModel';
import { toSidebarView } from '../core/view/sidebarView';
import { getDetailsHtml } from '../details/detailsHtml';
import { handleDetailsMessage, postDetailsView, postToDetails } from '../details/detailsMessages';
import { createFakeDocument } from './fakeDom';

const root = path.resolve(__dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-01T15:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const STATUSES: ProviderStatus[] = [
	{ id: 'github-copilot', displayName: 'GitHub Copilot', state: 'tracking', lastEventAt: 1 },
	{ id: 'claude-code', displayName: 'Claude Code', state: 'tracking', lastEventAt: 1 },
	{ id: 'codex-cli', displayName: 'Codex CLI', state: 'tracking', lastEventAt: 1 },
];

function ev(id: string, fields: Partial<AiUsageEvent> = {}): AiUsageEvent {
	return {
		id, provider: 'claude-code', model: 'claude-sonnet-4.5', startedAt: iso(NOW - 60_000), completedAt: iso(NOW - 55_000),
		inputTokens: 1000, outputTokens: 500, source: 'actual', status: 'completed', ...fields,
	};
}

const SEED: AiUsageEvent[] = [
	ev('a'),
	ev('b', { inputTokens: 52_000, outputTokens: 2400, cachedInputTokens: 30_000 }),
	ev('c', { provider: 'github-copilot', model: 'copilot/gpt-4.1-preview', outputTokens: undefined }),
	ev('d', { provider: 'codex-cli', model: 'some-future-model', inputTokens: 900, outputTokens: 90 }),
	ev('e', { provider: 'codex-cli', model: undefined, status: 'started', completedAt: undefined, inputTokens: undefined, outputTokens: undefined }),
	ev('yesterday', { startedAt: iso(NOW - DAY), completedAt: iso(NOW - DAY + 1000) }),
];

function sidebarModelFor(events: AiUsageEvent[]): { model: SidebarModel; dispose(): void } {
	const history = new UsageHistory(openUsageStore().store!, { now: () => NOW, startOfDay: ms => ms - (ms % DAY) });
	events.forEach(e => history.record(e));
	const model = buildSidebarModel({ world: () => ({ worldState: 'Idle', activeCount: 0 }), live: () => null, history, statuses: () => STATUSES });
	return { model, dispose: () => history.dispose() };
}

function summary(fields: Partial<ModelSummary>): ModelSummary {
	return {
		model: 'claude-sonnet-4.5', requests: 2, tokens: 3000, energyWh: 0.9, carbonGrams: 0.4, waterLiters: 0.001,
		confidence: 'medium', factorLevel: 'class', tokenProvenance: { actual: 2, partial: 0, estimated: 0 }, methodologyVersions: ['1.0.0'],
		...fields,
	};
}

const BASE_MODEL: SidebarModel = {
	worldState: 'Idle', activeCount: 0, live: null, today: { energyWh: 0, carbonGrams: 0, waterLiters: 0, tokens: 0, requests: 0 },
	session: null, periods: [], activity: null, providers: [], models: [], providerStatuses: STATUSES, anyProviderDetected: true,
};

const lineOf = (view: { lines: { kind: string; value: string }[] }, kind: string) => view.lines.find(l => l.kind === kind)?.value ?? '';

suite('Details view (#47, #42)', () => {
	test('today and provider figures reconcile with the sidebar for the same history', () => {
		const { model, dispose } = sidebarModelFor(SEED);
		try {
			const sidebar = toSidebarView(model, { firstRun: false });
			const details = toDetailsView(model);
			assert.ok(details.today);
			assert.deepStrictEqual(details.today, sidebar.today);
			assert.deepStrictEqual(details.providers.map(({ id, name, tokens, percent }) => ({ id, name, tokens, percent })), sidebar.providers);
			assert.strictEqual(details.today.requests, 5);
			// Every request and token today belongs to exactly one model and one provider.
			const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
			assert.strictEqual(sum(details.models.map(m => m.requests)), details.today.requests);
			assert.strictEqual(sum(details.models.map(m => m.tokens)), details.today.tokens);
			assert.strictEqual(sum(details.providers.map(p => p.requests)), details.today.requests);
			assert.strictEqual(sum(details.providers.map(p => p.percent ?? 0)), 100);
			assert.ok(isHostToDetailsMessage({ type: 'details', ...details }));
		} finally {
			dispose();
		}
	});

	test('model rows show usage, estimated impact and a confidence with its reasons', () => {
		const { model, dispose } = sidebarModelFor(SEED);
		try {
			const { models, overall } = toDetailsView(model);
			assert.deepStrictEqual(models.map(m => [m.model, m.text.requests, m.estimate.confidence]), [
				['claude-sonnet-4.5', '2', 'medium'],
				['copilot/gpt-4.1-preview', '1', 'low'],
				['some-future-model', '1', 'low'],
				[null, '1', null],
			]);
			for (const m of models) {
				assert.deepStrictEqual(m.estimate.lines.map(l => l.kind), EXPLANATION_KINDS.filter(k => m.estimate.confidence !== null || k !== 'methodology'));
			}
			const [sonnet, gpt, unknown, missing] = models;
			assert.match(lineOf(sonnet.estimate, 'why'), /^Medium: a model-class estimate starts at Medium and all token counts are actual/);
			assert.match(lineOf(sonnet.estimate, 'tokens'), /^Actual \(reported by the provider\) for 2 requests$/);
			assert.match(lineOf(sonnet.estimate, 'model'), /claude-sonnet-4\.5 \(claude-sonnet family, medium class\)/);
			assert.match(lineOf(sonnet.estimate, 'energy'), /^Model-class estimate \(medium\), 0\.00015 Wh per input token and 0\.0006 Wh per output token \(source: epoch-2025, google-2025\)$/);
			assert.match(lineOf(sonnet.estimate, 'carbonIntensity'), /Generic infrastructure estimate.*480 g CO₂e per kWh \(source: ember-2024\)/);
			assert.match(lineOf(sonnet.estimate, 'water'), /1\.1 L per kWh \(source: google-2025\)/);
			assert.strictEqual(lineOf(sonnet.estimate, 'methodology'), 'carbonbit-impact v1.1.0');

			assert.match(lineOf(gpt.estimate, 'why'), /^Low: a model-class estimate starts at Medium, lowered one step because some token counts are partial or estimated/);
			assert.match(lineOf(gpt.estimate, 'tokens'), /^Partial \(a missing input or output count is treated as 0\) for 1 request$/);
			assert.match(lineOf(gpt.estimate, 'model'), /^gpt-4\.1-preview \(matched gpt-4\.1 family, medium class\)$/);
			assert.match(lineOf(unknown.estimate, 'model'), /some-future-model \(not recognized; generic fallback\)/);
			assert.match(lineOf(unknown.estimate, 'energy'), /^Generic inference estimate, /);
			assert.match(lineOf(unknown.estimate, 'why'), /^Low: a generic inference estimate starts at Low/);
			assert.match(lineOf(missing.estimate, 'why'), /^Not estimated/);
			assert.match(lineOf(missing.estimate, 'tokens'), /^Without token counts \(not estimated\) for 1 request$/);
			assert.match(lineOf(missing.estimate, 'model'), /not reported \(generic fallback\)/);

			assert.strictEqual(overall.confidence, 'low');
			assert.match(lineOf(overall, 'why'), /^Low: the lowest confidence among today's models \(1 Medium, 2 Low\)/);
			assert.strictEqual(lineOf(overall, 'tokens'), 'Mixed: 3 actual (reported by the provider), 1 partial (a missing input or output count is treated as 0), 1 without token counts (not estimated)');
			assert.strictEqual(lineOf(overall, 'model'), '4 models: 1 recognized, 1 matched by family, 1 not recognized (generic fallback), 1 not reported (generic fallback)');
			assert.strictEqual(lineOf(overall, 'energy'), '2 models with a model-class estimate, 1 model with a generic inference estimate, 1 model not estimated');
		} finally {
			dispose();
		}
	});

	test('estimated token counts are labelled and never shown as actual', () => {
		const view = toDetailsView({
			...BASE_MODEL,
			models: [summary({ confidence: 'low', tokenProvenance: { actual: 1, partial: 0, estimated: 1 } })],
		});
		const estimate = view.models[0].estimate;
		assert.match(lineOf(estimate, 'tokens'), /^Mixed: 1 actual .*, 1 estimated by CarbonBit$/);
		assert.match(lineOf(estimate, 'why'), /lowered one step/);
	});

	test('the same model-specific factor data explains high confidence', () => {
		const factor = { label: 'Published model measurement', whPerInputToken: 0.0001, whPerOutputToken: 0.0004, sources: ['google-2025'], assumptions: [], limitations: [] };
		const engine = new ImpactEngine({ ...ENVIRONMENTAL_FACTORS, energy: { ...ENVIRONMENTAL_FACTORS.energy, models: { 'claude-sonnet-4.5': factor } } });
		const level = engine.estimate(ev('x'))!;
		assert.deepStrictEqual([level.factorLevel, level.confidence], ['model', 'high']);
		const view = toDetailsView({ ...BASE_MODEL, models: [summary({ confidence: 'high', factorLevel: 'model' })] }, engine);
		assert.match(lineOf(view.models[0].estimate, 'why'), /^High: a model-specific measurement starts at High/);
		assert.match(lineOf(view.models[0].estimate, 'energy'), /Published model measurement.*\(source: google-2025\)/);
		assert.strictEqual(engine.describeModel('claude-sonnet-4.5').level, 'model');
	});

	test('no history and no usage still produce valid, explicit views', () => {
		for (const model of [{ ...BASE_MODEL, today: null }, BASE_MODEL]) {
			const view = toDetailsView(model);
			assert.deepStrictEqual([view.models, view.providers, view.overall.confidence], [[], [], null]);
			assert.match(lineOf(view.overall, 'why'), /^Not estimated/);
			assert.ok(isHostToDetailsMessage({ type: 'details', ...view }));
		}
	});

	test('untrusted model names are cleaned and bounded', () => {
		const view = toDetailsView({ ...BASE_MODEL, models: [summary({ model: `x\u0000\n${'y'.repeat(400)}` })] });
		assert.strictEqual(view.models[0].model?.length, 128);
		assert.ok(isHostToDetailsMessage({ type: 'details', ...view }));
	});

	test('methodology is rendered from the engine factor data', () => {
		const m = methodologyView();
		const data = ENVIRONMENTAL_FACTORS;
		assert.deepStrictEqual([m.id, m.version, m.effectiveDate], [data.methodology.id, data.methodology.version, data.methodology.effectiveDate]);
		assert.deepStrictEqual(m.sources.map(s => [s.id, s.url]), Object.entries(data.sources).map(([id, s]) => [id, s.url]));
		assert.deepStrictEqual(m.levels.map(l => [l.actual, l.reduced]), (['model', 'family', 'class', 'generic'] as const).map(level => [confidenceFor(level, 'actual'), confidenceFor(level, 'partial')]));
		assert.ok(m.factors.some(f => f.name === 'Carbon intensity' && f.value.startsWith(`${data.carbonIntensity.gramsCo2ePerKWh} g CO₂e per kWh`)));
		assert.ok(m.factors.some(f => f.name === data.energy.generic.label && f.value.includes(String(data.energy.generic.whPerOutputToken))));
		for (const text of [...data.carbonIntensity.limitations, ...data.waterIntensity.assumptions, ...data.energy.generic.limitations]) {
			assert.ok([...m.assumptions, ...m.limitations].includes(text), text);
		}
		assert.strictEqual(new Set(m.assumptions).size, m.assumptions.length, 'shared assumptions are listed once');
		assert.ok(m.collection.some(t => /estimates/.test(t)) && m.collection.some(t => /^Actual:/.test(t)) && m.collection.some(t => /never stored/.test(t)));
		assert.ok(isHostToDetailsMessage({ type: 'methodology', ...m }));
	});
});

suite('Details protocol', () => {
	const methodology = methodologyView();
	const details: DetailsView = toDetailsView({ ...BASE_MODEL, models: [summary({})], providers: [{ provider: 'claude-code', requests: 2, tokens: 3000, percent: 100 }] });

	test('accepts details, methodology and tab messages', () => {
		for (const message of [{ type: 'details', ...details }, { type: 'methodology', ...methodology }, { type: 'show', tab: 'overview' }, { type: 'show', tab: 'methodology' }]) {
			assert.ok(isHostToDetailsMessage(message), message.type);
			assert.ok(isHostToDetailsMessage(JSON.parse(JSON.stringify(message))), 'survives structured clone');
		}
	});

	test('rejects leaky, malformed or oversized host messages', () => {
		const m0 = details.models[0];
		const invalid: unknown[] = [
			{ type: 'details', ...details, prompt: 'hi' },
			{ type: 'details', ...details, models: [{ ...m0, file: '/home/me/x.ts' }] },
			{ type: 'details', ...details, models: [{ ...m0, estimate: { ...m0.estimate, confidence: 'certain' } }] },
			{ type: 'details', ...details, models: [{ ...m0, estimate: { ...m0.estimate, lines: [{ kind: 'response', label: 'x', value: 'y' }] } }] },
			{ type: 'details', ...details, models: [{ ...m0, estimate: { ...m0.estimate, lines: [{ kind: 'why', label: 'x', value: 'a\nb' }] } }] },
			{ type: 'details', ...details, models: [{ ...m0, estimate: { ...m0.estimate, lines: [{ kind: 'why', label: 'x', value: 'y'.repeat(401) }] } }] },
			{ type: 'details', ...details, models: Array(101).fill(m0) },
			{ type: 'details', ...details, providers: [{ ...details.providers[0], path: 'C:\\x' }] },
			{ type: 'details', ...details, overall: { confidence: 'low' } },
			{ type: 'methodology', ...methodology, sources: [{ ...methodology.sources[0], url: 'javascript:alert(1)' }] },
			{ type: 'methodology', ...methodology, sources: [{ ...methodology.sources[0], url: 'http://example.com' }] },
			{ type: 'methodology', ...methodology, sources: [{ ...methodology.sources[0], url: 'https://x" onclick="y' }] },
			{ type: 'methodology', ...methodology, factors: [{ name: 'x', value: 'y', sources: [1] }] },
			{ type: 'show', tab: 'settings' },
			{ type: 'show', tab: 'overview', extra: true },
			{ type: 'view', live: null },
			null, [], 'details',
		];
		for (const message of invalid) {
			assert.strictEqual(isHostToDetailsMessage(message), false, JSON.stringify(message)?.slice(0, 120));
		}
	});

	test('the webview may only send ready and open the methodology document', () => {
		assert.ok(isDetailsToHostMessage({ type: 'ready' }));
		assert.ok(isDetailsToHostMessage({ type: 'openMethodologyDocument' }));
		for (const message of [{ type: 'command', command: 'carbonbit.clearLocalData' }, { type: 'ready', x: 1 }, { type: 'openExternal', url: 'https://x' }, null, 'ready']) {
			assert.strictEqual(isDetailsToHostMessage(message), false, JSON.stringify(message));
		}
	});

	test('ready replies with methodology, details and a pending tab once; actions are whitelisted', () => {
		const sent: unknown[] = [];
		let tab: 'methodology' | undefined = 'methodology';
		let opened = 0;
		const content = { view: () => details, methodology, takeTab: () => { const t = tab; tab = undefined; return t; } };
		const actions = { openMethodologyDocument: () => { opened++; } };
		assert.ok(handleDetailsMessage({ type: 'ready' }, m => sent.push(m), content, actions));
		assert.deepStrictEqual(sent.map(m => (m as { type: string }).type), ['methodology', 'details', 'show']);
		assert.deepStrictEqual(sent[2], { type: 'show', tab: 'methodology' });
		sent.length = 0;
		handleDetailsMessage({ type: 'ready' }, m => sent.push(m), content, actions);
		assert.deepStrictEqual(sent.map(m => (m as { type: string }).type), ['methodology', 'details']);
		assert.ok(handleDetailsMessage({ type: 'openMethodologyDocument' }, m => sent.push(m), content, actions));
		assert.strictEqual(opened, 1);
		for (const message of [{ type: 'command', command: 'carbonbit.showDetails' }, { type: 'ready', tab: 'x' }, undefined]) {
			assert.strictEqual(handleDetailsMessage(message, m => sent.push(m), content, actions), false);
		}
		assert.strictEqual(sent.length, 2);
	});

	test('the host never posts a message that fails validation', () => {
		const sent: unknown[] = [];
		assert.strictEqual(postDetailsView({ ...details, today: { ...details.today!, prompt: 'x' } as never }, m => sent.push(m)), false);
		assert.strictEqual(postToDetails({ type: 'show', tab: 'secret' as never }, m => sent.push(m)), false);
		assert.deepStrictEqual(sent, []);
	});
});

suite('Details HTML', () => {
	const options = {
		cspSource: 'https://webview.example',
		nonce: 'abc123',
		scriptUri: 'https://webview.example/media/details.js',
		iconsUri: 'https://webview.example/media/icons.js',
		styleUri: 'https://webview.example/media/details.css',
	};
	const html = getDetailsHtml(options);

	test('uses the same restrictive CSP with nonce-tagged external scripts only', () => {
		const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1] ?? '';
		assert.ok(csp.startsWith(`default-src 'none';`));
		for (const part of [`img-src https://webview.example data:;`, `style-src https://webview.example;`, `script-src 'nonce-abc123';`]) {
			assert.ok(csp.includes(part), part);
		}
		assert.ok(!/unsafe-(inline|eval)/.test(csp));
		const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
		assert.deepStrictEqual(scripts, [
			'<script nonce="abc123" src="https://webview.example/media/icons.js"></script>',
			'<script nonce="abc123" src="https://webview.example/media/details.js"></script>',
		]);
		assert.ok(/<section class="impact impact-carbon"[\s\S]*id="footprint-carbon"[\s\S]*id="footprint-water"/.test(html), 'footprint rows for CO2e and water');
		assert.ok(!/\son[a-z]+\s*=|<style\b|\sstyle\s*=|javascript:|<a\b/i.test(html));
		assert.ok(!getDetailsHtml({ ...options, scriptUri: 'x" onload="y' }).includes('" onload="'));
	});

	test('has accessible tabs, semantic tables and an estimate disclaimer', () => {
		assert.ok(/role="tablist"/.test(html));
		for (const tab of ['overview', 'methodology']) {
			assert.ok(new RegExp(`<button type="button" role="tab" id="tab-${tab}" aria-controls="panel-${tab}" aria-selected="(true|false)"`).test(html), tab);
			assert.ok(new RegExp(`<section id="panel-${tab}" role="tabpanel" aria-labelledby="tab-${tab}"`).test(html), tab);
		}
		const tables = html.match(/<table\b[\s\S]*?<\/table>/g) ?? [];
		assert.strictEqual(tables.length, 5);
		for (const table of tables) {
			assert.ok(/<caption>[^<]+/.test(table), 'caption');
			assert.ok(/<thead>[\s\S]*<th scope="col"[\s\S]*<\/thead>/.test(table), 'column headers');
			assert.ok(!/<th>/.test(table), 'every header cell has a scope');
		}
		assert.ok(/aria-expanded="false" aria-controls="overall-explanation"/.test(html));
		assert.ok(/estimates, not measurements/.test(html));
		assert.ok(/<section id="panel-methodology"[^>]*hidden>/.test(html));
	});
});

// Runs media/details.js against the fake DOM and VS Code API.
function loadDetailsScript(state?: unknown) {
	const posted: unknown[] = [];
	const saved: unknown[] = [];
	const document = createFakeDocument();
	let onMessage: ((event: { data: unknown }) => void) | undefined;
	vm.runInNewContext(fs.readFileSync(path.join(root, 'media', 'details.js'), 'utf8'), {
		acquireVsCodeApi: () => ({
			postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))),
			getState: () => state,
			setState: (s: unknown) => saved.push(JSON.parse(JSON.stringify(s))),
		}),
		document,
		window: { addEventListener: (type: string, fn: typeof onMessage) => { if (type === 'message') { onMessage = fn; } } },
	});
	return {
		posted,
		saved,
		document,
		el: (id: string) => document.getElementById(id)!,
		text: (id: string) => document.getElementById(id)!.text,
		send: (data: unknown) => onMessage?.({ data: JSON.parse(JSON.stringify(data)) }),
	};
}

suite('Details webview script', () => {
	const methodology: MethodologyView = methodologyView();
	let details: DetailsView;
	suiteSetup(() => {
		const { model, dispose } = sidebarModelFor(SEED);
		details = toDetailsView(model);
		dispose();
	});

	test('renders each period as a column with its figure and everyday comparisons, for CO2e and water', () => {
		const page = loadDetailsScript();
		page.send({ type: 'details', ...details });
		assert.deepStrictEqual(details.periods.map(p => p.id), ['today', 'last30Days', 'previousMonth', 'projectedYear']);
		for (const kind of ['carbon', 'water'] as const) {
			const columns = page.el(`footprint-${kind}`).children;
			assert.deepStrictEqual(columns.map(c => c.className), details.periods.map(p => `period period-${p.id}`), kind);
			columns.forEach((column, i) => {
				const period = details.periods[i];
				const [label, value, list] = column.children;
				assert.strictEqual(label.text, [period.label, period.note].filter(Boolean).join(' '));
				assert.strictEqual(value.text, period.totals.text[kind]);
				assert.deepStrictEqual(list.children.map(li => li.text), period[kind].map(e => `${e.amount} ${e.unit}`));
			});
		}
		assert.strictEqual(page.el('footprint-unavailable').hidden, true);
		page.send({ type: 'details', ...details, periods: [] });
		assert.strictEqual(page.el('footprint-carbon').children.length, 0);
		assert.strictEqual(page.el('footprint-unavailable').hidden, false);
	});

	test('renders today, models and providers as text from the host view', () => {
		const page = loadDetailsScript();
		assert.deepStrictEqual(page.posted, [{ type: 'ready' }]);
		page.send({ type: 'details', ...details });
		for (const key of ['requests', 'tokens', 'energy', 'carbon', 'water'] as const) {
			assert.strictEqual(page.text(`today-${key}`), details.today!.text[key], key);
		}
		assert.match(page.text('today-tokens-basis'), /^Usage counter: Mixed: 3 actual/);
		assert.strictEqual(page.text('overall-confidence'), 'Low');
		const rows = page.el('models').children;
		assert.strictEqual(rows.length, details.models.length * 2, 'one row and one explanation row per model');
		const first = rows[0];
		assert.deepStrictEqual(first.children.map(c => c.text), ['claude-sonnet-4.5', '2', details.models[0].text.tokens, details.models[0].text.energy, details.models[0].text.carbon, details.models[0].text.water, 'Medium']);
		assert.strictEqual(first.children[0].getAttribute('scope'), 'row');
		assert.strictEqual(rows[6].children[0].text, 'Model not reported');
		assert.strictEqual(rows[6].findTag('button')[0].text, 'Not estimated');
		assert.deepStrictEqual(page.el('providers').children.map(r => r.text), details.providers.map(p => `${p.name} ${p.requests} ${p.tokensText} ${p.percent}%`));
		assert.strictEqual(page.el('models-empty').hidden, true);

		page.send({ type: 'details', today: null, overall: { confidence: null, lines: [] }, models: [], providers: [] });
		assert.strictEqual(page.text('today-energy'), '\u2014');
		assert.strictEqual(page.el('today-unavailable').hidden, false);
		assert.deepStrictEqual([page.el('models-table').hidden, page.el('models-empty').hidden, page.el('providers-empty').hidden], [true, false, false]);
	});

	test('confidence badges are buttons that reveal why, and stay open across live updates', () => {
		const page = loadDetailsScript();
		page.send({ type: 'details', ...details });
		const button = () => page.el('models').children[2].findTag('button')[0];
		const panel = () => page.el('models').children[3];
		assert.deepStrictEqual([button().getAttribute('type'), button().getAttribute('aria-expanded'), panel().hidden], ['button', 'false', true]);
		assert.strictEqual(button().getAttribute('aria-controls'), panel().id);
		assert.match(button().getAttribute('aria-label') ?? '', /^Low confidence for copilot\/gpt-4\.1-preview: show why$/);
		button().click();
		assert.deepStrictEqual([button().getAttribute('aria-expanded'), panel().hidden], ['true', false]);
		const explanation = panel().findTag('dl')[0];
		assert.deepStrictEqual(explanation.findTag('dt').map(dt => dt.text), details.models[1].estimate.lines.map(l => l.label));
		assert.match(explanation.text, /Token usage Partial/);

		page.send({ type: 'details', ...details, providers: [] });
		assert.deepStrictEqual([button().getAttribute('aria-expanded'), panel().hidden], ['true', false], 'still open after an update');
		button().focus();
		page.send({ type: 'details', ...details });
		assert.strictEqual(page.document.activeElement, button(), 'focus follows the re-rendered button');
		button().click();
		assert.deepStrictEqual([button().getAttribute('aria-expanded'), panel().hidden], ['false', true]);

		const overall = page.el('overall-confidence');
		assert.strictEqual(page.el('overall-explanation').hidden, true);
		overall.click();
		assert.deepStrictEqual([overall.getAttribute('aria-expanded'), page.el('overall-explanation').hidden], ['true', false]);
		assert.match(page.text('overall-explanation'), /Confidence Low: the lowest confidence/);
	});

	test('methodology tab renders factors, sources and limitations; tabs follow host and keyboard', () => {
		const page = loadDetailsScript();
		page.send({ type: 'methodology', ...methodology });
		assert.match(page.text('method-version'), /carbonbit-impact version \d+\.\d+\.\d+/);
		assert.strictEqual(page.el('method-factors').children.length, methodology.factors.length);
		assert.strictEqual(page.el('method-limitations').children.length, methodology.limitations.length);
		const links = page.el('method-sources').findTag('a');
		assert.deepStrictEqual(links.map(a => a.getAttribute('href')), methodology.sources.map(s => s.url));
		assert.deepStrictEqual(page.el('method-levels').children.map(r => r.text), [
			'Model-specific measurement High Medium', 'Model-family measurement Medium Low', 'Model-class estimate Medium Low', 'Generic inference estimate Low Low',
		]);

		assert.deepStrictEqual([page.el('panel-overview').hidden, page.el('panel-methodology').hidden], [false, true]);
		page.send({ type: 'show', tab: 'methodology' });
		assert.deepStrictEqual([page.el('panel-overview').hidden, page.el('panel-methodology').hidden], [true, false]);
		assert.deepStrictEqual([page.el('tab-methodology').getAttribute('aria-selected'), page.el('tab-overview').getAttribute('tabindex')], ['true', '-1']);
		page.el('tab-methodology').keydown('ArrowRight');
		assert.strictEqual(page.el('panel-overview').hidden, false);
		assert.strictEqual(page.document.activeElement, page.el('tab-overview'));
		page.el('tab-overview').keydown('End');
		assert.strictEqual(page.el('panel-methodology').hidden, false);
		page.el('tab-overview').click();
		assert.strictEqual(page.el('panel-methodology').hidden, true);
		assert.deepStrictEqual(page.saved[page.saved.length - 1], { tab: 'overview' });

		const restored = loadDetailsScript({ tab: 'methodology' });
		assert.strictEqual(restored.el('panel-methodology').hidden, false, 'restores the tab after a reload');
	});

	test('posts only ready and the methodology document action, and never uses HTML injection', () => {
		const page = loadDetailsScript();
		page.el('open-document').click();
		page.el('overall-confidence').click();
		page.el('tab-methodology').click();
		assert.deepStrictEqual(page.posted, [{ type: 'ready' }, { type: 'openMethodologyDocument' }]);
		assert.ok(page.posted.every(isDetailsToHostMessage));
		const source = fs.readFileSync(path.join(root, 'media', 'details.js'), 'utf8');
		assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(source));
	});
});
