import type { AiUsageEvent, AiUsageSource, AiUsageStatus } from '../../usage/usageEvent';
import { CHARS_PER_TOKEN, isObject, toCount, toText } from '../shared/jsonValues';

/**
 * Metadata kept per Copilot Chat request. Prompt/response text is reduced to character
 * counts while parsing and is never retained.
 */
export interface CopilotChatRequestMeta {
	requestId: string;
	timestamp?: number;
	modelId?: string;
	resolvedModel?: string;
	modelState?: number;
	completedAt?: number;
	elapsedMs?: number;
	promptTokens?: number;
	completionTokens?: number;
	hasResult?: boolean;
	hasError?: boolean;
	promptChars: number;
	responseChars: number;
}

// VS Code `ResponseModelState` as persisted in chat session files.
const COMPLETE = 1;
const CANCELLED = 2;
const FAILED = 3;

function toTime(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Sums the length of markdown/thinking response parts. */
export function textLength(parts: unknown): number {
	if (!Array.isArray(parts)) {
		return 0;
	}
	let length = 0;
	for (const part of parts) {
		if (isObject(part) && typeof part.value === 'string'
			&& (part.kind === undefined || part.kind === 'markdownContent' || part.kind === 'thinking')) {
			length += part.value.length;
		}
	}
	return length;
}

export function applyRequestField(meta: CopilotChatRequestMeta, field: string, value: unknown): void {
	switch (field) {
		case 'timestamp': meta.timestamp = toTime(value); break;
		case 'modelId': meta.modelId = toText(value); break;
		case 'promptTokens': meta.promptTokens = toCount(value); break;
		case 'completionTokens': meta.completionTokens = toCount(value); break;
		case 'elapsedMs': meta.elapsedMs = toCount(value); break;
		case 'message': meta.promptChars = isObject(value) && typeof value.text === 'string' ? value.text.length : 0; break;
		case 'response': meta.responseChars = textLength(value); break;
		case 'modelState':
			meta.modelState = isObject(value) && typeof value.value === 'number' ? value.value : undefined;
			meta.completedAt = isObject(value) ? toTime(value.completedAt) : undefined;
			break;
		case 'result':
			if (!isObject(value)) {
				break;
			}
			meta.hasResult = true;
			meta.hasError = value.errorDetails !== undefined && value.errorDetails !== null;
			if (isObject(value.metadata)) {
				meta.resolvedModel = toText(value.metadata.resolvedModel) ?? meta.resolvedModel;
				meta.promptTokens ??= toCount(value.metadata.promptTokens);
				meta.completionTokens ??= toCount(value.metadata.outputTokens);
			}
			break;
	}
}

export function createRequestMeta(raw: unknown): CopilotChatRequestMeta | undefined {
	if (!isObject(raw) || typeof raw.requestId !== 'string' || raw.requestId.length === 0) {
		return undefined;
	}
	const meta: CopilotChatRequestMeta = { requestId: raw.requestId, promptChars: 0, responseChars: 0 };
	for (const [field, value] of Object.entries(raw)) {
		applyRequestField(meta, field, value);
	}
	return meta;
}

export function lifecycleStatus(meta: CopilotChatRequestMeta): AiUsageStatus {
	if (meta.hasError || meta.modelState === FAILED) {
		return 'failed';
	}
	// Cancelled requests still consumed tokens, so they count as completed usage.
	if (meta.modelState === COMPLETE || meta.modelState === CANCELLED || (meta.modelState === undefined && meta.hasResult)) {
		return 'completed';
	}
	return meta.completionTokens || meta.responseChars ? 'processing' : 'started';
}

/** Case-insensitive model id without the `copilot/` vendor prefix; prefers the resolved model. */
export function normalizeModelId(meta: Pick<CopilotChatRequestMeta, 'modelId' | 'resolvedModel'>): string | undefined {
	const id = (meta.resolvedModel ?? meta.modelId)?.trim().toLowerCase().replace(/^copilot\//, '');
	return id ? id : undefined;
}

export function toUsageEvent(sessionId: string, meta: CopilotChatRequestMeta): AiUsageEvent | undefined {
	if (meta.timestamp === undefined) {
		return undefined;
	}
	const status = lifecycleStatus(meta);
	const finished = status === 'completed' || status === 'failed';
	let inputTokens = meta.promptTokens;
	let outputTokens = meta.completionTokens;
	let source: AiUsageSource = 'actual';
	if (finished && inputTokens === undefined && meta.promptChars > 0) {
		inputTokens = Math.ceil(meta.promptChars / CHARS_PER_TOKEN);
		source = 'estimated';
	}
	if (finished && outputTokens === undefined && meta.responseChars > 0) {
		outputTokens = Math.ceil(meta.responseChars / CHARS_PER_TOKEN);
		source = 'estimated';
	}
	if (finished && inputTokens === undefined && outputTokens === undefined) {
		source = 'estimated';
	}

	const event: AiUsageEvent = {
		id: `${sessionId}/${meta.requestId}`,
		provider: 'github-copilot',
		startedAt: new Date(meta.timestamp).toISOString(),
		source,
		status,
	};
	const model = normalizeModelId(meta);
	if (model) {
		event.model = model;
	}
	const completedAt = meta.completedAt ?? (meta.elapsedMs !== undefined ? meta.timestamp + meta.elapsedMs : undefined);
	if (finished && completedAt !== undefined && completedAt >= meta.timestamp) {
		event.completedAt = new Date(completedAt).toISOString();
	}
	if (inputTokens !== undefined) {
		event.inputTokens = inputTokens;
	}
	if (outputTokens !== undefined) {
		event.outputTokens = outputTokens;
	}
	return event;
}
