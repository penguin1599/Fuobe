import { after, connection } from "next/server";
import { clearChat, getChat } from "@/server/cinema";
import { askDirector } from "@/server/cinema-director";
import { DirectorAsk, asCinemaViewer, body } from "@/server/cinema-schemas";

export async function GET(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/director">) {
  await connection();
  return asCinemaViewer(request, async () => {
    const { id } = await ctx.params;
    return Response.json({ messages: getChat(id) });
  });
}

/**
 * Ask the AI Director; answers with the whole conversation (the reply proposes shots, never renders them). An account's
 * Director never uses the studio's own AI helper: inside its work there is none (enhance.ts llmTextBackend), so it gets
 * the built-in breakdown, which needs no GPU and no key.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/director">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      const b = await body(request, DirectorAsk, "Write a message first");
      const reply = askDirector(id, b.text);
      // An LLM call can outlive a closed tab; keep it running so the answer is saved.
      after(() => reply.catch(() => {}));
      return Response.json({ messages: await reply });
    },
    { change: true },
  );
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/cinema/projects/[id]/director">) {
  return asCinemaViewer(
    request,
    async () => {
      const { id } = await ctx.params;
      clearChat(id);
      return new Response(null, { status: 204 });
    },
    { change: true },
  );
}
