module.exports = {
  apps: [{
    name: 'ngr-bot',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    max_restarts: 10,
    min_uptime: '10s',
    listen_timeout: 8000,
    kill_timeout: 5000
  }]
};