import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { HostToWebviewMessage, isHostToWebviewMessage, SIDEBAR_COMMANDS, SidebarCommand, SidebarView } from '../core/messages/protocol';
import { DEFAULT_SNAPSHOT, EMPTY_VIEW, handleWebviewMessage, postConfig, postToWebview, postView, SidebarActions } from '../sidebar/messageHandler';

const DEFAULT_CONFIG = { type: 'config', animationEnabled: true, maxFps: 30, visualMode: 'environmental' } as const;

function collect(): { sent: HostToWebviewMessage[]; send: (m: HostToWebviewMessage) => void } {
	const sent: HostToWebviewMessage[] = [];
	return { sent, send: m => sent.push(m) };
}

function recordActions(): SidebarActions & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		runCommand: (command: SidebarCommand) => calls.push(command),
		dismissOnboarding: () => calls.push('dismiss'),
	};
}

const VIEW: SidebarView = {
	live: { providerName: 'Claude Code', model: 'claude-sonnet-4', status: 'processing', tokens: '12K', updatedAt: 1000 },
	today: {
		energyWh: 0.84, carbonGrams: 0.24, waterLiters: 0.0042, tokens: 124000, requests: 17,
		text: { energy: '0.84 Wh', carbon: '0.24 g CO₂e', water: '4.2 ml', tokens: '124K', requests: '17' },
	},
	session: null,
	periods: [],
	activity: null,
	providers: [{ id: 'claude-code', name: 'Claude Code', tokens: 124000, percent: 100 }],
	setup: { firstRun: false, providers: [{ id: 'claude-code', name: 'Claude Code', state: 'tracking' }] },
};

suite('Webview message handler', () => {
	test('ready replies with the default config, a valid Idle state and the empty view', () => {
		const { sent, send } = collect();
		assert.strictEqual(handleWebviewMessage({ type: 'ready' }, send), true);
		assert.deepStrictEqual(sent, [
			DEFAULT_CONFIG,
			{ type: 'state', worldState: 'Idle', activeCount: 0 },
			{ type: 'view', ...EMPTY_VIEW },
		]);
		assert.ok(sent.every(isHostToWebviewMessage));
	});

	test('ready replies with the current renderer settings, world state and view', () => {
		const { sent, send } = collect();
		handleWebviewMessage({ type: 'ready' }, send, {
			world: { worldState: 'ProcessingMedium', activeCount: 2 },
			animation: { enabled: false, maxFps: 12 },
			visualMode: 'minimal',
			view: VIEW,
		});
		assert.deepStrictEqual(sent, [
			{ type: 'config', animationEnabled: false, maxFps: 12, visualMode: 'minimal' },
			{ type: 'state', worldState: 'ProcessingMedium', activeCount: 2 },
			{ type: 'view', ...VIEW },
		]);
	});

	test('whitelisted commands and onboarding dismissal reach the host actions only', () => {
		const actions = recordActions();
		const { sent, send } = collect();
		for (const command of SIDEBAR_COMMANDS) {
			assert.strictEqual(handleWebviewMessage({ type: 'command', command }, send, DEFAULT_SNAPSHOT, actions), true);
		}
		assert.strictEqual(handleWebviewMessage({ type: 'dismissOnboarding' }, send, DEFAULT_SNAPSHOT, actions), true);
		for (const bad of [
			{ type: 'command', command: 'carbonbit.clearLocalData' },
			{ type: 'command', command: 'workbench.action.terminal.new' },
			{ type: 'command', command: 'carbonbit.showDetails', args: ['x'] },
			{ type: 'dismissOnboarding', extra: 1 },
		]) {
			assert.strictEqual(handleWebviewMessage(bad, send, DEFAULT_SNAPSHOT, actions), false, JSON.stringify(bad));
		}
		assert.deepStrictEqual(actions.calls, [...SIDEBAR_COMMANDS, 'dismiss']);
		assert.strictEqual(sent.length, 0);
	});

	test('sidebar commands are contributed by the extension', () => {
		const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
		const contributed = new Set((pkg.contributes.commands as { command: string }[]).map(c => c.command));
		for (const command of SIDEBAR_COMMANDS) {
			assert.ok(contributed.has(command), command);
		}
	});

	test('postView refuses views with unexpected or unsafe content', () => {
		const { sent, send } = collect();
		assert.strictEqual(postView(VIEW, send), true);
		const bad: unknown[] = [
			{ ...VIEW, live: { ...VIEW.live, prompt: 'secret' } },
			{ ...VIEW, live: { ...VIEW.live, model: 'line\nbreak' } },
			{ ...VIEW, live: { ...VIEW.live, model: 'm'.repeat(129) } },
			{ ...VIEW, providers: [{ ...VIEW.providers[0], percent: 101 }] },
			{ ...VIEW, providers: [{ ...VIEW.providers[0], percent: 33.3 }] },
			{ ...VIEW, providers: [{ ...VIEW.providers[0], id: 'other' }] },
			{ ...VIEW, setup: { ...VIEW.setup, providers: [{ id: 'claude-code', name: 'Claude Code', state: 'ok' }] } },
		];
		for (const view of bad) {
			assert.strictEqual(postView(view as SidebarView, send), false, JSON.stringify(view));
		}
		assert.strictEqual(sent.length, 1);
	});

	test('postConfig refuses out-of-range settings and unknown visual modes', () => {
		const { sent, send } = collect();
		assert.strictEqual(postConfig({ enabled: true, maxFps: 0 }, 'neutral', send), false);
		assert.strictEqual(postConfig({ enabled: true, maxFps: 120 }, 'neutral', send), false);
		assert.strictEqual(postConfig({ enabled: true, maxFps: 30 }, 'dark' as never, send), false);
		assert.strictEqual(sent.length, 0);
	});

	test('survives a structured-clone round trip like postMessage', () => {
		const { sent, send } = collect();
		handleWebviewMessage(structuredClone({ type: 'ready' }), send);
		assert.ok(sent.length > 0 && sent.every(m => isHostToWebviewMessage(structuredClone(m))));
	});

	test('ignores invalid, unknown and extra-field messages', () => {
		const ignored: unknown[] = [
			undefined, null, 'ready', 42, [], {},
			{ type: 'state', worldState: 'Idle', activeCount: 0 },
			{ type: 'view', ...EMPTY_VIEW },
			{ type: 'runCommand', command: 'workbench.action.quit' },
			{ type: 'ready', extra: true },
			{ type: 'READY' },
		];
		for (const message of ignored) {
			const { sent, send } = collect();
			assert.strictEqual(handleWebviewMessage(message, send), false, JSON.stringify(message));
			assert.strictEqual(sent.length, 0, JSON.stringify(message));
		}
	});

	test('postToWebview never sends a message that fails the protocol check', () => {
		const { sent, send } = collect();
		const leaky = { type: 'state', worldState: 'Idle', activeCount: 0, prompt: 'secret' } as HostToWebviewMessage;
		const badState = { type: 'state', worldState: 'Sleeping', activeCount: 0 } as unknown as HostToWebviewMessage;
		const badCount = { type: 'state', worldState: 'Idle', activeCount: -1 } as HostToWebviewMessage;
		assert.strictEqual(postToWebview(leaky, send), false);
		assert.strictEqual(postToWebview(badState, send), false);
		assert.strictEqual(postToWebview(badCount, send), false);
		assert.strictEqual(sent.length, 0);
	});
});
