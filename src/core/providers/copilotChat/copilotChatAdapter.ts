import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import type { AiUsageEvent } from '../../usage/usageEvent';
import { JsonlTailAdapter, listJsonlFiles, type JsonlFileParser, type JsonlTailOptions } from '../shared/jsonlTailAdapter';
import { ChatSessionLog } from './chatSessionLog';
import { toUsageEvent } from './copilotChatNormalizer';

export interface CopilotChatAdapterOptions extends JsonlTailOptions {
	/** Folders that hold `<session>.jsonl` files directly. */
	sessionDirs?: readonly string[];
	/** VS Code `workspaceStorage` folders; every `<workspace>/chatSessions` below them is scanned. */
	workspaceStorageDirs?: readonly string[];
	isCopilotChatInstalled: () => boolean;
}

/** Chat session folders of every window under a VS Code user data folder (`.../User`); internal layout. */
export function copilotChatSessionRoots(userDir: string): Pick<CopilotChatAdapterOptions, 'sessionDirs' | 'workspaceStorageDirs'> {
	return {
		workspaceStorageDirs: [path.join(userDir, 'workspaceStorage')],
		sessionDirs: [path.join(userDir, 'globalStorage', 'emptyWindowChatSessions')],
	};
}

class CopilotChatFileParser implements JsonlFileParser {
	private readonly log = new ChatSessionLog();

	constructor(private readonly sessionId: string) { }

	get malformedLines(): number {
		return this.log.malformedLines;
	}

	apply(line: string): void {
		this.log.apply(line);
	}

	*takeChanged(): Iterable<AiUsageEvent> {
		for (const meta of this.log.requests) {
			const event = meta.requestId ? toUsageEvent(this.sessionId, meta) : undefined;
			if (event) {
				yield event;
			}
		}
	}
}

/**
 * GitHub Copilot Chat adapter. Tails VS Code's local chat session logs of all workspaces and
 * emits request metadata only. Limitations: the session format is internal to VS Code (not a
 * public API), cache token counts are not recorded, and only this VS Code installation's
 * sessions are visible.
 */
export class CopilotChatAdapter extends JsonlTailAdapter {
	readonly id = 'github-copilot';
	readonly displayName = 'GitHub Copilot Chat';
	private readonly workspaceStorageDirs: ReadonlySet<string>;

	constructor(private readonly chatOptions: CopilotChatAdapterOptions) {
		const workspaceStorageDirs = chatOptions.workspaceStorageDirs ?? [];
		// Session files are small operation logs that need a full replay to rebuild request state.
		super([...(chatOptions.sessionDirs ?? []), ...workspaceStorageDirs], chatOptions, true);
		this.workspaceStorageDirs = new Set(workspaceStorageDirs);
	}

	override async isAvailable(): Promise<boolean> {
		return this.chatOptions.isCopilotChatInstalled() || super.isAvailable();
	}

	protected async listFiles(root: string): Promise<string[]> {
		if (!this.workspaceStorageDirs.has(root)) {
			return listJsonlFiles(root, 0);
		}
		const workspaces = await fs.readdir(root, { withFileTypes: true }).catch((): Dirent[] => []);
		const files: string[] = [];
		for (const workspace of workspaces) {
			if (workspace.isDirectory()) {
				files.push(...await listJsonlFiles(path.join(root, workspace.name, 'chatSessions'), 0));
			}
		}
		return files;
	}

	protected createParser(file: string): JsonlFileParser {
		return new CopilotChatFileParser(this.sessionLabel(file));
	}
}
