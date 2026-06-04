const https = require('https');

const options = {
  hostname: '104.21.43.54',
  port: 443,
  path: '/api/debug-env',
  method: 'GET',
  headers: {
    'Host': 'go.yg1215.dpdns.org'
  },
  rejectUnauthorized: false
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Status code:', res.statusCode);
    console.log('Response body:', data);
  });
});

req.on('error', (e) => {
  console.error('Request error:', e);
});

req.end();
