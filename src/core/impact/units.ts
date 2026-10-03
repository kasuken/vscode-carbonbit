/** Display conversions (PRD §16). Pure, so the webview can mirror it later. */

export interface FormattedMetric {
	value: string;
	unit: string;
	text: string;
}

/** A displayed value that would round to this (or more) switches to the larger unit. */
export const ENERGY_KWH_THRESHOLD_WH = 1000;
export const CARBON_KG_THRESHOLD_G = 1000;
export const WATER_L_THRESHOLD_ML = 1000;

/** Smallest non-zero value shown; anything below reads as `<0.01`. */
export const MIN_DISPLAY = 0.01;

function round(value: number): number {
	if (value >= 100) {
		return Math.round(value);
	}
	if (value >= 1) {
		return Number(value.toFixed(value >= 10 ? 1 : 2));
	}
	return Number(value.toPrecision(2));
}

function formatValue(value: number): string {
	if (!Number.isFinite(value) || value <= 0) {
		return '0';
	}
	return value < MIN_DISPLAY ? `<${MIN_DISPLAY}` : groupThousands(String(round(value)));
}

// Values this large only occur in the biggest unit (kWh, kg, L), which has nothing larger to switch to.
function groupThousands(text: string): string {
	return text.replace(/^\d{4,}/, digits => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
}

function scaled(value: number, threshold: number, small: string, large: string): FormattedMetric {
	const safe = Number.isFinite(value) && value > 0 ? value : 0;
	const [shown, unit] = round(safe) >= threshold ? [safe / threshold, large] : [safe, small];
	const text = formatValue(shown);
	return { value: text, unit, text: `${text} ${unit}` };
}

export function formatEnergy(wh: number): FormattedMetric {
	return scaled(wh, ENERGY_KWH_THRESHOLD_WH, 'Wh', 'kWh');
}

export function formatCarbon(grams: number): FormattedMetric {
	return scaled(grams, CARBON_KG_THRESHOLD_G, 'g CO₂e', 'kg CO₂e');
}

export function formatWater(liters: number): FormattedMetric {
	return scaled(liters * 1000, WATER_L_THRESHOLD_ML, 'ml', 'L');
}

/** Compact token count: `950`, `1.2K`, `124K`, `1.2M`. */
export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) {
		return '0';
	}
	if (tokens < 999.5) {
		return String(Math.round(tokens));
	}
	const steps: [number, string][] = [[1e3, 'K'], [1e6, 'M'], [1e9, 'B']];
	for (const [divisor, suffix] of steps) {
		const value = tokens / divisor;
		if (value < 999.5 || suffix === 'B') {
			return `${value < 9.95 ? String(Number(value.toFixed(1))) : String(Math.round(value))}${suffix}`;
		}
	}
	return '0';
}

/**
 * Everyday-comparison amounts: about three significant digits, grouped thousands
 * (`0.775`, `6.97`, `231`, `1,386`); anything below 0.01 reads as `<0.01`.
 */
export function formatAmount(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) {
		return '0';
	}
	if (amount < MIN_DISPLAY) {
		return `<${MIN_DISPLAY}`;
	}
	if (amount >= 999.5) {
		return groupThousands(String(Math.round(amount)));
	}
	return String(Number(amount.toPrecision(3)));
}
