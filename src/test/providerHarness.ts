import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { JsonlTailAdapter } from '../core/providers/shared/jsonlTailAdapter';
import type { UsageEventOrigin } from '../core/providers/provider';
import type { AiUsageEvent } from '../core/usage/usageEvent';

/** Sets a file's modification time (tests use it to place logs before or after a previous run). */
export function setModified(file: string, epochMs: number): void {
	fs.utimesSync(file, epochMs / 1000, epochMs / 1000);
}

// Fixtures stay in src/ (excluded from the package); compiled tests run from out/test.
export const FIXTURES_ROOT = path.resolve(__dirname, '../../src/test/fixtures');
export const readProviderFixture = (provider: string, name: string) => fs.readFileSync(path.join(FIXTURES_ROOT, provider, name), 'utf8');
export const fixtureLines = (provider: string, name: string) => readProviderFixture(provider, name).split(/\r?\n/).filter(Boolean);

/** Keys that hold conversation content, paths or instructions in provider logs. */
const CONTENT_KEYS = new Set([
	'text', 'thinking', 'signature', 'content', 'transformedContent', 'message', 'value', 'inputText',
	'cwd', 'path', 'file_path', 'filesModified', 'repository', 'repository_url', 'branch',
	'arguments', 'output', 'last_agent_message', 'invocationMessage', 'renderedUserMessage',
]);

/** Every content-bearing string in a fixture must be a CANARY placeholder. */
export function assertCanaryOnly(value: unknown, key?: string): void {
	if (typeof value === 'string') {
		if (key !== undefined && CONTENT_KEYS.has(key)) {
			assert.match(value, /^CANARY_[A-Z_]+$/, `content field "${key}" must be a canary placeholder`);
		}
	} else if (Array.isArray(value)) {
		value.forEach(item => assertCanaryOnly(item, key));
	} else if (typeof value === 'object' && value !== null) {
		Object.entries(value).forEach(([k, v]) => assertCanaryOnly(v, k));
	}
}

/** Fixtures mark all conversation text with CANARY placeholders; none may reach events or logs. */
export function assertNoContent(value: unknown): void {
	assert.ok(!JSON.stringify(value).includes('CANARY'), 'conversation content leaked');
}

export function createTailHarness<T extends JsonlTailAdapter>(create: (root: string, log: (message: string) => void) => T) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbonbit-provider-'));
	const events: AiUsageEvent[] = [];
	const origins: UsageEventOrigin[] = [];
	const logs: string[] = [];
	const adapter = create(root, message => logs.push(message));
	adapter.onUsageEvent((event, origin) => { events.push(event); origins.push(origin ?? 'live'); });
	return {
		root, events, origins, logs, adapter,
		/** Path under the root; parent folders are created. */
		file(...segments: string[]): string {
			const file = path.join(root, ...segments);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			return file;
		},
		async appendLines(file: string, lines: readonly string[]): Promise<void> {
			for (const line of lines) {
				fs.appendFileSync(file, line + '\n');
				await adapter.refresh();
			}
		},
		async cleanup(): Promise<void> {
			await adapter.stop();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
