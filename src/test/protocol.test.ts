import * as assert from 'assert';
import { isHostToWebviewMessage, isWebviewToHostMessage, SIDEBAR_COMMANDS, WORLD_STATES } from '../core/messages/protocol';
import { VISUAL_MODES } from '../core/settings/visualModeSettings';

const today = { energyWh: 0.84, carbonGrams: 0.24, waterLiters: 0.0042, tokens: 124000, requests: 17 };
const text = { energy: '0.84 Wh', carbon: '0.24 g CO₂e', water: '4.2 ml', tokens: '124K', requests: '17' };
const view = {
	type: 'view',
	live: { providerName: 'GitHub Copilot', model: null, status: 'started', tokens: null, updatedAt: 1_759_312_800_000 },
	today: { ...today, text },
	session: { ...today, text },
	periods: [],
	activity: { bucketMinutes: 2, tokens: [0, 5, 0], summary: '5 tokens in the last 6 minutes' },
	providers: [
		{ id: 'github-copilot', name: 'GitHub Copilot', tokens: 90, percent: 90 },
		{ id: 'codex-cli', name: 'Codex CLI', tokens: 10, percent: 10 },
		{ id: 'claude-code', name: 'Claude Code', tokens: 0, percent: null },
	],
	setup: { firstRun: true, providers: [{ id: 'codex-cli', name: 'Codex CLI', state: 'stopped' }] },
};

suite('Webview message protocol', () => {
	suite('host -> webview', () => {
		test('accepts state messages for every world state', () => {
			for (const worldState of WORLD_STATES) {
				assert.ok(isHostToWebviewMessage({ type: 'state', worldState, activeCount: 0 }), worldState);
				assert.ok(isHostToWebviewMessage({ type: 'state', worldState, activeCount: 3 }), worldState);
			}
		});

		test('accepts complete and empty view messages', () => {
			assert.ok(isHostToWebviewMessage(view));
			assert.ok(isHostToWebviewMessage({ type: 'view', live: null, today: null, session: null, periods: [], activity: null, providers: [], setup: { firstRun: false, providers: [] } }));
			for (const status of ['started', 'processing', 'completed', 'failed']) {
				assert.ok(isHostToWebviewMessage({ ...view, live: { ...view.live, status } }), status);
			}
			for (const state of ['stopped', 'tracking', 'unavailable', 'failed']) {
				assert.ok(isHostToWebviewMessage({ ...view, setup: { firstRun: false, providers: [{ id: 'codex-cli', name: 'Codex CLI', state }] } }), state);
			}
		});

		test('rejects malformed or leaky view messages', () => {
			const bad: unknown[] = [
				{ ...view, extra: 1 },
				{ type: 'view', live: null, today: null, providers: [] },
				{ ...view, live: { ...view.live, prompt: 'hi' } },
				{ ...view, live: { ...view.live, status: 'Generating' } },
				{ ...view, live: { ...view.live, providerName: '' } },
				{ ...view, live: { ...view.live, model: 'x\u0007' } },
				{ ...view, today },
				{ ...view, today: { ...today, text: { ...text, extra: 'x' } } },
				{ ...view, today: { ...today, text: { ...text, energy: 'x'.repeat(33) } } },
				{ ...view, today: { ...today, energyWh: -1, text } },
				{ ...view, providers: {} },
				{ ...view, providers: [{ ...view.providers[0], percent: -1 }] },
				{ ...view, providers: [{ ...view.providers[0], tokens: 1.5 }] },
				{ ...view, providers: [{ ...view.providers[0], file: 'a.ts' }] },
				{ ...view, providers: Array.from({ length: 17 }, () => view.providers[0]) },
				{ ...view, setup: { firstRun: 'yes', providers: [] } },
				{ ...view, setup: { firstRun: true, providers: [{ id: 'codex-cli', name: 'Codex CLI', state: 'tracking', path: '/x' }] } },
			];
			for (const value of bad) {
				assert.strictEqual(isHostToWebviewMessage(value), false, JSON.stringify(value));
			}
		});

		test('rejects non-objects and unknown types', () => {
			for (const value of [null, undefined, 'state', 1, [], {}, { type: 'init' }, { type: 'ready' }]) {
				assert.strictEqual(isHostToWebviewMessage(value), false, JSON.stringify(value));
			}
		});

		test('accepts config messages within the frame-rate range and for every visual mode', () => {
			for (const maxFps of [1, 30, 60]) {
				assert.ok(isHostToWebviewMessage({ type: 'config', animationEnabled: true, maxFps, visualMode: 'environmental' }), String(maxFps));
			}
			for (const visualMode of VISUAL_MODES) {
				assert.ok(isHostToWebviewMessage({ type: 'config', animationEnabled: false, maxFps: 30, visualMode }), visualMode);
			}
		});

		test('rejects malformed config messages', () => {
			const ok = { type: 'config', animationEnabled: true, maxFps: 30, visualMode: 'neutral' };
			const bad: unknown[] = [
				{ type: 'config', animationEnabled: true, visualMode: 'neutral' },
				{ type: 'config', maxFps: 30, visualMode: 'neutral' },
				{ type: 'config', animationEnabled: true, maxFps: 30 },
				{ ...ok, animationEnabled: 'true' },
				{ ...ok, maxFps: 0 },
				{ ...ok, maxFps: 61 },
				{ ...ok, maxFps: 29.5 },
				{ ...ok, maxFps: '30' },
				{ ...ok, maxFps: Infinity },
				{ ...ok, visualMode: 'dark' },
				{ ...ok, visualMode: 'Neutral' },
				{ ...ok, extra: true },
			];
			for (const value of bad) {
				assert.strictEqual(isHostToWebviewMessage(value), false, JSON.stringify(value));
			}
		});

		test('rejects extra fields on state messages', () => {
			assert.strictEqual(isHostToWebviewMessage({ type: 'state', worldState: 'Idle', activeCount: 0, prompt: 'hi' }), false);
			assert.strictEqual(isHostToWebviewMessage({ type: 'state', worldState: 'Idle', activeCount: 0, today: null }), false);
		});

		test('rejects malformed payloads', () => {
			const bad: unknown[] = [
				{ type: 'state', worldState: 'Idle' },
				{ type: 'state', activeCount: 0 },
				{ type: 'state', worldState: 'Idle', activeCount: -1 },
				{ type: 'state', worldState: 'Idle', activeCount: 1.5 },
				{ type: 'state', worldState: 'Idle', activeCount: '1' },
				{ type: 'state', worldState: 'Sleeping', activeCount: 0 },
			];
			for (const value of bad) {
				assert.strictEqual(isHostToWebviewMessage(value), false, JSON.stringify(value));
			}
		});
	});

	suite('webview -> host', () => {
		test('accepts ready, dismissOnboarding and whitelisted commands', () => {
			assert.ok(isWebviewToHostMessage({ type: 'ready' }));
			assert.ok(isWebviewToHostMessage({ type: 'dismissOnboarding' }));
			for (const command of SIDEBAR_COMMANDS) {
				assert.ok(isWebviewToHostMessage({ type: 'command', command }), command);
			}
		});

		test('rejects commands outside the whitelist', () => {
			for (const command of ['carbonbit.clearLocalData', 'carbonbit.openSidebar', 'workbench.action.quit', '', 1, null]) {
				assert.strictEqual(isWebviewToHostMessage({ type: 'command', command }), false, String(command));
			}
			assert.strictEqual(isWebviewToHostMessage({ type: 'command' }), false);
		});

		test('rejects non-objects and unknown types', () => {
			for (const value of [null, undefined, 'ready', [], {}, { type: 'state' }, { type: 'runCommand' }, { type: 1 }]) {
				assert.strictEqual(isWebviewToHostMessage(value), false, JSON.stringify(value));
			}
		});

		test('rejects extra fields', () => {
			assert.strictEqual(isWebviewToHostMessage({ type: 'ready', command: 'workbench.action.quit' }), false);
		});

		test('rejects prototype-polluted keys', () => {
			assert.strictEqual(isWebviewToHostMessage(JSON.parse('{"type":"ready","__proto__":{"x":1}}')), false);
		});
	});
});
