import { languageName, statusText, useI18n, vocalModeName } from "../i18n.js";
import { SongDetailEditor } from "./SongDetailEditor.js";
import { languageOptions, songStatusOptions, useSongCatalogRuntime } from "./use-song-catalog-runtime.js";
import type { KtvIndexDiagnosticsResponse, KtvIndexNasSampleResult, KtvIndexSyncedSourceRecord } from "@home-ktv/domain";
import type { AdminCatalogAsset, AdminCatalogSong, Language, SongStatus } from "./types.js";

export function SongCatalogView() {
  const { t } = useI18n();
  const {
    status,
    setStatus,
    language,
    setLanguage,
    songs,
    selectedSong,
    setSelectedSongId,
    evaluation,
    validation,
    ktvIndexDiagnostics,
    ktvIndexIsError,
    ktvIndexIsLoading,
    ktvIndexQuery,
    refreshKtvIndexDiagnostics,
    queryIsError,
    queryIsLoading,
    isBusy,
    revalidateSong,
    saveMetadata,
    setDefaultAsset,
    setKtvIndexQuery,
    updateAsset,
    validateSong
  } = useSongCatalogRuntime();

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="admin-title">
          <h1>{t("songs.title")}</h1>
          <p>{t("songs.description")}</p>
        </div>
      </header>

      <KtvIndexDiagnosticsPanel
        diagnostics={ktvIndexDiagnostics}
        isError={ktvIndexIsError}
        isLoading={ktvIndexIsLoading}
        query={ktvIndexQuery}
        onQueryChange={setKtvIndexQuery}
        onRefresh={refreshKtvIndexDiagnostics}
      />

      <section className="catalog-workbench" aria-label={t("songs.catalogAria")}>
        <aside className="catalog-list-pane" aria-label={t("songs.listAria")}>
          <p className="pane-title">{t("songs.formalSongs")}</p>
          <div className="catalog-filters">
            <label>
              <span>{t("songs.status")}</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as SongStatus | "")}>
                {songStatusOptions.map((option) => (
                  <option key={option || "all"} value={option}>
                    {option ? statusText(option, t) : t("songs.allStatuses")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("candidate.language")}</span>
              <select value={language} onChange={(event) => setLanguage(event.target.value as Language | "")}>
                {languageOptions.map((option) => (
                  <option key={option || "all"} value={option}>
                    {option ? languageName(option, t) : languageName("all", t)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {queryIsError ? <p className="queue-error-text">歌曲加载失败，请稍后重试。</p> : null}
          {queryIsLoading ? <p className="queue-empty-text">{t("songs.loading")}</p> : null}
          <div className="song-list">
            {songs.map((song) => (
              <button
                className={song.id === selectedSong?.id ? "song-row selected" : "song-row"}
                key={song.id}
                type="button"
                onClick={() => setSelectedSongId(song.id)}
              >
                <span className="song-row-main">
                  <strong>{song.title}</strong>
                  <small>
                    {song.artistName} · {languageName(song.language, t)} · {statusText(song.status, t)} · {song.assets.length}{" "}
                    {t("songs.assets")}
                  </small>
                </span>
                <span className={`status-dot ${song.status}`} aria-hidden="true" />
              </button>
            ))}
          </div>
        </aside>

        <section className="catalog-detail-pane" aria-label={t("songs.detailAria")}>
          {selectedSong ? (
            <>
              <SongDetailEditor
                evaluation={evaluation}
                isBusy={isBusy}
                song={selectedSong}
                validation={validation}
                onRevalidate={async (songId) => {
                  await revalidateSong(songId);
                }}
                onSaveMetadata={async (songId, input) => {
                  await saveMetadata(songId, input);
                }}
                onSetDefaultAsset={async (songId, assetId) => {
                  await setDefaultAsset(songId, assetId);
                }}
                onUpdateAsset={async (assetId, patch) => {
                  await updateAsset(assetId, patch);
                }}
                onValidate={async (songId) => {
                  await validateSong(songId);
                }}
              />
              <KtvSyncedSourcesPanel song={selectedSong} />
            </>
          ) : (
            <EmptySongDetail />
          )}
        </section>
      </section>
    </main>
  );
}

function KtvIndexDiagnosticsPanel({
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

function KtvSyncedSourcesPanel({ song }: { song: AdminCatalogSong }) {
  const { t } = useI18n();
  const sources = song.assets
    .map((asset) => asset.ktvIndexSource ?? null)
    .filter((source): source is KtvIndexSyncedSourceRecord => source !== null);

  if (sources.length === 0) {
    return null;
  }

  return (
    <section className="ktv-synced-sources" aria-label={t("ktvIndex.syncedSources")}>
      <header>
        <p className="pane-title">{t("ktvIndex.sectionLabel")}</p>
        <h2>{t("ktvIndex.syncedSources")}</h2>
      </header>
      <div className="ktv-synced-source-list">
        {sources.map((source) => (
          <article className="ktv-synced-source-card" key={source.assetId}>
            <header>
              <strong>{source.title}</strong>
              <span className="badge">{source.category}</span>
            </header>
            <dl>
              <div>
                <dt>ktv_songs.id</dt>
                <dd>
                  <code>{source.indexedSongId}</code>
                </dd>
              </div>
              <div>
                <dt>ktv_song_assets.id</dt>
                <dd>
                  <code>{source.indexedAssetId}</code>
                </dd>
              </div>
              <div className="wide">
                <dt>{t("ktvIndex.sourceFilePath")}</dt>
                <dd>
                  <code>{source.filePath}</code>
                </dd>
              </div>
              <div>
                <dt>{t("ktvIndex.parseConfidence")}</dt>
                <dd>{formatNullableNumber(source.parseConfidence)}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatNumber(value: number | null | undefined): string {
  return value == null ? "0" : value.toLocaleString();
}

function formatNullableNumber(value: number | null | undefined): string {
  return value == null ? "-" : String(value);
}

function SongResourceSummary({ song }: { song: AdminCatalogSong }) {
  const { t } = useI18n();
  return (
    <article className="song-detail-shell">
      <header className="editor-header">
        <div>
          <p className="status-label">{statusText(song.status, t)}</p>
          <h2>
            {song.artistName} - {song.title}
          </h2>
          <p className="action-note">
            {t("songs.defaultAsset")}: <strong>{song.defaultAssetId ?? t("common.none")}</strong>
          </p>
        </div>
      </header>

      <section className="asset-summary-grid" aria-label={t("asset.summaryAria")}>
        {song.assets.map((asset) => (
          <AssetSummary key={asset.id} asset={asset} />
        ))}
      </section>
    </article>
  );
}

function AssetSummary({ asset }: { asset: AdminCatalogAsset }) {
  const { t } = useI18n();
  return (
    <article className="asset-summary">
      <header>
        <strong>{asset.id}</strong>
        <span className="badge">{statusText(asset.status, t)}</span>
      </header>
      <dl className="asset-facts">
        <div>
          <dt>{t("asset.vocal")}</dt>
          <dd>{vocalModeName(asset.vocalMode, t)}</dd>
        </div>
        <div>
          <dt>{t("asset.lyric")}</dt>
          <dd>{asset.lyricMode}</dd>
        </div>
        <div>
          <dt>{t("asset.switchFamily")}</dt>
          <dd>{asset.switchFamily ?? t("common.none")}</dd>
        </div>
        <div>
          <dt>{t("asset.switchQuality")}</dt>
          <dd>{asset.switchQualityStatus}</dd>
        </div>
      </dl>
    </article>
  );
}

function EmptySongDetail() {
  const { t } = useI18n();
  return (
    <div className="editor-empty">
      <h2>{t("songs.emptyTitle")}</h2>
      <p>{t("songs.emptyBody")}</p>
    </div>
  );
}
