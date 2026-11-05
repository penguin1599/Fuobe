import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SeriesView } from "@/components/content-factory/series-view";
import { getModel } from "@/lib/catalog";
import { pickerData } from "@/lib/catalog/faceless";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "Series" };

async function Series({ params }: { params: PageProps<"/content-factory/[id]">["params"] }) {
  const { id } = await params;
  if (!recordFor({ kind: "series", ids: [id] }, await headers())) notFound();
  return <SeriesView id={id} voices={pickerData(getModel).voices} />;
}

export default function Page({ params }: PageProps<"/content-factory/[id]">) {
  return (
    <Suspense fallback={null}>
      <Series params={params} />
    </Suspense>
  );
}
