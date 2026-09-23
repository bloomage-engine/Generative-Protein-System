"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { MsaAligned } from "../formats.js";
import { DEFAULT_CONSERVED, columnStats, isConservedCol, tableStats } from "../stats.js";
import type { MsaTarget } from "../mention.js";
import {
  PLAIN_TEXT_CELL_LIMIT,
  columnsToKeep,
  conservationBandColor,
  filterRowsByQuery,
  groupSpans,
  rowWindow,
  rulerLine,
  shouldUsePlainText,
} from "../grid.js";

const ROW_HEIGHT = 20;
const OVERSCAN = 4;
const NAME_WIDTH = 168; // px
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

type CellClass = "seq" | "gap" | "conserved" | "selected" | "hoverCell" | "hoverRow" | "hoverCol";

const CELL_COLOR: Partial<Record<CellClass, string>> = {
  gap: "#9aa0a6",
  conserved: "#e8590c",
  selected: "#1d4ed8",
  hoverCell: "#7c3aed",
  hoverRow: "#475569",
  hoverCol: "#475569",
};
const CELL_BG: Partial<Record<CellClass, string>> = {
  selected: "#dbeafe",
  hoverCell: "#ede9fe",
  hoverRow: "#f1f5f9",
  hoverCol: "#f8fafc",
};

export interface MsaGridProps {
  data: MsaAligned;
  className?: string;
  /** Double-click (or a run) reports the target back; the host toggles the mention. */
  onMention?: (target: MsaTarget) => void;
}

interface Drag {
  seqName: string;
  anchor: number; // 0-based ORIGINAL column index
}

export function MsaGrid({ data, className, onMention }: MsaGridProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [hover, setHover] = useState<{ row: string; col: number } | null>(null);
  const [selection, setSelection] = useState<MsaTarget | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [query, setQuery] = useState("");
  const [conservedOnly, setConservedOnly] = useState(false);
  const [hideGaps, setHideGaps] = useState(false);
  const [showBand, setShowBand] = useState(true);
  const [showStats, setShowStats] = useState(false);
  const charProbeRef = useRef<HTMLSpanElement | null>(null);
  const [charWidth, setCharWidth] = useState(7.2);

  // Measure one character so column hit-testing matches the rendered grid.
  useLayoutEffect(() => {
    const el = charProbeRef.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width > 0) setCharWidth(width / 10);
  });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = (): void => setViewport(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (drag === null) return;
    const finish = (): void => setDrag(null);
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [drag]);

  const colStats = useMemo(() => columnStats(data), [data]);
  const rows = useMemo(() => filterRowsByQuery(data.sequences, query), [data.sequences, query]);
  const keep = useMemo(
    () => columnsToKeep(data.columns, data.sequences, colStats, { conservedOnly, hideGaps }, DEFAULT_CONSERVED),
    [data.columns, data.sequences, colStats, conservedOnly, hideGaps],
  );
  const keepSet = useMemo(() => new Set(keep), [keep]);
  const table = useMemo(() => tableStats(data), [data]);
  const plain = shouldUsePlainText(data.sequences.length, data.columns);

  const windowed = rowWindow(rows.length, scrollTop, viewport > 0 ? viewport : 480, ROW_HEIGHT, OVERSCAN);
  const visible = rows.slice(windowed.start, windowed.start + windowed.count);

  const inSelection = useCallback(
    (seqName: string, col: number) =>
      selection !== null &&
      selection.seqName === seqName &&
      col >= selection.start - 1 &&
      col <= selection.end - 1,
    [selection],
  );

  const cellClass = (char: string, seqName: string, col: number): CellClass => {
    if (inSelection(seqName, col)) return "selected";
    if (hover !== null) {
      if (hover.row === seqName && hover.col === col) return "hoverCell";
      if (hover.row === seqName) return "hoverRow";
      if (hover.col === col) return "hoverCol";
    }
    if (char === "-" || char === undefined) return "gap";
    const st = colStats[col];
    if (st !== undefined && isConservedCol(st, DEFAULT_CONSERVED)) return "conserved";
    return "seq";
  };

  const columnFromEvent = (e: ReactMouseEvent<HTMLDivElement>, rowEl: HTMLDivElement): number => {
    const rect = rowEl.getBoundingClientRect();
    const x = e.clientX - rect.left - NAME_WIDTH;
    if (x < 0) return -1;
    const colInText = Math.floor(x / charWidth);
    const c = keep[colInText];
    return c === undefined ? -1 : c;
  };

  const onRowMouseDown = (e: ReactMouseEvent<HTMLDivElement>, seqName: string): void => {
    const col = columnFromEvent(e, e.currentTarget);
    if (col < 0) return;
    e.preventDefault();
    if (inSelection(seqName, col)) {
      setSelection(null); // a second click on the selected cell clears it
      return;
    }
    setDrag({ seqName, anchor: col });
    setSelection({ seqName, start: col + 1, end: col + 1 });
  };

  const onRowMouseMove = (e: ReactMouseEvent<HTMLDivElement>, seqName: string): void => {
    const col = columnFromEvent(e, e.currentTarget);
    if (col < 0) {
      setHover(null);
      return;
    }
    setHover({ row: seqName, col });
    if (drag !== null && drag.seqName === seqName && e.buttons === 1) {
      const start = Math.min(drag.anchor, col);
      const end = Math.max(drag.anchor, col);
      setSelection({ seqName, start: start + 1, end: end + 1 });
    }
  };

  const onRowDoubleClick = (e: ReactMouseEvent<HTMLDivElement>, seqName: string): void => {
    if (!onMention) return;
    const col = columnFromEvent(e, e.currentTarget);
    const target =
      col >= 0 && selection !== null && inSelection(seqName, col)
        ? { seqName, start: selection.start, end: selection.end }
        : { seqName, start: col + 1, end: col + 1 };
    setSelection({ seqName, start: target.start, end: target.end });
    onMention(target);
  };

  const gridWidth = NAME_WIDTH + (plain ? data.columns : keep.length) * charWidth + 8;
  const hoverStat = hover !== null ? colStats[hover.col] : undefined;

  const inputStyle: CSSProperties = {
    fontSize: 12,
    padding: "2px 6px",
    border: "1px solid rgba(148,163,184,0.4)",
    borderRadius: 4,
    background: "transparent",
    color: "inherit",
  };
  const labelStyle: CSSProperties = { fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" };

  return (
    <div
      className={className}
      style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelection(null);
          setHover(null);
        }
      }}
      onMouseLeave={() => setHover(null)}
    >
      {/* Toolbar */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "4px 8px" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sequences…"
          aria-label="Search sequences"
          style={inputStyle}
        />
        <label style={labelStyle}>
          <input type="checkbox" checked={conservedOnly} disabled={plain} onChange={(e) => setConservedOnly(e.target.checked)} />
          conserved only
        </label>
        <label style={labelStyle}>
          <input type="checkbox" checked={hideGaps} disabled={plain} onChange={(e) => setHideGaps(e.target.checked)} />
          hide gaps
        </label>
        <label style={labelStyle}>
          <input type="checkbox" checked={showBand} disabled={plain} onChange={(e) => setShowBand(e.target.checked)} />
          conservation band
        </label>
        <button type="button" style={{ fontSize: 12 }} onClick={() => setShowStats((v) => !v)}>
          {showStats ? "hide stats" : "show stats"}
        </button>
      </div>

      {showStats && (
        <div style={{ fontSize: 12, padding: "0 8px 4px", opacity: 0.85 }}>
          {table.sequences} sequences · {table.columns} columns · avg identity{" "}
          {(table.averageIdentity * 100).toFixed(1)}% · {table.conservedColumns} conserved columns
        </div>
      )}

      {plain && (
        <p style={{ fontSize: 12, padding: "0 8px 4px", opacity: 0.8 }}>
          {(data.sequences.length * data.columns).toLocaleString()} cells is above{" "}
          {PLAIN_TEXT_CELL_LIMIT.toLocaleString()} — showing the plain-text view (search still works;
          selection, the band and the column filters are disabled at this size).
        </p>
      )}

      <div
        ref={scrollerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: `${ROW_HEIGHT}px`,
        }}
      >
        {/* Sticky header: annotations, conservation band, ruler */}
        <div style={{ position: "sticky", top: 0, zIndex: 2, background: "transparent" }}>
          <span ref={charProbeRef} aria-hidden style={{ visibility: "hidden", display: "block", height: 0, overflow: "hidden" }}>
            0000000000
          </span>
          {data.annotations.map((a) => (
            <div key={`${a.label}`} style={{ display: "flex", whiteSpace: "pre", height: 16, color: "#64748b" }}>
              <span
                style={{ width: NAME_WIDTH, flex: "0 0 auto", overflow: "hidden", textOverflow: "ellipsis" }}
                title={a.label}
              >
                {a.label}
              </span>
              <span style={{ overflow: "hidden" }}>{keep.map((c) => a.chars[c] ?? "·").join("")}</span>
            </div>
          ))}
          {!plain && showBand && (
            <div style={{ display: "flex", whiteSpace: "pre", height: 6 }}>
              <span style={{ width: NAME_WIDTH, flex: "0 0 auto" }} />
              {groupSpans("·".repeat(keep.length), (i) => {
                const c = keep[i];
                const st = c === undefined ? undefined : colStats[c];
                return conservationBandColor(st?.identity ?? 0, st?.gapFraction ?? 1);
              }).map((sp, k) => (
                <span key={k} style={{ color: sp.cls }}>
                  {sp.text}
                </span>
              ))}
            </div>
          )}
          {!plain && (
            <div style={{ display: "flex", whiteSpace: "pre", height: 14, color: "#64748b" }}>
              <span style={{ width: NAME_WIDTH, flex: "0 0 auto" }} />
              <span>{rulerLine(data.columns, keepSet)}</span>
            </div>
          )}
        </div>

        {/* Virtualized body */}
        <div style={{ position: "relative", height: rows.length * ROW_HEIGHT, width: gridWidth }}>
          {visible.map((s, i) => {
            const y = (windowed.start + i) * ROW_HEIGHT;
            return (
              <div
                key={`${s.name}-${windowed.start + i}`}
                style={{ position: "absolute", top: y, left: 0, width: "100%", height: ROW_HEIGHT, whiteSpace: "pre" }}
                onMouseDown={(e) => onRowMouseDown(e, s.name)}
                onMouseMove={(e) => onRowMouseMove(e, s.name)}
                onDoubleClick={(e) => onRowDoubleClick(e, s.name)}
              >
                <span
                  style={{ display: "inline-block", width: NAME_WIDTH, overflow: "hidden", textOverflow: "ellipsis", opacity: 0.9 }}
                  title={s.name}
                >
                  {s.name}
                </span>
                {plain ? (
                  <span style={{ opacity: 0.9 }}>{s.seq}</span>
                ) : (
                  groupSpans(
                    keep.map((c) => s.seq[c] ?? "-").join(""),
                    (i) => cellClass(keep[i] === undefined ? "-" : s.seq[keep[i]!] ?? "-", s.name, keep[i] ?? -1),
                  ).map((sp, k) => (
                    <span key={k} style={{ color: CELL_COLOR[sp.cls as CellClass], background: CELL_BG[sp.cls as CellClass] }}>
                      {sp.text}
                    </span>
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer: hover info + selection + hint */}
      <div style={{ fontSize: 11, padding: "3px 8px", opacity: 0.85, display: "flex", gap: 12, alignItems: "center" }}>
        {hover !== null && hoverStat !== undefined ? (
          <span>
            {hover.row}:{hover.col + 1} · identity {(hoverStat.identity * 100).toFixed(0)}% · gap{" "}
            {(hoverStat.gapFraction * 100).toFixed(0)}%
          </span>
        ) : (
          <span>click selects · drag selects a run · double-click inserts the mention · Esc clears</span>
        )}
        {selection !== null && (
          <span>
            selected {selection.seqName}:{selection.start}
            {selection.end !== selection.start ? `–${selection.end}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
