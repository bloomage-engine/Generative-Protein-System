"use client";

import { Fragment, useMemo, useState, type CSSProperties } from "react";
import type { MmseqsResult } from "../formats.js";

export interface MsaResultTableProps {
  data: MmseqsResult;
  className?: string;
}

interface Sort {
  field: number;
  dir: 1 | -1;
}

const TH: CSSProperties = { textAlign: "left", padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.4)", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };
const TD: CSSProperties = { padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.13)", whiteSpace: "nowrap" };
const NUM_INPUT: CSSProperties = { width: 64, fontSize: 12, padding: "1px 4px", border: "1px solid rgba(148,163,184,0.4)", borderRadius: 4, background: "transparent", color: "inherit" };

export function MsaResultTable({ data, className }: MsaResultTableProps) {
  const [sort, setSort] = useState<Sort>({ field: 9, dir: 1 }); // evalue ascending
  const [identityMin, setIdentityMin] = useState(30);
  const [evalueMax, setEvalueMax] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  const idIdx = data.fields.indexOf("id");
  const evIdx = data.fields.indexOf("evalue");
  const alignIdx = data.fields.lastIndexOf("alignment");

  const rows = useMemo(() => {
    const filtered = data.rows.filter((r) => {
      if (idIdx !== -1) {
        const v = r[idIdx];
        if (typeof v === "number" && v < identityMin) return false;
      }
      if (evIdx !== -1) {
        const v = r[evIdx];
        if (typeof v === "number" && v > evalueMax) return false;
      }
      return true;
    });
    return [...filtered].sort((a, b) => {
      const av = a[sort.field];
      const bv = b[sort.field];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * sort.dir;
    });
  }, [data.rows, identityMin, evalueMax, sort, idIdx, evIdx]);

  const toggleSort = (i: number): void =>
    setSort((s) => (s.field === i ? { field: i, dir: (s.dir * -1) as 1 | -1 } : { field: i, dir: 1 }));

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", padding: "4px 8px", fontSize: 12 }}>
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          identity ≥
          <input type="number" min={0} max={100} value={identityMin} onChange={(e) => setIdentityMin(Math.max(0, Number(e.target.value) || 0))} style={NUM_INPUT} />
        </label>
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          E-value ≤
          <input type="number" min={0} step="any" value={evalueMax} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) setEvalueMax(v); }} style={{ ...NUM_INPUT, width: 80 }} />
        </label>
        <span style={{ opacity: 0.7 }}>
          {rows.length.toLocaleString()} of {data.rows.length.toLocaleString()} hits
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "0 8px" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {data.fields.map((f, i) => (
                <th key={`${f}-${i}`} style={TH} onClick={() => toggleSort(i)}>
                  {f}
                  {sort.field === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => {
              const key = `${String(r[0])}|${String(r[1])}|${String(r[3] ?? "")}|${String(r[4] ?? "")}|${idx}`;
              const alignVal = alignIdx === -1 ? undefined : r[alignIdx];
              const hasAlign = typeof alignVal === "string" && alignVal.length > 0;
              return (
                <Fragment key={key}>
                  <tr
                    style={expanded === key ? { background: "rgba(148,163,184,0.08)" } : undefined}
                    onClick={() => hasAlign && setExpanded(expanded === key ? null : key)}
                  >
                    {data.fields.map((f, i) => {
                      const v = r[i];
                      return (
                        <td key={`${f}-${i}`} style={TD}>
                          {hasAlign && i === 0 ? "▸ " : ""}
                          {v === null || v === undefined ? "" : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                  {expanded === key && hasAlign && (
                    <tr>
                      <td colSpan={data.fields.length} style={{ padding: "4px 8px" }}>
                        <pre
                          style={{
                            margin: 0,
                            fontSize: 11,
                            lineHeight: "16px",
                            whiteSpace: "pre-wrap",
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                          }}
                        >
                          {alignVal}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, fontSize: 11, padding: "4px 8px", opacity: 0.7 }}>
        click a hit row to show the raw mmseqs alignment string for that pair
      </p>
    </div>
  );
}
