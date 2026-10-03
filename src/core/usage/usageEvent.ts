export const AI_PROVIDER_IDS = ['github-copilot', 'github-copilot-cli', 'claude-code', 'codex-cli'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export const AI_USAGE_SOURCES = ['actual', 'estimated'] as const;
export type AiUsageSource = (typeof AI_USAGE_SOURCES)[number];

export const AI_USAGE_STATUSES = ['started', 'processing', 'completed', 'failed'] as const;
export type AiUsageStatus = (typeof AI_USAGE_STATUSES)[number];

/** Normalized usage event (PRD §10). Carries metadata only, never conversation content. */
export interface AiUsageEvent {
	id: string;
	provider: AiProviderId;
	model?: string;
	startedAt: string;
	completedAt?: string;
	inputTokens?: number;
	outputTokens?: number;
	/** Prompt-cache reads; NOT included in `inputTokens` (adapters subtract them if the source includes them). */
	cachedInputTokens?: number;
	/** Prompt-cache writes; NOT included in `inputTokens`. */
	cacheCreationTokens?: number;
	source: AiUsageSource;
	status: AiUsageStatus;
}

export type AiUsageEventValidation =
	| { valid: true; event: AiUsageEvent }
	| { valid: false; errors: string[] };

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationTokens'] as const;

const KNOWN_FIELDS: ReadonlySet<string> = new Set([
	'id', 'provider', 'model', 'startedAt', 'completedAt', 'source', 'status', ...TOKEN_FIELDS,
]);

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function validateAiUsageEvent(value: unknown): AiUsageEventValidation {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return { valid: false, errors: ['event must be an object'] };
	}
	const e = value as Record<string, unknown>;
	const errors: string[] = [];

	// Unknown fields are rejected so content (prompts, responses, files) can't leak through.
	for (const key of Object.keys(e)) {
		if (!KNOWN_FIELDS.has(key)) {
			errors.push(`unknown field: ${key}`);
		}
	}

	if (typeof e.id !== 'string' || e.id.length === 0) {
		errors.push('id must be a non-empty string');
	}
	if (!includes(AI_PROVIDER_IDS, e.provider)) {
		errors.push(`provider must be one of: ${AI_PROVIDER_IDS.join(', ')}`);
	}
	if (e.model !== undefined && (typeof e.model !== 'string' || e.model.length === 0)) {
		errors.push('model must be a non-empty string when present');
	}
	if (!isIsoTimestamp(e.startedAt)) {
		errors.push('startedAt must be a valid timestamp');
	}
	if (e.completedAt !== undefined) {
		if (!isIsoTimestamp(e.completedAt)) {
			errors.push('completedAt must be a valid timestamp when present');
		} else if (isIsoTimestamp(e.startedAt) && Date.parse(e.completedAt) < Date.parse(e.startedAt)) {
			errors.push('completedAt must not be before startedAt');
		}
		if (e.status === 'started' || e.status === 'processing') {
			errors.push(`completedAt is not allowed while status is ${e.status}`);
		}
	}
	for (const field of TOKEN_FIELDS) {
		const n = e[field];
		if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 0)) {
			errors.push(`${field} must be a non-negative integer when present`);
		}
	}
	if (!includes(AI_USAGE_SOURCES, e.source)) {
		errors.push(`source must be one of: ${AI_USAGE_SOURCES.join(', ')}`);
	}
	if (!includes(AI_USAGE_STATUSES, e.status)) {
		errors.push(`status must be one of: ${AI_USAGE_STATUSES.join(', ')}`);
	}

	return errors.length === 0 ? { valid: true, event: e as unknown as AiUsageEvent } : { valid: false, errors };
}

export function isAiUsageEvent(value: unknown): value is AiUsageEvent {
	return validateAiUsageEvent(value).valid;
}
