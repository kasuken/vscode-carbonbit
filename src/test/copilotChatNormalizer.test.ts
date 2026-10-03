import * as assert from 'assert';
import { ChatSessionLog } from '../core/providers/copilotChat/chatSessionLog';
import {
	createRequestMeta,
	lifecycleStatus,
	normalizeModelId,
	textLength,
	toUsageEvent,
} from '../core/providers/copilotChat/copilotChatNormalizer';
import { isAiUsageEvent } from '../core/usage/usageEvent';

suite('Copilot Chat normalizer', () => {
	test('normalizes model ids case-insensitively, preferring the resolved model', () => {
		assert.strictEqual(normalizeModelId({ modelId: 'copilot/GPT-4.1' }), 'gpt-4.1');
		assert.strictEqual(normalizeModelId({ modelId: 'copilot/auto', resolvedModel: 'Claude-Sonnet-4.5' }), 'claude-sonnet-4.5');
		assert.strictEqual(normalizeModelId({ modelId: 'copilot/some-unknown-model' }), 'some-unknown-model');
		assert.strictEqual(normalizeModelId({}), undefined);
	});

	test('maps VS Code response states to lifecycle statuses', () => {
		const base = { requestId: 'r', timestamp: 1, promptChars: 0, responseChars: 0 };
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 0 }), 'started');
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 0, completionTokens: 3 }), 'processing');
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 4, responseChars: 5 }), 'processing');
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 1 }), 'completed');
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 2 }), 'completed');
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 3 }), 'failed');
		assert.strictEqual(lifecycleStatus({ ...base, modelState: 1, hasError: true }), 'failed');
	});

	test('reports actual token counts with provenance', () => {
		const meta = createRequestMeta({
			requestId: 'r1', timestamp: Date.UTC(2026, 9, 1), modelId: 'copilot/gpt-4.1',
			modelState: { value: 1, completedAt: Date.UTC(2026, 9, 1, 0, 0, 2) }, promptTokens: 10, completionTokens: 4,
		});
		const event = toUsageEvent('s1', meta!);
		assert.deepStrictEqual(event, {
			id: 's1/r1', provider: 'github-copilot', model: 'gpt-4.1',
			startedAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-01T00:00:02.000Z',
			inputTokens: 10, outputTokens: 4, source: 'actual', status: 'completed',
		});
		assert.ok(isAiUsageEvent(event));
	});

	test('falls back to text-length estimates only for finished requests without counts', () => {
		const meta = createRequestMeta({
			requestId: 'r', timestamp: 1000, modelState: { value: 1 },
			message: { text: 'x'.repeat(10) }, response: [{ value: 'y'.repeat(8) }],
		})!;
		const event = toUsageEvent('s', meta)!;
		assert.strictEqual(event.inputTokens, 3);
		assert.strictEqual(event.outputTokens, 2);
		assert.strictEqual(event.source, 'estimated');

		const pending = toUsageEvent('s', { ...meta, modelState: 0 })!;
		assert.strictEqual(pending.inputTokens, undefined);
		assert.strictEqual(pending.source, 'actual');
	});

	test('keeps partial counts and still tracks requests without any data', () => {
		const partial = toUsageEvent('s', createRequestMeta({ requestId: 'r', timestamp: 1, modelState: { value: 1 }, promptTokens: 7 })!)!;
		assert.strictEqual(partial.inputTokens, 7);
		assert.strictEqual(partial.outputTokens, undefined);
		assert.strictEqual(partial.source, 'actual');

		const bare = toUsageEvent('s', createRequestMeta({ requestId: 'r', timestamp: 1, modelState: { value: 1 } })!)!;
		assert.strictEqual(bare.source, 'estimated');
		assert.ok(isAiUsageEvent(bare));
	});

	test('counts only markdown and thinking response text', () => {
		assert.strictEqual(textLength([{ value: 'abc' }, { kind: 'thinking', value: 'de' }, { kind: 'toolInvocationSerialized', invocationMessage: 'zzzz' }]), 5);
		assert.strictEqual(textLength('nope'), 0);
	});

	test('never copies text into request metadata', () => {
		const meta = createRequestMeta({ requestId: 'r', timestamp: 1, message: { text: 'SECRET' }, response: [{ value: 'SECRET' }] });
		assert.ok(!JSON.stringify(meta).includes('SECRET'));
	});
});

suite('ChatSessionLog', () => {
	test('replays snapshot, set and push operations', () => {
		const log = new ChatSessionLog();
		log.apply(JSON.stringify({ kind: 0, v: { requests: [{ requestId: 'a', timestamp: 1 }] } }));
		log.apply(JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'b', timestamp: 2 }] }));
		log.apply(JSON.stringify({ kind: 1, k: ['requests', 1, 'promptTokens'], v: 42 }));
		log.apply(JSON.stringify({ kind: 2, k: ['requests', 1, 'response'], v: [{ value: 'abcd' }] }));
		assert.deepStrictEqual(log.requests.map(r => r.requestId), ['a', 'b']);
		assert.strictEqual(log.requests[1].promptTokens, 42);
		assert.strictEqual(log.requests[1].responseChars, 4);

		log.apply(JSON.stringify({ kind: 2, k: ['requests'], v: [{ requestId: 'c', timestamp: 3 }], i: 1 }));
		assert.deepStrictEqual(log.requests.map(r => r.requestId), ['a', 'c']);
	});

	test('counts malformed lines and ignores unknown or out-of-range operations', () => {
		const log = new ChatSessionLog();
		log.apply('{oops');
		log.apply('[]');
		log.apply(JSON.stringify({ kind: 1, k: ['requests', 5, 'promptTokens'], v: 1 }));
		log.apply(JSON.stringify({ kind: 9, k: ['requests'], v: [] }));
		assert.strictEqual(log.malformedLines, 2);
		assert.strictEqual(log.requests.length, 0);
	});
});
