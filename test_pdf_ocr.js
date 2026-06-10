const { PDFParse } = require('pdf-parse');
const fs = require('fs');

const pdfPath = 'C:\\Users\\Administrator\\Desktop\\扫描全能王 5-11-26 08.26.pdf';
const ocrUrl = 'http://127.0.0.1:8787/api/ocr';

async function runTest() {
  if (!fs.existsSync(pdfPath)) {
    console.error('File not found:', pdfPath);
    process.exit(1);
  }

  console.log('Loading PDF...');
  const parser = new PDFParse({ data: fs.readFileSync(pdfPath) });
  
  console.log('Rendering PDF pages as screenshots...');
  const result = await parser.getScreenshot({ desiredWidth: 600 });
  console.log(`Rendered ${result.pages.length} pages.`);

  let allContacts = [];

  for (let i = 0; i < result.pages.length; i++) {
    const page = result.pages[i];
    console.log(`Page ${i + 1} image data length:`, page.data.length);

    // Convert Uint8Array to base64 via Buffer
    const base64Image = `data:image/png;base64,${Buffer.from(page.data).toString('base64')}`;

    console.log(`Sending Page ${i + 1} to local OCR API...`);
    const ocrRes = await fetch(ocrUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64Image,
        mode: 'bulk'
      })
    });

    console.log(`Page ${i + 1} response status: ${ocrRes.status}`);
    const text = await ocrRes.text();
    try {
      const data = JSON.parse(text);
      if (data.contacts && data.contacts.length > 0) {
        console.log(`Page ${i + 1} extracted ${data.contacts.length} contacts.`);
        allContacts = allContacts.concat(data.contacts);
      } else {
        console.log(`Page ${i + 1} extracted 0 contacts.`);
        if (data.error) {
          console.error('API Error:', data.error);
        }
      }
    } catch (e) {
      console.log('Raw response:', text);
    }
  }

  console.log('\n========================================');
  console.log(`ALL EXTRACTED CONTACTS (${allContacts.length}):`);
  console.log(JSON.stringify(allContacts, null, 2));
  console.log('========================================\n');

  await parser.destroy();
}

runTest().catch(console.error);
