import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import JSZip from 'jszip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const hwpx = path.join(__dirname, '../public/templates/practice-journal.hwpx')
const zip = await JSZip.loadAsync(fs.readFileSync(hwpx))
const xml = await zip.file('Contents/section0.xml').async('string')
const ph = '<hp:run charPrIDRef="0"/>'
const chunks = xml.split(ph)
console.log('placeholders:', chunks.length - 1)

function textsIn(s) {
  const out = []
  const re = /<hp:t>([^<]*)<\/hp:t>/g
  let m
  while ((m = re.exec(s))) out.push(m[1])
  return out
}

for (let i = 0; i < chunks.length; i++) {
  const t = textsIn(chunks[i])
  const lastFew = t.slice(-5)
  console.log(`\n[before slot ${i}] ...labels:`, JSON.stringify(lastFew))
}
