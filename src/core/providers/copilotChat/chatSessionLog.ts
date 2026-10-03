import { isObject } from '../shared/jsonValues';
import { applyRequestField, createRequestMeta, textLength, type CopilotChatRequestMeta } from './copilotChatNormalizer';

/**
 * Replays a VS Code chat session operation log (`chatSessions/<id>.jsonl`) while keeping
 * only request metadata. Ops: kind 0 = snapshot, 1 = set at path `k`, 2 = push at `k`
 * (optionally truncating to index `i` first). Unknown ops are ignored.
 */
export class ChatSessionLog {
	readonly requests: CopilotChatRequestMeta[] = [];
	malformedLines = 0;

	apply(line: string): void {
		let op: unknown;
		try {
			op = JSON.parse(line);
		} catch {
			op = undefined;
		}
		if (!isObject(op) || typeof op.kind !== 'number') {
			this.malformedLines++;
			return;
		}
		const path = Array.isArray(op.k) ? op.k : [];
		if (op.kind === 0) {
			this.requests.length = 0;
			this.pushRequests(isObject(op.v) ? op.v.requests : undefined);
		} else if (op.kind === 1 && path[0] === 'requests') {
			this.set(path, op.v);
		} else if (op.kind === 2 && path[0] === 'requests' && Array.isArray(op.v)) {
			this.push(path, op.v, op.i);
		}
	}

	private set(path: unknown[], value: unknown): void {
		if (path.length === 1) {
			this.requests.length = 0;
			this.pushRequests(value);
			return;
		}
		const meta = this.at(path[1]);
		if (meta && path.length === 3 && typeof path[2] === 'string') {
			applyRequestField(meta, path[2], value);
		}
	}

	private push(path: unknown[], value: unknown[], truncateAt: unknown): void {
		if (path.length === 1) {
			if (typeof truncateAt === 'number' && truncateAt >= 0) {
				this.requests.length = Math.min(truncateAt, this.requests.length);
			}
			this.pushRequests(value);
			return;
		}
		const meta = this.at(path[1]);
		if (meta && path.length === 3 && path[2] === 'response') {
			// Truncation of response parts is ignored; this only feeds the text-length fallback.
			meta.responseChars += textLength(value);
		}
	}

	private at(index: unknown): CopilotChatRequestMeta | undefined {
		return typeof index === 'number' ? this.requests[index] : undefined;
	}

	private pushRequests(list: unknown): void {
		if (!Array.isArray(list)) {
			return;
		}
		for (const raw of list) {
			// Placeholders keep indexes aligned with the source when a request is unreadable.
			this.requests.push(createRequestMeta(raw) ?? { requestId: '', promptChars: 0, responseChars: 0 });
		}
	}
}
