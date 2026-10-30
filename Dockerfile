FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json index.mjs ./
RUN mkdir data && chown node:node data
USER node
ENV HOST=0.0.0.0 PORT=8787 LOCATIONS_FILE=/app/data/locations.jsonl
EXPOSE 8787
VOLUME ["/app/data"]
CMD ["node", "index.mjs"]
