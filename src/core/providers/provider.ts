import type { AiProviderId, AiUsageEvent } from '../usage/usageEvent';

/** Structurally compatible with `vscode.Disposable`, kept vscode-free for unit testing. */
export interface Disposable {
	dispose(): void;
}

/** `live` = observed while tracking; `import` = read on startup from logs written since the previous run. */
export type UsageEventOrigin = 'live' | 'import';

/** `origin` defaults to `live` when omitted. */
export type AiUsageEventListener = (event: AiUsageEvent, origin?: UsageEventOrigin) => void;

/**
 * Provider adapter contract (PRD §9). Adapters only discover and parse provider data;
 * they must not calculate environmental impact.
 */
export interface AiProviderAdapter {
	readonly id: AiProviderId;
	readonly displayName: string;
	isAvailable(): Promise<boolean>;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Optional immediate re-read of provider data (e.g. "CarbonBit: Refresh Usage"). */
	refresh?(): Promise<void>;
	onUsageEvent(callback: AiUsageEventListener): Disposable;
}
