import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { createFakeDocument, FakeElement } from './fakeDom';

// Fake browser for the pixel world: virtual clock, 60 Hz frames, timers, visibility and media queries.

export const root = path.resolve(__dirname, '..', '..');
export const WORLD_SCRIPTS = ['scene.js', 'effects.js', 'renderer.js'].map(file => path.join('media', 'world', file));
const VSYNC_MS = 1000 / 60;

type Listener = (event: { data: unknown }) => void;

export class RecordingContext {
	fillStyle = '';
	imageSmoothingEnabled = true;
	readonly calls: unknown[][] = [];
	fillRect(x: number, y: number, w: number, h: number) {
		this.calls.push(['fillRect', this.fillStyle, x, y, w, h]);
	}
	drawImage(_image: unknown, x: number, y: number) {
		this.calls.push(['drawImage', x, y]);
	}
	setTransform(...args: number[]) {
		this.calls.push(['setTransform', ...args]);
	}
	count(kind: string) {
		return this.calls.filter(c => c[0] === kind).length;
	}
}

export interface Frame {
	state: string;
	prevState: string;
	elapsed: number;
	t: number;
	level: number;
	activeCount: number;
	still: boolean;
	mode?: string;
	hour?: number;
}

export interface WorldGlobals {
	CarbonBitScene: {
		P: Record<string, string>;
		PALETTES: Record<string, Record<string, string>>;
		PHASES: readonly string[];
		phaseOf(hour: number): string;
		drawBackground(ctx: RecordingContext, phase: string): void;
	};
	CarbonBitEffects: { drawDynamic(ctx: RecordingContext, frame: Frame): void; IDLE_SETTLE_MS: number };
	CarbonBitWorld: {
		WIDTH: number;
		HEIGHT: number;
		drawScene(ctx: RecordingContext, frame: Frame): void;
		drawIdleScene(ctx: RecordingContext, hour?: number): void;
		describeState(state: string, activeCount: number): string;
	};
}

// A fake browser: virtual clock, 60 Hz animation frames, timers, visibility and media queries.
// Loads the world scripts and sidebar.js together, driven only through host messages.
// The wall clock (Date) is pinned to `hour` so the time-of-day sky is deterministic.
export function createBrowser(options: { reducedMotion?: boolean; hour?: number } = {}) {
	let time = 0;
	let hour = options.hour ?? 12;
	const FixedDate = class extends Date {
		constructor() {
			super(2026, 5, 1, Math.floor(hour), 0, 0);
		}
	};
	let nextId = 1;
	let rafCallbacks = 0;
	const frames = new Map<number, (now: number) => void>();
	const timers = new Map<number, { due: number; fn: () => void }>();
	const docListeners = new Map<string, () => void>();
	let onMessage: Listener | undefined;
	let onMotionChange: ((event: { matches: boolean }) => void) | undefined;
	const main = new RecordingContext();
	const layer = new RecordingContext();
	const attributes = new Map<string, string>();
	const canvas = {
		width: 160,
		height: 90,
		style: {} as Record<string, string>,
		parentElement: { clientWidth: 320, clientHeight: 180 },
		getContext: () => main,
		setAttribute: (name: string, value: string) => attributes.set(name, String(value)),
		getAttribute: (name: string) => attributes.get(name) ?? null,
	};
	const fakeDocument = createFakeDocument();
	const document = {
		hidden: false,
		body: fakeDocument.body,
		createElement: (tag: string) => (tag === 'canvas' ? { width: 0, height: 0, getContext: () => layer } : new FakeElement(tag)),
		getElementById: (id: string) => (id === 'world' ? canvas : fakeDocument.getElementById(id)),
		addEventListener: (type: string, fn: () => void) => docListeners.set(type, fn),
	};
	const window = {
		devicePixelRatio: 1,
		performance: { now: () => time },
		requestAnimationFrame: (fn: (now: number) => void) => {
			frames.set(nextId, fn);
			return nextId++;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		setTimeout: (fn: () => void, ms: number) => {
			timers.set(nextId, { due: time + Math.max(0, ms), fn });
			return nextId++;
		},
		clearTimeout: (id: number) => timers.delete(id),
		matchMedia: (query: string) => ({
			matches: query.includes('reduced-motion') && Boolean(options.reducedMotion),
			addEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => {
				if (query.includes('reduced-motion')) {
					onMotionChange = fn;
				}
			},
		}),
		addEventListener: (type: string, fn: Listener) => {
			if (type === 'message') {
				onMessage = fn;
			}
		},
	};
	const context = vm.createContext({
		Date: FixedDate,
		window,
		document,
		acquireVsCodeApi: () => ({ postMessage: () => undefined }),
		ResizeObserver: class { observe() { /* sized once at mount */ } },
	});
	for (const file of [...WORLD_SCRIPTS, path.join('media', 'sidebar.js')]) {
		vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
	}

	function fireTimers(until: number) {
		for (;;) {
			const next = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
			if (!next) {
				return;
			}
			timers.delete(next[0]);
			time = next[1].due;
			next[1].fn();
		}
	}

	return {
		main,
		layer,
		canvas,
		globals: window as unknown as WorldGlobals,
		body: fakeDocument.body,
		text: (id: string) => fakeDocument.elements.get(id)?.text,
		send: (data: unknown) => onMessage?.({ data }),
		state: (worldState: string, activeCount = 1) => onMessage?.({ data: { type: 'state', worldState, activeCount } }),
		config: (animationEnabled: boolean, maxFps: number, visualMode = 'environmental') =>
			onMessage?.({ data: { type: 'config', animationEnabled, maxFps, visualMode } }),
		setHidden(hidden: boolean) {
			document.hidden = hidden;
			docListeners.get('visibilitychange')?.();
		},
		setReducedMotion: (matches: boolean) => onMotionChange?.({ matches }),
		setHour(next: number) {
			hour = next;
		},
		pending: () => frames.size + timers.size,
		rafCallbacks: () => rafCallbacks,
		frames: () => main.count('drawImage'),
		advance(ms: number) {
			const end = time + ms;
			for (;;) {
				const vsync = (Math.floor(time / VSYNC_MS + 1e-9) + 1) * VSYNC_MS;
				if (vsync > end) {
					fireTimers(end);
					time = end;
					return;
				}
				fireTimers(vsync);
				time = vsync;
				const due = [...frames.values()];
				frames.clear();
				rafCallbacks += due.length;
				due.forEach(fn => fn(time));
			}
		},
	};
}

export function frameOf(state: string, overrides: Partial<Frame> = {}): Frame {
	return { state, prevState: 'Idle', elapsed: 400, t: 12_345, level: 2, activeCount: 1, still: false, hour: 12, ...overrides };
}

export function dynamicCalls(browser: ReturnType<typeof createBrowser>, frame: Frame) {
	const ctx = new RecordingContext();
	browser.globals.CarbonBitEffects.drawDynamic(ctx, frame);
	return ctx.calls;
}

