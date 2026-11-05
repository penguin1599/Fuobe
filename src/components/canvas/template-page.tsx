"use client";

import { ArrowLeft, ArrowRight, Loader2, Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/page-shell";
import { EngineSwitch } from "@/components/studio/engine-switch";
import { CoverArt, CoverImg, useCoverPlayback } from "@/components/template-cover";
import { useEngine, useIsOwner, useIsVisitor, useModelAccess } from "@/lib/api";
import { shownTo, type TemplateDetail, type TemplateInput } from "@/lib/canvas-sections";
import { templateCover } from "@/lib/template-covers";
import { toastError } from "@/lib/refusals";
import { NodeIcon } from "./node-icon";
import { CoverPlaceholder, ModelLine, Schematic } from "./template-card";
import { useCanvasActions } from "./use-canvas";

function Input({ input }: { input: TemplateInput }) {
  const thumb = input.sample?.thumb;
  return (
    <li className="rounded-xl border bg-card p-3.5">
      <div className="flex items-start gap-3">
        {thumb && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" loading="lazy" decoding="async" className="size-14 shrink-0 rounded-lg border object-cover" />
        )}
        <div className="min-w-0">
          <p className="text-[14px] font-medium">{input.label}</p>
          {input.hint && <p className="text-[13px] text-muted-foreground">{input.hint}</p>}
        </div>
      </div>
      {input.text && <p className="mt-2 rounded-lg bg-muted/60 px-3 py-2 text-[13px] whitespace-pre-line">{input.text}</p>}
      {input.table && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-muted-foreground">
              <tr>
                {input.table.columns.map((c) => (
                  <th key={c} className="py-1 pr-3 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {input.table.rows.map((r, i) => (
                <tr key={i} className="border-t">
                  {r.map((cell, j) => (
                    <td key={j} className="py-1 pr-3 align-top">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

/**
 * A Canvas template's page (/canvas/start/<id>): what it makes, what goes in, the steps and what comes out, for
 * everyone. The owner makes the board from here; a guest or an account opens it in the editor ("Use this board",
 * /canvas/try/<id>), and for an effect film also gets the Video effect that makes the same in one step.
 */
export function TemplatePage({ t }: { t: TemplateDetail }) {
  const router = useRouter();
  const owner = useIsOwner();
  const visitor = useIsVisitor();
  const access = useModelAccess();
  const [engine, setEngine] = useEngine();
  const { create } = useCanvasActions();
  const [busy, setBusy] = useState(false);
  const cover = templateCover("canvas", t.id);
  const { ref, playing, asked, handlers } = useCoverPlayback<HTMLDivElement>(`canvas-start/${t.id}`, cover);
  // A board visitors don't get to see yet (no real cover, or no ready board of its own): the owner's only.
  const ownerOnly = !shownTo(t, { visitor: true, hasCover: (id) => !!templateCover("canvas", id) });

  if (ownerOnly && !owner) {
    return (
      <PageShell>
        {visitor && (
          <div className="py-16 text-center">
            <p className="text-[15px] text-muted-foreground">This board isn&apos;t here.</p>
            <Link href="/canvas" className="mt-3 inline-flex text-[14px] font-medium underline underline-offset-4">
              See the ready boards
            </Link>
          </div>
        )}
      </PageShell>
    );
  }

  const use = async () => {
    setBusy(true);
    try {
      const c = await create({ templateId: t.id, engine });
      router.push(`/canvas/${c.id}`);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };

  const heading = "text-[13px] font-semibold tracking-wide text-muted-foreground uppercase";

  return (
    <PageShell wide>
      <Link href="/canvas" className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Canvas
      </Link>
      <div className="mt-3 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10">
        <div className="min-w-0">
          <div ref={ref} {...handlers} className="relative aspect-[16/9] overflow-hidden rounded-2xl border bg-muted">
            {cover ? (
              cover.frames.length > 1 ? (
                <div className="absolute inset-0 grid auto-cols-fr grid-flow-col gap-0.5">
                  {cover.frames.map((f) => (
                    <CoverImg key={f.src} frame={f} sizes="(max-width: 1024px) 34vw, 280px" />
                  ))}
                </div>
              ) : (
                <CoverArt cover={cover} sizes="(max-width: 1024px) 100vw, 820px" playing={playing} asked={asked} />
              )
            ) : (
              <div className="absolute inset-0" style={{ background: `linear-gradient(135deg, oklch(0.62 0.12 ${t.hue} / 0.22), oklch(0.62 0.12 ${t.hue} / 0.06) 75%)` }}>
                <CoverPlaceholder icon={t.icon} steps={t.flow} />
              </div>
            )}
            {owner && !cover && <span className="absolute top-3 right-3 rounded-full bg-background/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shadow-soft">No cover yet</span>}
          </div>
          {cover && (
            <div className="relative mt-3 hidden h-28 overflow-hidden rounded-xl border bg-card p-2 sm:block">
              <span className="absolute top-2 left-3 text-[12px] text-muted-foreground">The board</span>
              <Schematic outline={t.byEngine[engine].outline} labeled />
            </div>
          )}
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border bg-card">
              <NodeIcon name={t.icon} className="size-4" />
            </span>
            <h1 className="font-heading text-[30px] leading-tight">{t.name}</h1>
          </div>
          <p className="mt-2 text-[15px] text-pretty text-muted-foreground">{t.description}</p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {owner ? (
              <>
                <Button className="rounded-full" onClick={() => void use()} disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" /> : <Plus />} Use template
                </Button>
                <EngineSwitch value={engine} onChange={setEngine} size="sm" />
              </>
            ) : (
              <>
                <Button asChild className="rounded-full">
                  <Link href={`/canvas/try/${t.id}`} data-use-board>
                    <Workflow /> Use this board
                  </Link>
                </Button>
                {t.oneStep && (
                  <Button asChild variant="secondary" className="rounded-full">
                    <Link href={t.oneStep.href}>
                      {t.oneStep.label} <ArrowRight />
                    </Link>
                  </Button>
                )}
              </>
            )}
          </div>
          {!owner && (
            <p className="mt-2 text-[13px] text-pretty text-muted-foreground [html[data-viewer='owner']_&]:hidden">
              Opens the board in the editor with every step and photo in place. Change anything and keep it.
              {t.oneStep && " The effect in Video makes the same film in one step."}
            </p>
          )}

          <section aria-labelledby="goes-in" className="mt-8">
            <h2 id="goes-in" className={heading}>
              What goes in
            </h2>
            <ul className="mt-2 space-y-2">
              {t.inputs.map((i) => (
                <Input key={i.id} input={i} />
              ))}
            </ul>
          </section>

          <section aria-labelledby="the-steps" className="mt-8">
            <h2 id="the-steps" className={heading}>
              The steps
            </h2>
            <ol className="mt-2 space-y-2">
              {t.steps.map((s, i) => (
                <li key={i} className="flex gap-3 text-[14px]">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[12px] font-medium">{i + 1}</span>
                  <span className="min-w-0 pt-0.5 text-pretty">{s}</span>
                </li>
              ))}
            </ol>
            {owner && <ModelLine t={t} engine={engine} access={access} className="mt-3" />}
          </section>

          <section aria-labelledby="comes-out" className="mt-8">
            <h2 id="comes-out" className={heading}>
              What comes out
            </h2>
            <p className="mt-2 text-[14px] text-pretty">{t.makes}</p>
          </section>
        </div>
      </div>
    </PageShell>
  );
}
