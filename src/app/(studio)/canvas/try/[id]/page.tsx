import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TryBoard } from "@/components/canvas/visitor-canvas";
import { visitorBoard, visitorBoardIds } from "@/server/visitor-board";

export function generateStaticParams() {
  return visitorBoardIds().map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps<"/canvas/try/[id]">): Promise<Metadata> {
  const { id } = await params;
  const b = visitorBoard(id);
  // A board in the editor is a working page, not one to find in search (its template page is).
  return { title: b ? `${b.name} · Canvas` : "Not found", robots: { index: false, follow: true } };
}

async function Board({ params }: { params: PageProps<"/canvas/try/[id]">["params"] }) {
  const { id } = await params;
  const b = visitorBoard(id);
  if (!b) notFound();
  return <TryBoard board={{ id: `try-${id}`, ...b }} />;
}

/** A ready board (or a blank one) open in the Canvas editor, for anyone: see src/components/canvas/visitor-canvas.tsx. */
export default function Page({ params }: PageProps<"/canvas/try/[id]">) {
  return (
    <Suspense fallback={null}>
      <Board params={params} />
    </Suspense>
  );
}
