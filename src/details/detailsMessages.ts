import {
	type DetailsTab,
	type DetailsView,
	type HostToDetailsMessage,
	isDetailsToHostMessage,
	isHostToDetailsMessage,
	type MethodologyView,
} from '../core/messages/detailsProtocol';

export type SendToDetails = (message: HostToDetailsMessage) => void;

/** Host actions the details webview may trigger; only reached with validated input. */
export interface DetailsActions {
	openMethodologyDocument(): void;
}

export interface DetailsContent {
	view(): DetailsView;
	methodology: MethodologyView;
	/** Tab requested before the webview was ready; consumed once. */
	takeTab?(): DetailsTab | undefined;
}

/** Sends only messages that pass the protocol check; returns whether it was sent. */
export function postToDetails(message: HostToDetailsMessage, send: SendToDetails): boolean {
	if (!isHostToDetailsMessage(message)) {
		return false;
	}
	send(message);
	return true;
}

export function postDetailsView(view: DetailsView, send: SendToDetails): boolean {
	return postToDetails({ type: 'details', ...view }, send);
}

/** Handles a raw message from the details webview; invalid or unknown messages are ignored. */
export function handleDetailsMessage(message: unknown, send: SendToDetails, content: DetailsContent, actions: DetailsActions): boolean {
	if (!isDetailsToHostMessage(message)) {
		return false;
	}
	if (message.type === 'openMethodologyDocument') {
		actions.openMethodologyDocument();
		return true;
	}
	const methodologySent = postToDetails({ type: 'methodology', ...content.methodology }, send);
	const viewSent = postDetailsView(content.view(), send);
	const tab = content.takeTab?.();
	const tabSent = tab === undefined || postToDetails({ type: 'show', tab }, send);
	return methodologySent && viewSent && tabSent;
}
