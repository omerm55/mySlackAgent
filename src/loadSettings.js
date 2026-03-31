'use strict';

const fs = require('fs');
const path = require('path');

function loadSettings(filePath) {
  const configPath = filePath || path.resolve(__dirname, '../config/settings.json');

  if (!fs.existsSync(configPath)) {
    console.error(
      `Settings file not found at: ${configPath}\n` +
      `Copy config/settings.example.json to config/settings.json and fill in your values.`
    );
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse settings.json: ${err.message}`);
    process.exit(1);
  }

  if (!raw.opsChannelId || typeof raw.opsChannelId !== 'string') {
    console.error('settings.json: "opsChannelId" is required.');
    process.exit(1);
  }

  return {
    opsChannelId: raw.opsChannelId,
    alerting: {
      errorThreshold: raw.alerting?.errorThreshold ?? 3,
      errorWindowMinutes: raw.alerting?.errorWindowMinutes ?? 5,
    },
    rateLimiting: {
      defaultPerHour: raw.rateLimiting?.defaultPerHour ?? 20,
    },
    dailySummary: {
      enabled: raw.dailySummary?.enabled ?? true,
      utcHour: raw.dailySummary?.utcHour ?? 7,
    },
  };
}

module.exports = { loadSettings };
