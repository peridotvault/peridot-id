import type { ReactNode } from 'react';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { baseOptions } from '@/lib/layout.shared';
import { LandingProviders } from '@/components/landing/providers';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <HomeLayout {...baseOptions()}>
      <LandingProviders>{children}</LandingProviders>
    </HomeLayout>
  );
}
