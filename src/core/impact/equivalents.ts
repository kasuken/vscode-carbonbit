import {
	CARBON_EQUIVALENT_IDS,
	type CarbonEquivalentId,
	ENVIRONMENTAL_FACTORS,
	type EnvironmentalFactorData,
	type EquivalentFactor,
	WATER_EQUIVALENT_IDS,
	type WaterEquivalentId,
} from './data/environmentalFactors';
import { formatAmount } from './units';

export interface EquivalentAmount<Id extends string> {
	id: Id;
	amount: number;
	/** Display amount, see `formatAmount`. */
	amountText: string;
	/** Unit text agreeing with the displayed amount. */
	unit: string;
}

export interface Equivalents {
	carbon: EquivalentAmount<CarbonEquivalentId>[];
	water: EquivalentAmount<WaterEquivalentId>[];
}

export interface EquivalentBasis {
	energyWh: number;
	carbonGrams: number;
	waterLiters: number;
}

function amountOf<Id extends string>(id: Id, factor: EquivalentFactor, basis: EquivalentBasis): EquivalentAmount<Id> {
	const value = basis[factor.basis];
	const amount = Number.isFinite(value) && value > 0 && factor.perUnit > 0 ? value / factor.perUnit : 0;
	const amountText = formatAmount(amount);
	return { id, amount, amountText, unit: amountText === '1' ? factor.one : factor.other };
}

/** Everyday comparisons for a set of totals, in the order of the factor id lists. */
export function equivalentsOf(basis: EquivalentBasis, data: EnvironmentalFactorData = ENVIRONMENTAL_FACTORS): Equivalents {
	return {
		carbon: CARBON_EQUIVALENT_IDS.map(id => amountOf(id, data.equivalents.carbon[id], basis)),
		water: WATER_EQUIVALENT_IDS.map(id => amountOf(id, data.equivalents.water[id], basis)),
	};
}
