import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SwapWorkbench } from "@/components/swap-studio/workbench";
import { recordFor } from "@/server/records";

export const metadata: Metadata = { title: "Character Swap" };

/** A project's page: the owner's projects, or a signed-in account's own (its projects only). */
async function Project({ params }: { params: PageProps<"/character-swap/[id]">["params"] }) {
  const { id } = await params;
  if (!recordFor({ kind: "swap-project", ids: [id] }, await headers())) notFound();
  return <SwapWorkbench id={id} />;
}

export default function Page({ params }: PageProps<"/character-swap/[id]">) {
  return (
    <Suspense fallback={null}>
      <Project params={params} />
    </Suspense>
  );
}
