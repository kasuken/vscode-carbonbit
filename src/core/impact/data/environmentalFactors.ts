/**
 * Versioned environmental factors and methodology metadata (PRD §13-17). The only place
 * environmental values live; see docs/METHODOLOGY.md. Every value cites `sources` and lists its
 * assumptions. No published per-token measurement exists for the models CarbonBit sees, so the
 * `models` and `families` tables are intentionally empty and estimates use class/generic factors.
 */

export interface FactorSource {
	title: string;
	author: string;
	year: number;
	url: string;
	usedFor: string;
}

export interface Provenance {
	sources: string[];
	assumptions: string[];
	limitations: string[];
}

export interface EnergyFactor extends Provenance {
	label: string;
	/** Facility-level energy per token, data-center overhead included (Wh). */
	whPerInputToken: number;
	whPerOutputToken: number;
}

/** Everyday comparisons shown next to CO₂e and water figures (PRD §16). Ids drive the webview icons. */
export const CARBON_EQUIVALENT_IDS = ['car', 'train', 'flight', 'kettle', 'phone', 'led'] as const;
export type CarbonEquivalentId = (typeof CARBON_EQUIVALENT_IDS)[number];
export const WATER_EQUIVALENT_IDS = ['tea', 'shower', 'laundry', 'bath', 'dishwasher', 'drinking'] as const;
export type WaterEquivalentId = (typeof WATER_EQUIVALENT_IDS)[number];

export interface EquivalentFactor extends Provenance {
	/** Unit text for exactly one unit and for any other amount, e.g. 'kettle boil' / 'kettle boils'. */
	one: string;
	other: string;
	/**
	 * What one unit is worth. Household-energy comparisons are energy-based, so they hold under the
	 * same grid intensity CarbonBit applies to AI energy and stay consistent with it.
	 */
	basis: 'carbonGrams' | 'energyWh' | 'waterLiters';
	perUnit: number;
}

export interface EnvironmentalFactorData {
	methodology: { id: string; version: string; effectiveDate: string; summary: string };
	sources: Record<string, FactorSource>;
	/** Energy weight of cache tokens relative to a regular input token. */
	tokenWeights: Provenance & { cachedInput: number; cacheCreation: number };
	energy: {
		models: Record<string, EnergyFactor>;
		families: Record<string, EnergyFactor>;
		classes: Record<'small' | 'medium' | 'frontier', EnergyFactor>;
		generic: EnergyFactor;
	};
	carbonIntensity: Provenance & { label: string; gramsCo2ePerKWh: number };
	waterIntensity: Provenance & { label: string; litersPerKWh: number };
	equivalents: {
		carbon: Record<CarbonEquivalentId, EquivalentFactor>;
		water: Record<WaterEquivalentId, EquivalentFactor>;
	};
}

const ANCHOR_ASSUMPTIONS = [
	'Output-token energy anchored to ~0.3 Wh for a typical query with ~500 output tokens (epoch-2025): 0.0006 Wh per output token.',
	'Input (prefill) tokens assumed to cost 1/4 of an output token, mirroring the common ~4:1 output:input API price ratio; this is a proxy, not a measurement.',
];

const ANCHOR_LIMITATIONS = [
	'Not a measurement of any specific model, provider or data center.',
	'Real energy varies with hardware, batching, utilization, context length and reasoning tokens.',
];

export const ENVIRONMENTAL_FACTORS: EnvironmentalFactorData = {
	methodology: {
		id: 'carbonbit-impact',
		version: '1.1.0',
		effectiveDate: '2026-10-03',
		summary: 'Token-based inference estimate: weighted tokens x energy factor; energy x generic grid carbon intensity; energy x generic on-site water intensity.',
	},
	sources: {
		'epoch-2025': {
			title: 'How much energy does ChatGPT use?',
			author: 'Josh You, Epoch AI (Gradient Updates)',
			year: 2025,
			url: 'https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use',
			usedFor: 'Order-of-magnitude anchor: ~0.3 Wh for a typical GPT-4o query (~500 output tokens).',
		},
		'google-2025': {
			title: 'Measuring the environmental impact of delivering AI at Google Scale',
			author: 'Elsner et al., Google',
			year: 2025,
			url: 'https://arxiv.org/abs/2508.15734',
			usedFor: 'Median Gemini Apps text prompt: 0.24 Wh and 0.26 mL water; water intensity derived from their ratio.',
		},
		'ember-2024': {
			title: 'Global Electricity Review 2024',
			author: 'Ember',
			year: 2024,
			url: 'https://ember-energy.org/latest-insights/global-electricity-review-2024/',
			usedFor: 'Global average power-sector emissions intensity (~480 g CO2 per kWh, 2023).',
		},
		'desnz-2025': {
			title: 'Greenhouse gas reporting: conversion factors 2025',
			author: 'UK Department for Energy Security and Net Zero',
			year: 2025,
			url: 'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2025',
			usedFor: 'Everyday comparisons: petrol car, national rail and short-haul flight emissions per km.',
		},
		'ec-kettles-2020': {
			title: 'Preparatory study for kettles (Ecodesign), Task 3: Users',
			author: 'European Commission DG ENER (Fraunhofer ISI, VITO)',
			year: 2020,
			url: 'https://www.energimyndigheten.se/globalassets/energieffektivisering_/lagar-och-krav/ekodesign--energimarkning/ecodesign_kettles_task_3_20201218_v27_final.pdf',
			usedFor: 'Everyday comparison: about 0.12 kWh to boil 1 litre in a kettle.',
		},
		'epa-equivalencies': {
			title: 'Greenhouse Gas Equivalencies Calculator: Calculations and References',
			author: 'US Environmental Protection Agency',
			year: 2026,
			url: 'https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references',
			usedFor: 'Everyday comparison: about 0.019 kWh per smartphone charge.',
		},
		'epa-watersense-2010': {
			title: 'WaterSense Specification for Showerheads: Supporting Statement',
			author: 'US Environmental Protection Agency WaterSense',
			year: 2010,
			url: 'https://www.epa.gov/sites/default/files/2017-01/documents/ws-products-support-statement-showerheads.pdf',
			usedFor: 'Everyday comparison: average shower flow of 2.22 gallons (8.4 L) per minute.',
		},
		'ccw-water-use': {
			title: 'How much water do you use?',
			author: 'Consumer Council for Water (CCW)',
			year: 2024,
			url: 'https://www.ccw.org.uk/save-money-and-water/averagewateruse/',
			usedFor: 'Everyday comparisons: washing machine load, full bath and dishwasher cycle.',
		},
		'efsa-water-2010': {
			title: 'EFSA sets European dietary reference values for water intake',
			author: 'European Food Safety Authority',
			year: 2010,
			url: 'https://www.efsa.europa.eu/en/press/news/nda100326',
			usedFor: 'Everyday comparison: about 2 L of water per adult per day.',
		},
	},
	tokenWeights: {
		cachedInput: 0.1,
		cacheCreation: 1,
		sources: [],
		assumptions: [
			'Cache reads skip most prefill compute; weighted at 0.1 of an input token (CarbonBit assumption, similar to typical cache-read price discounts).',
			'Cache writes are processed like regular input tokens (weight 1).',
		],
		limitations: ['No published per-token energy measurement for prompt caching.'],
	},
	energy: {
		models: {},
		families: {},
		classes: {
			small: {
				label: 'Model-class estimate (small)',
				whPerInputToken: 0.0000375,
				whPerOutputToken: 0.00015,
				sources: ['epoch-2025'],
				assumptions: [...ANCHOR_ASSUMPTIONS, 'Small-class models assumed to use 0.25x the medium-class energy (CarbonBit assumption).'],
				limitations: ANCHOR_LIMITATIONS,
			},
			medium: {
				label: 'Model-class estimate (medium)',
				whPerInputToken: 0.00015,
				whPerOutputToken: 0.0006,
				sources: ['epoch-2025', 'google-2025'],
				assumptions: [...ANCHOR_ASSUMPTIONS, 'Medium-class models use the anchor values directly; google-2025 (0.24 Wh median prompt) corroborates the order of magnitude.'],
				limitations: ANCHOR_LIMITATIONS,
			},
			frontier: {
				label: 'Model-class estimate (frontier)',
				whPerInputToken: 0.00045,
				whPerOutputToken: 0.0018,
				sources: ['epoch-2025'],
				assumptions: [...ANCHOR_ASSUMPTIONS, 'Frontier-class models assumed to use 3x the medium-class energy (CarbonBit assumption).'],
				limitations: ANCHOR_LIMITATIONS,
			},
		},
		generic: {
			label: 'Generic inference estimate',
			whPerInputToken: 0.00015,
			whPerOutputToken: 0.0006,
			sources: ['epoch-2025'],
			assumptions: [...ANCHOR_ASSUMPTIONS, 'Generic fallback for unrecognized models: medium-class anchor values.'],
			limitations: [...ANCHOR_LIMITATIONS, 'Model not recognized; size of the model is unknown.'],
		},
	},
	carbonIntensity: {
		label: 'Generic infrastructure estimate (global average grid)',
		gramsCo2ePerKWh: 480,
		sources: ['ember-2024'],
		assumptions: ['Location-based global average; reported CO2 intensity treated as CO2e.', 'Applies to all providers and regions.'],
		limitations: ['Ignores provider renewable-energy purchases, region and time of day.', 'Excludes embodied hardware and training emissions.'],
	},
	waterIntensity: {
		label: 'Generic data-center cooling estimate (on-site water)',
		litersPerKWh: 1.1,
		sources: ['google-2025'],
		assumptions: ['0.26 mL / 0.24 Wh from google-2025, rounded to 1.1 L per kWh.'],
		limitations: ['On-site cooling water only; excludes water used for electricity generation.', 'One provider\'s fleet average applied to all providers.'],
	},
	equivalents: {
		carbon: {
			car: {
				one: 'km driving (petrol car)',
				other: 'km driving (petrol car)',
				basis: 'carbonGrams',
				perUnit: 162.72,
				sources: ['desnz-2025'],
				assumptions: ['UK average petrol car, per vehicle-km, tailpipe emissions (162.72 g CO2e/km).'],
				limitations: ['Excludes fuel production (well-to-tank, about +46 g/km) and car manufacturing.'],
			},
			train: {
				one: 'km by train',
				other: 'km by train',
				basis: 'carbonGrams',
				perUnit: 35.46,
				sources: ['desnz-2025'],
				assumptions: ['UK national rail, per passenger-km (35.46 g CO2e/km), diesel and electric mix.'],
				limitations: ['Electrified high-speed rail elsewhere in Europe can be several times lower.'],
			},
			flight: {
				one: 'km flying (economy, short-haul)',
				other: 'km flying (economy, short-haul)',
				basis: 'carbonGrams',
				perUnit: 125.76,
				sources: ['desnz-2025'],
				assumptions: ['Short-haul economy flight, per passenger-km, including radiative forcing (125.76 g CO2e/km; 74.35 without).'],
				limitations: ['Excludes fuel production (well-to-tank). Domestic flights have higher per-km emissions.'],
			},
			kettle: {
				one: 'kettle boil',
				other: 'kettle boils',
				basis: 'energyWh',
				perUnit: 120,
				sources: ['ec-kettles-2020'],
				assumptions: ['Boiling 1 litre uses about 0.12 kWh; compared by energy, so the same grid intensity applies to both sides.'],
				limitations: ['Real boils vary with the amount of water and the kettle.'],
			},
			phone: {
				one: 'smartphone charge',
				other: 'smartphone charges',
				basis: 'energyWh',
				perUnit: 19,
				sources: ['epa-equivalencies'],
				assumptions: ['One full charge uses about 19 Wh including standby while plugged in; compared by energy.'],
				limitations: ['Battery sizes and charger efficiency vary widely.'],
			},
			led: {
				one: 'hour of a 10 W LED bulb',
				other: 'hours of a 10 W LED bulb',
				basis: 'energyWh',
				perUnit: 10,
				sources: [],
				assumptions: ['Defined as a 10 W bulb lit for one hour (10 Wh), about the draw of an LED replacing a 60 W incandescent bulb; compared by energy.'],
				limitations: ['Illustrative; LED bulbs range from a few watts to over 15 W.'],
			},
		},
		water: {
			tea: {
				one: 'mug of tea or coffee',
				other: 'mugs of tea or coffee',
				basis: 'waterLiters',
				perUnit: 0.25,
				sources: [],
				assumptions: ['A mug holds about 250 ml (CarbonBit assumption).'],
				limitations: ['Illustrative; counts the water in the mug only.'],
			},
			shower: {
				one: 'minute of showering',
				other: 'minutes of showering',
				basis: 'waterLiters',
				perUnit: 8.4,
				sources: ['epa-watersense-2010'],
				assumptions: ['Average measured shower flow of 2.22 gallons (8.4 L) per minute.'],
				limitations: ['Showers range from about 6 L/min (electric) to 15 L/min (power showers).'],
			},
			laundry: {
				one: 'washing machine load',
				other: 'washing machine loads',
				basis: 'waterLiters',
				perUnit: 50,
				sources: ['ccw-water-use'],
				assumptions: ['A normal load in a modern machine uses about 50 L.'],
				limitations: ['Eco programmes use about 35 L; older machines use more.'],
			},
			bath: {
				one: 'full bath',
				other: 'full baths',
				basis: 'waterLiters',
				perUnit: 80,
				sources: ['ccw-water-use'],
				assumptions: ['A full bath holds about 80 L.'],
				limitations: ['Bath sizes and fill levels vary.'],
			},
			dishwasher: {
				one: 'dishwasher cycle',
				other: 'dishwasher cycles',
				basis: 'waterLiters',
				perUnit: 14,
				sources: ['ccw-water-use'],
				assumptions: ['A standard programme in a modern dishwasher uses about 14 L.'],
				limitations: ['Eco programmes use about 10 L.'],
			},
			drinking: {
				one: 'day of drinking water',
				other: 'days of drinking water',
				basis: 'waterLiters',
				perUnit: 2,
				sources: ['efsa-water-2010'],
				assumptions: ['An adult needs about 2 L of water a day.'],
				limitations: ['EFSA gives 2.0 L (women) and 2.5 L (men) of total water, including water from food.'],
			},
		},
	},
};
