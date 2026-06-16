const fs = require('fs');
const file = 'C:/Users/Administrator/megz/src/index.js';
let c = fs.readFileSync(file, 'utf8');

const old = `if (phoneCol >= 0) {
                    // Name: column before phone, clean prefixes like "新 "
                    if (phoneCol > 0) name = cols[phoneCol - 1].replace(/^[新旧]\\s*/, '').trim();
                    // Company: column after phone
                    if (phoneCol + 1 < cols.length) company = cols[phoneCol + 1].trim();
                    // Note: remaining columns
                    note = cols.slice(phoneCol + 2).join(' ').trim();
                  }`;

const nw = `if (phoneCol >= 0) {
                    // Name: column before phone, clean prefixes like "新 "
                    if (phoneCol > 0) name = cols[phoneCol - 1].replace(/^[新旧]\\s*/, '').trim();
                    // Company: first non-numeric column after phone
                    for (var ci2 = phoneCol + 1; ci2 < cols.length; ci2++) {
                      var val = cols[ci2].trim();
                      if (val && !/^[\\d.]+$/.test(val) && val !== '新增跟进') {
                        company = val;
                        note = cols.slice(ci2 + 1).filter(function(x) { return x.trim() && x.trim() !== '新增跟进'; }).join(' ').trim();
                        break;
                      }
                    }
                  }`;

if (c.includes(old)) {
  c = c.replace(old, nw);
  fs.writeFileSync(file, c, 'utf8');
  console.log('Replaced');
} else {
  console.log('NOT FOUND - checking...');
  // Find the section
  const idx = c.indexOf('// Name: column before phone');
  console.log('Found at', idx);
  if (idx > 0) console.log('Snippet:', JSON.stringify(c.substring(idx, idx + 250)));
}
