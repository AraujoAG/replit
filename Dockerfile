# Usa uma versão leve do Node.js
FROM node:18-alpine

# Cria a pasta do app
WORKDIR /usr/src/app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências (incluindo o node-cache)
RUN npm install

# Copia o resto do código
COPY . .

# Expõe a porta 8000 (a mesma do seu server.js)
EXPOSE 8000

# Comando para iniciar
CMD ["npm", "start"]
