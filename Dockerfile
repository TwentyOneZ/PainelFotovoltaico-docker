FROM node:20-alpine

RUN apk add --no-cache git python3 make g++

WORKDIR /app
RUN mkdir -p /data/baileys_auth_info

COPY package.json /app/
# Se tiver package-lock.json, prefira npm ci --omit=dev
RUN npm install --omit=dev

COPY server.js /app/
COPY public /app/public

# RUN mkdir -p /app/legacy
# COPY mqtt-whatsapp-bridge.js /app/legacy/mqtt-whatsapp-bridge.js

EXPOSE 3000
ENV PORT=3000 AUTH_DIR=/data/baileys_auth_info LOG_LEVEL=info
CMD ["npm", "start"]
