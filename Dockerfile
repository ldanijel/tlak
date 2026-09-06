# Tlak – PWA + API u jednom kontejneru (Node 22, SQLite u volumenu /data)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/tlak.db STATIC_DIR=/app/client/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace=server && npm cache clean --force
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "--no-warnings=ExperimentalWarning", "server/src/index.js"]
