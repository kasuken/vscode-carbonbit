import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CodexCliAdapter, codexSessionDirs } from '../core/providers/codexCli/codexCliAdapter';
import { isAiUsageEvent } from '../core/usage/usageEvent';
import { assertNoContent, createTailHarness, fixtureLines, readProviderFixture, setModified } from './providerHarness';

const create = () => createTailHarness((root, log) => new CodexCliAdapter({ sessionDirs: [root], log, pollIntervalMs: 0 }));
const ROLLOUT = ['2026', '10', '01', 'rollout-2026-10-01T15-00-00-codex-1.jsonl'];

suite('CodexCliAdapter', () => {
	let harness: ReturnType<typeof create>;
	setup(() => { harness = create(); });
	teardown(() => harness.cleanup());

	test('discovers sessions from CODEX_HOME or the home folder', () => {
		const home = path.join('h');
		assert.deepStrictEqual(codexSessionDirs({ CODEX_HOME: path.join('c') }, home), [path.join('c', 'sessions')]);
		assert.deepStrictEqual(codexSessionDirs({}, home), [path.join(home, '.codex', 'sessions')]);
	});

	test('reports unavailable without a sessions folder and stays inert', async () => {
		const missing = new CodexCliAdapter({ sessionDirs: [path.join(harness.root, 'missing')], pollIntervalMs: 0 });
		assert.strictEqual(await missing.isAvailable(), false);
		await missing.start();
		await missing.refresh();
		await missing.stop();
		assert.strictEqual(await harness.adapter.isAvailable(), true);
	});

	test('emits per-turn lifecycle with deltas of cumulative token counts', async () => {
		await harness.adapter.start();
		await harness.appendLines(harness.file(...ROLLOUT), fixtureLines('codexCli', 'rollout.jsonl'));

		const id = 'rollout-2026-10-01T15-00-00-codex-1';
		assert.deepStrictEqual(harness.events.map(e => [e.id.slice(id.length + 1), e.status, e.model, e.inputTokens, e.cachedInputTokens, e.outputTokens]), [
			['t1', 'started', undefined, undefined, undefined, undefined],
			['t1', 'started', 'gpt-5-codex', undefined, undefined, undefined],
			['t1', 'processing', 'gpt-5-codex', 200, 800, 50],
			['t1', 'processing', 'gpt-5-codex', 700, 1800, 120],
			['t1', 'completed', 'gpt-5-codex', 700, 1800, 120],
			['t2', 'started', 'gpt-5-codex', undefined, undefined, undefined],
			['t2', 'started', 'some-future-model', undefined, undefined, undefined],
			['t2', 'processing', 'some-future-model', 300, 200, 30],
			['t2', 'completed', 'some-future-model', 300, 200, 30],
		]);
		assert.deepStrictEqual(harness.events[4], {
			id: `${id}/t1`, provider: 'codex-cli', model: 'gpt-5-codex',
			startedAt: '2026-10-01T15:00:01.000Z', completedAt: '2026-10-01T15:00:09.000Z',
			inputTokens: 700, outputTokens: 120, cachedInputTokens: 1800, source: 'actual', status: 'completed',
		});
		assert.ok(harness.events.every(isAiUsageEvent));
		assertNoContent([harness.events, harness.logs]);
	});

	test('skips existing history and uses the last usage when earlier totals are unknown', async () => {
		const file = harness.file(...ROLLOUT);
		fs.writeFileSync(file, readProviderFixture('codexCli', 'rollout.jsonl'));
		await harness.adapter.start();
		await harness.adapter.refresh();
		assert.strictEqual(harness.events.length, 0);

		await harness.appendLines(file, [
			'{"timestamp":"2026-10-01T18:00:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t9"}}',
			'{"timestamp":"2026-10-01T18:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":3100,"cached_input_tokens":2000,"output_tokens":160},"last_token_usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}}}',
		]);
		assert.deepStrictEqual(harness.events.map(e => [e.id.split('/')[1], e.status, e.inputTokens, e.outputTokens]), [['t9', 'started', undefined, undefined], ['t9', 'processing', 100, 10]]);
	});

	test('imports turns active since the previous run with deltas computed from the whole rollout', async () => {
		const since = Date.parse('2026-10-01T15:00:30.000Z');
		const imported = createTailHarness((root, log) => new CodexCliAdapter({ sessionDirs: [root], log, pollIntervalMs: 0, importSince: since }));
		try {
			fs.writeFileSync(imported.file(...ROLLOUT), readProviderFixture('codexCli', 'rollout.jsonl'));
			await imported.adapter.start();
			assert.deepStrictEqual(imported.events.map(e => [e.id.split('/')[1], e.status, e.model, e.inputTokens, e.cachedInputTokens, e.outputTokens]), [
				['t2', 'completed', 'some-future-model', 300, 200, 30],
			]);
			assert.deepStrictEqual(imported.origins, ['import']);
			assert.ok(imported.events.every(isAiUsageEvent));
			assertNoContent([imported.events, imported.logs]);
		} finally {
			await imported.cleanup();
		}
	});

	test('imports rollouts appended since the previous run even when their mtime lags behind', async () => {
		const since = Date.parse('2026-10-01T15:00:30.000Z');
		const imported = createTailHarness((root, log) => new CodexCliAdapter({ sessionDirs: [root], log, pollIntervalMs: 0, importSince: since }));
		try {
			const file = imported.file(...ROLLOUT);
			fs.writeFileSync(file, readProviderFixture('codexCli', 'rollout.jsonl'));
			// Codex on Windows can keep the mtime of when the rollout was opened while it keeps appending.
			setModified(file, Date.parse('2026-10-01T15:00:00.000Z'));
			const old = imported.file('2026', '09', '30', 'rollout-old.jsonl');
			fs.writeFileSync(old, fixtureLines('codexCli', 'rollout.jsonl').slice(0, 12).join('\n') + '\n');
			setModified(old, since - 60_000);
			await imported.adapter.start();
			assert.deepStrictEqual(imported.events.map(e => [e.id.split('/')[1], e.status]), [['t2', 'completed']]);
			assert.deepStrictEqual(imported.origins, ['import']);
			assertNoContent([imported.events, imported.logs]);
		} finally {
			await imported.cleanup();
		}
	});

	test('estimates turns without token counts and waits for incomplete lines', async () => {
		await harness.adapter.start();
		const file = harness.file(...ROLLOUT);
		fs.writeFileSync(file, readProviderFixture('codexCli', 'partial.jsonl').replace(/\r?\n$/, ''));
		await harness.adapter.refresh();

		const last = (turn: string) => harness.events.filter(e => e.id.endsWith(`/${turn}`)).at(-1)!;
		assert.deepStrictEqual([last('t3').status, last('t3').inputTokens, last('t3').outputTokens, last('t3').source], ['completed', 5, 7, 'estimated']);
		assert.deepStrictEqual([last('t4').status, last('t4').source], ['started', 'actual']);

		fs.appendFileSync(file, 'ens":25}}}}\n');
		await harness.adapter.refresh();
		assert.deepStrictEqual([last('t4').status, last('t4').inputTokens, last('t4').cachedInputTokens, last('t4').outputTokens], ['processing', 300, 100, 25]);
		assert.ok(!harness.logs.some(l => l.includes('malformed')));
		assertNoContent(harness.events);
	});

	test('skips malformed lines with safe diagnostics', async () => {
		await harness.adapter.start();
		fs.writeFileSync(harness.file(...ROLLOUT), readProviderFixture('codexCli', 'malformed.jsonl'));
		await harness.adapter.refresh();

		assert.deepStrictEqual(harness.events.map(e => [e.id.split('/')[1], e.status, e.model, e.inputTokens, e.outputTokens, e.source]),
			[['t5', 'completed', undefined, undefined, undefined, 'estimated']]);
		assert.ok(harness.logs.includes('[codex-cli] skipped 3 malformed line(s) in session rollout-2026-10-01T15-00-00-codex-1'));
		assertNoContent([harness.events, harness.logs]);
	});
});
