import {
	HostToWebviewMessage,
	isHostToWebviewMessage,
	isWebviewToHostMessage,
	SidebarCommand,
	SidebarView,
} from '../core/messages/protocol';
import { AnimationSettings, DEFAULT_ANIMATION_SETTINGS } from '../core/settings/animationSettings';
import { DEFAULT_VISUAL_MODE, type VisualMode } from '../core/settings/visualModeSettings';
import type { WorldSnapshot } from '../core/world/worldStateEngine';

export const IDLE_WORLD: WorldSnapshot = { worldState: 'Idle', activeCount: 0 };

/** Before the host has built a view: nothing detected yet, onboarding pending. */
export const EMPTY_VIEW: SidebarView = { live: null, today: null, session: null, periods: [], activity: null, providers: [], setup: { firstRun: true, providers: [] } };

export type SendToWebview = (message: HostToWebviewMessage) => void;

/** Current host-side state replayed to a (re)loaded webview. */
export interface SidebarSnapshot {
	world: WorldSnapshot;
	animation: AnimationSettings;
	visualMode: VisualMode;
	view: SidebarView;
}

/** Host actions the webview may trigger; only reached with validated input. */
export interface SidebarActions {
	runCommand(command: SidebarCommand): void;
	dismissOnboarding(): void;
}

export const DEFAULT_SNAPSHOT: SidebarSnapshot = {
	world: IDLE_WORLD,
	animation: DEFAULT_ANIMATION_SETTINGS,
	visualMode: DEFAULT_VISUAL_MODE,
	view: EMPTY_VIEW,
};

/** Sends only messages that pass the protocol check; returns whether it was sent. */
export function postToWebview(message: HostToWebviewMessage, send: SendToWebview): boolean {
	// Runtime check guards against extra fields (e.g. conversation content) slipping through.
	if (!isHostToWebviewMessage(message)) {
		return false;
	}
	send(message);
	return true;
}

/** Handles a raw message from the webview; invalid or unknown messages are ignored. */
export function handleWebviewMessage(
	message: unknown,
	send: SendToWebview,
	snapshot: SidebarSnapshot = DEFAULT_SNAPSHOT,
	actions?: SidebarActions,
): boolean {
	if (!isWebviewToHostMessage(message)) {
		return false;
	}
	switch (message.type) {
		case 'ready': {
			// Config first so the renderer never animates a state with stale settings.
			const configSent = postConfig(snapshot.animation, snapshot.visualMode, send);
			const stateSent = postWorldState(snapshot.world, send);
			return postView(snapshot.view, send) && stateSent && configSent;
		}
		case 'command':
			actions?.runCommand(message.command);
			return true;
		case 'dismissOnboarding':
			actions?.dismissOnboarding();
			return true;
	}
}

export function postConfig(animation: AnimationSettings, visualMode: VisualMode, send: SendToWebview): boolean {
	return postToWebview({ type: 'config', animationEnabled: animation.enabled, maxFps: animation.maxFps, visualMode }, send);
}

export function postWorldState(world: WorldSnapshot, send: SendToWebview): boolean {
	return postToWebview({ type: 'state', worldState: world.worldState, activeCount: world.activeCount }, send);
}

export function postView(view: SidebarView, send: SendToWebview): boolean {
	return postToWebview({ type: 'view', ...view }, send);
}
