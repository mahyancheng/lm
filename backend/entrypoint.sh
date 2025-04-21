#!/usr/bin/env bash
set -e

# Ensure the websockify “run” script is executable
if [ -d /opt/novnc/utils/websockify ] && [ -f /opt/novnc/utils/websockify/run ]; then
  chmod +x /opt/novnc/utils/websockify/run
fi

# Start supervisord
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
