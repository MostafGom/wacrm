# Fake external services for local end-to-end testing only.
FROM node:20-alpine
WORKDIR /fakes
COPY server.mjs media.mjs simulator.html ./
USER node
EXPOSE 4010
CMD ["node", "server.mjs"]
