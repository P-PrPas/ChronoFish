import { useEffect, useState } from 'react'

type ApiState = 'checking' | 'online' | 'offline'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api/v1'

export default function App() {
  const [apiState, setApiState] = useState<ApiState>('checking')

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${apiBaseUrl}/health`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setApiState('online')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setApiState('offline')
      })
    return () => controller.abort()
  }, [])

  return (
    <main>
      <section aria-labelledby="page-title" className="card">
        <p className="eyebrow">SCNT tracking system</p>
        <h1 id="page-title">ChronoFish</h1>
        <p className="lead">พื้นที่ทำงานสำหรับติดตามตัวอ่อนและปลาโคลน ตั้งแต่การทดลองจนถึงการติดตามรายวัน</p>
        <div aria-live="polite" className={`status status--${apiState}`}>
          <span aria-hidden="true" />
          API: {apiState === 'checking' ? 'กำลังตรวจสอบ' : apiState === 'online' ? 'พร้อมใช้งาน' : 'ยังไม่ได้เชื่อมต่อ'}
        </div>
      </section>
    </main>
  )
}
