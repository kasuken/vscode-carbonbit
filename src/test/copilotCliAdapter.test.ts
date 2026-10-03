import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CopilotCliAdapter, copilotCliSessionDirs } from '../core/providers/copilotCli/copilotCliAdapter';
import { isAiUsageEvent } from '../core/usage/usageEvent';
import { assertNoContent, createTailHarness, fixtureLines, readProviderFixture } from './providerHarness';

const create = () => createTailHarness((root, log) => new CopilotCliAdapter({ sessionDirs: [root], log, pollIntervalMs: 0 }));

suite('CopilotCliAdapter', () => {
	let harness: ReturnType<typeof create>;
	setup(() => { harness = create(); });
	teardown(() => harness.cleanup());

	test('discovers session-state from COPILOT_HOME, XDG_CONFIG_HOME or the home folder', () => {
		const home = path.join('h');
		assert.deepStrictEqual(copilotCliSessionDirs({ COPILOT_HOME: path.join('c') }, home), [path.join('c', 'session-state')]);
		assert.deepStrictEqual(copilotCliSessionDirs({}, home), [path.join(home, '.copilot', 'session-state')]);
		assert.deepStrictEqual(copilotCliSessionDirs({ XDG_CONFIG_HOME: path.join('x') }, home),
			[path.join('x', '.copilot', 'session-state'), path.join(home, '.copilot', 'session-state')]);
	});

	test('reports unavailable without a session-state folder and stays inert', async () => {
		const missing = new CopilotCliAdapter({ sessionDirs: [path.join(harness.root, 'missing')], pollIntervalMs: 0 });
		assert.strictEqual(await missing.isAvailable(), false);
		await missing.start();
		await missing.refresh();
		await missing.stop();
		assert.strictEqual(await harness.adapter.isAvailable(), true);
	});

	test('emits per-call output tokens and reconciles input/cache totals at shutdown', async () => {
		await harness.adapter.start();
		await harness.appendLines(harness.file('cli-session-1', 'events.jsonl'), fixtureLines('copilotCli', 'events.jsonl'));

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.model, e.inputTokens, e.outputTokens, e.cachedInputTokens, e.cacheCreationTokens, e.source]), [
			['cli-session-1/m-1', 'claude-sonnet-4.5', undefined, 120, undefined, undefined, 'actual'],
			['cli-session-1/m-2', 'claude-sonnet-4.5', undefined, 30, undefined, undefined, 'actual'],
			['cli-session-1/m-3', 'gpt-5-mini', undefined, 10, undefined, undefined, 'actual'],
			['cli-session-1/ev-10/claude-sonnet-4.5', 'claude-sonnet-4.5', 500, 50, 4000, 500, 'actual'],
			['cli-session-1/ev-10/gpt-5-mini', 'gpt-5-mini', 900, 0, 0, 0, 'actual'],
		]);
		assert.deepStrictEqual(harness.events[0], {
			id: 'cli-session-1/m-1', provider: 'github-copilot-cli', model: 'claude-sonnet-4.5',
			startedAt: '2026-10-01T09:00:05.000Z', outputTokens: 120, source: 'actual', status: 'completed',
		});
		assert.ok(harness.events.every(isAiUsageEvent));
		assertNoContent([harness.events, harness.logs]);
	});

	test('skips existing history and does not reconcile segments that started before tracking', async () => {
		const file = harness.file('cli-session-1', 'events.jsonl');
		const lines = fixtureLines('copilotCli', 'events.jsonl');
		fs.writeFileSync(file, lines.slice(0, 8).join('\n') + '\n');
		await harness.adapter.start();
		await harness.adapter.refresh();
		assert.strictEqual(harness.events.length, 0);

		await harness.appendLines(file, lines.slice(8));
		assert.deepStrictEqual(harness.events.map(e => e.id), ['cli-session-1/m-3']);
	});

	test('estimates older messages without counts and waits for incomplete lines', async () => {
		await harness.adapter.start();
		const file = harness.file('cli-session-2', 'events.jsonl');
		fs.writeFileSync(file, readProviderFixture('copilotCli', 'partial.jsonl').replace(/\r?\n$/, ''));
		await harness.adapter.refresh();

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.model, e.outputTokens, e.source]), [
			['cli-session-2/m-old', 'some-future-model', 6, 'estimated'],
			['cli-session-2/m-tools-only', 'some-future-model', undefined, 'estimated'],
		]);
		fs.appendFileSync(file, 'okens":15}}\n');
		await harness.adapter.refresh();
		assert.deepStrictEqual([harness.events.at(-1)!.id, harness.events.at(-1)!.outputTokens, harness.events.at(-1)!.source], ['cli-session-2/m-late', 15, 'actual']);
		assert.ok(!harness.logs.some(l => l.includes('malformed')));
		assertNoContent(harness.events);
	});

	test('skips malformed lines with safe diagnostics', async () => {
		await harness.adapter.start();
		fs.writeFileSync(harness.file('cli-session-3', 'events.jsonl'), readProviderFixture('copilotCli', 'malformed.jsonl'));
		await harness.adapter.refresh();

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.outputTokens, e.source]), [['cli-session-3/m-bad-count', 4, 'estimated']]);
		assert.ok(harness.logs.includes('[github-copilot-cli] skipped 3 malformed line(s) in session cli-session-3'));
		assertNoContent([harness.events, harness.logs]);
	});
});
