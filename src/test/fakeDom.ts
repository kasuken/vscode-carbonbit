// Just enough DOM for the media/ webview scripts: ids, text, hidden, children, attributes and events.
export class FakeElement {
	id = '';
	textContent = '';
	hidden = false;
	className = '';
	readonly style: Record<string, string> = {};
	readonly dataset: Record<string, string> = {};
	readonly attributes = new Map<string, string>();
	children: FakeElement[] = [];
	private readonly listeners = new Map<string, (event: unknown) => void>();
	constructor(readonly tagName = 'div', private readonly owner?: { activeElement?: FakeElement }) { }
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	appendChild(child: FakeElement) {
		this.children.push(child);
		return child;
	}
	replaceChildren(...children: FakeElement[]) {
		this.children = children;
	}
	addEventListener(type: string, fn: (event: unknown) => void) {
		this.listeners.set(type, fn);
	}
	focus() {
		if (this.owner) {
			this.owner.activeElement = this;
		}
	}
	click() {
		this.listeners.get('click')?.({});
	}
	keydown(key: string) {
		this.listeners.get('keydown')?.({ key, preventDefault: () => undefined });
	}
	/** Rendered text, as assistive technology would read it (aria-hidden subtrees skipped). */
	get text(): string {
		if (this.attributes.get('aria-hidden') === 'true') {
			return '';
		}
		return [this.textContent, ...this.children.map(c => c.text)].filter(Boolean).join(' ');
	}
	find(className: string): FakeElement[] {
		return this.children.flatMap(c => [...(c.className.split(' ').includes(className) ? [c] : []), ...c.find(className)]);
	}
	findTag(tagName: string): FakeElement[] {
		return this.children.flatMap(c => [...(c.tagName === tagName ? [c] : []), ...c.findTag(tagName)]);
	}
}

export function createFakeDocument() {
	const elements = new Map<string, FakeElement>();
	const document = {
		elements,
		activeElement: undefined as FakeElement | undefined,
		body: new FakeElement('body'),
		getElementById: (id: string) => {
			if (!elements.has(id)) {
				const el = new FakeElement('div', document);
				el.id = id;
				elements.set(id, el);
			}
			return elements.get(id);
		},
		createElement: (tag: string) => new FakeElement(tag, document),
		createElementNS: (_namespace: string, tag: string) => new FakeElement(tag, document),
	};
	return document;
}
