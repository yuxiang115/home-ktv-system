import type { KtvIndexDiagnosticsPreviewResult, KtvIndexDiagnosticsResponse } from "@home-ktv/domain";
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
          <span className="admin-eyebrow">{t("ktvIndex.sectionLabel")}</span>
          <h1>{t("songs.title")}</h1>
          <p>{t("songs.description")}</p>
        </div>
        <div className="admin-header-beam" aria-hidden="true">
          <span />
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
  const preview = diagnostics?.preview ?? [];

  return (
    <section className="ktv-index-diagnostics ktv-index-search-workbench" aria-label={t("ktvIndex.title")}>
      <header className="ktv-index-header ktv-index-search-hero">
        <div>
          <p className="pane-title">{t("ktvIndex.sectionLabel")}</p>
          <h2>{t("ktvIndex.searchPreview")}</h2>
        </div>
        <label className="ktv-index-search-field ktv-index-search-field--hero">
          <span>{t("ktvIndex.previewQuery")}</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={t("ktvIndex.previewPlaceholder")} />
        </label>
      </header>

      {isError ? <p className="queue-error-text">{t("ktvIndex.loadFailed")}</p> : null}

      <div className="ktv-index-search-layout">
        <section className="ktv-index-preview">
          <div className="ktv-index-preview-toolbar">
            <h3>{t("ktvIndex.previewResults")}</h3>
            <span>{isLoading ? t("common.loading") : t("ktvIndex.resultCount", { count: preview.length })}</span>
          </div>
          {preview.length ? <SearchPreviewList results={preview} /> : <p className="queue-empty-text">{isLoading ? t("common.loading") : t("ktvIndex.noPreviewResults")}</p>}
        </section>

        <aside className="ktv-index-status-panel">
          <header>
            <h3>{t("ktvIndex.indexStatus")}</h3>
            <button className="secondary-button" type="button" onClick={() => void onRefresh()} disabled={isLoading}>
              {isLoading ? t("common.refreshing") : t("ktvIndex.refresh")}
            </button>
          </header>
          <dl className="ktv-index-status-list">
            <StatusFact label={t("ktvIndex.latestRun")} value={diagnostics?.latestRun?.status ?? t("common.none")} />
            <StatusFact label={t("ktvIndex.sourceRoot")} value={diagnostics?.sourceRoot ?? t("common.none")} />
            <StatusFact label={t("ktvIndex.activeAssets")} value={formatNumber(diagnostics?.activeAssetCount)} />
            <StatusFact label={t("ktvIndex.missingAssets")} value={formatNumber(diagnostics?.missingAssetCount)} />
          </dl>
        </aside>
      </div>
    </section>
  );
}

function SearchPreviewList({ results }: { results: KtvIndexDiagnosticsPreviewResult[] }) {
  return (
    <div className="ktv-index-preview-list">
      {results.map((result) => (
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
  );
}

function StatusFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="ktv-index-status-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? "0" : value.toLocaleString();
}
