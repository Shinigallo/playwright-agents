# Build context = repo root (vedi docker-compose.yml) così possiamo
# includere il modulo condiviso ./services/shared usato dai servizi LLM.
FROM mcr.microsoft.com/playwright:v1.60.0

WORKDIR /app

COPY planner/package*.json ./
RUN npm install

COPY planner/ ./
# Modulo LLM condiviso — importato come ../../services/shared/gemini-proxy da src/llm.ts.
# Ha il suo package.json così axios è risolvibile da /services/shared.
COPY services/shared /services/shared
RUN npm install --prefix /services/shared --omit=dev

EXPOSE 3001
CMD ["npm", "start"]
