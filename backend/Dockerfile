# backend/Dockerfile
# Use Python 3.11 base image (Debian Bookworm)
FROM python:3.11-slim-bullseye

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install OS dependencies
# Ensure EACH line except the last one in this block ends with a backslash (\)
# with NO characters (not even spaces) after the backslash.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      x11vnc \
      supervisor \
      git \
      net-tools \
      libnss3 \
      tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set timezone
# Use your current time zone: Asia/Kuala_Lumpur
RUN ln -fs /usr/share/zoneinfo/Asia/Kuala_Lumpur /etc/localtime \
    && dpkg-reconfigure -f noninteractive tzdata

# Clone noVNC and websockify for the Live View
RUN echo "Cloning noVNC and websockify..." && \
    git clone https://github.com/novnc/noVNC.git /opt/novnc && \
    git clone https://github.com/novnc/websockify /opt/novnc/utils/websockify && \
    echo "noVNC setup complete."

# Set working directory
WORKDIR /app

# Verify Python Version (for debugging during build)
RUN echo "Python version in container:" && python --version && pip --version

# Copy requirements.txt (ensure it includes browser-use==0.1.41 and langchain-ollama, but NOT playwright)
COPY backend/requirements.txt .

# Upgrade pip and install Playwright Python package FIRST
RUN echo "Upgrading pip and installing Playwright package..." && \
    python -m pip install --upgrade pip setuptools wheel && \
    pip install --no-cache-dir playwright && \
    echo "Pip upgraded and Playwright package installed."

# Install Playwright browsers AND their OS dependencies using the tool's command
RUN echo "Installing Playwright browsers and OS dependencies..." && \
    playwright install --with-deps && \
    echo "Playwright browsers and dependencies installed."

# Install all Python requirements from the file (including browser-use)
RUN echo "Installing Python requirements..." && \
    pip install --no-cache-dir -r requirements.txt && \
    echo "Requirements installed."

# Copy application code
# Assumes build context is the project root (mahyancheng-go/)
COPY backend/app/ ./app/
COPY backend/run_browser_task.py .
COPY backend/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY backend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Copy frontend and create tasks directory
COPY backend/frontend/ ./frontend/
RUN mkdir -p /app/tasks

# Expose necessary ports
EXPOSE 8000 6080 5901

# Environment variables for VNC/Display
ENV DISPLAY=:99
# Let Playwright use its default browser path when installed manually
# ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright # Removed

# Entrypoint executes supervisord via the script
ENTRYPOINT ["/entrypoint.sh"]