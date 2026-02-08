import { docs } from '@/.source';
import { loader } from 'fumadocs-core/source';
import type { InferPageType } from 'fumadocs-core/source';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const mdxSource = docs.toFumadocsSource();
// fumadocs-mdx v11 returns files as a lazy function; fumadocs-core v15 expects an array
const files = typeof mdxSource.files === 'function' ? (mdxSource.files as unknown as () => unknown[])() : mdxSource.files;

export const source = loader({
  baseUrl: '/docs',
  source: { files } as typeof mdxSource,
});

export async function getLLMText(page: InferPageType<typeof source>) {
  const filePath = join(process.cwd(), 'content/docs', page.file.path);
  let raw = '';
  try {
    raw = await readFile(filePath, 'utf-8');
    // Strip frontmatter
    const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (fmMatch) raw = raw.slice(fmMatch[0].length);
  } catch {
    raw = '';
  }
  return `# ${page.data.title}\nURL: ${page.url}\n\n${page.data.description ?? ''}\n\n${raw}`;
}
