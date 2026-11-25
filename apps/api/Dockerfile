FROM node:22-alpine
WORKDIR /srv
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./dist/migrations
COPY public ./public
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node","dist/index.js"]