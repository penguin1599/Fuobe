import type { Metadata } from "next";
import { Suspense } from "react";
import { DraftBoard } from "@/components/canvas/visitor-canvas";
import { boardExtras } from "@/server/visitor-board";

export const metadata: Metadata = { title: "Canvas", robots: { index: false, follow: false } };

async function Board({ params }: { params: PageProps<"/canvas/draft/[id]">["params"] }) {
  const { id } = await params;
  return <DraftBoard key={id} id={id} boards={boardExtras()} />;
}

/** A board kept in this browser (a visitor's draft): its pages are read from the browser, never the server. */
export default function Page({ params }: PageProps<"/canvas/draft/[id]">) {
  return (
    <Suspense fallback={null}>
      <Board params={params} />
    </Suspense>
  );
}
