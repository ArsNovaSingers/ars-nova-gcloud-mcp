# The Google Cloud SDK image already contains a working, up-to-date gcloud.
# Starting from it and adding Node is far more reliable than starting from a
# Node image and trying to install gcloud from apt.
FROM google/cloud-sdk:slim

# Node 20 from NodeSource.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg git \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "src/index.js"]
