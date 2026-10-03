import { escapeAttribute } from '../sidebar/sidebarHtml';

export interface DetailsHtmlOptions {
	cspSource: string;
	nonce: string;
	scriptUri: string;
	/** Pixel icons for the everyday comparisons; loads before `scriptUri`. */
	iconsUri: string;
	styleUri: string;
}

export function getDetailsHtml(options: DetailsHtmlOptions): string {
	const csp = escapeAttribute(options.cspSource);
	const nonce = escapeAttribute(options.nonce);
	const policy = [
		`default-src 'none'`,
		`img-src ${csp} data:`,
		`style-src ${csp}`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${csp}`,
	].join('; ');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${policy};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
	<title>CarbonBit Details</title>
</head>
<body>
	<header>
		<h1>CarbonBit Details</h1>
		<p class="note">Requests and tokens are usage counters from local logs. Energy, CO&#8322;e and water are estimates, not measurements.</p>
		<div class="tabs" role="tablist" aria-label="Details sections">
			<button type="button" role="tab" id="tab-overview" aria-controls="panel-overview" aria-selected="true">Overview</button>
			<button type="button" role="tab" id="tab-methodology" aria-controls="panel-methodology" aria-selected="false" tabindex="-1">Methodology</button>
		</div>
	</header>
	<main>
		<section id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" tabindex="0">
			<section class="footprint" aria-labelledby="footprint-heading">
				<h2 id="footprint-heading">Footprint over time</h2>
				<p class="note">Each figure comes with everyday comparisons of about the same size. The projected year extends your last 30 days of usage. Periods before your tools&rsquo; local logs begin show no data rather than zero.</p>
				<p id="footprint-unavailable" class="note" hidden>Usage history is unavailable.</p>
				<section class="impact impact-carbon" aria-labelledby="footprint-carbon-heading">
					<h3 id="footprint-carbon-heading">Estimated CO&#8322;e</h3>
					<div id="footprint-carbon" class="period-columns"></div>
				</section>
				<section class="impact impact-water" aria-labelledby="footprint-water-heading">
					<h3 id="footprint-water-heading">Estimated water</h3>
					<div id="footprint-water" class="period-columns"></div>
				</section>
			</section>
			<section aria-labelledby="today-heading">
				<h2 id="today-heading">Today</h2>
				<p id="today-unavailable" class="note" hidden>Usage history is unavailable.</p>
				<table class="summary">
					<caption>Today&rsquo;s usage counters and estimated impact</caption>
					<thead><tr><th scope="col">Metric</th><th scope="col" class="num">Value</th><th scope="col">Basis</th></tr></thead>
					<tbody>
						<tr><th scope="row">Requests</th><td id="today-requests" class="num">&mdash;</td><td>Usage counter</td></tr>
						<tr><th scope="row">Tokens</th><td id="today-tokens" class="num">&mdash;</td><td id="today-tokens-basis">Usage counter</td></tr>
						<tr><th scope="row">Energy</th><td id="today-energy" class="num">&mdash;</td><td>Estimate</td></tr>
						<tr><th scope="row">CO&#8322;e</th><td id="today-carbon" class="num">&mdash;</td><td>Estimate</td></tr>
						<tr><th scope="row">Water</th><td id="today-water" class="num">&mdash;</td><td>Estimate</td></tr>
					</tbody>
				</table>
				<p class="confidence-line">Estimate confidence:
					<button type="button" id="overall-confidence" class="confidence confidence-none" aria-expanded="false" aria-controls="overall-explanation">&mdash;</button>
				</p>
				<div id="overall-explanation" class="explanation" hidden></div>
			</section>
			<section aria-labelledby="models-heading">
				<h2 id="models-heading">Models</h2>
				<table id="models-table" class="models">
					<caption>Today&rsquo;s usage and estimated impact by model. Select a confidence level to see why.</caption>
					<thead><tr>
						<th scope="col">Model</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Tokens</th>
						<th scope="col" class="num">Energy</th><th scope="col" class="num">CO&#8322;e</th><th scope="col" class="num">Water</th>
						<th scope="col">Confidence</th>
					</tr></thead>
					<tbody id="models"></tbody>
				</table>
				<p id="models-empty" class="note" hidden>No model usage recorded today.</p>
			</section>
			<section aria-labelledby="providers-heading">
				<h2 id="providers-heading">Providers</h2>
				<table id="providers-table" class="providers">
					<caption>Usage distribution by provider (share of today&rsquo;s tokens)</caption>
					<thead><tr><th scope="col">Provider</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Tokens</th><th scope="col">Share</th></tr></thead>
					<tbody id="providers"></tbody>
				</table>
				<p id="providers-empty" class="note" hidden>No provider usage recorded today.</p>
			</section>
		</section>
		<section id="panel-methodology" role="tabpanel" aria-labelledby="tab-methodology" tabindex="0" hidden>
			<h2>Methodology</h2>
			<p id="method-version" class="note"></p>
			<p id="method-summary"></p>
			<h3 id="method-collection-heading">How usage is collected</h3>
			<ul id="method-collection" aria-labelledby="method-collection-heading"></ul>
			<h3>Confidence levels</h3>
			<table>
				<caption>Starting confidence by energy factor level. Partial or estimated token counts lower it one step.</caption>
				<thead><tr><th scope="col">Energy factor level</th><th scope="col">Actual token counts</th><th scope="col">Partial or estimated counts</th></tr></thead>
				<tbody id="method-levels"></tbody>
			</table>
			<h3>Factors</h3>
			<table>
				<caption>Factors used for every estimate</caption>
				<thead><tr><th scope="col">Factor</th><th scope="col">Value</th><th scope="col">Sources</th></tr></thead>
				<tbody id="method-factors"></tbody>
			</table>
			<h3 id="method-assumptions-heading">Assumptions</h3>
			<ul id="method-assumptions" aria-labelledby="method-assumptions-heading"></ul>
			<h3 id="method-limitations-heading">Limitations</h3>
			<ul id="method-limitations" aria-labelledby="method-limitations-heading"></ul>
			<h3 id="method-sources-heading">Sources</h3>
			<ul id="method-sources" aria-labelledby="method-sources-heading"></ul>
			<div class="actions">
				<button type="button" id="open-document" class="secondary">Open methodology document</button>
			</div>
		</section>
	</main>
	<script nonce="${nonce}" src="${escapeAttribute(options.iconsUri)}"></script>
	<script nonce="${nonce}" src="${escapeAttribute(options.scriptUri)}"></script>
</body>
</html>`;
}
