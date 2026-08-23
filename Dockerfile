# build stage — full image so native deps (better-sqlite3) can compile if no prebuild
FROM node:24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci
COPY backend ./backend
COPY frontend ./frontend
RUN npm -w backend run build && npm -w frontend run build && npm prune --omit=dev

# runtime stage — one container serves the API and the built frontend
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    STATIC_DIR=/app/frontend/dist \
    DB_PATH=/app/data/webchat.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./backend/dist
COPY --from=build /app/frontend/dist ./frontend/dist
COPY backend/package.json ./backend/
COPY package.json ./
EXPOSE 8080
CMD ["node", "backend/dist/index.js"]
