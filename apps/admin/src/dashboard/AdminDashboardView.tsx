import type {
  AdminDashboardChartPoint,
  AdminDashboardLargestSong,
  AdminDashboardMetric,
  AdminDashboardRequestTrendPoint,
  AdminDashboardRecentRequest,
  AdminDashboardSongRank,
  AdminDashboardTrendRange,
  AdminDashboardUserRank
} from "@home-ktv/domain";
import type { CSSProperties, ReactNode } from "react";
import { ResponsiveLine } from "@nivo/line";
import { ResponsivePie } from "@nivo/pie";
import { useState } from "react";
import { useI18n } from "../i18n.js";
import { useAdminDashboard } from "./use-admin-dashboard.js";

const chartColors = ["#29d8ff", "#ffd166", "#6cff9d", "#ff4d7a", "#9b8cff", "#ff8bd2", "#72f0ff", "#f7a55a"];
const trendRanges = ["7d", "30d", "3m", "1y"] as const satisfies readonly AdminDashboardTrendRange[];

function chartColor(index: number): string {
  return chartColors[index % chartColors.length] ?? chartColors[0]!;
}

export function AdminDashboardView() {
  const { t } = useI18n();
  const [trendRange, setTrendRange] = useState<AdminDashboardTrendRange>("30d");
  const dashboard = useAdminDashboard(trendRange);
  const data = dashboard.data;

  if (dashboard.isLoading) {
    return <main className="admin-dashboard dashboard-state">{t("common.loading")}</main>;
  }

  if (dashboard.isError || !data) {
    return (
      <main className="admin-dashboard dashboard-state">
        <p>{t("dashboard.loadFailed")}</p>
        <button className="secondary-button" type="button" onClick={() => void dashboard.refetch()}>
          {t("dashboard.refresh")}
        </button>
      </main>
    );
  }

  return (
    <main className="admin-dashboard" aria-label={t("dashboard.aria")}>
      <header className="dashboard-hero">
        <div>
          <span className="admin-eyebrow">{t("dashboard.eyebrow")}</span>
          <h1>{t("dashboard.title")}</h1>
          <p>{t("dashboard.description")}</p>
        </div>
        <div className="dashboard-health-strip" aria-label={t("dashboard.health")}>
          <HealthItem label={t("dashboard.probeCoverage")} value={formatPercent(data.health.probeCoveragePercent)} />
          <HealthItem label={t("dashboard.missingAssets")} value={formatInteger(data.health.missingAssetCount)} tone="warning" />
          <HealthItem label={t("dashboard.lowConfidence")} value={formatInteger(data.health.lowConfidenceCount)} tone="danger" />
          <button className="secondary-button" type="button" onClick={() => void dashboard.refetch()}>
            {dashboard.isFetching ? t("common.refreshing") : t("dashboard.refresh")}
          </button>
        </div>
      </header>

      <section className="dashboard-metrics" aria-label={t("dashboard.metrics")}>
        {data.metrics.map((metric, index) => (
          <MetricCard key={metric.id} metric={metric} colorIndex={index} />
        ))}
      </section>

      <section className="dashboard-chart-grid dashboard-chart-grid--trend">
        <DashboardPanel
          title={t("dashboard.requestTrend")}
          subtitle={t(`dashboard.range.${trendRange}`)}
          span="full"
          actions={<TrendRangeTabs selectedRange={trendRange} onSelect={setTrendRange} />}
        >
          <TrendChart data={data.requests.requestTrend} trendRange={trendRange} />
        </DashboardPanel>
      </section>

      <section className="dashboard-chart-grid dashboard-chart-grid--distributions">
        <DashboardPanel title={t("dashboard.sizeDistribution")} subtitle={formatBytes(data.storage.totalBytes)}>
          <DonutChart data={data.storage.sizeBuckets} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.extensionDistribution")} subtitle={t("dashboard.byFiles")}>
          <DonutChart data={data.storage.extensionDistribution} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.technicalStatus")} subtitle={t("dashboard.mediaHealth")}>
          <DonutChart data={data.catalog.technicalStatus} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.audioTracks")} subtitle={t("dashboard.switchReadiness")}>
          <DonutChart data={data.catalog.audioTrackDistribution} />
        </DashboardPanel>
      </section>

      <section className="dashboard-chart-grid dashboard-chart-grid--catalog">
        <DashboardPanel title={t("dashboard.topArtists")} subtitle={t("dashboard.topArtistsDistribution")} span="wide">
          <DonutChart data={data.catalog.topArtists} variant="large" />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.topStyles")} subtitle={t("dashboard.topStylesDistribution")} span="wide">
          <DonutChart data={data.catalog.topStyles} variant="large" />
        </DashboardPanel>
      </section>

      <section className="dashboard-chart-grid dashboard-chart-grid--rankings">
        <DashboardPanel title={t("dashboard.topSongs")} subtitle={t("dashboard.singingRank")}>
          <RankedSongs songs={data.requests.topSongs} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.requesters")} subtitle={t("dashboard.userRank")}>
          <RequesterRank requesters={data.requests.topRequesters} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.requestStatus")} subtitle={t("dashboard.queueHistory")}>
          <DonutChart data={data.requests.statusDistribution} />
        </DashboardPanel>
      </section>

      <section className="dashboard-table-grid">
        <DashboardPanel title={t("dashboard.largestFiles")} subtitle={t("dashboard.storageHotspots")} span="wide">
          <LargestSongs songs={data.storage.largestSongs} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.recentRequests")} subtitle={t("dashboard.latestQueueEntries")} span="wide">
          <RecentRequests requests={data.requests.recentRequests} />
        </DashboardPanel>
      </section>
    </main>
  );
}

function MetricCard({ metric, colorIndex }: { metric: AdminDashboardMetric; colorIndex: number }) {
  return (
    <article className="dashboard-metric" style={{ "--accent": chartColor(colorIndex) } as CSSProperties}>
      <span>{metric.label}</span>
      <strong>{formatMetricValue(metric)}</strong>
      <small>{metric.trendLabel ?? formatMetricUnit(metric)}</small>
    </article>
  );
}

function DashboardPanel({
  title,
  subtitle,
  span,
  actions,
  children
}: {
  title: string;
  subtitle: string;
  span?: "wide" | "full";
  actions?: ReactNode;
  children: ReactNode;
}) {
  const className =
    span === "full"
      ? "dashboard-panel dashboard-panel--full"
      : span === "wide"
        ? "dashboard-panel dashboard-panel--wide"
        : "dashboard-panel";
  return (
    <section className={className}>
      <header>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        {actions}
      </header>
      <div className="dashboard-panel-body">{children}</div>
    </section>
  );
}

function TrendRangeTabs({
  selectedRange,
  onSelect
}: {
  selectedRange: AdminDashboardTrendRange;
  onSelect: (range: AdminDashboardTrendRange) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="dashboard-range-tabs" role="group" aria-label={t("dashboard.trendRange")}>
      {trendRanges.map((range) => (
        <button
          key={range}
          type="button"
          className={range === selectedRange ? "is-active" : ""}
          aria-pressed={range === selectedRange}
          onClick={() => onSelect(range)}
        >
          {t(`dashboard.rangeLabel.${range}`)}
        </button>
      ))}
    </div>
  );
}

function HealthItem({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "warning" | "danger" }) {
  return (
    <span className={`dashboard-health-item dashboard-health-item--${tone}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

function DonutChart({ data, variant = "normal" }: { data: AdminDashboardChartPoint[]; variant?: "normal" | "large" }) {
  if (data.length === 0) {
    return <EmptyChart />;
  }
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const chartData = data.map((item, index) => ({
    id: item.label,
    label: item.label,
    value: item.value,
    color: chartColor(index)
  }));
  return (
    <div className={variant === "large" ? "dashboard-donut-wrap dashboard-donut-wrap--large" : "dashboard-donut-wrap"}>
      <div className="dashboard-nivo-donut">
        <ResponsivePie
          data={chartData}
          margin={{ top: 12, right: 12, bottom: 12, left: 12 }}
          innerRadius={variant === "large" ? 0.54 : 0.62}
          padAngle={variant === "large" ? 1.2 : 1.8}
          cornerRadius={4}
          activeOuterRadiusOffset={8}
          colors={{ datum: "data.color" }}
          borderWidth={0}
          enableArcLabels={false}
          enableArcLinkLabels={false}
          tooltip={({ datum }) => (
            <ChartTooltip label={String(datum.label)} value={Number(datum.value)} suffix={formatShare(Number(datum.value), total)} />
          )}
          theme={nivoTheme}
        />
      </div>
      <ChartLegend data={data} total={total} compact={variant !== "large"} />
    </div>
  );
}

function TrendChart({
  data,
  trendRange
}: {
  data: AdminDashboardRequestTrendPoint[];
  trendRange: AdminDashboardTrendRange;
}) {
  if (data.length === 0) {
    return <EmptyChart />;
  }
  const tickValues = selectTrendTickValues(
    data.map((item) => item.date),
    trendRange
  );
  const series = [
    {
      id: "点歌次数",
      color: chartColors[0],
      data: data.map((item) => ({ x: item.date, y: item.requestCount }))
    },
    {
      id: "点歌人数",
      color: chartColors[1],
      data: data.map((item) => ({ x: item.date, y: item.uniqueRequesterCount }))
    }
  ];
  return (
    <div className="dashboard-nivo-line">
      <ResponsiveLine
        data={series}
        margin={{ top: 14, right: 24, bottom: 50, left: 38 }}
        xScale={{ type: "point" }}
        yScale={{ type: "linear", min: 0, max: "auto", stacked: false, reverse: false }}
        curve="monotoneX"
        colors={{ datum: "color" }}
        lineWidth={3}
        enablePoints={false}
        pointSize={0}
        pointColor={{ from: "color" }}
        pointBorderWidth={0}
        pointBorderColor="rgba(4, 10, 25, 0.9)"
        enableArea={true}
        areaOpacity={0.12}
        enableSlices="x"
        useMesh={true}
        axisTop={null}
        axisRight={null}
        axisBottom={{
          tickSize: 0,
          tickPadding: 10,
          tickValues,
          format: (value) => formatShortDate(String(value))
        }}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          format: (value) => formatInteger(Number(value))
        }}
        legends={[
          {
            anchor: "top-right",
            direction: "row",
            translateY: -6,
            itemWidth: 82,
            itemHeight: 14,
            symbolSize: 8,
            symbolShape: "circle"
          }
        ]}
        sliceTooltip={({ slice }) => (
          <div className="dashboard-tooltip">
            <strong>{String(slice.points[0]?.data.xFormatted ?? "")}</strong>
            {slice.points.map((point) => (
              <span key={point.id}>
                {point.seriesId}: {formatInteger(Number(point.data.yFormatted ?? point.data.y))}
              </span>
            ))}
          </div>
        )}
        theme={nivoTheme}
      />
    </div>
  );
}

function RankedSongs({ songs }: { songs: AdminDashboardSongRank[] }) {
  return (
    <ol className="dashboard-rank-list">
      {songs.slice(0, 10).map((song, index) => (
        <li key={song.songId}>
          <span>{index + 1}</span>
          <div>
            <strong>{song.title}</strong>
            <small>{song.artistName}</small>
          </div>
          <em>{song.requestCount}</em>
        </li>
      ))}
    </ol>
  );
}

function RequesterRank({ requesters }: { requesters: AdminDashboardUserRank[] }) {
  return (
    <ol className="dashboard-rank-list">
      {requesters.slice(0, 8).map((requester, index) => (
        <li key={requester.requesterId}>
          <span>{index + 1}</span>
          <div>
            <strong>{requester.displayName}</strong>
            <small>{requester.uniqueSongCount} 首不同歌曲</small>
          </div>
          <em>{requester.requestCount}</em>
        </li>
      ))}
    </ol>
  );
}

function LargestSongs({ songs }: { songs: AdminDashboardLargestSong[] }) {
  return (
    <div className="dashboard-data-table">
      {songs.map((song) => (
        <div key={song.songId}>
          <strong>{song.title}</strong>
          <span>{song.artistName}</span>
          <code>{song.fileName}</code>
          <em>{formatBytes(song.sizeBytes)}</em>
        </div>
      ))}
    </div>
  );
}

function RecentRequests({ requests }: { requests: AdminDashboardRecentRequest[] }) {
  return (
    <div className="dashboard-data-table dashboard-data-table--recent">
      {requests.map((request) => (
        <div key={request.queueEntryId}>
          <strong>{request.title}</strong>
          <span>{request.artistName}</span>
          <code>{request.requesterName}</code>
          <em>{formatDateTime(request.requestedAt)}</em>
        </div>
      ))}
    </div>
  );
}

function ChartLegend({
  data,
  total,
  compact = false
}: {
  data: AdminDashboardChartPoint[];
  total: number;
  compact?: boolean;
}) {
  const displayData = compact ? data.slice(0, 8) : data;
  return (
    <div className={compact ? "dashboard-chart-legend dashboard-chart-legend--compact" : "dashboard-chart-legend"}>
      {displayData.map((item, index) => (
        <span key={item.label}>
          <i style={{ background: chartColor(index) }} />
          <strong>{item.label}</strong>
          <em>{formatInteger(item.value)}</em>
          <small>{formatShare(item.value, total)}</small>
        </span>
      ))}
    </div>
  );
}

function EmptyChart() {
  return <div className="dashboard-empty-chart">暂无数据</div>;
}

function ChartTooltip({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="dashboard-tooltip">
      <strong>{label}</strong>
      <span>数量: {formatInteger(value)}{suffix ? ` · ${suffix}` : ""}</span>
    </div>
  );
}

function formatMetricValue(metric: AdminDashboardMetric): string {
  if (metric.unit === "bytes") {
    return formatBytes(metric.value);
  }
  if (metric.unit === "percent") {
    return formatPercent(metric.value);
  }
  return formatInteger(metric.value);
}

function formatMetricUnit(metric: AdminDashboardMetric): string {
  return metric.unit === "bytes" || metric.unit === "percent" || metric.unit == null ? "" : metric.unit;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)}%`;
}

function formatShare(value: number, total: number): string {
  if (total <= 0) {
    return "0%";
  }
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format((value / total) * 100)}%`;
}

function formatBytes(value: number): string {
  if (value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}`;
}

function formatShortDate(value: string): string {
  const [, yearMonth] = /^(\d{4})-(\d{2})$/u.exec(value) ?? [];
  if (yearMonth) {
    return value.replace("-", "/");
  }
  const [, month, day] = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value) ?? [];
  return month && day ? `${month}/${day}` : value;
}

function selectTrendTickValues(dates: readonly string[], trendRange: AdminDashboardTrendRange): string[] {
  if (trendRange === "7d" || trendRange === "1y") {
    return [...dates];
  }

  const targetCount = trendRange === "3m" ? 7 : 6;
  const step = Math.max(1, Math.ceil(dates.length / targetCount));
  const ticks = dates.filter((_, index) => index % step === 0);
  const last = dates.at(-1);
  if (last && !ticks.includes(last)) {
    ticks.push(last);
  }
  return ticks;
}

const nivoTheme = {
  background: "transparent",
  text: {
    fill: "#cbd6f7",
    fontSize: 11,
    fontWeight: 800
  },
  axis: {
    ticks: {
      text: {
        fill: "#9da9c9",
        fontSize: 11,
        fontWeight: 800
      }
    },
    legend: {
      text: {
        fill: "#cbd6f7",
        fontSize: 11
      }
    }
  },
  grid: {
    line: {
      stroke: "rgba(122, 202, 255, 0.12)",
      strokeWidth: 1
    }
  },
  legends: {
    text: {
      fill: "#cbd6f7",
      fontSize: 11,
      fontWeight: 800
    }
  },
  tooltip: {
    container: {
      background: "transparent",
      boxShadow: "none",
      padding: 0
    }
  }
} as const;

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
