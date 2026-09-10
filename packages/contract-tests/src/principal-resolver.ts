/**
 * Conformance suite for `PrincipalResolver`.
 *
 * Any implementation — the OSS `LocalPrincipalResolver` or the private
 * enterprise bearer resolver — must satisfy these cases. Registered with
 * `node:test`, so a consumer just calls it from one of its own test files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrincipalResolver, RequestContext } from "@science-studio/transport";

export interface PrincipalResolverCase {
  /** A request the resolver MUST authenticate. */
  accepted: RequestContext;
  /** A request the resolver MUST reject (omit when it never rejects). */
  rejected?: RequestContext;
}

export function testPrincipalResolver(
  name: string,
  make: () => PrincipalResolver | Promise<PrincipalResolver>,
  cases: PrincipalResolverCase,
): void {
  test(`${name}: resolves an accepted request to a well-formed Principal`, async () => {
    const resolver = await make();
    const principal = await resolver.resolve(cases.accepted);
    assert.ok(principal, "an accepted request must resolve");
    assert.equal(typeof principal.id, "string");
    assert.ok(principal.id.length > 0, "id must be non-empty");
    assert.equal(typeof principal.tenant, "string");
    assert.ok(principal.tenant.length > 0, "tenant must be non-empty");
    assert.equal(typeof principal.displayName, "string");
    assert.ok(Array.isArray(principal.roles), "roles must be an array");
    assert.equal(typeof principal.local, "boolean");
    if (principal.local) {
      // A credential-less identity owns its own trust boundary.
      assert.equal(principal.tenant, principal.id, "a local principal owns its own tenant");
    }
  });

  if (cases.rejected) {
    test(`${name}: rejects an unauthenticated request`, async () => {
      const resolver = await make();
      assert.equal(await resolver.resolve(cases.rejected!), null);
    });
  }
}
