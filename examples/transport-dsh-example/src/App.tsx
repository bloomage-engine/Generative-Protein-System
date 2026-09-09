import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import {
  useTransport,
  useTransportWatch,
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

export default function App() {
  // useTransport also loads the session's history on mount: the transport
  // runtime only starts a request when the user sends a message, so the
  // package fires a command-less probe and imports the returned snapshot.
  // The backend reconciles every client against its canonical transcript, so
  // a fresh page (and a page reload) converges to the full history — the dsh
  // adapter restores its own persisted transcript mirror on service restarts.
  const runtime = useTransport();
  // Standing watch: adopt canonical-snapshot pushes from the transport-service.
  // dsh sessions have a single writer (this adapter), so the adapter only ever
  // pushes a baseline snapshot on attach — keeping the watch consumer on the
  // same code path as the openclaw example with no remote turns to adopt.
  useTransportWatch(runtime);

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
}
