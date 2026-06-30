FROM node:20-alpine

WORKDIR /app

COPY package.json package.json
RUN npm install --omit=dev

COPY server.js server.js
COPY public public

ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/app/data

EXPOSE 8787

CMD ["node", "server.js"]
