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
    pending: "ค้างส่ง",
    empty: "ยังไม่มีข้อมูล",
    chooseOperator: "เลือกผู้ปฏิบัติงาน",
    operatorRequired: "ต้องเลือกผู้ปฏิบัติงานก่อนบันทึก",
    retryRejected: "ลองรายการที่ปฏิเสธอีกครั้ง",
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
    pending: "Pending",
    empty: "No data yet",
    chooseOperator: "Choose operator",
    operatorRequired: "Choose an operator before recording",
    retryRejected: "Retry rejected changes",
  },
};

export type { ApiItem };
