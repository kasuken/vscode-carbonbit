import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CopilotChatAdapter, copilotChatSessionRoots } from '../core/providers/copilotChat/copilotChatAdapter';
import { isAiUsageEvent } from '../core/usage/usageEvent';
import { assertNoContent, createHarness, FIXTURES, readFixture } from './copilotChatHarness';
import { setModified } from './providerHarness';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTENT_KEYS = new Set(['text', 'value', 'inputText', 'invocationMessage', 'renderedUserMessage', 'message']);

suite('CopilotChatAdapter', () => {
	let harness: ReturnType<typeof createHarness>;
	setup(() => { harness = createHarness(); });
	teardown(() => harness.cleanup());

	test('reports unavailable when Copilot Chat and its session folder are missing', async () => {
		const missing = new CopilotChatAdapter({ sessionDirs: [path.join(harness.dir, 'missing')], isCopilotChatInstalled: () => false, pollIntervalMs: 0 });
		assert.strictEqual(await missing.isAvailable(), false);
		await missing.start();
		await missing.refresh();
		await missing.stop();

		const installed = new CopilotChatAdapter({ sessionDirs: [], isCopilotChatInstalled: () => true, pollIntervalMs: 0 });
		assert.strictEqual(await installed.isAvailable(), true);
		assert.strictEqual(await harness.adapter.isAvailable(), true, 'existing session folder counts as available');
	});

	test('emits the request lifecycle while a session file grows', async () => {
		await harness.adapter.start();
		for (const line of readFixture('available.jsonl').split(/\r?\n/).filter(Boolean)) {
			fs.appendFileSync(harness.file(), line + '\n');
			await harness.adapter.refresh();
		}
		const first = harness.events.filter(e => e.id === 'session-1/request_1');
		assert.deepStrictEqual(first.map(e => e.status), ['started', 'processing', 'processing', 'processing', 'processing', 'completed']);
		assert.deepStrictEqual(first.at(-1), {
			id: 'session-1/request_1', provider: 'github-copilot', model: 'gpt-4.1-2025-04-14',
			startedAt: new Date(1790000000000).toISOString(), completedAt: new Date(1790000004000).toISOString(),
			inputTokens: 3400, outputTokens: 120, source: 'actual', status: 'completed',
		});
		const unknownModel = harness.events.filter(e => e.id === 'session-1/request_2');
		assert.deepStrictEqual(unknownModel.map(e => [e.status, e.model]), [['completed', 'some-future-model']]);
		assert.ok(harness.events.every(isAiUsageEvent));
		assertNoContent(harness.events);
	});

	test('does not replay existing history on start and emits only new changes', async () => {
		fs.writeFileSync(harness.file(), readFixture('available.jsonl'));
		await harness.adapter.start();
		await harness.adapter.refresh();
		assert.strictEqual(harness.events.length, 0);

		fs.appendFileSync(harness.file(), readFixture('changed.jsonl').split(/\r?\n/)[1] + '\n');
		await harness.adapter.refresh();
		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status, e.inputTokens, e.outputTokens]), [['session-1/request_3', 'failed', 700, undefined]]);
	});

	test('deduplicates when the session file is rewritten (compacted)', async () => {
		fs.writeFileSync(harness.file(), readFixture('available.jsonl'));
		await harness.adapter.start();
		fs.writeFileSync(harness.file(), readFixture('changed.jsonl'));
		await harness.adapter.refresh();
		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status]), [['session-1/request_3', 'failed']]);
	});

	test('handles partial data and waits for incomplete trailing lines', async () => {
		await harness.adapter.start();
		// The fixture's last line is cut mid-write; drop its newline to mimic an in-progress append.
		fs.writeFileSync(harness.file(), readFixture('partial.jsonl').replace(/\r?\n$/, ''));
		await harness.adapter.refresh();

		const byId = new Map(harness.events.map(e => [e.id.split('/')[1], e]));
		assert.deepStrictEqual([...byId.keys()], ['request_pending', 'request_no_counts', 'request_input_only']);
		assert.strictEqual(byId.get('request_pending')!.status, 'started');
		assert.strictEqual(byId.get('request_pending')!.model, 'auto');
		assert.deepStrictEqual(
			[byId.get('request_no_counts')!.inputTokens, byId.get('request_no_counts')!.outputTokens, byId.get('request_no_counts')!.source, byId.get('request_no_counts')!.model],
			[5, 10, 'estimated', undefined]);
		assert.deepStrictEqual(
			[byId.get('request_input_only')!.status, byId.get('request_input_only')!.inputTokens, byId.get('request_input_only')!.outputTokens, byId.get('request_input_only')!.source],
			['completed', 900, undefined, 'actual']);
		assert.ok(!harness.logs.some(l => l.includes('malformed')), 'incomplete line is not reported as malformed');

		fs.appendFileSync(harness.file(), 'letedAt":1790000009000}}\n');
		await harness.adapter.refresh();
		const last = harness.events.at(-1)!;
		assert.deepStrictEqual([last.id, last.status, last.completedAt], ['session-1/request_pending', 'completed', new Date(1790000009000).toISOString()]);
		assert.ok(harness.events.every(isAiUsageEvent));
		assertNoContent(harness.events);
	});

	test('skips malformed data, keeps valid requests and logs safe diagnostics', async () => {
		await harness.adapter.start();
		fs.writeFileSync(harness.file(), readFixture('malformed.jsonl'));
		await harness.adapter.refresh();

		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status, e.model, e.inputTokens, e.outputTokens, e.source]),
			[['session-1/request_bad_counts', 'failed', undefined, 5, undefined, 'estimated']]);
		assert.ok(harness.logs.some(l => l.includes('skipped 3 malformed line(s) in session session-1')));
		assertNoContent(harness.events);
		assertNoContent(harness.logs);
	});

	test('a throwing subscriber does not stop tracking', async () => {
		harness.adapter.onUsageEvent(() => { throw new Error('boom'); });
		await harness.adapter.start();
		fs.writeFileSync(harness.file(), readFixture('available.jsonl'));
		await harness.adapter.refresh();
		assert.ok(harness.events.length > 0);
	});

	test('derives the session folders of every window from the VS Code user folder', () => {
		const user = path.join('data', 'User');
		assert.deepStrictEqual(copilotChatSessionRoots(user), {
			workspaceStorageDirs: [path.join(user, 'workspaceStorage')],
			sessionDirs: [path.join(user, 'globalStorage', 'emptyWindowChatSessions')],
		});
	});

	test('tracks the chat sessions of every workspace, not only the current window', async () => {
		const all = createHarness(dir => ({ sessionDirs: [], workspaceStorageDirs: [dir] }));
		try {
			await all.adapter.start();
			for (const workspace of ['ws-a', 'ws-b']) {
				fs.mkdirSync(path.join(all.dir, workspace, 'chatSessions'), { recursive: true });
				fs.writeFileSync(path.join(all.dir, workspace, 'chatSessions', `${workspace}-chat.jsonl`), readFixture('available.jsonl'));
			}
			// Other workspace files are not chat sessions.
			fs.mkdirSync(path.join(all.dir, 'ws-c', 'chatEditingSessions'), { recursive: true });
			fs.writeFileSync(path.join(all.dir, 'ws-c', 'chatEditingSessions', 'edit.jsonl'), readFixture('available.jsonl'));
			fs.writeFileSync(path.join(all.dir, 'ws-c', 'loose.jsonl'), readFixture('available.jsonl'));
			await all.adapter.refresh();

			assert.deepStrictEqual([...new Set(all.events.map(e => e.id.split('/')[0]))].sort(), ['ws-a-chat', 'ws-b-chat']);
			assert.ok(all.origins.every(origin => origin === 'live'));
		} finally {
			await all.cleanup();
		}
	});

	test('parses sessions unused for a while only once they change, emitting only the new part', async () => {
		fs.writeFileSync(harness.file(), readFixture('available.jsonl'));
		setModified(harness.file(), Date.now() - 30 * DAY_MS);
		await harness.adapter.start();
		await harness.adapter.refresh();
		assert.strictEqual(harness.events.length, 0);

		fs.appendFileSync(harness.file(), readFixture('changed.jsonl').split(/\r?\n/)[1] + '\n');
		await harness.adapter.refresh();
		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status, e.inputTokens, e.outputTokens]), [['session-1/request_3', 'failed', 700, undefined]]);
	});

	test('a session rewritten before it was parsed reports only requests newer than its last change', async () => {
		fs.writeFileSync(harness.file(), readFixture('available.jsonl'));
		// After request_2 finished and before request_3 started.
		setModified(harness.file(), 1790000015000);
		await harness.adapter.start();
		fs.writeFileSync(harness.file(), readFixture('changed.jsonl'));
		await harness.adapter.refresh();
		assert.deepStrictEqual(harness.events.map(e => [e.id, e.status]), [['session-1/request_3', 'failed']]);
	});

	test('imports requests active since the previous run, then continues live', async () => {
		const imported = createHarness(() => ({ importSince: 1790000011000 }));
		try {
			fs.writeFileSync(imported.file(), readFixture('available.jsonl'));
			fs.writeFileSync(imported.file('session-old.jsonl'), readFixture('available.jsonl'));
			setModified(imported.file('session-old.jsonl'), 1790000005000);
			await imported.adapter.start();
			// request_1 finished before the previous run ended; the old session did not change since.
			assert.deepStrictEqual(imported.events.map(e => [e.id, e.status]), [['session-1/request_2', 'completed']]);
			assert.deepStrictEqual(imported.origins, ['import']);
			assert.ok(imported.logs.includes('[github-copilot] imported 1 update(s) since the previous run'));

			fs.appendFileSync(imported.file(), readFixture('changed.jsonl').split(/\r?\n/)[1] + '\n');
			await imported.adapter.refresh();
			assert.deepStrictEqual(imported.events.slice(1).map(e => e.id), ['session-1/request_3']);
			assert.deepStrictEqual(imported.origins.slice(1), ['live']);
			assertNoContent([imported.events, imported.logs]);
		} finally {
			await imported.cleanup();
		}
	});

	test('fixtures contain only canary placeholders, never real conversation text', () => {
		const files = fs.readdirSync(FIXTURES);
		assert.ok(files.length >= 4);
		const visit = (value: unknown, key?: string): void => {
			if (typeof value === 'string' && key && CONTENT_KEYS.has(key)) {
				assert.match(value, /^CANARY_[A-Z_]+$/, `content field "${key}" must be a canary placeholder`);
			} else if (Array.isArray(value)) {
				value.forEach(item => visit(item));
			} else if (typeof value === 'object' && value !== null) {
				Object.entries(value).forEach(([k, v]) => visit(v, k));
			}
		};
		for (const file of files) {
			for (const line of readFixture(file).split(/\r?\n/)) {
				try {
					visit(JSON.parse(line));
				} catch (error) {
					if (error instanceof assert.AssertionError) {
						throw error;
					}
				}
			}
		}
	});
});
