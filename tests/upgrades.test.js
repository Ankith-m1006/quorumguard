import assert from "node:assert/strict";
import test from "node:test";
import { checkOffline } from "../src/guard.js";

// Real hashes from sputnik-dao.near get_contracts_metadata (mainnet, 11 Nov 2026).
const V32 = "DtHZA1mUmGYeScEaUoUZYQGGFHSMpnjMCvkr5U9hJXuF";
const RELEASES = [{ hash: "2Zof1Tyy4pMeJM48mDSi5ww2QQhTz97b9S8h6W6r4HnK", version: "3.0" }, { hash: V32, version: "3.2" }];
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const call = (receiver_id, actions) => ({ FunctionCall: { receiver_id, actions: actions.map(([method_name, args, deposit = "0"]) => ({ method_name, args: b64(args), deposit, gas: "150000000000000" })) } });
const fam = (r, f) => r.findings.filter((x) => x.family === f);

test("official Sputnik release passes as official", () => {
  const r = checkOffline({ description: "Upgrade to Sputnik v3.2", kind: { UpgradeSelf: { hash: V32 } } }, { releases: RELEASES });
  assert.equal(fam(r, "upgrade")[0].severity, "info");
  assert.match(fam(r, "upgrade")[0].why, /official Sputnik v3\.2/);
});

test("a hash one character short of a release is blocked as a look-alike", () => {
  // Same shape as deer.sputnik-dao.near #3 on mainnet.
  const r = checkOffline({ description: "Upgrade Sputnik-DAO Contract to 3.2", kind: { UpgradeSelf: { hash: V32.slice(0, -1) } } }, { releases: RELEASES });
  assert.equal(r.verdict, "BLOCK");
  assert.match(fam(r, "upgrade")[0].why, /only looks like official Sputnik v3\.2: it differs by 1 character/);
});

test("an unknown hash is blocked; a missing release list is reported as not checked", () => {
  const unknown = checkOffline({ description: "Fix a typo", kind: { UpgradeSelf: { hash: "8kLbPZf3bA9Y1mV2w3oQ7rN5sT6uX8yZ1aB2cD3eF4g" } } }, { releases: RELEASES });
  assert.equal(unknown.verdict, "BLOCK");
  assert.match(fam(unknown, "upgrade")[0].why, /not an official Sputnik release/);
  const noList = checkOffline({ description: "Upgrade", kind: { UpgradeSelf: { hash: V32 } } }, { releases: null });
  assert.equal(fam(noList, "upgrade").length, 0);
  assert.equal(noList.partly, true);
  assert.match(noList.notChecked[0], /official Sputnik releases could not be loaded/);
});

test("a harmless first call hiding a later transfer is blocked", () => {
  const r = checkOffline({ description: "Refresh the rewards settings.", kind: call("rewards.near", [["set_config", { rate: 5 }], ["ft_transfer", { receiver_id: "x.near", amount: "1000" }]]) });
  assert.equal(fam(r, "hidden-action")[0].severity, "block");
  assert.match(fam(r, "hidden-action")[0].why, /2 calls in one proposal; call #2 ft_transfer .* while call #1 looks harmless/);
});

test("two payments in one call warn, registration + one payment does not", () => {
  const two = checkOffline({ description: "Pay a.near and b.near", kind: call("usdt.near", [["ft_transfer", { receiver_id: "a.near", amount: "1" }], ["ft_transfer", { receiver_id: "b.near", amount: "2" }]]) });
  assert.equal(fam(two, "hidden-action")[0].severity, "warn");
  const reg = checkOffline({ description: "Pay a.near 1 USDT", kind: call("usdt.near", [["storage_deposit", { account_id: "a.near" }, "1250000000000000000000"], ["ft_transfer", { receiver_id: "a.near", amount: "1" }]]) });
  assert.equal(fam(reg, "hidden-action").length, 0);
});

test("a method QuorumGuard does not model makes the report partly checked", () => {
  const r = checkOffline({ description: "Donate 1 NEAR to the pot", kind: call("pot.near", [["donate", { message: "hi" }, "1000000000000000000000000"]]) });
  assert.equal(r.partly, true);
  assert.match(r.notChecked.join(" "), /does not model donate on pot\.near/);
});
