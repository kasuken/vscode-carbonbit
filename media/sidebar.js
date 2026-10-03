// Sidebar webview script. The host validates every message it sends and receives;
// this side only accepts the known `config`, `state` and `view` shapes and renders via textContent.
(function () {
	const vscode = acquireVsCodeApi();

	// PRD §27 states, driven by the world so the text always matches the animation.
	const STATUS_LABELS = {
		Idle: 'Idle',
		RequestStarting: 'Sending request…',
		ProcessingLight: 'Generating…',
		ProcessingMedium: 'Generating…',
		ProcessingHeavy: 'Generating…',
		ResponseArriving: 'Completed',
		Failed: 'Failed',
	};
	const TOOL_STATES = {
		tracking: { mark: '✓', text: 'Detected' },
		unavailable: { mark: '○', text: 'Not detected' },
		failed: { mark: '!', text: 'Tracking unavailable' },
		stopped: { mark: '…', text: 'Checking' },
	};
	const VISUAL_MODES = ['environmental', 'neutral', 'minimal'];
	const PERIODS = ['today', 'last30Days', 'previousMonth', 'projectedYear'];
	const BUTTONS = {
		'onboarding-start': { type: 'dismissOnboarding' },
		'onboarding-methodology': { type: 'command', command: 'carbonbit.showMethodology' },
		'action-methodology': { type: 'command', command: 'carbonbit.showMethodology' },
		'action-details': { type: 'command', command: 'carbonbit.showDetails' },
		'empty-refresh': { type: 'command', command: 'carbonbit.refreshUsage' },
	};
	const EMPTY = '—';
	// Activity bars grow in whole pixel steps, like the world.
	const BAR_MAX_PX = 28;
	const BAR_STEP_PX = 2;

	const worldCanvas = document.getElementById('world');
	const World = window.CarbonBitWorld;
	const Icons = window.CarbonBitIcons;
	const world = mountWorld();
	const saved = readState();
	let worldState = 'Idle';
	let activeCount = 0;
	let view = null;
	let period = PERIODS.includes(saved.period) ? saved.period : 'today';

	// The numbers must keep working even if the pixel world can't start.
	function mountWorld() {
		if (!worldCanvas || !World) {
			return undefined;
		}
		try {
			const mounted = World.mountWorld(worldCanvas);
			return {
				setWorld: (state, count) => guard(() => mounted.setWorld(state, count)),
				setConfig: (config) => guard(() => mounted.setConfig(config)),
			};
		} catch {
			return undefined;
		}
	}

	function guard(action) {
		try {
			action();
		} catch {
			// Rendering problems stay inside the world.
		}
	}

	function readState() {
		try {
			const state = typeof vscode.getState === 'function' ? vscode.getState() : undefined;
			return state && typeof state === 'object' ? state : {};
		} catch {
			return {};
		}
	}

	function byId(id) {
		return document.getElementById(id);
	}

	function setText(id, text) {
		const el = byId(id);
		if (el) {
			el.textContent = text;
		}
	}

	function setHidden(id, hidden) {
		const el = byId(id);
		if (el) {
			el.hidden = hidden;
		}
	}

	function element(tag, className, text) {
		const el = document.createElement(tag);
		if (className) {
			el.className = className;
		}
		if (text !== undefined) {
			el.textContent = text;
		}
		return el;
	}

	function fill(id, items) {
		const el = byId(id);
		if (el) {
			el.replaceChildren(...items);
		}
	}

	function list(value) {
		return Array.isArray(value) ? value : [];
	}

	// Coarse on purpose: the host refreshes the view every minute, so no timer runs here.
	function ago(ms) {
		if (typeof ms !== 'number' || !Number.isFinite(ms)) {
			return '';
		}
		const minutes = Math.floor(Math.max(0, Date.now() - ms) / 60000);
		if (minutes < 1) {
			return 'just now';
		}
		if (minutes < 60) {
			return `${minutes} min ago`;
		}
		const hours = Math.floor(minutes / 60);
		return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
	}

	function renderLive() {
		const live = view && view.live && typeof view.live === 'object' ? view.live : null;
		const now = byId('now');
		if (now) {
			now.dataset.state = worldState;
		}
		setText('status', STATUS_LABELS[worldState]);
		setText('live-more', activeCount > 1 ? `+${activeCount - 1} active` : '');
		setHidden('live-more', activeCount <= 1);
		const source = byId('live-source');
		if (!source) {
			return;
		}
		if (!live) {
			source.replaceChildren(element('span', 'live-provider', 'No AI requests yet'));
			return;
		}
		const idle = worldState === 'Idle';
		const parts = [];
		if (idle) {
			parts.push(element('span', 'live-lead', 'Last request:'));
		}
		parts.push(element('span', 'live-provider', live.providerName));
		if (live.model) {
			parts.push(element('span', 'live-model', live.model));
		}
		if (live.tokens) {
			parts.push(element('span', 'live-tokens', `${live.tokens} tokens`));
		}
		if (live.status === 'failed') {
			parts.push(element('span', 'live-failed', '(failed)'));
		}
		if (idle) {
			parts.push(element('span', 'live-age', ago(live.updatedAt)));
		}
		source.replaceChildren(...parts);
	}

	function renderSession(session) {
		const text = session && session.text ? session.text : {};
		setText('session-requests', text.requests || EMPTY);
		setText('session-tokens', text.tokens || EMPTY);
		setText('session-carbon', text.carbon || EMPTY);
	}

	function clockLabel(ms) {
		const d = new Date(ms);
		return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
	}

	function renderActivity(activity) {
		const tokens = activity && Array.isArray(activity.tokens) ? activity.tokens : [];
		const summary = activity && activity.summary ? activity.summary : 'No activity recorded';
		const bucketMs = activity && activity.bucketMinutes > 0 ? activity.bucketMinutes * 60000 : 0;
		// Square-root scale keeps small bursts visible next to a large one.
		const peak = Math.sqrt(Math.max(1, ...tokens));
		const lastStart = bucketMs ? Math.floor(Date.now() / bucketMs) * bucketMs : 0;
		fill('activity-bars', tokens.map((count, i) => {
			const bar = element('span', i === tokens.length - 1 ? 'bar bar-now' : 'bar');
			const steps = count > 0 ? Math.max(1, Math.round((Math.sqrt(count) / peak) * (BAR_MAX_PX / BAR_STEP_PX))) : 0;
			bar.style.height = `${steps * BAR_STEP_PX}px`;
			if (bucketMs) {
				const start = lastStart - (tokens.length - 1 - i) * bucketMs;
				bar.title = `${clockLabel(start)}–${clockLabel(start + bucketMs)}: ${count.toLocaleString('en')} tokens`;
			}
			return bar;
		}));
		setText('activity-summary', summary);
		const bars = byId('activity-bars');
		if (bars) {
			bars.setAttribute('aria-label', summary);
		}
	}

	function equivalentItems(items) {
		return list(items).map((item) => {
			const row = element('li', `equivalent equivalent-${item.id}`);
			if (Icons) {
				row.appendChild(Icons.create(document, item.id));
			}
			row.appendChild(element('span', 'amount', item.amount));
			row.appendChild(element('span', 'unit', item.unit));
			return row;
		});
	}

	function selectPeriod(next, focus) {
		period = PERIODS.includes(next) ? next : 'today';
		for (const id of PERIODS) {
			const tab = byId(`period-${id}`);
			if (tab) {
				const selected = id === period;
				tab.setAttribute('aria-selected', String(selected));
				tab.setAttribute('tabindex', selected ? '0' : '-1');
				if (selected && focus) {
					tab.focus();
				}
			}
		}
		const panel = byId('footprint-panel');
		if (panel) {
			panel.setAttribute('aria-labelledby', `period-${period}`);
		}
		try {
			if (typeof vscode.setState === 'function') {
				vscode.setState({ period });
			}
		} catch {
			// Remembering the tab is a convenience only.
		}
		renderFootprint();
	}

	function currentPeriod() {
		const periods = view ? list(view.periods) : [];
		const match = periods.find((p) => p && p.id === period);
		if (match) {
			return match;
		}
		// Without period data (e.g. history unavailable), today's totals still show.
		return period === 'today' && view && view.today ? { id: 'today', note: null, totals: view.today, carbon: [], water: [] } : null;
	}

	function renderFootprint() {
		const selected = currentPeriod();
		const text = selected && selected.totals && selected.totals.text ? selected.totals.text : {};
		setText('metric-energy', text.energy || EMPTY);
		setText('metric-carbon', text.carbon || EMPTY);
		setText('metric-water', text.water || EMPTY);
		setText('metric-tokens', text.tokens || EMPTY);
		setText('metric-requests', text.requests || EMPTY);
		fill('carbon-equivalents', equivalentItems(selected && selected.carbon));
		fill('water-equivalents', equivalentItems(selected && selected.water));
		const note = selected && selected.note ? selected.note : '';
		setText('period-note', note);
		setHidden('period-note', !note);
		const footprint = byId('footprint-panel');
		if (footprint) {
			footprint.dataset.period = period;
		}
	}

	function shareText(provider) {
		if (provider.percent === null) {
			return 'no token data';
		}
		return provider.percent === 0 && provider.tokens > 0 ? '<1%' : `${provider.percent}%`;
	}

	function renderProviders(providers) {
		const shares = list(providers);
		fill('providers-bar', shares.filter((p) => p.percent > 0).map((provider) => {
			const segment = element('span', `segment provider-${provider.id}`);
			segment.style.flexGrow = String(provider.percent);
			return segment;
		}));
		fill('providers', shares.map((provider) => {
			const item = element('li', `provider provider-${provider.id}`);
			const swatch = element('span', 'swatch');
			swatch.setAttribute('aria-hidden', 'true');
			item.appendChild(swatch);
			item.appendChild(element('span', 'provider-name', provider.name));
			item.appendChild(element('span', 'provider-share', shareText(provider)));
			return item;
		}));
		setText('providers-caption', shares.some((p) => p.percent !== null) ? 'Share of today’s tokens' : 'No token usage recorded today');
		setHidden('providers-bar', !shares.some((p) => p.percent > 0));
	}

	function toolItems(providers, withState) {
		return providers.map((provider) => {
			const state = TOOL_STATES[provider.state] || TOOL_STATES.stopped;
			const item = element('li', `tool tool-${provider.state}`);
			if (withState) {
				const mark = element('span', 'tool-mark', state.mark);
				mark.setAttribute('aria-hidden', 'true');
				item.appendChild(mark);
			}
			item.appendChild(element('span', 'tool-name', provider.name));
			if (withState) {
				item.appendChild(element('span', 'tool-state', state.text));
			}
			return item;
		});
	}

	function renderSetup(setup) {
		const providers = setup && Array.isArray(setup.providers) ? setup.providers : [];
		const firstRun = Boolean(setup && setup.firstRun);
		const noneDetected = providers.length > 0 && providers.every((p) => p.state === 'unavailable' || p.state === 'failed');
		fill('onboarding-tools', toolItems(providers, true));
		fill('empty-tools', toolItems(providers, false));
		setHidden('onboarding', !firstRun);
		setHidden('empty', firstRun || !noneDetected);
	}

	// The canvas description follows the world, so screen readers hear the same state.
	function describeWorld() {
		if (worldCanvas && World && typeof World.describeState === 'function') {
			guard(() => {
				const label = World.describeState(worldState, activeCount);
				if (typeof label === 'string' && label) {
					worldCanvas.setAttribute('aria-label', label);
				}
			});
		}
	}

	function applyConfig(message) {
		if (typeof message.animationEnabled !== 'boolean' || typeof message.maxFps !== 'number') {
			return;
		}
		const visualMode = VISUAL_MODES.includes(message.visualMode) ? message.visualMode : 'environmental';
		if (document.body) {
			document.body.dataset.mode = visualMode;
		}
		if (world) {
			world.setConfig({ animationEnabled: message.animationEnabled, maxFps: message.maxFps, visualMode });
		}
	}

	for (const id of Object.keys(BUTTONS)) {
		const button = byId(id);
		if (button) {
			button.addEventListener('click', () => vscode.postMessage(BUTTONS[id]));
		}
	}

	PERIODS.forEach((id, index) => {
		const tab = byId(`period-${id}`);
		if (!tab) {
			return;
		}
		tab.addEventListener('click', () => selectPeriod(id, false));
		// Roving tabindex: arrows, Home and End move between periods (WAI-ARIA tabs).
		tab.addEventListener('keydown', (event) => {
			const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: PERIODS.length - 1 };
			if (Object.prototype.hasOwnProperty.call(moves, event.key)) {
				event.preventDefault();
				selectPeriod(PERIODS[(moves[event.key] + PERIODS.length) % PERIODS.length], true);
			}
		});
	});

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || typeof message !== 'object') {
			return;
		}
		if (message.type === 'config') {
			applyConfig(message);
		} else if (message.type === 'state') {
			const known = Object.prototype.hasOwnProperty.call(STATUS_LABELS, message.worldState);
			worldState = known ? message.worldState : 'Idle';
			activeCount = Number.isInteger(message.activeCount) && message.activeCount > 0 ? message.activeCount : 0;
			renderLive();
			describeWorld();
			if (world) {
				world.setWorld(worldState, activeCount);
			}
		} else if (message.type === 'view') {
			view = message;
			renderLive();
			renderSession(message.session);
			renderActivity(message.activity);
			renderFootprint();
			renderProviders(message.providers);
			renderSetup(message.setup);
		}
	});

	selectPeriod(period, false);
	vscode.postMessage({ type: 'ready' });
})();
