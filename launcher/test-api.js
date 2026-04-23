const https = require('https');
const fs = require('fs');
const path = require('path');

const envPath = path.join(require('os').homedir(), 'Library/Application Support/predict-fun-market-maker/.env');
const env = {};
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    env[trimmed.substring(0, eqIndex).trim()] = trimmed.substring(eqIndex + 1).trim();
  }
}

const apiKey = env.API_KEY;
console.log('API Key:', apiKey ? apiKey.substring(0, 20) + '...' : 'NOT FOUND');

const options = {
  hostname: 'api.predict.fun',
  path: '/v1/markets?status=OPEN',
  headers: { 'x-api-key': apiKey },
  timeout: 10000
};

https.get(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const parsed = JSON.parse(data);
      console.log('Markets count:', parsed.data?.length || 0);
      console.log('First market:', parsed.data?.[0]?.question?.substring(0, 50));
    } catch(e) {
      console.log('Parse error:', e.message);
    }
  });
}).on('error', e => console.log('Error:', e.message));
