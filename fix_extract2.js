const fs = require('fs');
const file = 'C:/Users/Administrator/megz/src/index.js';
let c = fs.readFileSync(file, 'utf8');

// Find unique marker
const marker = '// Company: column after phone';
const idx = c.indexOf(marker);
if (idx < 0) { console.log('Marker not found'); process.exit(1); }

// Find the start of this block (if statement)
const blockStart = c.lastIndexOf('if (phoneCol >= 0)', idx);
// Find end of this block (the closing brace of if)
const blockEnd = c.indexOf('\n            }', c.indexOf('note = cols.slice', idx));
if (blockStart < 0 || blockEnd < 0) { console.log('Block boundaries not found'); process.exit(1); }

const oldBlock = c.substring(blockStart, blockEnd);
console.log('OLD BLOCK:');
console.log(oldBlock);
console.log('---');

const newBlock = `if (phoneCol >= 0) {
                    // Name: column before phone, clean prefixes
                    if (phoneCol > 0) name = cols[phoneCol - 1].replace(/^[新旧]\\s*/, '').trim();
                    // Company: first non-numeric, non-action column after phone
                    for (var ci2 = phoneCol + 1; ci2 < cols.length; ci2++) {
                      var val = cols[ci2].trim();
                      if (val && !/^[\\d.]+$/.test(val) && val !== '新增跟进') {
                        company = val;
                        note = cols.slice(ci2 + 1).filter(function(x) { return x.trim() && x.trim() !== '新增跟进'; }).join(' ').trim();
                        break;
                      }
                    }`;

c = c.replace(oldBlock, newBlock);
fs.writeFileSync(file, c, 'utf8');
console.log('Done');
