import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeCodeAdapter, claudeCodeProjectDirs } from '../core/providers/claudeCode/claudeCodeAdapter';
import { isAiUsageEvent } from '../core/usage/usageEvent';
import { assertNoContent, createTailHarness, fixtureLines, readProviderFixture, setModified } from './providerHarness';

const create = () => createTailHarness((root, log) => new ClaudeCodeAdapter({ projectDirs: [root], log, pollIntervalMs: 0 }));

/** Counts folder listings and can simulate a listing that transiently misses every file. */
class ListingAdapter extends ClaudeCodeAdapter {
	listings = 0;
	hideFiles = false;

	constructor(root: string, log: (message: string) => void) {
		super({ projectDirs: [root], log, pollIntervalMs: 0 });
	}

	protected override async listFiles(root: string): Promise<string[]> {
		this.listings++;
		const files = await super.listFiles(root);
		return this.hideFiles ? [] : files;
	}
}

suite('ClaudeCodeAdapter', () => {
	let harness: ReturnType<typeof create>;
	setup(() => { harness = create(); });
	teardown(() => harness.cleanup());

	test('discovers the projects folder from CLAUDE_CONFIG_DIR or the home folder', () => {
		const home = path.join('h');
		assert.deepStrictEqual(claudeCodeProjectDirs({ CLAUDE_CONFIG_DIR: path.join('cfg') }, home), [path.join('cfg', 'projects')]);
		assert.deepStrictEqual(claudeCodeProjectDirs({}, home), [path.join(home, '.claude', 'projects'), path.join(home, '.config', 'claude', 'projects')]);
		assert.deepStrictEqual(claudeCodeProjectDirs({ XDG_CONFIG_HOME: path.join('x') }, home)[1], path.join('x', 'claude', 'projects'));
	});

	test('reports unavailable without a projects folder and stays inert', async () => {
		const missing = new ClaudeCodeAdapter({ projectDirs: [path.join(harness.root, 'missing')], pollIntervalMs: 0 });
		assert.strictEqual(await missing.isAvailable(), false);
		await missing.start();
		await missing.refresh();
		await missing.stop();
		assert.strictEqual(await harness.adapter.isAvailable(), true);
	});

	test('emits per-response lifecycle with actual token and cache counts', async () => {
		await harness.adapter.start();
		await harness.appendLines(harness.file('proj-a', 'sess-a.jsonl'), fixtureLines('claudeCode', 'session.jsonl'));

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status]), [
			['sess-a/msg_1', 'processing'], ['sess-a/msg_1', 'completed'], ['sess-a/msg_2', 'completed'],
			['sess-a/msg_err', 'failed'], ['sess-a/msg_3', 'completed'],
		]);
		assert.deepStrictEqual(harness.events[1], {
			id: 'sess-a/msg_1', provider: 'claude-code', model: 'claude-sonnet-4-5-20250929',
			startedAt: '2026-10-01T10:00:02.000Z', completedAt: '2026-10-01T10:00:05.000Z',
			inputTokens: 12, outputTokens: 180, cachedInputTokens: 4000, cacheCreationTokens: 300,
			source: 'actual', status: 'completed',
		});
		assert.deepStrictEqual(harness.events[3], {
			id: 'sess-a/msg_err', provider: 'claude-code', startedAt: '2026-10-01T10:00:10.000Z',
			completedAt: '2026-10-01T10:00:10.000Z', source: 'estimated', status: 'failed',
		});
		const unknownModel = harness.events[4];
		assert.deepStrictEqual([unknownModel.model, unknownModel.inputTokens, unknownModel.outputTokens, unknownModel.source], ['claude-nova-9', undefined, 7, 'actual']);
		assert.ok(harness.events.every(isAiUsageEvent));
		assertNoContent([harness.events, harness.logs]);
	});

	test('does not replay existing history and picks up new subagent transcripts', async () => {
		fs.writeFileSync(harness.file('proj-a', 'sess-a.jsonl'), readProviderFixture('claudeCode', 'session.jsonl'));
		await harness.adapter.start();
		await harness.adapter.refresh();
		assert.strictEqual(harness.events.length, 0);

		const subagent = harness.file('proj-a', 'sess-a', 'subagents', 'agent-1.jsonl');
		await harness.appendLines(subagent, fixtureLines('claudeCode', 'session.jsonl').slice(4, 5));
		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status, e.outputTokens]), [['sess-a/msg_2', 'completed', 40]]);
	});

	test('imports responses active since the previous run from transcripts changed since then', async () => {
		const since = Date.parse('2026-10-01T10:00:09.000Z');
		const imported = createTailHarness((root, log) => new ClaudeCodeAdapter({ projectDirs: [root], log, pollIntervalMs: 0, importSince: since }));
		try {
			fs.writeFileSync(imported.file('proj-a', 'sess-a.jsonl'), readProviderFixture('claudeCode', 'session.jsonl'));
			const unchanged = imported.file('proj-b', 'sess-b.jsonl');
			fs.writeFileSync(unchanged, readProviderFixture('claudeCode', 'session.jsonl').replace(/sess-a/g, 'sess-b'));
			setModified(unchanged, since - 60_000);
			await imported.adapter.start();
			assert.deepStrictEqual(imported.events.map(e => [e.id, e.status]), [['sess-a/msg_err', 'failed'], ['sess-a/msg_3', 'completed']]);
			assert.deepStrictEqual(imported.origins, ['import', 'import']);

			await imported.appendLines(imported.file('proj-c', 'sess-c.jsonl'), fixtureLines('claudeCode', 'session.jsonl').slice(4, 5));
			assert.deepStrictEqual([imported.events.at(-1)!.id, imported.origins.at(-1)], ['sess-a/msg_2', 'live']);
			assertNoContent([imported.events, imported.logs]);
		} finally {
			await imported.cleanup();
		}
	});

	test('handles partial counts and waits for incomplete trailing lines', async () => {
		await harness.adapter.start();
		const file = harness.file('proj-b', 'sess-p.jsonl');
		fs.writeFileSync(file, readProviderFixture('claudeCode', 'partial.jsonl').replace(/\r?\n$/, ''));
		await harness.adapter.refresh();

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status, e.inputTokens, e.outputTokens, e.source]), [
			['sess-p/msg_no_usage', 'completed', undefined, 5, 'estimated'],
			['sess-p/msg_streaming', 'processing', 4, 2, 'actual'],
		]);
		assert.ok(!harness.logs.some(l => l.includes('malformed')));

		fs.appendFileSync(file, '":1}\n');
		await harness.adapter.refresh();
		assert.deepStrictEqual([harness.events.at(-1)!.status, harness.events.at(-1)!.outputTokens], ['completed', 90]);
		assertNoContent(harness.events);
	});

	test('finishes a call whose stream never recorded a stop reason once the next call of its thread starts', async () => {
		await harness.adapter.start();
		await harness.appendLines(harness.file('proj-u', 'sess-u.jsonl'), fixtureLines('claudeCode', 'unfinished.jsonl'));

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status, e.completedAt, e.outputTokens]), [
			['sess-u/msg_open', 'processing', undefined, 5],
			['sess-u/msg_side', 'processing', undefined, 1],
			['sess-u/msg_open', 'completed', '2026-10-01T10:00:03.000Z', 5],
			['sess-u/msg_next', 'completed', '2026-10-01T10:00:06.000Z', 20],
		], 'the sidechain agent is a separate thread and stays in flight');
		assert.ok(harness.events.every(isAiUsageEvent));
		assertNoContent([harness.events, harness.logs]);
	});

	test('polls that arrive while a scan is queued join it instead of piling up', async () => {
		const counting = createTailHarness((root, log) => new ListingAdapter(root, log));
		try {
			await counting.adapter.start();
			const file = counting.file('proj-a', 'sess-a.jsonl');
			fs.writeFileSync(file, fixtureLines('claudeCode', 'session.jsonl').slice(0, 3).join('\n') + '\n');
			const before = counting.adapter.listings;
			await Promise.all([1, 2, 3, 4, 5].map(() => counting.adapter.refresh()));
			assert.strictEqual(counting.adapter.listings - before, 1);
			assert.deepStrictEqual(counting.events.map(e => e.status), ['completed']);
		} finally {
			await counting.cleanup();
		}
	});

	test('a file missing from one listing is not replayed as new activity when it reappears', async () => {
		const flaky = createTailHarness((root, log) => new ListingAdapter(root, log));
		try {
			await flaky.adapter.start();
			const file = flaky.file('proj-a', 'sess-a.jsonl');
			const lines = fixtureLines('claudeCode', 'session.jsonl');
			await flaky.appendLines(file, lines.slice(0, 5));
			const seen = flaky.events.length;
			flaky.adapter.hideFiles = true;
			await flaky.adapter.refresh();
			flaky.adapter.hideFiles = false;
			await flaky.appendLines(file, lines.slice(5));
			assert.deepStrictEqual(flaky.events.slice(seen).map(e => [e.id, e.status]), [['sess-a/msg_err', 'failed'], ['sess-a/msg_3', 'completed']]);

			// Files that are really gone are forgotten.
			fs.rmSync(file);
			await flaky.adapter.refresh();
			fs.writeFileSync(file, lines[4] + '\n');
			await flaky.adapter.refresh();
			assert.deepStrictEqual(flaky.events.at(-1)?.id, 'sess-a/msg_2');
		} finally {
			await flaky.cleanup();
		}
	});

	test('skips malformed lines with safe diagnostics', async () => {
		await harness.adapter.start();
		fs.writeFileSync(harness.file('proj-c', 'sess-m.jsonl'), readProviderFixture('claudeCode', 'malformed.jsonl'));
		await harness.adapter.refresh();

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.inputTokens, e.outputTokens, e.cachedInputTokens, e.source]),
			[['sess-m/msg_bad_counts', undefined, 5, 10, 'estimated']]);
		assert.ok(harness.logs.some(l => l === '[claude-code] skipped 4 malformed line(s) in session sess-m'));
		assertNoContent([harness.events, harness.logs]);
	});
});
