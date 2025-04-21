# backend/Dockerfile
FROM mcr.microsoft.com/playwright/python:latest

# Install OS deps: Xvfb, x11vnc, supervisor, git, net-tools
RUN apt-get update && apt-get install -y \
      xvfb \
      x11vnc \
      supervisor \
      git \
      net-tools \
    && rm -rf /var/lib/apt/lists/*

# Clone noVNC and websockify into /opt/novnc
RUN git clone https://github.com/novnc/noVNC.git /opt/novnc \
 && git clone https://github.com/novnc/websockify /opt/novnc/utils/websockify

# Set workdir and install Python deps
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers
RUN playwright install --with-deps

# Copy app code
COPY backend/app/ ./app/
COPY backend/run_browser_task.py .

# Supervisor config & entrypoint
COPY backend/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY backend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Copy frontend for static serve
COPY frontend/ ./frontend/

# Expose ports: FastAPI, noVNC, VNC
EXPOSE 8000 6080 5901

ENV DISPLAY=:99
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENTRYPOINT ["/entrypoint.sh"]
