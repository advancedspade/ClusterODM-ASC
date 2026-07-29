FROM node:14-bullseye
LABEL maintainer="Piero Toffanin <pt@masseranolabs.com>"

EXPOSE 3000

USER root

RUN apt-get update && apt-get install -y --no-install-recommends telnet curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir /var/www
WORKDIR "/var/www"
COPY --chown=node:node . /var/www

RUN npm ci

RUN chown -R node:node /var/www

USER node

VOLUME ["/var/www/data"]
ENTRYPOINT ["/usr/local/bin/node", "/var/www/index.js"]
