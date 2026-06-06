import type {
  AdminDashboardChartPoint,
  AdminDashboardLargestSong,
  AdminDashboardMetric,
  AdminDashboardRecentRequest,
  AdminDashboardSongRank,
  AdminDashboardUserRank
} from "@home-ktv/domain";
import type { CSSProperties, ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
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
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={data.requests.requestTrend} margin={{ top: 10, right: 18, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="requestTrendFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#29d8ff" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="#29d8ff" stopOpacity={0.04} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(122, 202, 255, 0.12)" vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "#9da9c9", fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} tick={{ fill: "#9da9c9", fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <Area type="monotone" dataKey="requestCount" stroke="#29d8ff" strokeWidth={3} fill="url(#requestTrendFill)" />
              <Area type="monotone" dataKey="uniqueRequesterCount" stroke="#ffd166" strokeWidth={2} fill="transparent" />
            </AreaChart>
          </ResponsiveContainer>
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
  return (
    <div className="dashboard-donut-wrap">
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="label" innerRadius={58} outerRadius={88} paddingAngle={3}>
            {data.map((entry, index) => (
              <Cell key={entry.label} fill={chartColor(index)} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <ChartLegend data={data.slice(0, 6)} />
    </div>
  );
}

function HorizontalBarChart({ data }: { data: AdminDashboardChartPoint[] }) {
  if (data.length === 0) {
    return <EmptyChart />;
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data.slice(0, 8)} layout="vertical" margin={{ top: 4, right: 18, left: 18, bottom: 4 }}>
        <CartesianGrid stroke="rgba(122, 202, 255, 0.1)" horizontal={false} />
        <XAxis type="number" hide />
        <YAxis dataKey="label" type="category" width={76} tickLine={false} axisLine={false} tick={{ fill: "#cbd6f7", fontSize: 11 }} />
        <Tooltip content={<ChartTooltip />} />
        <Bar dataKey="value" radius={[0, 6, 6, 0]}>
          {data.slice(0, 8).map((entry, index) => (
            <Cell key={entry.label} fill={chartColor(index)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
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

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number; payload?: unknown }>; label?: string }) {
  if (!active || !payload?.length) {
    return null;
  }
  return (
    <div className="dashboard-tooltip">
      <strong>{label ?? readTooltipLabel(payload[0]?.payload)}</strong>
      {payload.map((item) => (
        <span key={`${item.name ?? "value"}-${item.value}`}>
          {item.name ?? "数量"}: {formatInteger(item.value ?? 0)}
        </span>
      ))}
    </div>
  );
}

function readTooltipLabel(payload: unknown): string {
  return typeof payload === "object" && payload !== null && "label" in payload ? String(payload.label) : "";
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
