import * as os from 'os';
import * as path from 'path';
import { JsonlTailAdapter, listJsonlFiles, type JsonlFileParser, type JsonlTailOptions } from '../shared/jsonlTailAdapter';
import { ClaudeCodeParser } from './claudeCodeParser';

export interface ClaudeCodeAdapterOptions extends JsonlTailOptions {
	/** `projects` folders to scan; defaults to `claudeCodeProjectDirs()`. */
	projectDirs?: readonly string[];
}

/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects` and the XDG `~/.config/claude/projects`. */
export function claudeCodeProjectDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
	const configDir = env.CLAUDE_CONFIG_DIR?.trim();
	if (configDir) {
		return [path.join(configDir, 'projects')];
	}
	return [path.join(home, '.claude', 'projects'), path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'claude', 'projects')];
}

/**
 * Claude Code adapter. Tails local transcripts and emits per-API-response metadata with
 * actual token and cache counts. Existing history is not replayed.
 */
export class ClaudeCodeAdapter extends JsonlTailAdapter {
	readonly id = 'claude-code';
	readonly displayName = 'Claude Code';

	constructor(options: ClaudeCodeAdapterOptions = {}) {
		super(options.projectDirs ?? claudeCodeProjectDirs(), options);
	}

	// <project>/<session>.jsonl and <project>/<session>/subagents/<agent>.jsonl
	protected listFiles(root: string): Promise<string[]> {
		return listJsonlFiles(root, 3);
	}

	protected createParser(file: string): JsonlFileParser {
		return new ClaudeCodeParser(this.sessionLabel(file));
	}
}
