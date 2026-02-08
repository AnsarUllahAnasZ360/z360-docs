import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Image from 'next/image';

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <Image src="/z360-logo.svg" alt="Z360" width={28} height={28} />
        <span>Z360 Documentation</span>
      </>
    ),
  },
  githubUrl: 'https://github.com/AnsarUllahAnasZ360/z360-docs',
  links: [
    {
      text: 'Documentation',
      url: '/docs',
      active: 'nested-url',
    },
  ],
};
