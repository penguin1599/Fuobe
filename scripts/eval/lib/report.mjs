// A run's report: summary.json (what ran, means per variant, how variants of the same case compare,
// blind ratings, failures), report.html (a contact sheet: every case × variant with its scores), and
// the run's lines in results/history.jsonl (one per case and variant).
import fs from "node:fs";
import path from "node:path";
import { esc, href, page } from "./html.mjs";
import { fmt, gain, METRIC_INFO, METRIC_ORDER, verdict } from "./metric-info.mjs";
import { aggregateRatings } from "./review.mjs";
import { money } from "./run.mjs";
import { candidateOf, latestJobs, readJson, writeHistory, writeJson } from "./store.mjs";

const mean = (xs) => {
  const v = xs.filter((x) => typeof x === "number" && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** A run folder's files: run.json, the latest row per job, metrics.json, the review's ratings and key. */
export function loadRun(dir) {
  const run = readJson(path.join(dir, "run.json"));
  if (!run) throw new Error(`${dir} isn't a run folder (no run.json)`);
  return {
    dir,
    run,
    rows: latestJobs(dir),
    metrics: readJson(path.join(dir, "metrics.json"), null),
    ratings: readJson(path.join(dir, "review", "ratings.json"), null),
    key: readJson(path.join(dir, "review", "key.json"), null),
  };
}

/** One job's numbers: the Python metrics plus time, cost and memory from the runner. */
export function jobScores(row, metricsDoc) {
  const m = metricsDoc?.jobs?.[row.id] ?? {};
  const out = {};
  for (const [k, v] of Object.entries(m)) if (!k.startsWith("_") && typeof v === "number") out[k] = v;
  const ms = row.comfy?.execMs ?? row.timing?.serverMs ?? row.timing?.wallMs;
  if (row.status === "succeeded" && ms != null) out.seconds = Math.round(ms / 100) / 10;
  const cost = row.costUsd?.actual ?? row.costUsd?.estimate;
  if (row.status === "succeeded" && cost != null) out.costUsd = cost;
  // On a CPU ComfyUI the device's memory is the whole machine's RAM: kept in the row, not scored as VRAM.
  const vram = row.vram?.type === "cpu" ? null : (row.vram?.torchPeakGb ?? row.vram?.peakUsedGb);
  if (vram != null) out.vramGb = vram;
  return out;
}

/** Continuity and other group scores land on every job of the group. */
function groupScores(metricsDoc) {
  const byJob = new Map();
  for (const g of Object.values(metricsDoc?.groups ?? {})) for (const id of g.jobs ?? []) byJob.set(id, { continuity: g.continuity });
  return byJob;
}

const recipeLine = (r) => {
  if (!r) return null;
  const loras = (r.applied ?? r.sent?.loras ?? []).map((l) => `${l.file.replace(/\.safetensors$/, "")}@${l.strength ?? 1}`);
  return [r.look?.name ?? (r.presets ?? []).join(" / "), loras.length ? loras.join(" + ") : "no LoRAs", r.complete === false || r.sent?.complete === false ? "incomplete" : null].filter(Boolean).join(" · ");
};

/** Everything the report says, as data. */
export function summarize(loaded) {
  const { run, rows, metrics } = loaded;
  const groups = groupScores(metrics);
  const scored = rows.map((r) => ({ row: r, scores: { ...jobScores(r, metrics), ...(groups.get(r.id) ?? {}) } }));
  const variants = run.variants?.length ? run.variants : [...new Set(rows.map((r) => r.variant))];
  const keysOf = (list) => [...new Set(list.flatMap((x) => Object.keys(x.scores)))].filter((k) => METRIC_INFO[k]).sort((a, b) => METRIC_ORDER.indexOf(a) - METRIC_ORDER.indexOf(b));
  const metricKeys = keysOf(scored);

  const perVariant = {};
  for (const v of variants) {
    const mine = scored.filter((x) => x.row.variant === v);
    const ok = mine.filter((x) => x.row.status === "succeeded");
    perVariant[v] = {
      description: run.variantInfo?.[v] ?? "",
      jobs: mine.length,
      succeeded: ok.length,
      failed: mine.filter((x) => ["failed", "timeout", "canceled", "interrupted"].includes(x.row.status)).length,
      skipped: mine.filter((x) => x.row.status === "skipped").length,
      mean: Object.fromEntries(metricKeys.map((k) => [k, mean(ok.map((x) => x.scores[k]))]).filter(([, v2]) => v2 != null)),
      n: Object.fromEntries(metricKeys.map((k) => [k, ok.filter((x) => typeof x.scores[k] === "number").length])),
      costUsd: ok.reduce((a, x) => a + (x.scores.costUsd ?? 0), 0),
      models: [...new Set(ok.map((x) => x.row.model?.id).filter(Boolean))],
    };
  }

  // Variants of the same job key (case/prompt/seed), each against the run's candidate (the recipe under test).
  const base = candidateOf(run, variants);
  const byKey = new Map();
  for (const x of scored) if (x.row.status === "succeeded") byKey.set(`${x.row.key}|${x.row.variant}`, x);
  const pairs = variants.filter((v) => v !== base).map((other) => {
    const res = {};
    for (const k of metricKeys) {
      const s = { wins: 0, losses: 0, ties: 0, gains: [] };
      for (const x of scored.filter((y) => y.row.variant === base && y.row.status === "succeeded")) {
        const y = byKey.get(`${x.row.key}|${other}`);
        if (!y) continue;
        const v = verdict(k, y.scores[k], x.scores[k]);
        if (!v) continue;
        s[v === "win" ? "wins" : v === "loss" ? "losses" : "ties"]++;
        s.gains.push(gain(k, y.scores[k], x.scores[k]));
      }
      if (s.wins + s.losses + s.ties) res[k] = { wins: s.wins, losses: s.losses, ties: s.ties, meanGain: mean(s.gains) };
    }
    return { base, other, metrics: res };
  });

  // Cases with each variant's jobs, for the contact sheet and history.
  const cases = [];
  for (const caseId of [...new Set(rows.map((r) => r.caseId))]) {
    const mine = scored.filter((x) => x.row.caseId === caseId);
    const entry = { caseId, title: mine[0].row.caseTitle, variants: {} };
    for (const v of variants) {
      const jobs = mine.filter((x) => x.row.variant === v);
      if (!jobs.length) continue;
      const ok = jobs.filter((x) => x.row.status === "succeeded");
      entry.variants[v] = {
        mean: Object.fromEntries(metricKeys.map((k) => [k, mean(ok.map((x) => x.scores[k]))]).filter(([, val]) => val != null)),
        succeeded: ok.length,
        jobs: jobs.length,
        model: ok[0]?.row.model?.id ?? jobs[0].row.model?.id,
        recipe: recipeLine(ok[0]?.row.recipe ?? jobs[0].row.recipe),
        recipeComplete: jobs.every((x) => x.row.recipe?.complete !== false && x.row.recipe?.sent?.complete !== false),
        items: jobs.map((x) => ({
          id: x.row.id,
          promptId: x.row.promptId,
          seed: x.row.seed,
          status: x.row.status,
          error: x.row.error ?? x.row.skip ?? null,
          outputs: (x.row.outputs ?? []).filter((o) => o.kind === "image" || o.kind === "video" || o.kind === "audio").map((o) => ({ file: o.file, kind: o.kind, ...(o.stem && { stem: o.stem }) })),
          scores: x.scores,
          notes: [...(x.row.notes ?? []), ...(metrics?.jobs?.[x.row.id]?._notes ?? [])],
        })),
      };
    }
    cases.push(entry);
  }

  const ok = rows.filter((r) => r.status === "succeeded");
  return {
    runId: run.runId,
    suite: run.suite,
    title: run.title,
    original: run.original,
    engine: run.engine,
    label: run.label,
    server: run.server,
    comfy: run.comfy,
    harness: run.harness,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    counts: {
      jobs: rows.length,
      succeeded: ok.length,
      failed: rows.filter((r) => ["failed", "timeout", "canceled", "interrupted"].includes(r.status)).length,
      skipped: rows.filter((r) => r.status === "skipped").length,
    },
    // Spent: every attempt that reached the server and any training, as the runner counted it against the cap.
    costUsd: { estimate: run.estimateUsd ?? null, spent: run.spentUsd ?? ok.reduce((a, r) => a + (r.costUsd?.actual ?? r.costUsd?.estimate ?? 0), 0), ...(run.trainingUsd && { training: run.trainingUsd }) },
    metrics: { keys: metricKeys, models: metrics?.models ?? {}, skipped: metrics?.skipped ?? (metrics ? {} : { all: "not scored yet: pnpm eval:report runs the metrics" }), device: metrics?.device ?? null },
    variants: perVariant,
    pairs,
    candidate: base,
    ratings: aggregateRatings(loaded),
    cases,
    failures: rows.filter((r) => r.status !== "succeeded" && r.status !== "skipped").map((r) => ({ id: r.id, status: r.status, error: r.error })),
    skips: Object.entries(rows.filter((r) => r.status === "skipped").reduce((acc, r) => ({ ...acc, [r.skip]: (acc[r.skip] ?? 0) + 1 }), {})).map(([reason, count]) => ({ reason, count })),
  };
}

/** One history line per case and variant (means over its prompts and seeds). */
export function historyRows(summary) {
  return summary.cases.flatMap((c) =>
    Object.entries(c.variants).map(([variant, v]) => ({
      runId: summary.runId,
      at: summary.startedAt,
      suite: summary.suite,
      engine: summary.engine,
      caseId: c.caseId,
      variant,
      model: v.model,
      recipe: v.recipe,
      recipeComplete: v.recipeComplete,
      succeeded: v.succeeded,
      jobs: v.jobs,
      scores: v.mean,
    })),
  );
}

const when = (t) => (t ? new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "–");

function chips(scores, keys) {
  return keys
    .filter((k) => scores[k] != null)
    .map((k) => `<span class="chip" title="${esc(METRIC_INFO[k].label)} (${esc(METRIC_INFO[k].unit)}${METRIC_INFO[k].better === "none" ? "" : `, ${METRIC_INFO[k].better} is better`})">${esc(k)} ${k === "costUsd" ? esc(money(scores[k])) : esc(fmt(k, scores[k]))}</span>`)
    .join(" ");
}

/** The contact sheet. */
export function reportHtml(summary) {
  const free = summary.engine !== "cloud";
  // Cost is in each card's first line; per metric it only matters on the cloud.
  const keys = summary.metrics.keys.filter((k) => !(free && k === "costUsd"));
  const variantCards = Object.entries(summary.variants)
    .map(([v, s]) => {
      const lines = keys.filter((k) => s.mean[k] != null).map((k) => `<div class="stat"><span>${esc(METRIC_INFO[k].label)}</span><span>${k === "costUsd" ? esc(money(s.mean[k])) : esc(fmt(k, s.mean[k]))} <span class="muted">n=${s.n[k]}</span></span></div>`);
      return `<div class="card"><h3>${esc(v)}</h3><p class="muted">${esc(s.description)}</p><p>${s.succeeded}/${s.jobs} done${s.failed ? ` · <span class="chip bad">${s.failed} failed</span>` : ""}${s.skipped ? ` · ${s.skipped} skipped` : ""} · ${free ? "Free" : esc(money(s.costUsd))}</p>${s.models.length ? `<p class="muted">${esc(s.models.join(", "))}</p>` : ""}${lines.join("")}</div>`;
    })
    .join("");
  const pairCards = summary.pairs
    .filter((p) => Object.keys(p.metrics).length)
    .map(
      (p) =>
        `<div class="card"><h3>${esc(p.base)} against ${esc(p.other)}</h3><p class="muted" style="font-size:12px">How often ${esc(p.base)} is better, worse or the same on the same case, prompt and seed</p>${Object.entries(p.metrics)
          .filter(([k]) => keys.includes(k))
          .map(([k, s]) => `<div class="stat"><span>${esc(METRIC_INFO[k].label)}</span><span><span class="good-text">${s.wins} better</span> · <span class="bad-text">${s.losses} worse</span> · ${s.ties} same</span></div>`)
          .join("")}</div>`,
    )
    .join("");
  const ratings = summary.ratings?.pairs?.length
    ? `<h2>Blind review</h2><div class="stats">${summary.ratings.pairs
        .map((r) => `<div class="card"><h3>${esc(r.a)} vs ${esc(r.b)}</h3><p>${esc(r.a)} preferred ${r.aWins}, ${esc(r.b)} ${r.bWins}, same ${r.ties} · ${r.preferA == null ? "–" : `${Math.round(r.preferA * 100)}% for ${esc(r.a)}`}</p></div>`)
        .join("")}</div>`
    : "";
  const caseBlocks = summary.cases
    .map((c) => {
      const cols = Object.entries(c.variants)
        .map(([v, s]) => {
          const tiles = s.items
            .map((it) => {
              // Audio results (a separation's stems): one player per stem, named.
              const sounds = it.outputs.filter((o) => o.kind === "audio");
              const media = sounds.length
                ? `<div class="stems">${sounds.map((o, i) => `<label class="stem"><span class="muted">${esc(o.stem ?? `audio ${i + 1}`)}</span><audio src="${href(o.file)}" preload="none" controls></audio></label>`).join("")}</div>`
                : it.outputs[0]
                ? it.outputs[0].kind === "video"
                  ? `<video class="media" src="${href(it.outputs[0].file)}" muted loop playsinline preload="metadata" controls></video>`
                  : `<img class="media" src="${href(it.outputs[0].file)}" alt="${esc(`${c.title}, ${v}, ${it.promptId}`)}" loading="lazy">`
                : `<div class="media row" style="justify-content:center"><span class="chip ${it.status === "skipped" ? "" : "bad"}">${esc(it.status)}</span></div>`;
              return `<figure style="margin:0">${media}<figcaption class="muted" style="font-size:12px;margin-top:4px">${esc(it.promptId)} · seed ${esc(it.seed)}${it.error ? ` · ${esc(it.error)}` : ""}</figcaption><div class="row" style="margin-top:4px">${chips(it.scores, keys)}</div></figure>`;
            })
            .join("");
          return `<div class="card"><h3>${esc(v)}${s.recipeComplete ? "" : ' <span class="chip bad" title="Some of the recipe\'s LoRAs were left out on this engine">recipe incomplete</span>'}</h3>${s.recipe ? `<p class="muted" style="font-size:12px">${esc(s.recipe)}</p>` : ""}<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(min(100%,${s.items.some((it) => it.outputs.some((o) => o.kind === "audio")) ? 240 : 140}px),1fr))">${tiles}</div></div>`;
        })
        .join("");
      return `<section><h2 id="${esc(c.caseId)}">${esc(c.title)} <span class="muted" style="font-weight:400">${esc(c.caseId)}</span></h2><div class="grid">${cols}</div></section>`;
    })
    .join("");
  const skipped = Object.entries(summary.metrics.skipped ?? {});
  const models = Object.entries(summary.metrics.models ?? {});
  const body = `<main>
<div class="row" style="justify-content:space-between"><h1>${esc(summary.title)}</h1><button class="btn" type="button" onclick="toggleTheme()">Light / dark</button></div>
<p class="muted">${esc(summary.runId)}${summary.label ? ` · ${esc(summary.label)}` : ""}</p>
<div class="facts">
<div><b>Engine</b>${esc(summary.engine)}${summary.engine === "demo" ? " (demo media, not model output)" : ""}</div>
<div><b>Server</b>${esc(summary.server?.url)}</div>
<div><b>Jobs</b>${summary.counts.succeeded} done · ${summary.counts.failed} failed · ${summary.counts.skipped} skipped</div>
<div><b>Cost</b>${free ? "Free" : `${esc(money(summary.costUsd.spent))} (estimated ${esc(money(summary.costUsd.estimate))})`}</div>
<div><b>Started</b>${esc(when(summary.startedAt))}</div>
<div><b>Harness</b>${esc(summary.harness?.commit ?? "–")} · recipes ${esc(summary.harness?.recipes?.sha ?? "–")}</div>
${summary.comfy ? `<div><b>ComfyUI</b>${esc(summary.comfy.version ?? (summary.comfy.unreachable ? "not reachable" : "–"))} ${esc((summary.comfy.devices ?? []).map((d) => `${d.name} ${d.vramTotalGb} GB`).join(", "))}</div>` : ""}
</div>
${skipped.length ? `<p class="muted">Not scored: ${skipped.map(([k, v]) => `${esc(k)} (${esc(v)})`).join("; ")}</p>` : ""}
${summary.skips.length ? `<p class="muted">Skipped jobs: ${summary.skips.map((s) => `${s.count} × ${esc(s.reason)}`).join("; ")}</p>` : ""}
<h2>Variants</h2><div class="stats">${variantCards}</div>
${pairCards ? `<h2>Variant against variant</h2><div class="stats">${pairCards}</div>` : ""}
${ratings}
<h2>Cases</h2>
${caseBlocks}
${models.length ? `<h2>Metric models</h2><div class="stats">${models.map(([k, m]) => `<div class="card"><h3>${esc(k)}</h3><p class="muted">${esc(JSON.stringify(m))}</p></div>`).join("")}</div>` : ""}
</main>`;
  return page({ title: `${summary.title} · ${summary.runId}`, body });
}

/** Write summary.json, report.html and the run's history lines; returns the summary. */
export function writeReport(dir, root) {
  const loaded = loadRun(dir);
  const summary = summarize(loaded);
  writeJson(path.join(dir, "summary.json"), summary);
  fs.writeFileSync(path.join(dir, "report.html"), reportHtml(summary));
  writeHistory(root, summary.runId, historyRows(summary));
  return summary;
}
