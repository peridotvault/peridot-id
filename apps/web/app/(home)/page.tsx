import { CoverageGrid } from "@/components/landing/coverage-grid";
import { CaseStudy } from "@/components/landing/case-study";
import { Hero } from "@/components/landing/hero";
import { HeroWaves } from "@/components/landing/hero-waves";
import { Faq } from "@/components/landing/faq";
import { Features } from "@/components/landing/features";
import { FinalCta } from "@/components/landing/final-cta";
import { Footer } from "@/components/landing/footer";
import { Pricing } from "@/components/landing/pricing";
import { Stats } from "@/components/landing/stats";
import { Testimonials } from "@/components/landing/testimonials";
import { TrustedBy } from "@/components/landing/trusted-by";
import { ValueProp } from "@/components/landing/value-prop";
import { WindowMockup } from "@/components/landing/window-mockup";
import { InView, MotionSection } from "@/lib/motion";

export default function HomePage() {
  return (
    <>
      <main className="flex-1">
        <div className="relative">
          <HeroWaves />
          <Hero />
          <MotionSection
            variants={{
              hidden: { opacity: 0, y: 24, scale: 0.985 },
              visible: { opacity: 1, y: 0, scale: 1 },
            }}
            transition={{ duration: 0.85, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className="relative px-5 pb-24 sm:px-8 lg:px-10"
          >
            <WindowMockup />
          </MotionSection>
        </div>
        <InView>
          <TrustedBy />
        </InView>
        <CoverageGrid />
        <InView>
          <Features />
        </InView>
        <InView>
          <ValueProp />
        </InView>
        <InView>
          <Testimonials />
        </InView>
        <InView>
          <Stats />
        </InView>
        <InView>
          <CaseStudy />
        </InView>
        <InView>
          <Pricing />
        </InView>
        <InView>
          <Faq />
        </InView>
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
