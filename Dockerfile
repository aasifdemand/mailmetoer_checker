FROM node:18-slim

# Install system dependencies for Puppeteer and Xvfb
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    xvfb \
    xauth \
    libnss3 \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    fonts-liberation \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome directly from .deb
RUN curl -LO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y ./google-chrome-stable_current_amd64.deb --no-install-recommends \
    && rm google-chrome-stable_current_amd64.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

# Ensure the uploads/profiles directory exists
RUN mkdir -p uploads/profiles

EXPOSE 3000

# We use xvfb-run to start the app with a virtual display
# -a: automatically find free display
# -e /dev/stdout: print errors to standard out so docker logs can see them
CMD ["xvfb-run", "-a", "-e", "/dev/stdout", "--server-args=-screen 0 1280x1024x24", "node", "server.js"]
