import * as os from 'os';
import * as path from 'path';
import { JsonlTailAdapter, listJsonlFiles, type JsonlFileParser, type JsonlTailOptions } from '../shared/jsonlTailAdapter';
import { CodexParser } from './codexParser';

export interface CodexCliAdapterOptions extends JsonlTailOptions {
	/** `sessions` folders to scan; defaults to `codexSessionDirs()`. */
	sessionDirs?: readonly string[];
}

/** `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
export function codexSessionDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
	return [path.join(env.CODEX_HOME?.trim() || path.join(home, '.codex'), 'sessions')];
}

/**
 * Codex CLI adapter. Tails rollout files and emits per-turn metadata with actual token and
 * cached-input counts. Existing history is not replayed.
 */
export class CodexCliAdapter extends JsonlTailAdapter {
	readonly id = 'codex-cli';
	readonly displayName = 'Codex CLI';
	// Observed on Windows: rollouts still being appended keep the mtime of when they were opened.
	protected override readonly mtimeMayLag = true;

	constructor(options: CodexCliAdapterOptions = {}) {
		super(options.sessionDirs ?? codexSessionDirs(), options);
	}

	// YYYY/MM/DD/rollout-*.jsonl
	protected listFiles(root: string): Promise<string[]> {
		return listJsonlFiles(root, 3, name => name.startsWith('rollout-') && name.endsWith('.jsonl'));
	}

	protected createParser(file: string): JsonlFileParser {
		return new CodexParser(this.sessionLabel(file));
	}
}
