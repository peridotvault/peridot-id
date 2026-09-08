import { loader } from 'fumadocs-core/source';
import type { OperationOutput, WebhookOutput } from 'fumadocs-openapi';
import { openapi } from './openapi';
import { defineDocs } from 'fumadocs-mdx/macro';

const docs = defineDocs({
  dir: 'content/docs',
});

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({
      baseDir: 'api',
      groupBy(entry) {
        if (entry.type === 'webhook') return 'webhook';
        const segment = entry.item.path.replace(/^\//, '').split('/')[0];
        return segment === 'openapi.yaml' ? 'openapi' : segment;
      },
      name(entry: Omit<OperationOutput, 'path'> | Omit<WebhookOutput, 'path'>) {
        if (entry.type === 'webhook') return 'webhook';
        if (entry.item.path.endsWith('openapi.yaml')) return 'get-openapi';
        const segments = entry.item.path.replace(/^\//, '').split('/');
        const core = segments.length > 1 ? segments.slice(1).join('-') : segments[0];
        return `${entry.item.method.toLowerCase()}-${core.replace(/[^\w-]/g, '')}`;
      },
    }),
  },
  {
    baseUrl: '/docs',
    plugins: [openapi.loaderPlugin()],
  },
);
