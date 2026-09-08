import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useTransport } from "@science-studio/transport-client";

/**
 * Message renderers. `MessagePrimitive.Parts` ships sensible web defaults for
 * every part type the wire contract produces — text, streaming (in-progress
 * indicator), reasoning, and tool-call (fallback UI with args/result) — so the
 * example adds no custom part components of its own.
 */
const UserMessage = () => (
  <div className="msg msg-user">
    <MessagePrimitive.Parts />
  </div>
);

const AssistantMessage = () => (
  <div className="msg msg-assistant">
    <MessagePrimitive.Parts />
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
  // a fresh page (and a page reload) converges to the full gateway history.
  const runtime = useTransport();

  return (
    <div className="page">
      <header className="header">
        <h1>transport-openclaw · assistant-ui</h1>
        <p>
          A live conversation with the OpenClaw gateway, driven by{" "}
          <code>@science-studio/transport-openclaw</code> behind the shared
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
            <ComposerPrimitive.Root className="composer">
              <ComposerPrimitive.Input
                className="composer-input"
                placeholder="Message the agent…"
                enterKeyHint="send"
                aria-label="Message input"
              />
              <ComposerPrimitive.Send className="composer-send">Send</ComposerPrimitive.Send>
            </ComposerPrimitive.Root>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </main>
    </div>
  );
}
