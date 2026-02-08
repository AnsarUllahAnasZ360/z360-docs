import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';

const mdxSource = docs.toFumadocsSource();
// fumadocs-mdx v11 returns files as a lazy function; fumadocs-core v15 expects an array
const files = typeof mdxSource.files === 'function' ? (mdxSource.files as unknown as () => unknown[])() : mdxSource.files;

export const source = loader({
  baseUrl: '/docs',
  source: { files } as typeof mdxSource,
});
