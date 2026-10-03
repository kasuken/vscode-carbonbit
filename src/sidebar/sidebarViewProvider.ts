import * as vscode from 'vscode';
import type { SidebarView } from '../core/messages/protocol';
import { AnimationSettings, DEFAULT_ANIMATION_SETTINGS } from '../core/settings/animationSettings';
import { DEFAULT_VISUAL_MODE, type VisualMode } from '../core/settings/visualModeSettings';
import type { WorldSnapshot } from '../core/world/worldStateEngine';
import { EMPTY_VIEW, handleWebviewMessage, IDLE_WORLD, postConfig, postView, postWorldState, SidebarActions } from './messageHandler';
import { createNonce, getSidebarHtml } from './sidebarHtml';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
	static readonly viewId = 'carbonbit.sidebar';

	private view: vscode.WebviewView | undefined;
	private world: WorldSnapshot = IDLE_WORLD;
	private animation: AnimationSettings = DEFAULT_ANIMATION_SETTINGS;
	private visualMode: VisualMode = DEFAULT_VISUAL_MODE;
	private content: SidebarView = EMPTY_VIEW;

	constructor(private readonly extensionUri: vscode.Uri, private readonly actions: SidebarActions) {}

	setAnimation(animation: AnimationSettings): void {
		this.animation = { ...animation };
		this.postConfig();
	}

	setVisualMode(visualMode: VisualMode): void {
		this.visualMode = visualMode;
		this.postConfig();
	}

	private postConfig(): void {
		const webview = this.view?.webview;
		if (webview) {
			postConfig(this.animation, this.visualMode, message => { void webview.postMessage(message); });
		}
	}

	setWorld(world: WorldSnapshot): void {
		this.world = { ...world };
		const webview = this.view?.webview;
		if (webview) {
			postWorldState(this.world, message => { void webview.postMessage(message); });
		}
	}

	setView(content: SidebarView): void {
		this.content = content;
		const webview = this.view?.webview;
		if (webview) {
			postView(this.content, message => { void webview.postMessage(message); });
		}
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
		const webview = webviewView.webview;

		webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
		webview.html = getSidebarHtml({
			cspSource: webview.cspSource,
			nonce: createNonce(),
			scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sidebar.js')).toString(),
			iconsUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'icons.js')).toString(),
			worldScriptUris: ['scene.js', 'effects.js', 'renderer.js'].map(file =>
				webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'world', file)).toString()),
			styleUri: webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sidebar.css')).toString(),
		});

		const subscription = webview.onDidReceiveMessage((message: unknown) => {
			handleWebviewMessage(
				message,
				outgoing => { void webview.postMessage(outgoing); },
				{ world: this.world, animation: this.animation, visualMode: this.visualMode, view: this.content },
				this.actions,
			);
		});
		webviewView.onDidDispose(() => {
			subscription.dispose();
			if (this.view === webviewView) {
				this.view = undefined;
			}
		});
	}
}
