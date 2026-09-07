import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalletMonitorState, checkWalletShortfall } from "../src/risk/wallet-monitor.ts";

test("checkWalletShortfall does not warn when available balance covers cashUsd", () => {
  const state = createWalletMonitorState();
  const { warning } = checkWalletShortfall(state, 100, 100, 1000);
  assert.equal(warning, null);
});

test("checkWalletShortfall ignores a small, immaterial difference", () => {
  const state = createWalletMonitorState();
  // $2 short on $1000 maxCapitalUsd — well under the 5%/$1 tolerance floor... actually
  // tolerance = max(1, 1000*0.05) = 50, so $2 is well within tolerance.
  const { warning } = checkWalletShortfall(state, 98, 100, 1000);
  assert.equal(warning, null);
});

test("checkWalletShortfall does not warn on a single check even for a material shortfall", () => {
  const first = checkWalletShortfall(createWalletMonitorState(), 20, 100, 1000); // $80 short, well over tolerance
  assert.equal(first.warning, null, "one check alone must not trigger the warning");
  assert.equal(first.state.shortfallStreak, 1);
});

test("checkWalletShortfall warns after the required number of consecutive shortfalls", () => {
  let state = createWalletMonitorState();
  let warning: string | null = null;
  for (let i = 0; i < 3; i++) {
    ({ state, warning } = checkWalletShortfall(state, 20, 100, 1000));
  }
  assert(warning !== null, "3 consecutive material shortfalls must trigger the warning by default");
  assert.match(warning!, /Bybit available balance/);
});

test("checkWalletShortfall keeps warning on every subsequent check once triggered", () => {
  let state = createWalletMonitorState();
  for (let i = 0; i < 3; i++) ({ state } = checkWalletShortfall(state, 20, 100, 1000));
  const { warning } = checkWalletShortfall(state, 20, 100, 1000); // 4th check
  assert(warning !== null, "must not require re-accumulating the streak once already active");
});

test("checkWalletShortfall clears immediately once the shortfall resolves", () => {
  let state = createWalletMonitorState();
  for (let i = 0; i < 3; i++) ({ state } = checkWalletShortfall(state, 20, 100, 1000));
  const recovered = checkWalletShortfall(state, 100, 100, 1000); // balance is fine again
  assert.equal(recovered.warning, null);
  assert.equal(recovered.state.shortfallStreak, 0);
  assert.equal(recovered.state.warningActive, false);
});

test("checkWalletShortfall resets the streak on an intermittent recovery (no false-positive carryover)", () => {
  let state = createWalletMonitorState();
  ({ state } = checkWalletShortfall(state, 20, 100, 1000)); // streak 1
  ({ state } = checkWalletShortfall(state, 100, 100, 1000)); // recovers — resets to 0
  assert.equal(state.shortfallStreak, 0);
  ({ state } = checkWalletShortfall(state, 20, 100, 1000)); // streak 1 again, not 3
  const { warning } = checkWalletShortfall(state, 20, 100, 1000); // streak 2
  assert.equal(warning, null, "an intermittent recovery must not let the streak carry over toward the threshold");
});
