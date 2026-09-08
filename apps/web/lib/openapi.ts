import { createOpenAPI } from 'fumadocs-openapi/server';

export const openapi = createOpenAPI({
  // The canonical spec lives in the shared OpenAPI package
  input: ['../../packages/openapi/src/openapi.yaml'],
});
