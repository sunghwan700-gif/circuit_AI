import fs from 'fs'
import path from 'path'
import os from 'os'
const p = path.join(os.tmpdir(), 'hwpx-inspect', 'Contents', 'section0.xml')
const x = fs.readFileSync(p, 'utf8')
const re = /<hp:run charPrIDRef="0"\/>/g
console.log('empty charPr 0 runs:', [...x.matchAll(re)].length)
