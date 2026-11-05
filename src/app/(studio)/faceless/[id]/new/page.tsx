import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { EpisodeWizard } from "@/components/faceless/episode-wizard";
import { getModel } from "@/lib/catalog";
import { pickerData } from "@/lib/catalog/faceless";
import { facelessTopic } from "@/lib/starters/catalog";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "New episode" };

async function Wizard({ params, searchParams }: Pick<PageProps<"/faceless/[id]/new">, "params" | "searchParams">) {
  const { id } = await params;
  if (!recordFor({ kind: "channel", ids: [id] }, await headers())) notFound();
  // A ready channel (?starter=<id>) opens with its first episode's topic written in.
  const { starter } = await searchParams;
  const topic = facelessTopic(typeof starter === "string" ? starter : undefined);
  return <EpisodeWizard channelId={id} picker={pickerData(getModel)} initialTopic={topic} />;
}

export default function Page({ params, searchParams }: PageProps<"/faceless/[id]/new">) {
  return (
    <Suspense fallback={null}>
      <Wizard params={params} searchParams={searchParams} />
    </Suspense>
  );
}
