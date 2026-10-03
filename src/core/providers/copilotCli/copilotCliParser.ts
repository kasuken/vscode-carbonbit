import type { AiUsageEvent } from '../../usage/usageEvent';
import type { JsonlFileParser } from '../shared/jsonlTailAdapter';
import { estimateTokens, isObject, normalizeModel, parseRecord, toCount, toEpoch, toText } from '../shared/jsonValues';

/**
 * Parses GitHub Copilot CLI session events (`~/.copilot/session-state/<id>/events.jsonl`).
 * Each `assistant.message` (one model call) carries the model and actual output tokens only.
 * Input and cache counts exist only in the per-model `session.shutdown` summary, so a
 * shutdown emits one reconciliation event per model with the input/cache totals and any
 * output not already reported. Only ids, model names, timestamps and counts are kept.
 */
export class CopilotCliParser implements JsonlFileParser {
	malformedLines = 0;
	private readonly changed: AiUsageEvent[] = [];
	private currentModel: string | undefined;
	/** A segment runs from `session.start`/`session.resume` to `session.shutdown`. */
	private segmentObserved = false;
	private readonly segmentOutput = new Map<string, number>();

	constructor(private readonly sessionId: string) { }

	apply(line: string): void {
		const record = parseRecord(line);
		const data = record?.data;
		const at = toEpoch(record?.timestamp);
		if (!record || typeof record.type !== 'string' || !isObject(data) || at === undefined) {
			this.malformedLines++;
			return;
		}
		switch (record.type) {
			case 'session.start':
			case 'session.resume':
				this.beginSegment(data.selectedModel);
				break;
			case 'session.model_change':
				this.currentModel = normalizeModel(data.newModel) ?? this.currentModel;
				break;
			case 'assistant.message':
				this.message(data, at);
				break;
			case 'session.shutdown':
				this.shutdown(toText(record.id) ?? String(at), data, at);
				break;
		}
	}

	takeChanged(): Iterable<AiUsageEvent> {
		return this.changed.splice(0);
	}

	private beginSegment(model: unknown): void {
		this.currentModel = normalizeModel(model) ?? this.currentModel;
		this.segmentObserved = true;
		this.segmentOutput.clear();
	}

	private message(data: Record<string, unknown>, at: number): void {
		const messageId = toText(data.messageId);
		if (!messageId) {
			this.malformedLines++;
			return;
		}
		const model = normalizeModel(data.model) ?? this.currentModel;
		const actual = toCount(data.outputTokens);
		// Older CLI versions omit `outputTokens`; fall back to the reply length.
		const outputTokens = actual ?? estimateTokens(toText(data.content)?.length ?? 0);
		const event: AiUsageEvent = {
			id: `${this.sessionId}/${messageId}`,
			provider: 'github-copilot-cli',
			startedAt: new Date(at).toISOString(),
			source: actual !== undefined ? 'actual' : 'estimated',
			status: 'completed',
		};
		if (model) {
			event.model = model;
		}
		if (outputTokens !== undefined) {
			event.outputTokens = outputTokens;
		}
		const key = model ?? '';
		this.segmentOutput.set(key, (this.segmentOutput.get(key) ?? 0) + (outputTokens ?? 0));
		this.changed.push(event);
	}

	private shutdown(shutdownId: string, data: Record<string, unknown>, at: number): void {
		// Totals of a segment that started before tracking would mix in history that was skipped.
		if (this.segmentObserved && isObject(data.modelMetrics)) {
			for (const [rawModel, metrics] of Object.entries(data.modelMetrics)) {
				const usage = isObject(metrics) && isObject(metrics.usage) ? metrics.usage : undefined;
				const model = normalizeModel(rawModel);
				if (!usage || !model) {
					continue;
				}
				const cacheRead = toCount(usage.cacheReadTokens);
				const cacheWrite = toCount(usage.cacheWriteTokens);
				const input = toCount(usage.inputTokens);
				const output = toCount(usage.outputTokens);
				const event: AiUsageEvent = {
					id: `${this.sessionId}/${shutdownId}/${model}`,
					provider: 'github-copilot-cli',
					model,
					startedAt: new Date(at).toISOString(),
					source: 'actual',
					status: 'completed',
				};
				// The CLI's `inputTokens` includes cache reads and writes; our contract counts them separately.
				if (input !== undefined) {
					event.inputTokens = Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0));
				}
				if (output !== undefined) {
					event.outputTokens = Math.max(0, output - (this.segmentOutput.get(model) ?? 0));
				}
				if (cacheRead !== undefined) {
					event.cachedInputTokens = cacheRead;
				}
				if (cacheWrite !== undefined) {
					event.cacheCreationTokens = cacheWrite;
				}
				if (event.inputTokens || event.outputTokens || event.cachedInputTokens || event.cacheCreationTokens) {
					this.changed.push(event);
				}
			}
		}
		this.segmentObserved = false;
		this.segmentOutput.clear();
	}
}
