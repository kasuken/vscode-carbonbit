import * as os from 'os';
import * as path from 'path';
import { JsonlTailAdapter, listJsonlFiles, type JsonlFileParser, type JsonlTailOptions } from '../shared/jsonlTailAdapter';
import { CopilotCliParser } from './copilotCliParser';

export interface CopilotCliAdapterOptions extends JsonlTailOptions {
	/** `session-state` folders to scan; defaults to `copilotCliSessionDirs()`. */
	sessionDirs?: readonly string[];
}

/** `$COPILOT_HOME/session-state`, else `$XDG_CONFIG_HOME/.copilot` or `~/.copilot`. */
export function copilotCliSessionDirs(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string[] {
	const copilotHome = env.COPILOT_HOME?.trim();
	if (copilotHome) {
		return [path.join(copilotHome, 'session-state')];
	}
	const dirs = [path.join(home, '.copilot', 'session-state')];
	const xdg = env.XDG_CONFIG_HOME?.trim();
	if (xdg) {
		dirs.unshift(path.join(xdg, '.copilot', 'session-state'));
	}
	return dirs;
}

/**
 * GitHub Copilot CLI adapter. Tails `session-state/<id>/events.jsonl` and emits per-model-call
 * output tokens plus input/cache totals from session shutdown summaries. Existing history is
 * not replayed.
 */
export class CopilotCliAdapter extends JsonlTailAdapter {
	readonly id = 'github-copilot-cli';
	readonly displayName = 'GitHub Copilot CLI';

	constructor(options: CopilotCliAdapterOptions = {}) {
		super(options.sessionDirs ?? copilotCliSessionDirs(), options);
	}

	protected listFiles(root: string): Promise<string[]> {
		return listJsonlFiles(root, 1, name => name === 'events.jsonl');
	}

	protected override sessionLabel(file: string): string {
		return path.basename(path.dirname(file));
	}

	protected createParser(file: string): JsonlFileParser {
		return new CopilotCliParser(this.sessionLabel(file));
	}
}
