#!/usr/bin/env node
// Helper the assistant can run to find out how to search an employer.
//   node probe-sources.js "Company Name"          -> tries Greenhouse, Lever, Ashby board names
//   node probe-sources.js https://xyz.wd5.myworkdayjobs.com/en-US/SiteName/job/...   -> tests a Workday posting address
// Prints plain JSON so the assistant can copy working entries into search-profile.json.
const https = require("https");

function get(url, opts = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ status: 0, body: "" }); }
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: opts.method || "GET", timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json", ...(opts.headers || {}) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
    );
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "" }); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function slugVariants(name) {
  const base = String(name || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9\s-]/g, "").trim();
  const words = base.split(/\s+/).filter(Boolean);
  const noSuffix = words.filter((w) => !/^(inc|llc|ltd|corp|corporation|company|co|group|the)$/.test(w));
  const set = new Set([noSuffix.join(""), noSuffix.join("-"), words.join(""), words.join("-"), noSuffix[0]].filter(Boolean));
  return [...set];
}

async function tryBoards(name) {
  const out = { company: name, found: [] };
  for (const s of slugVariants(name)) {
    const gh = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs`);
    if (gh.status === 200) { try { out.found.push({ kind: "greenhouse", board: s, openJobs: (JSON.parse(gh.body).jobs || []).length }); } catch {} }
    const lv = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`);
    if (lv.status === 200) { try { const j = JSON.parse(lv.body); if (Array.isArray(j)) out.found.push({ kind: "lever", board: s, openJobs: j.length }); } catch {} }
    const ab = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}`);
    if (ab.status === 200) { try { out.found.push({ kind: "ashby", board: s, openJobs: (JSON.parse(ab.body).jobs || []).length }); } catch {} }
  }
  if (!out.found.length) out.note = "No Greenhouse, Lever or Ashby board found under common names. The company may use Workday (give me a job posting address) or its own site (add roles by hand).";
  return out;
}

async function tryWorkday(url) {
  const m = String(url).match(/https:\/\/([^/]+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
  if (!m) return { error: "That does not look like a Workday posting address (it should contain myworkdayjobs.com)." };
  const host = m[1], site = m[2];
  const payload = JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" });
  const r = await get(`https://${host}/wday/cxs/${host.split(".")[0]}/${site}/jobs`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, body: payload });
  let total = null;
  try { total = JSON.parse(r.body).total; } catch {}
  return { kind: "workday", host, site, works: r.status === 200, openJobs: total, profileEntry: { label: host.split(".")[0], host, site, group: "", scope: "local" } };
}

(async () => {
  const arg = process.argv.slice(2).join(" ").trim();
  if (!arg) { console.log("Usage: node probe-sources.js \"Company Name\"   or   node probe-sources.js <Workday posting address>"); process.exit(1); }
  const res = /myworkdayjobs\.com/i.test(arg) ? await tryWorkday(arg) : await tryBoards(arg);
  console.log(JSON.stringify(res, null, 2));
})();
