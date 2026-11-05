import { toast } from "sonner";

const asking = new Set<string>();

/**
 * Download a zip of results (/api/generations/zip?ids=…: Shorts' Download parts, Photodump's Download all, the
 * Library's Download). It asks the route first (`&check=1`, no zip made), so a refusal (nothing finished yet, too big, a
 * zip still going) is said in a toast and the page stays where it is; then the zip downloads without leaving the page.
 * A second click on the same zip while the first is being asked does nothing. Resolves true when the download started.
 */
export async function downloadZip(href: string): Promise<boolean> {
  if (asking.has(href)) return false;
  asking.add(href);
  try {
    const r = await fetch(`${href}${href.includes("?") ? "&" : "?"}check=1`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok) {
      const said = ((await r?.json().catch(() => null)) as { error?: string } | null)?.error;
      toast.error(said ?? "Couldn't make the zip. Try again.");
      return false;
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    a.click();
    return true;
  } finally {
    // The zip starts streaming a moment after the click: until then a second click would only be refused.
    setTimeout(() => asking.delete(href), 2000);
  }
}

/** A results zip link (it goes through downloadZip); every other download link downloads as it is. */
export const isZipHref = (href: string | undefined): href is string => !!href && href.startsWith("/api/generations/zip?");

/**
 * For any download <a> (`onClick={onZipLink}`): a results zip asks first (downloadZip); any other link is left alone.
 */
export function onZipLink(e: { currentTarget: HTMLAnchorElement; preventDefault(): void }): void {
  const href = e.currentTarget.getAttribute("href") ?? undefined;
  if (!isZipHref(href)) return;
  e.preventDefault();
  void downloadZip(href);
}
