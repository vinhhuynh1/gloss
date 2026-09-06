# Node 24 matches the local toolchain; package.json requires >=20 for the
# native --env-file support the dev script uses.
FROM node:24-alpine

WORKDIR /app

# Copied before the source so a source-only change reuses the install layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 1234

# Not `npm start`: npm swallows SIGTERM, and this service's shutdown handler
# is the only thing that flushes open documents to Postgres before exit
# (see the flush-strategy comment in persistence.js). node must be PID 1 so
# the signal reaches it.
CMD ["node", "server.js"]
