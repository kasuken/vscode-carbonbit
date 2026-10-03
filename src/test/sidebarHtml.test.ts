import * as assert from 'assert';
import { createNonce, getSidebarHtml } from '../sidebar/sidebarHtml';

const options = {
	cspSource: 'https://webview.example',
	nonce: 'abc123',
	scriptUri: 'https://webview.example/media/sidebar.js',
	iconsUri: 'https://webview.example/media/icons.js',
	worldScriptUris: ['scene.js', 'effects.js', 'renderer.js'].map(f => `https://webview.example/media/world/${f}`),
	styleUri: 'https://webview.example/media/sidebar.css',
};

function getCsp(html: string): string {
	const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html);
	assert.ok(match, 'CSP meta tag missing');
	return match[1];
}

suite('Sidebar HTML', () => {
	test('applies a restrictive Content Security Policy', () => {
		const csp = getCsp(getSidebarHtml(options));
		assert.ok(csp.startsWith(`default-src 'none';`));
		assert.ok(csp.includes(`img-src https://webview.example data:;`));
		assert.ok(csp.includes(`style-src https://webview.example;`));
		assert.ok(csp.includes(`script-src 'nonce-abc123';`));
		assert.ok(csp.includes(`font-src https://webview.example;`));
		assert.ok(!csp.includes('unsafe-inline'));
		assert.ok(!csp.includes('unsafe-eval'));
	});

	test('loads only external, nonce-tagged scripts', () => {
		const html = getSidebarHtml(options);
		const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
		assert.strictEqual(scripts.length, 5);
		const order = ['world/scene.js', 'world/effects.js', 'world/renderer.js', 'icons.js', 'sidebar.js'];
		order.forEach((file, i) => {
			assert.ok(scripts[i].includes(`src="https://webview.example/media/${file}"`), `${file} must load at position ${i}`);
		});
		for (const script of scripts) {
			assert.ok(script.includes('nonce="abc123"'), script);
			assert.ok(/src="[^"]+"/.test(script), script);
			assert.ok(/>\s*<\/script>$/.test(script), 'inline script body found');
		}
	});

	test('contains no inline handlers, inline styles or remote resources', () => {
		const html = getSidebarHtml(options);
		assert.ok(!/\son[a-z]+\s*=/i.test(html));
		assert.ok(!/<style\b/i.test(html));
		assert.ok(!/\sstyle\s*=/i.test(html));
		assert.ok(!/javascript:/i.test(html));
		const urls = html.match(/(?:src|href)="([^"]+)"/g) ?? [];
		for (const url of urls) {
			assert.ok(url.includes('https://webview.example/'), url);
		}
	});

	test('provides a canvas mount point and idle status', () => {
		const html = getSidebarHtml(options);
		assert.ok(/<canvas id="world" width="160" height="90" role="img" aria-label="[^"]*idle[^"]*"/i.test(html));
		assert.ok(/<p id="status"[^>]*aria-live="polite"[^>]*>Idle<\/p>/.test(html));
	});

	test('has live, today, providers, onboarding and empty-state sections with metrics available as text', () => {
		const html = getSidebarHtml(options);
		for (const id of [
			'live-heading', 'live-source', 'live-more', 'today-heading', 'providers', 'providers-caption', 'onboarding', 'onboarding-tools', 'empty', 'empty-tools',
			'activity-bars', 'activity-summary', 'carbon-equivalents', 'water-equivalents', 'period-note',
		]) {
			assert.ok(html.includes(`id="${id}"`), id);
		}
		for (const id of ['metric-energy', 'metric-tokens', 'metric-requests', 'session-requests', 'session-tokens', 'session-carbon']) {
			assert.ok(new RegExp(`<dd id="${id}">`).test(html), id);
		}
		for (const id of ['metric-carbon', 'metric-water']) {
			assert.ok(new RegExp(`<span id="${id}" class="figure-value">`).test(html), id);
		}
		assert.ok(/<section id="onboarding"[^>]*hidden>/.test(html), 'onboarding stays hidden until the host says first run');
		assert.ok(/<section id="empty"[^>]*hidden>/.test(html));
		assert.ok(/estimates, not (direct )?measurements/i.test(html), 'estimate disclaimer is in the page');
		assert.ok(/stays on your machine/i.test(html) && /Processed locally/i.test(html), 'privacy note is in the page');
		assert.ok(html.includes('<body data-mode="environmental">'));
	});

	test('actions are real buttons, never links', () => {
		const html = getSidebarHtml(options);
		assert.ok(!/<a\b/i.test(html));
		const buttons = html.match(/<button\b[^>]*>/g) ?? [];
		assert.deepStrictEqual(buttons.map(b => /id="([^"]+)"/.exec(b)?.[1]), [
			'onboarding-start', 'onboarding-methodology', 'empty-refresh',
			'period-today', 'period-last30Days', 'period-previousMonth', 'period-projectedYear',
			'action-details', 'action-methodology',
		]);
		assert.ok(buttons.every(b => b.includes('type="button"')));
	});

	test('period tabs are an accessible tablist with today selected', () => {
		const html = getSidebarHtml(options);
		assert.ok(/<div class="periods" role="tablist" aria-label="Period">/.test(html));
		const tabs = html.match(/<button type="button" role="tab"[^>]*>[^<]*<\/button>/g) ?? [];
		assert.strictEqual(tabs.length, 4);
		assert.ok(tabs.every(t => t.includes('aria-controls="footprint-panel"')));
		assert.deepStrictEqual(tabs.map(t => /aria-selected="(\w+)"/.exec(t)?.[1]), ['true', 'false', 'false', 'false']);
		assert.ok(tabs.slice(1).every(t => t.includes('tabindex="-1"')));
		assert.ok(/<div id="footprint-panel" role="tabpanel" aria-labelledby="period-today">/.test(html));
	});

	test('escapes injected attribute values', () => {
		const html = getSidebarHtml({ ...options, scriptUri: 'x" onload="alert(1)', worldScriptUris: ['y"><script>'] });
		assert.ok(!html.includes('" onload="'));
		assert.ok(html.includes('x&quot; onload=&quot;alert(1)'));
		assert.ok(html.includes('y&quot;&gt;&lt;script&gt;'));
	});

	test('createNonce returns unique, sufficiently random values', () => {
		const a = createNonce();
		const b = createNonce();
		assert.notStrictEqual(a, b);
		assert.ok(Buffer.from(a, 'base64').length >= 16);
	});
});
