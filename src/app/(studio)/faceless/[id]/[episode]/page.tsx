import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EpisodeView } from "@/components/faceless/episode-view";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "Episode" };

async function Episode({ params }: { params: PageProps<"/faceless/[id]/[episode]">["params"] }) {
  const { id, episode } = await params;
  if (!recordFor({ kind: "episode", ids: [id, episode] }, await headers())) notFound();
  return <EpisodeView id={episode} backHref={`/faceless/${id}`} backLabel="Channel" />;
}

export default function Page({ params }: PageProps<"/faceless/[id]/[episode]">) {
  return (
    <Suspense fallback={null}>
      <Episode params={params} />
    </Suspense>
  );
}
