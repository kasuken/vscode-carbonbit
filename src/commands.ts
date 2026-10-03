import * as vscode from 'vscode';

/** PRD §45 commands; ids must match `contributes.commands` in package.json. */
export const COMMAND_IDS = {
	open: 'carbonbit.openSidebar',
	refreshUsage: 'carbonbit.refreshUsage',
	showDetails: 'carbonbit.showDetails',
	showMethodology: 'carbonbit.showMethodology',
	clearLocalData: 'carbonbit.clearLocalData',
	openDiagnostics: 'carbonbit.openDiagnostics',
} as const;

export type CommandName = keyof typeof COMMAND_IDS;
export type CommandHandlers = Record<CommandName, () => unknown>;

export function registerCommands(handlers: CommandHandlers): vscode.Disposable[] {
	return (Object.keys(COMMAND_IDS) as CommandName[]).map(name =>
		vscode.commands.registerCommand(COMMAND_IDS[name], () => handlers[name]()));
}

export function focusSidebar(viewId: string): Thenable<unknown> {
	return vscode.commands.executeCommand(`${viewId}.focus`);
}

export const METHODOLOGY_PATH = ['docs', 'METHODOLOGY.md'] as const;

/** Opens the bundled methodology as a Markdown preview (plain editor if preview is unavailable). */
export async function openMethodology(extensionUri: vscode.Uri): Promise<void> {
	const uri = vscode.Uri.joinPath(extensionUri, ...METHODOLOGY_PATH);
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		void vscode.window.showErrorMessage('CarbonBit methodology document is missing from this installation.');
		return;
	}
	try {
		await vscode.commands.executeCommand('markdown.showPreview', uri);
	} catch {
		await vscode.window.showTextDocument(uri, { preview: true });
	}
}

export async function openDiagnosticsDocument(text: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: text });
	await vscode.window.showTextDocument(document, { preview: true });
}
