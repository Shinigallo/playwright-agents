# Build context = repo root (vedi docker-compose.yml) così possiamo
# includere il modulo condiviso ./services/shared usato dai servizi LLM.
FROM node:20-slim

WORKDIR /app

COPY generator/package*.json ./
RUN npm install

COPY generator/ ./
# Modulo LLM condiviso — importato come ../../services/shared/gemini-proxy da src/llm.ts.
# Ha il suo package.json così axios è risolvibile da /services/shared.
COPY services/shared /services/shared
RUN npm install --prefix /services/shared --omit=dev

EXPOSE 3002
CMD ["npm", "start"]
