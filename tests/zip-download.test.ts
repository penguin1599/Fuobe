import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A results zip (Shorts' Download parts, Photodump's Download all, the Library's Download) asks the route first: a
 * refusal is a toast and the page stays where it is; only a zip the route will make is downloaded.
 */

const errors: string[] = [];
vi.mock("sonner", () => ({ toast: { error: (m: string) => errors.push(m) } }));
const { downloadZip, isZipHref, onZipLink } = await import("@/lib/zip-download");

const clicked: string[] = [];
let asked: string[] = [];
let answer: () => Response = () => Response.json({ files: 1, size: 10 });

beforeEach(() => {
  vi.useFakeTimers();
  errors.length = 0;
  clicked.length = 0;
  asked = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const a = { href: "", download: undefined as string | undefined, click: () => clicked.push(a.href) };
      return a;
    },
  });
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return answer();
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ZIP = "/api/generations/zip?ids=a,b";

describe("downloadZip", () => {
  it("asks first, then downloads", async () => {
    answer = () => Response.json({ files: 2, size: 10 });
    expect(await downloadZip(ZIP)).toBe(true);
    expect(asked).toEqual([`${ZIP}&check=1`]);
    expect(clicked).toEqual([ZIP]);
    expect(errors).toEqual([]);
  });

  it("says the route's refusal and downloads nothing", async () => {
    answer = () => Response.json({ error: "Your last download is still going" }, { status: 429 });
    expect(await downloadZip(ZIP)).toBe(false);
    expect(clicked).toEqual([]);
    expect(errors).toEqual(["Your last download is still going"]);
  });

  it("says something when the route can't be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await downloadZip(ZIP)).toBe(false);
    expect(clicked).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("does nothing on a second click while the first is going", async () => {
    answer = () => Response.json({ files: 2, size: 10 });
    const [one, two] = await Promise.all([downloadZip(ZIP), downloadZip(ZIP)]);
    expect([one, two]).toEqual([true, false]);
    expect(asked).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(await downloadZip(ZIP)).toBe(true);
  });
});

describe("onZipLink", () => {
  const link = (href: string) => {
    let prevented = false;
    onZipLink({ currentTarget: { getAttribute: () => href } as unknown as HTMLAnchorElement, preventDefault: () => (prevented = true) });
    return prevented;
  };

  it("takes over a results zip link and leaves every other download alone", async () => {
    answer = () => Response.json({ files: 2, size: 10 });
    expect(link(ZIP)).toBe(true);
    expect(link("/api/files/outputs/a.png?download=a.png")).toBe(false);
    expect(isZipHref("/api/folders/f1/zip")).toBe(false);
    await vi.waitFor(() => expect(clicked).toEqual([ZIP]));
  });
});
