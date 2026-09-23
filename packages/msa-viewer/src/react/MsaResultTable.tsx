"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { MmseqsResult } from "../formats.js";

export interface MsaResultTableProps {
  data: MmseqsResult;
  className?: string;
}

interface Sort {
  field: number;
  dir: 1 | -1;
}

const TH: CSSProperties = {
  textAlign: "left",
  padding: "2px 8px",
  borderBottom: "1px solid rgba(148,163,184,0.4)",
  cursor: "pointer",
  userSelect: "none",
  whiteSpace: "nowrap",
};
const TD: CSSProperties = { padding: "2px 8px", borderBottom: "1px solid rgba(148,163,184,0.13)", whiteSpace: "nowrap" };
const TD_NUM: CSSProperties = { ...TD, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const NUM_INPUT: CSSProperties = {
  width: 64,
  fontSize: 12,
  padding: "1px 4px",
  border: "1px solid rgba(148,163,184,0.4)",
  borderRadius: 4,
  background: "transparent",
  color: "inherit",
};

/**
 * The mmseqs2 hit table. Columns come from the parsed canonical order
 * (query, target, pident, length, mismatch, gapopen, qstart, qend, tstart, tend,
 * evalue, [score]) — the real `easy-search` layout, so the identity filter reads
 * `pident` and the E-value filter reads the real `evalue` column.
 */
export function MsaResultTable({ data, className }: MsaResultTableProps) {
  const [sort, setSort] = useState<Sort>({ field: Math.max(0, data.fields.indexOf("evalue")), dir: 1 }); // evalue ascending
  const [identityMin, setIdentityMin] = useState(30);
  const [evalueMax, setEvalueMax] = useState(1);

  const idIdx = data.fields.indexOf("pident");
  const evIdx = data.fields.indexOf("evalue");

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
          <input
            type="number"
            min={0}
            max={100}
            value={identityMin}
            onChange={(e) => setIdentityMin(Math.max(0, Number(e.target.value) || 0))}
            style={NUM_INPUT}
          />
        </label>
        <label style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          E-value ≤
          <input
            type="number"
            min={0}
            step="any"
            value={evalueMax}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") return; // clearing the field must not hide every row
              const v = Number(raw);
              if (Number.isFinite(v)) setEvalueMax(v);
            }}
            style={{ ...NUM_INPUT, width: 80 }}
          />
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
            {rows.map((r, idx) => (
              <tr key={`${String(r[0])}|${String(r[1])}|${idx}`}>
                {data.fields.map((f, i) => (
                  <td key={`${f}-${i}`} style={i >= 2 ? TD_NUM : TD}>
                    {r[i] === null || r[i] === undefined ? "" : String(r[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, fontSize: 11, padding: "4px 8px", opacity: 0.7 }}>
        click a column header to sort · identity is the percent identity (pident) · the E-value cap hides weak hits
      </p>
    </div>
  );
}
