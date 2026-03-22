// PM2 process configuration — use this if deploying directly on a VM/server
// without Docker. Run: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'slack-jira-bot',
      script: 'src/index.js',
      // Restart automatically if the process crashes
      autorestart: true,
      // Wait 5s before restarting to avoid rapid crash loops
      restart_delay: 5000,
      // Limit restart attempts within a time window
      max_restarts: 10,
      min_uptime: '10s',
      // Credentials come from the system environment or a .env file loaded
      // by dotenv inside the app — do not put secrets in this file.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
