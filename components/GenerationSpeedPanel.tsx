"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { useI18n } from "@/lib/i18n";
import { InfoHint } from "@/components/ui/primitives";
import { formatCompactNumber } from "@/lib/format";
import { generationSpeedTier, summarizeGenerationSpeed, type GenerationSpeedSample } from "@/lib/generation-speed";

const SAMPLE_COUNTS = [20, 50, 100] as const;

const rate = (value: number) => value.toFixed(1);
const seconds = (ms: number) => (ms / 1000).toFixed(1);

/**
 * Bar chart of the last N completed requests' tok/s (omp's definition:
 * output tokens / whole request time) with summary statistics beside it.
 * Hover, click or arrow keys pick the bar whose details are shown.
 */
export function GenerationSpeedPanel({ samples }: { samples: readonly GenerationSpeedSample[] }) {
  const { t, locale } = useI18n();
  const detailId = useId();
  const [count, setCount] = useState<number>(SAMPLE_COUNTS[0]);
  const [picked, setPicked] = useState<number | null>(null);
  const shown = samples.slice(-count);
  const stats = summarizeGenerationSpeed(shown);
  // Index into `shown`; defaults to the newest request.
  const active = picked !== null && picked < shown.length ? picked : shown.length - 1;
  const sample = shown[active];
  const scaleMax = stats ? Math.max(10, Math.ceil(stats.max / 10) * 10) : 10;

  const onChartKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (shown.length === 0) return;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setPicked(event.key === "Home" ? 0 : shown.length - 1);
    } else if (step !== 0) {
      event.preventDefault();
      setPicked(Math.min(shown.length - 1, Math.max(0, active + step)));
    }
  };

  const statRows: Array<[string, string]> = stats ? [
    [t("speedPanel.mean"), rate(stats.mean)],
    [t("speedPanel.tokenWeightedMean"), rate(stats.tokenWeightedMean)],
    [t("speedPanel.median"), rate(stats.median)],
    ["P10 / P90", `${rate(stats.p10)} / ${rate(stats.p90)}`],
    [t("speedPanel.minMax"), `${rate(stats.min)} / ${rate(stats.max)}`],
    [t("speedPanel.stdDev"), rate(stats.stdDev)],
    [t("speedPanel.meanDecode"), stats.meanDecodeTps === null ? "—" : rate(stats.meanDecodeTps)],
    [t("speedPanel.meanTtft"), stats.meanTtftMs === null ? "—" : `${seconds(stats.meanTtftMs)} s`],
    [t("speedPanel.totalOutput"), formatCompactNumber(stats.totalOutputTokens)],
  ] : [];

  return (
    <div className="speed-panel">
      <div className="speed-panel-header">
        <span className="speed-panel-title">
          {t("speedPanel.title")}
          <InfoHint label={t("speedPanel.formulaLabel")} side="bottom">{t("speedPanel.formula")}</InfoHint>
        </span>
        <div className="speed-panel-counts" role="group" aria-label={t("speedPanel.sampleCount")}>
          {SAMPLE_COUNTS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={count === option}
              onClick={() => { setCount(option); setPicked(null); }}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {!stats || !sample ? (
        <p className="speed-panel-empty">{t("speedPanel.empty")}</p>
      ) : (
        <div className="speed-panel-body">
          <div className="speed-panel-chart-column">
            <div
              className="speed-panel-chart"
              role="group"
              tabIndex={0}
              aria-label={t("speedPanel.chartLabel", { count: shown.length })}
              aria-describedby={detailId}
              onKeyDown={onChartKey}
              onMouseLeave={() => setPicked(null)}
            >
              <span className="speed-panel-axis">{scaleMax} t/s</span>
              <span
                className="speed-panel-mean-line"
                style={{ bottom: `${(stats.mean / scaleMax) * 100}%` }}
                title={t("speedPanel.meanLine", { value: rate(stats.mean) })}
              >
                <span className="speed-panel-mean-label">{t("speedPanel.meanShort")}</span>
              </span>
              {shown.map((entry, index) => (
                <span
                  key={`${entry.timestamp ?? "x"}-${index}`}
                  className="speed-panel-bar"
                  data-active={index === active || undefined}
                  onMouseEnter={() => setPicked(index)}
                  onClick={() => setPicked(index)}
                  style={{
                    height: `${Math.max(1.5, (entry.tps / scaleMax) * 100)}%`,
                    background: `var(--status-${generationSpeedTier(entry.tps)})`,
                  }}
                />
              ))}
            </div>
            <p id={detailId} className="speed-panel-detail" aria-live="polite">
              <strong>{t("speedPanel.requestNumber", { index: samples.length - shown.length + active + 1 })}</strong>
              {sample.timestamp !== null && <> · {new Date(sample.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</>}
              {" · "}<strong style={{ color: `var(--status-${generationSpeedTier(sample.tps)})` }}>{rate(sample.tps)} t/s</strong>
              {" · "}{t("speedPanel.outputOverTime", { tokens: formatCompactNumber(sample.outputTokens), seconds: seconds(sample.durationMs) })}
              {sample.ttftMs !== null && <> · {t("speedPanel.ttft", { seconds: seconds(sample.ttftMs) })}</>}
              {sample.decodeTps !== null && <> · {t("speedPanel.decode", { tps: rate(sample.decodeTps) })}</>}
              {sample.model && <> · {sample.model}</>}
            </p>
          </div>
          <dl className="speed-panel-stats">
            {statRows.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
