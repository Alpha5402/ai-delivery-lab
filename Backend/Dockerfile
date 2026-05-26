FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src
COPY tsconfig.json ./
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3001
CMD ["node", "dist/server.js"]
