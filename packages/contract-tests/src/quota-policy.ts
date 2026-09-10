/**
 * Conformance suite for `QuotaPolicy`.
 *
 * Deliberately minimal: the only universal rule is that a policy never rejects
 * a zero-byte check (a request that stores nothing is always admissible). An
 * implementation that enforces a real quota supplies an `overage` delta that
 * MUST be rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Principal, QuotaPolicy } from "@science-studio/transport";

export interface QuotaPolicyCase {
  /** The principal to check against. */
  principal: Principal;
  /** A byte delta that must be accepted. */
  allowed: number;
  /** A byte delta that must be rejected, when the policy enforces a quota. */
  overage?: number;
}

export function testQuotaPolicy(
  name: string,
  make: () => QuotaPolicy | Promise<QuotaPolicy>,
  cases: QuotaPolicyCase,
): void {
  test(`${name}: admits a permitted delta`, async () => {
    const policy = await make();
    await policy.check(cases.principal, cases.allowed);
  });

  test(`${name}: admits a zero-byte check`, async () => {
    const policy = await make();
    await policy.check(cases.principal, 0);
  });

  if (cases.overage !== undefined) {
    test(`${name}: rejects an over-quota delta`, async () => {
      const policy = await make();
      await assert.rejects(() => policy.check(cases.principal, cases.overage!));
    });
  }
}
