import type { AiUsageEvent } from '../../usage/usageEvent';
import type { JsonlFileParser } from '../shared/jsonlTailAdapter';
import { estimateTokens, isObject, normalizeModel, parseRecord, toCount, toEpoch, toText } from '../shared/jsonValues';

interface ClaudeMessageMeta {
	id: string;
	model?: string;
	startedAt: number;
	lastAt: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	stopped: boolean;
	failed: boolean;
	textChars: number;
}

const max = (a: number | undefined, b: number | undefined) => a === undefined ? b : b === undefined ? a : Math.max(a, b);

function textChars(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}
	let chars = 0;
	for (const block of content) {
		if (isObject(block)) {
			chars += (toText(block.text) ?? toText(block.thinking) ?? '').length;
		}
	}
	return chars;
}

/**
 * Parses Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl`). Each API
 * response is written as one `assistant` line per content block sharing `message.id`, with
 * `usage` growing while it streams. Only ids, model, timestamps and counts are kept.
 * Calls within one conversation thread run one after another, so a call whose stream never
 * recorded a `stop_reason` is finished once the next call of its thread starts.
 */
export class ClaudeCodeParser implements JsonlFileParser {
	malformedLines = 0;
	private readonly messages = new Map<string, ClaudeMessageMeta>();
	private readonly changed = new Set<ClaudeMessageMeta>();
	/** Latest unfinished call per thread (the main conversation or one sidechain agent). */
	private readonly openByThread = new Map<string, ClaudeMessageMeta>();

	constructor(private readonly fallbackSessionId: string) { }

	apply(line: string): void {
		const record = parseRecord(line);
		if (!record) {
			this.malformedLines++;
			return;
		}
		if (record.type !== 'assistant') {
			return;
		}
		const message = record.message;
		const at = toEpoch(record.timestamp);
		if (!isObject(message) || !toText(message.id) || at === undefined) {
			this.malformedLines++;
			return;
		}
		const rawModel = toText(message.model);
		const isError = record.isApiErrorMessage === true;
		const session = toText(record.sessionId) ?? this.fallbackSessionId;
		const key = `${session}/${message.id as string}`;
		// Sidechain lines without an agent id may interleave parallel agents, so they are left alone.
		const agent = record.isSidechain === true ? toText(record.agentId) : 'main';
		const thread = agent === undefined ? undefined : `${session}\n${agent}`;
		this.finishPrevious(thread, key);
		// `<synthetic>` lines are written locally by Claude Code, not by an API call.
		if (rawModel === '<synthetic>' && !isError) {
			return;
		}
		let meta = this.messages.get(key);
		if (!meta) {
			meta = { id: key, startedAt: at, lastAt: at, stopped: false, failed: false, textChars: 0 };
			this.messages.set(key, meta);
		}
		meta.lastAt = Math.max(meta.lastAt, at);
		meta.model = normalizeModel(rawModel) ?? meta.model;
		meta.failed ||= isError;
		meta.stopped ||= typeof message.stop_reason === 'string';
		meta.textChars += textChars(message.content);
		if (isObject(message.usage) && !isError) {
			const usage = message.usage;
			meta.inputTokens = max(meta.inputTokens, toCount(usage.input_tokens));
			meta.outputTokens = max(meta.outputTokens, toCount(usage.output_tokens));
			meta.cacheReadTokens = max(meta.cacheReadTokens, toCount(usage.cache_read_input_tokens));
			meta.cacheCreationTokens = max(meta.cacheCreationTokens, toCount(usage.cache_creation_input_tokens));
		}
		if (thread !== undefined) {
			if (meta.stopped || meta.failed) {
				this.openByThread.delete(thread);
			} else {
				this.openByThread.set(thread, meta);
			}
		}
		this.changed.add(meta);
	}

	/** Some streams end without a final `stop_reason` line; left open they would look busy for minutes. */
	private finishPrevious(thread: string | undefined, key: string): void {
		if (thread === undefined) {
			return;
		}
		const open = this.openByThread.get(thread);
		if (open && open.id !== key) {
			this.openByThread.delete(thread);
			if (!open.stopped && !open.failed) {
				open.stopped = true;
				this.changed.add(open);
			}
		}
	}

	*takeChanged(): Iterable<AiUsageEvent> {
		for (const meta of this.changed) {
			yield toClaudeEvent(meta);
		}
		this.changed.clear();
	}
}

export function toClaudeEvent(meta: ClaudeMessageMeta): AiUsageEvent {
	const status = meta.failed ? 'failed' : meta.stopped ? 'completed' : 'processing';
	const hasCounts = meta.inputTokens !== undefined || meta.outputTokens !== undefined;
	const event: AiUsageEvent = {
		id: meta.id,
		provider: 'claude-code',
		startedAt: new Date(meta.startedAt).toISOString(),
		source: hasCounts ? 'actual' : 'estimated',
		status,
	};
	if (meta.model) {
		event.model = meta.model;
	}
	if (status !== 'processing') {
		event.completedAt = new Date(meta.lastAt).toISOString();
	}
	const outputTokens = hasCounts ? meta.outputTokens : meta.failed ? undefined : estimateTokens(meta.textChars);
	if (meta.inputTokens !== undefined) {
		event.inputTokens = meta.inputTokens;
	}
	if (outputTokens !== undefined) {
		event.outputTokens = outputTokens;
	}
	// Anthropic `input_tokens` already excludes cache reads and writes.
	if (meta.cacheReadTokens !== undefined) {
		event.cachedInputTokens = meta.cacheReadTokens;
	}
	if (meta.cacheCreationTokens !== undefined) {
		event.cacheCreationTokens = meta.cacheCreationTokens;
	}
	return event;
}
