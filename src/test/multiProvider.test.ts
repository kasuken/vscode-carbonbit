import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImpactEngine } from '../core/impact/impactEngine';
import { ClaudeCodeAdapter } from '../core/providers/claudeCode/claudeCodeAdapter';
import { CodexCliAdapter } from '../core/providers/codexCli/codexCliAdapter';
import { CopilotChatAdapter } from '../core/providers/copilotChat/copilotChatAdapter';
import { CopilotCliAdapter } from '../core/providers/copilotCli/copilotCliAdapter';
import { AI_PROVIDER_IDS, validateAiUsageEvent, type AiUsageEvent } from '../core/usage/usageEvent';
import { UsageService } from '../core/usage/usageService';
import { assertCanaryOnly, assertNoContent, FIXTURES_ROOT, readProviderFixture } from './providerHarness';

class BrokenClaudeAdapter extends ClaudeCodeAdapter {
	protected override listFiles(): Promise<string[]> {
		throw Object.assign(new Error('CANARY_SECRET_PATH'), { code: 'EACCES' });
	}
}

function createEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carbonbit-multi-'));
	const dir = (...segments: string[]) => {
		const full = path.join(root, ...segments);
		fs.mkdirSync(full, { recursive: true });
		return full;
	};
	const logs: string[] = [];
	const log = (message: string) => logs.push(message);
	const roots = { chat: dir('chat'), claude: dir('claude'), cli: dir('cli'), codex: dir('codex') };
	const adapters = {
		chat: new CopilotChatAdapter({ sessionDirs: [roots.chat], isCopilotChatInstalled: () => false, log, pollIntervalMs: 0 }),
		claude: new ClaudeCodeAdapter({ projectDirs: [roots.claude], log, pollIntervalMs: 0 }),
		cli: new CopilotCliAdapter({ sessionDirs: [roots.cli], log, pollIntervalMs: 0 }),
		codex: new CodexCliAdapter({ sessionDirs: [roots.codex], log, pollIntervalMs: 0 }),
	};
	const service = new UsageService(log);
	Object.values(adapters).forEach(adapter => service.register(adapter));
	const events: AiUsageEvent[] = [];
	service.onUsageEvent(event => events.push(event));
	const write = (file: string, provider: string, fixture: string) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, readProviderFixture(provider, fixture));
	};
	const writeAll = () => {
		write(path.join(roots.chat, 'session-1.jsonl'), 'copilotChat', 'available.jsonl');
		write(path.join(roots.claude, 'proj', 'sess-a.jsonl'), 'claudeCode', 'session.jsonl');
		write(path.join(roots.cli, 'cli-session-1', 'events.jsonl'), 'copilotCli', 'events.jsonl');
		write(path.join(roots.codex, '2026', '10', '01', 'rollout-x.jsonl'), 'codexCli', 'rollout.jsonl');
	};
	const refreshAll = () => Promise.all(Object.values(adapters).map(adapter => adapter.refresh()));
	return {
		roots, adapters, service, events, logs, write, writeAll, refreshAll,
		async cleanup() {
			await service.stop();
			service.dispose();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

suite('Multi-provider isolation and compatibility', () => {
	let env: ReturnType<typeof createEnv>;
	setup(() => { env = createEnv(); });
	teardown(() => env.cleanup());

	test('all P0 providers emit compatible normalized events through one event bus', async () => {
		await env.service.start();
		assert.deepStrictEqual(env.service.getStatuses().map(s => [s.id, s.state]), [
			['github-copilot', 'tracking'], ['claude-code', 'tracking'], ['github-copilot-cli', 'tracking'], ['codex-cli', 'tracking'],
		]);
		env.writeAll();
		await env.refreshAll();

		assert.deepStrictEqual([...new Set(env.events.map(e => e.provider))].sort(), [...AI_PROVIDER_IDS].sort());
		const engine = new ImpactEngine();
		for (const event of env.events) {
			assert.ok(validateAiUsageEvent(event).valid, `${event.provider} event is valid`);
			const impact = engine.estimate(event);
			if (event.status === 'completed' && (event.inputTokens || event.outputTokens)) {
				assert.ok(impact && impact.energyWh > 0, `${event.provider} completed usage is measurable`);
			}
		}
		// Every provider reports cache usage separately from input when the source has it.
		assert.ok(env.events.some(e => e.provider === 'claude-code' && e.cachedInputTokens === 4000 && e.inputTokens === 12));
		assert.ok(env.events.some(e => e.provider === 'github-copilot-cli' && e.cachedInputTokens === 4000 && e.inputTokens === 500));
		assert.ok(env.events.some(e => e.provider === 'codex-cli' && e.cachedInputTokens === 1800 && e.inputTokens === 700));
		assertNoContent([env.events, env.logs]);
	});

	test('unavailable, malformed and failing providers do not stop the others', async () => {
		fs.rmSync(env.roots.codex, { recursive: true });
		const broken = new BrokenClaudeAdapter({ projectDirs: [env.roots.claude], log: m => env.logs.push(m), pollIntervalMs: 0 });
		const service = new UsageService(m => env.logs.push(m));
		[env.adapters.chat, broken, env.adapters.cli, env.adapters.codex].forEach(adapter => service.register(adapter));
		const events: AiUsageEvent[] = [];
		service.onUsageEvent(event => events.push(event));
		try {
			await service.start();
			assert.deepStrictEqual(service.getStatuses().map(s => [s.id, s.state]), [
				['github-copilot', 'tracking'], ['claude-code', 'tracking'], ['github-copilot-cli', 'tracking'], ['codex-cli', 'unavailable'],
			]);
			env.write(path.join(env.roots.chat, 'session-1.jsonl'), 'copilotChat', 'malformed.jsonl');
			env.write(path.join(env.roots.cli, 'cli-session-1', 'events.jsonl'), 'copilotCli', 'events.jsonl');
			await Promise.all([env.adapters.chat.refresh(), broken.refresh(), env.adapters.cli.refresh(), env.adapters.codex.refresh()]);

			assert.ok(events.some(e => e.provider === 'github-copilot-cli'));
			assert.ok(events.every(e => e.provider !== 'claude-code' && e.provider !== 'codex-cli'));
			assert.ok(env.logs.includes('Codex CLI: tracking unavailable'));
			assert.ok(env.logs.includes('[claude-code] scan failed: EACCES'));
			assert.ok(env.logs.some(l => l.startsWith('[github-copilot] skipped')));
			assertNoContent([events, env.logs]);
		} finally {
			await service.stop();
			service.dispose();
		}
	});

	test('provider fixtures contain only canary placeholders, never real content', () => {
		for (const provider of fs.readdirSync(FIXTURES_ROOT)) {
			for (const file of fs.readdirSync(path.join(FIXTURES_ROOT, provider))) {
				for (const line of readProviderFixture(provider, file).split(/\r?\n/)) {
					try {
						assertCanaryOnly(JSON.parse(line));
					} catch (error) {
						if (error instanceof assert.AssertionError) {
							throw new assert.AssertionError({ message: `${provider}/${file}: ${error.message}` });
						}
					}
				}
			}
		}
	});
});
