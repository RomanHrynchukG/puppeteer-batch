# Dockerfile
FROM node:22-slim

WORKDIR /app

# Install Chromium + libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
 && rm -rf /var/lib/apt/lists/*

# Use a non-root user so we don't need --no-sandbox
RUN useradd -m -u 1001 pptruser

ENV NODE_ENV=production \
    PORT=3002 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package*.json ./
RUN npm install --omit=dev
COPY . .

RUN chown -R pptruser:pptruser /app
USER pptruser

EXPOSE 3002
CMD ["npm", "start"]
