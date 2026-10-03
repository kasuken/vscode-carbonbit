import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { migrate, MIGRATIONS, NewerSchemaError, UsageStore } from './usageStore';

export const DATABASE_FILE_NAME = 'carbonbit.db';

type SqliteModule = typeof import('node:sqlite');

export interface OpenUsageStoreOptions {
	/** Database file; `undefined` opens an in-memory database. */
	file?: string;
	now?: () => number;
	log?: (message: string) => void;
	/** Test seam for runtimes without `node:sqlite`. */
	loadSqlite?: () => SqliteModule | undefined;
	migrations?: readonly string[];
}

export interface OpenedUsageStore {
	/** `undefined` only when SQLite is unavailable in this runtime. */
	store: UsageStore | undefined;
	/** `false` when usage only lives in memory for this session. */
	persistent: boolean;
	/** User-facing explanation when storage is degraded. */
	warning?: string;
}

// Built-in since Node 22.13 (the VS Code ^1.138 extension host); no native module to package.
export function loadNodeSqlite(): SqliteModule | undefined {
	try {
		return process.getBuiltinModule('node:sqlite');
	} catch {
		return undefined;
	}
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : '';
		return `${code}${error.message}`;
	}
	return 'unknown error';
}

function openDatabase(sqlite: SqliteModule, location: string, migrations: readonly string[]): UsageStore {
	const db: DatabaseSync = new sqlite.DatabaseSync(location);
	try {
		// Several VS Code windows may share the file.
		db.exec('PRAGMA busy_timeout = 3000');
		if (location !== ':memory:') {
			db.exec('PRAGMA journal_mode = WAL');
		}
		const check = db.prepare('PRAGMA quick_check').get();
		if (check?.quick_check !== 'ok') {
			throw new Error('integrity check failed');
		}
		migrate(db, migrations);
		return new UsageStore(db);
	} catch (error) {
		db.close();
		throw error;
	}
}

/** Moves an unreadable database (and its WAL files) aside so a fresh one can be created. */
function backUpCorruptFile(file: string, now: number): string {
	const backup = `${file}.corrupt-${now}`;
	for (const suffix of ['', '-wal', '-shm']) {
		if (fs.existsSync(file + suffix)) {
			fs.renameSync(file + suffix, backup + suffix);
		}
	}
	return backup;
}

/**
 * Opens the usage database without ever throwing: a corrupt file is backed up and recreated;
 * if that fails (or the schema is newer) usage is kept in memory for this session instead.
 */
export function openUsageStore(options: OpenUsageStoreOptions = {}): OpenedUsageStore {
	const { file, now = Date.now, log = () => { }, migrations = MIGRATIONS } = options;
	const sqlite = (options.loadSqlite ?? loadNodeSqlite)();
	if (!sqlite) {
		const warning = 'CarbonBit: SQLite is not available in this VS Code version; usage history is disabled.';
		log(warning);
		return { store: undefined, persistent: false, warning };
	}

	if (file) {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			return { store: openDatabase(sqlite, file, migrations), persistent: true };
		} catch (error) {
			log(`storage: open failed (${describe(error)})`);
			if (!(error instanceof NewerSchemaError)) {
				try {
					const backup = backUpCorruptFile(file, now());
					log(`storage: unreadable database moved to ${path.basename(backup)}`);
					return {
						store: openDatabase(sqlite, file, migrations),
						persistent: true,
						warning: 'CarbonBit: the local usage database was unreadable and has been reset. A backup was kept.',
					};
				} catch (retryError) {
					log(`storage: recreate failed (${describe(retryError)})`);
				}
			}
		}
	}

	try {
		return {
			store: openDatabase(sqlite, ':memory:', migrations),
			persistent: false,
			warning: file ? 'CarbonBit: the local usage database could not be opened; usage is kept in memory for this session only.' : undefined,
		};
	} catch (error) {
		log(`storage: in-memory database failed (${describe(error)})`);
		return { store: undefined, persistent: false, warning: 'CarbonBit: usage history is unavailable.' };
	}
}
