"use client";

import * as React from "react";

function isCollection(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value !== null;
}

function JsonNode({
  keyLabel,
  value,
  depth,
}: {
  keyLabel: string | null;
  value: unknown;
  depth: number;
}) {
  const [open, setOpen] = React.useState(depth < 2);

  if (isCollection(value)) {
    const isArray = Array.isArray(value);
    const entries: [string, unknown][] = isArray
      ? (value as unknown[]).map((item, i) => [String(i), item] as [string, unknown])
      : Object.entries(value as Record<string, unknown>);

    return (
      <div>
        <button
          type="button"
          className="font-mono text-xs text-foreground"
          onClick={() => setOpen((v) => !v)}
        >
          {keyLabel != null && <span>{JSON.stringify(keyLabel)}: </span>}
          <span className="text-muted-foreground">
            {isArray ? "[" : "{"} {entries.length} item(s)
          </span>
        </button>
        {open && (
          <div className="ml-4 border-l border-border pl-2">
            {entries.map(([k, v]) => (
              <JsonNode key={k} keyLabel={k} value={v} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const color =
    typeof value === "string"
      ? "text-emerald-700 dark:text-emerald-400"
      : typeof value === "number"
        ? "text-sky-700 dark:text-sky-400"
        : typeof value === "boolean"
          ? "text-amber-700 dark:text-amber-400"
          : "text-muted-foreground";

  return (
    <div className={`font-mono text-xs ${color}`}>
      {keyLabel != null && <span className="text-foreground">{JSON.stringify(keyLabel)}: </span>}
      {JSON.stringify(value)}
    </div>
  );
}

export function JsonRenderer({ content }: { content: string }) {
  const data = React.useMemo<
    { ok: true; value: unknown } | { ok: false; error: string }
  >(() => {
    try {
      return { ok: true, value: JSON.parse(content) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [content]);

  if (!data.ok) {
    return (
      <div className="flex-1 p-4 text-sm text-destructive">
        JSON parse failed: {data.error}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <JsonNode keyLabel={null} value={data.value} depth={0} />
    </div>
  );
}
