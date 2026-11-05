# Public sign-up and guest browsing

A Fuobe studio with a password can open itself a little to the public: signed-out visitors (guests)
browse it read-only, and anyone can make a free account. It is off by default, so a self-hosted
studio behaves as before: every page and API call needs the install password or an API token.

## Turning it on

Public sign-up works only on a studio that has a password (`FUOBE_PASSWORD` or **Settings →
Security**). Then it is on when one of these is true:

- `FUOBE_PUBLIC_SIGNUP=1` is set on the server. `FUOBE_PUBLIC_SIGNUP=0` keeps it off, whatever
  Settings says. While the variable is set, the Settings switch can't change it.
- The owner turns on **Settings → Security → Public sign-up**.
- The request is for `fuobe.com` or `www.fuobe.com` (the public demo), the server lists that name in
  `FUOBE_ALLOWED_ORIGINS`, and `FUOBE_PUBLIC_SIGNUP` is not `0`. The `Host` header comes from the
  client, so a self-hosted studio that someone reaches by its IP address can't be opened with
  `Host: fuobe.com`.

Turning it off signs out every account at once, and guests are sent to sign in again.

## Guests

A guest can open every page: galleries, presets, the studios, Layers, Cinema, Image to 3D and
Settings, read-only. The pages get the catalog and status reads they need (`/api/status`,
`/api/models`, `/api/search-index`, `/api/comfyui`, `/api/settings/models`, curated moodboards,
built-in skills), and the bar's menus read `/nav-menus/apps`, `/nav-menus/motions` and
`/nav-menus/canvas`: static files made at build time that hold what a visitor may see only (no model
names, no template without a real cover). The owner's library stays private: the lists come back empty, and other reads of
it (files, uploads, projects, settings values, tokens) answer 401 "Sign up to see your library".

Every change a guest sends (generate, upload, save a setting, create a project…) answers 401. The
studio shows a "Create a free account to run this" card with **Sign up** and **Log in**. Where
signing up wouldn't help, a guest gets an account's answer instead: 403 `assist-owner` for Assist,
and 403 `own-gpu-tool` for a tool an account's own GPU or key doesn't run (Katana,
Marketing…). The pages of those tools say so up front and turn off their upload and Generate.
What is drawn in the browser itself is open to try: Click to Ad's animated end card and Marketing
Studio's code-drawn templates (Kinetic Motion) take a guest's words and play live (a code-drawn
template shows no "isn't available" note, as nothing is generated); their Save opens the sign-up card before anything renders.
The Kinetic page (`/kinetic`) is open the same way: a guest plays and edits every scene (Easy and Pro, presets,
timing, undo), and Save, Save frame, Save contact sheet, Save version, "Pick a clip" and an upload open the sign-up
card before anything renders or uploads. A guest's versions list is empty and `/kinetic?from=<id>` opens the scene
picker. Price
checks (the estimate routes, and `?preview=1` on the run routes that support it) stay open, so the
studios can show prices. A guest may send 120 price checks a minute (per visitor behind a trusted
reverse proxy; see below), and so may each account. A price check reads only the header of a file
it names, and only of the asker's own files (a guest owns none) or of Fuobe's published example files. Nor does a price check reveal the
owner's library: the turnaround video's price check (`/api/turnaround/estimate`, or
`/api/turnaround?preview=1`) answers 404 "Character not found" for any character a visitor names,
whether it exists or not. A price check never calls a GPU either: Split soundtrack's price check
takes an account's GPU type from the status strip's last check and asks the GPU nothing.

## Accounts

- Sign up at `/login?signup=1` (`POST /api/auth/signup` with `{ "email", "password" }`). The
  password needs at least 8 characters. There is no email verification.
- Log in at `/login` (`POST /api/auth/login` with `{ "email", "password" }`). The install password
  still works as before: `POST /api/auth/login` with `{ "password" }`, or the owner's sign-in at
  `/login?owner=1`. The login page links to it only in development, so a public site doesn't
  advertise it.
- Accounts are stored in the database (`fuobe.db` in the data folder, table `auth_accounts`): the
  email in lower case (one account per email), a salted scrypt hash of the password (the same scheme
  as the install password), and the creation time. An install from before this kept them in
  `auth.json`, which moves into the database on the first start ([Sign-in data](SELF-HOSTING.md#sign-in-data)).
- Sign-up and log-in attempts are rate limited per visitor (set `FUOBE_TRUST_PROXY=1` behind a
  reverse proxy, so that each visitor gets their own limit; an IPv6 address counts by its /64).
  A visitor gets 30 account log-ins a minute, right or wrong, and 10 a minute for one email. After
  5 wrong passwords for one email, that visitor is locked out of it for 15 minutes. After 10 wrong
  passwords for one email from any number of addresses, the email is locked for 15 minutes, but
  only for the addresses that got it wrong twice or more. The person whose account it is still
  gets in from anywhere else, so nobody can lock a chosen account out. Account log-ins and the
  install password have separate limits, so guessing at one never slows down the other.

An account is signed in, but it sees the owner's studio as a guest does:

- **The owner's library stays the owner's.** An account opens every page and the catalog, but the
  owner's results, files, uploads, folders, shares, projects (Layers, Cinema, Canvas, storyboards,
  elements…) and Assist threads are hidden: the lists come back empty, and other reads answer 403.
  Every change to them (create, rename, move, share, delete) answers 403 with `code: "library"`.
  Accounts have their own uploads and runs (below), their own Cinema Studio projects, and their own Faceless
  channels, explainers and Content Factory series.
  A Canvas Kinetic node renders in the owner's browser; keeping its run on the board
  (`PUT /api/canvases/<id>/runs/<node>`) is a canvas change like any other (403 `library` for an account, 401
  for a guest), and it takes only the owner's own finished Kinetic Motion results.
  **Canvas is open to build in.** Each ready board has its page (`/canvas/start/<id>`: what goes in, the
  steps and what comes out), and **Use this board** opens it in the Canvas editor (`/canvas/try/<id>`,
  or `/canvas/try/blank` for a blank one) with every node and link in place, its inputs holding
  Fuobe's published example files (by their public path, never a copy in anyone's storage) and its
  last step showing the board's own published film. A guest builds and changes boards there; the
  first change keeps the board in that browser only (`/canvas/draft/<id>`, localStorage, up to 20,
  nothing sent to the server), and **Save** offers a free account. An account saves its boards to its
  account (`/canvas/saved/<id>`; `GET`/`POST /api/account/canvases`, `GET`/`PATCH`/`DELETE
  /api/account/canvases/<id>`): its own boards only (another account's reads as 404, a guest gets
  401), up to 50 boards of 1 MB each and 120 saves a minute, deleted with the account. Its inputs
  take its own uploads or Fuobe's published example files, nothing else. The owner's canvases
  (`/api/canvases`) stay the owner's (403 `library` for an account). **Run** on a visitor's board
  never runs: a canvas plans with the studio's own AI helpers, so it says what running needs and
  links the Video effect that makes the same film in one step (or the studios); its steps name no
  price or run state, and a ready board's last step says Example. On a phone the
  board shows read-only with its steps editable in Nodes. Assist, Cinema Studio,
  Storyboard, Elements, Faceless Studio, Content Factory, Explainer, Ads Studio, Click to Ad and
  Marketing Studio show their ready-made starters the same way (`<studio>/start/<id>`); making one
  (`POST /api/starters/<id>`) is the owner's, and an account gets 403 `library`, except Cinema Studio's
  ready films and Faceless Studio's ready channels, which an account makes as its own project (a guest gets the sign-up
  card). Content Factory's and the Explainer's ready ones fill the composer for anyone. A starter without its
  cover yet is the owner's only: its card, its words and its page (404 for anyone else). Storyboard's
  ready stories with a cover also fill its composer for anyone (`/storyboard?starter=<id>`), and the
  Library's "Make your first" row links to pages everyone can open.
- **Settings, keys and tokens are the owner's.** Changing settings or model switches, the password,
  API tokens, Public sign-up, LoRA downloads, Assist connectors and the MCP endpoint answer 403 for
  an account.
- **Accounts never run on the owner's keys or GPU.** An account runs on its own ComfyUI (see
  [Your GPU](#your-gpu)) or its own fal.ai or Replicate key (see [Your keys](#your-keys)). With
  neither, anything that would reach a model (a generation, an AI helper, a retry) answers 403
  with `code: "connect-gpu"`, and the studio shows a "Connect your GPU to run this" card.
- **Its own runs are its own.** The runs an account starts on its GPU appear in its own lists
  (`GET /api/generations`), and it can open, cancel and delete them and download their files. They
  stay out of the owner's Library and live feed, and no other account can open them. The studio's
  owner can see them, open their files and delete them ([Managing accounts](#managing-accounts));
  the sign-up form says so. An account's delete is for good (it has no Trash): a result's ⋯ menu and the
  Library's selection bar say **Delete for good…** and ask first, and its space comes
  back at once. The live-updates stream isn't sent to accounts: their studios poll instead.
- **It downloads its own runs as one zip.** The Library's **Download**, a result's **Download all** and Shorts'
  **Download parts** go to `GET /api/generations/zip`, which zips the account's own runs only: another account's run or
  the owner's is left out, exactly as one that doesn't exist (none of its own: 404), so the answer never says whether
  it is there. A file held for its check is left out too. One zip takes up to 200 runs and 1 GB (413 past either), and
  an account makes one zip at a time (429 while one is going; a download that stops, or stalls for 2 minutes, frees
  it). The zip is streamed from the files, so it uses no disk or memory. The Library asks first (`?check=1`), so a
  refusal shows as a message. A guest gets the sign-up card.
- **Its own uploads are its own.** Only the account that uploaded a file can use it in a run, and
  no other account can open it. See [Uploads](#uploads).
- **Results made in the browser are its own runs too.** A motion clip rendered in
  the page (an animated end card, a text template, anything made on the Kinetic page) is saved with an upload and
  `POST /api/generations/local` (`op: "motion"`, model `local-motion`). No model makes it, so any
  account may save one, with or without its own GPU or key (the upload is sent with
  `x-fuobe-kinetic: 1`; see [Uploads](#uploads)). It counts as the account's own runs and files: the clip and every file it
  names (its pictures, and the recipe's logo, product, pictures and clip) must be the account's own (403
  otherwise). Frames, contact sheets and versions are Kinetic results too (`feature` `kinetic-frame`,
  `kinetic-sheet` or `kinetic-version`, a PNG picture of the size its recipe makes: the export size for a frame or a
  sheet, the rest frame 540 px on its long side for a version; 400 otherwise); a clip under the words must be the account's own stored video,
  and a video input is taken only when it is the recipe's own clip (`layers.video.src`; 400 otherwise). The stored
  file must be the MP4, WebM or (for those three) PNG it claims to be (400), and it shares the account's hourly run budget (60 an hour with its other runs,
  429). The words drawn on the clip (the recipe's fields and brand name) and its title go through the
  studio's checks when they are on, whatever the page sends as the prompt, and are what the run keeps
  (a refusal answers 422; a result the checks want to see waits for them). It shows in the account's
  own runs, never the owner's Library. Nothing
  is downloaded straight from the page: the clip is downloaded from the saved result. A guest's
  call answers 401 with the sign-up card.
  A **colour grade** (`op: "grade"`, model `local-color-grade`) and a **Relight blend** (`op: "relight"`,
  model `local-relight`) are kept the same way: the same upload, its own stored PNG picture or MP4 or WebM clip
  (400 otherwise), made from its own files only (a file picked on the page stays in the browser, so the grade names
  no input), within the same run budget and through the same checks (its description and title). Colour grading's
  **Save to your runs** shows for an account; a guest's Save opens the sign-up card.
  Split soundtrack's **Export mix** (`POST /api/audio-tools/export`, the WAV in parts) is kept as one of its runs
  too (`feature` `audio-split-mix`, model `local-mix`): its WAV goes into its own files, no bigger than the room
  they have left (413), one export at a time (a new one drops the unfinished one), and a part with another viewer's
  export id answers 404. The last part answers 201 with the run, within the same run budget (429) and through the
  same checks (422).

## Managing accounts

The owner sees everyone who signed up in **Settings → Accounts**, the last section of Settings (the
**Accounts** chip at the top of Settings and the link under Public sign-up lead there): email,
whether its own GPU is connected, its runs (all time, in the last 7 days, running now, failed in the
last 7 days), when it last ran, and the space its files take against its limit (1 GB in its first 7
days, then 3 GB). On wide screens the list also shows when the account was created and its last
log-in (the CSV always has them). Running now counts as the run limit does: a batch or a chain
going is one run. A line above the list gives the runs of every account in the last 24 hours and 7
days, the runs going now, and the space all accounts' files take against their share of the disk.
The owner can switch an account off (it is signed out at once and can't log in) or delete it, and
export the list as CSV. If an `auth.json` turns up in the data folder after the sign-in data moved
into the database, the section also shows a notice. Visitors never see it. The file is not used: it
is set aside under a new name, and sign-in goes on from the database. The notice gives the file's
name and how many accounts and API tokens it lists
([Sign-in data](SELF-HOSTING.md#sign-in-data)).

**Accounts' runs** (`/settings/runs`, from the list) shows what accounts made, newest first: one
account's or every account's, each labelled with its email, filtered by account, status (finished,
running, failed) and kind. The filters are in the address (`?account=<id>&status=failed&kind=video`),
so a reload or a shared link keeps them. Each run shows its result (a clip plays on hover, a tap, or
Enter; the count on a run with several files steps through them, and its menu opens each one), the
app, preset or studio and the model, the prompt, its status with the error of a failed run, and when
it ran. The owner can delete a run with its files, which gives the account its space back at once, or
switch the account off from there. The owner's own runs are never listed there, and accounts' runs
never appear in the owner's Library, its counts or the live feed.

The API, for the owner only (guests get 401, accounts 403): `GET /api/admin/accounts` (each account
with `runs`, `runsDay`, `runsWeek`, `running`, `failedWeek`, `lastRunAt`, `bytes` and `capBytes`,
and `totals`; `?format=csv` for the file), `PATCH /api/admin/accounts/<id>` with
`{ "disabled": true | false }`, `DELETE /api/admin/accounts/<id>`, `GET /api/admin/generations`
(`?account=<id>`, `status=finished|running|failed`, `kind=image|video|audio|model3d|text`,
`before=<createdAt>:<id>` from the last page's `next`, `limit` up to 100) and
`DELETE /api/admin/generations/<id>` (an account's run only).

An account can delete itself: `DELETE /api/auth/me` with `{ "password" }`. When an account is
deleted (by itself or by the owner), its runs are stopped and removed, and its uploads and results
are deleted with it.

An account changes its password in **Settings → Account**: `PATCH /api/auth/me` with
`{ "current", "next" }` (at least 8 characters, and not the current one). Every other browser signed in to the account is
signed out; the browser that changed it gets a new session. Changing the password and deleting the
account share one limit: 5 password checks a minute per account. A browser that was signed out gets
401 from both, so the page can offer Log in; the owner gets 403.

## Your GPU

An account connects its own ComfyUI in **Settings → Your GPU**, or from the "Connect your GPU" card,
in one of two ways.

### The ComfyUI on this computer

The first choice: the account's open Fuobe tab runs its jobs on the ComfyUI on the same computer.
The server still plans every run (templates, inputs, checks, limits, history). Each ComfyUI call
becomes a job that the tab takes (`/api/gpu/computer/*`), sends to `http://127.0.0.1:<port>`,
follows, and whose results it uploads back; results are checked like uploads, and a job takes only
its own results, once. The server never calls the person's computer. Runs wait while no tab is open
("Open Fuobe on the computer with your ComfyUI to run this") and stop cleanly after a while.

- **Finding ComfyUI.** The card looks on ports 8188, 8000 (ComfyUI Desktop), 8189, 8190, 8288, 8001
  and 7821, or one the person types. While the browser would still ask to let the site reach apps
  on this device, it looks only after a click, and explains that question first. A tab never
  reaches the computer's apps by itself before that.
- **Fuobe Connect.** A page can read a ComfyUI on the computer only when ComfyUI lets that site in.
  Fuobe Connect (`integrations/fuobe-connect`, from ComfyUI-Manager or a git clone) lets in only the
  studios that the person trusts (`https://fuobe.com` unless they name others), and only for what a
  run needs. Every other website still meets ComfyUI's own check. The card offers it only while
  `FUOBE_CONNECT_PUBLISHED` (`src/lib/fuobe-connect.ts`) is true, which it is once its repository
  is published. Then it is the one step, and the setting and the guard below are under "Advanced".
  Until then the setting with the guard is the one step. See [gpu-workers.md](gpu-workers.md).
- **Pairing** (Safari, phones, a blocked browser, a PC with no screen), offered with Fuobe Connect:
  Fuobe Connect shows a code, and the person types it and approves it while signed in
  (`/connect?pair=1`; the page never fills in a code from its link). That ComfyUI then runs this
  person's jobs, and only theirs, with no tab open. Settings → Your GPU lists it, with Disconnect.
- **Fuobe's setting.** Without Fuobe Connect, ComfyUI must run with
  `--enable-cors-header <the site's address>`. The card gives the fix for the install it finds: a
  start file for Windows portable or Easy-Install (it restarts ComfyUI with the setting and leaves a
  start file with it for next time; it never changes the person's own start files), the place in
  ComfyUI Desktop's Server-Config, Stability Matrix's launch options, or the flag for a terminal.
  It notices by itself when ComfyUI is back with it.
- **Fuobe's guard.** With that setting, ComfyUI stops turning away other websites' requests.
  `fuobe_guard.py` (src/lib/comfy-guard.ts), a custom node that the start file puts in
  `custom_nodes` and that the other installs download from the card, puts the check back: a request
  from a web page gets in only from ComfyUI's own page or the site the setting names, the live
  socket included. It answers `GET /fuobe/guard`, and the card warns while it's missing.
- **Phones and Safari** can't reach a ComfyUI on the device: they get the link instead (and pairing, with Fuobe
  Connect), with why.

The owner can do the same on a deployed studio: **Settings → Where ComfyUI runs → On the computer
you're using**. A studio with ComfyUI on its own machine keeps calling it from the server.

### A link

For runs that go on with the tab closed. The studio's server calls that ComfyUI, so it must be
reachable from the internet. Put a tunnel in front of a local ComfyUI and paste the https address
it prints:

```bash
cloudflared tunnel --url http://localhost:8188   # or: ngrok http 8188
```

- **Saving.** `PUT /api/account/gpu` with `{ "url", "token"? }` checks the address and asks that
  ComfyUI for `/system_stats` (`?test=1` checks without saving). `DELETE` disconnects. The address
  and the optional token (sent as `Authorization: Bearer`) are stored with the account in the
  database (`auth_account_gpu`), never as the studio's ComfyUI setting.
- **Server-side requests.** Addresses on the server itself, on private networks or link-local
  addresses are refused. The check runs again on the address each connection actually uses, so a
  name that is later pointed at the server can't reach the studio's own ComfyUI. The studio's own
  ComfyUI address is refused too, and so are IPv6 addresses that wrap an IPv4 address.
  `FUOBE_ALLOW_PRIVATE_URLS=1` allows private addresses, for a LAN install, but never the server's
  own addresses. Address checks are limited to 10 a minute.
- **Runs.** Everything that runs through `POST /api/generations` runs on the account's ComfyUI
  with the open-source engine: the Image, Video and Audio studios (their input modes too: edit,
  inpaint, extend, lipsync, reframe, upscale, image to video…), every camera motion and effect,
  and the apps that take a picture, a clip or a sound. Their chained steps (multi-shot films,
  Frames mode, Extend, relit effects) run there too, as the account's own. So does a 3D model (the
  Image to 3D and Photo to 3D apps, and an image result's "Make it 3D", which opens Photo to 3D), on
  the account's own GPU or key; it is finished as Image to 3D's models are (below), and on this
  install's GPUs (hosted runs) 3D isn't offered yet. Polls,
  uploads, outputs and cancels go there, and nothing falls back to the studio's own providers. If
  the account's ComfyUI can't be reached, the run waits for it, then says why in plain words
  ([When your GPU or key has a problem](#when-your-gpu-or-key-has-a-problem)). A cloud model, an AI helper or
  the studio's local LLM is refused; "Enhance prompt" uses Fuobe's offline wording. Other tools
  (Canvas, Assist, Marketing…) answer 403 with `code: "own-gpu-tool"`, because they
  plan with the studio's own AI helpers or keep projects of their own. The Audio tools have their own routes (below).
  Restore & colourise (`POST /api/restore`) shows to everyone, its tab, page and result-menu item marked "Runs on your
  own GPU · 24 GB": an account runs it on its own GPU after the same checks as Genjutsu's, with Fuobe's offline template
  for the words (writing them from the frames with the studio's AI helper stays the owner's). A visitor's page is the
  GPU's whatever the engine switch says, since the cloud engine carries the gated Restore IC-LoRA, which never goes with
  an account's own key (an account's cloud run answers 422 before anything starts); a guest gets the sign-up card, an
  account without a GPU "Connect your GPU". A guest's model pickers list the
  paid models after the open ones, each marked "Use your own fal.ai key" (or Replicate); choosing one opens the sign-up
  card. An account without a key sees the same list with "Add your fal.ai key". Image to 3D's cloud models, Retexture,
  Rig and "Use the cloud" for Pick an object are marked the same way for a visitor on open models only.
  A hosted model whose calls haven't yet passed a live run with a real key (`src/lib/catalog/hosted-untested.ts`:
  MiniMax H3 Max's lip sync, relight, insert, looks and Turbo, H3 Lite and HighSpeed, Vidu Q4, the Mureka songs and
  song tools, MiniMax Music 3, ElevenLabs Music, Lyria 3.5, the hosted voice cleaners, Meshy retexture, Tripo P2,
  Fuobe Animation's cloud half, Kandinsky 6.0, Kandinsky VSR, Bria green screen and Bria guided cut-out) runs on an
  account's own key like any paid model: it stays in the account's pickers once it has a key, an account without the
  key is asked for it (`add-key`), and a guest gets the sign-up card. Audio → Extend & remix shows to everyone, its tab
  marked "Use your own fal.ai key". `src/lib/own-setup.ts` labels these and every other item that runs only on a
  visitor's own GPU or key (`ownSetupOnly`, `ownSetupLabel`, `ownSetupStep`), and the hosted runs never place one on
  this studio's GPUs or keys. The items that need a bigger card than this studio's (Open-H3 Regenerate: Upscale →
  Video's "Regenerate · creative" and its first step, "Regenerate in 2K" and "Enhance" in result menus, the Canvas
  node, Shorts' Enhance, Cinema's "Finish in 2K" on a GPU take, MiniMax H3 at 2K on
  your GPU, Character Swap's Sharpen and its 1080p / 2K / 4K on your GPU; and Kandinsky 6.0 Pro) show to everyone,
  marked "Runs on your own GPU · 48 GB" (Kandinsky Pro's choice says about 80 GB). An account runs them on its own GPU
  only, when that GPU has the memory (`src/server/own-setup-run.ts`); otherwise it gets "Connect your GPU" (`connect-gpu`).
  Cinema's exact orbit is marked "Runs on your own GPU · 48 GB or fal.ai key". Faceless's "Regenerate to 1080p" and
  Shorts' Enhance run on an account's own GPU through their own routes (`.../regenerate`, `.../enhance`). The owner sees
  these surfaces too; while they are held on this studio's GPU, the owner's run answers with what it needs ("needs a
  GPU with 48 GB or more"). Cinema's "Make a prop from a picture" (Idol 3D) runs on a visitor's own GPU through Image to
  3D's route.
  "Write the lyrics" and "Rewrite my prompt now" use the studio's AI helper and are hidden from guests and accounts.
  A song's stems come back as one zip: for an account it is fetched from public addresses only, within what its files
  have room for (128 MB at most, 256 MB unpacked), and each stem is saved to disk as it is unpacked.
- **Genjutsu.** An account runs Genjutsu's modes that are open to everyone the same way (`POST /api/genjutsu`, and the
  clip's words for Character swap, `POST /api/genjutsu/transcribe`). Each step of the run (the cut, the swap, the joins,
  the sound) is a run of its own on the account's ComfyUI, or on its own fal.ai or Replicate key on the cloud engine,
  with only its own files, and the whole run counts once against its limits. Its results show under "Your Genjutsu" and
  in its own runs, to open and download. "Describe my character" (`POST /api/genjutsu/describe`) runs the GPU describer
  on the account's own ComfyUI: a core graph (Qwen3-VL 8B through TextGenerate, `character-describe-qwen3vl`) reads
  only the account's own picture, takes no text from the request and saves under a name the server makes; the page
  fills the description from that run's text. A guest gets the sign-up card. The checks are
  `src/server/account-tool-run.ts`.
  The modes and options that haven't yet passed a real render on this studio's GPU (Group swap's "one by one", Object
  swap's Change it, Remove it and New background, From picture with its Light and own person choices, Fix faces and
  MiniMax H3 Motion transfer) show to everyone, marked with what they run on ("Runs on your own GPU · 24 GB",
  `src/lib/own-setup.ts`). An account runs them on its own GPU; without one it gets "Connect your GPU"
  (`connect-gpu`). The mark leaves by itself once the feature's graphs are validated and its pass is recorded in
  `workflows/comfyui/gpu-tested.json` (`genjutsuLive`; "Clean the voice first", in Genjutsu and Character Swap
  Studio, works the same way through `soundLive`). Cinema Studio's World mode carries the same mark
  until its graph is validated (`src/server/own-setup-live.ts`), and Image to 3D's "Trim spikes" says what it runs on.
- **Storyboard.** An account makes boards the same way (`POST /api/storyboards`), and the film of a board
  (`POST /api/storyboards/<id>/film`). Every frame, shot and join is a run of its own on the account's ComfyUI, or on
  its own fal.ai or Replicate key on the cloud engine, with only its own pictures as look references, and a board (or
  a film) counts once against its limits. Its boards are its own runs: the page lists them, to reopen, open and
  download, and a film takes only its own board (another account's board, or the owner's, answers 404 "We can't
  find that storyboard."). "From one idea" splits the story into a shot list without the studio's AI helper. One
  sheet takes as many panels for an account as its recorded GPU test showed (`ONE_SHEET_GPU_TEST`; with none recorded
  a one-sheet board answers 422 for an account). A guest gets the sign-up card.
- **Image to 3D.** An account makes its 3D models on its own ComfyUI, or on its own fal.ai or Replicate key on the
  cloud engine (`POST /api/image-to-3d`, which takes the same request as `POST /api/generations`): From an image, From
  several images, From text, Pick an object and Splat, and a finished model's Rig & animate. It gets the checks every
  tool run gets, and its models show under "Your 3D models", to view in 3D and download. A GLB from its ComfyUI is
  finished on this server (the web GLB the viewer loads) under its limits (`src/server/model3d-finish.ts`): one account's
  finish at a time across the server, at low priority; a model over 300 MB, a server or account short of room, or more
  than 60 finishes in an hour keep the model as it came (still viewable and downloadable). Its turntable is recorded in
  the browser ("Record turntable"), not on the server. Film it photoreal runs as a Fly around (below). Refine detail (Hi3D), the TRELLIS.2 final,
  Idol 3D's other sides ("Make the other sides from the front") and Trim spikes show to everyone and run on the
  account's own GPU through the same route; each is labelled with what it runs on ("Runs on your own GPU · 24 GB")
  until its graph is validated on this studio's GPU (`graphs` in `src/lib/own-setup.ts`, read by the page with
  `ownSetupsNow`, `src/server/own-setup-live.ts`), when the label leaves by itself. Retexture and Rig run on the
  account's own fal.ai key. On this install's
  GPUs (hosted runs) 3D isn't offered yet. A guest gets the sign-up card.
- **Character Swap Studio.** An account keeps Character Swap projects of its own (`/character-swap`; `GET`/`POST
  /api/swap-studio/projects`, `GET`/`PATCH`/`DELETE /api/swap-studio/projects/<id>`): its own only (another account's,
  or the owner's, reads as 404; a guest gets the sign-up card), up to 50 of 1 MB each and 120 saves a minute, deleted
  with the account. Every job in a project (a clip's 24 fps copy or browser copy, its words, a mask, a scene anchor,
  queued takes, Sharpen, the assembly) is a run of its own on the account's ComfyUI, or on its own fal.ai key on the
  cloud engine, with only its own uploads and results, after the same checks as Genjutsu's. A queue counts once against
  its limits: a take that waits for the one before it starts later in the same run. The pictures a project names (the
  character, an imported anchor) and its clips are the account's own. Its assembled clips are its own runs, to open and
  download. The checks are `src/server/swap-studio-account.ts`.
- **Shorts Studio.** An account makes its own shorts the same way (`POST /api/shorts/sessions`), on its own ComfyUI or
  on its own fal.ai or Replicate key on the cloud engine: each segment's cut, restyle and the stitch under the clip's
  sound are runs of its own, with only its own files, and a short counts once against its limits. A new take of a
  segment (`POST /api/shorts/sessions/<id>/segments/<n>`) and Stitch again (`.../stitch`) go through the same checks.
  Its shorts and the presets it makes from its own pictures are its own projects (`src/server/account-projects.ts`):
  its History, a short's page (`/shorts/<id>`) and its preset list show only its own, and another account's or the
  owner's read as not found (404). It keeps up to 50 shorts. Deleting a short deletes its runs for good (an account
  has no Trash). It downloads the full video, each part, and "Download parts" as one zip of its own runs.
  Enhance (`.../enhance`, Open-H3 Regenerate) runs on its own GPU only, one with 48 GB or more (`connect-gpu`
  otherwise), after the same checks. A guest gets the sign-up card.
- **Cinema Studio.** An account makes, reopens and runs its own projects (`/api/cinema/projects/**`): up to 50,
  each with its folders, takes, Director settings, brief and AI Director chat, deleted with the account. Another
  account's project, or the owner's, reads as not found (404), and the owner's lists never show an account's. A take
  (`POST .../generate`, World mode and Blockout to film included), a retry (`.../items/<id>/retry`) and a 2K finish
  (`.../items/<id>/finish`) run the same way as Genjutsu's: every step on the account's ComfyUI or its own fal.ai or
  Replicate key, with only its own files, after the same checks. A project's cover and a grid's tiles must be its own
  files. Its AI Director writes the shot breakdown without the studio's AI helper (no GPU or key needed). Its Delete
  deletes a take for good (it has no Trash). "Create 3D scene" and an exact orbit run there too: on its GPU their first
  step is a 3D model, finished on this server under its limits as Image to 3D's are. Saving a still as an element, the
  elements list and sharing a project are left out: those are the owner's library. A guest gets the sign-up card.
- **Photodump, Fashion Factory, Character Sheet and AI Influencer.** An account runs them the same way
  (`POST /api/photodump`, `/api/photodump/fashion`, `/api/photodump/character`, `/api/influencer`, and a photo's retry
  `/api/photodump/retry`): every photo on its own ComfyUI or its own fal.ai or Replicate key, with only its own files,
  after the same checks, and a set counts once against its limits. Its packs (`/api/photodump/packs`) and its
  characters (`/api/photodump/characters`: a name and photos of one person, saved from New character or from a
  Character Sheet's "Save as character") are its own projects: up to 50 of each, from its own photos, deleted with the
  account; another account's or the owner's read as not found (404). An account's character goes into a run as its
  first photo (an @mention names the owner's elements only). Its runs are its own (each tool's History and recent
  sheets), and a retried photo replaces the failed one for good (it has no Trash). The price is its run's: free on its
  GPU, its own key's price on the cloud engine. A guest gets the sign-up card on Generate, on Create pack, on New
  character and before choosing a photo.
- **Video tools, Turnaround video, Fly around and Katana.** An account runs Remove object and Remove a person
  (`POST /api/remove-object`, its mask preview `.../preview` and "Redo from here" `.../reroll`), Evolution
  (`POST /api/evolution`), Mixed Media (`POST /api/mixed-media`, a preview frame `.../preview` and "Try again"
  `.../retry`), Turnaround video (`POST /api/turnaround`), Fly around (`POST /api/fly-around`: Image to 3D's "Film it
  photoreal" and the exact orbits) and Katana (`POST /api/katana`, `.../<id>/retry`) the same way as Genjutsu's: every
  step on the account's ComfyUI or its own fal.ai or Replicate key, with only its own files, after the same checks, and
  a run counts once against its limits. Their price checks are priced for the account's own GPU or key. Their results
  are its own runs (each tool's history, "Your …" feeds and its runs list), to open and download. "Redo from here" and
  "Try again" take only its own removal or render, and a Mixed Media render's frame count (`GET
  /api/mixed-media/progress`) answers for its own renders only (anyone else's reads as 404). Evolution's direction
  (`POST /api/evolution/direction`, and a run sent without one) is written by Fuobe's offline writer, never the studio's
  AI helper. Turnaround and Fly around never use the studio's WorldCast worker for an account; a character from the
  owner's library answers 404. Katana's runs are its own projects (`GET /api/katana`, `GET`/`DELETE
  /api/katana/<id>`): up to 50, another account's or the owner's read as 404, deleted with the account. A guest gets
  the sign-up card. Removing a person with MiniMax H3 and VOID's removal on the open engine keep their "own setup"
  entries (`video-tools:remove-person`, `video-tools:remove-object-void` in `src/lib/own-setup.ts`) until a real render
  passes on this studio's GPU and is recorded in `workflows/comfyui/gpu-tested.json` (`remove-person`,
  `remove-object-void`): their graphs' `validated` in the manifest says only that ComfyUI accepted the graph.
- **Audio tools.** An account runs Split soundtrack and Clean up dialogue, Video tools → Remove dialogue, Edit speech,
  Loop / extend, Join and Clean up voice (`POST /api/audio-tools`) the same way as Genjutsu's: every step on its own
  ComfyUI, or on its own fal.ai or Replicate key where a step is a cloud model, with only its own files, after the same
  checks, and a run counts once against its limits. Its price check is its own run's. Its stems, clean dialogue,
  edited speech and mixes are its own runs, to reopen in the mixer, open and download, and Export mix keeps the WAV as
  one of its runs (above). Edit speech runs on the account's own GPU only (AuK's files and a 24 GB card): its tab and
  page carry the "own setup" label (`audio:edit-speech`), and its upload and run ask an account without a GPU to
  connect one. Result menus offer Remove dialogue, Clean up dialogue and Edit speech, and Captions offers "Fix this line".
  A guest gets the sign-up card.
- **Translate & dub.** An account keeps dubs of its own (`GET`/`POST /api/dub`, `GET`/`PATCH`/`DELETE /api/dub/<id>`,
  `POST /api/dub/<id>/voice`): up to 50, in the account project store, deleted with the account. Another account's dub,
  or the owner's, reads as not found (404), and the owner's list never shows an account's. A dub (one shot on its own
  key, or step by step) and the voice of each language run the same way as Genjutsu's: every step on its own ComfyUI
  or key, with only its own video. Its translations run on its own GPU (Qwen3.5 4B, `oss-qwen35-translate`), never on
  the studio's AI helper, on either engine: a cloud step-by-step dub with a key and no GPU is asked to connect one. Its
  reviewed lines are saved with its dub, and its dubbed videos are its own runs, to open and download. A guest gets the
  sign-up card.
- **Faceless Studio, the Explainer and Content Factory.** An account's channels (`/api/faceless/channels/**`), their
  episodes (`/api/faceless/episodes/**`), its explainers (`/api/explainer`) and its series
  (`/api/content-factory/series/**`) are its own (`src/server/account-projects.ts` kinds `faceless`, `explainer` and
  `content-factory`; up to 50 of each, deleted with the account). Another account's, or the owner's, read as not found
  (404), and the owner's lists never show an account's. Its scripts, episode plans, channel names, topic ideas and
  document summaries are the offline writer's: never the studio's AI helper. A render, a retry, a timeline change, an
  upscale, a channel avatar, a narrator sample and a reference clip's reading run on its own ComfyUI or its own fal.ai or
  Replicate key, with only its own files, after the same checks as Genjutsu's (`src/server/account-tool-run.ts`); the
  whole render is planned and checked before its first step starts, and a series' episodes render as one run. Writing a
  script for review, a channel and a series made from a preset need no GPU or key. The server never fetches a link for
  it: a channel's YouTube reference is kept as the link, and an explainer's link source and a series' TikTok or
  Instagram link are the owner's (it attaches the file or uploads the clip). "Generate in Claude" (the studio's own MCP
  server) isn't offered to it (403 `own-gpu-tool`). "Regenerate to 1080p" runs on its own GPU only, one with 48 GB or
  more (`connect-gpu` otherwise). A guest gets the sign-up card.
- **Files a run takes.** A run on your GPU takes only files you uploaded here, or your own results.
  A link or a `data:` URI answers 400 with `code: "input-not-allowed"`, someone else's file 403
  (`input-not-yours`), and a file that has expired 404 (`input-gone`, "That file has expired.
  Upload it again."). A file bigger than an upload of its kind may be (one of your own results,
  too) answers 413 (`input-too-big`). The server never fetches a link for an account. The one
  exception is Fuobe's published example files ("Start from an example" on a page): a run may read
  them by their exact path, the same for everyone, from the server's own disk, with no upload and no
  space used. Nothing else outside your own files. A published example file is never removed or renamed.
- **LoRAs and model files.** The server never downloads anything onto your machine. A LoRA a run
  adds (a camera motion's, an effect's, a look's) must already be in your ComfyUI's `models/loras`
  folder. When one is missing, the run answers 409 with `code: "comfy_missing_model"` and a `fix`
  that lists each file, the folder it goes in and where to download it ("Your ComfyUI doesn't have
  2 LoRA files this needs. Download each one into ComfyUI/models/loras, keep the file name, then
  press Generate again."). The same check runs again when the run is handed to your ComfyUI. A
  checkpoint or encoder your ComfyUI lacks is named by ComfyUI's own answer.
- **Limits.** Up to 4 runs at once and 60 an hour; a run makes up to 4 results. A run waits up to
  30 minutes in your ComfyUI's queue and may run for 45. Your ComfyUI's answers have a deadline and
  a size cap (a result up to 1 GB in 15 minutes, and no more than your files have room for; 16
  results a job at most). Each account sends one file to its ComfyUI at a time, and the accounts
  take turns. The clip check (`POST /api/media/probe`) allows 60 a minute and 2 at once.
- **Disk space.** Accounts can't upload or run when the server's data disk is short of space
  (503): it keeps 20 GB free, or a tenth of a smaller disk, and at least 2 GB.
  `FUOBE_ACCOUNT_DISK_FREE_GB` sets another amount, and the server log says when accounts are
  refused for space.
- **What a visitor sees.** For a guest or an account, `GET /api/status` describes its own GPU
  (`viewer`), with the open engine and no Demo mode. It says nothing about the studio's own
  ComfyUI, providers, keys or local AI servers. The account menu (the top bar's right end; the You
  tab on a phone) shows **Your GPU · Connect** (a guest signs up first), or the account's ComfyUI as
  online or offline with its GPU and VRAM, then Settings and the light or dark switch. An
  account's menu also shows its email, Your GPU (`/connect`) and Sign out. Thanks & licences and
  the source on GitHub are in Settings → About, for guests and accounts too.
  `GET /api/models` lists the open-source models for a visitor, and the studios price a visitor's
  run as it would go on its own GPU. The studio's own settings page isn't shown to visitors.

### Set it up with my AI

An account can let its own AI (ChatGPT, Claude, or a coding agent such as Claude Code, Codex or
Gemini CLI) do the setup: **Set it up with my AI** on the Connect your GPU card, in Settings → Your
GPU and at `/connect?setup=ai`. A guest signs up first and comes back there. The panel picks the
way for the browser (this browser, or a web address on Safari, on a phone and on a page on plain
http), gives the AI a short message with two links (the steps and the status), and ticks off each
step as the account's open tab sees it. It ends with a first picture made on the account's GPU.

- **The code.** `POST /api/setup/session` (`{ way, os, phone?, fresh?, resume? }`) gives the
  account one setup code of 12 letters and digits, like `ABCD-EFGH-JKMN`. The same call again
  answers the same code. The code ends 30 minutes after the account's tab was last heard from (2
  hours at most), 10 minutes after the setup is done, when the account makes a new one (`fresh`),
  or at once with **End this code** (`DELETE /api/setup/session/<code>`). It also ends when the
  account is deleted or switched off. The codes live in the server's memory. After a restart, the
  account's tab brings its own code back with a resume token sealed for that account.
- **The tab.** The account's open tab reports what it sees
  (`POST /api/setup/session/<code>/report`, fixed values and whole numbers only, unknown keys answer
  400) and waits for its AI's reads (`GET /api/setup/session/<code>/wait`, 25 seconds at most). One
  tab leads a setup at a time. Another account's code answers 404.
- **The status.** Anyone with the code can read `GET /api/setup/<code>` without signing in: the
  steps, the port and the kind of install, and the next step, in fixed words (plain text, or JSON
  with `?format=json`). It never holds the email, a run, a key, an address, a token, a file name or
  the GPU's name. Reading it reaches only the server's memory: at most it asks the open tab to look
  at its own ComfyUI sooner, once every 3 seconds. Every code that is not active gets the same 404.
- **The steps.** `GET /api/setup/guide/<way>/<computer>` (the steps for the AI, with the studio's
  own address from a fixed list: fuobe.com, `FUOBE_ALLOWED_ORIGINS`, or an address on the local
  network), `GET /api/setup/files/fuobe_guard.py` and `GET /api/setup/files/start/<port>` (the
  Windows start file) are open to everyone. The steps tell the AI to show each command and wait for
  a yes, to use exactly `--enable-cors-header <the studio's address>`, never `--listen`, and to
  check Fuobe's files by their SHA-256.
- **Limits.** 6 new codes a minute and 20 an hour per account. 30 status reads a minute per code.
  Unknown codes: 10 per 10 minutes per visitor (behind a trusted proxy, `FUOBE_TRUST_PROXY=1`) and
  600 per 10 minutes for everyone together. All answer 429 with `Retry-After`.

The code is `src/server/ai-setup.ts`, `src/lib/ai-setup/`, `src/components/gpu/ai-setup/` and
`src/app/api/setup/`.

## Your keys

An account can add its own fal.ai key or Replicate token in **Settings → Your keys** (below Your
GPU), or from the "Add your key" card that opens when it picks a paid model it has no key for (a
search in a model picker lists them, dimmed, and a link to one keeps it, with a note), from the
locked engine switch, or from "No GPU?" on the welcome page and the Connect your GPU card. With
a key it runs that provider's paid models (Nano Banana, Seedream, Kling, Veo…), billed to its own
account with that provider. The studio's own keys are never used for an account's run.

- **Checked first.** `PUT /api/account/keys/fal` (or `/replicate`) with `{ key }` checks the key
  with the provider before it is saved: a free call that runs nothing (fal.ai: the status of a
  request that doesn't exist; Replicate: `GET /v1/account`). A refused key answers 422, a provider
  out of reach 503, and nothing is saved. A key that works on a provider account with no balance
  left is saved, with a `note` that says to top it up. `?test=1` only checks. Only a check that
  reaches the provider counts: 10 a minute per account, 20 per address (behind a trusted proxy),
  120 for all accounts together.
- **Stored encrypted.** The key is sealed with AES-256-GCM under a server key in
  `data/secrets.key`, made the first time a key is saved, and kept with the account in the
  database (`auth_account_keys`). The server key isn't derived from the sign-in secret, so a new password or "Sign
  everyone out" leaves saved keys working. Without `secrets.key` (lost, or restored from another
  server), saved keys can't be opened: accounts are asked to add them again, and the studio's keys
  are never used instead.
- **Never shown.** `GET /api/account/keys` gives each key's last 4 characters, when it was added,
  whether this server can still open it, and whether the provider refused it in a run. No answer,
  log or error holds a key: a provider's error that echoes the request has it replaced with "••••".
  The owner's **Settings → Accounts** shows which providers an account has a key for (the CSV has
  `fal_key` and `replicate_key`), never the key.
- **Removed with the account.** Deleting an account (by itself or by the owner) switches it off,
  stops its running jobs at the provider with its own key, then removes its runs, files and record,
  keys included. Removing or replacing a key that runs are going on answers 409 `runs-going` first;
  with `{ stopRuns: true }` those runs are stopped with the old key before it changes. A run still
  being handed to the provider is stopped there when its submit lands: the key (or the deleted
  account's record) waits for that, up to a minute. On an install upgraded from `auth.json`, the
  backup `auth.json.migrated-<time>` still holds the accounts as they were at the upgrade, sealed
  keys included: delete it once the upgrade is confirmed ([Sign-in data](SELF-HOSTING.md#sign-in-data)).
- **What it changes in the studios.** `GET /api/status` lists the account's keys
  (`viewer.keys`) and its engine mode: `both` while it has a key and the studio isn't open-source
  only, else `open`. The model pickers dim the paid models it has no key for ("Add your Replicate
  key"), and prices say who pays ("≈ $0.15 · your fal.ai account"). A paid run without the key
  answers 403 with `code: "add-key"` and an `x-fuobe-add-key` header naming the provider.
- **Limits.** Every account limit applies to paid runs too (4 at once, 60 an hour, 4 outputs a run,
  its space), checked before anything reaches the provider. Runs with a key send the prompt and the
  attached files to that provider. civitai LoRAs are left out of runs on an account's key (copying
  them would use the studio's civitai key). Image to 3D runs on its key too; Assist, text steps and the other tools stay closed.
- An account on a studio set to **Open source only** keeps its keys, but they aren't used.

## When your GPU or key has a problem

An account's GPU can be off, starting up, or behind a password. Its key can be refused, or its
provider can be busy. In each case the account sees one plain sentence that says what is wrong
and what to do, a small details line for the curious (the address, the status and the reason), and
buttons that help. `src/lib/diagnose.ts` reads every failure the same way, for Settings, the
composer and a failed run. The owner's own runs, and runs on this studio's GPUs (hosted runs),
keep their words as before.

- **Settings → Your GPU.** Test and Connect say what is wrong with the address: a RunPod pod that is
  stopped ("Your RunPod pod isn't running, or ComfyUI isn't on port 8188", with **Start your pod**,
  a link to RunPod's pods page), a GPU starting up, no answer, a password that is missing or wrong,
  a sign-in page in front, or another app on that address. `PUT /api/account/gpu` answers 422 with
  `error` (the sentence) and `trouble` (`cause`, `details`, `actions`, `retryable`). An address
  pasted without `https://` gets it added, and a `?…` or `#…` part is left out; the answer's `note`
  says so. A GPU that is off or starting up is checked again by itself (5, 10, 20, 30 seconds, for 3
  to 5 minutes), and **Save anyway** (`{ "anyway": true }`) keeps its address: runs wait for it. Too
  many checks (429) count down and check again by themselves. The saved address's card says
  **Offline** with the reason, and **Check now** (`{ "saved": true }`) asks it again.
- **Before Run.** When the account's GPU didn't answer its last status check, the composer shows
  the reason and its buttons above Generate. It reads the status the strip already has (every 30
  seconds), so the GPU is never asked more often. When one of the account's keys runs the tool's
  cloud version (a preset's cloud route, or a Fuobe Original on the cloud engine), **Run with your
  fal.ai key** switches to Cloud and runs it there, billed to that key. A run started anyway waits.
  The account menu says why the GPU is offline: "pod stopped", "starting up", "needs a password".
- **A run that waits.** A run whose GPU is off, starting up or out of reach waits and tries again by
  itself, with a growing wait (up to a minute between tries). Its tile says what it waits for
  ("Waiting for your RunPod pod to start", "Waiting for your GPU to start up"). A GPU that is off
  waits up to 30 minutes, one starting up 10 minutes. Before the run fails, the GPU is asked once
  more. A run whose account saves another address while it waits stops and says so. A provider
  that is busy (429) or down (503) at submit is tried again for 1 to 3 minutes; a 502 or 504 at
  submit is not, because the job may have started. Waiting never retries what it can't fix: a
  refused key, an empty balance, a missing add-on or file, or an input the model refuses. A 403
  that isn't about the key (a model the key may not run) says to pick another model; the key
  stays as it is.
- **A paired ComfyUI.** A run for a ComfyUI paired with a code (Fuobe Connect) that is off says
  "Waiting for your paired ComfyUI. Start ComfyUI there (or start your pod), and this run goes on
  by itself." It doesn't ask for a Fuobe tab, because a paired ComfyUI needs none.
- **While it runs.** A GPU or provider that stops answering mid-run is asked again with a growing
  wait, and after 3 misses the tile says "Your GPU stopped answering. Waiting for it to come back".
  It stops after 15 minutes (10 for a key's provider) in plain words. A key refused or a balance
  gone while a run is polled fails it at once, and the job is stopped there. A ComfyUI that
  restarted and lost a run gets it sent once more. A run whose account moved to another address
  says so. A result that can't be copied is tried 3 times first. A graph that needs a second
  ComfyUI (ThinkSound, LatentSync 1.6) is refused before anything is sent.
- **A failed run.** The tile shows the sentence, the details line, and up to three buttons: **Start
  your pod**, **Check my GPU** (the Test above, on the saved address), **Open Settings → Your GPU**
  or **Your keys** (**Replace key**), **Add credit on fal.ai** (or Replicate), **Run with your
  Replicate key** when the other key runs the same model, and **Retry**. The Library's card shows
  the same sentence with up to two of them. The run keeps them in `trouble`
  (`GET /api/generations/<id>`), next to `fix` for **Fix it**.

## Hosted runs

By default an account runs only on its own GPU or its own key. An owner who wants accounts to run on the studio's own
ComfyUI instead sets `FUOBE_HOSTED_RUNS=1`. It is off unless set, and with it off nothing below changes.

With it on:

- An account with no GPU of its own can run in the studios (generations, camera motions, effects, apps). The run goes
  to this install's ComfyUI server (the address in Settings). An install whose ComfyUI runs on the owner's computer
  doesn't offer hosted runs.
- An account whose own GPU is online runs there by default. The composer shows where a run goes ("Your GPU" or "This
  studio's GPUs"), and the person can pick either.
- Every other tool still needs the account's own GPU ("This tool doesn't run on your own GPU yet" stays as it is).
  Image to 3D, extra LoRAs added to a request, and clips and sound as inputs stay on the account's own GPU.
- A choice that needs an NVIDIA RTX card (RTX Video's upscale, frame generation and HDR) doesn't go to the studio's
  GPUs when their last GPU check says the card can't run it, or that their ComfyUI lacks the RTX Video nodes. The run
  goes to the account's own GPU when it has one, or answers 403 `not-offered` ("This one needs an NVIDIA RTX card, and
  this studio's GPUs can't run it right now…").
- When a billing service names the models that may run on the studio's GPUs, that applies to every model a run uses,
  not only its main one.
- An account can upload pictures for these runs. Clips and sound still need its own GPU or key.
- A new account goes back to where it was after sign-up, not to "Connect your GPU". Connecting a GPU stays in
  Settings → Your GPU and at `/connect`; the account menu says "Your GPU · Optional".
- A run waiting for the studio's GPUs shows its place in line ("In line · 3rd · about 40 s"). A run may wait
  `FUOBE_POOL_WAIT_MIN` minutes (30 by default); past that it fails.
- The account's usual limits apply: runs at once, runs per hour, outputs per run, and its space.

Two optional services can go with it:

- a **billing service** ([billing-hook.md](billing-hook.md)): prices runs on this install's GPUs, sets the price aside
  before a run starts, and shows the person a balance. Without one, these runs are free.
- a **moderation service** ([moderation-hook.md](moderation-hook.md)): checks a run before it starts and, when it asks
  to, its outputs before they show. Without one, nothing is checked.

The code is `src/server/hosted.ts` (the switch, the place, the line), `src/server/hosted-run.ts` (the run route's side),
`src/server/run-stamp.ts` (what every row of a run carries) and `src/lib/hosted.ts` (the browser's side). The tests are
`tests/hosted-runs.test.ts`, `tests/billing-hook.test.ts`, `tests/billing-release.test.ts` and
`tests/moderation-hook.test.ts`.

## Uploads

An account with its own ComfyUI connected, or its own key, can upload files (`POST /api/uploads`,
the file as the request body with its type in `Content-Type` and its name in `X-File-Name`; an
older page's multipart form works up to 26 MB). With neither it answers 403 with
`code: "connect-gpu"`, and a guest gets 401 with the sign-up card. The one exception is a result
rendered in the page (sent with `x-fuobe-kinetic: 1`: a Kinetic Motion clip and its poster, a colour
grade, a Relight blend): any account may upload its MP4 or WebM clip or its PNG picture, within the
same space, size and upload limits below. Any other type
sent that way answers 403 `connect-gpu`, and a model run still needs the account's own GPU or key.

| What | Types | Largest |
|---|---|---|
| Pictures | PNG, JPEG, WebP | 25 MB and 40 megapixels |
| Sound | MP3, WAV, OGG, FLAC, M4A, WebM | 50 MB |
| Clips | MP4, MOV, WebM, MKV, AVI | 95 MB (ComfyUI takes up to 100 MB unless started with more) |

- The type is read from the file's first bytes. A file that isn't one of these answers 415.
- `Content-Length` is required (411), and a file over its size answers 413 before it is read.
- An account keeps up to 1 GB of uploads and 3 GB of files in all (uploads and results); in its
  first 7 days, 1 GB in all. Past that, uploads and runs answer 413: delete some runs to make room.
- All accounts together keep at most a quarter of the data disk (`FUOBE_ACCOUNTS_DISK_GB` sets
  it), and the disk always keeps its free floor (`FUOBE_ACCOUNT_DISK_FREE_GB`). Past either,
  account uploads and runs answer 503 "short of space"; the owner's work is not affected.
- Up to 60 uploads an hour, 300 a day and 2 at once (429 with `Retry-After`). An upload sent as a
  form (older pages, held in memory) also waits for a place among 8 from every account together.
  An upload ends with 408 when nothing arrives for a minute, or when it takes over 30 minutes.
  One address (one network) makes at most 20 accounts a day.
- **How long files stay.** Uploads are removed after 14 days, even when a run still uses them.
  Runs and their results are removed after 30 days. Everything goes at once when the account is
  deleted.

`GET /api/auth/me` (open to everyone) says who is looking: `{ signedIn, owner, publicSignup,
account? }`.

The rules are in `src/lib/guest-access.ts` (which paths guests and accounts may use) and
`src/proxy.ts` (where they are applied). Your GPU is `src/server/account-gpu.ts`, `onOwnGpu` in
`src/server/providers/comfyui.ts` and `accountRun` in `src/server/generations.ts`; what an account's
work may read is `src/server/tenant.ts`. Your keys are `src/server/account-keys.ts` (storage),
`src/server/secret-box.ts` (encryption), `src/server/provider-keys.ts` (`cloudKey`, the one place a
fal.ai or Replicate key is read) and `src/app/api/account/keys`; their tests are the
`tests/account-keys*.test.ts` files, `tests/secret-box.test.ts`, `tests/byo-keys-static.test.ts` and
`tests/e2e/byo-keys.mjs` (against stand-in providers). Uploads are `src/app/api/uploads/route.ts` (which makes the
proxy's checks itself, `src/server/direct-gate.ts`), the limits are in `src/server/account-files.ts`
and the clean-up in `src/server/account-sweep.ts`. The owner's view of what accounts make is
`src/server/account-admin.ts`. The tests are in `tests/public-signup.test.ts`,
`tests/accounts-admin.test.ts`, `tests/account-runs-admin.test.ts`, `tests/account-gpu.test.ts` and
the `tests/account-*.test.ts` files.
