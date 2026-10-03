/**
 * Model alias data (PRD §47-48). Visualization classes only — not a scientific classification
 * and not an energy factor. All keys are lowercase; lookups are case-insensitive.
 */

export type VisualClass = 'small' | 'medium' | 'frontier';

export interface ModelFamilyEntry {
	/** Regex source tested against the normalized model name; first matching family wins. */
	pattern: string;
	modelClass: VisualClass;
}

export interface ModelAliasData {
	version: string;
	/** Ordered: more specific families (e.g. `-mini`) must come before broader ones. */
	families: Record<string, ModelFamilyEntry>;
	/** Canonical model id -> family id. */
	models: Record<string, string>;
	/** Alias -> canonical model id. */
	aliases: Record<string, string>;
}

export const MODEL_ALIAS_DATA: ModelAliasData = {
	version: '1.0.0',
	families: {
		'claude-opus': { pattern: '^claude-(.+-)?opus(-|$)', modelClass: 'frontier' },
		'claude-sonnet': { pattern: '^claude-(.+-)?sonnet(-|$)', modelClass: 'medium' },
		'claude-haiku': { pattern: '^claude-(.+-)?haiku(-|$)', modelClass: 'small' },
		'gpt-mini': { pattern: '^gpt-.*-(mini|nano)(-|$)', modelClass: 'small' },
		'gpt-5': { pattern: '^gpt-5([.-]|$)', modelClass: 'frontier' },
		'gpt-4.1': { pattern: '^gpt-4\\.1(-|$)', modelClass: 'medium' },
		'gpt-4o': { pattern: '^gpt-4o(-|$)', modelClass: 'medium' },
		'openai-o-mini': { pattern: '^o\\d+-mini(-|$)', modelClass: 'small' },
		'openai-o': { pattern: '^o\\d+(-|$)', modelClass: 'frontier' },
		'gemini-flash': { pattern: '^gemini-.*-flash(-|$)', modelClass: 'small' },
		'gemini-pro': { pattern: '^gemini-.*-pro(-|$)', modelClass: 'frontier' },
		'grok-code-fast': { pattern: '^grok-code-fast(-|$)', modelClass: 'small' },
	},
	models: {
		'claude-opus-4': 'claude-opus',
		'claude-opus-4.1': 'claude-opus',
		'claude-opus-4.5': 'claude-opus',
		'claude-opus-5.5': 'claude-opus',
		'claude-sonnet-4': 'claude-sonnet',
		'claude-sonnet-4.5': 'claude-sonnet',
		'claude-3.5-sonnet': 'claude-sonnet',
		'claude-3.7-sonnet': 'claude-sonnet',
		'claude-haiku-4.5': 'claude-haiku',
		'claude-3.5-haiku': 'claude-haiku',
		'gpt-4o': 'gpt-4o',
		'gpt-4o-mini': 'gpt-mini',
		'gpt-4.1': 'gpt-4.1',
		'gpt-5': 'gpt-5',
		'gpt-5-mini': 'gpt-mini',
		'gpt-5-codex': 'gpt-5',
		'o3': 'openai-o',
		'o3-mini': 'openai-o-mini',
		'o4-mini': 'openai-o-mini',
		'gemini-2.0-flash': 'gemini-flash',
		'gemini-2.5-pro': 'gemini-pro',
		'grok-code-fast-1': 'grok-code-fast',
	},
	aliases: {
		'claude-4-opus': 'claude-opus-4',
		'claude-opus-4-0': 'claude-opus-4',
		'claude-opus-4-1': 'claude-opus-4.1',
		'claude-4.1-opus': 'claude-opus-4.1',
		'claude-opus-4-5': 'claude-opus-4.5',
		'claude-4.5-opus': 'claude-opus-4.5',
		'claude-opus-5-5': 'claude-opus-5.5',
		'claude-5.5-opus': 'claude-opus-5.5',
		'claude-4-sonnet': 'claude-sonnet-4',
		'claude-sonnet-4-0': 'claude-sonnet-4',
		'claude-sonnet-4-5': 'claude-sonnet-4.5',
		'claude-4.5-sonnet': 'claude-sonnet-4.5',
		'claude-3-5-sonnet': 'claude-3.5-sonnet',
		'claude-3-7-sonnet': 'claude-3.7-sonnet',
		'claude-haiku-4-5': 'claude-haiku-4.5',
		'claude-4.5-haiku': 'claude-haiku-4.5',
		'claude-3-5-haiku': 'claude-3.5-haiku',
		'gpt-4-1': 'gpt-4.1',
		'gemini-2-0-flash': 'gemini-2.0-flash',
		'gemini-2-5-pro': 'gemini-2.5-pro',
	},
};
