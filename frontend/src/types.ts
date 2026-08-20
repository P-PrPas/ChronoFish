import type { ApiItem } from './api/client'

export type Page = 'dashboard' | 'due' | 'batches' | 'fish' | 'master' | 'timing' | 'promotions' | 'controls' | 'audit' | 'export'
export type Language = 'th' | 'en'
export type AppText = typeof text.th

export const text = {
  th: { dashboard: 'ภาพรวม', due: 'รายการถึงกำหนด', batches: 'รอบทดลอง', fish: 'ทะเบียนปลา', master: 'ข้อมูลหลัก', online: 'เชื่อมต่อแล้ว', offline: 'ออฟไลน์', save: 'บันทึก', refresh: 'รีเฟรช', allAlive: 'รอดทั้งหมด', pending: 'ค้างส่ง', empty: 'ยังไม่มีข้อมูล' },
  en: { dashboard: 'Dashboard', due: 'Due now', batches: 'Experiments', fish: 'Fish registry', master: 'Master data', online: 'Online', offline: 'Offline', save: 'Save', refresh: 'Refresh', allAlive: 'All alive', pending: 'Pending', empty: 'No data yet' },
}

export type { ApiItem }
