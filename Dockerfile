# justPIXIT Studio – enkel Node.js, geen externe pakketten.
# Luistert op poort 80 in de container (Traefik draait op de server in hostmodus en spreekt de container rechtstreeks aan).
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=80 \
    DATA_DIR=/data \
    TZ=Europe/Brussels
RUN apk add --no-cache tzdata wget && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
USER node
VOLUME ["/data"]
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:80/health || exit 1
CMD ["node", "server/index.js"]
