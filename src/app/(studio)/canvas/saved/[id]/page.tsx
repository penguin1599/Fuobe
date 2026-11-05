import type { Metadata } from "next";
import { Suspense } from "react";
import { SavedBoard } from "@/components/canvas/visitor-canvas";
import { boardExtras } from "@/server/visitor-board";

export const metadata: Metadata = { title: "Canvas", robots: { index: false, follow: false } };

async function Board({ params }: { params: PageProps<"/canvas/saved/[id]">["params"] }) {
  const { id } = await params;
  return <SavedBoard key={id} id={id} boards={boardExtras()} />;
}

/** An account's own canvas: the browser asks /api/account/canvases/<id>, which answers that account only. */
export default function Page({ params }: PageProps<"/canvas/saved/[id]">) {
  return (
    <Suspense fallback={null}>
      <Board params={params} />
    </Suspense>
  );
}
