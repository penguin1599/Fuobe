// What the report and the review page share: escaping, and one small stylesheet with light and dark
// tokens (Fuobe's neutral palette), sized so nothing scrolls sideways on a 390 px phone.

export const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** A relative URL for a path inside the run folder (each segment encoded). */
export const href = (rel) => String(rel).split(/[\\/]/).map(encodeURIComponent).join("/");

export const BASE_CSS = `
:root {
  --bg: #ffffff; --fg: #18181b; --muted: #71717a; --card: #fafafa; --border: #e4e4e7;
  --accent: #4f46e5; --accent-fg: #ffffff; --good: #15803d; --bad: #b91c1c; --chip: #f4f4f5;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --card: #18181b; --border: #27272a;
    --accent: #818cf8; --accent-fg: #09090b; --good: #4ade80; --bad: #f87171; --chip: #27272a;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #09090b; --fg: #fafafa; --muted: #a1a1aa; --card: #18181b; --border: #27272a;
  --accent: #818cf8; --accent-fg: #09090b; --good: #4ade80; --bad: #f87171; --chip: #27272a;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
main { max-width: 1200px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; line-height: 1.25; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 16px; margin: 32px 0 12px; }
h3 { font-size: 14px; margin: 0 0 8px; }
p { margin: 0 0 8px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.chip { display: inline-flex; gap: 4px; align-items: center; padding: 2px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; white-space: nowrap; }
.chip.good, .good-text { color: var(--good); } .chip.bad, .bad-text { color: var(--bad); }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 12px; min-width: 0; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr)); }
.media { width: 100%; aspect-ratio: 1; object-fit: contain; background: var(--chip); border-radius: 8px; display: block; }
.stems { display: grid; gap: 6px; }
.stem { display: grid; gap: 2px; font-size: 12px; }
.stem audio, .side audio { width: 100%; min-width: 0; display: block; }
.facts { display: grid; gap: 8px 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr)); margin: 12px 0; }
@media (max-width: 480px) { .facts { grid-template-columns: 1fr 1fr; } }
.facts div { min-width: 0; } .facts b { display: block; font-size: 12px; color: var(--muted); font-weight: 500; }
.btn { appearance: none; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 8px; padding: 8px 12px; font: inherit; cursor: pointer; }
.btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.btn:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
kbd { font: 12px ui-monospace, monospace; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--card); }
.stats { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); }
.stat { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; border-bottom: 1px solid var(--border); padding: 4px 0; }
.stat span:last-child { font-variant-numeric: tabular-nums; text-align: right; }
`;

/** The theme switch: follows the system until you pick, remembered per browser. */
export const THEME_SCRIPT = `
(() => {
  const root = document.documentElement;
  try { const t = localStorage.getItem("fuobe-eval-theme"); if (t) root.dataset.theme = t; } catch {}
  window.toggleTheme = () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("fuobe-eval-theme", root.dataset.theme); } catch {}
  };
})();
`;

export const page = ({ title, body, head = "", script = "" }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}${head}</style>
<script>${THEME_SCRIPT}</script>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ""}
</body>
</html>
`;
