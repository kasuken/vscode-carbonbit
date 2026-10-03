import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { focusSidebar, openDiagnosticsDocument, openMethodology, registerCommands } from './commands';
import {
	createDiagnosticsReport,
	DiagnosticsReport,
	formatDiagnosticsReport,
	RedactionTargets,
	StorageStatus,
} from './core/diagnostics/diagnostics';
import { ClaudeCodeAdapter } from './core/providers/claudeCode/claudeCodeAdapter';
import { CodexCliAdapter } from './core/providers/codexCli/codexCliAdapter';
import { CopilotChatAdapter, copilotChatSessionRoots } from './core/providers/copilotChat/copilotChatAdapter';
import { CopilotCliAdapter } from './core/providers/copilotCli/copilotCliAdapter';
import { normalizeAnimationSettings } from './core/settings/animationSettings';
import { normalizeRetentionDays } from './core/settings/retentionSettings';
import { normalizeVisualMode } from './core/settings/visualModeSettings';
import { DATABASE_FILE_NAME, openUsageStore } from './core/storage/openUsageStore';
import { localStartOfDay, UsageHistory } from './core/storage/usageHistory';
import { BACKFILL_VERSION, checkpointAt, importSince, needsBackfill } from './core/usage/importCheckpoint';
import { UsageService } from './core/usage/usageService';
import { methodologyView, toDetailsView } from './core/view/detailsView';
import { LiveActivity } from './core/view/liveActivity';
import { buildSidebarModel, SidebarModel } from './core/view/sidebarModel';
import { toSidebarView } from './core/view/sidebarView';
import { WorldStateEngine } from './core/world/worldStateEngine';
import { DetailsPanel } from './details/detailsPanel';
import { SidebarViewProvider } from './sidebar/sidebarViewProvider';

const CLI_POLL_MS = 2000;
// Every workspace's chat sessions are scanned, so they are polled at the CLI rate too.
const CHAT_POLL_MS = 2000;
const VIEW_THROTTLE_MS = 1000;
// Also catches midnight rollover and usage recorded by other VS Code windows; saves the import checkpoint.
const VIEW_REFRESH_MS = 60_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ONBOARDING_DISMISSED_KEY = 'carbonbit.onboardingDismissed';
const LAST_TRACKED_KEY = 'carbonbit.lastTrackedAt';
const BACKFILL_KEY = 'carbonbit.historyBackfill';

// globalStorageUri is `<User>/globalStorage/<extension id>`; chat sessions live under `<User>`.
function vscodeUserDir(context: vscode.ExtensionContext): string {
	return path.dirname(path.dirname(context.globalStorageUri.fsPath));
}

function readAnimationSettings() {
	const config = vscode.workspace.getConfiguration('carbonbit.animation');
	return normalizeAnimationSettings(config.get('enabled'), config.get('maxFps'));
}

function readRetentionDays() {
	return normalizeRetentionDays(vscode.workspace.getConfiguration('carbonbit').get('dataRetentionDays'));
}

function readVisualMode() {
	return normalizeVisualMode(vscode.workspace.getConfiguration('carbonbit').get('visualMode'));
}

function openHistory(context: vscode.ExtensionContext, log: (message: string) => void): { history: UsageHistory; persistent: boolean; recovered: boolean } {
	const opened = openUsageStore({ file: path.join(context.globalStorageUri.fsPath, DATABASE_FILE_NAME), log });
	if (opened.warning) {
		void vscode.window.showWarningMessage(opened.warning);
	}
	return {
		history: new UsageHistory(opened.store, { log }),
		persistent: opened.persistent,
		recovered: opened.persistent && opened.warning !== undefined,
	};
}

function redactionTargets(): RedactionTargets {
	const folders = vscode.workspace.workspaceFolders ?? [];
	let userName: string | undefined;
	try {
		userName = os.userInfo().username;
	} catch {
		// Some environments have no user database entry.
	}
	return {
		homeDir: os.homedir(),
		userName,
		workspacePaths: folders.map(f => f.uri.fsPath),
		workspaceNames: [vscode.workspace.name, ...folders.map(f => f.name)].filter((n): n is string => !!n),
	};
}

async function confirmAndClear(history: UsageHistory, refresh: () => void): Promise<void> {
	const clear = 'Clear Data';
	const choice = await vscode.window.showWarningMessage(
		'Delete all CarbonBit usage data stored on this machine?',
		{ modal: true, detail: 'Usage history and today\'s totals are removed. Settings are kept. This cannot be undone.' },
		clear,
	);
	if (choice !== clear) {
		return;
	}
	if (history.clear()) {
		refresh();
		void vscode.window.showInformationMessage('CarbonBit local data cleared.');
	} else {
		void vscode.window.showErrorMessage('CarbonBit could not clear local data. See the CarbonBit output for details.');
	}
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('CarbonBit', { log: true });
	let publishView = () => { /* replaced once usage history is open */ };
	const sidebar = new SidebarViewProvider(context.extensionUri, {
		runCommand: command => { void vscode.commands.executeCommand(command); },
		dismissOnboarding: () => { void context.globalState.update(ONBOARDING_DISMISSED_KEY, true).then(() => publishView()); },
	});
	sidebar.setAnimation(readAnimationSettings());
	sidebar.setVisualMode(readVisualMode());
	let viewTimer: ReturnType<typeof setTimeout> | undefined;
	// World transitions (including expiring pulses and loops) also refresh the live line, throttled.
	const world = new WorldStateEngine(snapshot => {
		sidebar.setWorld(snapshot);
		viewTimer ??= setTimeout(() => publishView(), VIEW_THROTTLE_MS);
	});
	const live = new LiveActivity();
	const log = (message: string) => output.info(message);
	const usage = new UsageService(log);
	// Logs written while CarbonBit was not running are imported in the background on start; the first
	// time, that includes whatever history the tools' logs still hold, so past periods aren't empty.
	// The extension's own test host never imports the developer's whole history.
	const backfilled = context.extensionMode === vscode.ExtensionMode.Test ? BACKFILL_VERSION : context.globalState.get(BACKFILL_KEY);
	const backfill = needsBackfill(backfilled);
	const since = importSince(context.globalState.get(LAST_TRACKED_KEY), Date.now(), localStartOfDay, readRetentionDays(), backfilled);
	if (backfill) {
		log(`importing usage history since ${new Date(since).toISOString().slice(0, 10)} from local logs`);
	}
	usage.register(new CopilotChatAdapter({
		...copilotChatSessionRoots(vscodeUserDir(context)),
		isCopilotChatInstalled: () => vscode.extensions.getExtension('GitHub.copilot-chat') !== undefined,
		log,
		pollIntervalMs: CHAT_POLL_MS,
		importSince: since,
	}));
	// CLI logs live in the user's home folder and can be large, so they are polled less often.
	usage.register(new CopilotCliAdapter({ log, pollIntervalMs: CLI_POLL_MS, importSince: since }));
	usage.register(new ClaudeCodeAdapter({ log, pollIntervalMs: CLI_POLL_MS, importSince: since }));
	usage.register(new CodexCliAdapter({ log, pollIntervalMs: CLI_POLL_MS, importSince: since }));
	let importDone = false;
	const saveCheckpoint = () => {
		if (importDone) {
			void context.globalState.update(LAST_TRACKED_KEY, checkpointAt(Date.now()));
		}
	};

	const { history, persistent, recovered } = openHistory(context, message => output.warn(message));
	const logPruned = (removed: number) => {
		if (removed > 0) {
			log(`storage: removed ${removed} expired requests`);
		}
	};
	logPruned(history.setRetentionDays(readRetentionDays()));
	const refreshTimer = setInterval(() => { saveCheckpoint(); publishView(); }, VIEW_REFRESH_MS);
	const pruneTimer = setInterval(() => { logPruned(history.pruneExpired()); publishView(); }, PRUNE_INTERVAL_MS);

	// Single source of host-side view data for the sidebar/details UI.
	const getSidebarModel = (): SidebarModel => buildSidebarModel({
		world: () => world.current,
		live: () => live.current(),
		history,
		statuses: () => usage.getStatuses(),
	});
	const details = new DetailsPanel(context.extensionUri, () => toDetailsView(getSidebarModel()), methodologyView(), {
		openMethodologyDocument: () => { void openMethodology(context.extensionUri); },
	});
	publishView = () => {
		clearTimeout(viewTimer);
		viewTimer = undefined;
		const firstRun = !context.globalState.get<boolean>(ONBOARDING_DISMISSED_KEY, false);
		const model = getSidebarModel();
		sidebar.setView(toSidebarView(model, { firstRun }));
		if (details.visible) {
			details.setView(toDetailsView(model));
		}
	};
	publishView();
	const getDiagnosticsReport = (): DiagnosticsReport => {
		const storage: StorageStatus = { available: history.available, persistent, recovered, failedOperations: history.failedOperations };
		const animation = readAnimationSettings();
		return createDiagnosticsReport({
			extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
			vscodeVersion: vscode.version,
			os: { platform: os.platform(), release: os.release(), arch: os.arch() },
			providers: usage.getStatuses(),
			storage,
			settings: { animationEnabled: animation.enabled, maxFps: animation.maxFps, visualMode: readVisualMode(), retentionDays: readRetentionDays() },
			now: Date.now(),
		}, redactionTargets());
	};

	context.subscriptions.push(
		output,
		world,
		usage,
		history,
		details,
		{ dispose: () => { clearInterval(refreshTimer); clearInterval(pruneTimer); clearTimeout(viewTimer); } },
		usage.onUsageEvent((event, origin) => {
			// Imported history is stored but does not animate the world or the live line.
			if (origin !== 'import') {
				world.handle(event);
				live.handle(event);
			}
			history.record(event);
			viewTimer ??= setTimeout(publishView, VIEW_THROTTLE_MS);
			output.trace(`${event.provider} ${event.status} model=${event.model ?? 'unknown'} in=${event.inputTokens ?? '-'} out=${event.outputTokens ?? '-'} (${event.source}, ${origin ?? 'live'})`);
		}),
		vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewId, sidebar),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('carbonbit.animation')) {
				sidebar.setAnimation(readAnimationSettings());
			}
			if (e.affectsConfiguration('carbonbit.visualMode')) {
				sidebar.setVisualMode(readVisualMode());
			}
			if (e.affectsConfiguration('carbonbit.dataRetentionDays')) {
				logPruned(history.setRetentionDays(readRetentionDays()));
				publishView();
			}
		}),
		...registerCommands({
			open: () => focusSidebar(SidebarViewProvider.viewId),
			refreshUsage: async () => {
				await usage.refresh();
				publishView();
				vscode.window.setStatusBarMessage('CarbonBit: usage refreshed', 3000);
			},
			showDetails: () => details.show('overview'),
			showMethodology: () => details.show('methodology'),
			clearLocalData: () => confirmAndClear(history, () => { live.clear(); publishView(); }),
			openDiagnostics: () => openDiagnosticsDocument(formatDiagnosticsReport(getDiagnosticsReport())),
		}),
	);

	// Provider discovery and the import run in the background so activation never waits on or fails with them.
	void usage.start().then(() => {
		// Advance the checkpoint only after the import finished, so an interrupted import is retried.
		importDone = true;
		saveCheckpoint();
		if (backfill) {
			void context.globalState.update(BACKFILL_KEY, BACKFILL_VERSION);
		}
		publishView();
	});
}

export function deactivate() {}
