FROM node:24-slim
WORKDIR /app
COPY package.json server.mjs ./
COPY public ./public
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.mjs"]
