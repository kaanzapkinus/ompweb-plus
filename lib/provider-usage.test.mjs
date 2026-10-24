import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { parseProviderUsageOutput, getProviderUsage } = await jiti.import("./provider-usage.ts");
test("parseProviderUsageOutput selects matching model windows", () => {
  const now = Date.UTC(2026, 7, 27, 12, 0, 0);
  const output = JSON.stringify({
    generatedAt: 123,
    reports: [
      {
        provider: "openai-codex",
        metadata: { email: "account@example.com", planType: "plus" },
        limits: [
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "5h" },
            amount: { usedFraction: 0.09 },
            window: { resetsAt: now + (2 * 60 + 39) * 60_000 },
          },
          {
            scope: { modelId: "gpt-5.6-luna", windowId: "7d" },
            amount: { usedFraction: 0.04 },
            window: { resetsAt: now + (5 * 24 + 20) * 3_600_000 },
          },
          {
            scope: { modelId: "other-model", windowId: "5h" },
            amount: { usedFraction: 0.88 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
      {
        provider: "ollama",
        limits: [
          {
            scope: { windowId: "5h" },
            amount: { usedFraction: 0.5 },
            window: { resetsAt: now + 60_000 },
          },
        ],
      },
    ],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "openai-codex", modelId: "GPT-5.6-LUNA" }, now), {
    generatedAt: 123,
    reports: [{
      provider: "openai-codex",
      accountLabel: "account@example.com",
      accountIndex: 1,
      plan: "plus",
      modelId: "gpt-5.6-luna",
      fiveHour: { percent: 9, resetMinutes: 159, resetsAt: now + 159 * 60_000 },
      sevenDay: { percent: 4, resetHours: 140, resetsAt: now + 140 * 3_600_000 },
    }],
  });
});

test("parseProviderUsageOutput selects the binding meter for repeated windows", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: { resetsAt: now + 60_000 } },
        { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 0.7 }, window: { resetsAt: now + 30 * 60_000 } },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now).reports[0]?.fiveHour, {
    percent: 70,
    resetMinutes: 30,
    resetsAt: now + 30 * 60_000,
  });
});
test("parseProviderUsageOutput returns every model when no model is selected", () => {
  const output = JSON.stringify({
    reports: [{
      provider: "provider",
      metadata: { accountId: "account-1" },
      limits: [
        { scope: { modelId: "model-a", windowId: "5h" }, amount: { usedFraction: 0.1 }, window: {} },
        { scope: { modelId: "model-a", windowId: "7d" }, amount: { usedFraction: 0.2 }, window: {} },
        { scope: { modelId: "model-b", windowId: "5h" }, amount: { usedFraction: 0.3 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }), {
    generatedAt: null,
    reports: [
      {
        provider: "provider",
        accountIndex: 1,
        modelId: "model-a",
        fiveHour: { percent: 10 },
        sevenDay: { percent: 20 },
      },
      {
        provider: "provider",
        accountIndex: 1,
        modelId: "model-b",
        fiveHour: { percent: 30 },
      },
    ],
  });
});

test("parseProviderUsageOutput keeps accounts without reported limits", () => {
  const output = JSON.stringify({
    reports: [{ provider: "ollama", metadata: { email: "ollama@example.com" }, limits: [] }],
  });

  assert.deepEqual(parseProviderUsageOutput(output), {
    generatedAt: null,
    reports: [{
      provider: "ollama",
      accountLabel: "ollama@example.com",
      accountIndex: 1,
      noLimits: true,
    }],
  });
});

test("parseProviderUsageOutput falls back to duration and ignores malformed limits", () => {
  const now = 1_000_000;
  const output = JSON.stringify({
    generatedAt: "not-a-number",
    reports: [{
      provider: "provider",
      limits: [
        {
          scope: {},
          amount: { usedFraction: 0.12 },
          window: { durationMs: 30 * 24 * 60 * 60 * 1000, resetsAt: now + 48 * 3_600_000 },
        },
        { scope: { windowId: "5h" }, amount: { usedFraction: "bad" }, window: {} },
        { scope: { windowId: "unknown" }, amount: { usedFraction: 0.2 }, window: {} },
      ],
    }],
  });

  assert.deepEqual(parseProviderUsageOutput(output, { provider: "provider" }, now), {
    generatedAt: null,
    reports: [{
      provider: "provider",
      accountIndex: 1,
      monthly: { percent: 12, resetHours: 48, resetsAt: now + 48 * 3_600_000 },
    }],
  });
});

test("quota reset timestamps remain exact and missing timestamps are never derived from durations", () => {
  const output = JSON.stringify({ reports: [{
    provider: "provider",
    limits: [
      { scope: { modelId: "model", windowId: "5h" }, amount: { usedFraction: 1 }, window: { resetsAt: 9_876_543 } },
      { scope: { modelId: "model", windowId: "7d" }, amount: { usedFraction: 0.5 }, window: { durationMs: 7 * 24 * 3_600_000 } },
    ],
  }] });
  const report = parseProviderUsageOutput(output, { provider: "provider" }, 1_000_000).reports[0];
  assert.equal(report.fiveHour.resetsAt, 9_876_543);
  assert.equal(Object.hasOwn(report.sevenDay, "resetsAt"), false);
});

test("parseProviderUsageOutput rejects invalid JSON", () => {
  assert.throws(() => parseProviderUsageOutput("not-json"), /invalid JSON/);
});

test("manual refresh replaces cached limits while automatic reads keep using the cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ompweb-provider-usage-"));
  const script = join(dir, "omp.cjs");
  const bin = process.platform === "win32" ? join(dir, "omp.cmd") : script;
  const data = join(dir, "usage.json");
  const cache = join(dir, "cached-usage.json");
  const failOnce = join(dir, "fail-once");
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  const usage = (fraction) => JSON.stringify({
    reports: [{
      provider: "provider",
      limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: fraction }, window: {} }],
    }],
  });
  try {
    await writeFile(script, `#!${process.execPath}
const fs = require("node:fs");
const cache = ${JSON.stringify(cache)};
const failOnce = ${JSON.stringify(failOnce)};
if (process.argv.includes("--redact")) {
  // Redaction turns account emails into "an*" in the sidebar.
  process.exit(2);
} else if (process.argv[3] === "invalidate") {
  fs.rmSync(cache, { force: true });
} else if (fs.existsSync(failOnce)) {
  fs.rmSync(failOnce);
  setTimeout(() => process.exit(1), 100);
} else {
  if (!fs.existsSync(cache)) fs.copyFileSync(${JSON.stringify(data)}, cache);
  process.stdout.write(fs.readFileSync(cache, "utf8"));
}
`, { mode: 0o755 });
    if (process.platform === "win32") await writeFile(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    process.env.OMP_WEB_OMP_BIN = bin;
    await writeFile(data, usage(0.1));
    await writeFile(failOnce, "");
    const automatic = getProviderUsage();
    const manual = getProviderUsage({}, true);
    await Promise.all([
      assert.rejects(automatic),
      manual.then((report) => assert.equal(report.reports[0].fiveHour.percent, 10, "manual refresh must recover after an overlapping automatic fetch fails")),
    ]);
    await writeFile(data, usage(0.8));
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 10);
    assert.equal((await getProviderUsage({}, true)).reports[0].fiveHour.percent, 80);
    await writeFile(data, usage(0.4));
    assert.equal((await getProviderUsage()).reports[0].fiveHour.percent, 80);
  } finally {
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic quota waits use only exhausted applicable windows of one unambiguous account", async () => {
  const { providerQuotaResetTime } = await jiti.import("./provider-usage.ts");
  const model = { provider: "p", modelId: "m" };
  const now = 1_790_000_000_000;
  const report = { provider: "p", accountIndex: 1, fiveHour: { percent: 100, resetsAt: now + 60_000 }, sevenDay: { percent: 31, resetsAt: now + 600_000 } };
  const select = (reports) => providerQuotaResetTime({ generatedAt: now, reports }, model, now);
  assert.equal(select([report]), now + 60_000);
  assert.equal(select([{ ...report, sevenDay: { percent: 100, resetsAt: now + 600_000 } }]), now + 600_000);
  assert.equal(select([{ ...report, sevenDay: { percent: 100 } }]), null);
  assert.equal(select([{ ...report, fiveHour: { percent: 7, resetsAt: now + 60_000 } }]), null);
  assert.equal(select([{ ...report, modelId: "M" }]), null);
  assert.equal(select([{ ...report, tier: "premium" }]), null);
  assert.equal(select([report, { ...report, accountIndex: 2 }]), null);
  assert.equal(select([report, { ...report, modelId: "m", fiveHour: { percent: 100, resetsAt: now + 120_000 } }]), now + 120_000);
  assert.equal(select([{ ...report, fiveHour: { percent: 100, resetsAt: now - 1 } }]), null);
});

test("labeled account scopes share raw report identity without merging same-email credentials", async () => {
  const { providerQuotaResetTime } = await jiti.import("./provider-usage.ts");
  const now = 1_790_000_000_000;
  const raw = {
    provider: "p", metadata: { email: "same@example.com" },
    limits: [
      { scope: { windowId: "5h" }, amount: { usedFraction: 1 }, window: { resetsAt: now + 60_000 } },
      { scope: { windowId: "7d", modelId: "m" }, amount: { usedFraction: 1 }, window: { resetsAt: now + 120_000 } },
    ],
  };
  const one = parseProviderUsageOutput(JSON.stringify({ reports: [raw] }), { provider: "p" }, now);
  assert.equal(providerQuotaResetTime(one, { provider: "p", modelId: "m" }, now), now + 120_000);
  const two = parseProviderUsageOutput(JSON.stringify({ reports: [raw, raw] }), { provider: "p" }, now);
  assert.equal(providerQuotaResetTime(two, { provider: "p", modelId: "m" }, now), null);
});
