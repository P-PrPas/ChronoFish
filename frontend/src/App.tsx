import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
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

type NavItem = { page: Page; label: string; icon: string; group: "primary" | "research" | "system" };

const productName = "KUVTH Zebrafish LIMS";

const iconPaths: Record<string, ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  due: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  batches: <><path d="M4 7h16v13H4z"/><path d="M8 7V4h8v3M8 12h8M8 16h5"/></>,
  fish: <><path d="M4 12c3-5 9-6 14-2l3-3v10l-3-3c-5 4-11 3-14-2Z"/><circle cx="15.5" cy="11" r=".7"/></>,
  master: <><path d="M4 5h16v14H4zM8 9h8M8 13h8M8 17h5"/></>,
  timing: <><circle cx="12" cy="12" r="9"/><path d="M12 8v4h4M9 2h6"/></>,
  promotions: <><path d="M12 21V9M7 14c-3 0-4-2-4-5 3 0 5 1 6 4M17 10c3 0 4-2 4-5-3 0-5 1-6 4"/></>,
  controls: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/></>,
  audit: <><path d="M6 3h12v18H6zM9 8h6M9 12h6M9 16h4"/><path d="m4 5 2 2"/></>,
  export: <><path d="M12 3v12M7 10l5 5 5-5M5 19h14"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
};

function Icon({ name, className = "icon" }: { name: string; className?: string }) {
  return <svg className={className} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{iconPaths[name]}</svg>;
}

function pageForWrite(path: string): Page {
  if (path.startsWith("/observations/embryo")) return "due";
  if (path.startsWith("/batches") || path.startsWith("/injection-lots") || path.startsWith("/embryos")) return "batches";
  if (path.startsWith("/fish") || path.startsWith("/observations/fish")) return "fish";
  if (path.startsWith("/timing-profiles")) return "timing";
  if (path.startsWith("/promotions")) return "promotions";
  if (path.includes("control-arm-counts")) return "controls";
  return "master";
}

export function markInvalidFields(form: HTMLFormElement | null, page: Page, language: Language) {
  return Array.from(form?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea") ?? []).filter((control) => !control.validity.valid).map((control, index) => {
    if (!control.id) {
      let suffix = index + 1;
      while (document.getElementById(`invalid-${page}-${suffix}`)) suffix += 1;
      control.id = `invalid-${page}-${suffix}`;
    }
    const errorId = `${control.id}-error`;
    const message = language === "th" ? "กรุณากรอกหรือแก้ไขข้อมูลในช่องนี้" : "Enter or correct this field.";
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", [...new Set([...(control.getAttribute("aria-describedby")?.split(" ") ?? []), errorId])].join(" "));
    control.parentElement?.setAttribute("data-field-error", message);
    return { id: control.id, errorId, label: control.labels?.[0]?.textContent?.trim() || control.getAttribute("aria-label") || (language === "th" ? `ช่องที่ ${index + 1}` : `Field ${index + 1}`), message };
  });
}

function App() {
  const [page, setPage] = useState<Page>(
    (location.hash.slice(1) as Page) || "dashboard",
  );
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem("chronofish.language") === "en" ? "en" : "th");
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);
  const [rejected, setRejected] = useState<QueuedWriteRecord[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [operators, setOperators] = useState<ApiItem[]>([]);
  const [formErrors, setFormErrors] = useState<{ id: string; errorId: string; label: string; message: string }[]>([]);
  const validationFrame = useRef(0);
  const previousPage = useRef(page);
  const currentOperator = operatorId();
  const writePage = !["dashboard", "audit", "export"].includes(page);
  const t = text[language];
  const navItems: NavItem[] = [
    { page: "dashboard", label: t.dashboard, icon: "dashboard", group: "primary" },
    { page: "due", label: t.due, icon: "due", group: "primary" },
    { page: "batches", label: t.batches, icon: "batches", group: "primary" },
    { page: "fish", label: t.fish, icon: "fish", group: "primary" },
    { page: "promotions", label: t.promotions, icon: "promotions", group: "research" },
    { page: "controls", label: t.controls, icon: "controls", group: "research" },
    { page: "timing", label: t.timing, icon: "timing", group: "system" },
    { page: "export", label: t.export, icon: "export", group: "research" },
    { page: "master", label: t.master, icon: "master", group: "system" },
    { page: "audit", label: t.audit, icon: "audit", group: "system" },
  ];
  const currentNav = navItems.find((item) => item.page === page) ?? navItems[0];

  useEffect(() => {
    void get("/operators")
      .then((data) => setOperators(data.items ?? []))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem("chronofish.language", language);
  }, [language]);
  useEffect(() => {
    document.title = `${currentNav.label} · ${productName}`;
  }, [currentNav.label]);
  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    setFormErrors([]);
    window.scrollTo({ top: 0, behavior: "auto" });
    window.requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }, [page]);
  useEffect(() => {
    const followHistory = () => {
      const next = location.hash.slice(1) as Page;
      if (navItems.some((item) => item.page === next)) setPage(next);
    };
    window.addEventListener("hashchange", followHistory);
    window.addEventListener("popstate", followHistory);
    return () => {
      window.removeEventListener("hashchange", followHistory);
      window.removeEventListener("popstate", followHistory);
    };
  }, []);
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

  const navigate = (next: Page) => {
    if (next !== page) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}#${next}`);
    setPage(next);
  };
  const renderNav = (items: NavItem[]) => items.map((item) => (
    <button
      key={item.page}
      aria-current={page === item.page ? "page" : undefined}
      className={page === item.page ? "nav-link nav-link--active" : "nav-link"}
      onClick={(event) => {
        event.currentTarget.closest(".nav-disclosure--mobile")?.removeAttribute("open");
        navigate(item.page);
      }}
    >
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </button>
  ));
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">{language === "th" ? "ข้ามไปยังเนื้อหาหลัก" : "Skip to main content"}</a>
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><Icon name="fish" /></span>
          <span className="brand-copy">
            <span className="brand">{productName}</span>
            <span className="tagline">{language === "th" ? "พื้นที่บันทึกงานวิจัย SCNT" : "SCNT research workspace"}</span>
          </span>
        </div>
        <nav aria-label={language === "th" ? "เมนูหลัก" : "Main navigation"} className="sidebar-nav">
          <div className="nav-group nav-group--primary">
            <p className="nav-group__label">{language === "th" ? "งานหลัก" : "Core work"}</p>
            {renderNav(navItems.filter((item) => item.group === "primary"))}
          </div>
          <details className="nav-disclosure nav-disclosure--desktop" open={navItems.some((item) => item.group === "research" && item.page === page)}>
            <summary>{language === "th" ? "งานต่อเนื่องและรายงาน" : "Follow-up & reports"}</summary>
            <div className="nav-group">{renderNav(navItems.filter((item) => item.group === "research"))}</div>
          </details>
          <details className="nav-disclosure nav-disclosure--desktop" open={navItems.some((item) => item.group === "system" && item.page === page)}>
            <summary>{language === "th" ? "ข้อมูลอ้างอิงและระบบ" : "Reference & system"}</summary>
            <div className="nav-group">{renderNav(navItems.filter((item) => item.group === "system"))}</div>
          </details>
          <details className="nav-disclosure nav-disclosure--mobile">
            <summary><Icon name="more" /><span>{language === "th" ? "เพิ่มเติม" : "More"}</span></summary>
            <div className="nav-group">{renderNav(navItems.filter((item) => item.group !== "primary"))}</div>
          </details>
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note__pulse" aria-hidden="true" />
          <span><strong>{language === "th" ? "ระบบพร้อมบันทึก" : "System ready"}</strong><small>{language === "th" ? "ข้อมูลมี audit trail และทำงานออฟไลน์ได้" : "Audit trail active · offline capable"}</small></span>
        </div>
      </aside>
      <header className="topbar">
        <div className="workspace-context">
          <span>
            <span className="workspace-kicker">{language === "th" ? "กำลังใช้งาน" : "Current view"}</span>
            <strong>{currentNav.label}</strong>
          </span>
        </div>
        <div className="top-actions">
          <label className="operator-select">
            <span className="sr-only">{t.chooseOperator}</span>
            <select
              id="operator-select"
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
            <span className="sr-only" role="status">
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
          <span className={`queue ${pending + rejected.length ? "queue--pending" : ""}`} aria-live="polite">
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
            aria-label={language === "th" ? "เปลี่ยนภาษาเป็นอังกฤษ" : "Switch language to Thai"}
          >
            {language === "th" ? "EN" : "ไทย"}
          </button>
        </div>
      </header>
      <main className="content" id="main-content" tabIndex={-1}>
        {writePage && !currentOperator && <div className="operator-gate" role="alert"><strong>{t.operatorRequired}</strong><button type="button" onClick={() => document.getElementById("operator-select")?.focus()}>{t.chooseOperator}</button></div>}
        {formErrors.length > 0 && <div className="error form-error-summary" id="form-error-summary" role="alert" tabIndex={-1}><strong>{language === "th" ? "ตรวจสอบข้อมูลที่ต้องแก้ไข" : "Check the fields that need attention"}</strong><ul>{formErrors.map((item) => <li id={item.errorId} key={item.id}><a href={`#${item.id}`}>{item.label}</a>: {item.message}</li>)}</ul></div>}
        <fieldset
          className="page-gate"
          disabled={writePage && !currentOperator}
          aria-describedby={writePage && !currentOperator ? "operator-select" : undefined}
          onInvalid={(event: FormEvent<HTMLElement>) => {
            const field = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            window.cancelAnimationFrame(validationFrame.current);
            validationFrame.current = window.requestAnimationFrame(() => {
              setFormErrors(markInvalidFields(field.form, page, language));
              window.requestAnimationFrame(() => document.getElementById("form-error-summary")?.focus());
            });
          }}
          onInputCapture={(event: FormEvent<HTMLElement>) => {
            const field = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            if (field.validity?.valid) {
              field.removeAttribute("aria-invalid");
              const describedBy = field.getAttribute("aria-describedby")?.split(" ").filter((id) => id !== `${field.id}-error`).join(" ");
              if (describedBy) field.setAttribute("aria-describedby", describedBy); else field.removeAttribute("aria-describedby");
              field.parentElement?.removeAttribute("data-field-error");
              setFormErrors((current) => current.filter((item) => item.id !== field.id));
            }
          }}
        >
          {writePage && <p className="required-note">{language === "th" ? "ช่องที่มีเครื่องหมาย * จำเป็นต้องกรอก" : "Fields marked * are required"}</p>}
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
        </fieldset>
      </main>
    </div>
  );
}

export default App;
