// Details webview script. The host validates every message; this side renders the known
// `details`, `methodology` and `show` shapes via textContent only.
(function () {
	const vscode = acquireVsCodeApi();
	const Icons = window.CarbonBitIcons;
	const EMPTY = '\u2014';
	const TABS = ['overview', 'methodology'];
	const CONFIDENCE_LABELS = { high: 'High', medium: 'Medium', low: 'Low' };
	const MODEL_COLUMNS = [['Requests', 'requests'], ['Tokens', 'tokens'], ['Energy', 'energy'], ['CO\u2082e', 'carbon'], ['Water', 'water']];
	// Explanations stay open across live updates.
	const expanded = new Set();
	let lastDetails = '';

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

	function rowHeader(text) {
		const th = element('th', '', text);
		th.setAttribute('scope', 'row');
		return th;
	}

	function tableRow(header, cells) {
		const tr = element('tr');
		tr.appendChild(rowHeader(header));
		cells.forEach((text) => tr.appendChild(element('td', '', text)));
		return tr;
	}

	function confidenceText(confidence) {
		return CONFIDENCE_LABELS[confidence] || 'Not estimated';
	}

	function selectTab(tab, focus) {
		const current = TABS.includes(tab) ? tab : 'overview';
		for (const name of TABS) {
			const selected = name === current;
			const button = byId(`tab-${name}`);
			if (button) {
				button.setAttribute('aria-selected', String(selected));
				button.setAttribute('tabindex', selected ? '0' : '-1');
				if (selected && focus) {
					button.focus();
				}
			}
			setHidden(`panel-${name}`, !selected);
		}
		vscode.setState({ tab: current });
	}

	function explanation(lines) {
		const dl = element('dl', 'explanation-lines');
		for (const line of list(lines)) {
			const item = element('div', `explanation-${line.kind}`);
			item.appendChild(element('dt', '', line.label));
			item.appendChild(element('dd', '', line.value));
			dl.appendChild(item);
		}
		return dl;
	}

	function setExpanded(button, panel, key, open) {
		button.setAttribute('aria-expanded', String(open));
		panel.hidden = !open;
		if (open) {
			expanded.add(key);
		} else {
			expanded.delete(key);
		}
	}

	// Visible text first so the accessible name starts with what is shown.
	function describeButton(button, estimate, subject) {
		const label = confidenceText(estimate && estimate.confidence);
		button.className = `confidence confidence-${(estimate && estimate.confidence) || 'none'}`;
		button.textContent = label;
		button.setAttribute('aria-label', `${label} confidence for ${subject}: show why`);
	}

	function renderOverall(today, overall) {
		const button = byId('overall-confidence');
		const panel = byId('overall-explanation');
		if (button && panel) {
			describeButton(button, overall, 'today\u2019s estimates');
			panel.replaceChildren(explanation(overall && overall.lines));
			setExpanded(button, panel, 'overall', expanded.has('overall'));
		}
		const tokens = list(overall && overall.lines).find((line) => line.kind === 'tokens');
		setText('today-tokens-basis', tokens && today ? `Usage counter: ${tokens.value}` : 'Usage counter');
	}

	function renderToday(today) {
		const text = today && today.text ? today.text : {};
		for (const key of ['requests', 'tokens', 'energy', 'carbon', 'water']) {
			setText(`today-${key}`, text[key] || EMPTY);
		}
		setHidden('today-unavailable', Boolean(today));
	}

	function renderModels(models) {
		const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
		let refocus;
		const rows = [];
		list(models).forEach((model, i) => {
			const name = model.model || 'Model not reported';
			const key = `model:${model.model || ''}`;
			const row = element('tr');
			row.appendChild(rowHeader(name));
			for (const [label, field] of MODEL_COLUMNS) {
				const cell = element('td', 'num', (model.text && model.text[field]) || EMPTY);
				cell.dataset.label = label;
				row.appendChild(cell);
			}
			const confidenceCell = element('td', 'confidence-cell');
			confidenceCell.dataset.label = 'Confidence';
			const button = element('button');
			button.setAttribute('type', 'button');
			button.dataset.key = key;
			describeButton(button, model.estimate, name);
			confidenceCell.appendChild(button);
			row.appendChild(confidenceCell);

			const detail = element('tr', 'explanation-row');
			detail.id = `model-explanation-${i}`;
			const detailCell = element('td', 'explanation');
			detailCell.setAttribute('colspan', String(MODEL_COLUMNS.length + 2));
			detailCell.appendChild(explanation(model.estimate && model.estimate.lines));
			detail.appendChild(detailCell);
			button.setAttribute('aria-controls', detail.id);
			setExpanded(button, detail, key, expanded.has(key));
			button.addEventListener('click', () => setExpanded(button, detail, key, button.getAttribute('aria-expanded') !== 'true'));
			if (key === focusedKey) {
				refocus = button;
			}
			rows.push(row, detail);
		});
		fill('models', rows);
		setHidden('models-table', rows.length === 0);
		setHidden('models-empty', rows.length > 0);
		if (refocus) {
			refocus.focus();
		}
	}

	// One column per period: label, the headline figure and its everyday comparisons.
	function periodColumn(period, kind) {
		const column = element('article', `period period-${period.id}`);
		const head = element('p', 'period-label', period.label);
		if (period.note) {
			head.appendChild(element('span', 'period-note', period.note));
		}
		column.appendChild(head);
		const text = period.totals && period.totals.text ? period.totals.text : {};
		column.appendChild(element('p', 'period-value', text[kind] || EMPTY));
		const items = list(period[kind]);
		if (items.length) {
			const listEl = element('ul', 'equivalents');
			listEl.setAttribute('aria-label', 'About the same as');
			for (const item of items) {
				const row = element('li', `equivalent equivalent-${item.id}`);
				if (Icons) {
					row.appendChild(Icons.create(document, item.id));
				}
				row.appendChild(element('span', 'amount', item.amount));
				row.appendChild(element('span', 'unit', item.unit));
				listEl.appendChild(row);
			}
			column.appendChild(listEl);
		}
		return column;
	}

	function renderFootprint(periods) {
		const items = list(periods);
		fill('footprint-carbon', items.map((p) => periodColumn(p, 'carbon')));
		fill('footprint-water', items.map((p) => periodColumn(p, 'water')));
		setHidden('footprint-unavailable', items.length > 0);
	}

	function shareText(provider) {
		if (provider.percent === null) {
			return 'no token data';
		}
		return provider.percent === 0 && provider.tokens > 0 ? '<1%' : `${provider.percent}%`;
	}

	function renderProviders(providers) {
		const rows = list(providers).map((provider) => {
			const row = element('tr');
			row.appendChild(rowHeader(provider.name));
			row.appendChild(element('td', 'num', String(provider.requests)));
			row.appendChild(element('td', 'num', provider.tokensText));
			const share = element('td', 'share');
			const bar = element('span', 'bar');
			const barFill = element('span', 'bar-fill');
			bar.setAttribute('aria-hidden', 'true');
			barFill.style.width = `${provider.percent || 0}%`;
			bar.appendChild(barFill);
			share.appendChild(bar);
			share.appendChild(element('span', 'share-text', shareText(provider)));
			row.appendChild(share);
			return row;
		});
		fill('providers', rows);
		setHidden('providers-table', rows.length === 0);
		setHidden('providers-empty', rows.length > 0);
	}

	function renderMethodology(m) {
		setText('method-version', `Methodology ${m.id} version ${m.version}, effective ${m.effectiveDate}. All environmental figures are estimates.`);
		setText('method-summary', m.summary);
		fill('method-collection', list(m.collection).map((text) => element('li', '', text)));
		fill('method-levels', list(m.levels).map((l) => tableRow(l.level, [confidenceText(l.actual), confidenceText(l.reduced)])));
		fill('method-factors', list(m.factors).map((f) => tableRow(f.name, [f.value, list(f.sources).join(', ') || EMPTY])));
		fill('method-assumptions', list(m.assumptions).map((text) => element('li', '', text)));
		fill('method-limitations', list(m.limitations).map((text) => element('li', '', text)));
		fill('method-sources', list(m.sources).map((source) => {
			const item = element('li');
			item.appendChild(element('span', 'source-id', `[${source.id}] `));
			item.appendChild(element('span', '', `${source.citation}. ${source.usedFor} `));
			if (/^https:\/\//.test(source.url)) {
				const link = element('a', '', source.url);
				link.setAttribute('href', source.url);
				item.appendChild(link);
			}
			return item;
		}));
	}

	TABS.forEach((name, i) => {
		const button = byId(`tab-${name}`);
		if (!button) {
			return;
		}
		button.addEventListener('click', () => selectTab(name, false));
		button.addEventListener('keydown', (event) => {
			const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[event.key];
			if (next !== undefined) {
				event.preventDefault();
				selectTab(TABS[(next + TABS.length) % TABS.length], true);
			}
		});
	});

	const overallButton = byId('overall-confidence');
	const overallPanel = byId('overall-explanation');
	if (overallButton && overallPanel) {
		overallButton.addEventListener('click', () =>
			setExpanded(overallButton, overallPanel, 'overall', overallButton.getAttribute('aria-expanded') !== 'true'));
	}
	const openDocument = byId('open-document');
	if (openDocument) {
		openDocument.addEventListener('click', () => vscode.postMessage({ type: 'openMethodologyDocument' }));
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || typeof message !== 'object') {
			return;
		}
		if (message.type === 'details') {
			// Identical updates are skipped so focus and scroll aren't disturbed.
			const json = JSON.stringify(message);
			if (json === lastDetails) {
				return;
			}
			lastDetails = json;
			renderFootprint(message.periods);
			renderToday(message.today);
			renderOverall(message.today, message.overall);
			renderModels(message.models);
			renderProviders(message.providers);
		} else if (message.type === 'methodology') {
			renderMethodology(message);
		} else if (message.type === 'show') {
			selectTab(message.tab, false);
		}
	});

	const saved = vscode.getState();
	selectTab(saved && saved.tab, false);
	vscode.postMessage({ type: 'ready' });
})();
