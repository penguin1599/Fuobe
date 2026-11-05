import { connection } from "next/server";
import { guestRun } from "@/server/account-tool-run";
import { body } from "@/server/shorts-schemas";
import { deleteProject, EditSchema, editProject, projectView } from "@/server/swap-studio";
import { asViewer, guestProjectRead, refsRefused } from "@/server/swap-studio-account";

/**
 * The project with every job's state (finished jobs are filled in, ready waiting takes launched). An account's own
 * projects only (another's, or the owner's, is not found); a guest signs up first.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]">) {
  await connection();
  return asViewer(request, async () => Response.json(projectView((await ctx.params).id)), { guest: guestProjectRead });
}

/**
 * One edit (rename, character, cuts, shot and segment settings, layouts, takes, review…): the project as it is after it.
 * A picture an account's edit names (its character, an imported anchor) is one of its own.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]">) {
  return asViewer(
    request,
    async (account) => {
      const { id } = await ctx.params;
      const edit = await body(request, EditSchema, "That change isn't valid");
      const bad = account && refsRefused(account.id, [edit.type === "character" ? edit.image : edit.type === "anchor-import" ? edit.url : null]);
      return bad || Response.json(await editProject(id, edit));
    },
    { guest: guestRun, save: true },
  );
}

/** Delete the project, stopping what it still makes (the assembled clips stay in the Library, or an account's runs). */
export async function DELETE(request: Request, ctx: RouteContext<"/api/swap-studio/projects/[id]">) {
  return asViewer(
    request,
    async () => {
      await deleteProject((await ctx.params).id);
      return new Response(null, { status: 204 });
    },
    { guest: guestRun },
  );
}
