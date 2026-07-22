FROM mcr.microsoft.com/playwright:v1.60.0

WORKDIR /app

COPY package*.json ./
RUN npm install

RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 3004
CMD ["npm", "start"]
