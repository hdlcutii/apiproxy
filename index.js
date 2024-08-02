const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const beautify = require('json-beautify');

const app = express();
const port = 3000;

// Load configuration
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const proxyData = JSON.parse(fs.readFileSync('proxy.json', 'utf8'));

// Storage for proxies
let proxies = {
  all: [],
  https: [],
  http: [],
  socks5: [],
  socks4: []
};

// Track the last check time and the last update time
let lastCheck = new Date();
let isUpdating = false;

// Function to check if a proxy is live
const checkProxyLive = async (proxy) => {
  try {
    const response = await axios.get(config.site, {
      proxy: {
        host: proxy.ip_address,
        port: proxy.port,
        protocol: proxy.type === 'https' ? 'https' : 'http'
      },
      timeout: config.timeout * 1000
    });
    return response.status === 200;
  } catch (error) {
    return false;
  }
};

// Function to get additional information from ipinfo.io
const getProxyInfo = async (proxy) => {
  try {
    const response = await axios.get(`https://ipinfo.io/${proxy.ip_address}/json`);
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch additional info for ${proxy.ip_address}:${proxy.port}: ${error.message}`);
    return {};
  }
};

// Function to parse proxy from text format
const parseProxyText = (text) => {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  return lines.map(line => {
    const [ip_address, port] = line.split(':');
    return { ip_address, port };
  });
};

// Function to update proxies
const updateProxies = async () => {
  if (isUpdating) return; // Avoid concurrent updates
  isUpdating = true;

  console.log('Updating proxies...');
  const types = ['https', 'http', 'socks5', 'socks4'];
  let allProxies = [];

  for (const type of types) {
    proxies[type] = []; // Clear old proxies of this type

    for (const url of proxyData[type]) {
      try {
        const response = await axios.get(url, { timeout: config.timeout * 1000 });
        const data = response.data;

        let fetchedProxies = [];
        if (typeof data === 'string') {
          // Assuming data is in text format
          fetchedProxies = parseProxyText(data);
        } else if (Array.isArray(data)) {
          // Assuming data is in JSON format
          fetchedProxies = data.map(p => ({
            ip_address: p.ip_address,
            port: p.port
          }));
        } else {
          console.log(`Unexpected data format from ${url}`);
          continue;
        }

        // Check each proxy asynchronously
        const results = await Promise.all(fetchedProxies.map(async (proxy) => {
          if (proxy.ip_address && proxy.port) {
            const isLive = await checkProxyLive(proxy);
            if (isLive) {
              // Get additional information if the proxy is live
              const proxyInfo = await getProxyInfo(proxy);
              proxy.type = type;
              proxy.city = proxyInfo.city || null;
              proxy.region = proxyInfo.region || null;
              proxy.country = proxyInfo.country || null;
              proxy.loc = proxyInfo.loc || null;
              proxy.org = proxyInfo.org || null;
              proxy.postal = proxyInfo.postal || null;
              proxy.timezone = proxyInfo.timezone || null;
              proxy.hostname = proxyInfo.hostname || null;
              proxy.anycast = proxyInfo.anycast || null;
              proxy.last_check = new Date();
              return proxy;
            } else {
              console.log(`Dead proxy: ${proxy.ip_address}:${proxy.port}`);
              return null;
            }
          }
          return null;
        }));

        // Filter out null values (dead proxies) and update lists
        proxies[type].push(...results.filter(p => p !== null));
        allProxies.push(...results.filter(p => p !== null));
      } catch (error) {
        console.error(`Failed to fetch proxy from ${url}: ${error.message}`);
      }
    }
  }

  proxies.all = allProxies; // Update the 'all' list
  lastCheck = new Date(); // Update last check time

  isUpdating = false;
};

// Function to check and update proxy status continuously
const checkProxiesContinuously = async () => {
  await updateProxies();

  // Periodically check proxy status
  setInterval(async () => {
    await updateProxies();
  }, 60 * 1000); // Check proxies every minute
};

// Function to reset all proxies after 10 hours
const resetProxiesAfterTenHours = () => {
  setInterval(async () => {
    const now = new Date();
    const hoursPassed = (now - lastCheck) / (1000 * 60 * 60);
    if (hoursPassed >= 10) {
      console.log('10 hours passed. Resetting proxies...');
      // Clear all proxies
      proxies = {
        all: [],
        https: [],
        http: [],
        socks5: [],
        socks4: []
      };
      await updateProxies();
    }
  }, 60 * 60 * 1000); // Check every hour if 10 hours have passed
};

// Middleware to redirect root to /api/status
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/api') {
    res.redirect('/api/status');
  } else {
    next();
  }
});

// Helper function to format proxy data
const formatProxies = (proxies) => {
  return proxies.map(p => ({
    "ip_address": p.ip_address,
    "port": p.port,
    "type": p.type,
    "city": p.city || null,
    "region": p.region || null,
    "country": p.country || null,
    "loc": p.loc || null,
    "org": p.org || null,
    "postal": p.postal || null,
    "timezone": p.timezone || null,
    "hostname": p.hostname || null,
    "anycast": p.anycast || null,
    "last_check": moment(p.last_check || new Date()).format('YYYY-MM-DD HH:mm:ss'),
    "check_google": p.check_google || false
  }));
};

// Endpoint to get proxy list
app.get('/api/proxy', async (req, res) => {
  const type = req.query.type;
  const format = req.query.format || 'json';

  if (!['https', 'http', 'socks5', 'socks4', 'all'].includes(type)) {
    return res.status(400).json({ error: 'Invalid proxy type' });
  }

  if (!['txt', 'json'].includes(format)) {
    return res.status(400).json({ error: 'Invalid format' });
  }

  const data = type === 'all' ? [].concat(...Object.values(proxies)) : proxies[type];
  const formattedData = formatProxies(data);

  if (format === 'txt') {
    // Convert proxy data to text format with each proxy on a new line
    const txt = data.map(p => `${p.ip_address}:${p.port}`).join('\n');
    return res.set('Content-Type', 'text/plain').send(txt);
  }

  // Format JSON data nicely
  const json = beautify(formattedData, null, 2, 100);
  res.set('Content-Type', 'application/json').send(json);
});

// Endpoint for API status
app.get('/api/status', (req, res) => {
  const status = {
    "Horikita All Proxy": {
      "path": "/api/proxy?type=all&format=json",
      "status": 200,
      "total": proxies.all.length,
      "last_check": moment(lastCheck).format('YYYY-MM-DD HH:mm:ss')
    },
    "Horikita Https Proxy": {
      "path": "/api/proxy?type=https&format=json",
      "status": 200,
      "total": proxies.https.length,
      "last_check": moment(lastCheck).format('YYYY-MM-DD HH:mm:ss')
    },
    "Horikita Http Proxy": {
      "path": "/api/proxy?type=http&format=json",
      "status": 200,
      "total": proxies.http.length,
      "last_check": moment(lastCheck).format('YYYY-MM-DD HH:mm:ss')
    },
    "Horikita Socks5 Proxy": {
      "path": "/api/proxy?type=socks5&format=json",
      "status": 200,
      "total": proxies.socks5.length,
      "last_check": moment(lastCheck).format('YYYY-MM-DD HH:mm:ss')
    },
    "Horikita Socks4 Proxy": {
      "path": "/api/proxy?type=socks4&format=json",
      "status": 200,
      "total": proxies.socks4.length,
      "last_check": moment(lastCheck).format('YYYY-MM-DD HH:mm:ss')
    }
  };

  // Format JSON status nicely
  const jsonStatus = beautify(status, null, 2, 100);
  res.set('Content-Type', 'application/json').send(jsonStatus);
});

// Start server and begin proxy checking
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  checkProxiesContinuously(); // Start checking proxies immediately
  resetProxiesAfterTenHours(); // Start resetting proxies every 10 hours
});
