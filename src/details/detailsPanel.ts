import * as vscode from 'vscode';
import type { DetailsTab, DetailsView, MethodologyView } from '../core/messages/detailsProtocol';
import { createNonce } from '../sidebar/sidebarHtml';
import { getDetailsHtml } from './detailsHtml';
import { DetailsActions, handleDetailsMessage, postDetailsView, postToDetails } from './detailsMessages';

/** Single-instance Details webview panel (PRD §30); revealed if already open. */
export class DetailsPanel implements vscode.Disposable {
	static readonly viewType = 'carbonbit.details';

	private panel: vscode.WebviewPanel | undefined;
	private pendingTab: DetailsTab | undefined;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly getView: () => DetailsView,
		private readonly methodology: MethodologyView,
		private readonly actions: DetailsActions,
	) {}

	/** Hidden panels drop their content and reload (sending `ready`) when shown again. */
	get visible(): boolean {
		return this.panel?.visible ?? false;
	}

	show(tab: DetailsTab): void {
		if (this.panel?.visible) {
			this.panel.reveal();
			postToDetails({ type: 'show', tab }, message => { void this.panel?.webview.postMessage(message); });
			return;
		}
		this.pendingTab = tab;
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.panel = this.createPanel();
	}

	setView(view: DetailsView): void {
		const webview = this.panel?.visible ? this.panel.webview : undefined;
		if (webview) {
			postDetailsView(view, message => { void webview.postMessage(message); });
		}
	}

	dispose(): void {
		this.panel?.dispose();
	}

	private createPanel(): vscode.WebviewPanel {
		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
		const panel = vscode.window.createWebviewPanel(DetailsPanel.viewType, 'CarbonBit Details', vscode.ViewColumn.Active, {
			enableScripts: true,
			enableFindWidget: true,
			localResourceRoots: [mediaRoot],
		});
		panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'carbonbit.svg');
		const webview = panel.webview;
		webview.html = getDetailsHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'details.js')).toString(),
			iconsUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'icons.js')).toString(),
			styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'details.css')).toString(),
		});
		const subscription = webview.onDidReceiveMessage((message: unknown) => {
			handleDetailsMessage(message, outgoing => { void webview.postMessage(outgoing); }, {
				view: this.getView,
				methodology: this.methodology,
				takeTab: () => {
					const tab = this.pendingTab;
					this.pendingTab = undefined;
					return tab;
				},
			}, this.actions);
		});
		panel.onDidDispose(() => {
			subscription.dispose();
			if (this.panel === panel) {
				this.panel = undefined;
				this.pendingTab = undefined;
			}
		});
		return panel;
	}
}
