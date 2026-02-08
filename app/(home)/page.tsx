import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center text-center px-4 py-16">
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl bg-gradient-to-r from-fd-foreground to-fd-foreground/70 bg-clip-text text-transparent">
            Z360 Platform
          </h1>
          <p className="text-lg text-fd-muted-foreground max-w-2xl mx-auto">
            Complete technical documentation for the Z360 VoIP platform — architecture, call management, integration patterns, and deployment guides.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/docs"
            className="inline-flex items-center justify-center rounded-lg bg-fd-primary text-fd-primary-foreground px-8 py-3 text-sm font-medium shadow-sm transition-colors hover:bg-fd-primary/90"
          >
            Read the Whitepaper
          </Link>
          <Link
            href="/docs/system-context/system-architecture-unified"
            className="inline-flex items-center justify-center rounded-lg border border-fd-border bg-fd-background px-8 py-3 text-sm font-medium shadow-sm transition-colors hover:bg-fd-accent"
          >
            System Architecture
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-8">
          <Link href="/docs/system-context" className="group rounded-xl border border-fd-border bg-fd-card p-6 text-left transition-all hover:border-fd-primary/50 hover:shadow-md">
            <h3 className="font-semibold text-fd-foreground mb-2 group-hover:text-fd-primary transition-colors">System Context</h3>
            <p className="text-sm text-fd-muted-foreground">Architecture overview, data flows, and external services</p>
          </Link>
          <Link href="/docs/technology-landscape" className="group rounded-xl border border-fd-border bg-fd-card p-6 text-left transition-all hover:border-fd-primary/50 hover:shadow-md">
            <h3 className="font-semibold text-fd-foreground mb-2 group-hover:text-fd-primary transition-colors">Technology Landscape</h3>
            <p className="text-sm text-fd-muted-foreground">Platform requirements, Capacitor, and Telnyx integration</p>
          </Link>
          <Link href="/docs/platform-architectures" className="group rounded-xl border border-fd-border bg-fd-card p-6 text-left transition-all hover:border-fd-primary/50 hover:shadow-md">
            <h3 className="font-semibold text-fd-foreground mb-2 group-hover:text-fd-primary transition-colors">Platform Architectures</h3>
            <p className="text-sm text-fd-muted-foreground">Android, iOS, and Web/Laravel architecture details</p>
          </Link>
          <Link href="/docs/call-management" className="group rounded-xl border border-fd-border bg-fd-card p-6 text-left transition-all hover:border-fd-primary/50 hover:shadow-md">
            <h3 className="font-semibold text-fd-foreground mb-2 group-hover:text-fd-primary transition-colors">Call Management</h3>
            <p className="text-sm text-fd-muted-foreground">Call state machine, inbound flows, and simultaneous ringing</p>
          </Link>
          <Link href="/docs/integration-architecture" className="group rounded-xl border border-fd-border bg-fd-card p-6 text-left transition-all hover:border-fd-primary/50 hover:shadow-md">
            <h3 className="font-semibold text-fd-foreground mb-2 group-hover:text-fd-primary transition-colors">Integration Architecture</h3>
            <p className="text-sm text-fd-muted-foreground">Push notifications and credential configuration</p>
          </Link>
          <Link href="/docs/edge-cases" className="group rounded-xl border border-fd-border bg-fd-card p-6 text-left transition-all hover:border-fd-primary/50 hover:shadow-md">
            <h3 className="font-semibold text-fd-foreground mb-2 group-hover:text-fd-primary transition-colors">Edge Cases & Config</h3>
            <p className="text-sm text-fd-muted-foreground">Failure analysis, race conditions, and deployment config</p>
          </Link>
        </div>

        <p className="text-xs text-fd-muted-foreground pt-4">
          Built with Fumadocs &middot; Powered by Next.js
        </p>
      </div>
    </main>
  );
}
