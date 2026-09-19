/**
 * Conformance suites for the Science Studio seams.
 *
 * These are not tests of this package — they are the SHARED contract every
 * implementation must satisfy, published so the open-core boundary is
 * verifiable: the OSS reference implementations run them here, and the private
 * enterprise module (plus any third-party runtime) runs the same suites in its
 * own CI. See docs/design/implementation-plan.md §5.
 *
 * Each `test*` function registers `node:test` cases; call it from a test file.
 */
export {
  testPrincipalResolver,
  type PrincipalResolverCase,
} from "./principal-resolver.js";
export {
  testWorkspace,
  type WorkspaceFixture,
  type WorkspaceUnderTest,
} from "./workspace.js";
export {
  testRuntimeFactory,
  type RuntimeFactoryCase,
} from "./runtime-factory.js";
export {
  testAdapterLifecycle,
  type AdapterLifecycleCase,
} from "./adapter-lifecycle.js";
export { testQuotaPolicy, type QuotaPolicyCase } from "./quota-policy.js";
export { sessionState } from "./session-state.js";
export {
  testResolveSessionKey,
  type ResolveSessionKeyCase,
} from "./resolve-session-key.js";
export { testSubagents, type SubagentsCase } from "./subagents.js";
export { testTranscriptAndSubagent, type TranscriptAndSubagentCase } from "./transcript-subagent.js";
