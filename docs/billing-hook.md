# Billing hook: an optional external service

An install can connect an external billing service at `FUOBE_BILLING_URL`. Fuobe sends facts about each run that goes
to this install's GPUs (hosted runs, see [public-signup.md](public-signup.md#hosted-runs)); the service answers with what
the person sees and whether the run may start. With no service set, every run is free and allowed, and Fuobe makes no
call at all.

Fuobe has no words of its own for prices or balances. Every word on screen about them (the price on Run, the balance in
the top bar and the account menu, a refusal's text, a link, an offer) comes from the service's answers at runtime.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `FUOBE_BILLING_URL` | The service: `https://billing.example.com/base`, `http://…`, or a Unix socket on this machine, `unix:/path/to/billing.sock` | none: no billing |
| `FUOBE_BILLING_TOKEN` | Sent as `Authorization: Bearer <token>` with every call | none |
| `FUOBE_HOSTED_RUNS` | `1` lets accounts run on this install's GPUs (the only runs the service prices) | off |
| `FUOBE_POOL_WAIT_MIN` | How long a run may wait in line on this install's GPUs when the service doesn't say | 30 |

## When Fuobe calls the service

Only for runs on this install's GPUs (the place `pool`), plus an account's policy, its balance, account events and
offer clicks. A run on the account's own GPU or with its own key never asks the service. Every call is safe to send
twice: the service must treat a repeated call (the same `requestId`, or the same hold and run row) as the same call.

| Call | Timeout | When |
|---|---|---|
| `GET /v1/policy?account=<id>` | 1 s | before a run on this install's GPUs, and for the status (cached for the answer's `ttlS`) |
| `POST /v1/quote` | 1 s | the price check before Run (`POST /api/generations?preview=1`), asked again 300 ms after each change |
| `POST /v1/reserve` | 2 s, one retry with the same `requestId` | just before the run's rows are made |
| `POST /v1/release` | 5 s, through the outbox | the rows couldn't be made after a reserve |
| `POST /v1/settle` | 5 s, through the outbox | each row that succeeded |
| `POST /v1/refund` | 5 s, through the outbox | each row that failed, was stopped, or was removed by an output check |
| `GET /v1/balance?account=<id>` | 1 s | the balance pill and the account menu's balance (cached 10 s) |
| `POST /v1/account-event` | 5 s, best effort | an account was made, verified, signed in or deleted |
| `POST /v1/interest` | 5 s | a person pressed an offer's button |

### Shapes

All JSON. Times are Unix milliseconds. Amounts are whole numbers in the service's own unit.

```ts
type AccountFacts = { id: string; email: string | null; emailVerified: boolean; signIn: "google" | "password"; createdAt: number; adultAt: number | null };
type Place = "own-gpu" | "own-key" | "pool" | "install-key";
type RunFacts = {
  place: Place; model: string; op: string | null; app: string | null; preset: string | null; studio: string;
  kind: "image" | "video" | "audio" | "text" | "model3d"; engine: "open" | "cloud"; provider: string;
  jobs: number; outputsPerJob: number; megapixels: number | null; seconds: number | null; fps: number | null;
  loras: number; inputs: { image: number; video: number; audio: number }; lane: string | null; providerUsd: number | null;
  steps?: { model: string; op: string }[];   // the run's other steps beside `model` (a 2K take's finish on this install's GPUs)
};
type QueueFacts = { lane: string; ahead: number; etaS: number | null; workersOnline: number; nextOpenAt: number | null; mine: { waiting: number; running: number } };
type Action = { label: string; url: string };              // Fuobe opens url as given (https, or a path on this site)
type Offer = { key: string; text: string; label: string };  // a click sends POST /v1/interest { account, key }
type RefuseCode = "top-up" | "limit" | "busy" | "not-offered" | "blocked" | "closed" | "paused";

type Quote = { allowed: boolean; amount: number; priceVersion: string; text: string; sub?: string; code?: RefuseCode; etaS?: number | null; action?: Action; offer?: Offer };
type Policy = {
  hosted: boolean;                                                // may this account use this install's GPUs at all
  pool: { allow?: string[]; deny?: string[]; apps?: { allow?: string[]; deny?: string[] } };  // models and apps there
  uploads: { image: boolean; video: boolean; audio: boolean };    // which of its own files those runs may use
  limits: { activeRuns: number; waiting: number; runsPerHour: number; outputsPerRun: number; maxMegapixels: number; maxSeconds: number; keepDays: number; spaceBytes: number };
  links?: Action[]; notice?: { id: string; text: string; url?: string }; ttlS: number;
};
```

| Call | Request | Answer |
|---|---|---|
| `POST /v1/quote` | `{ account: AccountFacts \| null, run: RunFacts, queue: QueueFacts \| null }` | `Quote` |
| `POST /v1/reserve` | `{ requestId, account: AccountFacts, run: RunFacts, queue: QueueFacts \| null, shown: { amount, priceVersion } }` | `{ ok: true, holdId, amount, boostMs, maxWaitMs, pools?, text }` or `{ ok: false, code: RefuseCode \| "price-changed", text, quote?, action?, offer? }` |
| `POST /v1/release` | `{ holdId, reason: "not-created" }` | `{ ok: true }` |
| `POST /v1/settle` | `{ holdId, generationId, rows, status: "succeeded", final: { outputs, megapixels, seconds }, providerUsd, gpuMs, device, reachedProvider }` | `{ ok: true, charged }` |
| `POST /v1/refund` | `{ holdId, generationId, rows, status: "failed" \| "canceled" \| "hidden" \| "unchecked", reason, reachedProvider, gpuMs, device }` | `{ ok: true, text }` |
| `GET /v1/balance` | | `{ amount, chip, text, sub?, refillAt?, detail: { label, text }[], action?, offer? }` |
| `POST /v1/account-event` | `{ event: "created" \| "verified" \| "signed-in" \| "deleted", account: AccountFacts }` | `{ ok: true }` |
| `POST /v1/interest` | `{ account, key }` | `{ ok: true, text }` |

`shown` is the price the person saw before pressing Run. A service must never charge more than it: when the price would
be higher, it refuses with `price-changed` and the new quote, and the person sees the new price before running again.

A reserve's `text` is shown on the result once it succeeded ("7 units"). `maxWaitMs` is how long the run may wait in
line; past it the row fails and is refunded.

Example (arbitrary numbers):

```json
POST https://billing.example.com/v1/reserve
{ "requestId": "r_9Xk2", "account": { "id": "acct_1", "email": "a@example.com", "emailVerified": true, "signIn": "password",
  "createdAt": 1767225600000, "adultAt": null },
  "run": { "place": "pool", "model": "oss-example", "op": "t2i", "app": null, "preset": null, "studio": "image", "kind": "image",
  "engine": "open", "provider": "comfyui", "jobs": 1, "outputsPerJob": 1, "megapixels": null, "seconds": null, "fps": null,
  "loras": 0, "inputs": { "image": 0, "video": 0, "audio": 0 }, "lane": "comfyui", "providerUsd": 0 },
  "queue": { "lane": "comfyui", "ahead": 2, "etaS": 40, "workersOnline": 1, "nextOpenAt": null, "mine": { "waiting": 0, "running": 0 } },
  "shown": { "amount": 7, "priceVersion": "v7" } }
→ { "ok": true, "holdId": "h_1", "amount": 7, "boostMs": 7000, "maxWaitMs": 700000, "text": "7 units" }
```

## What the person sees when a run is refused

The run route answers a refusal with the service's `text` as `error`, a status by code, and the header
`x-fuobe-billing: <code>`. The page opens one card with the text, the `action` link or the `offer` button, and a way to
run for free on one's own GPU.

| Code | HTTP |
|---|---|
| `price-changed` | 409 (the body has the new `quote`) |
| `top-up` | 402 |
| `limit` | 429 |
| `busy`, `paused` | 503 |
| `blocked`, `not-offered`, `closed` | 403 |

## Holds and the outbox

Every row a run makes (its jobs, and every step its chains queue) carries the reserve's hold. The server stamps it; a
client can never set it. Once none of a hold's rows is still queued or running, each row is reported once: `settle` for
a row that succeeded, `refund` for any other, each with `rows` (how many rows share the hold), so the service knows when
the hold is closed. Reports are written to an outbox table first and sent from there, retried with backoff (10 s,
doubling, up to 10 minutes) for 7 days. A restart loses nothing: the outbox finds every finished row with a hold and no
report from what is stored. A run whose rows couldn't be made after its reserve sends one `release`.

## When the service is down

| Situation | What happens |
|---|---|
| No `FUOBE_BILLING_URL` | No call. Every run is free and allowed. |
| Set, and it answers | As above. |
| Set, and no answer in time | Runs on this install's GPUs are refused (503, "Runs are paused for a moment. Try again soon."). Run shows "Price unavailable". Runs on the account's own GPU or key go on. Reports wait in the outbox and are sent when it is back. Runs that already have a hold keep running. |

The service's address and its errors are written to the server's log only. A browser never sees them.
