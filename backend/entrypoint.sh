#!/usr/bin/env bash
set -e

# Ensure the websockify “run” script is executable
if [ -d /opt/novnc/utils/websockify ] && [ -f /opt/novnc/utils/websockify/run ]; then
  chmod +x /opt/novnc/utils/websockify/run
fi

# Start supervisord using the specified configuration file
# supervisord will run in the foreground because nodaemon=true is set in the conf
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf