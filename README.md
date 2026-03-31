# Huerta Coworking — Backend

## Setup local

```bash
npm install
cp .env.example .env
# Completar .env con tus valores
npm run dev
```

## Deploy en Railway

1. Subir este repo a GitHub
2. En Railway: New Project → Deploy from GitHub → elegir este repo
3. Agregar PostgreSQL: New → Database → PostgreSQL
4. Copiar DATABASE_URL de PostgreSQL a las variables de entorno
5. Agregar el resto de variables del .env.example en Railway → Variables

## Variables de entorno en Railway

Todas las del archivo .env.example, excepto DATABASE_URL que Railway pone automáticamente.
