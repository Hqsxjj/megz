const fs = require('fs');
const code = fs.readFileSync('C:/Users/Administrator/megz/src/index.js', 'utf8');
const lines = code.split('\n');
for (let i = 6070; i <= 6090; i++) {
  console.log(`Line ${i}:`, JSON.stringify(lines[i - 1]));
}
