FROM nginx:alpine

# Copia la configurazione nginx con reverse proxy verso orchestrator ed executor
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copia il frontend statico
COPY index.html /usr/share/nginx/html/index.html

EXPOSE 80
