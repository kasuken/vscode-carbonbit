import * as assert from 'assert';
import { formatCarbon, formatEnergy, formatTokens, formatWater } from '../core/impact/units';

suite('Metric units', () => {
	test('energy switches from Wh to kWh at 1000 Wh', () => {
		const cases: [number, string][] = [
			[0, '0 Wh'], [0.004, '<0.01 Wh'], [0.42, '0.42 Wh'], [0.045, '0.045 Wh'], [3.456, '3.46 Wh'], [12.34, '12.3 Wh'],
			[999.4, '999 Wh'], [999.6, '1 kWh'], [1000, '1 kWh'], [1500, '1.5 kWh'], [123_456, '123 kWh'],
		];
		for (const [wh, text] of cases) {
			assert.strictEqual(formatEnergy(wh).text, text, String(wh));
		}
	});

	test('carbon switches from g to kg CO₂e at 1000 g', () => {
		assert.deepStrictEqual(formatCarbon(0.24), { value: '0.24', unit: 'g CO₂e', text: '0.24 g CO₂e' });
		assert.strictEqual(formatCarbon(999).text, '999 g CO₂e');
		assert.strictEqual(formatCarbon(1000).text, '1 kg CO₂e');
		assert.strictEqual(formatCarbon(2500).text, '2.5 kg CO₂e');
	});

	test('water switches from ml to L at 1 L', () => {
		assert.strictEqual(formatWater(0.0042).text, '4.2 ml');
		assert.strictEqual(formatWater(0.00000495).text, '<0.01 ml');
		assert.strictEqual(formatWater(0.00045).text, '0.45 ml');
		assert.strictEqual(formatWater(0.9994).text, '999 ml');
		assert.strictEqual(formatWater(1).text, '1 L');
		assert.strictEqual(formatWater(12.5).text, '12.5 L');
		assert.strictEqual(formatWater(6003.4).text, '6,003 L', 'the largest unit groups thousands');
		assert.strictEqual(formatCarbon(1_234_567).text, '1,235 kg CO₂e');
	});

	test('token counts use compact K/M suffixes', () => {
		const cases: [number, string][] = [
			[0, '0'], [-3, '0'], [NaN, '0'], [17, '17'], [999, '999'], [999.6, '1K'], [1234, '1.2K'], [9960, '10K'],
			[124_000, '124K'], [999_600, '1M'], [1_200_000, '1.2M'], [42_000_000, '42M'], [3_000_000_000, '3B'],
		];
		for (const [tokens, text] of cases) {
			assert.strictEqual(formatTokens(tokens), text, String(tokens));
		}
	});

	test('invalid or negative input renders as zero', () => {
		for (const value of [NaN, -1, Infinity]) {
			assert.strictEqual(formatEnergy(value).text, '0 Wh', String(value));
		}
	});
});
