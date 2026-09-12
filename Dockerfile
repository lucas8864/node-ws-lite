FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY index.js ./

ENV NODE_ENV=production

EXPOSE 9876

USER node

CMD ["node", "index.js"]
