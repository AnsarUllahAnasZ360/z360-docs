# Z360 Documentation

Technical documentation site for the Z360 VoIP Platform, built with [Fumadocs](https://fumadocs.vercel.app/) and [Next.js](https://nextjs.org/).

## Live Site

[https://z360-docs.vercel.app](https://z360-docs.vercel.app)

## Contents

- **System Context** - Architecture overview, data flows, control flows, external services
- **Technology Landscape** - Platform requirements, Capacitor architecture, Telnyx reference
- **Platform Architectures** - Android, iOS, Web/Laravel architecture and gap analysis
- **Call Management** - Call state machine, inbound call flows, simultaneous ringing, credentials
- **Integration Architecture** - Push notifications, two-push architecture, credential configuration
- **Edge Cases** - Failure analysis, race conditions, network failures, gaps and roadmap
- **Configuration** - Configuration reference, build and deployment

## Getting Started

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## Tech Stack

- [Next.js 15](https://nextjs.org/) - React framework
- [Fumadocs](https://fumadocs.vercel.app/) - Documentation framework
- [Tailwind CSS 4](https://tailwindcss.com/) - Styling
- [Vercel](https://vercel.com/) - Hosting and deployment
