"use client";

import { memo } from "react";
import { formatNumber } from "@/lib/status-board-layout";
import type { StatusBlock, StatusCell } from "@/lib/status-board-types";
import { MarkdownBody } from "./MarkdownBody";

/**
 * Rich content of a status item (`blocks`, validated by
 * lib/status-board-blocks.ts). Agents describe content; the look comes from
 * here and status-board.css, always with theme colors.
 */

/** Values the caller chose to show: up to 6 significant digits, not the compact chart format. */
function cellText(value: StatusCell): string {
  if (value === null) return "";
  return typeof value === "number" ? String(Number(value.toPrecision(6))) : value;
}

function Caption({ text }: { text?: string }) {
  return text ? <div className="status-block-title">{text}</div> : null;
}

type Chart = Extract<StatusBlock, { type: "chart" }>;

function ChartBlock({ block }: { block: Chart }) {
  const all = block.series.flatMap((series) => series.points);
  if (all.length === 0) return null;
  const xs = all.map(([x]) => x);
  const ys = all.map(([, y]) => y);
  const minX = Math.min(...xs);
  const spanX = Math.max(...xs) - minX || 1;
  // Bars grow from zero; lines use the data range.
  const minY = block.chart === "bar" ? Math.min(0, ...ys) : Math.min(...ys);
  const maxY = block.chart === "bar" ? Math.max(0, ...ys) : Math.max(...ys);
  const spanY = maxY - minY || 1;
  const y = (value: number) => 38 - ((value - minY) / spanY) * 36;
  const categories = [...new Set(xs)].sort((a, b) => a - b);
  let body;
  if (block.chart === "bar") {
    const slot = 100 / categories.length;
    const width = (slot * 0.8) / block.series.length;
    body = block.series.flatMap((series, s) => series.points.map(([px, py], n) => {
      const left = categories.indexOf(px) * slot + slot * 0.1 + s * width;
      const top = Math.min(y(py), y(0));
      return <rect key={`${s}-${n}`} className={`status-series-${s}`} x={left} y={top} width={Math.max(width - 0.4, 0.3)} height={Math.max(Math.abs(y(py) - y(0)), 0.3)} fill="currentColor" />;
    }));
  } else {
    body = block.series.map((series, s) => (
      <polyline
        key={s}
        className={`status-series-${s}`}
        points={series.points.map(([px, py]) => `${((px - minX) / spanX) * 100},${y(py)}`).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    ));
  }
  return (
    <figure className="status-chart">
      <Caption text={block.title} />
      <div className="status-chart-plot">
        <div className="status-chart-axis" aria-hidden="true">
          <span>{formatNumber(maxY)}</span>
          {block.yLabel && <span className="status-chart-ylabel">{block.yLabel}</span>}
          <span>{formatNumber(minY)}</span>
        </div>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={block.title ?? block.series.map((series) => series.name).join(", ")}>
          {body}
        </svg>
      </div>
      {block.chart === "line" ? (
        <div className="status-chart-xaxis" aria-hidden="true">
          <span>{formatNumber(minX)}</span>
          {block.xLabel && <span>{block.xLabel}</span>}
          <span>{formatNumber(minX + spanX)}</span>
        </div>
      ) : categories.length <= 24 && (
        <div className="status-chart-xaxis status-chart-categories" aria-hidden="true">
          {categories.map((category) => <span key={category}>{formatNumber(category)}</span>)}
        </div>
      )}
      {block.chart === "bar" && block.xLabel && <div className="status-chart-xaxis" aria-hidden="true"><span />{block.xLabel}<span /></div>}
      <figcaption className="status-chart-legend">
        {block.series.map((series, s) => (
          <span key={s} className={`status-series-${s}`}>
            <i aria-hidden="true" />
            {series.name}
            {series.points.length > 0 && <b>{formatNumber(series.points.at(-1)![1])}</b>}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

function Block({ block }: { block: StatusBlock }) {
  switch (block.type) {
    case "markdown":
      return <MarkdownBody className="status-block-markdown" suppressImages>{block.text}</MarkdownBody>;
    case "kv":
      return (
        <div>
          <Caption text={block.title} />
          <dl className="status-kv">
            {block.entries.map((entry, index) => (
              <div key={index} data-state={entry.state}>
                <dt title={entry.label}>{entry.label}</dt>
                <dd>{cellText(entry.value)}{entry.unit ? ` ${entry.unit}` : ""}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "table": {
      // Number columns (every filled cell a number) align right, header included.
      const numeric = block.columns.map((_, c) => block.rows.some((row) => row[c] !== null) && block.rows.every((row) => row[c] === null || typeof row[c] === "number"));
      return (
        <div>
          <Caption text={block.title} />
          <div className="status-table-wrap">
            <table className="status-table">
              <thead><tr>{block.columns.map((column, index) => <th key={index} data-number={numeric[index] || undefined}>{column}</th>)}</tr></thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>{row.map((value, c) => <td key={c} data-number={typeof value === "number" || undefined}>{cellText(value)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    case "progress": {
      const percent = Math.max(0, Math.min(100, (block.value / block.max) * 100));
      return (
        <div className="status-subprogress" data-state={block.state}>
          <div className="status-subprogress-head">
            <span title={block.label}>{block.label}</span>
            <span>{Math.floor(percent)}% · {formatNumber(block.value)}/{formatNumber(block.max)}{block.unit ? ` ${block.unit}` : ""}</span>
          </div>
          <div className="status-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={block.label}>
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      );
    }
    case "chart":
      return <ChartBlock block={block} />;
    case "code":
      return (
        <div>
          <Caption text={block.title} />
          <pre className="status-code">{block.text}</pre>
        </div>
      );
  }
}

export const StatusBlocks = memo(function StatusBlocks({ blocks }: { blocks: StatusBlock[] }) {
  return (
    <div className="status-blocks">
      {blocks.map((block, index) => <Block key={index} block={block} />)}
    </div>
  );
});
