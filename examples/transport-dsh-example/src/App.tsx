import { memo } from "react";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import {
  useTransport,
} from "@science-studio/transport-client";
import { MarkdownText } from "./markdown";
import { AssistantReasoning } from "./reasoning-panel";
import { Composer } from "./composer";

/**
 * Message renderers. Assistant text parts render as GitHub-flavored markdown
 * (`MarkdownText`, see `markdown.tsx`); reasoning gets the static-variant
 * reasoning panel (see `reasoning-panel.tsx`) — core ships no default for
 * either, so without these a reply would be raw text and a thinking trace
 * invisible. User messages keep the default plain text renderer.
 */
const UserMessage = () => (
  <div className="msg msg-user">
    <MessagePrimitive.Parts />
  </div>
);

const AssistantMessage = () => (
  <div className="msg msg-assistant">
    {/* Reasoning leads the turn, so the panel sits above the other parts. */}
    <AssistantReasoning />
    <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
    <MessagePrimitive.Error>
      <p className="error">Something went wrong.</p>
    </MessagePrimitive.Error>
  </div>
);

/**
 * The app shell, memoized: `useTransport` must not be called by a component
 * that re-renders. Assistant-ui rebuilds its internal thread-list adapter on
 * every invocation, and a re-render of the owning component reads as an adapter
 * swap — it tears the active thread down and starts an empty one, wiping the
 * transcript (see `useTransport`). This shell holds no state, so `memo` (no
 * props) keeps the hook inert against re-renders from above.
 */
export default memo(function App() {
  // The single session hook: assistant-ui transport runtime over the
  // transport-service, with the history loaded on mount (command-less probe —
  // the backend reconciles against its canonical transcript, restored from the
  // adapter's own mirror after a service restart) and the standing watch
  // adopted (canonical-snapshot pushes from the transport-service).
  const runtime = useTransport();

  return (
    <div className="page">
      <header className="header">
        <h1>transport-dsh · assistant-ui</h1>
        <p>
          A live conversation with a DeepSeek Harness runtime, driven by{" "}
          <code>@science-studio/transport-dsh</code> behind the shared
          transport-service and rendered by assistant-ui.
        </p>
      </header>
      <main className="thread-wrap">
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="thread">
            <ThreadPrimitive.Viewport className="thread-viewport">
              <ThreadPrimitive.Messages
                components={{ UserMessage, AssistantMessage }}
              />
            </ThreadPrimitive.Viewport>
            <Composer />
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </main>
    </div>
  );
});
