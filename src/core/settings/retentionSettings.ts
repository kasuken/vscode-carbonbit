/** Allowed `carbonbit.dataRetentionDays` values (PRD §44); 0 keeps data forever. */
export const RETENTION_DAY_OPTIONS = [7, 30, 90, 365, 0] as const;
export const DEFAULT_RETENTION_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeRetentionDays(value: unknown): number {
	return (RETENTION_DAY_OPTIONS as readonly unknown[]).includes(value) ? value as number : DEFAULT_RETENTION_DAYS;
}

/** Requests started before this instant are expired; `undefined` for unlimited retention. */
export function retentionCutoff(now: number, retentionDays: number): number | undefined {
	return retentionDays > 0 ? now - retentionDays * DAY_MS : undefined;
}
