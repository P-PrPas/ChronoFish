# รายงานประเมิน UX/UI และแผน Redesign ตาม WCAG 2.2

**ผลิตภัณฑ์:** KUVTH Zebrafish LIMS — SCNT Research Workspace
**วันที่ประเมิน:** 31 สิงหาคม 2026
**เป้าหมาย:** WCAG 2.2 ระดับ AA และประสบการณ์ใช้งานที่เหมาะกับนักวิจัยทั้ง desktop และ mobile
**สถานะเอกสาร:** Baseline audit ก่อน redesign

## 1. บทสรุปผู้บริหาร

KUVTH Zebrafish LIMS มีพื้นฐาน UI ที่ดีกว่าระบบงานภายในทั่วไปอย่างชัดเจน: visual hierarchy สม่ำเสมอ, ใช้ native HTML controls, มี skip link, รองรับ keyboard tabs, มี loading/empty/error states, มี reduced-motion, ตารางเป็น semantic HTML และ dashboard มีตารางข้อมูลสำรองให้กราฟ

อย่างไรก็ตาม **ยังไม่ควรประกาศว่าเว็บไซต์ผ่าน WCAG 2.2 AA** เพราะใน implementation ที่สุ่มตรวจพบ blocker ที่วัดหรือยืนยันจากโค้ดได้ ได้แก่:

1. สีเส้นขอบ input และสีกราฟบางชุดไม่ถึง contrast 3:1 ตาม SC 1.4.11
2. accessible name ภาษาอังกฤษบางจุดทับ visible label ภาษาไทย ทำให้ไม่ตรงกับ SC 2.5.3 และสร้างความเสี่ยงต่อ SC 3.1.2
3. สถานะบันทึก/รอ sync ถูก `display: none` บน mobile ≤430px ทั้งที่เป็นข้อมูลสำคัญต่อความมั่นใจว่าข้อมูลงานวิจัยถูกบันทึกแล้ว
4. mobile navigation ใช้ horizontal scroller; เมื่อเข้า deep link ของเมนูรอง/ระบบ active item เริ่มอยู่นอก viewport จึงไม่เห็นตำแหน่งปัจจุบัน

### คะแนนภาพรวม

**73/100 — พื้นฐานดี แต่ต้องแก้ accessibility และ mobile-critical feedback ก่อนขยายฟีเจอร์**

คะแนนนี้เป็น heuristic สำหรับจัดลำดับ redesign ไม่ใช่ใบรับรอง conformance

| หมวด | น้ำหนัก | คะแนน | สรุป |
|---|---:|---:|---|
| Accessibility & semantics | 25% | 78 | โครงสร้างดี แต่มี AA blockers เรื่อง contrast และชื่อ control |
| Responsive & mobile | 15% | 64 | main content reflow ได้ แต่ navigation และ global status ยังมีปัญหา |
| Navigation & information architecture | 15% | 68 | desktop ชัดเจน; mobile ค้นหาเมนูรองยากและ active item หลุด viewport |
| Forms & critical workflows | 15% | 72 | ใช้ native controls ดี แต่ error recovery และ required-state ยังไม่ครบ |
| Visual hierarchy & readability | 10% | 86 | สุภาพ เป็นระบบ เหมาะกับงานวิจัย และอ่านง่ายโดยรวม |
| Data visualization | 10% | 68 | มี table alternative และ pattern แต่บางสีไม่ผ่านและ label เล็ก |
| Feedback & offline confidence | 5% | 66 | แนวคิด offline queue ดีมาก แต่ซ่อนสถานะสำคัญบนโทรศัพท์ |
| Performance & perceived speed | 5% | 86 | ไม่มีภาพหนัก, font local, bundle ยังอยู่ในระดับควบคุมได้ |

## 2. ขอบเขตและวิธีประเมิน

ตรวจเส้นทางหลัก 10 หน้า:

- ผลการทดลอง (`#dashboard`)
- งานตรวจวันนี้ (`#due`)
- การทดลอง (`#batches`)
- ดูแลปลา (`#fish`)
- ขึ้นทะเบียนปลาโคลน (`#promotions`)
- ผลกลุ่มเปรียบเทียบ (`#controls`)
- เวลามาตรฐาน (`#timing`)
- ดาวน์โหลดข้อมูล (`#export`)
- ตั้งค่าห้องแล็บ (`#master`)
- ตรวจสอบการแก้ไข (`#audit`)

วิธีที่ใช้:

- ตรวจ source ของ React, semantic HTML, ARIA, focus management และ responsive CSS
- รันเว็บจริงด้วย backend แบบ memory และ Vite development server
- ตรวจภาพที่ viewport 1440×1000, 375×812 และตรวจ reflow ที่ 320 CSS px
- เดินลำดับ Tab บน mobile และทดสอบ Arrow Left/Right ของ dashboard tabs
- วัด contrast จากสีจริงใน design tokens และ chart palette
- ตรวจ production build size และ behavior ของ loading/empty/operator-gate
- เทียบกับ [WCAG 2.2 Recommendation](https://www.w3.org/TR/WCAG22/) และเอกสาร Understanding ของ W3C

ข้อจำกัด:

- backend แบบ memory ไม่มีข้อมูลวิจัยและ operator ครบทุก state จึงตรวจ workflow ที่ต้องมีข้อมูลจริงจาก source และ test coverage เป็นหลัก
- ยังไม่ได้ทดสอบกับ NVDA, JAWS, VoiceOver, TalkBack, switch control หรือผู้ใช้จริง
- ยังไม่ได้ทดสอบทุก error response จาก API, slow network, offline replay และ rejected queue ด้วย browser จริง
- ดังนั้นผลนี้เป็น **expert audit + sampled technical verification** ไม่ใช่ third-party accessibility certification

## 3. ผลที่ทำได้ดีและควรรักษาไว้

### Accessibility foundation

- `<html lang>` เปลี่ยนตามภาษาที่เลือก และไม่ปิด browser zoom
- มี skip link ไป `#main-content` (`frontend/src/App.tsx:168`)
- navigation หลักใช้ `<nav>` และ active page ใช้ `aria-current="page"`
- route ที่ผู้ใช้กดจาก navigation จะเลื่อนขึ้นบนและย้าย focus ไป main content
- form controls ส่วนใหญ่เป็น `<input>`, `<select>`, `<button>` และวางใน `<label>` โดยตรง
- error จากระบบใช้ `role="alert"`, `tabIndex={-1}` และ `autoFocus` (`frontend/src/components.tsx:25`)
- dashboard tabs และ fish tabs ใช้ roving `tabIndex`, `aria-selected`, `aria-controls` และปุ่มลูกศรได้จริง
- มี `prefers-reduced-motion` (`frontend/src/styles.css:410`)
- visible interactive controls ที่สุ่มตรวจส่วนใหญ่สูงอย่างน้อย 44px ซึ่งสูงกว่า WCAG 2.2 AA ขั้นต่ำ 24×24 CSS px
- sticky header ไม่บัง focused control ในลำดับ Tab ที่สุ่มตรวจบน dashboard mobile

### Readability and visual consistency

- body text 16px, line-height 1.58 และใช้ IBM Plex Thai local font
- color tokens, radius, elevation และ spacing มีภาษาภาพเดียวกันเกือบทุกหน้า
- primary action, secondary action และ destructive action แยกกันค่อนข้างชัด
- contrast ของข้อความหลักผ่าน: `--muted` บน white = 4.88:1 และบน canvas = 4.51:1; primary/white = 6.72:1
- desktop sidebar แบ่ง Core work, Follow-up & reports และ Reference & system ได้เหมาะกับ mental model ของระบบ

### Workflow and data

- operator gate อธิบายสาเหตุและมีปุ่มพา focus ไปยัง operator selector
- งาน due มี bulk action เฉพาะแถวที่ยังว่าง ลดงานซ้ำโดยไม่ทับข้อมูลเดิม
- correction และ destructive flow หลายจุดต้องมีเหตุผลหรือ confirmation
- dashboard กราฟมี semantic table alternative และ table wrapper ใช้งานด้วย keyboard ได้
- chart series ไม่พึ่งสีอย่างเดียวทั้งหมด เพราะมี dash pattern และ legend buttons ที่ใช้ `aria-pressed`
- มี loading, empty, error, retry และ offline queue architecture อยู่แล้ว

## 4. ประเด็นเร่งด่วนตามลำดับความสำคัญ

ระดับความรุนแรง:

- **P0:** เสี่ยงสูญเสียข้อมูล, ขวางงานหลัก หรือเป็น WCAG AA blocker ชัดเจน
- **P1:** กระทบผู้ใช้จำนวนมากหรือทำให้ workflow ช้าสับสน
- **P2:** ปรับคุณภาพ ความสบายในการใช้ และความสม่ำเสมอ

### F01 — สถานะบันทึกและ sync หายไปบน mobile

**ระดับ:** P0
**ผลกระทบ:** ผู้ใช้ภาคสนามไม่รู้ว่าข้อมูลบันทึกแล้ว, กำลัง sync, ค้าง หรือถูก reject; เพิ่มโอกาสปิดหน้า/ทำซ้ำและทำให้ไม่เชื่อมั่นข้อมูลวิจัย

หลักฐาน:

- queue มี `aria-live="polite"` ใน `frontend/src/App.tsx:238`
- แต่ `.queue` ถูก `display: none` ที่ viewport ≤430px ใน `frontend/src/styles.css:401`
- การซ่อนด้วย CSS ทำให้ทั้งข้อความที่มองเห็นและ accessibility tree หายไป

WCAG ที่เกี่ยวข้อง: 4.1.3 Status Messages (AA), 1.3.1 Info and Relationships, usability/error prevention

ข้อเสนอ:

- ห้ามซ่อน queue state บน mobile
- แสดง compact status เช่น `บันทึกแล้ว`, `รอส่ง 3`, `ส่งไม่สำเร็จ 1`
- live region ต้องอยู่ใน DOM ตลอด แม้ visual UI จะย่อเป็น icon + count
- rejected state ต้องค้างจนผู้ใช้เปิดดู/แก้ไข ไม่ auto-dismiss

เกณฑ์รับงาน:

- ที่ 320px ผู้ใช้และ screen reader รับรู้ saved/pending/syncing/rejected ได้
- pending/rejected เปิดรายละเอียดและไปหน้าที่เกี่ยวข้องได้ใน ≤2 actions
- status ไม่แย่ง focus และไม่ประกาศซ้ำทุก render

### F02 — Non-text contrast ไม่ผ่านใน input และกราฟ

**ระดับ:** P0
**ผลกระทบ:** ผู้มีสายตาเลือนรางมองขอบเขตช่องกรอกและเส้นข้อมูลไม่ชัด

หลักฐานที่วัดได้:

| คู่สี | Contrast | เป้าหมาย | ผล |
|---|---:|---:|---|
| `--line-strong #bdccc7` / white | 1.66:1 | 3:1 | ไม่ผ่านสำหรับขอบ input ที่จำเป็นต่อการระบุ control |
| fish chart `#ef9f67` / white | 2.14:1 | 3:1 | ไม่ผ่าน |
| fish chart `#78c7b5` / white | 1.97:1 | 3:1 | ไม่ผ่าน |
| fish chart `#caa7f7` / white | 2.02:1 | 3:1 | ไม่ผ่าน |
| fish chart `#f2d479` / white | 1.45:1 | 3:1 | ไม่ผ่าน |
| fish chart `#8ab6ed` / white | 2.10:1 | 3:1 | ไม่ผ่าน |

ที่มา: `frontend/src/styles.css:25,130` และ `frontend/src/pages/dashboard.tsx:295`

WCAG: [SC 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) กำหนด visual information ที่จำเป็นต่อการระบุ UI component/graphic อย่างน้อย 3:1

ข้อเสนอที่เล็กที่สุด:

- ปรับ `--line-strong` ให้ผ่าน 3:1 บน `--surface`; ไม่ต้องเปลี่ยน component รายตัว
- reuse chart palette สีเข้มที่มีอยู่แล้ว (`#0b6761`, `#b67b2f`, `#557f9c`, `#775f8f`, `#a83c35`)
- ใช้ dash/marker shape ควบคู่กับสีทุก series
- เพิ่ม automated contrast check ให้เฉพาะ semantic token และ chart palette

เกณฑ์รับงาน: control boundary และ meaningful chart marks ทุกสี ≥3:1 ในทุก state

### F03 — Accessible name ภาษาอังกฤษทับ visible label ภาษาไทย

**ระดับ:** P0
**ผลกระทบ:** ผู้ใช้ voice control เรียก control ด้วยคำที่เห็นไม่ได้ และ Thai screen reader อ่านชื่อภาษาอังกฤษด้วยภาษาไทย

ตัวอย่าง:

- visible `สถานที่` แต่ `aria-label="Filter due by site"`
- visible `ผู้ปฏิบัติงาน` แต่ `aria-label="Filter due by operator"`
- visible `เหตุผลที่แก้ไข` แต่ `aria-label="Correction reason"`
- `Well for…`, `Expected HPA…`, `Fish code…`, `Fish box…` และ `CSV preview` เป็นอังกฤษตายตัวใน Thai UI

หลักฐาน: `frontend/src/pages/due.tsx:82,83,242`, `frontend/src/pages/batches.tsx:1026`, `frontend/src/pages/settings.tsx:408,432,614,624`

WCAG: 2.5.3 Label in Name (A), 3.1.2 Language of Parts (AA), 4.1.2 Name, Role, Value (A)

ข้อเสนอ:

- ถ้า control อยู่ใน `<label>` ที่ชัดเจนแล้ว ให้ **ลบ redundant `aria-label`** เพื่อให้ native label เป็น accessible name
- control รายแถวที่ต้องใส่รหัส specimen ให้สร้าง accessible name จากข้อความภาษาเดียวกับ UI
- caption/aria-label ของตารางและกราฟต้อง localize เช่นเดียวกับ visible copy

เกณฑ์รับงาน:

- accessible name มี visible label เป็น substring
- เมื่อ `<html lang="th">` ไม่มีประโยคอังกฤษทั่วไปใน accessible name ยกเว้นรหัส/คำเทคนิคที่จำเป็น

### F04 — Mobile navigation ซ่อน current location และบังคับเลื่อนแนวนอน

**ระดับ:** P0 ด้าน mobile UX / P1 ด้าน conformance
**ผลกระทบ:** ผู้ใช้หา Promotions, Controls, Timing, Export, Master และ Audit ยาก; เมื่อเข้าด้วย deep link active item เริ่มอยู่นอกจอ

ผลวัดที่ 320 CSS px:

| Route | nav viewport / content | ตำแหน่ง active item |
|---|---:|---|
| Core pages | 296 / 313px | dashboard–fish มองเห็น |
| Promotions | 296 / 410px | x=320–417, อยู่นอก viewport |
| Timing | 296 / 406px | x=325–418, อยู่นอก viewport |
| Master | 296 / 406px | x=325–418, อยู่นอก viewport |
| Audit | 296 / 408px | x=325–420, อยู่นอก viewport |

main document ไม่เกิด horizontal page overflow ที่ 320px แต่ navigation เป็น internal horizontal scroller ซึ่งต้องประเมิน SC 1.4.10 Reflow เพิ่มด้วย assistive technology และ zoom จริง

ข้อเสนอ:

- mobile แสดง 4 core destinations + ปุ่ม `เพิ่มเติม`
- `เพิ่มเติม` ใช้ native `<details>`/popover list แบ่ง Follow-up และ System; ไม่ต้องเพิ่ม navigation library
- แสดงชื่อ current view ใน mobile topbar แทนการซ่อน `.workspace-context`
- เมื่อเปิด deep link/back ให้ current item เห็นทันทีและประกาศชื่อหน้า

เกณฑ์รับงาน:

- ทุกหน้าหาได้ภายใน 2 actions ที่ 320px
- current page มองเห็นและ programmatically determinable เสมอ
- navigation ไม่ต้องเลื่อนแนวนอน

### F05 — Focus indicator ผ่านระดับมองเห็นทั่วไป แต่ยังอ่อนสำหรับ low vision

**ระดับ:** P1
**ผลกระทบ:** focus ring `rgba(...,.3)` บนพื้นอ่อนมี contrast ต่ำ แม้มีขนาด 3px

หลักฐาน: `frontend/src/styles.css:48`; field focus ใช้ border primary ซึ่งชัดกว่า

WCAG 2.2 ระดับ AA ต้องมี Focus Visible และ Focus Not Obscured; [Focus Appearance 2.4.13](https://www.w3.org/TR/WCAG22/#focus-appearance) เป็น AAA แต่ควรใช้เป็นคุณภาพเป้าหมายของระบบที่มีข้อมูลสำคัญ

ข้อเสนอ: ใช้ outline สีทึบ semantic focus token ≥3:1, 2–3px, offset 2px และทดสอบบน canvas/surface/danger-soft

### F06 — Error recovery ของ form ยังพึ่ง browser และ error รวมมากเกินไป

**ระดับ:** P1
**ผลกระทบ:** native `required` ช่วยกรณีว่าง แต่ API validation หลาย field อาจแสดงเพียง alert รวม ทำให้ผู้ใช้ต้องหา field เอง โดยเฉพาะ form ยาว

สิ่งที่ดี: native validation จะ focus field แรกที่ผิด และ `ErrorMessage` ประกาศ error ได้

ช่องว่าง:

- ไม่มี pattern สำหรับ `aria-invalid` + `aria-describedby` ที่ field
- ไม่มี linked error summary เมื่อหลาย field ผิด
- required field ไม่มี visible marker/คำอธิบายที่สม่ำเสมอ
- server error ยังไม่เห็นหลักฐานว่าผูกกลับ field ที่เป็นสาเหตุ

WCAG: [3.3.1 Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification.html), 3.3.2 Labels or Instructions, 3.3.3 Error Suggestion

ข้อเสนอ: เริ่มเฉพาะ workflow เสี่ยงสูง—สร้าง batch, บันทึกรอบตรวจ, promotion และ timing import—ก่อนทำทั้งระบบ

### F07 — selected state ของ master-data toolbar เป็น visual-only

**ระดับ:** P1
**ผลกระทบ:** screen reader ไม่รู้ว่ากำลังแก้ข้อมูลประเภทใด แม้สีและ class จะเปลี่ยน

หลักฐาน: `frontend/src/pages/master.tsx:43` ใช้ `tab tab--active` แต่ไม่มี `aria-pressed`, `aria-current` หรือ tab pattern

ข้อเสนอที่เล็กที่สุด: ใช้ `aria-pressed={resource === key}` กับปุ่มเดิม และมี heading ของ content ที่เปลี่ยนตาม resource

### F08 — route change ผ่าน Back/Forward ไม่จัดการ focus/title เหมือนการกดเมนู

**ระดับ:** P1
**ผลกระทบ:** browser Back เปลี่ยนเนื้อหาแต่ focus อาจค้างที่ control เดิม และ document title ยังเป็นชื่อ workspace ทั่วไป

หลักฐาน:

- `navigate()` ย้าย focus (`frontend/src/App.tsx:149–154`)
- `hashchange/popstate` เปลี่ยนเพียง state (`frontend/src/App.tsx:88–97`)
- `<title>` คงที่ (`frontend/index.html:11`)

ข้อเสนอ: ย้าย scroll/focus/title update ไป effect เดียวที่ทำงานทุกครั้งเมื่อ `page` เปลี่ยน แก้ที่ shared root ครั้งเดียว

### F09 — ตัวอักษร navigation/chart บางจุดเล็กเกินใช้งานสบาย

**ระดับ:** P2
**ผลกระทบ:** mobile nav label 10.72px, well metadata 10.88px และ chart label 9.5–10.5px อ่านยากในห้องแล็บหรือขณะถือโทรศัพท์

หลักฐาน: `frontend/src/styles.css:192,229,354,399,407`

WCAG ไม่มี minimum font size ตายตัว แต่เป็น usability และ text-scaling risk

ข้อเสนอ:

- กำหนด 12px เป็น minimum สำหรับ supplemental data และ 14px สำหรับ navigation/interactive labels
- ลดจำนวน item ที่แสดงพร้อมกันแทนการย่อข้อความ
- ทดสอบ text resize 200% และ browser zoom 400%

### F10 — Destructive/correction interactions ยังไม่เป็น pattern เดียวกัน

**ระดับ:** P2
**ผลกระทบ:** บางจุดใช้ `confirm`, บางจุดใช้ `prompt`, บางจุดมี undo 10 วินาที ทำให้ mental model ไม่สม่ำเสมอ

ตัวอย่าง: การลบ fish observation ขอเหตุผลด้วย `window.prompt` (`frontend/src/pages/fish.tsx:141`) ขณะที่ due correction มี confirm และ undo

ข้อเสนอ:

- ระยะสั้นคง native confirm ไว้ เพราะ accessible และไม่ต้องเพิ่ม dependency
- ทำ inline correction panel/`<dialog>` เฉพาะ action ที่ต้องกรอกเหตุผล
- แสดง object, consequence, reason และ primary destructive action ให้ครบ
- เพิ่ม undo เฉพาะรายการที่ backend รองรับ rollback ปลอดภัย

### F11 — Accessibility ของกราฟควรบอก insight ไม่ใช่เพียงชื่อกราฟ

**ระดับ:** P2
**ผลกระทบ:** `aria-label` เช่น “กราฟอัตรารอด…” บอกชนิดกราฟ แต่ไม่บอกแนวโน้มสำคัญ; ผู้ใช้ต้องเปิดตารางเพื่อทำความเข้าใจทั้งหมด

ข้อเสนอ:

- สร้าง text summary จากข้อมูล เช่น จุดตกสูงสุด, sample size, กลุ่มที่ต่างชัด
- ให้ summary อยู่ก่อนกราฟและ table alternative อยู่ใกล้กราฟ
- label แกน/หน่วยให้ครบ และเพิ่ม chart text เป็นอย่างน้อย 12px
- คง legend buttons และ dash patterns ที่มีอยู่

### F12 — อย่ารีบเพิ่ม design system library หรือ route splitting

**ระดับ:** Keep/Monitor
**เหตุผล:** CSS เดิมมี semantic tokens และ components เพียงพอ; production bundle 366.29kB raw / 104.61kB gzip และ CSS 33.22kB raw ยังไม่ใช่ bottleneck ที่มีหลักฐาน

ข้อเสนอ: แก้ shared tokens, App shell และ critical workflows ใน code เดิมก่อน เพิ่ม dependency เมื่อ profiling หรือ regression cost พิสูจน์ว่าจำเป็น

## 5. ประเมินรายหน้า

| หน้า | คะแนน | จุดแข็ง | ปัญหาหลัก |
|---|---:|---|---|
| Dashboard | 78 | question-first hierarchy, filters ยุบได้, semantic tables, keyboard tabs | chart palette, label เล็ก, summary สำหรับ screen reader ยังทั่วไป |
| Due | 72 | operator gate ชัด, bulk-to-blank ปลอดภัย, status และ undo บางส่วน | Thai label ถูก English aria-label ทับ, form error recovery |
| Batches | 74 | CTA/empty state ชัด, progressive workflow | form ยาว, required/error pattern, mobile current-nav |
| Fish | 76 | Daily check มาก่อน registry, tab pattern ดี, action states ชัด | delete ใช้ prompt, secondary info หนาแน่นบน mobile |
| Promotions | 68 | eligibility flow และ selection ชัด | route หาไม่ง่ายบน mobile, active nav อยู่นอกจอ |
| Controls | 69 | grouping และ native controls | mobile navigation, accessible copy บางจุดเป็นอังกฤษ |
| Timing | 67 | version history/import preview ลดความเสี่ยง | dense workflow, English accessible labels, current-nav hidden |
| Export | 77 | filters, preview, format grouping และ read-only flow เหมาะสม | mobile route discoverability, print/screen-reader QA ยังไม่ครบ |
| Master | 70 | แบ่ง location กับ reusable data ชัด, inactivate ไม่ลบ history | selected resource state visual-only, form density |
| Audit | 76 | filter + semantic expandable records เหมาะกับงานตรวจสอบ | mobile route discoverability, long values/text scaling ต้องทดสอบจริง |

## 6. WCAG 2.2 conformance matrix แบบย่อ

| Success Criterion | ระดับ | สถานะจาก sample | หมายเหตุ |
|---|---|---|---|
| 1.1.1 Non-text Content | A | ผ่านใน sample | icons ตกแต่งใช้ `aria-hidden`; ไม่มี meaningful raster images |
| 1.3.1 Info and Relationships | A | ผ่านส่วนใหญ่ | semantic labels/tables/headings ดี; master selected state ต้องแก้ |
| 1.4.1 Use of Color | A | ผ่านส่วนใหญ่ | chart มี dash/labels; online indicator mobile ควรมี visible text |
| 1.4.3 Contrast Minimum | AA | ผ่านใน token หลัก | muted/canvas = 4.51:1; ต้องตรวจทุก runtime state เพิ่ม |
| 1.4.10 Reflow | AA | ต้องแก้/ยืนยัน | document = 320px ไม่มี page overflow แต่ nav ต้อง horizontal scroll |
| 1.4.11 Non-text Contrast | AA | **ไม่ผ่าน** | input border 1.66:1; fish chart colors 1.45–2.14:1 |
| 2.1.1 Keyboard | A | ผ่านใน sample | nav, details และ tabs ใช้ keyboard ได้ |
| 2.4.1 Bypass Blocks | A | ผ่าน | มี skip link |
| 2.4.2 Page Titled | A | เสี่ยง | title ไม่เปลี่ยนตาม hash route |
| 2.4.3 Focus Order | A | ผ่านส่วนใหญ่ | click navigation ดี; Back/Forward ต้องแก้ |
| 2.4.7 Focus Visible | AA | ผ่านใน sample | มี global focus indicator |
| 2.4.11 Focus Not Obscured | AA | ผ่านใน sample | Tab 16 ขั้นบน dashboard mobile ไม่ถูก sticky UI บัง |
| 2.5.3 Label in Name | A | **ไม่ผ่านใน Thai UI** | fixed English aria-label ทับ visible Thai labels |
| 2.5.8 Target Size Minimum | AA | ผ่านใน sample | visible controls ส่วนใหญ่ ≥44px; WCAG ขั้นต่ำ 24px |
| 3.1.1 Language of Page | A | ผ่าน | `documentElement.lang` อัปเดตตามภาษา |
| 3.1.2 Language of Parts | AA | **เสี่ยงสูง/พบตัวอย่างไม่ผ่าน** | English accessible phrases สืบทอด `lang=th` |
| 3.3.1 Error Identification | A | ต้องทดสอบเพิ่ม | native required ดี; API field errors ยังไม่ยืนยัน |
| 3.3.2 Labels or Instructions | A | ผ่านส่วนใหญ่ | label มี; required instruction ควรทำให้ชัด |
| 4.1.2 Name, Role, Value | A | ต้องแก้บางจุด | tabs ดี; master resource selected state ไม่ประกาศ |
| 4.1.3 Status Messages | AA | **เสี่ยงสูง** | queue live region ถูกซ่อนบน ≤430px |

## 7. ทิศทาง Redesign

### 7.1 หลักการ

1. **งานวันนี้มาก่อนข้อมูลระบบ:** core workflows ต้องเข้าถึงได้ทันที
2. **บันทึกแล้วต้องรู้แน่:** saved/pending/rejected เป็น global status ที่ห้ามหาย
3. **ลดความหนาแน่นด้วย progressive disclosure ไม่ใช่ย่อ font**
4. **ภาษาเดียวกันทั้งที่เห็นและที่ screen reader ได้ยิน**
5. **แก้ shared root/token ก่อนแก้ทีละหน้า**
6. **ไม่เพิ่ม UI dependency:** native `<details>`, `<dialog>`, form controls และ CSS เดิมเพียงพอ

### 7.2 Information architecture ใหม่

Desktop คง sidebar เดิม แต่ mobile เปลี่ยนเป็น:

| ตำแหน่ง | เนื้อหา |
|---|---|
| Brand row | KUVTH Zebrafish LIMS + current view |
| Primary nav | ผลการทดลอง, งานตรวจวันนี้, การทดลอง, ดูแลปลา |
| More | ขึ้นทะเบียนปลาโคลน, ผลกลุ่มเปรียบเทียบ, ดาวน์โหลด, เวลามาตรฐาน, ตั้งค่า, Audit |
| Global status row | Operator, saved/pending/rejected, network, language |

บนหน้า secondary/system ให้ชื่อ current view แสดงใน header เสมอ ไม่พึ่ง active item ที่อยู่นอกจอ

### 7.3 Design tokens ที่ต้องล็อก

| Token/Rule | เป้าหมาย |
|---|---|
| Body text | 16px / line-height 1.5–1.65 |
| Interactive/supporting label | ≥14px |
| Supplemental non-interactive text | ≥12px |
| Normal text contrast | ≥4.5:1 |
| Large text contrast | ≥3:1 |
| UI boundary/graphic contrast | ≥3:1 |
| Focus indicator | 2–3px, ≥3:1 กับ adjacent state |
| Product touch target | ≥44×44px; WCAG floor ≥24×24px |
| Spacing | 4/8px scale ที่มีอยู่ |
| Motion | transform/opacity และ respect reduced-motion |

## 8. แผนดำเนินงาน

### Phase 0 — แก้ blocker ก่อน redesign ภาพใหญ่ (1–2 วัน)

1. แสดง queue/sync/rejected status บน mobile และคง live region
2. ปรับ `--line-strong`, focus token และ chart palette ให้ผ่าน contrast
3. ลบ redundant English `aria-label`; localize label ที่จำเป็น
4. เพิ่ม `aria-pressed` ให้ master resource toolbar
5. เพิ่ม regression checks สำหรับ token contrast และ accessible names ที่พบ

**Definition of Done:** ไม่มี blocker ที่ยืนยันใน F01–F03 และ F07

### Phase 1 — App shell และ mobile navigation (2–4 วัน)

1. แยก 4 core routes + native More menu บน mobile
2. แสดง current view และ global save status ใน mobile header
3. ย้าย title/focus/scroll handling ไป effect กลางเมื่อ `page` เปลี่ยน
4. รองรับ deep link, Back/Forward และ restore/filter state ที่เหมาะสม
5. ตรวจ 320, 375, 768, 1024 และ 1440px ทั้งไทย/อังกฤษ

**Definition of Done:** ทุก route เข้าถึง ≤2 actions; ไม่มี horizontal navigation; active route เห็นและประกาศได้

### Phase 2 — Critical form usability (3–5 วัน)

เริ่มจาก Batches, Due, Promotions และ Timing:

1. visible required indicator + คำอธิบายรูปแบบข้อมูล
2. inline errors ที่ผูกด้วย `aria-describedby`
3. `aria-invalid` หลัง validate ไม่ใช่ระหว่างกำลังพิมพ์
4. linked error summary และย้าย focus เมื่อมีหลาย error
5. loading button ป้องกัน submit ซ้ำและมีข้อความสำเร็จ/กู้คืนได้
6. ใช้ inline correction panel หรือ native `<dialog>` เฉพาะ action ที่ต้องกรอกเหตุผล

**Definition of Done:** ผู้ใช้แก้ invalid form ได้โดยไม่ต้องเดาและ keyboard/screen reader ไปยัง error ได้โดยตรง

### Phase 3 — Dashboard และ data visualization (2–3 วัน)

1. ใช้ accessible palette + dash/marker ทุก series
2. เพิ่ม plain-language insight summary ก่อนกราฟ
3. chart text ≥12px และหน่วยแกนครบ
4. คง table alternative และทำ summary/caption เป็นภาษาปัจจุบัน
5. ทดสอบข้อมูล 1, 5 และหลาย series รวม empty/error/loading

**Definition of Done:** ทุก meaningful graphic ≥3:1; เข้าใจ insight ได้โดยไม่ต้องเห็นกราฟ

### Phase 4 — Validation กับผู้ใช้และ assistive technology (2–3 วัน)

ทดสอบงานจริงอย่างน้อย:

1. เลือก operator และบันทึกรอบตรวจ embryo
2. สร้าง batch/lot และแก้ข้อมูลผิด
3. บันทึก daily fish observation และ specimen
4. ทำงาน offline แล้วกลับ online รวม rejected queue
5. หา Promotions/Timing/Audit จาก mobile deep link
6. อ่าน dashboard และ export รายงาน

สภาพแวดล้อม:

- Keyboard-only
- NVDA + Chrome/Firefox
- VoiceOver + Safari/iPhone
- TalkBack + Chrome/Android ถ้ามีผู้ใช้ Android
- Zoom 200% และ 400%, text resize 200%
- reduced-motion, high contrast/forced colors
- slow network/offline/retry

ไม่ต้องเพิ่ม automation dependency ใน Phase 0; ใช้ Vitest/build ที่มีอยู่ก่อน แล้วเพิ่ม axe/Playwright เมื่อทีมต้องการ regression ใน CI จริง

### สถานะการ Implement (1 กันยายน 2026)

| Phase | สถานะ | สิ่งที่ดำเนินการแล้ว |
|---|---|---|
| Phase 0 | เสร็จแล้ว | แสดง saved/pending/rejected บน mobile, ปรับ contrast token/focus/chart, แก้ accessible name ตามภาษา และเพิ่ม `aria-pressed` ใน Master toolbar |
| Phase 1 | เสร็จแล้ว | mobile navigation เป็น 4 core routes + native More, แสดง current view, และรวม title/focus/scroll handling สำหรับ click, deep link และ Back/Forward |
| Phase 2 | เสร็จในขอบเขตระบบปัจจุบัน | เพิ่ม required instruction/indicator, `aria-invalid`, linked error summary และ focus recovery โดยใช้ native form validation; ปุ่มบันทึกเดิมมี loading/disabled guard อยู่แล้ว |
| Phase 3 | เสร็จแล้ว | เปลี่ยนเป็น palette ที่ผ่าน 3:1, คง dash pattern, ขยาย chart text เป็น 12px, ย้าย insight ไว้ก่อนกราฟ และแปล caption ตามภาษาปัจจุบัน |
| Phase 4 | รอดำเนินการกับผู้ใช้จริง | automation/build และ visual breakpoint check ผ่านแล้ว แต่ยังต้องทดสอบ NVDA, VoiceOver, TalkBack และ workflow กับนักวิจัยจริงก่อนประกาศ WCAG 2.2 AA |

Regression ที่เพิ่มในรอบนี้ครอบคลุม contrast token, route title/focus, mobile navigation structure, form error linkage, localized accessible names, Master selected state และ chart palette/pattern

## 9. ตัวชี้วัดหลัง redesign

| ตัวชี้วัด | เป้าหมาย |
|---|---:|
| Task completion ของ critical workflows | ≥95% |
| ผู้ใช้หา secondary route บน mobile | ≤2 actions / ≤10 วินาที |
| ผู้ใช้ตอบได้ว่าข้อมูล saved/pending/rejected หรือไม่ | 100% ใน usability test |
| Invalid submission ที่ผู้ใช้แก้ไม่สำเร็จ | <5% |
| Accidental duplicate submission | 0 ใน test scenarios |
| Horizontal page/navigation scroll ที่ 320px | 0 ยกเว้น data table/plate ที่จำเป็น |
| Text contrast | 100% ของ text token ตาม 4.5:1/3:1 |
| UI/graphic contrast | 100% ของ meaningful marks ≥3:1 |
| Keyboard completion | 100% ของ critical tasks |
| Thai visible label ตรง accessible name | 100% |

## 10. ลำดับ backlog ที่แนะนำ

| ลำดับ | งาน | Priority | Effort | ผลลัพธ์ |
|---:|---|---|---:|---|
| 1 | คืน queue/sync/rejected status บน mobile | P0 | S | ลดความเสี่ยงข้อมูลและเพิ่มความเชื่อมั่น |
| 2 | แก้ line/chart/focus contrast tokens | P0 | S | ปลด WCAG blocker หลายหน้าพร้อมกัน |
| 3 | ลบ/แปล English aria-label ที่ทับ Thai label | P0 | S | voice control และ Thai screen reader ใช้งานได้ |
| 4 | Mobile core nav + More + current view | P0/P1 | M | หา route ง่ายและไม่ต้อง horizontal scroll |
| 5 | Central page-change focus/title behavior | P1 | S | deep link/back ใช้งานคาดเดาได้ |
| 6 | Master selected state | P1 | XS | screen reader รู้ context |
| 7 | Critical form inline errors + summary | P1 | M | ลด error recovery time |
| 8 | Accessible chart palette/summary/type | P1/P2 | M | เข้าใจ dashboard ได้ทุกความสามารถ |
| 9 | Standardize destructive correction UI | P2 | M | ลดความสับสนและผิดพลาด |
| 10 | Assistive-tech + researcher usability test | P1 | M | ยืนยันว่าการแก้ทำงานกับผู้ใช้จริง |

## 11. คำตัดสิน

KUVTH Zebrafish LIMS **ไม่จำเป็นต้องรื้อ UI ใหม่ทั้งหมด** โครงสร้าง desktop, visual language และ native component foundation ใช้ต่อได้ การ redesign ที่คุ้มที่สุดคือแก้ shared CSS tokens, app shell/mobile navigation, accessible naming และ feedback ของ critical workflows ก่อน

หลังจบ Phase 0–2 คาดว่าคะแนน heuristic จะขึ้นจาก **73 → 88+** โดยไม่ต้องเปลี่ยน framework หรือเพิ่ม component library ส่วนการประกาศ WCAG 2.2 AA ควรทำหลัง Phase 4 และปิดทุก failure จากการทดสอบด้วย assistive technology และข้อมูลจริงแล้วเท่านั้น
