package export

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// Sheet is the intentionally small export seam: domain code supplies stable
// headers and rows, while this package owns the XLSX container and XML rules.
type Sheet struct {
	Name    string
	Headers []string
	Rows    [][]string
}

func Build(sheets []Sheet, version string) ([]byte, error) {
	var output bytes.Buffer
	archive := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml":        contentTypesXML(len(sheets)),
		"_rels/.rels":                relsXML(),
		"xl/workbook.xml":            workbookXML(sheets),
		"xl/_rels/workbook.xml.rels": workbookRelsXML(len(sheets)),
		"xl/styles.xml":              stylesXML(),
		"docProps/core.xml":          coreXML(version),
		"docProps/app.xml":           appXML(len(sheets)),
	}
	for name, contents := range files {
		writer, err := archive.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := io.WriteString(writer, contents); err != nil {
			return nil, err
		}
	}
	for index, sheet := range sheets {
		writer, err := archive.Create(fmt.Sprintf("xl/worksheets/sheet%d.xml", index+1))
		if err != nil {
			return nil, err
		}
		if _, err := io.WriteString(writer, sheetXML(sheet)); err != nil {
			return nil, err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func xmlText(value string) string {
	encoded, _ := xml.Marshal(value)
	text := string(encoded)
	return strings.TrimSuffix(strings.TrimPrefix(text, "<string>"), "</string>")
}
func contentTypesXML(count int) string {
	parts := []string{`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`}
	for index := 1; index <= count; index++ {
		parts = append(parts, fmt.Sprintf(`<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, index))
	}
	return strings.Join(parts, "") + `</Types>`
}
func relsXML() string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
}
func workbookXML(sheets []Sheet) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	for index, sheet := range sheets {
		fmt.Fprintf(&b, `<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, xmlText(sheet.Name), index+1, index+1)
	}
	b.WriteString(`</sheets></workbook>`)
	return b.String()
}
func workbookRelsXML(count int) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for index := 1; index <= count; index++ {
		fmt.Fprintf(&b, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, index, index)
	}
	b.WriteString(`<Relationship Id="rId50" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`)
	return b.String()
}
func stylesXML() string {
	return `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyFont="1"/></cellXfs></styleSheet>`
}
func coreXML(version string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://purl.org/dc/elements/1.1/"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">ChronoFish export</dc:title><dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">ChronoFish</dc:creator><dc:description xmlns:dc="http://purl.org/dc/elements/1.1/">%s</dc:description></cp:coreProperties>`, xmlText(version))
}
func appXML(count int) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>ChronoFish</Application><Sheets>%d</Sheets></Properties>`, count)
}
func sheetXML(sheet Sheet) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	writeRowXML(&b, 1, sheet.Headers, true)
	for index, row := range sheet.Rows {
		writeRowXML(&b, index+2, row, false)
	}
	b.WriteString(`</sheetData></worksheet>`)
	return b.String()
}
func writeRowXML(b *strings.Builder, rowNumber int, values []string, header bool) {
	fmt.Fprintf(b, `<row r="%d">`, rowNumber)
	for index, value := range values {
		cell := columnName(index+1) + strconv.Itoa(rowNumber)
		style := ""
		if header {
			style = ` s="1"`
		}
		if !header && value != "" {
			if _, err := strconv.ParseFloat(value, 64); err == nil {
				fmt.Fprintf(b, `<c r="%s"%s><v>%s</v></c>`, cell, style, xmlText(value))
				continue
			}
		}
		fmt.Fprintf(b, `<c r="%s" t="inlineStr"%s><is><t>%s</t></is></c>`, cell, style, xmlText(value))
	}
	b.WriteString(`</row>`)
}
func columnName(number int) string {
	result := ""
	for number > 0 {
		number--
		result = string(rune('A'+number%26)) + result
		number /= 26
	}
	return result
}
