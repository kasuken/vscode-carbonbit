import * as assert from 'assert';
import type { AiUsageEvent } from '../core/usage/usageEvent';
import { Intensity } from '../core/world/worldIntensity';
import { DEFAULT_WORLD_TIMINGS, WorldSnapshot, WorldStateEngine } from '../core/world/worldStateEngine';
import { FakeClock } from './fakeClock';

const { requestStartingMs, responseArrivingMs, failedMs, staleRequestMs, agentLoopGapMs } = DEFAULT_WORLD_TIMINGS;

function ev(id: string, status: AiUsageEvent['status'], model?: Intensity): AiUsageEvent {
	return { id, provider: 'github-copilot', model, startedAt: '2026-10-01T10:00:00.000Z', source: 'actual', status };
}

// The model field carries the intensity so engine tests don't depend on the classifier heuristic.
function setup() {
	const clock = new FakeClock();
	const changes: WorldSnapshot[] = [];
	const engine = new WorldStateEngine(s => changes.push(s), { clock, classify: e => (e.model as Intensity) ?? 'medium' });
	const states = () => changes.map(c => `${c.worldState}/${c.activeCount}`);
	return { clock, engine, changes, states };
}

suite('WorldStateEngine', () => {
	test('runs a request through starting, processing, arriving and back to idle', () => {
		const { clock, engine, states } = setup();
		assert.deepStrictEqual(engine.current, { worldState: 'Idle', activeCount: 0 });
		engine.handle(ev('a', 'started', 'heavy'));
		clock.advance(requestStartingMs - 1);
		assert.strictEqual(engine.current.worldState, 'RequestStarting');
		clock.advance(1);
		engine.handle(ev('a', 'completed'));
		clock.advance(responseArrivingMs);
		assert.deepStrictEqual(states(), ['RequestStarting/1', 'ProcessingHeavy/1', 'ResponseArriving/0', 'Idle/0']);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	test('repeated and late events are idempotent', () => {
		const { clock, engine, states } = setup();
		engine.handle(ev('a', 'started'));
		engine.handle(ev('a', 'started'));
		clock.advance(requestStartingMs);
		engine.handle(ev('a', 'processing'));
		engine.handle(ev('a', 'processing'));
		engine.handle(ev('a', 'completed'));
		engine.handle(ev('a', 'completed'));
		engine.handle(ev('a', 'processing'));
		clock.advance(responseArrivingMs);
		engine.handle(ev('a', 'started'));
		assert.deepStrictEqual(states(), ['RequestStarting/1', 'ProcessingMedium/1', 'ResponseArriving/0', 'Idle/0']);
	});

	test('overlapping requests show the heaviest active intensity', () => {
		const { clock, engine, states } = setup();
		engine.handle(ev('a', 'started', 'light'));
		clock.advance(requestStartingMs);
		engine.handle(ev('b', 'processing', 'heavy'));
		clock.advance(requestStartingMs);
		engine.handle(ev('b', 'completed'));
		clock.advance(responseArrivingMs);
		engine.handle(ev('a', 'failed'));
		clock.advance(failedMs);
		assert.deepStrictEqual(states(), [
			'RequestStarting/1', 'ProcessingLight/1',
			'RequestStarting/2', 'ProcessingHeavy/2',
			'ResponseArriving/1', 'ProcessingLight/1',
			'Failed/0', 'Idle/0',
		]);
	});

	test('a request never downgrades its intensity mid-flight', () => {
		const { clock, engine } = setup();
		engine.handle(ev('a', 'started', 'heavy'));
		engine.handle(ev('a', 'processing', 'light'));
		clock.advance(requestStartingMs);
		assert.strictEqual(engine.current.worldState, 'ProcessingHeavy');
	});

	test('a failure keeps its minimum display time while new requests start', () => {
		const { clock, engine, states } = setup();
		engine.handle(ev('a', 'failed'));
		clock.advance(100);
		engine.handle(ev('b', 'started', 'light'));
		clock.advance(failedMs - 101);
		assert.strictEqual(engine.current.worldState, 'Failed');
		clock.advance(1);
		assert.deepStrictEqual(states(), ['Failed/0', 'Failed/1', 'ProcessingLight/1']);
	});

	test('a finished event without a prior start still shows its outcome', () => {
		const { clock, engine, states } = setup();
		engine.handle(ev('a', 'completed'));
		clock.advance(responseArrivingMs);
		assert.deepStrictEqual(states(), ['ResponseArriving/0', 'Idle/0']);
	});

	test('a request that never completes is dropped after the stale timeout', () => {
		const { clock, engine, states } = setup();
		engine.handle(ev('a', 'started'));
		clock.advance(staleRequestMs - 1);
		engine.handle(ev('a', 'processing'));
		clock.advance(staleRequestMs - 1);
		assert.strictEqual(engine.current.worldState, 'ProcessingMedium');
		clock.advance(1);
		assert.deepStrictEqual(states(), ['RequestStarting/1', 'ProcessingMedium/1', 'Idle/0']);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	test('dispose cancels pending transitions', () => {
		const { clock, engine, states } = setup();
		engine.handle(ev('a', 'started'));
		engine.dispose();
		clock.advance(staleRequestMs);
		assert.deepStrictEqual(states(), ['RequestStarting/1']);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	test('consecutive completions of a per-call provider keep the world processing between calls', () => {
		const { clock, engine, states } = setup();
		const call = (id: string, model: Intensity) => engine.handle({ ...ev(id, 'completed', model), provider: 'claude-code' });
		// Claude Code writes each call only once it has finished: completions with tool runs in between.
		call('c1', 'medium');
		clock.advance(5000);
		call('c2', 'heavy');
		clock.advance(responseArrivingMs);
		assert.strictEqual(engine.current.worldState, 'ProcessingHeavy', 'busy while the next call runs');
		clock.advance(4000);
		call('c3', 'light');
		clock.advance(agentLoopGapMs - 1);
		assert.deepStrictEqual(engine.current, { worldState: 'ProcessingHeavy', activeCount: 0 }, 'a loop never downgrades');
		clock.advance(1);
		assert.deepStrictEqual(states(), [
			'ResponseArriving/0', 'Idle/0',
			'ResponseArriving/0', 'ProcessingHeavy/0',
			'ResponseArriving/0', 'ProcessingHeavy/0', 'Idle/0',
		]);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	test('a lone completion, distant completions and per-turn providers only pulse', () => {
		const { clock, engine, states } = setup();
		engine.handle({ ...ev('c1', 'completed'), provider: 'github-copilot-cli' });
		clock.advance(agentLoopGapMs);
		engine.handle({ ...ev('c2', 'completed'), provider: 'github-copilot-cli' });
		clock.advance(responseArrivingMs);
		// Copilot Chat requests are whole turns with their own in-flight phase.
		engine.handle(ev('t1', 'completed'));
		clock.advance(1000);
		engine.handle(ev('t2', 'completed'));
		clock.advance(responseArrivingMs);
		assert.deepStrictEqual(states(), ['ResponseArriving/0', 'Idle/0', 'ResponseArriving/0', 'Idle/0', 'ResponseArriving/0', 'Idle/0']);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	test('a running loop combines with in-flight requests and failures do not extend it', () => {
		const { clock, engine, states } = setup();
		const claude = (id: string, status: AiUsageEvent['status'], model?: Intensity) => engine.handle({ ...ev(id, status, model), provider: 'claude-code' });
		claude('s1', 'processing', 'light');
		clock.advance(requestStartingMs);
		claude('s1', 'completed', 'light');
		clock.advance(2000);
		claude('s2', 'completed', 'light');
		clock.advance(responseArrivingMs);
		engine.handle(ev('chat', 'started', 'medium'));
		clock.advance(requestStartingMs);
		engine.handle(ev('chat', 'completed'));
		clock.advance(responseArrivingMs);
		claude('s3', 'failed');
		clock.advance(agentLoopGapMs);
		assert.deepStrictEqual(states(), [
			'RequestStarting/1', 'ProcessingLight/1', 'ResponseArriving/0', 'Idle/0',
			'ResponseArriving/0', 'ProcessingLight/0',
			'RequestStarting/1', 'ProcessingMedium/1', 'ResponseArriving/0', 'ProcessingLight/0',
			'Failed/0', 'ProcessingLight/0', 'Idle/0',
		]);
		assert.strictEqual(clock.pendingTimers, 0);
	});

	test('the agent loop heuristic can be disabled', () => {
		const clock = new FakeClock();
		const changes: string[] = [];
		const engine = new WorldStateEngine(s => changes.push(s.worldState), { clock, timings: { agentLoopGapMs: 0 } });
		engine.handle({ ...ev('c1', 'completed'), provider: 'claude-code' });
		clock.advance(responseArrivingMs);
		engine.handle({ ...ev('c2', 'completed'), provider: 'claude-code' });
		clock.advance(responseArrivingMs);
		assert.deepStrictEqual(changes, ['ResponseArriving', 'Idle', 'ResponseArriving', 'Idle']);
		assert.strictEqual(clock.pendingTimers, 0);
	});
});
