"use client";

export function PlainTextRenderer({ content }: { content: string }) {
  return (
    <pre className="flex-1 overflow-auto p-6 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
      {content}
    </pre>
  );
}
