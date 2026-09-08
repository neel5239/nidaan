# Nidaan - single container: Express API + static UI + SQLite + Tesseract OCR
FROM node:22-bookworm-slim

# Tesseract (English) for image OCR; pdf-parse handles PDFs without extra packages
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Data (SQLite db + uploaded reports) lives on a mounted volume in production
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    TESSERACT_BIN=/usr/bin/tesseract
RUN mkdir -p /app/data/uploads
VOLUME ["/app/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
