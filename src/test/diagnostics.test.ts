import * as assert from 'assert';
import {
	createDiagnosticsReport,
	databaseHealth,
	DiagnosticsInput,
	formatDiagnosticsReport,
	redactSensitiveText,
	StorageStatus,
} from '../core/diagnostics/diagnostics';

const HEALTHY: StorageStatus = { available: true, persistent: true, recovered: false, failedOperations: [] };
const T = Date.UTC(2026, 9, 1, 17, 24);

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
	return {
		extensionVersion: '0.1.0',
		vscodeVersion: '1.140.0',
		os: { platform: 'win32', release: '10.0.26100', arch: 'x64' },
		providers: [
			{ id: 'github-copilot', displayName: 'GitHub Copilot', state: 'tracking', lastEventAt: T },
			{ id: 'claude-code', displayName: 'Claude Code', state: 'failed', lastEventAt: null },
			{ id: 'codex-cli', displayName: 'Codex CLI', state: 'unavailable', lastEventAt: null },
			{ id: 'github-copilot-cli', displayName: 'GitHub Copilot CLI', state: 'tracking', lastEventAt: T - 60_000 },
		],
		storage: HEALTHY,
		settings: { animationEnabled: true, maxFps: 30, visualMode: 'environmental', retentionDays: 90 },
		now: T + 1000,
		...overrides,
	};
}

suite('Diagnostics', () => {
	test('report carries versions, OS, per-provider detection, last update and database health', () => {
		const report = createDiagnosticsReport(input());
		assert.deepStrictEqual(Object.keys(report).sort(), [
			'database', 'extensionVersion', 'generatedAt', 'lastProviderUpdate', 'os', 'providers', 'settings', 'vscodeVersion',
		]);
		assert.strictEqual(report.extensionVersion, '0.1.0');
		assert.strictEqual(report.vscodeVersion, '1.140.0');
		assert.deepStrictEqual(report.os, { platform: 'win32', release: '10.0.26100', arch: 'x64' });
		assert.strictEqual(report.lastProviderUpdate, new Date(T).toISOString());
		assert.deepStrictEqual(report.database, { health: 'healthy', persistent: true, failedOperations: [] });
	});

	test('one failing provider does not obscure the others', () => {
		const report = createDiagnosticsReport(input());
		assert.deepStrictEqual(report.providers.map(p => [p.id, p.detection, p.lastEventAt]), [
			['github-copilot', 'detected', new Date(T).toISOString()],
			['claude-code', 'error', null],
			['codex-cli', 'not-detected', null],
			['github-copilot-cli', 'detected', new Date(T - 60_000).toISOString()],
		]);
		const text = formatDiagnosticsReport(report);
		assert.match(text, /- GitHub Copilot: Detected, last update \d{4}-\d\d-\d\d \d\d:\d\d/);
		assert.match(text, /- Claude Code: Tracking unavailable\n/);
		assert.match(text, /- Codex CLI: Not detected\n/);
		assert.match(text, /- GitHub Copilot CLI: Detected, last update/);
	});

	test('reports no provider update when nothing was received', () => {
		const report = createDiagnosticsReport(input({ providers: [{ id: 'codex-cli', displayName: 'Codex CLI', state: 'stopped', lastEventAt: null }] }));
		assert.strictEqual(report.lastProviderUpdate, null);
		assert.strictEqual(report.providers[0].detection, 'pending');
		assert.match(formatDiagnosticsReport(report), /Last provider update: none this session/);
	});

	test('database health covers recovery, runtime errors, memory-only and unavailable storage', () => {
		assert.strictEqual(databaseHealth(HEALTHY), 'healthy');
		assert.strictEqual(databaseHealth({ ...HEALTHY, recovered: true }), 'recovered');
		assert.strictEqual(databaseHealth({ ...HEALTHY, failedOperations: ['record'] }), 'errors');
		assert.strictEqual(databaseHealth({ ...HEALTHY, persistent: false }), 'memory-only');
		assert.strictEqual(databaseHealth({ available: false, persistent: false, recovered: false, failedOperations: [] }), 'unavailable');
		const text = formatDiagnosticsReport(createDiagnosticsReport(input({ storage: { ...HEALTHY, failedOperations: ['record', 'totals'] } })));
		assert.match(text, /## Database\n\nErrors\n\nFailed operations: record, totals/);
	});

	test('redacts home folder, workspace paths and names, and user name', () => {
		const targets = {
			homeDir: 'C:\\Users\\jdoe',
			userName: 'jdoe',
			workspacePaths: ['C:\\Users\\jdoe\\src\\secret-project'],
			workspaceNames: ['secret-project'],
		};
		const text = 'C:\\Users\\jdoe\\src\\secret-project\\a.ts c:/users/JDOE/.claude secret-project JDoe jdoes';
		assert.strictEqual(redactSensitiveText(text, targets), '<workspace>\\a.ts ~/.claude <workspace> <user> jdoes');
		assert.strictEqual(redactSensitiveText('/home/ab x', { homeDir: '/home/ab', userName: 'ab' }), '~ x', 'short names are not word-redacted');
		assert.strictEqual(redactSensitiveText('/home/abc', { homeDir: '/home/ab' }), '/home/abc', 'only whole path segments match');
	});

	test('report and text are safe to share: no paths, user or project names, or content', () => {
		const targets = { homeDir: '/home/jdoe', userName: 'jdoe', workspacePaths: ['/home/jdoe/work/acme-billing'], workspaceNames: ['acme-billing'] };
		const report = createDiagnosticsReport(input({
			os: { platform: 'linux', release: '6.8.0-jdoe-acme-billing', arch: 'x64' },
			providers: [{ id: 'claude-code', displayName: 'Claude Code (/home/jdoe/work/acme-billing)', state: 'tracking', lastEventAt: T }],
		}), targets);
		const text = formatDiagnosticsReport(report);
		const json = JSON.stringify(report);
		for (const output of [json, text]) {
			for (const secret of ['/home/jdoe', 'jdoe', 'acme-billing', '.jsonl']) {
				assert.ok(!output.toLowerCase().includes(secret), `${secret} leaked: ${output}`);
			}
		}
		assert.ok(!/prompt|response|content|text|file/i.test(json), json);
		assert.match(text, /Contains no prompts, responses, source code, file names or paths\./);
	});

	test('report survives JSON serialization unchanged', () => {
		const report = createDiagnosticsReport(input());
		assert.deepStrictEqual(JSON.parse(JSON.stringify(report)), report);
	});
});
