'use client';
import { type FormEvent, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const transport = new DefaultChatTransport({ api: '/api/ai' });

export function AskAI() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const { messages, sendMessage, status } = useChat({ transport });

  const isLoading = status === 'streaming' || status === 'submitted';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput('');
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 rounded-full bg-fd-primary text-fd-primary-foreground p-3 shadow-lg hover:opacity-90 transition-opacity"
        aria-label="Ask AI"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="m2 14 6-6 6 6 6-6"/></svg>
      </button>
    );
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 max-h-[500px] flex flex-col rounded-xl border border-fd-border bg-fd-background shadow-2xl">
      <div className="flex items-center justify-between p-4 border-b border-fd-border">
        <h3 className="font-semibold text-sm">Ask AI about Z360</h3>
        <button onClick={() => setOpen(false)} className="text-fd-muted-foreground hover:text-fd-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[200px]">
        {messages.length === 0 && (
          <p className="text-sm text-fd-muted-foreground">Ask a question about the Z360 platform...</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`text-sm ${m.role === 'user' ? 'text-fd-foreground font-medium' : 'text-fd-muted-foreground'}`}>
            <span className="font-semibold">{m.role === 'user' ? 'You' : 'AI'}:</span>{' '}
            {m.parts?.map((part, i) => (part.type === 'text' ? <span key={i}>{part.text}</span> : null))}
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit} className="p-3 border-t border-fd-border flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question..."
          className="flex-1 rounded-lg border border-fd-border bg-fd-background px-3 py-2 text-sm outline-none focus:border-fd-primary"
        />
        <button type="submit" disabled={isLoading} className="rounded-lg bg-fd-primary text-fd-primary-foreground px-3 py-2 text-sm font-medium disabled:opacity-50">
          Send
        </button>
      </form>
    </div>
  );
}
