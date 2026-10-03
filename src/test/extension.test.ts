import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { COMMAND_IDS, METHODOLOGY_PATH } from '../commands';

function detailsTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all.flatMap(g => g.tabs)
		.filter(t => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('carbonbit.details'));
}

// Tab state reaches the extension host asynchronously.
async function waitForDetailsTabs(count: number): Promise<vscode.Tab[]> {
	for (let i = 0; i < 50 && detailsTabs().length !== count; i++) {
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	return detailsTabs();
}

suite('Extension Test Suite', () => {
	test('CarbonBit: Open activates the extension and reveals the sidebar view', async () => {
		await vscode.commands.executeCommand('carbonbit.openSidebar');
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('carbonbit.openSidebar'));
		assert.ok(commands.includes('carbonbit.sidebar.focus'));
		assert.ok(!commands.includes('vscode-carbonbit.helloWorld'));
	});

	test('contributes animation settings with PRD defaults', () => {
		const config = vscode.workspace.getConfiguration('carbonbit.animation');
		assert.strictEqual(config.get('enabled'), true);
		assert.strictEqual(config.get('maxFps'), 30);
	});

	test('contributes local data retention and the clear command', async () => {
		assert.strictEqual(vscode.workspace.getConfiguration('carbonbit').get('dataRetentionDays'), 90);
		await vscode.commands.executeCommand('carbonbit.openSidebar');
		assert.ok((await vscode.commands.getCommands(true)).includes('carbonbit.clearLocalData'));
	});

	test('contributes and registers every PRD §45 command in the CarbonBit category', async () => {
		const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'vscode-carbonbit');
		assert.ok(extension);
		const contributed = extension.packageJSON.contributes.commands as { command: string; title: string; category: string }[];
		assert.deepStrictEqual(contributed.map(c => `${c.category}: ${c.title}`), [
			'CarbonBit: Open',
			'CarbonBit: Refresh Usage',
			'CarbonBit: Show Details',
			'CarbonBit: Show Methodology',
			'CarbonBit: Clear Local Data',
			'CarbonBit: Open Diagnostics',
		]);
		assert.deepStrictEqual(contributed.map(c => c.command), Object.values(COMMAND_IDS));
		await vscode.commands.executeCommand(COMMAND_IDS.open);
		const registered = await vscode.commands.getCommands(true);
		for (const id of Object.values(COMMAND_IDS)) {
			assert.ok(registered.includes(id), id);
		}
	});

	test('contributes the visual mode setting with the PRD default and allowed values', () => {
		const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'vscode-carbonbit');
		const schema = extension?.packageJSON.contributes.configuration.properties['carbonbit.visualMode'];
		assert.deepStrictEqual(schema.enum, ['environmental', 'neutral', 'minimal']);
		assert.strictEqual(vscode.workspace.getConfiguration('carbonbit').get('visualMode'), 'environmental');
	});

	test('Refresh Usage completes without errors', async () => {
		await vscode.commands.executeCommand(COMMAND_IDS.refreshUsage);
	});

	test('Show Details and Show Methodology share one Details panel that reopens after closing', async () => {
		await vscode.commands.executeCommand(COMMAND_IDS.showDetails);
		await vscode.commands.executeCommand(COMMAND_IDS.showDetails);
		await vscode.commands.executeCommand(COMMAND_IDS.showMethodology);
		const tabs = await waitForDetailsTabs(1);
		assert.strictEqual(tabs.length, 1);
		assert.strictEqual(tabs[0].label, 'CarbonBit Details');
		await vscode.window.tabGroups.close(tabs);
		assert.strictEqual((await waitForDetailsTabs(0)).length, 0);
		await vscode.commands.executeCommand(COMMAND_IDS.showMethodology);
		const reopened = await waitForDetailsTabs(1);
		assert.strictEqual(reopened.length, 1);
		await vscode.window.tabGroups.close(reopened);
	});

	test('Open Diagnostics opens a report without home folder or user name', async () => {
		await vscode.commands.executeCommand(COMMAND_IDS.openDiagnostics);
		const text = vscode.window.activeTextEditor?.document.getText() ?? '';
		assert.match(text, /^# CarbonBit Diagnostics/);
		assert.match(text, new RegExp(`VS Code version: ${vscode.version.replace(/\./g, '\\.')}`));
		for (const name of ['GitHub Copilot', 'Claude Code', 'Codex CLI']) {
			assert.ok(text.includes(`- ${name}`), name);
		}
		assert.match(text, /## Database\n\n\S/);
		assert.ok(!text.toLowerCase().includes(os.homedir().toLowerCase()));
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	});

	test('the full methodology document still ships with the extension', async () => {
		const extension = vscode.extensions.all.find(e => e.packageJSON.name === 'vscode-carbonbit');
		assert.ok(extension);
		await vscode.workspace.fs.stat(vscode.Uri.joinPath(extension.extensionUri, ...METHODOLOGY_PATH));
	});
});
