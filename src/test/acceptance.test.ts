import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDiagnosticsReport, formatDiagnosticsReport } from '../core/diagnostics/diagnostics';
import type { Confidence } from '../core/impact/confidence';
import { ImpactEngine } from '../core/impact/impactEngine';
import { isHostToDetailsMessage } from '../core/messages/detailsProtocol';
import { isHostToWebviewMessage, type WorldState } from '../core/messages/protocol';
import { ClaudeCodeAdapter } from '../core/providers/claudeCode/claudeCodeAdapter';
import { CodexCliAdapter } from '../core/providers/codexCli/codexCliAdapter';
import { CopilotChatAdapter } from '../core/providers/copilotChat/copilotChatAdapter';
import { CopilotCliAdapter } from '../core/providers/copilotCli/copilotCliAdapter';
import { DATABASE_FILE_NAME, openUsageStore } from '../core/storage/openUsageStore';
import { UsageHistory } from '../core/storage/usageHistory';
import type { AiUsageEvent } from '../core/usage/usageEvent';
import { UsageService } from '../core/usage/usageService';
import { methodologyView, toDetailsView } from '../core/view/detailsView';
import { LiveActivity } from '../core/view/liveActivity';
import { buildSidebarModel } from '../core/view/sidebarModel';
import { toSidebarView } from '../core/view/sidebarView';
import { DEFAULT_WORLD_TIMINGS, WorldStateEngine } from '../core/world/worldStateEngine';
import { FakeClock } from './fakeClock';
import { assertNoContent, fixtureLines, readProviderFixture, setModified } from './providerHarness';

const DAY = 24 * 60 * 60 * 1000;
// After every fixture's timestamps; UTC day boundaries keep the test timezone-independent.
const NOW = Date.parse('2026-10-01T18:00:00.000Z');
const startOfDay = (ms: number) => ms - (ms % DAY);
const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** PRD §53 MVP journey, end to end, with fixtures, a fake clock and a temporary database. */
suite('MVP acceptance journey (#40)', () => {
	let root: string;
	let storageDir: string;
	const disposables: { dispose(): void }[] = [];

	setup(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbonbit-accept-providers-'));
		storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbonbit-accept-storage-'));
	});

	teardown(() => {
		disposables.splice(0).reverse().forEach(d => d.dispose());
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(storageDir, { recursive: true, force: true });
	});

	test('detect -> track -> world -> estimate -> persist -> restart -> inspect -> clear, without leaking content', async () => {
		const dir = (...segments: string[]) => path.join(root, ...segments);
		['chat', 'claude', 'cli'].forEach(d => fs.mkdirSync(dir(d)));
		const clock = new FakeClock();
		clock.advance(NOW);
		const now = () => clock.now();
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);

		// 1-2. Detection: three providers present, Codex CLI not installed yet.
		const claude = new ClaudeCodeAdapter({ projectDirs: [dir('claude')], log, pollIntervalMs: 0 });
		const adapters = [
			new CopilotChatAdapter({ sessionDirs: [dir('chat')], isCopilotChatInstalled: () => false, log, pollIntervalMs: 0 }),
			claude,
			new CopilotCliAdapter({ sessionDirs: [dir('cli')], log, pollIntervalMs: 0 }),
			new CodexCliAdapter({ sessionDirs: [dir('codex')], log, pollIntervalMs: 0 }),
		];
		const usage = new UsageService(log, { now });
		adapters.forEach(a => usage.register(a));
		disposables.push({ dispose: () => { void usage.stop(); usage.dispose(); } });
		await usage.start();
		const states = () => usage.getStatuses().map(s => [s.id, s.state]);
		assert.deepStrictEqual(states(), [
			['github-copilot', 'tracking'], ['claude-code', 'tracking'], ['github-copilot-cli', 'tracking'], ['codex-cli', 'unavailable'],
		]);
		fs.mkdirSync(dir('codex'));
		await usage.refresh();
		assert.ok(states().every(([, state]) => state === 'tracking'), 'a provider installed later is detected on refresh');

		// Host pipeline exactly as extension.ts wires it.
		const file = path.join(storageDir, DATABASE_FILE_NAME);
		const openHistory = () => {
			const h = new UsageHistory(openUsageStore({ file, now, log }).store, { now, startOfDay, log });
			disposables.push(h);
			return h;
		};
		let history = openHistory();
		const worldStates: WorldState[] = [];
		const world = new WorldStateEngine(s => worldStates.push(s.worldState), { clock });
		disposables.push(world);
		const live = new LiveActivity({ now });
		const events: AiUsageEvent[] = [];
		usage.onUsageEvent((event, origin) => {
			events.push(event);
			if (origin !== 'import') {
				world.handle(event);
				live.handle(event);
			}
			history.record(event);
		});

		// 3-11. One live Claude Code request, line by line: the world leaves Idle and returns to it.
		const claudeFile = dir('claude', 'proj', 'sess-a.jsonl');
		fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
		assert.strictEqual(world.current.worldState, 'Idle');
		for (const line of fixtureLines('claudeCode', 'session.jsonl')) {
			fs.appendFileSync(claudeFile, line + '\n');
			await claude.refresh();
			clock.advance(1000);
		}
		// Consecutive Claude Code calls read as an agent loop that stays busy for a short gap.
		clock.advance(DEFAULT_WORLD_TIMINGS.agentLoopGapMs);
		const sequence = worldStates.filter((s, i) => s !== worldStates[i - 1]);
		assert.strictEqual(sequence[0], 'RequestStarting');
		assert.ok(sequence.some(s => s.startsWith('Processing')), `processing state in ${sequence.join(' > ')}`);
		assert.ok(sequence.includes('ResponseArriving'), sequence.join(' > '));
		assert.strictEqual(sequence.at(-1), 'Idle');
		assert.deepStrictEqual(world.current, { worldState: 'Idle', activeCount: 0 });
		assert.strictEqual(live.current()?.provider, 'claude-code');
		assert.ok(live.current()?.model, 'model is displayed');

		// The other providers' fixtures arrive in bulk.
		const write = (target: string, provider: string, fixture: string) => {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, readProviderFixture(provider, fixture));
		};
		write(dir('chat', 'session-1.jsonl'), 'copilotChat', 'available.jsonl');
		write(dir('cli', 'cli-session-1', 'events.jsonl'), 'copilotCli', 'events.jsonl');
		write(dir('codex', '2026', '10', '01', 'rollout-x.jsonl'), 'codexCli', 'rollout.jsonl');
		await usage.refresh();
		clock.advance(DEFAULT_WORLD_TIMINGS.agentLoopGapMs);
		assert.strictEqual(world.current.worldState, 'Idle');
		assert.ok(usage.getStatuses().every(s => s.lastEventAt !== null), 'every provider delivered usage');

		// 8-9. Expected figures, computed independently from the final state of each request.
		const engine = new ImpactEngine();
		const final = new Map<string, AiUsageEvent>();
		events.forEach(e => final.set(e.id, { ...final.get(e.id), ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) } as AiUsageEvent));
		const today = [...final.values()].filter(e => Date.parse(e.startedAt) >= startOfDay(NOW));
		const estimates = today.map(e => ({ event: e, impact: engine.estimate(e) }));
		assert.ok(estimates.some(({ impact }) => impact && impact.energyWh > 0), 'environmental impact is calculated');
		for (const { event, impact } of estimates) {
			if (impact) {
				assert.ok(['high', 'medium', 'low'].includes(impact.confidence), `${event.provider} has a confidence`);
				assert.ok(event.source !== 'estimated' || impact.tokenSource !== 'actual', 'estimated tokens are never labelled actual');
			}
		}
		// Copilot Chat fixture is dated 2026-09-21: persisted, but not part of today.
		assert.ok([...final.values()].some(e => e.provider === 'github-copilot' && Date.parse(e.startedAt) < startOfDay(NOW)));
		const tokensOf = (e: AiUsageEvent) => (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cachedInputTokens ?? 0) + (e.cacheCreationTokens ?? 0);
		const expected = {
			requests: today.length,
			tokens: today.reduce((s, e) => s + tokensOf(e), 0),
			energyWh: estimates.reduce((s, { impact }) => s + (impact?.energyWh ?? 0), 0),
		};

		// 13. Restart: close everything and reopen the same database file.
		const sessionToday = history.todayMetrics();
		history.dispose();
		history = openHistory();
		const restored = history.todayMetrics()!;
		assert.deepStrictEqual(restored, sessionToday, 'usage survives a restart');
		assert.deepStrictEqual([restored.requests, restored.tokens], [expected.requests, expected.tokens]);
		assert.ok(Math.abs(restored.energyWh - expected.energyWh) < 1e-9);
		assert.deepStrictEqual(history.providers('today').map(p => p.provider).sort(), ['claude-code', 'codex-cli', 'github-copilot-cli']);
		for (const summary of history.models('today')) {
			const own = estimates.filter(({ event }) => (event.model ?? null) === summary.model);
			const lowest = own.map(({ impact }) => impact?.confidence).filter((c): c is Confidence => !!c).sort((a, b) => RANK[a] - RANK[b])[0] ?? null;
			assert.strictEqual(summary.confidence, lowest, `${summary.model} confidence is the lowest of its requests`);
		}

		// 12, 14-15. Sidebar and Details show the same figures, with confidence reasons and methodology.
		const model = () => buildSidebarModel({ world: () => world.current, live: () => live.current(), history, statuses: () => usage.getStatuses() });
		const sidebar = toSidebarView(model(), { firstRun: false });
		const details = toDetailsView(model());
		const sidebarMessage = { type: 'view', ...sidebar };
		const detailsMessage = { type: 'details', ...details };
		assert.ok(isHostToWebviewMessage(sidebarMessage));
		assert.ok(isHostToDetailsMessage(detailsMessage));
		assert.deepStrictEqual(details.today, sidebar.today);
		assert.deepStrictEqual(details.providers.map(({ id, name, tokens, percent }) => ({ id, name, tokens, percent })), sidebar.providers);
		assert.strictEqual(sidebar.providers.reduce((s, p) => s + (p.percent ?? 0), 0), 100);
		assert.ok(details.overall.confidence, 'overall confidence is visible');
		assert.ok(details.models.every(m => m.estimate.confidence === null || m.estimate.lines.some(l => l.kind === 'why')));
		const methodology = methodologyView();
		const methodologyMessage = { type: 'methodology', ...methodology };
		assert.ok(isHostToDetailsMessage(methodologyMessage));
		assert.ok(methodology.sources.length > 0 && methodology.assumptions.length > 0 && methodology.limitations.length > 0);
		assert.ok(details.models.some(m => m.estimate.lines.some(l => l.kind === 'methodology' && l.value.endsWith(methodology.version))));

		const report = formatDiagnosticsReport(createDiagnosticsReport({
			extensionVersion: '0.0.1',
			vscodeVersion: '1.0.0',
			os: { platform: 'test', release: '1', arch: 'x64' },
			providers: usage.getStatuses(),
			storage: { available: history.available, persistent: true, recovered: false, failedOperations: history.failedOperations },
			settings: { animationEnabled: true, maxFps: 30, visualMode: 'environmental', retentionDays: 90 },
			now: clock.now(),
		}, { homeDir: root }));
		assert.match(report, /Database\n\nHealthy/);

		// 16. Clear local data: aggregates are empty and the database keeps working.
		assert.strictEqual(history.clear(), true);
		live.clear();
		assert.deepStrictEqual(history.todayMetrics(), { energyWh: 0, carbonGrams: 0, waterLiters: 0, tokens: 0, requests: 0 });
		assert.deepStrictEqual([history.models('today'), history.providers('today')], [[], []]);
		const cleared = toSidebarView(model(), { firstRun: false });
		assert.deepStrictEqual([cleared.live, cleared.today?.requests, cleared.providers], [null, 0, []]);
		history.record(today[0]);
		assert.strictEqual(history.todayMetrics()?.requests, 1);
		history.dispose();

		// Privacy: fixtures mark every prompt, response, path and repository with CANARY; none may surface.
		assertNoContent([events, logs, sidebarMessage, detailsMessage, methodologyMessage, report]);
		for (const name of fs.readdirSync(storageDir)) {
			assert.ok(!fs.readFileSync(path.join(storageDir, name)).toString('latin1').includes('CANARY'), `${name} holds conversation content`);
		}
	});

	test('usage logged while CarbonBit was closed is imported on start: stored, but the world stays idle', async () => {
		const dir = (...segments: string[]) => path.join(root, ...segments);
		const clock = new FakeClock();
		clock.advance(NOW);
		const now = () => clock.now();
		const logs: string[] = [];
		const log = (m: string) => logs.push(m);
		// The previous run ended before the fixture sessions; an older transcript did not change since.
		const since = Date.parse('2026-10-01T09:00:00.000Z');
		const write = (target: string, content: string) => {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		};
		write(dir('claude', 'proj', 'sess-a.jsonl'), readProviderFixture('claudeCode', 'session.jsonl'));
		write(dir('codex', '2026', '10', '01', 'rollout-x.jsonl'), readProviderFixture('codexCli', 'rollout.jsonl'));
		const unchanged = dir('claude', 'proj', 'sess-old.jsonl');
		write(unchanged, readProviderFixture('claudeCode', 'session.jsonl').replace(/sess-a/g, 'sess-old'));
		setModified(unchanged, since - DAY);

		const usage = new UsageService(log, { now });
		usage.register(new ClaudeCodeAdapter({ projectDirs: [dir('claude')], log, pollIntervalMs: 0, importSince: since }));
		usage.register(new CodexCliAdapter({ sessionDirs: [dir('codex')], log, pollIntervalMs: 0, importSince: since }));
		disposables.push({ dispose: () => { void usage.stop(); usage.dispose(); } });
		const history = new UsageHistory(openUsageStore({ file: path.join(storageDir, DATABASE_FILE_NAME), now, log }).store, { now, startOfDay, log });
		disposables.push(history);
		const world = new WorldStateEngine(() => { }, { clock });
		disposables.push(world);
		const live = new LiveActivity({ now });
		const origins = new Set<string | undefined>();
		usage.onUsageEvent((event, origin) => {
			origins.add(origin);
			if (origin !== 'import') {
				world.handle(event);
				live.handle(event);
			}
			history.record(event);
		});
		await usage.start();

		assert.deepStrictEqual([...origins], ['import']);
		assert.deepStrictEqual(history.providers('today').map(p => p.provider).sort(), ['claude-code', 'codex-cli']);
		assert.strictEqual(history.todayMetrics()?.requests, 6, '4 Claude Code responses and 2 Codex turns');
		assert.deepStrictEqual(world.current, { worldState: 'Idle', activeCount: 0 });
		assert.strictEqual(live.current(), null);
		assert.ok(usage.getStatuses().every(s => s.lastEventAt === null), 'imported history is not recent activity');
		assert.ok(logs.includes('[claude-code] imported 4 update(s) since the previous run'), logs.join('\n'));
		assertNoContent(logs);
	});
});
