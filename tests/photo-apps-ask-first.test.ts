import { beforeEach, describe, expect, it, vi } from "vitest";

// Photodump's "Create pack" and "New character", and the Character Sheet's and AI Influencer's run, ask first: a guest
// gets the sign-up card, an account with nothing to run on "Connect your GPU", before the dialog opens or the run is
// sent. A press made before the page knows who is looking waits for that, never opening the dialog for a guest.

const state = vi.hoisted(() => ({
  viewer: undefined as undefined | { owner: boolean; account?: { email: string }; signedIn: boolean; publicSignup: boolean },
  viewerError: false,
  status: undefined as unknown,
  asked: [] as string[],
  refusing: false,
  refs: [] as { current: unknown }[],
  ref: 0,
  effects: [] as (() => void)[],
}));

// One hook harness, outside React: refs keep their value between renders, effects run after each render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T,>(f: T) => f,
  useRef: (init: unknown) => (state.refs[state.ref] ??= { current: init }, state.refs[state.ref++]),
  useEffect: (f: () => void) => void state.effects.push(f),
}));
vi.mock("@/lib/api", () => ({
  useViewer: () => ({ data: state.viewer, isError: state.viewerError }),
  useStatus: () => ({ data: state.status, isError: false }),
  // The real ask: true (and the card opens) for a guest or an account with nothing to run on.
  useAskBeforeUpload: () => (action: string) => (state.refusing ? (state.asked.push(action), true) : false),
}));

const { useAskFirst, viewerKnown } = await import("@/components/photodump/ask-first");

// One render of the hook (outside React, by the mocks above).
function render() {
  state.ref = 0;
  state.effects = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const ask = useAskFirst();
  for (const f of state.effects) f();
  return ask;
}

beforeEach(() => {
  Object.assign(state, { viewer: undefined, viewerError: false, status: undefined, asked: [], refusing: false, refs: [], ref: 0, effects: [] });
});

describe("asking first on the photo apps", () => {
  it("knows who is looking once the viewer is read (and, for an account, its GPU and keys)", () => {
    expect(viewerKnown(undefined, false, false)).toBe(false);
    expect(viewerKnown(undefined, true, false)).toBe(true);
    expect(viewerKnown({ owner: false }, false, false)).toBe(true);
    expect(viewerKnown({ owner: true }, false, false)).toBe(true);
    expect(viewerKnown({ owner: false, account: { email: "a@example.com" } }, false, false)).toBe(false);
    expect(viewerKnown({ owner: false, account: { email: "a@example.com" } }, false, true)).toBe(true);
  });

  it("a guest's press before the viewer loads waits, then opens the sign-up card, never the dialog", () => {
    const opened: string[] = [];
    render()(() => opened.push("dialog"));
    expect(opened).toEqual([]);
    expect(state.asked).toEqual([]);
    // The viewer arrives: a guest.
    state.viewer = { owner: false, signedIn: false, publicSignup: true };
    state.refusing = true;
    render();
    expect(state.asked).toEqual(["upload"]);
    expect(opened).toEqual([]);
    // Rendering again doesn't ask twice.
    render();
    expect(state.asked).toEqual(["upload"]);
  });

  it("an account's early press waits for its GPU and keys, then goes on when it has one", () => {
    const opened: string[] = [];
    state.viewer = { owner: false, account: { email: "a@example.com" }, signedIn: true, publicSignup: true };
    render()(() => opened.push("run"), "run");
    expect(opened).toEqual([]);
    state.status = { viewer: { kind: "account", gpu: { connected: true } } };
    render();
    expect(opened).toEqual(["run"]);
    expect(state.asked).toEqual([]);
  });

  it("once known, asks at the press: the card for a refusal, else the action", () => {
    state.viewer = { owner: false, signedIn: false, publicSignup: true };
    state.refusing = true;
    const opened: string[] = [];
    render()(() => opened.push("run"), "run");
    expect(state.asked).toEqual(["run"]);
    expect(opened).toEqual([]);
    state.refusing = false;
    state.viewer = { owner: true, signedIn: true, publicSignup: true };
    render()(() => opened.push("dialog"));
    expect(opened).toEqual(["dialog"]);
  });
});
