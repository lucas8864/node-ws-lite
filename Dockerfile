FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY index.js index.html ./

ENV NODE_ENV=production

EXPOSE 8080

USER node

CMD ["node", "index.js"]
