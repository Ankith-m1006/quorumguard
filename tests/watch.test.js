import assert from "node:assert/strict";
import test from "node:test";
import { proposalsInBlock } from "../src/watch.js";

// Shape copied from a real neardata.xyz block (shards[].receipt_execution_outcomes[]).
const outcome = (receiver, method, status, pred = "alice.near") => ({
  execution_outcome: { outcome: { status } },
  receipt: { predecessor_id: pred, receiver_id: receiver, receipt: { Action: { actions: [{ FunctionCall: { method_name: method, args: "e30=", deposit: "0", gas: 1 } }] } } },
  tx_hash: "TX",
});
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");

test("finds new proposals and their ids", () => {
  const block = { shards: [{ receipt_execution_outcomes: [
    outcome("build.sputnik-dao.near", "add_proposal", { SuccessValue: b64(287) }),
    outcome("build.sputnik-dao.near", "act_proposal", { SuccessValue: "" }),           // a vote, not a proposal
    outcome("build.sputnik-dao.near", "add_proposal", { Failure: { ActionError: {} } }), // failed
    outcome("token.near", "add_proposal", { SuccessValue: b64(5) }),                    // not a Sputnik DAO
  ] }] };
  assert.deepEqual(proposalsInBlock(block), [{ dao: "build.sputnik-dao.near", id: 287, proposer: "alice.near", tx: "TX" }]);
});

test("empty or skipped blocks are fine", () => {
  assert.deepEqual(proposalsInBlock(null), []);
  assert.deepEqual(proposalsInBlock({ shards: [] }), []);
});
