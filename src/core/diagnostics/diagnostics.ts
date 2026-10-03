import type { ProviderStatus, ProviderTrackingState } from '../usage/usageService';
import type { AiProviderId } from '../usage/usageEvent';

/** How the usage database was opened and how it has behaved since (PRD §46 "Database"). */
export interface StorageStatus {
	available: boolean;
	persistent: boolean;
	/** An unreadable database was moved aside and recreated at startup. */
	recovered: boolean;
	failedOperations: readonly string[];
}

export type DatabaseHealth = 'healthy' | 'recovered' | 'errors' | 'memory-only' | 'unavailable';
export type ProviderDetection = 'detected' | 'not-detected' | 'error' | 'pending';

export interface DiagnosticsInput {
	extensionVersion: string;
	vscodeVersion: string;
	os: { platform: string; release: string; arch: string };
	providers: readonly ProviderStatus[];
	storage: StorageStatus;
	settings: { animationEnabled: boolean; maxFps: number; visualMode: string; retentionDays: number };
	now: number;
}

export interface ProviderDiagnostics {
	id: AiProviderId;
	displayName: string;
	state: ProviderTrackingState;
	detection: ProviderDetection;
	/** ISO timestamp of the last event received this session. */
	lastEventAt: string | null;
}

/** Metadata only: no prompts, responses, source code, file names or paths. */
export interface DiagnosticsReport {
	generatedAt: string;
	extensionVersion: string;
	vscodeVersion: string;
	os: { platform: string; release: string; arch: string };
	providers: ProviderDiagnostics[];
	lastProviderUpdate: string | null;
	database: { health: DatabaseHealth; persistent: boolean; failedOperations: string[] };
	settings: { animationEnabled: boolean; maxFps: number; visualMode: string; retentionDays: number };
}

/** Values that could identify the user or project; replaced wherever they appear. */
export interface RedactionTargets {
	homeDir?: string;
	userName?: string;
	/** Workspace folder paths. */
	workspacePaths?: readonly string[];
	/** Workspace and folder names. */
	workspaceNames?: readonly string[];
}

const DETECTION: Record<ProviderTrackingState, ProviderDetection> = {
	tracking: 'detected',
	unavailable: 'not-detected',
	failed: 'error',
	stopped: 'pending',
};

const DETECTION_LABEL: Record<ProviderDetection, string> = {
	detected: 'Detected',
	'not-detected': 'Not detected',
	error: 'Tracking unavailable',
	pending: 'Not started',
};

const HEALTH_LABEL: Record<DatabaseHealth, string> = {
	healthy: 'Healthy',
	recovered: 'Healthy (an unreadable database was reset at startup; a backup was kept)',
	errors: 'Errors',
	'memory-only': 'In memory only (usage is not saved this session)',
	unavailable: 'Unavailable',
};

// Short names would match unrelated words.
const MIN_NAME_LENGTH = 3;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathPattern(p: string): RegExp {
	const parts = p.replace(/[\\/]+$/, '').split(/[\\/]+/).map(escapeRegExp);
	return new RegExp(`${parts.join('[\\\\/]+')}(?![\\p{L}\\p{N}_-])`, 'giu');
}

function wordPattern(word: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'giu');
}

/** Replaces home/workspace paths, workspace names and the user name. */
export function redactSensitiveText(text: string, targets: RedactionTargets): string {
	let result = text;
	const paths = [...(targets.workspacePaths ?? [])].filter(p => p.length >= MIN_NAME_LENGTH).sort((a, b) => b.length - a.length);
	for (const p of paths) {
		result = result.replace(pathPattern(p), '<workspace>');
	}
	if (targets.homeDir && targets.homeDir.length >= MIN_NAME_LENGTH) {
		result = result.replace(pathPattern(targets.homeDir), '~');
	}
	for (const name of targets.workspaceNames ?? []) {
		if (name.length >= MIN_NAME_LENGTH) {
			result = result.replace(wordPattern(name), '<workspace>');
		}
	}
	if (targets.userName && targets.userName.length >= MIN_NAME_LENGTH) {
		result = result.replace(wordPattern(targets.userName), '<user>');
	}
	return result;
}

export function databaseHealth(storage: StorageStatus): DatabaseHealth {
	if (!storage.available) {
		return 'unavailable';
	}
	if (!storage.persistent) {
		return 'memory-only';
	}
	if (storage.failedOperations.length > 0) {
		return 'errors';
	}
	return storage.recovered ? 'recovered' : 'healthy';
}

/** Builds the report; free-text fields are passed through `redactSensitiveText`, the rest are enums/numbers. */
export function createDiagnosticsReport(input: DiagnosticsInput, targets: RedactionTargets = {}): DiagnosticsReport {
	const redact = (text: string) => redactSensitiveText(text, targets);
	const providers = input.providers.map(p => ({
		id: p.id,
		displayName: redact(p.displayName),
		state: p.state,
		detection: DETECTION[p.state],
		lastEventAt: p.lastEventAt === null ? null : new Date(p.lastEventAt).toISOString(),
	}));
	const last = Math.max(...input.providers.map(p => p.lastEventAt ?? -Infinity));
	return {
		generatedAt: new Date(input.now).toISOString(),
		extensionVersion: redact(input.extensionVersion),
		vscodeVersion: redact(input.vscodeVersion),
		os: { platform: redact(input.os.platform), release: redact(input.os.release), arch: redact(input.os.arch) },
		providers,
		lastProviderUpdate: Number.isFinite(last) ? new Date(last).toISOString() : null,
		database: {
			health: databaseHealth(input.storage),
			persistent: input.storage.persistent,
			failedOperations: input.storage.failedOperations.map(redact),
		},
		settings: { ...input.settings, visualMode: redact(input.settings.visualMode) },
	};
}

function localTime(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Plain-text (Markdown) rendering of the report, safe to paste into an issue. */
export function formatDiagnosticsReport(report: DiagnosticsReport): string {
	const lines = [
		'# CarbonBit Diagnostics',
		'',
		`- CarbonBit version: ${report.extensionVersion}`,
		`- VS Code version: ${report.vscodeVersion}`,
		`- Operating system: ${report.os.platform} ${report.os.release} (${report.os.arch})`,
		'',
		'## Provider detection',
		'',
		...report.providers.map(p => {
			const update = p.lastEventAt ? `, last update ${localTime(p.lastEventAt)}` : '';
			return `- ${p.displayName}: ${DETECTION_LABEL[p.detection]}${update}`;
		}),
		'',
		`Last provider update: ${report.lastProviderUpdate ? localTime(report.lastProviderUpdate) : 'none this session'}`,
		'',
		'## Database',
		'',
		HEALTH_LABEL[report.database.health],
		...(report.database.failedOperations.length > 0 ? ['', `Failed operations: ${report.database.failedOperations.join(', ')}`] : []),
		'',
		'## Settings',
		'',
		`- Animation: ${report.settings.animationEnabled ? 'on' : 'off'}, max ${report.settings.maxFps} FPS`,
		`- Visual mode: ${report.settings.visualMode}`,
		`- Data retention: ${report.settings.retentionDays === 0 ? 'unlimited' : `${report.settings.retentionDays} days`}`,
		'',
		`Generated ${localTime(report.generatedAt)}. Contains no prompts, responses, source code, file names or paths.`,
		'',
	];
	return lines.join('\n');
}
