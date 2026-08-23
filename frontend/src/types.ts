import type { ApiItem } from "./api/client";

export type Page =
  | "dashboard"
  | "due"
  | "batches"
  | "fish"
  | "master"
  | "timing"
  | "promotions"
  | "controls"
  | "audit"
  | "export";
export type Language = "th" | "en";
export type AppText = typeof text.th;

export const text = {
  th: {
    dashboard: "ภาพรวม",
    due: "รายการถึงกำหนด",
    batches: "รอบทดลอง",
    fish: "ทะเบียนปลา",
    master: "ข้อมูลหลัก",
    timing: "โปรไฟล์เวลา",
    promotions: "เลี้ยงปลาโคลน",
    controls: "กลุ่มควบคุม",
    audit: "ประวัติการแก้ไข",
    export: "ส่งออก",
    online: "เชื่อมต่อแล้ว",
    offline: "ออฟไลน์",
    save: "บันทึก",
    refresh: "รีเฟรช",
    allAlive: "รอดทั้งหมด",
    fishAlive: "ยังอยู่",
    fishDead: "ตาย",
    fishFrozen: "แช่แข็ง",
    fishDiscarded: "คัดออก",
    pending: "ค้างส่ง",
    saved: "บันทึกแล้ว",
    syncing: "กำลังส่ง…",
    empty: "ยังไม่มีข้อมูล",
    chooseOperator: "เลือกผู้ปฏิบัติงาน",
    operatorRequired: "ต้องเลือกผู้ปฏิบัติงานก่อนบันทึก",
    retryRejected: "ลองรายการที่ปฏิเสธอีกครั้ง",
    reviewRejected: "ตรวจรายการที่ส่งไม่สำเร็จ",
    openRelated: "เปิดหน้าที่เกี่ยวข้อง",
    discardRejected: "ลบทิ้ง",
    confirmDiscard: "ลบรายการที่ส่งไม่สำเร็จนี้ออกจากคิว?",
    rejectedFallback: "เซิร์ฟเวอร์ปฏิเสธรายการนี้",
    downloadCSV: "\u0e14\u0e32\u0e27\u0e19\u0e4c\u0e42\u0e2b\u0e25\u0e14 CSV",
    importing: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e19\u0e33\u0e40\u0e02\u0e49\u0e32…",
    importCSV: "\u0e19\u0e33\u0e40\u0e02\u0e49\u0e32 CSV",
    saving: "\u0e01\u0e33\u0e25\u0e31\u0e07\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01…",
    saveTimingVersion: "\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 timing version \u0e43\u0e2b\u0e21\u0e48",
    promotionRejected: "\u0e01\u0e32\u0e23\u0e40\u0e25\u0e35\u0e49\u0e22\u0e07\u0e1b\u0e25\u0e32\u0e16\u0e39\u0e01\u0e1b\u0e0f\u0e34\u0e40\u0e2a\u0e18; \u0e15\u0e23\u0e27\u0e08\u0e2a\u0e2d\u0e1a\u0e2d\u0e35\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07",
    confirmSelected: "\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e17\u0e35\u0e48\u0e40\u0e25\u0e37\u0e2d\u0e01",
    noEligiblePromotions: "\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48\u0e21\u0e35\u0e15\u0e31\u0e27\u0e2d\u0e48\u0e2d\u0e19\u0e17\u0e35\u0e48\u0e40\u0e02\u0e49\u0e32\u0e40\u0e01\u0e13\u0e11\u0e4c",
    queued: "\u0e23\u0e2d\u0e2a\u0e48\u0e07",
    confirm: "\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19",
    controlCountsSaved: "\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e08\u0e33\u0e19\u0e27\u0e19\u0e01\u0e25\u0e38\u0e48\u0e21\u0e04\u0e27\u0e1a\u0e04\u0e38\u0e21\u0e41\u0e25\u0e49\u0e27",
    downloadExcel: "\u0e14\u0e32\u0e27\u0e19\u0e4c\u0e42\u0e2b\u0e25\u0e14 Excel",
    printPDF: "\u0e1e\u0e34\u0e21\u0e1e\u0e4c / PDF",
  },
  en: {
    dashboard: "Dashboard",
    due: "Due now",
    batches: "Experiments",
    fish: "Fish registry",
    master: "Master data",
    timing: "Timing profiles",
    promotions: "Promotions",
    controls: "Controls",
    audit: "Audit history",
    export: "Export",
    online: "Online",
    offline: "Offline",
    save: "Save",
    refresh: "Refresh",
    allAlive: "All alive",
    fishAlive: "Alive",
    fishDead: "Dead",
    fishFrozen: "Frozen",
    fishDiscarded: "Discarded",
    pending: "Pending",
    saved: "Saved",
    syncing: "Sending…",
    empty: "No data yet",
    chooseOperator: "Choose operator",
    operatorRequired: "Choose an operator before recording",
    retryRejected: "Retry rejected changes",
    reviewRejected: "Review failed changes",
    openRelated: "Open related page",
    discardRejected: "Discard rejected change",
    confirmDiscard: "Discard this rejected change from the queue?",
    rejectedFallback: "The server rejected this change",
    downloadCSV: "Download CSV",
    importing: "Importing…",
    importCSV: "Import CSV",
    saving: "Saving…",
    saveTimingVersion: "Save new timing version",
    promotionRejected: "Promotion was rejected; review the candidate again",
    confirmSelected: "Confirm selected",
    noEligiblePromotions: "No eligible embryo promotions",
    queued: "Queued",
    confirm: "Confirm",
    controlCountsSaved: "Control counts saved",
    downloadExcel: "Download Excel",
    printPDF: "Print / PDF",
  },
};

export type { ApiItem };
