const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync('C:/Users/Administrator/megz/test_dashboard.html', 'utf8');

const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('error', (msg) => errors.push('ERROR: ' + msg));
virtualConsole.on('jsdomError', (msg) => errors.push('JSDOM-ERROR: ' + msg));

const dom = new JSDOM(html, {
  url: 'http://localhost:8765/dialer',
  runScripts: 'dangerously',
  resources: 'usable',
  virtualConsole: virtualConsole
});

dom.window.addEventListener('load', () => {
  const overlay = dom.window.document.getElementById('dbOverlay');
  const btn = dom.window.document.getElementById('custViewerBtn2');
  console.log('dbOverlay found:', !!overlay);
  console.log('custViewerBtn2 found:', !!btn);
  console.log('openDBDashboard type:', typeof dom.window.openDBDashboard);

  if (btn) {
    btn.click();
    setTimeout(() => {
      console.log('After click - overlay classes:', overlay ? overlay.className : 'null');
      console.log('Errors:', errors.length > 0 ? errors.slice(0, 5).join('; ') : 'none');
      process.exit(0);
    }, 500);
  } else {
    console.log('Button not found!');
    process.exit(1);
  }
});

setTimeout(() => {
  console.log('Timeout - final openDBDashboard:', typeof dom.window.openDBDashboard);
  process.exit(0);
}, 3000);
