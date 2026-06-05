import { eventTypeText, roomStateText, useI18n, vocalModeName } from "../i18n.js";
import { useRoomStatus } from "./use-room-status.js";

export function RoomStatusView() {
  const { t } = useI18n();
  const roomSlug = "living-room";
  const {
    errorMessage,
    isRefreshingPairing,
    isRefreshingRoom,
    refreshPairingToken,
    refreshRoomStatus,
    roomStatus
  } = useRoomStatus(roomSlug, t);

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="admin-title">
          <span className="admin-eyebrow">Room Control</span>
          <h1>{t("rooms.title")}</h1>
          <p>{t("rooms.description")}</p>
        </div>
        <div className="admin-header-beam" aria-hidden="true">
          <span />
        </div>
        <div className="admin-header-actions">
          <button className="secondary-button" type="button" onClick={() => void refreshRoomStatus()} disabled={isRefreshingRoom}>
            {isRefreshingRoom ? t("common.refreshing") : t("rooms.refreshState")}
          </button>
          <button className="primary-button" type="button" onClick={() => void refreshPairingToken()} disabled={!roomStatus || isRefreshingPairing}>
            {isRefreshingPairing ? t("common.refreshing") : t("rooms.refreshToken")}
          </button>
        </div>
      </header>

      <section className="room-status-grid" aria-label={t("rooms.gridAria")}>
        {errorMessage ? <p className="room-status-error">{errorMessage}</p> : null}
        <dl className="room-status-summary">
          <div className="metric-card metric-card--blue">
            <dt>{t("rooms.state")}</dt>
            <dd>{roomStatus ? roomStateText(roomStatus.room.status, t) : t("common.loading")}</dd>
          </div>
          <div className="metric-card metric-card--magenta">
            <dt>{t("rooms.tokenExpires")}</dt>
            <dd>{roomStatus ? formatTime(roomStatus.pairing.tokenExpiresAt) : t("common.loading")}</dd>
          </div>
          <div className="metric-card metric-card--green">
            <dt>{t("rooms.onlineControllers")}</dt>
            <dd>{roomStatus ? roomStatus.controllers.onlineCount : t("common.loading")}</dd>
          </div>
          <div className={`metric-card ${roomStatus?.tvPresence.online ? "metric-card--green" : "metric-card--danger"}`}>
            <dt>{t("rooms.tvStatus")}</dt>
            <dd>{roomStatus ? (roomStatus.tvPresence.online ? t("rooms.tvOnline") : t("rooms.tvOffline")) : t("common.loading")}</dd>
          </div>
          <div className="metric-card metric-card--blue">
            <dt>{t("rooms.sessionVersion")}</dt>
            <dd>{roomStatus ? roomStatus.sessionVersion : t("common.loading")}</dd>
          </div>
        </dl>

        <section className="room-status-panel" aria-label={t("rooms.currentSong")}>
          <h2>{t("rooms.currentSong")}</h2>
          {roomStatus?.current ? (
            <p>
              {roomStatus.current.songTitle} - {roomStatus.current.artistName} ({vocalModeName(roomStatus.current.vocalMode, t)})
            </p>
          ) : (
            <p>{t("rooms.noCurrentSong")}</p>
          )}
        </section>

        <section className="room-status-panel" aria-label={t("rooms.queueSummary")}>
          <h2>{t("rooms.queueSummary")}</h2>
          <ol className="room-status-queue">
            {(roomStatus?.queue ?? []).slice(0, 5).map((entry) => (
              <li key={entry.queueEntryId}>
                <strong>{entry.songTitle}</strong>
                <span>{entry.artistName}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="room-status-panel room-status-wide" aria-label={t("rooms.recentEvents")}>
          <h2>{t("rooms.recentEvents")}</h2>
          <ol className="room-event-list">
            {(roomStatus?.recentEvents ?? []).map((event) => (
              <li key={event.id}>
                <strong>{eventTypeText(event.eventType, t)}</strong>
                <span>
                  <code>{event.eventType}</code> / {event.queueEntryId ?? t("rooms.roomFallback")} / {formatTime(event.createdAt)}
                </span>
                <small>{formatPayload(event.eventPayload, t)}</small>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  const seconds = `${date.getSeconds()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatPayload(payload: Record<string, unknown>, t: ReturnType<typeof useI18n>["t"]): string {
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  const recovery = typeof payload.recovery === "string" ? payload.recovery : null;
  return [reason, recovery].filter(Boolean).join(" / ") || t("common.noPayload");
}
