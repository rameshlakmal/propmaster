# VHS (scripted terminal recordings) plus Node, for rendering the README demo GIF.
# Used by: npm run gif
FROM node:24-slim AS node

FROM ghcr.io/charmbracelet/vhs:latest
COPY --from=node /usr/local/bin/node /usr/local/bin/node
