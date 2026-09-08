import { useEffect } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useTransportRuntime } from "./runtime";
import { createInitialRuntimeState, fetchSessionSnapshot } from "./session-sync";

const API = "/api/transport";

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
  const runtime = useTransportRuntime();

  useEffect(() => {
    // Load the session's history on first mount: the transport runtime only
    // starts a request when the user sends a message, so fire a command-less
    // probe and import the returned snapshot. The backend reconciles every
    // client against its canonical transcript, so a fresh page (and a page
    // reload) converges to the full gateway history.
    let cancelled = false;
    void (async () => {
      const snapshot = await fetchSessionSnapshot(API, createInitialRuntimeState(), null);
      if (cancelled || snapshot === null) return;
      const threadState = runtime.thread.getState();
      // If a send started while the probe was in flight, that run's own
      // reconcile already streamed the history — importing an older snapshot
      // here could clobber it.
      if (
        threadState.isRunning ||
        threadState.isLoading ||
        threadState.messages.length > 0
      ) {
        return;
      }
      runtime.thread.importExternalState(snapshot);
    })();
    return () => {
      cancelled = true;
    };
  }, [runtime]);

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
                components={{ UserMessage: UserMessage, AssistantMessage: AssistantMessage }}
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
