import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';

const specPath = path.resolve(process.cwd(), 'openapi.yaml');
const specText = readFileSync(specPath, 'utf8');
export const openapiSpec = parse(specText) as Record<string, unknown>;

/** GET /openapi.yaml (raw contract) and GET /docs (Swagger UI). */
export const docsRouter = Router();
docsRouter.get('/openapi.yaml', (_req, res) => {
  res.type('application/yaml').send(specText);
});
docsRouter.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'Star Generation API' }));
