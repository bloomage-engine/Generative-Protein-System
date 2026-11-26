"use client";

import { useMemo, useState } from "react";
import type { MsaUnaligned } from "../formats.js";
import type { MsaTarget } from "../mention.js";

export interface UnalignedListProps {
  data: MsaUnaligned;
  className?: string;
  onMention?: (target: MsaTarget) => void;
}

export function UnalignedList({ data, className, onMention }: UnalignedListProps) {
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? data.sequences : data.sequences.filter((s) => s.name.toLowerCase().includes(q));
  }, [data.sequences, query]);
  const totalLength = rows.reduce((a, s) => a + s.seq.length, 0);

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 8px", fontSize: 12 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sequences…"
          aria-label="Search sequences"
          style={{ fontSize: 12, padding: "2px 6px", border: "1px solid rgba(148,163,184,0.4)", borderRadius: 4, background: "transparent", color: "inherit" }}
        />
        <span style={{ opacity: 0.7 }}>
          {rows.length} sequences · {totalLength.toLocaleString()} aa total (unaligned — no columns)
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)" }}>sequence</th>
              <th style={{ textAlign: "right", padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)" }}>length</th>
              <th style={{ padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)" }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: "2px 8px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{s.name}</td>
                <td style={{ padding: "2px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.seq.length}</td>
                <td style={{ padding: "2px 8px", textAlign: "right" }}>
                  <button
                    type="button"
                    disabled={s.seq.length === 0}
                    onClick={() => onMention?.({ seqName: s.name, start: 1, end: s.seq.length })}
                    style={{ fontSize: 11, cursor: "pointer" }}
                  >
                    insert
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
