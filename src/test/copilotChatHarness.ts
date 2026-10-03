import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CopilotChatAdapter, type CopilotChatAdapterOptions } from '../core/providers/copilotChat/copilotChatAdapter';
import type { UsageEventOrigin } from '../core/providers/provider';
import type { AiUsageEvent } from '../core/usage/usageEvent';

// Fixtures stay in src/ (excluded from the package); compiled tests run from out/test.
export const FIXTURES = path.resolve(__dirname, '../../src/test/fixtures/copilotChat');
export const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** Fixtures mark all conversation text with CANARY placeholders; none may reach events or logs. */
export function assertNoContent(value: unknown): void {
	assert.ok(!JSON.stringify(value).includes('CANARY'), 'conversation content leaked');
}

/** By default `dir` is a plain session folder; `options` can point the adapter elsewhere (e.g. `workspaceStorageDirs`). */
export function createHarness(options: (dir: string) => Partial<CopilotChatAdapterOptions> = () => ({})) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carbonbit-chat-'));
	const events: AiUsageEvent[] = [];
	const origins: UsageEventOrigin[] = [];
	const logs: string[] = [];
	const adapter = new CopilotChatAdapter({
		sessionDirs: [dir],
		isCopilotChatInstalled: () => false,
		log: message => logs.push(message),
		pollIntervalMs: 0,
		...options(dir),
	});
	adapter.onUsageEvent((event, origin) => { events.push(event); origins.push(origin ?? 'live'); });
	return {
		dir, events, origins, logs, adapter,
		file: (name = 'session-1.jsonl') => path.join(dir, name),
		cleanup: async () => {
			await adapter.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
