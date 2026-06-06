import type {
  AdminDashboardChartPoint,
  AdminDashboardLargestSong,
  AdminDashboardMetric,
  AdminDashboardRequestTrendPoint,
  AdminDashboardRecentRequest,
  AdminDashboardSongRank,
  AdminDashboardUserRank
} from "@home-ktv/domain";
import type { CSSProperties, ReactNode } from "react";
import { ResponsiveBar } from "@nivo/bar";
import { ResponsiveLine } from "@nivo/line";
import { ResponsivePie } from "@nivo/pie";
import { useI18n } from "../i18n.js";
import { useAdminDashboard } from "./use-admin-dashboard.js";

const chartColors = ["#29d8ff", "#ffd166", "#6cff9d", "#ff4d7a", "#9b8cff", "#ff8bd2", "#72f0ff", "#f7a55a"];

function chartColor(index: number): string {
  return chartColors[index % chartColors.length] ?? chartColors[0]!;
}

export function AdminDashboardView() {
  const { t } = useI18n();
  const dashboard = useAdminDashboard();
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

      <section className="dashboard-chart-grid dashboard-chart-grid--lead">
        <DashboardPanel title={t("dashboard.requestTrend")} subtitle={t("dashboard.last14Days")} span="wide">
          <TrendChart data={data.requests.requestTrend} />
        </DashboardPanel>

        <DashboardPanel title={t("dashboard.topSongs")} subtitle={t("dashboard.singingRank")}>
          <RankedSongs songs={data.requests.topSongs} />
        </DashboardPanel>
      </section>

      <section className="dashboard-chart-grid">
        <DashboardPanel title={t("dashboard.sizeDistribution")} subtitle={formatBytes(data.storage.totalBytes)}>
          <DonutChart data={data.storage.sizeBuckets} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.extensionDistribution")} subtitle={t("dashboard.byFiles")}>
          <HorizontalBarChart data={data.storage.extensionDistribution} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.topArtists")} subtitle={t("dashboard.bySongs")}>
          <HorizontalBarChart data={data.catalog.topArtists} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.topStyles")} subtitle={t("dashboard.byTags")}>
          <HorizontalBarChart data={data.catalog.topStyles} />
        </DashboardPanel>
      </section>

      <section className="dashboard-chart-grid">
        <DashboardPanel title={t("dashboard.technicalStatus")} subtitle={t("dashboard.mediaHealth")}>
          <DonutChart data={data.catalog.technicalStatus} />
        </DashboardPanel>
        <DashboardPanel title={t("dashboard.audioTracks")} subtitle={t("dashboard.switchReadiness")}>
          <HorizontalBarChart data={data.catalog.audioTrackDistribution} />
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
  children
}: {
  title: string;
  subtitle: string;
  span?: "wide";
  children: ReactNode;
}) {
  return (
    <section className={span === "wide" ? "dashboard-panel dashboard-panel--wide" : "dashboard-panel"}>
      <header>
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </header>
      <div className="dashboard-panel-body">{children}</div>
    </section>
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

function DonutChart({ data }: { data: AdminDashboardChartPoint[] }) {
  if (data.length === 0) {
    return <EmptyChart />;
  }
  const chartData = data.map((item, index) => ({
    id: item.label,
    label: item.label,
    value: item.value,
    color: chartColor(index)
  }));
  return (
    <div className="dashboard-donut-wrap">
      <div className="dashboard-nivo-donut">
        <ResponsivePie
          data={chartData}
          margin={{ top: 10, right: 10, bottom: 10, left: 10 }}
          innerRadius={0.64}
          padAngle={1.8}
          cornerRadius={4}
          activeOuterRadiusOffset={8}
          colors={{ datum: "data.color" }}
          borderWidth={0}
          enableArcLabels={false}
          enableArcLinkLabels={false}
          tooltip={({ datum }) => <ChartTooltip label={String(datum.label)} value={Number(datum.value)} />}
          theme={nivoTheme}
        />
      </div>
      <ChartLegend data={data.slice(0, 6)} />
    </div>
  );
}

function HorizontalBarChart({ data }: { data: AdminDashboardChartPoint[] }) {
  if (data.length === 0) {
    return <EmptyChart />;
  }
  const chartData = data.slice(0, 8).map((item) => ({
    label: item.label,
    value: item.value
  }));
  return (
    <div className="dashboard-nivo-bar">
      <ResponsiveBar
        data={chartData}
        keys={["value"]}
        indexBy="label"
        layout="horizontal"
        margin={{ top: 4, right: 18, bottom: 18, left: 78 }}
        padding={0.36}
        valueScale={{ type: "linear" }}
        indexScale={{ type: "band", round: true }}
        colors={({ index }) => chartColor(index)}
        borderRadius={6}
        enableGridX={false}
        enableGridY={false}
        enableLabel={false}
        axisTop={null}
        axisRight={null}
        axisBottom={null}
        axisLeft={{
          tickSize: 0,
          tickPadding: 8,
          tickRotation: 0,
          truncateTickAt: 10
        }}
        tooltip={({ data }) => <ChartTooltip label={String(data.label)} value={Number(data.value)} />}
        theme={nivoTheme}
      />
    </div>
  );
}

function TrendChart({ data }: { data: AdminDashboardRequestTrendPoint[] }) {
  if (data.length === 0) {
    return <EmptyChart />;
  }
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
        margin={{ top: 14, right: 24, bottom: 36, left: 38 }}
        xScale={{ type: "point" }}
        yScale={{ type: "linear", min: 0, max: "auto", stacked: false, reverse: false }}
        curve="monotoneX"
        colors={{ datum: "color" }}
        lineWidth={3}
        pointSize={7}
        pointColor={{ from: "color" }}
        pointBorderWidth={2}
        pointBorderColor="rgba(4, 10, 25, 0.9)"
        enableArea={true}
        areaOpacity={0.12}
        enableSlices="x"
        useMesh={true}
        axisTop={null}
        axisRight={null}
        axisBottom={{
          tickSize: 0,
          tickPadding: 12,
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

function ChartLegend({ data }: { data: AdminDashboardChartPoint[] }) {
  return (
    <div className="dashboard-chart-legend">
      {data.map((item, index) => (
        <span key={item.label}>
          <i style={{ background: chartColor(index) }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function EmptyChart() {
  return <div className="dashboard-empty-chart">暂无数据</div>;
}

function ChartTooltip({ label, value }: { label: string; value: number }) {
  return (
    <div className="dashboard-tooltip">
      <strong>{label}</strong>
      <span>数量: {formatInteger(value)}</span>
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

function formatBytes(value: number): string {
  if (value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1024 ** index)} ${units[index]}`;
}

function formatShortDate(value: string): string {
  const [, month, day] = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value) ?? [];
  return month && day ? `${month}/${day}` : value;
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
