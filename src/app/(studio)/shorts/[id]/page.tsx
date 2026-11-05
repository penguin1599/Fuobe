import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ShortsSessionView } from "@/components/shorts/session-view";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "Your short" };

async function Session({ params }: { params: PageProps<"/shorts/[id]">["params"] }) {
  const { id } = await params;
  // The owner's sessions, or a signed-in account's own.
  if (!recordFor({ kind: "shorts", ids: [id] }, await headers())) notFound();
  return <ShortsSessionView id={id} />;
}

export default function Page({ params }: PageProps<"/shorts/[id]">) {
  return (
    <Suspense fallback={null}>
      <Session params={params} />
    </Suspense>
  );
}
