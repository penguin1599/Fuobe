import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChannelView } from "@/components/faceless/channel-view";
import { getModel } from "@/lib/catalog";
import { pickerData } from "@/lib/catalog/faceless";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "Faceless channel" };

async function Channel({ params }: { params: PageProps<"/faceless/[id]">["params"] }) {
  const { id } = await params;
  if (!recordFor({ kind: "channel", ids: [id] }, await headers())) notFound();
  return <ChannelView id={id} picker={pickerData(getModel)} />;
}

export default function Page({ params }: PageProps<"/faceless/[id]">) {
  return (
    <Suspense fallback={null}>
      <Channel params={params} />
    </Suspense>
  );
}
