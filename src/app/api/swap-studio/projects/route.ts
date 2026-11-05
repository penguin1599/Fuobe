import { connection } from "next/server";
import { guestRun } from "@/server/account-tool-run";
import { body } from "@/server/shorts-schemas";
import { createProject, CreateSchema, listProjects } from "@/server/swap-studio";
import { asViewer, refsRefused } from "@/server/swap-studio-account";

/**
 * Character Swap Studio projects, most recently changed first: the owner's, or a signed-in account's own (public
 * sign-up; src/server/swap-studio-account.ts). A guest has none.
 */
export async function GET(request: Request) {
  await connection();
  return asViewer(request, () => Response.json({ items: listProjects() }), { guest: () => Response.json({ items: [] }, { headers: { "Cache-Control": "no-store" } }) });
}

/** A new project: a name, the engine, and (optionally) the character (an account's: a picture of its own). */
export async function POST(request: Request) {
  return asViewer(
    request,
    async (account) => {
      const b = await body(request, CreateSchema, "Name the project and pick an engine");
      const bad = account && refsRefused(account.id, [b.character?.image]);
      return bad || Response.json(createProject(b), { status: 201 });
    },
    { guest: guestRun, save: true },
  );
}
