# Fuobe Connect

A ComfyUI custom node pack. It lets [Fuobe](https://github.com/workingprototype/Fuobe) use your ComfyUI with one
install, the way ComfyUI's own page uses it at `http://127.0.0.1:8188`. You do not need a start flag, a second file or
a changed start file. It adds no nodes.

## Install

**ComfyUI-Manager:** open the Manager, choose **Custom Nodes Manager**, search for `Fuobe Connect`, press **Install**,
then press **Restart**.

**Git:** in a terminal, in ComfyUI's `custom_nodes` folder:

```
git clone https://github.com/workingprototype/ComfyUI-Fuobe-Connect
```

Then restart ComfyUI.

Then open Fuobe and choose **Connect your GPU**. Chrome and Edge ask once to let the page reach apps on this computer.
Press **Allow**. Fuobe finds ComfyUI and connects. If your browser can't reach this computer from a website (Safari,
phones, some other browsers), use pairing (below).

## What a trusted studio can do

**Direct mode (the default).** ComfyUI turns away requests from every other website. Fuobe Connect adds one exception:
the Fuobe studios you trust. By default these are `https://fuobe.com` and `https://www.fuobe.com`. A studio's address
must start with `https://` (`http://` only for a studio on this computer, such as `http://localhost:3000`).

A trusted studio reaches this ComfyUI only at `127.0.0.1`, `::1` or `localhost`. It never reaches it at a network
address (unless you allow that, below) or under another name that leads to this computer, such as `127.0.0.1.nip.io`.
Its page can:

- read ComfyUI's facts (`/system_stats`: version, GPU, memory, start options), its node list and the file lists of its
  model folders, with each folder's place on disk (every folder ComfyUI lists, except `custom_nodes` and `configs`). In
  the node list, the loaders show only Fuobe's own input files, not your file names;
- upload a run's input into the input folder, only under a name Fuobe gives (`fuobe_<id>.png` and similar), only as a
  picture, clip, sound, 3D scene, array (`.npy`, `.npz`) or subtitle file (`.srt`, `.vtt`). Never a settings or text
  file (`.json`, `.txt`, `.csv`) or a file of no known type. It can replace an earlier Fuobe input, never a file of
  yours;
- queue a workflow. Fuobe Connect checks every workflow here, in Python, before ComfyUI sees it:
  - every node type must be on the list this pack ships (`fuobe_connect/allowed_nodes.json`: the nodes Fuobe's own
    workflows use), or on your own list (below). A studio can't add to either list;
  - no text may name a place: an absolute path in any form (`/x`, `\x`, `//host/share`, `\\?\C:\x`, `C:\x`, or a
    drive with no slash such as `D:x`), a `..` step, a home folder (`~`, `~user`), an environment variable at the start
    (`$HOME/`, `%USERPROFILE%\`), a URL, a ComfyUI folder tag such as `name [output]`, or a key in JSON that names a
    file, a folder or an address (`"video_path": …`). Spaces and quotes in front don't hide one;
  - an input that a listed node reads as a file or a folder, or a name that it downloads, takes only the one value or
    form that Fuobe's own workflows use, written in the workflow itself and never worked out by another node. For
    example, the source paths of `MiniMaxH3SourceTimeline` must be empty, the subtitle file of
    `AILab_Qwen3ASRSubtitle` must be empty or under `fuobe/` in your output folder, the model of
    `DownloadAndLoadWav2VecModel` must be one of its two models, and the format of `VHS_VideoCombine` must be a plain
    name such as `video/h264-mp4`. `PATH_INPUTS` in `fuobe_connect/graph.py` lists every one;
  - every file loader must read a Fuobe input (`fuobe_<id>.<ext>`), never a file of yours;
  - a dropdown (a model name, a format, any list of choices) takes a link only where Fuobe's own workflows link one,
    because ComfyUI checks no value that reaches a dropdown through a link. A value written in the workflow is checked
    by ComfyUI against the dropdown's list, unless the node checks that input in its own way (a file loader, for
    example);
  - a link from an output that ComfyUI doesn't type-check (an "any" output such as `GetItemFromList`, `CreateList` or
    `VRAM_Debug`, a match-typed one such as `ComfySwitchNode`, or a dropdown-typed one) feeds only the inputs that
    Fuobe's own workflows feed from that node type. Inside ComfyUI, Fuobe Connect reads which outputs these are and
    which inputs are dropdowns from every node, your own listed ones too. The shipped list is in
    `fuobe_connect/allowed_nodes.json` (`loose` and `links`);
  - a link must name its node's output with a whole number from 0 (`["4", 0]`), the way Fuobe's own workflows and
    ComfyUI's page write it. ComfyUI also takes `true`, `false`, a number with a point (`0.0`) or `-1` as an output.
    Fuobe Connect sees each of these as a link, and refuses it;
  - `VHS_VideoCombine` puts its format's settings into ffmpeg's arguments, so each setting must be one plain word
    (`yuv420p`, `hq`), and it takes a link only for its pictures, sound, batch, VAE and frame rate;
  - the workflow may not give a node a JSON object (ComfyUI passes one on unchecked), except a 3D view's entries.

  A workflow that uses an installed node from the list can still do what that node does in ComfyUI's own folders: for
  example, save into your output folder, or keep a node pack's own cache. These checks follow what the listed nodes do
  at the versions Fuobe's workflows pin. A newer version of a node pack can read its inputs in a new way;
- see, follow, cancel, stop and remove only the prompts it queued (and a batch's later passes, which save under
  `fuobe/<id>`). A prompt becomes the studio's only after ComfyUI takes it. Fuobe Connect refuses a prompt whose id
  ComfyUI already has in its queue or its history, so a studio that learns the id of a prompt of yours can't take
  that prompt over. In the queue, your own prompts show only as places in the line. It can't clear the queue or stop
  your own work;
- download only the results that its own prompts' history lists;
- open ComfyUI's live socket only under a Fuobe client id (`fuobe-…`), never your own ComfyUI tab's. Note that
  ComfyUI itself sends the live messages of a prompt queued without a client id (many scripts and API tools queue
  that way) to every open socket, a studio's too: the prompt's id, its progress, its preview pictures, its errors and
  the names of the files it saves. The studio still can't download those files or control that prompt. A prompt
  queued from ComfyUI's own page carries that page's client id, and its messages go only to that page.

A trusted studio can't reach the Manager's install calls, your user files or your settings: Fuobe Connect turns away
every request of a trusted studio outside the list above itself, whatever ComfyUI's start options say. It can't read a
file of yours in the input folder or download a result of yours. Its workflows can't name a file of yours by its path:
text that names a place (an absolute path, a `..` step, a home folder, a URL) is refused, an input that a listed node
reads as a file takes only Fuobe's own form, and a value that another node works out can't reach such an input, a
dropdown or ffmpeg's arguments. Of ComfyUI's folder lists it can't read `custom_nodes` (every file of your node packs)
or `configs`. Every other website still meets ComfyUI's own check, unchanged. Nothing in ComfyUI's own files changes.

If ComfyUI runs with `--enable-cors-header` (an older Fuobe setup), ComfyUI's own check is off. Fuobe Connect then also
turns away every website except ComfyUI's own page, the site that the setting names and the trusted studios. This is
what Fuobe's guard file did, so you can delete `fuobe_guard.py` and the setting. A trusted studio gets only the checked
requests above even when the setting names it, so a trusted studio doesn't need the setting. With
`--enable-cors-header *` (every website) Fuobe Connect adds no check for other websites, but a trusted studio still
gets only the checked requests.

## Choose your studios, or none

Open ComfyUI's **Settings → Fuobe Connect** and enter the studios that may use this ComfyUI, separated by commas, for
example `https://studio.example.com`. Type `none` to let no website use this ComfyUI from the browser. Pairing still
works.

You can also set the environment variable `FUOBE_CONNECT_ORIGINS` before you start ComfyUI (`none` works there too).
When it is set, it wins over the setting, and ComfyUI shows a note about it.

**Your own node list.** If your studio uses a node type that isn't on the shipped list, add it to
`fuobe-connect-nodes.json` in ComfyUI's `user` folder: `{"nodes": ["MyNode"]}`. Only you can change this file. A
studio can't. Every check above applies to your nodes too: a workflow can't link from an output of theirs that
ComfyUI doesn't type-check, or into a dropdown of theirs.

**A network address.** A trusted studio reaches this ComfyUI only on this computer. To let it reach a ComfyUI that
runs with `--listen` at a network address, start ComfyUI with `FUOBE_CONNECT_LAN=1`. Its requests get the same checks
there.

**A name for ComfyUI's page.** Fuobe Connect's own window works when you open ComfyUI at `127.0.0.1`, `localhost` or
an IP address. If you open it by a name (for example `comfy.local`, or a domain in front of it), set
`FUOBE_CONNECT_HOSTS=comfy.local` before you start ComfyUI. This keeps a website that points its own name at your
computer out of the window's settings.

## Pairing (for Safari, phones and PCs with no screen)

In ComfyUI, open **Extensions → Connect to Fuobe**. You can give this computer a name. Press **Connect**. ComfyUI
shows a short code. Open the link on any device, sign in to Fuobe and approve the code. Approve only a code that you
see in your own ComfyUI. From then on, ComfyUI gets that one person's jobs from the studio over HTTPS, and it runs them
with no Fuobe tab open. It opens no port. The token belongs to you alone, so another person's jobs never reach your PC.

Pairing works only with a studio you trust, or with `https://fuobe.com`. Every job gets the same checks as in direct
mode, before it reaches ComfyUI. The job's inputs leave the input folder when the job is done.

The **Connect to Fuobe** window shows the studio, the account that approved the code (masked, for example
`a•••@example.com`, when the studio says), and the last jobs with their node types and times. Fuobe doesn't fill in
the code from a link: you type the code that your own ComfyUI shows, so a link that someone sends you can't connect
their ComfyUI to your account. **Pause jobs** stops this computer from taking new jobs. **Disconnect** tells
the studio to forget this computer first. If the studio can't be reached, Fuobe Connect keeps trying every minute, and
you can also remove the computer in Fuobe's settings.

On a PC with no screen, start ComfyUI with `FUOBE_CONNECT_PAIR=1`. The code and the link then appear in ComfyUI's
console. `FUOBE_CONNECT_SITE=https://studio.example.com` chooses the studio for that.

**What pairing sends to the studio.** When you press Connect: this computer's name (the one you typed, else its
network name), the GPU's name, its memory and ComfyUI's version. While paired, about every minute: the GPU's name and
memory, the computer's memory, the operating system, ComfyUI's version, whether ComfyUI is the portable build, and the
progress of a running job. Every five minutes: the file names in your `loras` folder (up to 20,000), so Fuobe can use
your LoRAs. To stop sending the LoRA names, start ComfyUI with `FUOBE_CONNECT_LORAS=0`. After a job: its results, and
for a failed job the error type and message, without the folders on this computer.

## Files

Fuobe Connect keeps one file, `fuobe-connect.json`, in ComfyUI's `user` folder. The file holds the studios that you
trust and, after pairing, the studio's address, the account and the token. Only your user account can read the file:
mode 0600 on Linux and macOS, and on Windows an access list with only your account. ComfyUI does not serve this file to
web pages.

## Tests

```
python -m unittest discover -s tests
```

The tests load ComfyUI's own origin check and run it behind Fuobe Connect over real HTTP on ports 3360, 3364, 3365
and 3366. Set `FUOBE_CONNECT_TEST_PORT` to move them (the tests use that port and the three after it, +4 to +6). Set
`COMFYUI_DIR` to a ComfyUI folder to read the middleware from that copy of ComfyUI. The tests need only `aiohttp`.
They do not need models, a GPU or a running ComfyUI. The `tests` folder is not part of the published pack.

## Licence

MIT
