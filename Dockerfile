FROM node:20-slim

WORKDIR /app

# Copy dependency manifests first (layer cache)
COPY package*.json ./

# Install production deps only
RUN npm ci --omit=dev

# Copy source
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
