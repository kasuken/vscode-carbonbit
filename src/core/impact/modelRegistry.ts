import { MODEL_ALIAS_DATA, ModelAliasData, VisualClass } from './data/modelAliases';

/** Visualization-only model class (PRD §47); `unknown` is the documented fallback. */
export type ModelClass = VisualClass | 'unknown';

export type ModelMatch = 'model' | 'family' | 'unknown';

export interface ModelResolution {
	/** Lowercased, prefix/date-stripped name; preserved for unknown models so usage is still tracked. */
	normalized?: string;
	canonicalModel?: string;
	family?: string;
	modelClass: ModelClass;
	match: ModelMatch;
}

export interface ModelRegistry {
	resolve(model: string | undefined): ModelResolution;
}

/**
 * Lowercases, drops a vendor prefix (`copilot/`, `anthropic/`…), unifies separators and strips
 * date/`latest` snapshot suffixes (`-2025-04-14`, `-20241022`, `-latest`).
 */
export function normalizeModelName(model: string | undefined): string | undefined {
	const name = (model ?? '').trim().toLowerCase()
		.replace(/^.*\//, '')
		.replace(/[\s_]+/g, '-')
		.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|latest)$/, '');
	return name.length > 0 ? name : undefined;
}

export function createModelRegistry(data: ModelAliasData = MODEL_ALIAS_DATA): ModelRegistry {
	const families = Object.entries(data.families).map(([id, entry]) => ({ id, regex: new RegExp(entry.pattern), modelClass: entry.modelClass }));
	const classOf = (family: string): ModelClass => Object.hasOwn(data.families, family) ? data.families[family].modelClass : 'unknown';

	return {
		resolve(model) {
			const normalized = normalizeModelName(model);
			if (!normalized) {
				return { modelClass: 'unknown', match: 'unknown' };
			}
			// hasOwn: names like `constructor` must not hit Object.prototype.
			const canonical = Object.hasOwn(data.aliases, normalized) ? data.aliases[normalized] : normalized;
			if (Object.hasOwn(data.models, canonical)) {
				const modelFamily = data.models[canonical];
				return { normalized, canonicalModel: canonical, family: modelFamily, modelClass: classOf(modelFamily), match: 'model' };
			}
			const family = families.find(f => f.regex.test(canonical));
			if (family) {
				return { normalized, family: family.id, modelClass: family.modelClass, match: 'family' };
			}
			return { normalized, modelClass: 'unknown', match: 'unknown' };
		},
	};
}

export const defaultModelRegistry = createModelRegistry();

export function modelClassOf(model: string | undefined): ModelClass {
	return defaultModelRegistry.resolve(model).modelClass;
}
