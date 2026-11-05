import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CinemaWorkspace } from "@/components/cinema/workspace";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "Cinema Studio" };

async function Workspace({ params }: { params: PageProps<"/cinema/[id]">["params"] }) {
  const { id } = await params;
  // The owner's projects, or a signed-in account's own.
  if (!recordFor({ kind: "cinema", ids: [id] }, await headers())) notFound();
  return <CinemaWorkspace id={id} />;
}

export default function Page({ params }: PageProps<"/cinema/[id]">) {
  return (
    <Suspense fallback={null}>
      <Workspace params={params} />
    </Suspense>
  );
}
