/** Defensive readers for untrusted provider log values. */

/** Text-length fallback, used only when a source has no token count. */
export const CHARS_PER_TOKEN = 4;

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toCount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function toText(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Epoch ms of an ISO timestamp string, or undefined. */
export function toEpoch(value: unknown): number | undefined {
	const ms = typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

export function estimateTokens(chars: number): number | undefined {
	return chars > 0 ? Math.ceil(chars / CHARS_PER_TOKEN) : undefined;
}

/** Parses a JSONL line into an object, or undefined when it is not a JSON object. */
export function parseRecord(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Lowercased model id without a vendor prefix; empty / placeholder ids become undefined. */
export function normalizeModel(value: unknown): string | undefined {
	const id = toText(value)?.trim().toLowerCase().replace(/^.*\//, '');
	return id && !id.startsWith('<') ? id : undefined;
}
