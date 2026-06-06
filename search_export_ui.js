const fs = require('fs');
const content = fs.readFileSync('c:\\Users\\Administrator\\.gemini\\antigravity\\scratch\\chinese_project\\megz\\src\\index.js', 'utf8');
const lines = content.split('\n');
lines.forEach((line, idx) => {
  if (line.toLowerCase().includes('webhookurlinput') || line.toLowerCase().includes('export-card')) {
    console.log(`${idx + 1}: ${line.trim()}`);
  }
});
