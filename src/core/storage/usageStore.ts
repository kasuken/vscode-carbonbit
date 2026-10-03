import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { Confidence, FactorLevel, TokenProvenance } from '../impact/confidence';
import type { AiProviderId, AiUsageSource, AiUsageStatus } from '../usage/usageEvent';

/** One stored request: only metadata needed for calculations, never prompts, responses, code or file names. */
export interface UsageRecord {
	id: string;
	provider: AiProviderId;
	model: string | null;
	/** Epoch milliseconds. */
	startedAt: number;
	completedAt: number | null;
	status: AiUsageStatus;
	source: AiUsageSource;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	cacheCreationTokens: number | null;
	energyWh: number | null;
	carbonGrams: number | null;
	waterLiters: number | null;
	confidence: Confidence | null;
	tokenProvenance: TokenProvenance | null;
	factorLevel: FactorLevel | null;
	methodologyVersion: string | null;
	updatedAt: number;
}

export interface UsageTotals {
	requests: number;
	/** Input + output + cache read + cache write tokens. */
	tokens: number;
	energyWh: number;
	carbonGrams: number;
	waterLiters: number;
}

/** Requests per token provenance; requests without token counts have no estimate and aren't counted. */
export type TokenProvenanceCounts = Record<TokenProvenance, number>;

export interface ModelSummary extends UsageTotals {
	model: string | null;
	/** Lowest confidence among the model's estimated requests. */
	confidence: Confidence | null;
	/** Least specific energy factor level among the model's estimated requests. */
	factorLevel: FactorLevel | null;
	tokenProvenance: TokenProvenanceCounts;
	/** Distinct methodology versions behind the model's estimates, sorted. */
	methodologyVersions: string[];
}

export interface ProviderShare {
	provider: AiProviderId;
	requests: number;
	tokens: number;
	/** Share of all tokens in the period, 0-100. */
	percent: number;
}

/** Thrown when the database was written by a newer CarbonBit; it is left untouched. */
export class NewerSchemaError extends Error {
	constructor(readonly version: number) {
		super(`database schema v${version} is newer than supported v${SCHEMA_VERSION}`);
		this.name = 'NewerSchemaError';
	}
}

const COLUMNS: Record<keyof UsageRecord, string> = {
	id: 'id',
	provider: 'provider',
	model: 'model',
	startedAt: 'started_at',
	completedAt: 'completed_at',
	status: 'status',
	source: 'source',
	inputTokens: 'input_tokens',
	outputTokens: 'output_tokens',
	cachedInputTokens: 'cached_input_tokens',
	cacheCreationTokens: 'cache_creation_tokens',
	energyWh: 'energy_wh',
	carbonGrams: 'carbon_grams',
	waterLiters: 'water_liters',
	confidence: 'confidence',
	tokenProvenance: 'token_provenance',
	factorLevel: 'factor_level',
	methodologyVersion: 'methodology_version',
	updatedAt: 'updated_at',
};

/** Migration `i` upgrades schema version `i` to `i + 1` (stored in `PRAGMA user_version`). */
export const MIGRATIONS: readonly string[] = [
	`CREATE TABLE usage_events (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		model TEXT,
		started_at INTEGER NOT NULL,
		completed_at INTEGER,
		status TEXT NOT NULL,
		source TEXT NOT NULL,
		input_tokens INTEGER,
		output_tokens INTEGER,
		cached_input_tokens INTEGER,
		cache_creation_tokens INTEGER,
		energy_wh REAL,
		carbon_grams REAL,
		water_liters REAL,
		confidence TEXT,
		token_provenance TEXT,
		factor_level TEXT,
		methodology_version TEXT,
		updated_at INTEGER NOT NULL
	);
	CREATE INDEX usage_events_started_at ON usage_events (started_at);`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function userVersion(db: DatabaseSync): number {
	return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
}

/** Applies pending migrations, each in its own transaction; safe if another window migrates concurrently. */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): void {
	for (; ;) {
		db.exec('BEGIN IMMEDIATE');
		try {
			const version = userVersion(db);
			if (version > migrations.length) {
				throw new NewerSchemaError(version);
			}
			if (version === migrations.length) {
				db.exec('COMMIT');
				return;
			}
			db.exec(migrations[version]);
			db.exec(`PRAGMA user_version = ${version + 1}`);
			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	}
}

const FIELDS = Object.keys(COLUMNS) as (keyof UsageRecord)[];
const TOKENS_SQL = 'COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) + COALESCE(cached_input_tokens, 0) + COALESCE(cache_creation_tokens, 0)';
const TOTALS_SQL = `COUNT(*) AS requests, COALESCE(SUM(${TOKENS_SQL}), 0) AS tokens,
	COALESCE(SUM(energy_wh), 0) AS energyWh, COALESCE(SUM(carbon_grams), 0) AS carbonGrams,
	COALESCE(SUM(water_liters), 0) AS waterLiters`;
const IN_RANGE = 'WHERE started_at >= ? AND started_at < ?';
const CONFIDENCE_RANK: readonly Confidence[] = ['low', 'medium', 'high'];
const FACTOR_RANK: readonly FactorLevel[] = ['model', 'family', 'class', 'generic'];
const countOf = (value: unknown) => Number(value ?? 0);

type Row = Record<string, unknown>;

function totalsOf(row: Row | undefined): UsageTotals {
	return {
		requests: Number(row?.requests ?? 0),
		tokens: Number(row?.tokens ?? 0),
		energyWh: Number(row?.energyWh ?? 0),
		carbonGrams: Number(row?.carbonGrams ?? 0),
		waterLiters: Number(row?.waterLiters ?? 0),
	};
}

/** Synchronous SQLite-backed usage store; ranges are `[from, to)` on `startedAt` (epoch ms). */
export class UsageStore {
	private readonly upsertStmt: StatementSync;
	private readonly getStmt: StatementSync;
	private readonly totalsStmt: StatementSync;
	private readonly modelsStmt: StatementSync;
	private readonly providersStmt: StatementSync;
	private readonly pruneStmt: StatementSync;
	private readonly firstStmt: StatementSync;
	private readonly bucketsStmt: StatementSync;
	private closed = false;

	constructor(private readonly db: DatabaseSync) {
		const cols = FIELDS.map(f => COLUMNS[f]);
		this.upsertStmt = db.prepare(`INSERT INTO usage_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
			ON CONFLICT (id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ')}`);
		this.getStmt = db.prepare(`SELECT ${FIELDS.map(f => `${COLUMNS[f]} AS ${f}`).join(', ')} FROM usage_events WHERE id = ?`);
		this.totalsStmt = db.prepare(`SELECT ${TOTALS_SQL} FROM usage_events ${IN_RANGE}`);
		this.modelsStmt = db.prepare(`SELECT model, ${TOTALS_SQL},
			MIN(CASE confidence WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 END) AS confidenceRank,
			MAX(CASE factor_level WHEN 'model' THEN 0 WHEN 'family' THEN 1 WHEN 'class' THEN 2 WHEN 'generic' THEN 3 END) AS factorRank,
			SUM(token_provenance = 'actual') AS actualRequests, SUM(token_provenance = 'partial') AS partialRequests,
			SUM(token_provenance = 'estimated') AS estimatedRequests, GROUP_CONCAT(DISTINCT methodology_version) AS methodologyVersions
			FROM usage_events ${IN_RANGE} GROUP BY model ORDER BY tokens DESC, model`);
		this.providersStmt = db.prepare(`SELECT provider, COUNT(*) AS requests, COALESCE(SUM(${TOKENS_SQL}), 0) AS tokens
			FROM usage_events ${IN_RANGE} GROUP BY provider ORDER BY tokens DESC, provider`);
		this.pruneStmt = db.prepare('DELETE FROM usage_events WHERE started_at < ?');
		this.firstStmt = db.prepare(`SELECT MIN(started_at) AS first FROM usage_events ${IN_RANGE}`);
		this.bucketsStmt = db.prepare(`SELECT CAST((started_at - ?) / ? AS INTEGER) AS bucket, ${TOTALS_SQL}
			FROM usage_events ${IN_RANGE} GROUP BY bucket ORDER BY bucket`);
	}

	get(id: string): UsageRecord | undefined {
		return this.getStmt.get(id) as UsageRecord | undefined;
	}

	upsert(record: UsageRecord): void {
		this.upsertStmt.run(...FIELDS.map(f => record[f]));
	}

	totals(from: number, to: number): UsageTotals {
		return totalsOf(this.totalsStmt.get(from, to));
	}

	byModel(from: number, to: number): ModelSummary[] {
		return (this.modelsStmt.all(from, to) as Row[]).map(row => ({
			model: (row.model as string | null) ?? null,
			...totalsOf(row),
			confidence: row.confidenceRank === null ? null : CONFIDENCE_RANK[Number(row.confidenceRank)],
			factorLevel: row.factorRank === null ? null : FACTOR_RANK[Number(row.factorRank)],
			tokenProvenance: { actual: countOf(row.actualRequests), partial: countOf(row.partialRequests), estimated: countOf(row.estimatedRequests) },
			methodologyVersions: typeof row.methodologyVersions === 'string' ? row.methodologyVersions.split(',').sort() : [],
		}));
	}

	byProvider(from: number, to: number): ProviderShare[] {
		const rows = this.providersStmt.all(from, to) as Row[];
		const total = rows.reduce((sum, row) => sum + Number(row.tokens), 0);
		return rows.map(row => ({
			provider: row.provider as AiProviderId,
			requests: Number(row.requests),
			tokens: Number(row.tokens),
			percent: total > 0 ? (Number(row.tokens) / total) * 100 : 0,
		}));
	}

	/** Start of the earliest request in the range, or `null` when it is empty. */
	firstStartedAt(from: number, to: number): number | null {
		const row = this.firstStmt.get(from, to) as Row | undefined;
		return row?.first === null || row?.first === undefined ? null : Number(row.first);
	}

	/** Totals per `bucketMs`-wide slice of [from, to); index 0 starts at `from`. Empty slices are zero. */
	buckets(from: number, to: number, bucketMs: number): UsageTotals[] {
		const count = Math.max(0, Math.ceil((to - from) / bucketMs));
		const result = Array.from({ length: count }, () => totalsOf(undefined));
		for (const row of this.bucketsStmt.all(from, bucketMs, from, to) as Row[]) {
			const index = Number(row.bucket);
			if (index >= 0 && index < count) {
				result[index] = totalsOf(row);
			}
		}
		return result;
	}

	/** Deletes requests started before `cutoff`; returns how many were removed. */
	deleteStartedBefore(cutoff: number): number {
		return Number(this.pruneStmt.run(cutoff).changes);
	}

	/** Removes every usage row and compacts the file so deleted data doesn't linger on disk. */
	clear(): void {
		this.db.exec('DELETE FROM usage_events');
		this.db.exec('VACUUM');
		this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	}

	close(): void {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}
}
