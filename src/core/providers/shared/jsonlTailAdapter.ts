import { promises as fs, type Dirent } from 'fs';
import * as path from 'path';
import type { AiProviderId, AiUsageEvent } from '../../usage/usageEvent';
import type { AiProviderAdapter, AiUsageEventListener, Disposable, UsageEventOrigin } from '../provider';
import { parseRecord, toEpoch } from './jsonValues';

/** Incremental parser for one JSONL session file. Must keep metadata only, never content. */
export interface JsonlFileParser {
	readonly malformedLines: number;
	apply(line: string): void;
	/** Current events whose state may have changed since the previous call. */
	takeChanged(): Iterable<AiUsageEvent>;
}

export interface JsonlTailOptions {
	/** Must only receive metadata (ids, counts, states), never conversation content. */
	log?: (message: string) => void;
	/** 0 disables polling; callers then drive updates with `refresh()`. */
	pollIntervalMs?: number;
	/**
	 * Epoch ms of the previous run. On start, files modified since then are read from the
	 * beginning and their events active since then are emitted with origin `import`.
	 */
	importSince?: number;
}

interface FileState {
	parser: JsonlFileParser;
	offset: number;
	rest: Buffer;
	/** Tailing started mid-file: drop bytes up to the next newline. */
	skipPartialLine: boolean;
	/** Last emitted signature per event id, used to deduplicate repeated updates. */
	emitted: Map<string, string>;
	/** Replay adapters: size and mtime of a file known at start but not parsed yet. */
	deferred?: { size: number; mtimeMs: number };
}

/** Which changed events to emit after parsing; `undefined` records them as already seen. */
interface Emission {
	origin: UsageEventOrigin;
	/** Only events active at or after this epoch ms are emitted. */
	activeSince?: number;
}

const OPEN_BRACE = 0x7b;
const NEWLINE = 0x0a;
// Large logs are parsed in slices so the extension host stays responsive.
const CHUNK_BYTES = 4 * 1024 * 1024;
// Replay adapters parse recently used sessions up front; older ones only when they change.
const EAGER_REPLAY_MS = 7 * 24 * 60 * 60 * 1000;

async function readRange(file: string, start: number, end: number): Promise<Buffer> {
	const handle = await fs.open(file, 'r');
	try {
		const buffer = Buffer.alloc(end - start);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

// Enough for the last few records of a log; a longer final line falls back to the file's mtime.
const TAIL_PROBE_BYTES = 64 * 1024;

/** Epoch ms of the last complete record with a top-level `timestamp` near the end of `file`. */
export async function lastRecordTime(file: string, size: number): Promise<number | undefined> {
	const start = Math.max(0, size - TAIL_PROBE_BYTES);
	const lines = (await readRange(file, start, size).catch(() => Buffer.alloc(0))).toString('utf8').split('\n');
	// The first piece may be the end of a line cut by the probe window.
	for (let i = lines.length - 1; i >= (start > 0 ? 1 : 0); i--) {
		const at = toEpoch(parseRecord(lines[i])?.timestamp);
		if (at !== undefined) {
			return at;
		}
	}
	return undefined;
}

function activeAt(event: AiUsageEvent): number {
	return Date.parse(event.completedAt ?? event.startedAt);
}

export function isDirectory(dir: string): Promise<boolean> {
	return fs.stat(dir).then(s => s.isDirectory(), () => false);
}

/** Lists files accepted by `accept` under `root`, descending at most `maxDepth` folder levels. */
export async function listJsonlFiles(root: string, maxDepth: number, accept = (name: string) => name.endsWith('.jsonl')): Promise<string[]> {
	const files: string[] = [];
	const visit = async (dir: string, depth: number): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (depth < maxDepth) {
					await visit(full, depth + 1);
				}
			} else if (entry.isFile() && accept(entry.name)) {
				files.push(full);
			}
		}
	};
	await visit(root, 0);
	return files;
}

/**
 * Shared adapter base that tails append-only JSONL session logs: polling, partial-line
 * buffering, rewrite detection, per-event deduplication and failure-isolated emission.
 * Existing content becomes the baseline on start, except files modified since
 * `importSince`, which are imported. With `replayHistory`, existing files are parsed
 * (without emitting) so later changes can be applied; otherwise they are skipped.
 */
export abstract class JsonlTailAdapter implements AiProviderAdapter {
	abstract readonly id: AiProviderId;
	abstract readonly displayName: string;

	private readonly listeners = new Set<AiUsageEventListener>();
	private readonly files = new Map<string, FileState>();
	private queue: Promise<void> = Promise.resolve();
	/** A refresh scan that is queued but not started yet; later refreshes join it. */
	private pendingRefresh: Promise<void> | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	private startedAt = 0;
	private imported = 0;

	constructor(
		protected readonly roots: readonly string[],
		private readonly tailOptions: JsonlTailOptions,
		private readonly replayHistory = false,
	) { }

	/**
	 * Set by adapters whose tool can append to a log without updating its modification time;
	 * on start, the last record's `timestamp` then also decides whether a file is imported.
	 */
	protected readonly mtimeMayLag: boolean = false;

	protected abstract listFiles(root: string): Promise<string[]>;
	protected abstract createParser(file: string): JsonlFileParser;

	protected sessionLabel(file: string): string {
		return path.basename(file, '.jsonl');
	}

	async isAvailable(): Promise<boolean> {
		for (const root of this.roots) {
			if (await isDirectory(root)) {
				return true;
			}
		}
		return false;
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}
		this.running = true;
		this.startedAt = Date.now();
		this.imported = 0;
		// Existing history becomes the baseline so restarts don't replay old requests.
		await this.enqueue(true);
		this.log(`tracking ${this.files.size} session file(s)`);
		if (this.tailOptions.importSince !== undefined) {
			this.log(`imported ${this.imported} update(s) since the previous run`);
		}
		const interval = this.tailOptions.pollIntervalMs ?? 1000;
		if (interval > 0 && this.running) {
			this.timer = setInterval(() => { void this.refresh(); }, interval);
		}
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.queue;
		this.files.clear();
	}

	/** Reads new session data and emits changed events. */
	refresh(): Promise<void> {
		if (!this.running) {
			return Promise.resolve();
		}
		// Polls that fire while a slow scan runs must not pile up and delay live events further.
		this.pendingRefresh ??= this.enqueue(false);
		return this.pendingRefresh;
	}

	onUsageEvent(callback: AiUsageEventListener): Disposable {
		this.listeners.add(callback);
		return { dispose: () => { this.listeners.delete(callback); } };
	}

	protected log(message: string): void {
		this.tailOptions.log?.(`[${this.id}] ${message}`);
	}

	private enqueue(baseline: boolean): Promise<void> {
		this.queue = this.queue.then(() => {
			if (!baseline) {
				this.pendingRefresh = undefined;
			}
			return this.scan(baseline);
		}).catch(error => {
			this.log(`scan failed: ${error instanceof Error && 'code' in error ? String(error.code) : 'error'}`);
		});
		return this.queue;
	}

	private async scan(baseline: boolean): Promise<void> {
		const seen = new Set<string>();
		for (const root of this.roots) {
			for (const file of await this.listFiles(root).catch((): string[] => [])) {
				// Stopping mid-scan (e.g. during a long import) abandons the rest.
				if (!this.running) {
					return;
				}
				seen.add(file);
				await this.readFile(file, baseline).catch(() => this.log(`could not read session ${this.sessionLabel(file)}`));
			}
		}
		for (const file of [...this.files.keys()].filter(f => !seen.has(f))) {
			// A listing can miss files transiently (locked or unreadable folder); forgetting them
			// would replay their whole history as new activity once they are listed again.
			if (await fs.stat(file).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')) {
				this.files.delete(file);
			}
		}
	}

	private newState(file: string, offset: number, skipPartialLine: boolean, emitted = new Map<string, string>()): FileState {
		const state: FileState = { parser: this.createParser(file), offset, rest: Buffer.alloc(0), skipPartialLine, emitted };
		this.files.set(file, state);
		return state;
	}

	private async skipToEnd(file: string, size: number, emitted?: Map<string, string>): Promise<void> {
		const lastByte = size > 0 ? await readRange(file, size - 1, size) : undefined;
		this.newState(file, size, lastByte !== undefined && lastByte[0] !== NEWLINE, emitted);
	}

	private async readFile(file: string, baseline: boolean): Promise<void> {
		const { size, mtimeMs } = await fs.stat(file);
		const state = this.files.get(file);
		if (!state) {
			return baseline ? this.readExisting(file, size, mtimeMs) : this.parse(file, this.newState(file, 0, false), size, { origin: 'live' });
		}
		if (size === state.offset) {
			return;
		}
		if (state.deferred) {
			return this.resumeDeferred(file, state.deferred, size);
		}
		const next = size > state.offset ? await readRange(file, state.offset, state.offset + 1) : undefined;
		// Appends start at a line boundary with `{`; anything else means the file was rewritten.
		const rewritten = !next || (!state.skipPartialLine && state.rest.length === 0 && next[0] !== OPEN_BRACE);
		if (!rewritten) {
			return this.parse(file, state, size, { origin: 'live' });
		}
		if (!this.replayHistory) {
			this.log(`session ${this.sessionLabel(file)} was rewritten; resuming at its end`);
			return this.skipToEnd(file, size, state.emitted);
		}
		// Replay from the start but keep emitted signatures so nothing is re-emitted.
		return this.parse(file, this.newState(file, 0, false, state.emitted), size, { origin: 'live' });
	}

	/** A file that existed when tracking started. */
	private async readExisting(file: string, size: number, mtimeMs: number): Promise<void> {
		const since = this.tailOptions.importSince;
		if (since !== undefined && (mtimeMs >= since || (this.mtimeMayLag && (await lastRecordTime(file, size) ?? 0) >= since))) {
			return this.parse(file, this.newState(file, 0, false), size, { origin: 'import', activeSince: since });
		}
		if (!this.replayHistory) {
			return this.skipToEnd(file, size);
		}
		if (mtimeMs >= this.startedAt - EAGER_REPLAY_MS) {
			return this.parse(file, this.newState(file, 0, false), size, undefined);
		}
		this.newState(file, size, false).deferred = { size, mtimeMs };
	}

	/** First change to a file whose history was not parsed yet. */
	private async resumeDeferred(file: string, deferred: { size: number; mtimeMs: number }, size: number): Promise<void> {
		const state = this.newState(file, 0, false);
		const edge = size > deferred.size && deferred.size > 0 ? await readRange(file, deferred.size - 1, deferred.size + 1) : undefined;
		const appended = size > deferred.size && (!edge || edge[0] !== NEWLINE || edge[1] === OPEN_BRACE);
		if (!appended) {
			// Rewritten before its history was known: report only requests active since it last changed.
			return this.parse(file, state, size, { origin: 'live', activeSince: deferred.mtimeMs });
		}
		// Content present at start is history; only what was appended after it is new.
		await this.parse(file, state, deferred.size, undefined);
		return this.parse(file, state, size, { origin: 'live' });
	}

	/** Parses `state` up to byte `end`, then emits (or just records) the changed events. */
	private async parse(file: string, state: FileState, end: number, emission: Emission | undefined): Promise<void> {
		const malformedBefore = state.parser.malformedLines;
		while (state.offset < end) {
			const chunk = await readRange(file, state.offset, Math.min(end, state.offset + CHUNK_BYTES));
			if (chunk.length === 0) {
				break;
			}
			state.offset += chunk.length;
			this.parseChunk(state, chunk);
			if (state.offset < end) {
				await yieldToEventLoop();
			}
		}
		const malformed = state.parser.malformedLines - malformedBefore;
		if (malformed > 0) {
			this.log(`skipped ${malformed} malformed line(s) in session ${this.sessionLabel(file)}`);
		}

		for (const event of state.parser.takeChanged()) {
			const signature = JSON.stringify(event);
			if (state.emitted.get(event.id) === signature) {
				continue;
			}
			state.emitted.set(event.id, signature);
			if (emission && (emission.activeSince === undefined || activeAt(event) >= emission.activeSince)) {
				if (emission.origin === 'import') {
					this.imported++;
				}
				this.emit(event, emission.origin);
			}
		}
	}

	private parseChunk(state: FileState, chunk: Buffer): void {
		let data = state.rest.length > 0 ? Buffer.concat([state.rest, chunk]) : chunk;
		if (state.skipPartialLine) {
			const first = data.indexOf(NEWLINE);
			if (first < 0) {
				state.rest = Buffer.alloc(0);
				return;
			}
			state.skipPartialLine = false;
			data = data.subarray(first + 1);
		}
		// Only complete lines are parsed; a partially written trailing line waits for the next read.
		const end = data.lastIndexOf(NEWLINE);
		// Copy the remainder so it does not pin the whole chunk in memory.
		state.rest = Buffer.from(end < 0 ? data : data.subarray(end + 1));
		if (end >= 0) {
			for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
				if (line.trim()) {
					state.parser.apply(line);
				}
			}
		}
	}

	private emit(event: AiUsageEvent, origin: UsageEventOrigin): void {
		for (const listener of [...this.listeners]) {
			try {
				listener(event, origin);
			} catch {
				// A failing subscriber must not stop tracking.
			}
		}
	}
}
