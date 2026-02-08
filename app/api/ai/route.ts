import { createAzure } from '@ai-sdk/azure';
import { streamText } from 'ai';
import { source } from '@/lib/source';

export const maxDuration = 30;

const azure = createAzure({
  resourceName: process.env.AZURE_RESOURCE_NAME,
  apiKey: process.env.AZURE_API_KEY,
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const pages = source.getPages();
  const context = pages
    .slice(0, 10)
    .map((p) => `## ${p.data.title}\n${p.data.description ?? ''}`)
    .join('\n\n');

  const result = streamText({
    model: azure('gpt-5.2'),
    system: `You are a helpful assistant for the Z360 VoIP platform documentation. Answer questions based on the documentation context provided.\n\nContext:\n${context}`,
    messages,
  });

  return result.toTextStreamResponse();
}
