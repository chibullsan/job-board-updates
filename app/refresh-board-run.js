/**
 * Board refresh: link checks + optional employer search (light / companies / deep).
 */
const fs = require("fs");
const https = require("https");
const path = require("path");

let LEADS_FILE = path.join(process.env.JB_DATA || __dirname, "leads.json");
const UA = "Mozilla/5.0";
const DEEP_BUDGET_MS = 10 * 60 * 1000;

/** Explicit remote only (not just "California USA"). */
const REMOTE_RE = /\bremote\b|work from home|work-from-home|fully remote|remote-friendly|anywhere in (the )?(u\.s\.|us|united states)|distributed team/i;
const DEFAULT_ON_SITE_RE = /on-?site|in-?office|headquarters|jobsites across|weekly travel|relocation required|must be located in/i;

// ---- Everything personal comes from the person's search-profile.json (in their data folder). ----
// These are filled in by applyProfile() at the start of every run.
let PROFILE_READY = false;
let HOME_RE = /$^/;                 // places that count as "local" (matches nothing until the profile says)
let ON_SITE_REJECT_RE = DEFAULT_ON_SITE_RE;
let TITLE_INCLUDE_RE = null;        // job titles worth adding to the board
let TITLE_EXCLUDE_RE = null;        // job titles never to add
let CANONICAL_WORKDAY = [];         // employers on Workday: { label, host, site, group, scope }
let QUERIES_COMPANIES = [];         // searches for the regular "company search"
let QUERIES_DEEP_FL = [];           // wider local searches for "deep search"
let QUERIES_DEEP_REMOTE = [];       // remote-friendly searches for "deep search"
let EXTRA_ASHBY_BOARDS = [];
let EXTRA_GREENHOUSE_BOARDS = [];
let EXTRA_LEVER_BOARDS = [];
let ASHBY_MANUAL_ONLY = new Set();  // boards never auto-added (manual / outreach only)
let MANUAL_LEAD_IDS = new Set();
let GROUP_LOCAL = "Local employers";
let GROUP_REMOTE = "Fully remote";
let GROUP_CONFLICT = "Conflicts";
let HOME_LABEL = "Local area";
let MAX_NEW = 40;                  // most roles one search may add (keeps the board from flooding)

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordsRe = (list) => (Array.isArray(list) && list.length ? new RegExp(list.map((x) => esc(String(x).trim())).filter(Boolean).join("|"), "i") : null);
const arr = (x) => (Array.isArray(x) ? x.filter(Boolean) : []);

function loadProfile(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "search-profile.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function applyProfile(p) {
  const prof = p || {};
  PROFILE_READY = !!(p && p.ready);
  HOME_RE = wordsRe(prof.home && prof.home.places) || /$^/;
  HOME_LABEL = (prof.home && prof.home.label) || "Local area";
  ON_SITE_REJECT_RE = wordsRe(prof.onSiteRejectWords) ? new RegExp(DEFAULT_ON_SITE_RE.source + "|" + wordsRe(prof.onSiteRejectWords).source, "i") : DEFAULT_ON_SITE_RE;
  TITLE_INCLUDE_RE = wordsRe(prof.titleKeywords);
  TITLE_EXCLUDE_RE = wordsRe(prof.titleExclude);
  CANONICAL_WORKDAY = arr(prof.sources && prof.sources.workday);
  EXTRA_ASHBY_BOARDS = arr(prof.sources && prof.sources.ashby);
  EXTRA_GREENHOUSE_BOARDS = arr(prof.sources && prof.sources.greenhouse);
  EXTRA_LEVER_BOARDS = arr(prof.sources && prof.sources.lever);
  ASHBY_MANUAL_ONLY = new Set(arr(prof.manualOnlyBoards));
  MANUAL_LEAD_IDS = new Set(arr(prof.manualLeadIds));
  QUERIES_COMPANIES = arr(prof.queries && prof.queries.companies);
  QUERIES_DEEP_FL = arr(prof.queries && prof.queries.deepLocal);
  QUERIES_DEEP_REMOTE = arr(prof.queries && prof.queries.deepRemote);
  const g = prof.groups || {};
  GROUP_LOCAL = g.local || "Local employers";
  GROUP_REMOTE = g.remote || "Fully remote";
  GROUP_CONFLICT = g.conflict || "Conflicts";
  MAX_NEW = Math.max(5, Number(prof.maxNewPerRun) || 40);
}

function fetchText(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: { "User-Agent": UA, Accept: "application/json, text/html, */*", ...(opts.headers || {}) },
        timeout: opts.timeout || 22000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(opts.body || undefined);
  });
}

function postJson(url, obj) {
  const body = JSON.stringify(obj);
  return fetchText(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
}

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function shortRole(s) {
  return String(s || "")
    .replace(/\s*\(Job ID[^)]*\)\s*$/i, "")
    .trim()
    .slice(0, 58);
}

async function checkUrl(l) {
  const url = (l.url || "").trim();
  if (!url || !/^https:/i.test(url)) return { id: l.id, skip: true, reason: "no-url" };
  try {
    const { status, body } = await fetchText(url);
    if (status >= 400) return { id: l.id, live: false, reason: `http-${status}` };
    if (/myworkdayjobs\.com/i.test(url)) {
      const m = body.match(/postingAvailable:\s*(true|false)/);
      if (m) return { id: l.id, live: m[1] === "true", reason: "workday" };
    }
    if (/ashbyhq\.com/i.test(url)) {
      if (/\"isListed\":true/.test(body)) return { id: l.id, live: true, reason: "ashby" };
      if (/\"isListed\":false/.test(body)) return { id: l.id, live: false, reason: "ashby" };
    }
    if (/dayforcehcm\.com/i.test(url)) {
      const m = body.match(/\"postingStatus\":(\d+)/);
      if (m) return { id: l.id, live: m[1] === "1", reason: "dayforce" };
    }
    if (/no longer accepting|posting is no longer|error=true/i.test(body)) return { id: l.id, live: false, reason: "text-closed" };
    return { id: l.id, live: null, reason: "unknown" };
  } catch (e) {
    return { id: l.id, live: null, reason: String(e.message || e) };
  }
}

async function poolMap(items, fn, concurrency = 6) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker));
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function workdayJobUrl(host, site, externalPath) {
  const ep = externalPath.startsWith("/") ? externalPath : `/job/${externalPath}`;
  if (ep.startsWith("/job/")) return `https://${host}/en-US/${site}${ep}`;
  return `https://${host}/en-US/${site}/job${ep}`;
}

function reqIdFromPath(externalPath) {
  const m = String(externalPath || "").match(/_(\d+)/);
  return m ? m[1] : "";
}

function workdaySitesFromLeads(leads) {
  const map = new Map();
  for (const l of leads) {
    const u = l.url || "";
    const m = u.match(/https:\/\/([^/]+\.myworkdayjobs\.com)\/[^/]+\/([^/]+)\//i);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}`;
    if (!map.has(key)) {
      map.set(key, {
        label: (l.group || m[2]).slice(0, 40),
        host: m[1],
        site: m[2],
        group: l.group || GROUP_LOCAL,
        scope: HOME_RE.test(l.where || "") || l.mode === "Local" ? "fl" : "any",
      });
    }
  }
  return [...map.values()];
}

function mergeWorkdaySources(leads, mode) {
  const key = (s) => `${s.host}|${s.site}`;
  const map = new Map();
  for (const s of CANONICAL_WORKDAY) map.set(key(s), { ...s });
  if (mode === "companies" || mode === "deep") {
    for (const s of workdaySitesFromLeads(leads)) {
      if (!map.has(key(s))) map.set(key(s), s);
    }
  }
  return [...map.values()];
}

function ashbySlugsFromLeads(leads) {
  const slugs = new Set();
  for (const l of leads) {
    const m = (l.url || "").match(/jobs\.ashbyhq\.com\/([^/]+)/i);
    if (m) slugs.add(decodeURIComponent(m[1]));
  }
  for (const s of EXTRA_ASHBY_BOARDS) slugs.add(s);
  return [...slugs];
}

/** Title filter comes from the profile: keep titles with a keyword, drop titles with an exclude word. */
function titleOkForBoard(title) {
  const t = String(title || "");
  if (/intern\b|college grad\b|new grad/i.test(t)) return false;
  if (TITLE_EXCLUDE_RE && TITLE_EXCLUDE_RE.test(t)) return false;
  return TITLE_INCLUDE_RE ? TITLE_INCLUDE_RE.test(t) : false;
}

function locationOkForScope(locText, scope) {
  const loc = String(locText || "");
  if (scope === "fl") return HOME_RE.test(loc);
  if (scope === "remote") return REMOTE_RE.test(loc) || loc.length < 3;
  if (scope === "any") return true;
  return HOME_RE.test(loc) || REMOTE_RE.test(loc);
}

function inferModeFromLocation(locText) {
  const loc = String(locText || "");
  if (ON_SITE_REJECT_RE.test(loc)) return "Conflict";
  return REMOTE_RE.test(loc) ? "Remote" : "Local";
}


function isAutoAddedLead(l) {
  return /Added from Ashby|Added from Workday|Added automatically|Found on search/i.test(l.why || "");
}

/** Remote (explicit) or local — for auto-added rows and bad URLs. */
function leadMatchesHome(l) {
  if (MANUAL_LEAD_IDS.has(l.id)) return true;
  if (/speculative outreach|outreach \(no open/i.test(l.role || "")) return true;
  const loc = (l.where || "") + " " + (l.url || "");
  if ([...ASHBY_MANUAL_ONLY].some((b) => (l.url || "").includes(b)) && !MANUAL_LEAD_IDS.has(l.id)) return false;
  if (HOME_RE.test(loc)) return true;
  if (!isAutoAddedLead(l)) return true;
  if (ON_SITE_REJECT_RE.test(loc)) return false;
  if (l.mode === "Remote" && /\bremote\b/i.test(l.where || "")) return true;
  return false;
}

function pruneMislocatedLeads(data, report, tick) {
  const removed = [];
  data.leads = data.leads.filter((l) => {
    if (leadMatchesHome(l)) return true;
    removed.push(l.role || l.id);
    return false;
  });
  report.pruned = removed;
  if (removed.length) {
    tick(
      `Removed ${removed.length} out-of-area listing(s) (not remote & not local): ${removed
        .map(shortRole)
        .slice(0, 4)
        .join("; ")}${removed.length > 4 ? " …" : ""}`
    );
  } else {
    tick("Location cleanup — no out-of-area auto-added listings to remove.");
  }
  return removed.length;
}

function jobLocationOk(slugName, job) {
  if (ASHBY_MANUAL_ONLY.has(slugName)) return false;
  const loc = String(job.location || job.secondaryLocations?.join(" ") || "").trim();
  if (ON_SITE_REJECT_RE.test(loc)) return false;
  if (HOME_RE.test(loc)) return true;
  if (!loc || loc.length <= 3) return false;
  return REMOTE_RE.test(loc);
}

/** Workday search. The address needs the company name (first part of the host), and Workday allows at most 20 results per page. */
async function pullWorkday(host, site, searchText, scope) {
  const tenant = String(host).split(".")[0];
  const all = [];
  for (let offset = 0; offset < 60; offset += 20) {
    const { status, body } = await postJson(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
      appliedFacets: {},
      limit: 20,
      offset,
      searchText,
    });
    if (status >= 400) return all.length ? { posts: filterPosts(all, scope), bad: 0 } : { posts: [], bad: status };
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      break;
    }
    const page = j.jobPostings || [];
    all.push(...page);
    if (page.length < 20) break;
    await sleep(300);
  }
  return { posts: filterPosts(all, scope), bad: 0 };
}

function filterPosts(list, scope) {
  return list.filter((p) => {
    const loc = (p.locationsText || "") + " " + (p.externalPath || "");
    return locationOkForScope(loc, scope);
  });
}

async function fetchAshbyBoard(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
  const { status, body } = await fetchText(url);
  if (status >= 400) return { jobs: [], bad: status };
  try {
    const j = JSON.parse(body);
    return { jobs: j.jobs || [], bad: 0 };
  } catch {
    return { jobs: [], bad: 0 };
  }
}

function addLeadFromPosting(data, ctx, report, tick, byId, byUrl, byJobId) {
  const { title, url, location, group, jobId, sourceNote } = ctx;
  if (!titleOkForBoard(title)) return false;
  const cleanUrl = (url || "").split("?")[0];
  if (cleanUrl && byUrl.has(cleanUrl)) return false;
  if (jobId && byJobId.has(jobId)) return false;
  const id = (slug(title) + (jobId ? "-" + jobId : "")).slice(0, 60);
  if (byId[id]) return false;

  const mode = ctx.mode || inferModeFromLocation(location);
  if (mode === "Conflict") return false; // searches do not add roles that already look like conflicts
  if (report.added.length >= MAX_NEW) { report.capped = true; return false; }
  const lead = {
    id,
    group: group || (mode === "Remote" ? GROUP_REMOTE : mode === "Conflict" ? GROUP_CONFLICT : GROUP_LOCAL),
    mode,
    role: title.trim() + (jobId ? ` (Job ID ${jobId})` : ""),
    where: (location || (mode === "Remote" ? "Remote" : HOME_LABEL)) + " · Found on search " + today(),
    pay: "Not shown",
    fit: "CHECK",
    fitNote: "",
    why: sourceNote || "Added automatically from board search. Read the posting and set fit after review.",
    url: url || "",
    jobId: jobId || "",
    added: today(),
    closed: false,
  };
  data.leads.push(lead);
  byId[lead.id] = lead;
  if (cleanUrl) byUrl.add(cleanUrl);
  if (jobId) byJobId.add(jobId);
  report.added.push(lead.role);
  tick(`Added to board: ${shortRole(lead.role)}`);
  return true;
}

async function runLinkChecks(data, report, tick, byId) {
  const toCheck = data.leads.filter((l) => l.url && /^https:/i.test(l.url));
  tick(`Checking ${toCheck.length} saved posting links…`);
  let linkStep = 0;
  async function checkOne(l) {
    linkStep++;
    tick(`Link check (${linkStep}/${toCheck.length}): ${shortRole(l.role)}…`);
    return checkUrl(l);
  }
  const results = await poolMap(toCheck, checkOne);
  for (const r of results) {
    if (r.skip || r.live === null) {
      report.skippedCheck++;
      continue;
    }
    report.checked++;
    const l = byId[r.id];
    if (!l) continue;
    if (!r.live && !l.closed) {
      l.closed = true;
      if (!l.where.includes("Refresh ") && !l.where.includes("live check")) {
        l.where = (l.where || "") + " · Marked closed on live check " + today();
      }
      report.markedClosed++;
      tick(`Marked closed: ${shortRole(l.role)}`);
    } else if (r.live && l.closed && !l.why.includes("watch")) {
      l.closed = false;
      l.where = (l.where || "").replace(/ · Marked closed[^·]*/i, "") + " · Live again " + today();
      report.markedOpen++;
      tick(`Reopened: ${shortRole(l.role)}`);
    }
  }
}

async function runWorkdaySearch(data, report, tick, byId, byUrl, byJobId, sources, queries, opts) {
  const { delayMs = 550, budgetStart, overBudget } = opts;
  const seenPath = new Set();
  const candidates = [];
  const totalQueries = sources.length * queries.length;
  let queryStep = 0;

  workdayQueries: for (const src of sources) {
    const scope = src.scope === "remote" ? "remote" : src.scope === "any" ? "any" : "fl";
    for (const q of queries) {
      if (overBudget && overBudget()) {
        tick("Deep search time budget reached — saving what we have…");
        break workdayQueries;
      }
      queryStep++;
      try {
        tick(`Workday (${queryStep}/${totalQueries}): ${src.label} — “${q}”…`);
        await sleep(delayMs);
        const { posts, bad } = await pullWorkday(src.host, src.site, q, scope);
        if (bad) {
          tick(`Workday (${queryStep}/${totalQueries}): ${src.label} — busy (${bad}), skipped`);
          report.searchErrors.push(`${src.host}/${q}: http-${bad}`);
          continue;
        }
        let newHere = 0;
        for (const p of posts) {
          if (!p.externalPath || seenPath.has(p.externalPath)) continue;
          seenPath.add(p.externalPath);
          candidates.push({ ...p, _host: src.host, _site: src.site, _group: src.group });
          newHere++;
        }
        tick(`Workday (${queryStep}/${totalQueries}): ${src.label} — “${q}” — ${posts.length} hit(s)${newHere ? `, ${newHere} new` : ""}`);
      } catch (e) {
        report.searchErrors.push(`${src.label}/${q}: ${String(e.message || e)}`);
      }
    }
  }

  report.searchHits += candidates.length;
  tick(`Reviewing ${candidates.length} Workday listing(s)…`);

  for (const p of candidates) {
    const title = p.title || "";
    const url = workdayJobUrl(p._host, p._site, p.externalPath);
    const jobId = reqIdFromPath(p.externalPath);
    addLeadFromPosting(
      data,
      {
        title: title.trim(),
        url,
        location: p.locationsText || "",
        group: p._group,
        jobId,
        sourceNote: "Added from Workday employer search. Read the posting and set fit after review.",
      },
      report,
      tick,
      byId,
      byUrl,
      byJobId
    );
  }
}

/** Greenhouse public board API. */
async function fetchGreenhouseBoard(token) {
  const { status, body } = await fetchText(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
  if (status >= 400) return { jobs: [], bad: status };
  try {
    const j = JSON.parse(body);
    return {
      jobs: (j.jobs || []).map((x) => ({
        title: x.title,
        location: (x.location && x.location.name) || "",
        url: x.absolute_url || "",
        id: String(x.id || ""),
      })),
      bad: 0,
    };
  } catch {
    return { jobs: [], bad: 0 };
  }
}

/** Lever public postings API. */
async function fetchLeverBoard(company) {
  const { status, body } = await fetchText(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`);
  if (status >= 400) return { jobs: [], bad: status };
  try {
    const j = JSON.parse(body);
    return {
      jobs: (Array.isArray(j) ? j : []).map((x) => ({
        title: x.text,
        location: [(x.categories && x.categories.location) || "", x.workplaceType === "remote" ? "Remote" : ""].filter(Boolean).join(" "),
        url: x.hostedUrl || "",
        id: String(x.id || ""),
      })),
      bad: 0,
    };
  } catch {
    return { jobs: [], bad: 0 };
  }
}

const BOARD_KINDS = {
  ashby: { label: "Ashby", fetch: fetchAshbyBoard },
  greenhouse: { label: "Greenhouse", fetch: fetchGreenhouseBoard },
  lever: { label: "Lever", fetch: fetchLeverBoard },
};

/** Search public job boards (Ashby / Greenhouse / Lever) by board name. */
async function runBoardSearch(kind, data, report, tick, byId, byUrl, byJobId, slugs, overBudget) {
  const K = BOARD_KINDS[kind];
  let step = 0;
  for (const slugName of slugs) {
    if (overBudget && overBudget()) break;
    step++;
    tick(`${K.label} board (${step}/${slugs.length}): ${slugName}…`);
    await sleep(400);
    const { jobs, bad } = await K.fetch(slugName);
    if (bad) {
      tick(`${K.label} ${slugName}: unavailable (${bad})`);
      report.searchErrors.push(`${kind}/${slugName}: http-${bad}`);
      continue;
    }
    let hits = 0;
    for (const j of jobs) {
      if (!jobLocationOk(slugName, j)) continue;
      const loc = j.location || j.secondaryLocations?.join(" ") || "";
      if (!titleOkForBoard(j.title)) continue;
      hits++;
      const mode = inferModeFromLocation(loc);
      const jobUrl =
        kind === "ashby"
          ? j.jobUrl || j.applyUrl || `https://jobs.ashbyhq.com/${slugName}/${j.id || ""}`
          : j.url;
      addLeadFromPosting(
        data,
        {
          title: j.title,
          url: jobUrl,
          location: loc,
          group: mode === "Remote" ? GROUP_REMOTE : GROUP_LOCAL,
          mode,
          jobId: "",
          sourceNote: `Added from ${K.label} (${slugName}). Read the posting and set fit after review.`,
        },
        report,
        tick,
        byId,
        byUrl,
        byJobId
      );
    }
    tick(`${K.label} ${slugName}: ${jobs.length} total, ${hits} matched your job titles and area`);
  }
}

/**
 * @param {Function} onProgress
 * @param {{ mode?: 'light'|'companies'|'deep' }} options
 */
async function runRefresh(onProgress, options = {}) {
  const mode = options.mode === "light" || options.mode === "companies" || options.mode === "deep" ? options.mode : "companies";
  const tick = typeof onProgress === "function" ? onProgress : () => {};
  const budgetStart = Date.now();
  const overBudget = () => mode === "deep" && Date.now() - budgetStart > DEEP_BUDGET_MS;

  const dataDir = options.dataDir || process.env.JB_DATA || __dirname;
  LEADS_FILE = path.join(dataDir, "leads.json");
  applyProfile(loadProfile(dataDir));

  const data = JSON.parse(fs.readFileSync(LEADS_FILE, "utf8").replace(/^\uFEFF/, ""));
  const byId = Object.fromEntries(data.leads.map((l) => [l.id, l]));
  const byJobId = new Set(data.leads.map((l) => l.jobId).filter(Boolean));
  const byUrl = new Set(data.leads.map((l) => (l.url || "").split("?")[0]));

  const report = {
    mode,
    checked: 0,
    markedClosed: 0,
    markedOpen: 0,
    added: [],
    pruned: [],
    skippedCheck: 0,
    searchHits: 0,
    searchErrors: [],
  };

  tick(mode === "light" ? "Light refresh — checking links & cleaning bad locations…" : mode === "deep" ? "Deep search — employers + remote boards (up to ~10 min)…" : "Company search — board employers…");

  if (PROFILE_READY) {
    tick("Location cleanup — dropping auto-added roles that are not remote (explicit) or local…");
    pruneMislocatedLeads(data, report, tick);
  } else {
    tick("Your search profile is not finished yet — only checking saved links. (Finish the interview in the chat to turn on searching.)");
  }
  Object.keys(byId).forEach((k) => delete byId[k]);
  for (const l of data.leads) byId[l.id] = l;
  byJobId.clear();
  byUrl.clear();
  for (const l of data.leads) {
    if (l.jobId) byJobId.add(l.jobId);
    if (l.url) byUrl.add(l.url.split("?")[0]);
  }

  if (mode !== "light" && PROFILE_READY) {
    const workdaySources = mergeWorkdaySources(data.leads, mode);
    const queries = mode === "deep" ? QUERIES_DEEP_FL : QUERIES_COMPANIES;
    const delayMs = mode === "deep" ? 650 : 500;

    await runWorkdaySearch(data, report, tick, byId, byUrl, byJobId, workdaySources, queries, {
      delayMs,
      budgetStart,
      overBudget,
    });

    // Public job boards listed in the profile (cheap, so they run in both search modes).
    if (EXTRA_ASHBY_BOARDS.length && !overBudget()) await runBoardSearch("ashby", data, report, tick, byId, byUrl, byJobId, EXTRA_ASHBY_BOARDS, overBudget);
    if (EXTRA_GREENHOUSE_BOARDS.length && !overBudget()) await runBoardSearch("greenhouse", data, report, tick, byId, byUrl, byJobId, EXTRA_GREENHOUSE_BOARDS, overBudget);
    if (EXTRA_LEVER_BOARDS.length && !overBudget()) await runBoardSearch("lever", data, report, tick, byId, byUrl, byJobId, EXTRA_LEVER_BOARDS, overBudget);

    if (mode === "deep" && !overBudget()) {
      const remoteSources = workdaySources
        .filter((s) => !CANONICAL_WORKDAY.some((c) => c.host === s.host))
        .map((s) => ({ ...s, scope: "remote" }));
      if (remoteSources.length) {
        tick(`Deep pass — remote-friendly search on ${remoteSources.length} other Workday site(s)…`);
        await runWorkdaySearch(data, report, tick, byId, byUrl, byJobId, remoteSources, QUERIES_DEEP_REMOTE, {
          delayMs: 700,
          budgetStart,
          overBudget,
        });
      }
      const ashbySlugs = ashbySlugsFromLeads(data.leads);
      tick(`Deep pass — Ashby boards (${ashbySlugs.length}) for remote roles…`);
      await runBoardSearch("ashby", data, report, tick, byId, byUrl, byJobId, ashbySlugs.filter((s) => !EXTRA_ASHBY_BOARDS.includes(s)), overBudget);
    }
  }

  await runLinkChecks(data, report, tick, byId);

  data.updated = today();
  tick("Saving board file…");
  fs.writeFileSync(LEADS_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  tick("Refresh finished — reloading list…");

  const modeLabel = mode === "light" ? "Link check" : mode === "deep" ? "Deep search" : "Company search";
  const pr = report.pruned.length ? `${report.pruned.length} removed (wrong location); ` : "";
  report.summary = `${modeLabel}: ${pr}checked ${report.checked} links; ${report.markedClosed} closed; ${report.markedOpen} reopened; ${report.added.length} new role(s) added.${report.capped ? ` (Stopped at ${MAX_NEW} new roles for this run. Run it again later, or narrow your job titles, to see more.)` : ""}`;
  return report;
}

module.exports = { runRefresh };

if (require.main === module) {
  const mode = process.argv[2] || "companies";
  runRefresh(console.log, { mode })
    .then((r) => {
      console.log(r.summary);
      if (r.added.length) console.log("Added:", r.added.join("; "));
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
