"use client";

import { Bot } from "lucide-react";
import type { Message, MessagePart, SubagentTranscript } from "@science-studio/transport";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";

/**
 * One delegated session's record: the child's own conversation folded from
 * the harness's durable log (docs/adr/0016 addendum). Text renders as
 * markdown; tool calls as compact collapsible rows — the workbench's
 * vocabulary, not the harness's.
 */
export function TranscriptBody({ transcript }: { transcript: SubagentTranscript }) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
        <Bot className="size-3.5" />
        {transcript.provider ? <span>{transcript.provider}</span> : null}
        {transcript.agentProvider && transcript.agentModel ? (
          <span>
            {transcript.agentProvider}/{transcript.agentModel}
          </span>
        ) : null}
        {transcript.startedAt ? <span>started {new Date(transcript.startedAt).toLocaleString()}</span> : null}
        {transcript.finishedAt ? <span>ended {new Date(transcript.finishedAt).toLocaleString()}</span> : null}
        {transcript.status ? <span>{transcript.status}</span> : null}
      </div>
      {transcript.messages.map((message) => (
        <TranscriptMessage key={message.id} message={message} />
      ))}
    </div>
  );
}

function TranscriptMessage({ message }: { message: Message }) {
  return (
    <section
      className={cn(
        "border-border/60 rounded-md border p-2",
        message.role === "user" && "border-accent/60",
      )}
    >
      <div className="text-muted-foreground mb-1 text-[10px] font-medium uppercase tracking-wide">
        {message.role}
      </div>
      <div className="flex flex-col gap-2">
        {message.parts.map((part, index) => (
          <TranscriptPart key={partKey(part, index)} part={part} />
        ))}
      </div>
    </section>
  );
}

function partKey(part: MessagePart, index: number): string {
  return part.type === "tool-call" ? part.id : `${part.type}-${index}`;
}

function TranscriptPart({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "text":
      return (
        <div>
          <MarkdownRenderer content={part.text} />
        </div>
      );
    case "reasoning":
      return (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer text-[11px]">Reasoning</summary>
          <div className="mt-1 text-xs opacity-80">
            <MarkdownRenderer content={part.text} />
          </div>
        </details>
      );
    case "tool-call":
      return (
        <details className="bg-muted/40 rounded border border-border/50 p-1.5 text-xs">
          <summary className="cursor-pointer font-medium">{part.name}</summary>
          {part.args ? (
            <pre className="mt-1 max-h-40 overflow-auto text-[11px]">{part.args}</pre>
          ) : null}
          {part.result !== undefined ? (
            <pre className="mt-1 max-h-40 overflow-auto text-[11px]">{part.result}</pre>
          ) : null}
        </details>
      );
    default:
      return null;
  }
}
