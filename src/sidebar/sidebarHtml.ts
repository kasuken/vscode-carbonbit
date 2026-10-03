import { randomBytes } from 'crypto';

export interface SidebarHtmlOptions {
	cspSource: string;
	nonce: string;
	scriptUri: string;
	/** Pixel-world scripts, in load order; all load before `scriptUri`. */
	worldScriptUris: readonly string[];
	/** Pixel icons for the everyday comparisons; loads before `scriptUri`. */
	iconsUri: string;
	styleUri: string;
}

export function createNonce(): string {
	return randomBytes(16).toString('base64');
}

export function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/** Period tabs, in display order; ids match `PERIOD_IDS`. */
const PERIOD_TABS: readonly [id: string, label: string][] = [
	['today', 'Today'],
	['last30Days', '30 days'],
	['previousMonth', 'Last month'],
	['projectedYear', 'Year'],
];

export function getSidebarHtml(options: SidebarHtmlOptions): string {
	const csp = escapeAttribute(options.cspSource);
	const nonce = escapeAttribute(options.nonce);
	const scripts = [...options.worldScriptUris, options.iconsUri, options.scriptUri]
		.map(uri => `<script nonce="${nonce}" src="${escapeAttribute(uri)}"></script>`)
		.join('\n\t');
	const policy = [
		`default-src 'none'`,
		`img-src ${csp} data:`,
		`style-src ${csp}`,
		`script-src 'nonce-${nonce}'`,
		`font-src ${csp}`,
	].join('; ');
	const periodTabs = PERIOD_TABS.map(([id, label], i) =>
		`<button type="button" role="tab" id="period-${id}" data-period="${id}" aria-controls="footprint-panel" aria-selected="${i === 0}"${i === 0 ? '' : ' tabindex="-1"'}>${label}</button>`)
		.join('\n\t\t\t');

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${policy};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${escapeAttribute(options.styleUri)}">
	<title>CarbonBit</title>
</head>
<body data-mode="environmental">
	<section class="stage" aria-labelledby="live-heading">
		<h2 id="live-heading" class="visually-hidden">Live</h2>
		<div class="world" id="world-frame">
			<canvas id="world" width="160" height="90" role="img" aria-label="Pixel planet, idle: the Earth from space with drifting clouds; your place is marked and the data center is quiet."></canvas>
		</div>
		<div class="now" data-state="Idle" id="now">
			<span class="pulse" aria-hidden="true"></span>
			<p id="status" class="status" aria-live="polite">Idle</p>
			<span id="live-more" class="badge" hidden></span>
			<p id="live-source" class="source">No AI requests yet</p>
		</div>
	</section>
	<section id="onboarding" class="card" aria-labelledby="onboarding-heading" hidden>
		<h2 id="onboarding-heading">Welcome to CarbonBit</h2>
		<p id="onboarding-intro">CarbonBit estimates the energy, CO&#8322;e and water behind your AI coding activity.</p>
		<p>Everything stays on your machine. CarbonBit reads usage metadata from local logs; prompts, responses and code are never stored or sent.</p>
		<p>Figures are estimates, not direct measurements. Real impact depends on hardware, location, batching, caching and how each provider runs its data centers.</p>
		<h3 id="onboarding-tools-heading">Detected tools</h3>
		<ul id="onboarding-tools" class="tools" aria-labelledby="onboarding-tools-heading"></ul>
		<div class="actions">
			<button id="onboarding-start" type="button">Start tracking</button>
			<button id="onboarding-methodology" type="button" class="secondary">How estimates work</button>
		</div>
	</section>
	<section id="empty" class="card" aria-labelledby="empty-heading" hidden>
		<h2 id="empty-heading">No supported AI tool found yet</h2>
		<p>Use one of these tools and CarbonBit picks up its activity automatically:</p>
		<ul id="empty-tools" class="tools"></ul>
		<div class="actions">
			<button id="empty-refresh" type="button" class="secondary">Check again</button>
		</div>
	</section>
	<section class="activity" aria-labelledby="activity-heading">
		<div class="section-head">
			<h2 id="activity-heading">Last hour</h2>
			<p id="activity-summary" class="aside">No activity in the last hour</p>
		</div>
		<div id="activity-bars" class="bars" role="img" aria-label="No activity in the last hour"></div>
		<dl class="session" aria-label="Since VS Code started">
			<div><dt>Session requests</dt><dd id="session-requests">&mdash;</dd></div>
			<div><dt>Session tokens</dt><dd id="session-tokens">&mdash;</dd></div>
			<div><dt>Session CO&#8322;e</dt><dd id="session-carbon">&mdash;</dd></div>
		</dl>
	</section>
	<section class="footprint" aria-labelledby="today-heading">
		<div class="section-head">
			<h2 id="today-heading">Footprint</h2>
			<p id="period-note" class="aside" hidden></p>
		</div>
		<div class="periods" role="tablist" aria-label="Period">
			${periodTabs}
		</div>
		<div id="footprint-panel" role="tabpanel" aria-labelledby="period-today">
			<p id="period-empty" class="period-empty" hidden>No usage recorded for this period. CarbonBit can only count what your AI tools&rsquo; local logs still contain.</p>
			<div id="period-figures">
			<div class="impact impact-carbon">
				<p class="figure"><span class="figure-label">Emissions</span> <span id="metric-carbon" class="figure-value">&mdash;</span></p>
				<p class="same-as">About the same as</p>
				<ul id="carbon-equivalents" class="equivalents" aria-label="About the same CO&#8322;e as"></ul>
			</div>
			<div class="impact impact-water">
				<p class="figure"><span class="figure-label">Water use</span> <span id="metric-water" class="figure-value">&mdash;</span></p>
				<p class="same-as">About the same as</p>
				<ul id="water-equivalents" class="equivalents" aria-label="About the same water as"></ul>
			</div>
			<dl class="metrics">
				<div><dt>Energy</dt><dd id="metric-energy">&mdash;</dd></div>
				<div><dt>Tokens</dt><dd id="metric-tokens">&mdash;</dd></div>
				<div><dt>Requests</dt><dd id="metric-requests">&mdash;</dd></div>
			</dl>
			</div>
			<p id="estimate-note" class="note">Energy, CO&#8322;e and water are estimates, not measurements.</p>
		</div>
	</section>
	<section class="tools-share" aria-labelledby="providers-heading">
		<div class="section-head">
			<h2 id="providers-heading">Tools today</h2>
			<p id="providers-caption" class="aside">Share of today&rsquo;s tokens</p>
		</div>
		<div id="providers-bar" class="stack" aria-hidden="true"></div>
		<ul id="providers" class="providers" aria-describedby="providers-caption"></ul>
	</section>
	<footer class="footer">
		<div class="actions">
			<button id="action-details" type="button">Open details</button>
			<button id="action-methodology" type="button" class="secondary">Methodology</button>
		</div>
		<p class="note">Processed locally on this machine.</p>
	</footer>
	${scripts}
</body>
</html>`;
}
