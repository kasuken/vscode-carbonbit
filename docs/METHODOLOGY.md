# CarbonBit Environmental Methodology

**Methodology:** `carbonbit-impact` **version 1.1.0**, effective 2026-10-03.
Data: [src/core/impact/data/environmentalFactors.ts](../src/core/impact/data/environmentalFactors.ts) (factors, sources, assumptions) and [src/core/impact/data/modelAliases.ts](../src/core/impact/data/modelAliases.ts) (model aliases and visualization classes).

All CarbonBit numbers are **estimates**, not measurements. Every estimate carries a confidence level and an explanation.

## Token counts (PRD §11)

CarbonBit prefers token counts reported in each provider's local session log (**actual**). When a finished request
has none, it estimates them from text length at ~4 characters per token (**estimated**); a request missing only its
input or output count is **partial**. The text itself is measured in memory and never stored. Per-provider sourcing,
log locations and checked versions are in the [README](../README.md#supported-tools).

## Formula

```text
weightedInput = inputTokens + cachedInputTokens × 0.1 + cacheCreationTokens × 1
energyWh      = weightedInput × whPerInputToken + outputTokens × whPerOutputToken
carbonGrams   = energyWh / 1000 × 480 g CO₂e/kWh
waterLiters   = energyWh / 1000 × 1.1 L/kWh
```

- `cachedInputTokens` and `cacheCreationTokens` are not part of `inputTokens`.
- A missing input or output count counts as 0 and lowers confidence. Events with no token counts get no estimate.
- Failed or cancelled requests are still estimated when they report usage.

## Energy factors (Wh per token, data-center overhead included)

| Level | Input | Output | Basis |
| --- | --- | --- | --- |
| Class: small | 0.0000375 | 0.00015 | medium × 0.25 (assumption) |
| Class: medium | 0.00015 | 0.0006 | anchor |
| Class: frontier | 0.00045 | 0.0018 | medium × 3 (assumption) |
| Generic fallback | 0.00015 | 0.0006 | anchor, model unknown |

The anchor uses ~0.3 Wh for a typical query with ~500 output tokens [epoch-2025], so 0.0006 Wh per output token. Input tokens are assumed to cost 1/4 of an output token, following the usual ~4:1 output:input API price ratio. This ratio is an assumption, not a measurement. Google's median of 0.24 Wh per Gemini Apps text prompt [google-2025] is in the same range.

The tables for specific models and model families are empty in v1.1.0. We did not find published per-token measurements for the models CarbonBit sees, so in practice estimates top out at **medium** confidence.

## Carbon and water

- **Carbon intensity:** 480 g CO₂e/kWh, the global average for the power sector in 2023 [ember-2024]. It is location-based and does not account for renewable-energy purchases, region or time of day. The reported CO₂ figure is treated as CO₂e.
- **Water:** 1.1 L/kWh, from 0.26 mL ÷ 0.24 Wh [google-2025]. This covers on-site cooling water only and excludes water used to generate the electricity.
- Training and embodied hardware emissions are not included.

## Periods and projection (PRD §16)

The footprint is shown for four periods:

| Period | Range |
| --- | --- |
| Today | Since local midnight. |
| Last 30 days | The rolling 30 × 24 hours before now. |
| Previous month | The whole previous calendar month (local time). |
| Projected year | Last 30 days ÷ days of recorded usage in them × 365. |

The projection divides by the days CarbonBit actually has data for: from the first request in the window until now, at least 1 and at most 30. This keeps a fresh install from looking smaller than it is. It is an extrapolation of recent usage, not a forecast, and the UI says how many days it is based on.

## Everyday comparisons (v1.1.0)

Each CO₂e and water figure comes with comparisons of about the same size. They put the number in context and carry the same uncertainty as the estimate itself. Transport comparisons use CO₂e directly. Household devices are compared by **energy**, so the comparison holds under the same grid intensity CarbonBit applies to AI energy. Water comparisons use litres.

| Comparison | One unit equals | Source |
| --- | --- | --- |
| km driving (petrol car) | 162.72 g CO₂e | [desnz-2025], UK average petrol car, tailpipe only |
| km by train | 35.46 g CO₂e | [desnz-2025], UK national rail per passenger-km |
| km flying (economy, short-haul) | 125.76 g CO₂e | [desnz-2025], including radiative forcing (74.35 without) |
| Kettle boil | 120 Wh | [ec-kettles-2020], about 0.12 kWh per litre |
| Smartphone charge | 19 Wh | [epa-equivalencies] |
| Hour of a 10 W LED bulb | 10 Wh | By definition |
| Mug of tea or coffee | 0.25 L | CarbonBit assumption |
| Minute of showering | 8.4 L | [epa-watersense-2010], average measured flow |
| Washing machine load | 50 L | [ccw-water-use] |
| Full bath | 80 L | [ccw-water-use] |
| Dishwasher cycle | 14 L | [ccw-water-use] |
| Day of drinking water | 2 L | [efsa-water-2010] |

The transport factors exclude fuel production (well-to-tank). Car, rail and water figures are UK or EU averages; shower and phone figures come from US sources. Comparisons display about three significant digits.

## Confidence (PRD §14, §17)

The factor level sets the starting confidence: model = high, family = medium, class = medium, generic = low. If token counts are estimated or partial, confidence drops one step (high → medium → low).

Each estimate lists reasons for: token usage, model match, energy model, carbon intensity and water.

## Assumptions and limitations (summary)

- Per-token energy is inferred from per-query figures; the 4:1 output:input ratio and the small/frontier multipliers are assumptions.
- One global, location-based grid intensity and one on-site water factor apply to every provider and region.
- Provider-side caching, batching, hardware and data-center efficiency are unknown and not modelled beyond the cache-read discount.
- Training, embodied hardware and the user's own device energy are excluded.
- Each stored request keeps the methodology version used, so figures stay reproducible when factors change.

## Model mapping (PRD §47-48)

Names are matched without regard to case. Vendor prefixes (`copilot/`) and snapshot suffixes (`-2025-04-14`, `-20241022`, `-latest`) are removed first. CarbonBit then tries, in order: an alias, a canonical model, an ordered family pattern, and finally the `unknown` fallback. Unknown names are kept and tracked. Model classes (small/medium/frontier/unknown) are a visualization abstraction, not a scientific classification.

## Sources

- **epoch-2025**: Josh You, "How much energy does ChatGPT use?", Epoch AI, 2025. https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use
- **google-2025**: Elsner et al., "Measuring the environmental impact of delivering AI at Google Scale", 2025. https://arxiv.org/abs/2508.15734
- **ember-2024**: Ember, "Global Electricity Review 2024". https://ember-energy.org/latest-insights/global-electricity-review-2024/
- **desnz-2025**: UK Department for Energy Security and Net Zero, "Greenhouse gas reporting: conversion factors 2025". https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2025
- **ec-kettles-2020**: European Commission DG ENER (Fraunhofer ISI, VITO), "Preparatory study for kettles (Ecodesign), Task 3: Users", 2020. https://www.energimyndigheten.se/globalassets/energieffektivisering_/lagar-och-krav/ekodesign--energimarkning/ecodesign_kettles_task_3_20201218_v27_final.pdf
- **epa-equivalencies**: US EPA, "Greenhouse Gas Equivalencies Calculator: Calculations and References". https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator-calculations-and-references
- **epa-watersense-2010**: US EPA WaterSense, "WaterSense Specification for Showerheads: Supporting Statement", 2010. https://www.epa.gov/sites/default/files/2017-01/documents/ws-products-support-statement-showerheads.pdf
- **ccw-water-use**: Consumer Council for Water, "How much water do you use?". https://www.ccw.org.uk/save-money-and-water/averagewateruse/
- **efsa-water-2010**: European Food Safety Authority, "EFSA sets European dietary reference values for water intake", 2010. https://www.efsa.europa.eu/en/press/news/nda100326

## Display units (PRD §16)

| Metric | Small unit | Switches to | When the rounded value is at least |
| --- | --- | --- | --- |
| Energy | Wh | kWh | 1000 Wh |
| Carbon | g CO₂e | kg CO₂e | 1000 g |
| Water | ml | L | 1000 ml |

Values below 0.01 display as `<0.01`. Values of 1,000 or more in the largest unit are grouped with commas (`6,003 L`).
