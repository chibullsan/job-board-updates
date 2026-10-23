// Local Job Board server. Listens on this PC only (127.0.0.1).
// - Serves the board page and leads.json
// - Saves the person's Apply/Maybe/Skip choices, stars and notes to state.json (in the data folder)
// - Streams a chat with a Cursor agent (via @cursor/sdk) that can edit leads.json and other files in the resume folder
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP = __dirname;                                  // program files (an update replaces these)
// ROOT = the person's whole job-search folder (the assistant works here).
// DATA = their private board data (leads, choices, chat history, key). An update NEVER touches DATA.
const ROOT = process.env.JB_ROOT ? path.resolve(process.env.JB_ROOT) : path.resolve(APP, "..", "..");
const DATA = process.env.JB_DATA ? path.resolve(process.env.JB_DATA) : APP;
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.PORT || 8765);
const HOST = "127.0.0.1";
const F = {
  leads: path.join(DATA, "leads.json"), state: path.join(DATA, "state.json"), html: path.join(APP, "index.html"),
  instrTemplate: path.join(APP, "AGENT-INSTRUCTIONS.template.md"), instrExtra: path.join(DATA, "assistant-notes.md"),
  session: path.join(DATA, "chat-session.json"), config: path.join(DATA, "config.json"), profile: path.join(DATA, "search-profile.json"),
};
function updatesEnabled() {
  if (process.env.JB_CAN_UPDATE === "1") return true;
  try { return fs.existsSync(path.join(APP, "update-config.json")); } catch { return false; }
}
const { runRefresh } = require("./refresh-board-run.js");
const { extractText } = require("./resume-extract.js");
const updater = require("./updater.js");
let publisher = null;
try { publisher = require("./publisher.js"); } catch {}   // only exists on the builder's own board
const upCtx = () => ({ APP, DATA, ROOT });
const APPS = path.join(ROOT, "03_Applications");
const relRoot = (p) => path.relative(ROOT, p) || ".";

// ---- who is this board for? (set once on the page; stored in DATA\config.json) ----
function getConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(F.config, "utf8").replace(/^\uFEFF/, "")); } catch {}
  const full = String(c.fullName || "").trim();
  const first = String(c.firstName || full.split(/\s+/)[0] || "").trim();
  return { ...c, fullName: full, firstName: first, label: first || "You" };
}

function slug(s) {
  return String(s || "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
}

function companyFromLead(l) {
  // Company is usually in parentheses at the end of the role, or comes from the group name.
  const m = String(l.role || "").match(/\(([^)]+)\)\s*$/) || String(l.role || "").match(/\(([^)]+)\)/);
  if (m && !/job id|req\b/i.test(m[1])) return slug(m[1]);
  const g = String(l.group || "");
  return slug(g.split("/")[0]) || "Company";
}

function roleShort(l) {
  return slug(l.role.replace(/\([^)]*\)/g, "").replace(/Job ID[^]*/i, "")) || slug(l.id);
}

function startApplication(leadId) {
  const data = getLeads();
  const l = (data.leads || []).find((x) => x.id === leadId);
  if (!l) return { error: "Lead not found on the board." };
  const ym = new Date().toISOString().slice(0, 7);
  const folderName = `${ym}_${companyFromLead(l)}_${roleShort(l)}`;
  const dir = path.join(APPS, folderName);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, "README.txt");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      `Application package for: ${l.role}\nBoard id: ${l.id}\nPosting: ${l.url || "(none)"}\n\nFolders/files to build here:\n  1_Job-Posting\n  2_Match-Notes\n  3_Resume\n  4_Cover-Letter\n  5_Extras\n  6_Company-and-Role-Research\n\nUse the board button "Draft resume and cover letter" or ask the assistant on the board to fill these from the master resume.\n`,
      "utf8"
    );
  }
  const match = path.join(dir, "2_Match-Notes_START.md");
  if (!fs.existsSync(match)) {
    fs.writeFileSync(
      match,
      `# Match notes — ${l.role}\n\n- **Board id:** ${l.id}\n- **Fit on board:** ${l.fit}\n- **Why (board):** ${l.why}\n\n## Posting highlights\n(Add from live posting.)\n\n## ${getConfig().label === "You" ? "My" : getConfig().label + "'s"} strengths for this role\n\n## Gaps / honesty flags (TO CONFIRM)\n`,
      "utf8"
    );
  }
  const posting = path.join(dir, "1_Job-Posting_LINK.txt");
  if (!fs.existsSync(posting)) fs.writeFileSync(posting, `${l.url || ""}\n`, "utf8");
  const st = readJSON(F.state, { items: {}, lastVisit: null });
  st.items[leadId] = {
    ...(st.items[leadId] || {}),
    status: "Apply",
    applicationFolder: folderName,
    updated: new Date().toISOString(),
  };
  writeJSON(F.state, st);
  return { ok: true, folder: folderName, path: dir.replace(/\\/g, "\\") };
}

// ---- tiny .env reader (never sent to the browser) ----
function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(DATA, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv();

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch { return d; } };
// Board data: if leads.json is ever saved with a mistake, keep showing the last good copy and say so.
let lastGoodLeads = null;
function getLeads() {
  try {
    const j = JSON.parse(fs.readFileSync(F.leads, "utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(j.leads)) throw new Error("leads missing");
    lastGoodLeads = j; return j;
  } catch (e) {
    return { ...(lastGoodLeads || { updated: "", leads: [] }), warning: "leads.json has a mistake in it (" + e.message + "). Showing the last good copy." };
  }
}
const writeJSON = (f, o) => { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const send = (res, code, body, type = "application/json") => { res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
const readBody = (req, limit = 2e6) => new Promise((ok, no) => { let d = ""; req.on("data", (c) => { d += c; if (d.length > limit) req.destroy(); }); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } }); });

// ---- assistant instructions: a generic template, filled in with this person's name and folders ----
function loadInstructions() {
  const cfg = getConfig();
  let t = "";
  try { t = fs.readFileSync(F.instrTemplate, "utf8"); } catch { t = "You are the assistant inside {{FIRST_NAME}}'s local Job Board web page."; }
  t = t.replace(/\{\{FIRST_NAME\}\}/g, cfg.firstName || "the user").replace(/\{\{FULL_NAME\}\}/g, cfg.fullName || cfg.firstName || "the user")
    .replace(/\{\{ROOT\}\}/g, ROOT).replace(/\{\{APP_REL\}\}/g, relRoot(APP)).replace(/\{\{DATA_REL\}\}/g, relRoot(DATA)).replace(/\{\{BOARD_REL\}\}/g, relRoot(DATA));
  try {
    const p = readJSON(F.profile, null);
    if (!(p && p.ready)) {
      const g = fs.readFileSync(path.join(APP, "INTERVIEW-GUIDE.md"), "utf8");
      t += "\n\n# INTERVIEW GUIDE (the search profile is not finished, so follow this)\n\n" + g
        .replace(/\{\{FIRST_NAME\}\}/g, cfg.firstName || "the user").replace(/\{\{APP_REL\}\}/g, relRoot(APP)).replace(/\{\{DATA_REL\}\}/g, relRoot(DATA));
    }
  } catch {}
  try { const extra = fs.readFileSync(F.instrExtra, "utf8").trim(); if (extra) t += "\n\n## Extra notes saved on this PC\n" + extra + "\n"; } catch {}
  return t;
}

// ---- chat agent ----
let sdkP = null, agent = null, busy = false, refreshBusy = false, firstTurn = true, currentRun = null;
let activityMessage = "Ready";
function setActivity(msg) {
  activityMessage = msg || "Ready";
}
function toolActivityLabel(name) {
  const n = String(name || "").toLowerCase();
  if (/read|glob|grep|list/.test(n)) return "Assistant: reading files or the board…";
  if (/write|edit|strreplace|notebook/.test(n)) return "Assistant: updating files or the board…";
  if (/search|web|fetch|http/.test(n)) return "Assistant: searching or checking a site…";
  if (/shell|terminal|run/.test(n)) return "Assistant: running a command…";
  return "Assistant: " + String(name || "tool").replace(/_/g, " ") + "…";
}
const sdk = () => (sdkP ||= import("@cursor/sdk"));
const MODEL = () => ({ id: process.env.CURSOR_MODEL || "composer-2.5" });
const hasKey = () => !!process.env.CURSOR_API_KEY && !/paste|your/i.test(process.env.CURSOR_API_KEY);

function errText(e) {
  return String((e && (e.message || e.name)) || e || "");
}
/** Saved local-agent memory is gone or damaged — start a new assistant, keep the on-page history. */
function isDeadSession(e) {
  const t = errText(e).toLowerCase();
  return /corrupt local agent checkpoint|missing root blob|cannot resume|failed to (load|resume|open) session|session not found|no conversation found|checkpoint/.test(t);
}
function isStuckRun(e) {
  return !!(e && (e.name === "AgentBusyError" || /already has active run|active run/i.test(errText(e))));
}
function friendlyChatError(e) {
  if (isDeadSession(e)) return "The assistant's saved memory on this PC was damaged, so I started a fresh assistant. Your chat history on this page is still there. Please send your message again.";
  const t = errText(e).replace(/[^\t\n\r\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "The assistant hit a problem. Please try sending again.";
  return t.length > 220 ? t.slice(0, 220) + "…" : t;
}

async function getAgent() {
  if (agent) return agent;
  const { Agent } = await sdk();
  const opts = { apiKey: process.env.CURSOR_API_KEY, local: { cwd: ROOT }, model: MODEL() };
  const saved = readJSON(F.session, null);
  if (saved && saved.agentId) {
    try { agent = await Agent.resume(saved.agentId, opts); firstTurn = false; return agent; }
    catch (e) { try { fs.unlinkSync(F.session); } catch {} }
  }
  agent = await Agent.create(opts);
  writeJSON(F.session, { agentId: agent.agentId, created: new Date().toISOString() });
  firstTurn = true;
  return agent;
}

// Cancel any run on this agent that is still marked active (left over from a crash or closed window), keeping its memory.
async function clearStaleRuns(agentId) {
  try {
    const { Agent } = await sdk();
    const runs = await Agent.listRuns(agentId, { runtime: "local", cwd: ROOT, apiKey: process.env.CURSOR_API_KEY });
    let n = 0;
    for (const r of runs.items || runs) {
      if (/running|active|pending|creating/i.test(String(r.status)) && r.supports && r.supports("cancel")) { try { await r.cancel(); n++; } catch {} }
    }
    return n;
  } catch { return 0; }
}

// Real chat-entry boundaries in Board-Chat-Log.md ("## time" then "**Name:**"), not "##" headings inside replies.
const ENTRY_START = /\n(?=## [^\n]+\r?\n\*\*[^*\n]+:\*\* )/;

// Short recap of the most recent web-page chats, so a brand-new session still knows what was going on.
function recentChatRecap(maxEntries = 8, maxChars = 1200) {
  try {
    const { entries } = readHistory(maxEntries);
    return entries.map((e) => (e.role === "user" ? "User: " : "Assistant: ") + (String(e.text).length > maxChars ? String(e.text).slice(0, maxChars) + " ...(shortened)" : e.text)).join("\n\n");
  } catch { return ""; }
}

async function resetChat() {
  try { if (agent) await agent[Symbol.asyncDispose]?.(); } catch {}
  agent = null; firstTurn = true;
  try { fs.unlinkSync(F.session); } catch {}
}

// ---- automatic chat log (so the Cursor chat can read what was said on the web page) ----
const LOG = path.join(ROOT, "00_READ-ME-FIRST", "Board-Chat-Log.md");
function appendLog(user, reply, tools) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, "# Board Chat Log\n\nAutomatic record of chats in the Job Board web page (newest at the bottom). The Cursor chat reads this so both assistants stay in sync. Do not edit by hand.\n\n");
    const ts = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
    const acts = [...new Set(tools)];
    fs.appendFileSync(LOG, `## ${ts}\n**${getConfig().label}:** ${user}\n\n**Assistant:** ${(reply || "").trim() || "(no text reply)"}\n${acts.length ? `\n_Actions used: ${acts.join(", ")}_\n` : ""}\n---\n\n`);
  } catch {}
}

// ---- permanent chat history (shown again in the chat window whenever the page opens) ----
// One JSON line per message. Never deleted by "new chat", restarts, or updates.
F.history = path.join(DATA, "chat-history.jsonl");
function logHistory(role, text, tools, extra) {
  try {
    const rec = { t: new Date().toISOString(), role, text: String(text || ""), ...(tools && tools.length ? { tools: [...new Set(tools)] } : {}), ...(extra || {}) };
    fs.appendFileSync(F.history, JSON.stringify(rec) + "\n", "utf8");
  } catch {}
}
function readHistory(limit = 300) {
  try {
    const lines = fs.readFileSync(F.history, "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit)) { try { out.push(JSON.parse(l)); } catch {} }
    return { total: lines.length, entries: out };
  } catch { return { total: 0, entries: [] }; }
}
// One-time: build the history file from the older Board-Chat-Log.md so earlier chats show up too.
function backfillHistory() {
  try {
    if (fs.existsSync(F.history) || !fs.existsSync(LOG)) return;
    const txt = fs.readFileSync(LOG, "utf8").replace(/^\uFEFF/, "");
    const lines = [];
    // Split only at real entry starts ("## time" followed by "**Name:**"), not at headings inside replies.
    for (const part of txt.split(ENTRY_START).slice(1)) {
      const m = part.match(/^## (.+)\r?\n\*\*([^*\n]+):\*\* ([\s\S]*?)\r?\n\r?\n\*\*Assistant:\*\* ([\s\S]*?)\r?\n(?:\r?\n_Actions used: ([^\n]*)_\r?\n)?\r?\n---\s*$/);
      if (!m) continue;
      const when = new Date(m[1]); const t = isNaN(when) ? m[1] : when.toISOString();
      lines.push(JSON.stringify({ t, role: "user", text: m[3].trim(), imported: true }));
      const reply = m[4].trim();
      if (reply && reply !== "(no text reply)") lines.push(JSON.stringify({ t, role: "assistant", text: reply, ...(m[5] ? { tools: m[5].split(",").map((s) => s.trim()) } : {}), imported: true }));
    }
    if (lines.length) fs.writeFileSync(F.history, lines.join("\n") + "\n", "utf8");
  } catch {}
}
backfillHistory();

// A brand-new board starts with a short, friendly "how this works" conversation (no personal facts).
function seedStarter() {
  try {
    if (fs.existsSync(F.history)) return;
    const name = getConfig().firstName;
    if (!name) return;
    const list = JSON.parse(fs.readFileSync(path.join(APP, "starter-history.json"), "utf8"));
    const now = Date.now();
    const lines = list.map((m, i) => JSON.stringify({ t: new Date(now + i).toISOString(), role: m.role, text: String(m.text).replace(/\{\{FIRST_NAME\}\}/g, name), starter: true }));
    fs.writeFileSync(F.history, lines.join("\n") + "\n", "utf8");
  } catch {}
}
seedStarter();

// ---- one-time setup from the web page: test the key, then save it to .env ----
function writeEnvKey(key) {
  const f = path.join(DATA, ".env");
  let lines = [];
  try { lines = fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => l.trim() && !/^\s*CURSOR_API_KEY\s*=/.test(l)); } catch {}
  lines.unshift("CURSOR_API_KEY=" + key);
  fs.writeFileSync(f, lines.join("\r\n") + "\r\n");
}
async function setupKey(req, res) {
  const b = await readBody(req).catch(() => ({}));
  const key = String(b.key || "").trim().replace(/^["']|["']$/g, "");
  if (!key || /\s/.test(key) || key.length < 20) return send(res, 400, { error: "That does not look like a full key. Copy the whole key (no spaces) and paste it again." });
  try {
    const { Cursor } = await sdk();
    await Cursor.models.list({ apiKey: key });
  } catch (e) {
    const auth = /auth|401|unauthor|invalid/i.test(String((e && (e.name + " " + e.message)) || e));
    return send(res, 400, { error: auth ? "Cursor did not accept that key. Check that you copied all of it, then try again." : "Could not reach Cursor to test the key (" + String((e && e.message) || e) + "). Check your internet connection and try again." });
  }
  writeEnvKey(key);
  process.env.CURSOR_API_KEY = key;
  agent = null;
  send(res, 200, { ok: true });
}

// ---- resume upload: save the original file, pull out its text for the assistant ----
async function uploadResume(req, res) {
  const b = await readBody(req, 30e6).catch(() => null);
  if (!b || !b.filename || !b.data) return send(res, 400, { error: "No file received. Please try again." });
  const orig = path.basename(String(b.filename)).replace(/[^\w .()\-]/g, "_").slice(0, 100) || "resume";
  let buf;
  try { buf = Buffer.from(String(b.data), "base64"); } catch { return send(res, 400, { error: "That file could not be read." }); }
  if (!buf.length) return send(res, 400, { error: "That file is empty." });
  let text;
  try { text = await extractText(orig, buf); } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
  const d = new Date(); const pad = (n) => String(n).padStart(2, "0");
  const ts = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes());
  const keepDir = path.join(ROOT, "02_Master-Templates", "Uploaded-Resume");
  fs.mkdirSync(keepDir, { recursive: true });
  const saved = path.join(keepDir, ts + "_" + orig);
  fs.writeFileSync(saved, buf);
  const pb = path.join(ROOT, "01_Profile-Builder");
  fs.mkdirSync(pb, { recursive: true });
  const tf = path.join(pb, "Resume-Text.md");
  if (fs.existsSync(tf)) { // never overwrite: move the previous text to OLD with a dated name
    const oldDir = path.join(ROOT, "OLD"); fs.mkdirSync(oldDir, { recursive: true });
    fs.renameSync(tf, path.join(oldDir, "Resume-Text_" + ts + ".md"));
  }
  fs.writeFileSync(tf, "# Resume text (pulled from the uploaded file)\n\nOriginal file: " + path.relative(ROOT, saved) + "\nUploaded: " + new Date().toLocaleString() + "\n\n---\n\n" + text + "\n");
  send(res, 200, { ok: true, chars: text.length, saved: path.relative(ROOT, saved), warning: text.length < 200 ? "I could only read a little text from that file. If it is a scan or a picture, please upload a Word version instead (or paste the text into the chat)." : "" });
}

function sse(res, ev, data) { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); }

async function chat(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const message = String(body.message || "").trim();
  if (!message) return send(res, 400, { error: "Empty message" });
  if (!hasKey()) return send(res, 400, { error: "no-key", help: "The assistant is not turned on yet. Use the setup box at the top of the chat panel." });
  const steer = body.steer === true;
  if (busy) {
    if (!steer) {
      return send(res, 409, {
        error: "busy",
        help: "The assistant is still working. Send again to steer (cancel and use your new message), or press Stop first.",
      });
    }
    setActivity("Steering — stopping previous reply…");
    try {
      if (currentRun && currentRun.supports && currentRun.supports("cancel")) await currentRun.cancel();
    } catch {}
    for (let i = 0; i < 40 && busy; i++) await new Promise((r) => setTimeout(r, 100));
    if (busy) {
      return send(res, 409, {
        error: "busy",
        help: "Could not switch yet. Press Stop, wait a second, then send your new message.",
      });
    }
  }
  busy = true;
  setActivity("Assistant working on your request…");
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
  logHistory("user", message);
  let reply = ""; const tools = [];
  // If the page is closed or reloaded mid-answer, stop the run so the assistant is not left stuck "in a run".
  res.on("close", () => { if (!res.writableEnded && currentRun && currentRun.supports && currentRun.supports("cancel")) { try { currentRun.cancel(); } catch {} } });
  try {
    let a = await getAgent();
    const buildFirst = () => {
      const cfg = getConfig();
      const instr = loadInstructions();
      const st = readJSON(F.state, { items: {} });
      const starVal = (v) => {
        if (v.stars != null && v.stars !== "") return Number(v.stars);
        if (v.rank != null && v.rank !== "") {
          const r = Number(v.rank);
          if (r >= 1 && r <= 5) return 6 - r;
        }
        return null;
      };
      const starred = Object.entries(st.items || {})
        .map(([id, v]) => [id, v, starVal(v)])
        .filter(([, , s]) => s != null && s >= 1)
        .sort((a, b) => b[2] - a[2])
        .slice(0, 25)
        .map(([id, v, s]) => `${s}★ ${id}${v.status ? " (" + v.status + ")" : ""}${v.note ? " — " + String(v.note).slice(0, 120) : ""}`);
      const who = cfg.firstName || "the user";
      const starBlock = starred.length ? `\n${who}'s starred leads (from ${relRoot(F.state)}, do not edit):\n${starred.join("\n")}\n` : "";
      return `Read and follow these instructions for this whole conversation:\n\n${instr}\n\nThis is a new session, so you do not remember earlier chats. Here is a recap of the most recent ones (full history: ${relRoot(F.history)}; shared notes: 00_READ-ME-FIRST\\Shared-Memory.md; ${who}'s choices: ${relRoot(F.state)}). Do not re-read those files unless the request needs them.\n\nRECENT CHATS:\n${recentChatRecap() || "(none yet)"}${starBlock}\nToday is ${new Date().toDateString()}.\n\n${who} says:\n${message}`;
    };
    let prompt = message;
    if (firstTurn) { prompt = buildFirst(); firstTurn = false; }
    let run;
    try {
      run = await a.send(prompt, { model: MODEL() });
    } catch (e) {
      if (isDeadSession(e) || isStuckRun(e)) {
        if (isStuckRun(e) && !isDeadSession(e)) {
          sse(res, "tool", { name: "clearing a stuck session" });
          const cleared = await clearStaleRuns(a.agentId);
          try {
            if (!cleared) throw e;
            run = await a.send(prompt, { model: MODEL() });
          } catch (e2) { e = e2; }
        }
        if (!run) {
          sse(res, "tool", { name: "starting a fresh session" });
          await resetChat();
          a = await getAgent();
          prompt = buildFirst(); firstTurn = false;
          run = await a.send(prompt, { model: MODEL() });
        }
      } else {
        throw e;
      }
    }
    currentRun = run;
    for await (const ev of run.stream()) {
      if (ev.type === "assistant") {
        for (const b of ev.message.content) {
          if (b.type === "text") { reply += b.text; sse(res, "text", { text: b.text }); }
          else if (b.type === "tool_use") {
            tools.push(b.name);
            setActivity(toolActivityLabel(b.name));
            sse(res, "tool", { name: b.name });
          }
        }
      } else if (ev.type === "tool_call" && ev.status === "running") {
        tools.push(ev.name);
        setActivity(toolActivityLabel(ev.name));
        sse(res, "tool", { name: ev.name });
      }
      else if (ev.type === "thinking") sse(res, "thinking", {});
    }
    const result = await run.wait();
    appendLog(message, reply, tools);
    sse(res, "done", { status: result.status });
  } catch (e) {
    if (isDeadSession(e)) {
      try { await resetChat(); } catch {}
    }
    sse(res, "error", { message: friendlyChatError(e), retryable: true });
  } finally {
    if (reply.trim()) logHistory("assistant", reply, tools);
    currentRun = null; busy = false; setActivity("Ready"); res.end();
  }
}

// ---- routes ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return send(res, 200, fs.readFileSync(F.html, "utf8"), "text/html");
    if (req.method === "GET" && url.pathname === "/api/leads") return send(res, 200, getLeads());
    if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, readJSON(F.state, { items: {}, lastVisit: null }));
    if (req.method === "GET" && url.pathname === "/api/config") {
      const c = getConfig(); const p = readJSON(F.profile, null);
      return send(res, 200, { fullName: c.fullName, firstName: c.firstName, configured: !!c.firstName, profileReady: !!(p && p.ready), resumeUploaded: fs.existsSync(path.join(ROOT, "01_Profile-Builder", "Resume-Text.md")), canUpdate: updatesEnabled(), canPublish: !!(publisher && publisher.pubConfig(DATA)), roleFamilies: (p && Array.isArray(p.roleFamilies)) ? p.roleFamilies : [], version: readJSON(path.join(APP, "version.json"), { version: "dev" }).version });
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const b = await readBody(req);
      const fullName = String(b.fullName || "").trim().slice(0, 80);
      if (!fullName) return send(res, 400, { error: "Please enter a name." });
      const cur = readJSON(F.config, {});
      writeJSON(F.config, { ...cur, fullName, firstName: String(b.firstName || fullName.split(/\s+/)[0]).trim().slice(0, 40) });
      seedStarter();
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      return send(res, 200, {
        boardApi: 3,
        appVersion: updater.localVersion(APP),
        searchModes: ["light", "companies", "deep"],
        leads: mtime(F.leads),
        state: mtime(F.state),
        busy,
        refreshBusy,
        chatReady: hasKey(),
        activity: activityMessage,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/refresh-board") {
      if (refreshBusy) return send(res, 409, { error: "Refresh already running. Wait for it to finish." });
      const b = req.method === "POST" ? await readBody(req).catch(() => ({})) : {};
      const mode = b.mode === "light" || b.mode === "companies" || b.mode === "deep" ? b.mode : "companies";
      setActivity(mode === "light" ? "Light refresh — checking links…" : mode === "deep" ? "Deep search starting…" : "Company search starting…");
      refreshBusy = true;
      try {
        const report = await runRefresh((msg) => setActivity(msg), { mode, dataDir: DATA });
        return send(res, 200, { ok: true, ...report });
      } catch (e) {
        return send(res, 500, { error: String(e.message || e) });
      } finally {
        refreshBusy = false;
        setActivity("Ready");
      }
    }
    if (req.method === "POST" && url.pathname === "/api/state") {
      const b = await readBody(req); const st = readJSON(F.state, { items: {}, lastVisit: null });
      if (b.lastVisit) st.lastVisit = b.lastVisit;
      if (b.id) { st.items[b.id] = { ...(st.items[b.id] || {}), ...b.patch, updated: new Date().toISOString() }; }
      writeJSON(F.state, st); return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/start-application") {
      const b = await readBody(req);
      const out = startApplication(String(b.id || "").trim());
      if (out.error) return send(res, 404, out);
      return send(res, 200, out);
    }
    if (req.method === "GET" && url.pathname === "/api/chat/history") return send(res, 200, readHistory(Math.min(2000, Number(url.searchParams.get("limit")) || 300)));
    if (req.method === "POST" && url.pathname === "/api/setup") return await setupKey(req, res);
    if (req.method === "POST" && url.pathname === "/api/upload-resume") return await uploadResume(req, res);
    if (req.method === "GET" && url.pathname === "/api/update/check") {
      try { return send(res, 200, { ...(await updater.checkForUpdate(upCtx())), last: updater.lastResult(upCtx()), canUpdate: updatesEnabled() }); }
      catch (e) { return send(res, 200, { error: "Could not check for updates: " + String((e && e.message) || e), current: updater.localVersion(APP), last: updater.lastResult(upCtx()), canUpdate: updatesEnabled() }); }
    }
    if (req.method === "GET" && url.pathname === "/api/update/status") return send(res, 200, { ...updater.getProgress(), last: updater.lastResult(upCtx()) });
    if (req.method === "POST" && url.pathname === "/api/update/apply") {
      if (!updatesEnabled()) return send(res, 400, { error: "Updating is only available in the installed Job Board (started with Start Job Board.bat)." });
      if (busy || refreshBusy) return send(res, 409, { error: "The assistant or a search is busy. Wait for it to finish, then update." });
      try {
        const r = await updater.applyUpdate(upCtx());
        send(res, 200, r);
        if (r.restart) setTimeout(() => process.exit(75), 1500);
      } catch (e) { send(res, 500, { error: String((e && e.message) || e) }); }
      return;
    }
    if (url.pathname.startsWith("/api/publish")) {
      if (!publisher || !publisher.pubConfig(DATA)) return send(res, 404, { error: "Publishing is not set up on this board." });
      if (req.method === "GET" && url.pathname === "/api/publish/preview") {
        try { return send(res, 200, publisher.preview(upCtx())); } catch (e) { return send(res, 500, { error: String((e && e.message) || e) }); }
      }
      if (req.method === "POST" && url.pathname === "/api/publish") {
        const b = await readBody(req).catch(() => ({}));
        try { return send(res, 200, publisher.publish(upCtx(), b.notes)); } catch (e) { return send(res, 400, { error: String((e && e.message) || e) }); }
      }
    }
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    if (req.method === "POST" && url.pathname === "/api/chat/stop") {
      setActivity("Stopping assistant…");
      try {
        if (currentRun && currentRun.supports && currentRun.supports("cancel")) await currentRun.cancel();
      } catch {}
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/chat/reset") { await resetChat(); return send(res, 200, { ok: true }); }
    send(res, 404, {
      error: "Not found",
      help: url.pathname.startsWith("/api/refresh")
        ? "This Job Board server is out of date. Close the old Job Board window (or run Restart-Job-Board.bat), then try Run search again."
        : undefined,
    });
  } catch (e) { if (!res.headersSent) send(res, 500, { error: String(e.message || e) }); else res.end(); }
});
// First run: make sure the person's data folder has the files the board expects.
for (const [f, d] of [[F.leads, { updated: "", leads: [] }], [F.state, { items: {}, lastVisit: null }]]) { if (!fs.existsSync(f)) writeJSON(f, d); }
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log(`The Job Board is already running. Open http://${HOST}:${PORT} in your browser. (To restart it, close the other Job Board window first.)`); process.exit(0); }
  throw e;
});
server.listen(PORT, HOST, () => { if (!process.env.JB_TEST_MODE) setTimeout(() => updater.confirmPendingUpdate(upCtx()), 6000); console.log(`Job Board running at http://${HOST}:${PORT}  (chat ${hasKey() ? "ready" : "needs API key in .env"})`); });
