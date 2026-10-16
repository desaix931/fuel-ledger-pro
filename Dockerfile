FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# Runs migrations, seeds the admin (first boot only), then starts the server.
CMD ["node", "src/server.js"]
