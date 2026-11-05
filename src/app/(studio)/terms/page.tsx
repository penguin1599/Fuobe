import type { Metadata } from "next";
import Link from "next/link";
import { Cloud, CodeXml, ImageUp, Palette, Sparkles, Users } from "lucide-react";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { FUOBE_REPO } from "@/lib/connections";

export const metadata: Metadata = { title: "Terms", description: "Simple terms for a creative studio." };

export default function Page() {
  return (
    <LegalPage title="Terms" lead="Simple terms for a creative studio." updated="3 November 2026" cards>
      <LegalSection title="Using Fuobe" icon={Sparkles}>
        <p>Fuobe is a free, open-source creative studio. Make whatever you can imagine.</p>
      </LegalSection>
      <LegalSection title="What you upload" icon={ImageUp}>
        <p>Upload things you own or have permission to use.</p>
      </LegalSection>
      <LegalSection title="What you make" icon={Palette}>
        <p>
          What you make is yours. Some models come with their own licence, so take a look at{" "}
          <Link href="/settings/licences">Thanks &amp; licences</Link> before you sell your work.
        </p>
      </LegalSection>
      <LegalSection title="Fair use" icon={Users}>
        <p>Fair limits on storage and runs keep the studio fast for everyone. Anything that doesn&apos;t follow these terms may be taken down.</p>
      </LegalSection>
      <LegalSection title="The service" icon={Cloud}>
        <p>
          Fuobe keeps getting better, so features may change. It&apos;s offered as it is, and <Link href="/privacy">Privacy</Link> explains how long
          your files are kept.
        </p>
      </LegalSection>
      <LegalSection title="The code" icon={CodeXml}>
        <p>
          Fuobe is open source under the MIT licence, and you&apos;re welcome to{" "}
          <a href={FUOBE_REPO} target="_blank" rel="noopener">
            run your own
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
