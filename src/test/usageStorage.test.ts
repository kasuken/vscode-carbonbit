import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ENVIRONMENTAL_FACTORS } from '../core/impact/data/environmentalFactors';
import { ImpactEngine } from '../core/impact/impactEngine';
import { isHostToWebviewMessage } from '../core/messages/protocol';
import { DEFAULT_RETENTION_DAYS, normalizeRetentionDays, RETENTION_DAY_OPTIONS } from '../core/settings/retentionSettings';
import { DATABASE_FILE_NAME, loadNodeSqlite, openUsageStore } from '../core/storage/openUsageStore';
import { localStartOfDay, UsageHistory, UsageHistoryOptions } from '../core/storage/usageHistory';
import { MIGRATIONS, SCHEMA_VERSION, UsageStore } from '../core/storage/usageStore';
import type { AiUsageEvent } from '../core/usage/usageEvent';
import { toSidebarView } from '../core/view/sidebarView';

const DAY = 24 * 60 * 60 * 1000;
// Fixed "now" with UTC day boundaries so results don't depend on the machine's timezone.
const NOW = Date.parse('2026-10-01T15:00:00.000Z');
const utcStartOfDay = (ms: number) => ms - (ms % DAY);
const iso = (ms: number) => new Date(ms).toISOString();

function ev(fields: Partial<AiUsageEvent> = {}): AiUsageEvent {
	return {
		id: 'r1', provider: 'claude-code', model: 'claude-sonnet-4.5', startedAt: iso(NOW - 60_000),
		completedAt: iso(NOW - 55_000), inputTokens: 1000, outputTokens: 500, source: 'actual', status: 'completed', ...fields,
	};
}

function sqlite() {
	const module = loadNodeSqlite();
	assert.ok(module, 'node:sqlite must be available in the extension host');
	return module;
}

/** Reads a database file directly, bypassing the store. */
function inspect<T>(file: string, query: (db: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']>) => T): T {
	const db = new (sqlite().DatabaseSync)(file);
	try {
		return query(db);
	} finally {
		db.close();
	}
}

const EXPECTED_COLUMNS = [
	'id', 'provider', 'model', 'started_at', 'completed_at', 'status', 'source',
	'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_creation_tokens',
	'energy_wh', 'carbon_grams', 'water_liters', 'confidence', 'token_provenance', 'factor_level',
	'methodology_version', 'updated_at',
];

suite('Usage storage', () => {
	let dir: string;
	let file: string;
	const open: UsageHistory[] = [];

	function history(options: UsageHistoryOptions & { migrations?: readonly string[] } = {}): UsageHistory {
		const opened = openUsageStore({ file, now: () => NOW, migrations: options.migrations });
		const h = new UsageHistory(opened.store, { now: () => NOW, startOfDay: utcStartOfDay, sessionStart: NOW - 10 * 60_000, ...options });
		open.push(h);
		return h;
	}

	function memoryHistory(options: UsageHistoryOptions = {}): { history: UsageHistory; store: UsageStore } {
		const store = openUsageStore().store!;
		const h = new UsageHistory(store, { now: () => NOW, startOfDay: utcStartOfDay, sessionStart: NOW - 10 * 60_000, ...options });
		open.push(h);
		return { history: h, store };
	}

	setup(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbonbit-'));
		file = path.join(dir, 'globalStorage', DATABASE_FILE_NAME);
	});

	teardown(() => {
		open.splice(0).forEach(h => h.dispose());
		fs.rmSync(dir, { recursive: true, force: true });
	});

	suite('initialization and migration (#37)', () => {
		test(`node:sqlite loads in this host (node ${process.versions.node}, electron ${process.versions.electron ?? 'n/a'})`, () => {
			const db = new (sqlite().DatabaseSync)(':memory:');
			assert.match(String(db.prepare('SELECT sqlite_version() AS v').get()?.v), /^3\./);
			db.close();
		});

		test('fresh install creates the database with the current schema version', () => {
			const opened = openUsageStore({ file });
			assert.ok(opened.store);
			assert.deepStrictEqual([opened.persistent, opened.warning], [true, undefined]);
			opened.store.close();
			assert.ok(fs.existsSync(file));
			assert.strictEqual(inspect(file, db => db.prepare('PRAGMA user_version').get()?.user_version), SCHEMA_VERSION);
		});

		test('the file database uses WAL with NORMAL sync, so a large import does not flush on every request', () => {
			const opened = openUsageStore({ file });
			const db = (opened.store as unknown as { db: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']> }).db;
			assert.strictEqual(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
			assert.strictEqual(db.prepare('PRAGMA synchronous').get()?.synchronous, 1, 'NORMAL');
			opened.store!.close();
		});

		test('schema upgrades keep existing data', () => {
			const v1 = history();
			v1.record(ev());
			v1.dispose();

			const upgraded = [...MIGRATIONS, 'ALTER TABLE usage_events ADD COLUMN future_field INTEGER'];
			const v2 = history({ migrations: upgraded });
			assert.strictEqual(v2.totals('today').requests, 1);
			v2.dispose();
			assert.strictEqual(inspect(file, db => db.prepare('PRAGMA user_version').get()?.user_version), MIGRATIONS.length + 1);
		});

		test('a newer schema is left untouched and usage falls back to memory', () => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			inspect(file, db => db.exec('PRAGMA user_version = 99'));
			const logs: string[] = [];
			const opened = openUsageStore({ file, log: m => logs.push(m) });
			assert.ok(opened.store);
			assert.strictEqual(opened.persistent, false);
			assert.ok(opened.warning);
			opened.store.close();
			assert.strictEqual(inspect(file, db => db.prepare('PRAGMA user_version').get()?.user_version), 99);
			assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter(f => f.includes('corrupt')), []);
			assert.ok(logs.some(m => m.includes('newer')));
		});
	});

	suite('recovery (#38)', () => {
		test('a corrupt database is backed up and recreated', () => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'this is not a sqlite database, just garbage bytes '.repeat(100));
			const opened = openUsageStore({ file, now: () => 1234 });
			assert.ok(opened.store);
			assert.strictEqual(opened.persistent, true);
			assert.match(opened.warning ?? '', /reset/);
			assert.ok(fs.readFileSync(`${file}.corrupt-1234`, 'utf8').startsWith('this is not a sqlite'));

			const h = new UsageHistory(opened.store, { now: () => NOW, startOfDay: utcStartOfDay });
			open.push(h);
			h.record(ev());
			assert.strictEqual(h.totals('today').requests, 1);
		});

		test('an unopenable location degrades to an in-memory database with a warning', () => {
			const blocker = path.join(dir, 'not-a-folder');
			fs.writeFileSync(blocker, '');
			const opened = openUsageStore({ file: path.join(blocker, DATABASE_FILE_NAME) });
			assert.ok(opened.store);
			assert.strictEqual(opened.persistent, false);
			assert.match(opened.warning ?? '', /memory/);
			const h = new UsageHistory(opened.store, { now: () => NOW, startOfDay: utcStartOfDay });
			open.push(h);
			h.record(ev());
			assert.strictEqual(h.todayMetrics()?.requests, 1);
		});

		test('without SQLite, history is disabled but never throws', () => {
			const opened = openUsageStore({ file, loadSqlite: () => undefined });
			assert.deepStrictEqual([opened.store, opened.persistent], [undefined, false]);
			assert.ok(opened.warning);
			const h = new UsageHistory(opened.store);
			assert.doesNotThrow(() => h.record(ev()));
			assert.deepStrictEqual([h.available, h.todayMetrics(), h.clear(), h.pruneExpired()], [false, null, false, 0]);
		});

		test('storage errors after open are logged once and swallowed', () => {
			const store = openUsageStore().store!;
			const logs: string[] = [];
			const h = new UsageHistory(store, { log: m => logs.push(m) });
			store.close();
			assert.doesNotThrow(() => { h.record(ev()); h.record(ev({ id: 'r2' })); });
			assert.deepStrictEqual(h.totals('today'), { requests: 0, tokens: 0, energyWh: 0, carbonGrams: 0, waterLiters: 0 });
			assert.strictEqual(logs.filter(m => m.startsWith('storage: record failed')).length, 1);
		});
	});

	suite('persisted metadata (#31)', () => {
		test('the schema holds only calculation metadata (column whitelist)', () => {
			history().dispose();
			const columns = inspect(file, db => db.prepare('PRAGMA table_info(usage_events)').all().map(c => c.name));
			assert.deepStrictEqual(columns, EXPECTED_COLUMNS);
			const tables = inspect(file, db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name));
			assert.deepStrictEqual(tables, ['usage_events']);
		});

		test('conversation content smuggled onto an event never reaches the file', () => {
			const h = history();
			h.record({ ...ev(), prompt: 'SECRET-PROMPT', response: 'SECRET-RESPONSE', file: 'secret-file.ts' } as AiUsageEvent);
			h.dispose();
			const bytes = fs.readFileSync(file).toString('latin1');
			for (const secret of ['SECRET-PROMPT', 'SECRET-RESPONSE', 'secret-file.ts']) {
				assert.ok(!bytes.includes(secret), `${secret} persisted`);
			}
		});

		test('lifecycle updates upsert one row and survive a restart', () => {
			const h = history();
			const started = ev({ status: 'started', completedAt: undefined, inputTokens: undefined, outputTokens: undefined });
			h.record(started);
			h.record({ ...started, status: 'processing', outputTokens: 20 });
			const final = ev({ inputTokens: 1000, outputTokens: 500, cachedInputTokens: 300 });
			h.record(final);
			h.record({ ...started, status: 'processing', outputTokens: 40 });
			h.dispose();

			const reopened = history();
			const { store } = openUsageStore({ file });
			const row = store!.get('r1')!;
			store!.close();
			const expected = new ImpactEngine().estimate(final)!;
			assert.deepStrictEqual(
				[row.status, row.inputTokens, row.outputTokens, row.cachedInputTokens, row.completedAt, row.model],
				['completed', 1000, 500, 300, Date.parse(final.completedAt!), 'claude-sonnet-4.5'],
			);
			assert.deepStrictEqual(
				[row.energyWh, row.carbonGrams, row.waterLiters, row.confidence, row.tokenProvenance, row.factorLevel, row.methodologyVersion],
				[expected.energyWh, expected.carbonGrams, expected.waterLiters, expected.confidence, expected.tokenSource, expected.factorLevel, expected.methodologyVersion],
			);
			assert.strictEqual(reopened.totals('today').requests, 1);
		});

		test('later updates keep fields earlier updates already reported', () => {
			const { history: h, store } = memoryHistory();
			h.record(ev({ status: 'processing', completedAt: undefined, outputTokens: undefined }));
			h.record(ev({ model: undefined, inputTokens: undefined, outputTokens: 700 }));
			const row = store.get('r1')!;
			assert.deepStrictEqual([row.model, row.inputTokens, row.outputTokens, row.status], ['claude-sonnet-4.5', 1000, 700, 'completed']);
			assert.strictEqual(row.energyWh, new ImpactEngine().estimate(ev({ outputTokens: 700 }))!.energyWh);
		});
	});

	suite('aggregation (#28)', () => {
		const sessionStart = NOW - 10 * 60_000;

		function seed(h: UsageHistory): AiUsageEvent[] {
			const events: AiUsageEvent[] = [
				ev({ id: 'yesterday', startedAt: iso(utcStartOfDay(NOW) - 1), completedAt: iso(utcStartOfDay(NOW) + 1000) }),
				ev({ id: 'midnight', provider: 'github-copilot', model: 'gpt-4.1', startedAt: iso(utcStartOfDay(NOW)), completedAt: undefined, status: 'failed', inputTokens: 200, outputTokens: 0 }),
				ev({ id: 'session1', startedAt: iso(sessionStart), inputTokens: 3000, outputTokens: 1000, cachedInputTokens: 1000 }),
				ev({ id: 'session2', provider: 'codex-cli', model: 'gpt-4.1', startedAt: iso(NOW - 1000), completedAt: undefined, status: 'processing', inputTokens: 1800, outputTokens: undefined }),
				ev({ id: 'pending', provider: 'codex-cli', model: undefined, startedAt: iso(NOW), completedAt: undefined, status: 'started', inputTokens: undefined, outputTokens: undefined }),
			];
			events.forEach(e => h.record(e));
			return events;
		}

		function sum(events: AiUsageEvent[]) {
			const engine = new ImpactEngine();
			return events.reduce((t, e) => {
				const est = engine.estimate(e);
				return {
					requests: t.requests + 1,
					tokens: t.tokens + (e.inputTokens ?? 0) + (e.outputTokens ?? 0) + (e.cachedInputTokens ?? 0) + (e.cacheCreationTokens ?? 0),
					energyWh: t.energyWh + (est?.energyWh ?? 0),
					carbonGrams: t.carbonGrams + (est?.carbonGrams ?? 0),
					waterLiters: t.waterLiters + (est?.waterLiters ?? 0),
				};
			}, { requests: 0, tokens: 0, energyWh: 0, carbonGrams: 0, waterLiters: 0 });
		}

		function assertTotals(actual: ReturnType<UsageHistory['totals']>, expected: ReturnType<typeof sum>): void {
			assert.deepStrictEqual([actual.requests, actual.tokens], [expected.requests, expected.tokens]);
			for (const key of ['energyWh', 'carbonGrams', 'waterLiters'] as const) {
				assert.ok(Math.abs(actual[key] - expected[key]) < 1e-12, `${key}: ${actual[key]} vs ${expected[key]}`);
			}
		}

		test('today starts at the local-day boundary; session starts at activation', () => {
			const { history: h } = memoryHistory({ sessionStart });
			const events = seed(h);
			// Failed and in-flight requests count, with whatever usage they reported.
			assertTotals(h.totals('today'), sum(events.slice(1)));
			assertTotals(h.totals('session'), sum(events.slice(2)));
		});

		test('today rolls over at midnight', () => {
			let now = NOW;
			const { history: h } = memoryHistory({ now: () => now });
			h.record(ev());
			assert.strictEqual(h.totals('today').requests, 1);
			now = utcStartOfDay(NOW) + DAY;
			assert.strictEqual(h.totals('today').requests, 0);
		});

		test('model summaries group by model with their lowest confidence', () => {
			const { history: h } = memoryHistory({ sessionStart });
			seed(h);
			const models = h.models('today');
			assert.deepStrictEqual(models.map(m => [m.model, m.requests, m.tokens]), [
				['claude-sonnet-4.5', 1, 5000],
				['gpt-4.1', 2, 2000],
				[null, 1, 0],
			]);
			assert.deepStrictEqual(models.map(m => m.confidence), ['medium', 'low', null]);
		});

		test('model summaries carry factor level, token provenance and methodology versions', () => {
			const { history: h } = memoryHistory({ sessionStart });
			seed(h);
			h.record(ev({ id: 'estimated', model: 'gpt-4.1', source: 'estimated' }));
			const models = h.models('today');
			assert.deepStrictEqual(models.map(m => [m.model, m.factorLevel, m.tokenProvenance, m.methodologyVersions]), [
				['claude-sonnet-4.5', 'class', { actual: 1, partial: 0, estimated: 0 }, [ENVIRONMENTAL_FACTORS.methodology.version]],
				['gpt-4.1', 'class', { actual: 1, partial: 1, estimated: 1 }, [ENVIRONMENTAL_FACTORS.methodology.version]],
				[null, null, { actual: 0, partial: 0, estimated: 0 }, []],
			]);
		});

		test('provider distribution uses token totals', () => {
			const { history: h } = memoryHistory({ sessionStart });
			seed(h);
			const providers = h.providers('today');
			assert.deepStrictEqual(providers.map(p => [p.provider, p.tokens, p.requests]), [
				['claude-code', 5000, 1],
				['codex-cli', 1800, 2],
				['github-copilot', 200, 1],
			]);
			assert.deepStrictEqual(providers.map(p => Math.round(p.percent * 100) / 100), [71.43, 25.71, 2.86]);
			assert.ok(Math.abs(providers.reduce((s, p) => s + p.percent, 0) - 100) < 1e-9);

			const { history: empty } = memoryHistory();
			empty.record(ev({ status: 'started', completedAt: undefined, inputTokens: undefined, outputTokens: undefined }));
			assert.deepStrictEqual(empty.providers('today').map(p => p.percent), [0]);
		});

		test('today metrics and provider shares form a valid sidebar view message', () => {
			const { history: h } = memoryHistory();
			assert.deepStrictEqual(h.todayMetrics(), { energyWh: 0, carbonGrams: 0, waterLiters: 0, tokens: 0, requests: 0 });
			seed(h);
			const today = h.todayMetrics();
			assert.strictEqual(today?.requests, 4);
			const view = toSidebarView({
				worldState: 'Idle', activeCount: 0, live: null, today, session: h.totals('session'), periods: h.periods(), activity: h.activity(120_000, 30),
				providers: h.providers('today'), models: [], providerStatuses: [], anyProviderDetected: false,
			}, { firstRun: false });
			assert.ok(isHostToWebviewMessage({ type: 'view', ...view }));
		});

		test('localStartOfDay returns local midnight', () => {
			const start = localStartOfDay(NOW);
			const d = new Date(start);
			assert.deepStrictEqual([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()], [0, 0, 0, 0]);
			assert.ok(start <= NOW && NOW - start < DAY + 60 * 60 * 1000);
			assert.strictEqual(localStartOfDay(start), start);
		});
	});

	suite('periods and live activity', () => {
		const utcStartOfMonth = (ms: number, offset: number) => {
			const d = new Date(ms);
			return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
		};
		const byId = (h: UsageHistory) => Object.fromEntries(h.periods().map(p => [p.id, p]));

		test('today, rolling 30 days and the previous calendar month use their own ranges', () => {
			const { history: h } = memoryHistory({ startOfMonth: utcStartOfMonth });
			h.record(ev({ id: 'today' }));
			h.record(ev({ id: 'last-week', startedAt: iso(NOW - 7 * DAY) }));
			h.record(ev({ id: 'september', startedAt: iso(Date.parse('2026-09-02T10:00:00.000Z')) }));
			h.record(ev({ id: 'august', startedAt: iso(Date.parse('2026-08-20T10:00:00.000Z')) }));
			const periods = byId(h);
			assert.deepStrictEqual(h.periods().map(p => p.id), ['today', 'last30Days', 'previousMonth', 'projectedYear']);
			assert.strictEqual(periods.today.totals.requests, 1);
			assert.strictEqual(periods.last30Days.totals.requests, 3, 'today, last week and early September');
			assert.strictEqual(periods.previousMonth.totals.requests, 2, 'last week and early September are both in September');
			assert.strictEqual(periods.previousMonth.from, Date.parse('2026-09-01T00:00:00.000Z'));
		});

		test('coverage tells a period with no recorded history apart from a period with no usage', () => {
			const { history: h } = memoryHistory({ startOfMonth: utcStartOfMonth });
			const coverage = () => h.periods().map(p => [p.id, p.coverage, p.dataFrom]);
			assert.deepStrictEqual(coverage(), [['today', 'full', null], ['last30Days', 'none', null], ['previousMonth', 'none', null], ['projectedYear', 'none', null]]);
			const midSeptember = Date.parse('2026-09-12T08:00:00.000Z');
			h.record(ev({ id: 'first', startedAt: iso(midSeptember) }));
			assert.deepStrictEqual(coverage(), [
				['today', 'full', null], ['last30Days', 'partial', midSeptember], ['previousMonth', 'partial', midSeptember], ['projectedYear', 'full', null],
			]);
			h.record(ev({ id: 'august', startedAt: iso(Date.parse('2026-08-20T08:00:00.000Z')) }));
			assert.deepStrictEqual(coverage().map(c => c[1]), ['full', 'full', 'full', 'full']);
		});

		test('the projected year scales by the days of recorded usage, never by days before tracking', () => {
			const { history: h } = memoryHistory();
			assert.deepStrictEqual([byId(h).projectedYear.totals.requests, byId(h).projectedYear.basisDays], [0, 0], 'nothing to project');
			h.record(ev({ id: 'a', startedAt: iso(NOW - 2 * 60_000) }));
			const oneDay = byId(h).projectedYear;
			assert.strictEqual(oneDay.basisDays, 1, 'less than a day of usage counts as one day');
			assert.ok(Math.abs(oneDay.totals.carbonGrams - h.totals('today').carbonGrams * 365) < 1e-9);
			h.record(ev({ id: 'b', startedAt: iso(NOW - 10 * DAY) }));
			const tenDays = byId(h).projectedYear;
			assert.strictEqual(tenDays.basisDays, 10);
			assert.ok(Math.abs(tenDays.totals.energyWh - byId(h).last30Days.totals.energyWh * 36.5) < 1e-9);
			assert.strictEqual(tenDays.totals.requests, 73);
			h.record(ev({ id: 'c', startedAt: iso(NOW - 29.5 * DAY) }));
			assert.strictEqual(byId(h).projectedYear.basisDays, 30, 'capped at the rolling window');
		});

		test('activity is bucketed on clock-aligned slices, oldest first, with empty slices as zero', () => {
			const { history: h } = memoryHistory();
			const bucket = 2 * 60_000;
			const current = Math.floor(NOW / bucket) * bucket;
			h.record(ev({ id: 'now', startedAt: iso(current + 1) }));
			h.record(ev({ id: 'earlier', startedAt: iso(current - 3 * bucket), inputTokens: 100, outputTokens: 0 }));
			h.record(ev({ id: 'too-old', startedAt: iso(current - 30 * bucket) }));
			const tokens = h.activity(bucket, 30).map(b => b.tokens);
			assert.strictEqual(tokens.length, 30);
			assert.strictEqual(tokens[29], 1500);
			assert.strictEqual(tokens[26], 100);
			assert.strictEqual(tokens.reduce((a, b) => a + b, 0), 1600);
		});

		test('periods and activity form a valid view message with everyday comparisons', () => {
			const { history: h } = memoryHistory();
			h.record(ev({ inputTokens: 200_000, outputTokens: 50_000 }));
			const view = toSidebarView({
				worldState: 'Idle', activeCount: 0, live: null, today: h.todayMetrics(), session: h.totals('session'), periods: h.periods(),
				activity: h.activity(120_000, 30), providers: [], models: [], providerStatuses: [], anyProviderDetected: false,
			}, { firstRun: false });
			assert.ok(isHostToWebviewMessage({ type: 'view', ...view }));
			assert.deepStrictEqual(view.periods.map(p => p.label), ['Today', 'Last 30 days', 'Previous month', 'Projected year']);
			assert.strictEqual(view.periods[2].note, 'September 2026, no data', 'nothing recorded is not shown as zero usage');
			assert.deepStrictEqual(view.periods.map(p => p.coverage), ['full', 'partial', 'none', 'full']);
			assert.strictEqual(view.periods[1].note, `Data from ${new Date(NOW - 60_000).toLocaleString('en', { day: 'numeric', month: 'short' })}`);
			assert.strictEqual(view.periods[3].note, 'From 1 day of usage');
			assert.deepStrictEqual(view.periods[0].carbon.map(e => e.id), ['car', 'train', 'flight', 'kettle', 'phone', 'led']);
			assert.deepStrictEqual(view.periods[0].water.map(e => e.id), ['tea', 'shower', 'laundry', 'bath', 'dishwasher', 'drinking']);
			assert.match(view.activity!.summary, /^250K tokens in the last hour$/);
		});
	});

	suite('retention and clearing (#29)', () => {
		test('only the PRD options are accepted', () => {
			assert.deepStrictEqual(RETENTION_DAY_OPTIONS.map(normalizeRetentionDays), [7, 30, 90, 365, 0]);
			for (const bad of [undefined, null, 1, -7, 90.5, '30', 1000]) {
				assert.strictEqual(normalizeRetentionDays(bad), DEFAULT_RETENTION_DAYS);
			}
		});

		for (const days of [7, 30, 90, 365]) {
			test(`${days}-day retention removes only requests older than ${days} days`, () => {
				const { history: h, store } = memoryHistory();
				const cutoff = NOW - days * DAY;
				h.record(ev({ id: 'expired', startedAt: iso(cutoff - 1), completedAt: iso(cutoff) }));
				h.record(ev({ id: 'boundary', startedAt: iso(cutoff), completedAt: iso(cutoff + 1) }));
				assert.strictEqual(h.setRetentionDays(days), 1);
				assert.deepStrictEqual([store.get('expired'), store.get('boundary')?.id], [undefined, 'boundary']);

				h.record(ev({ id: 'replayed', startedAt: iso(cutoff - 1), completedAt: iso(cutoff) }));
				assert.strictEqual(store.get('replayed'), undefined);
			});
		}

		test('unlimited retention (0) keeps everything', () => {
			const { history: h, store } = memoryHistory({ retentionDays: 0 });
			h.record(ev({ id: 'ancient', startedAt: iso(NOW - 3650 * DAY), completedAt: iso(NOW - 3650 * DAY + 1) }));
			assert.strictEqual(h.pruneExpired(), 0);
			assert.ok(store.get('ancient'));
		});

		test('clearing removes all usage, keeps other storage, and the database stays usable', () => {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const unrelated = path.join(path.dirname(file), 'other-state.json');
			fs.writeFileSync(unrelated, '{}');
			const h = history();
			h.record(ev({ id: 'a' }));
			h.record(ev({ id: 'b', startedAt: iso(NOW - 5 * DAY), completedAt: iso(NOW - 5 * DAY + 1) }));

			assert.strictEqual(h.clear(), true);
			assert.deepStrictEqual(h.totals('today'), { requests: 0, tokens: 0, energyWh: 0, carbonGrams: 0, waterLiters: 0 });
			assert.ok(fs.existsSync(unrelated));
			h.record(ev({ id: 'c' }));
			h.dispose();
			assert.deepStrictEqual(inspect(file, db => db.prepare('SELECT id FROM usage_events').all().map(r => r.id)), ['c']);
		});
	});
});
