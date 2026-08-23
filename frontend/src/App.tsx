import { useEffect, useState } from "react";
import { get, operatorId } from "./api/client";
import {
  discardRejected,
  drainQueue,
  queueCount,
  rejectedQueueItems,
  retryRejected,
  startQueueSync,
  type QueuedWriteRecord,
} from "./offline";
import { Dashboard } from "./pages/dashboard";
import { Due } from "./pages/due";
import { Batches } from "./pages/batches";
import { Fish } from "./pages/fish";
import { Master } from "./pages/master";
import { Controls, Promotions, Timing } from "./pages/settings";
import { Audit } from "./pages/audit";
import { Export } from "./pages/export";
import { type ApiItem, type Language, type Page, text } from "./types";

function pageForWrite(path: string): Page {
  if (path.startsWith("/observations/embryo")) return "due";
  if (path.startsWith("/batches") || path.startsWith("/injection-lots") || path.startsWith("/embryos")) return "batches";
  if (path.startsWith("/fish") || path.startsWith("/observations/fish")) return "fish";
  if (path.startsWith("/timing-profiles")) return "timing";
  if (path.startsWith("/promotions")) return "promotions";
  if (path.includes("control-arm-counts")) return "controls";
  return "master";
}

function App() {
  const [page, setPage] = useState<Page>(
    (location.hash.slice(1) as Page) || "dashboard",
  );
  const [language, setLanguage] = useState<Language>("th");
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState<QueuedWriteRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [operators, setOperators] = useState<ApiItem[]>([]);
  const currentOperator = operatorId();
  const t = text[language];

  useEffect(() => {
    void get("/operators")
      .then((data) => setOperators(data.items ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${page}`,
    );
  }, [page]);
  useEffect(() => {
    const refreshQueue = () =>
      void Promise.all([queueCount(), rejectedQueueItems()]).then(
        ([count, rejectedItems]) => {
          setPending(count);
          setRejected(rejectedItems);
        },
      );
    const on = () => {
      setOnline(true);
      void drainQueue().then(refreshQueue);
    };
    const off = () => setOnline(false);
    const queueChanged = () => refreshQueue();
    const syncStarted = () => setSyncing(true);
    const syncIdle = () => {
      setSyncing(false);
      refreshQueue();
    };
    const beforeClose = (event: BeforeUnloadEvent) => {
      if (pending + rejected.length > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("chronofish:queue-enqueued", queueChanged);
    window.addEventListener("chronofish:queue-drained", queueChanged);
    window.addEventListener("chronofish:queue-rejected", queueChanged);
    window.addEventListener("chronofish:queue-discarded", queueChanged);
    window.addEventListener("chronofish:queue-syncing", syncStarted);
    window.addEventListener("chronofish:queue-sync-idle", syncIdle);
    window.addEventListener("beforeunload", beforeClose);
    void drainQueue().then(refreshQueue);
    const stopQueueSync = startQueueSync(refreshQueue);
    return () => {
      stopQueueSync();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("chronofish:queue-enqueued", queueChanged);
      window.removeEventListener("chronofish:queue-drained", queueChanged);
      window.removeEventListener("chronofish:queue-rejected", queueChanged);
      window.removeEventListener("chronofish:queue-discarded", queueChanged);
      window.removeEventListener("chronofish:queue-syncing", syncStarted);
      window.removeEventListener("chronofish:queue-sync-idle", syncIdle);
      window.removeEventListener("beforeunload", beforeClose);
    };
  }, [pending, rejected.length]);

  const navigate = (next: Page) => setPage(next);
  return (
    <div className="app">
      <header className="topbar">
        <div>
          <span className="brand">ChronoFish</span>
          <span className="tagline">SCNT tracking</span>
        </div>
        <div className="top-actions">
          <label className="operator-select">
            <span className="sr-only">{t.chooseOperator}</span>
            <select
              aria-label={t.chooseOperator}
              value={currentOperator}
              onChange={(event) => {
                sessionStorage.setItem(
                  "chronofish.operator_id",
                  event.target.value,
                );
                window.location.reload();
              }}
            >
              <option value="">{t.chooseOperator}</option>
              {operators.map((operator) => (
                <option key={String(operator.id)} value={String(operator.id)}>
                  {String(operator.name)}
                </option>
              ))}
            </select>
          </label>
          {!currentOperator && (
            <span className="operator-required" role="status">
              {t.operatorRequired}
            </span>
          )}
          <span
            className={`connection connection--${online ? "online" : "offline"}`}
            aria-live="polite"
          >
            <span aria-hidden="true" />
            {online ? t.online : t.offline}
          </span>
          <span className="queue" aria-live="polite">
            {syncing ? t.syncing : pending + rejected.length ? `${t.pending} ${pending + rejected.length}` : t.saved}
          </span>
          {rejected.length > 0 && (
            <details className="queue-review">
              <summary>{t.reviewRejected} ({rejected.length})</summary>
              <div className="queue-review__panel">
                {rejected.map(({ id, value }) => (
                  <div className="queue-review__item" key={String(id)}>
                    <strong>{value.method} {value.path}</strong>
                    <span>{value.lastError || t.rejectedFallback}</span>
                    <div>
                      <button type="button" onClick={() => navigate(pageForWrite(value.path))}>{t.openRelated}</button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(t.confirmDiscard)) void discardRejected(id);
                        }}
                      >
                        {t.discardRejected}
                      </button>
                    </div>
                  </div>
                ))}
                <button className="queue-retry" type="button" onClick={() => void retryRejected()}>
                  {t.retryRejected}
                </button>
              </div>
            </details>
          )}
          <button
            className="language"
            onClick={() => setLanguage(language === "th" ? "en" : "th")}
            aria-label="Switch language"
          >
            {language === "th" ? "EN" : "ไทย"}
          </button>
        </div>
      </header>
      <div className="layout">
        <nav aria-label="Main navigation">
          {(
            [
              ["dashboard", t.dashboard],
              ["due", t.due],
              ["batches", t.batches],
              ["fish", t.fish],
              ["master", t.master],
              ["timing", t.timing],
              ["promotions", t.promotions],
              ["controls", t.controls],
              ["audit", t.audit],
              ["export", t.export],
            ] as [Page, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              aria-current={page === key ? "page" : undefined}
              className={
                page === key ? "nav-link nav-link--active" : "nav-link"
              }
              onClick={() => navigate(key)}
            >
              {label}
            </button>
          ))}
        </nav>
        <main className="content">
          {page === "dashboard" && <Dashboard onNavigate={navigate} t={t} />}
          {page === "due" && <Due t={t} />}
          {page === "batches" && <Batches t={t} />}
          {page === "fish" && <Fish t={t} />}
          {page === "master" && <Master t={t} />}
          {page === "timing" && <Timing t={t} />}
          {page === "promotions" && <Promotions t={t} />}
          {page === "controls" && <Controls t={t} />}
          {page === "audit" && <Audit t={t} />}
          {page === "export" && <Export t={t} />}
        </main>
      </div>
    </div>
  );
}

export default App;
