import type { AiUsageEvent, AiUsageStatus } from '../../usage/usageEvent';
import type { JsonlFileParser } from '../shared/jsonlTailAdapter';
import { estimateTokens, isObject, normalizeModel, parseRecord, toCount, toEpoch, toText } from '../shared/jsonValues';

interface TokenUsage {
	input: number;
	cached: number;
	cacheWrite: number;
	output: number;
}

interface CodexTurnMeta {
	turnId: string;
	model?: string;
	startedAt: number;
	lastAt: number;
	status: AiUsageStatus;
	usage?: TokenUsage;
	inputChars: number;
	outputChars: number;
}

function readUsage(value: unknown): TokenUsage | undefined {
	if (!isObject(value)) {
		return undefined;
	}
	const input = toCount(value.input_tokens);
	const output = toCount(value.output_tokens);
	if (input === undefined && output === undefined) {
		return undefined;
	}
	return { input: input ?? 0, cached: toCount(value.cached_input_tokens) ?? 0, cacheWrite: toCount(value.cache_write_input_tokens) ?? 0, output: output ?? 0 };
}

function contentChars(content: unknown): number {
	if (!Array.isArray(content)) {
		return 0;
	}
	return content.reduce((sum: number, part) => sum + (isObject(part) ? toText(part.text)?.length ?? 0 : 0), 0);
}

/**
 * Parses Codex CLI rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) into one event
 * per turn (`task_started` .. `task_complete`). `token_count` events report cumulative
 * session totals (sometimes repeated), so per-turn usage is the delta between totals.
 * Only ids, model names, timestamps and counts are kept.
 */
export class CodexParser implements JsonlFileParser {
	malformedLines = 0;
	private readonly turns = new Map<string, CodexTurnMeta>();
	private readonly changed = new Set<CodexTurnMeta>();
	private currentTurn: CodexTurnMeta | undefined;
	private lastModel: string | undefined;
	private previousTotal: TokenUsage | undefined;

	constructor(private readonly sessionId: string) { }

	apply(line: string): void {
		const record = parseRecord(line);
		const payload = record?.payload;
		const at = toEpoch(record?.timestamp);
		if (!record || !isObject(payload) || at === undefined) {
			this.malformedLines++;
			return;
		}
		if (record.type === 'turn_context') {
			const model = normalizeModel(payload.model);
			this.lastModel = model ?? this.lastModel;
			const turn = this.turn(payload.turn_id, at);
			if (turn && model) {
				turn.model = model;
				this.changed.add(turn);
			}
		} else if (record.type === 'event_msg') {
			this.eventMessage(payload, at);
		} else if (record.type === 'response_item' && payload.type === 'message' && this.currentTurn) {
			// Text lengths only feed the estimate fallback for turns without token counts.
			if (payload.role === 'assistant') {
				this.currentTurn.outputChars += contentChars(payload.content);
			} else if (payload.role === 'user') {
				this.currentTurn.inputChars += contentChars(payload.content);
			}
		}
	}

	*takeChanged(): Iterable<AiUsageEvent> {
		for (const turn of this.changed) {
			yield this.toEvent(turn);
		}
		this.changed.clear();
	}

	private eventMessage(payload: Record<string, unknown>, at: number): void {
		switch (payload.type) {
			case 'task_started': {
				const turn = this.turn(payload.turn_id, at);
				if (turn) {
					this.currentTurn = turn;
				}
				break;
			}
			case 'token_count':
				this.tokenCount(payload.info, at);
				break;
			case 'task_complete':
			case 'turn_aborted': {
				const turn = this.turn(payload.turn_id, at) ?? this.currentTurn;
				if (turn) {
					// Aborted turns still consumed tokens, so they count as completed usage.
					turn.status = 'completed';
					turn.lastAt = Math.max(turn.lastAt, at);
					this.changed.add(turn);
				}
				break;
			}
		}
	}

	private tokenCount(info: unknown, at: number): void {
		if (!isObject(info)) {
			return;
		}
		const total = readUsage(info.total_token_usage);
		const last = readUsage(info.last_token_usage);
		const previous = this.previousTotal;
		this.previousTotal = total ?? previous;
		let delta: TokenUsage | undefined;
		if (total && previous && total.input >= previous.input && total.output >= previous.output) {
			delta = {
				input: total.input - previous.input,
				cached: Math.max(0, total.cached - previous.cached),
				cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite),
				output: total.output - previous.output,
			};
		} else {
			// First count seen (history skipped) or totals reset: use the last response's usage.
			delta = last ?? total;
		}
		const turn = this.currentTurn;
		if (!turn || !delta || (delta.input === 0 && delta.output === 0)) {
			return;
		}
		const usage = turn.usage ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
		turn.usage = {
			input: usage.input + delta.input,
			cached: usage.cached + delta.cached,
			cacheWrite: usage.cacheWrite + delta.cacheWrite,
			output: usage.output + delta.output,
		};
		if (turn.status === 'started') {
			turn.status = 'processing';
		}
		turn.lastAt = Math.max(turn.lastAt, at);
		this.changed.add(turn);
	}

	private turn(rawId: unknown, at: number): CodexTurnMeta | undefined {
		const turnId = toText(rawId);
		if (!turnId) {
			return undefined;
		}
		let turn = this.turns.get(turnId);
		if (!turn) {
			turn = { turnId, startedAt: at, lastAt: at, status: 'started', inputChars: 0, outputChars: 0 };
			this.turns.set(turnId, turn);
			this.changed.add(turn);
		}
		return turn;
	}

	private toEvent(turn: CodexTurnMeta): AiUsageEvent {
		const finished = turn.status === 'completed';
		const event: AiUsageEvent = {
			id: `${this.sessionId}/${turn.turnId}`,
			provider: 'codex-cli',
			startedAt: new Date(turn.startedAt).toISOString(),
			source: turn.usage || !finished ? 'actual' : 'estimated',
			status: turn.status,
		};
		const model = turn.model ?? this.lastModel;
		if (model) {
			event.model = model;
		}
		if (finished) {
			event.completedAt = new Date(turn.lastAt).toISOString();
		}
		if (turn.usage) {
			// Codex `input_tokens` includes cached input; our contract counts cache separately.
			const { input, cached, cacheWrite, output } = turn.usage;
			event.inputTokens = Math.max(0, input - cached - cacheWrite);
			event.outputTokens = output;
			if (cached > 0) {
				event.cachedInputTokens = cached;
			}
			if (cacheWrite > 0) {
				event.cacheCreationTokens = cacheWrite;
			}
		} else if (finished) {
			const inputTokens = estimateTokens(turn.inputChars);
			const outputTokens = estimateTokens(turn.outputChars);
			if (inputTokens !== undefined) {
				event.inputTokens = inputTokens;
			}
			if (outputTokens !== undefined) {
				event.outputTokens = outputTokens;
			}
		}
		return event;
	}
}
