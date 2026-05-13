import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import JSZip from 'jszip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hwpx = path.join(__dirname, '../public/templates/practice-journal.hwpx')
const zip = await JSZip.loadAsync(fs.readFileSync(hwpx))
const xml = await zip.file('Contents/section0.xml').async('string')
const parts = xml.split(/<hp:run charPrIDRef="0"\/>/g)
console.log('segments:', parts.length)
// show ~80 chars before each placeholder occurrence
let idx = 0
for (const m of xml.matchAll(/<hp:run charPrIDRef="0"\/>/g)) {
  const start = Math.max(0, m.index - 120)
  const snippet = xml.slice(start, m.index).replace(/\s+/g, ' ').trim()
  console.log('\n---', idx++, '---')
  console.log(snippet.slice(-100))
}
