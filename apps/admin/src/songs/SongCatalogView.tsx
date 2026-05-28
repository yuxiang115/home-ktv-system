import type { KtvIndexDiagnosticsResponse, KtvIndexNasSampleResult } from "@home-ktv/domain";
import { useI18n } from "../i18n.js";
import { useSongCatalogRuntime } from "./use-song-catalog-runtime.js";

export function SongCatalogView() {
  const { t } = useI18n();
  const {
    ktvIndexDiagnostics,
    ktvIndexIsError,
    ktvIndexIsLoading,
    ktvIndexQuery,
    refreshKtvIndexDiagnostics,
    setKtvIndexQuery
  } = useSongCatalogRuntime();

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="admin-title">
          <h1>{t("songs.title")}</h1>
          <p>{t("songs.description")}</p>
        </div>
      </header>

      <NasLibraryDiagnosticsPanel
        diagnostics={ktvIndexDiagnostics}
        isError={ktvIndexIsError}
        isLoading={ktvIndexIsLoading}
        query={ktvIndexQuery}
        onQueryChange={setKtvIndexQuery}
        onRefresh={refreshKtvIndexDiagnostics}
      />
    </main>
  );
}

function NasLibraryDiagnosticsPanel({
  diagnostics,
  isError,
  isLoading,
  query,
  onQueryChange,
  onRefresh
}: {
  diagnostics: KtvIndexDiagnosticsResponse | null;
  isError: boolean;
  isLoading: boolean;
  query: string;
  onQueryChange(query: string): void;
  onRefresh(): Promise<void>;
}) {
  const { t } = useI18n();
  const nasSample = diagnostics?.nasSample;

  return (
    <section className="ktv-index-diagnostics" aria-label={t("ktvIndex.title")}>
      <header className="ktv-index-header">
        <div>
          <p className="pane-title">{t("ktvIndex.sectionLabel")}</p>
          <h2>{t("ktvIndex.title")}</h2>
        </div>
        <button className="secondary-button" type="button" onClick={() => void onRefresh()} disabled={isLoading}>
          {isLoading ? t("common.refreshing") : t("ktvIndex.refresh")}
        </button>
      </header>

      {isError ? <p className="queue-error-text">{t("ktvIndex.loadFailed")}</p> : null}

      <dl className="ktv-index-metrics">
        <Metric label={t("ktvIndex.tables")} value={`${diagnostics?.tables.filter((table) => table.exists).length ?? 0}/${diagnostics?.tables.length ?? 0}`} />
        <Metric label={t("ktvIndex.latestRun")} value={diagnostics?.latestRun?.status ?? t("common.none")} />
        <Metric label={t("ktvIndex.sourceRoot")} value={diagnostics?.sourceRoot ?? t("common.none")} />
        <Metric label={t("ktvIndex.activeAssets")} value={formatNumber(diagnostics?.activeAssetCount)} />
        <Metric label={t("ktvIndex.missingAssets")} value={formatNumber(diagnostics?.missingAssetCount)} />
        <Metric label={t("ktvIndex.songCount")} value={formatNumber(diagnostics?.songCount)} />
        <Metric label={t("ktvIndex.artistCount")} value={formatNumber(diagnostics?.artistCount)} />
        <Metric label={t("ktvIndex.probeCoverage")} value={formatPercent(diagnostics?.probeCoveragePercent)} />
        <Metric label={t("ktvIndex.probePending")} value={formatNumber(diagnostics?.probePendingCount)} />
        <Metric label={t("ktvIndex.probeFailed")} value={formatNumber(diagnostics?.probeFailedCount)} />
        <Metric label={t("ktvIndex.lowConfidence")} value={formatNumber(diagnostics?.lowConfidenceCount)} />
      </dl>

      <div className="ktv-index-detail-grid">
        <section>
          <h3>{t("ktvIndex.tables")}</h3>
          <div className="ktv-index-table" role="table" aria-label={t("ktvIndex.tables")}>
            {diagnostics?.tables.map((table) => (
              <div className="ktv-index-row" role="row" key={table.tableName}>
                <span role="cell">{table.tableName}</span>
                <strong role="cell">{table.exists ? t("ktvIndex.exists") : t("ktvIndex.missingTable")}</strong>
              </div>
            )) ?? <p className="queue-empty-text">{isLoading ? t("common.loading") : t("common.none")}</p>}
          </div>
        </section>

        <section>
          <h3>{t("ktvIndex.parseStrategies")}</h3>
          <div className="ktv-index-table" role="table" aria-label={t("ktvIndex.parseStrategies")}>
            {diagnostics?.parseStrategies.length ? (
              diagnostics.parseStrategies.map((strategy) => (
                <div className="ktv-index-row" role="row" key={strategy.parseStrategy}>
                  <span role="cell">{strategy.parseStrategy}</span>
                  <strong role="cell">{formatNumber(strategy.count)}</strong>
                </div>
              ))
            ) : (
              <p className="queue-empty-text">{isLoading ? t("common.loading") : t("common.none")}</p>
            )}
          </div>
        </section>

        <section>
          <h3>{t("ktvIndex.technicalStatus")}</h3>
          <div className="ktv-index-table" role="table" aria-label={t("ktvIndex.technicalStatus")}>
            {diagnostics?.technicalStatusCounts.length ? (
              diagnostics.technicalStatusCounts.map((status) => (
                <div className="ktv-index-row" role="row" key={status.technicalStatus}>
                  <span role="cell">{status.technicalStatus}</span>
                  <strong role="cell">{formatNumber(status.count)}</strong>
                </div>
              ))
            ) : (
              <p className="queue-empty-text">{isLoading ? t("common.loading") : t("common.none")}</p>
            )}
          </div>
        </section>

        <section>
          <h3>{t("ktvIndex.audioTrackDistribution")}</h3>
          <div className="ktv-index-table" role="table" aria-label={t("ktvIndex.audioTrackDistribution")}>
            {diagnostics?.audioTrackDistribution.length ? (
              diagnostics.audioTrackDistribution.map((item) => (
                <div className="ktv-index-row" role="row" key={item.audioTrackCount}>
                  <span role="cell">{t("ktvIndex.audioTrackCount", { count: item.audioTrackCount })}</span>
                  <strong role="cell">{formatNumber(item.count)}</strong>
                </div>
              ))
            ) : (
              <p className="queue-empty-text">{isLoading ? t("common.loading") : t("common.none")}</p>
            )}
          </div>
        </section>

        <section>
          <h3>{t("ktvIndex.nasSample")}</h3>
          <dl className="ktv-index-sample-counts">
            <Metric label={t("ktvIndex.sampleChecked")} value={`${nasSample?.checked ?? 0}/${nasSample?.requested ?? 0}`} />
            <Metric label={t("ktvIndex.sampleReadable")} value={formatNumber(nasSample?.readable)} />
            <Metric label={t("ktvIndex.sampleUnmapped")} value={formatNumber(nasSample?.unmapped)} />
          </dl>
          <div className="ktv-index-table ktv-index-sample-table" role="table" aria-label={t("ktvIndex.nasSample")}>
            {nasSample?.results.length ? (
              nasSample.results.map((sample) => <NasSampleRow key={sample.indexedAssetId} sample={sample} />)
            ) : (
              <p className="queue-empty-text">{isLoading ? t("common.loading") : t("common.none")}</p>
            )}
          </div>
        </section>

        <section className="ktv-index-preview">
          <h3>{t("ktvIndex.searchPreview")}</h3>
          <label className="ktv-index-search-field">
            <span>{t("ktvIndex.previewQuery")}</span>
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} />
          </label>
          {diagnostics?.preview.length ? (
            <div className="ktv-index-preview-list">
              {diagnostics.preview.map((result) => (
                <article className="ktv-index-preview-result" key={result.indexedSongId}>
                  <header>
                    <strong>
                      {result.artistName} - {result.title}
                    </strong>
                    <span className="badge">{result.category}</span>
                  </header>
                  {result.versions.map((version) => (
                    <div className="ktv-index-version-row" key={version.indexedAssetId}>
                      <span>
                        <strong>{version.displayName}</strong>
                        <small>
                          {version.sourceLabel} · {version.extension} · {version.category} · {version.parseConfidence}
                        </small>
                      </span>
                      <code>{version.filePath}</code>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          ) : (
            <p className="queue-empty-text">{isLoading ? t("common.loading") : t("ktvIndex.noPreviewResults")}</p>
          )}
        </section>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function NasSampleRow({ sample }: { sample: KtvIndexNasSampleResult }) {
  const { t } = useI18n();
  return (
    <div className="ktv-index-row ktv-index-sample-row" role="row">
      <span role="cell">
        <strong>{sampleStatusText(sample.status, t)}</strong>
        <code>{sample.filePath}</code>
      </span>
      <small role="cell">{sample.message ?? t("common.none")}</small>
    </div>
  );
}

function sampleStatusText(status: KtvIndexNasSampleResult["status"], t: ReturnType<typeof useI18n>["t"]): string {
  return t(`ktvIndex.sampleStatus.${status}`);
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? "0" : value.toLocaleString();
}

function formatPercent(value: number | null | undefined): string {
  return value == null ? "0%" : `${value}%`;
}
