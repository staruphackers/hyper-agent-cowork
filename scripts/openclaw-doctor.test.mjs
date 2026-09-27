import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { evaluateOpenClawAgents, findRedactedPaths, formatReport } from "./openclaw-doctor.mjs";

const pem = () =>
  crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const healthy = (overrides = {}) => ({
  id: "769acbc6-0000-0000-0000-000000000000",
  name: "Dahye",
  status: "idle",
  adapterConfig: {
    url: "wss://openclaw.example.test/",
    headers: { "x-openclaw-token": "gateway-token-value" },
    devicePrivateKeyPem: pem(),
    scopes: ["operator.admin"],
    ...overrides,
  },
});

const levels = (results, check) => results.filter((row) => row.check === check).map((row) => row.level);

test("a correctly configured agent has no FAIL or WARN", () => {
  const results = evaluateOpenClawAgents([healthy()]);
  assert.deepEqual(results.filter((row) => row.level === "FAIL" || row.level === "WARN"), []);
});

test("masked placeholders, a broken key and a missing token all FAIL", () => {
  const results = evaluateOpenClawAgents([
    healthy({ devicePrivateKeyPem: "***REDACTED***", headers: {} }),
  ]);
  assert.deepEqual(levels(results, "masked-placeholder"), ["FAIL"]);
  assert.deepEqual(levels(results, "device-key"), ["FAIL"]);
  assert.deepEqual(levels(results, "gateway-token"), ["FAIL"]);
});

test("a gateway token saved as the masked placeholder does not count as set", () => {
  const results = evaluateOpenClawAgents([healthy({ headers: { "x-openclaw-token": "***REDACTED***" } })]);
  assert.deepEqual(levels(results, "gateway-token"), ["FAIL"]);
});

test("disabled device auth FAILs even when stored as the string true", () => {
  assert.deepEqual(levels(evaluateOpenClawAgents([healthy({ disableDeviceAuth: "true" })]), "device-auth"), ["FAIL"]);
});

test("a boolean flag saved as the masked placeholder is caught", () => {
  const results = evaluateOpenClawAgents([healthy({ disableDeviceAuth: "***REDACTED***" })]);
  assert.deepEqual(levels(results, "masked-placeholder"), ["FAIL"]);
});

test("two live agents on the same gateway are reported as duplicates", () => {
  const results = evaluateOpenClawAgents([
    healthy(),
    { ...healthy({ url: "wss://OPENCLAW.example.test" }), id: "5bd59426-0000", name: "Dahye 2" },
  ]);
  assert.deepEqual(levels(results, "duplicate-agent"), ["WARN"]);
});

test("the report never contains secret values", () => {
  const key = pem();
  const report = formatReport(
    evaluateOpenClawAgents([healthy({ devicePrivateKeyPem: key, headers: { "x-openclaw-token": "super-secret-token" } })]),
  );
  assert.ok(!report.includes("super-secret-token"));
  assert.ok(!report.includes("PRIVATE KEY"));
});

test("findRedactedPaths lists setting names only", () => {
  assert.deepEqual(findRedactedPaths({ a: { b: "***REDACTED***" }, c: ["ok", "***REDACTED***"] }), ["a.b", "c[1]"]);
});
