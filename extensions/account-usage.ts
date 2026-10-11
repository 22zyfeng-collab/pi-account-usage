import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Usage = { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
type Row = { at: string; day: string; model: string; usage: Usage };
type Payload = { version: 1; updatedAt: string; total: Usage; models: Record<string, Usage>; days: Record<string, Record<string, Usage>> };

const zero = (): Usage => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const add = (a: Usage, b: Usage): Usage => ({
  requests: a.requests + b.requests,
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cost: a.cost + b.cost,
});
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
const fmt = (n: number) =>
  n < 1000 ? String(n)
  : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  : n < 1_000_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : `${(n / 1_000_000_000).toFixed(2)}G`;
const dayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

function usageFromAssistant(message: AssistantMessage): Usage {
  const u = message.usage;
  return {
    requests: 1,
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    cost: num(u.cost?.total),
  };
}

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line);
      if (row.account !== "pi") continue;
      rows.push({
        at: String(row.at ?? ""),
        day: String(row.day ?? row.at?.slice(0, 10) ?? "unknown"),
        model: String(row.model ?? "unknown"),
        usage: { ...zero(), ...(row.usage ?? {}) },
      });
    } catch { /* ignore an incomplete/corrupt line */ }
  }
  return rows;
}

async function sessionFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) result.push(...await sessionFiles(path));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
  } catch { /* sessions may not exist yet */ }
  return result;
}

async function loadRows(agentDir: string, fallbackLog: string): Promise<Row[]> {
  const rows: Row[] = [];
  const seenResponses = new Set<string>();
  for (const path of await sessionFiles(join(agentDir, "sessions"))) {
    try {
      const lines = (await readFile(path, "utf8")).split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        try {
          const entry = JSON.parse(lines[index]!);
          const message = entry.type === "message" ? entry.message : null;
          if (message?.role !== "assistant" || message.provider !== "openai-codex") continue;
          const usage = message.usage;
          if (!usage) continue;
          const responseId = typeof message.responseId === "string" ? message.responseId : `${path}:${index}`;
          if (seenResponses.has(responseId)) continue;
          seenResponses.add(responseId);
          const time = num(message.timestamp) || Date.parse(entry.timestamp) || Date.now();
          rows.push({
            at: new Date(time).toISOString(),
            day: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(time)),
            model: String(message.model ?? "unknown"),
            usage: { requests: 1, input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite), cost: num(usage.cost?.total) },
          });
        } catch { /* ignore malformed session lines */ }
      }
    } catch { /* ignore an unavailable session */ }
  }
  if (rows.length) return rows;
  try { return parseRows(await readFile(fallbackLog, "utf8")); }
  catch { return []; }
}

function buildPayload(rows: Row[]): Payload {
  const total = zero();
  const models: Record<string, Usage> = {};
  const days: Record<string, Record<string, Usage>> = {};
  for (const row of rows) {
    total.requests += row.usage.requests;
    total.input += row.usage.input;
    total.output += row.usage.output;
    total.cacheRead += row.usage.cacheRead;
    total.cacheWrite += row.usage.cacheWrite;
    total.cost += row.usage.cost;
    models[row.model] = add(models[row.model] ?? zero(), row.usage);
    days[row.day] ??= {};
    days[row.day][row.model] = add(days[row.day][row.model] ?? zero(), row.usage);
  }
  return { version: 1, updatedAt: new Date().toISOString(), total, models, days };
}

function compact(payload: Payload) {
  return `▣ Pi 用量　${payload.total.requests}次 · ${fmt(payload.total.input + payload.total.output)} tokens · ${payload.total.cost.toFixed(2)}`;
}

// 展开面板内容：Web 端渲染为 footer 里的「用量明细」小按钮，点击展开
function detailLines(payload: Payload): string[] {
  const t = payload.total;
  if (!t.requests) return ["暂无 openai-codex 用量记录"];
  const lines = [
    `累计 ${t.requests}次 · ${fmt(t.input + t.output)} tokens · $${t.cost.toFixed(2)}`,
    `　 输入 ${fmt(t.input)} · 输出 ${fmt(t.output)} · 缓存读 ${fmt(t.cacheRead)} · 缓存写 ${fmt(t.cacheWrite)}`,
  ];
  const today = Object.values(payload.days[dayKey()] ?? {}).reduce(add, zero());
  if (today.requests) lines.push(`今日 ${today.requests}次 · ${fmt(today.input + today.output)} tokens · $${today.cost.toFixed(2)}`);
  const models = Object.entries(payload.models).sort((a, b) => b[1].cost - a[1].cost).slice(0, 5);
  if (models.length) {
    lines.push(`按模型（花费前 ${models.length}）`);
    for (const [name, u] of models) lines.push(`　 ${name}  ${u.requests}次 · ${fmt(u.input + u.output)} · $${u.cost.toFixed(2)}`);
  }
  const days = Object.keys(payload.days).sort().slice(-7).reverse();
  if (days.length) {
    lines.push(`近 ${days.length} 天`);
    for (const d of days) {
      const u = Object.values(payload.days[d] ?? {}).reduce(add, zero());
      lines.push(`　 ${d.slice(5)}  ${u.requests}次 · ${fmt(u.input + u.output)} · $${u.cost.toFixed(2)}`);
    }
  }
  return lines;
}

export default function accountUsage(pi: ExtensionAPI) {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.cwd(), ".pi");
  const logPath = join(agentDir, "state", "account-usage.jsonl");
  let rows: Row[] = [];
  let ctx: ExtensionContext | undefined;
  let writeQueue = Promise.resolve();
  let payload = buildPayload(rows);

  const publish = () => {
    if (!ctx?.hasUI) return;
    payload = buildPayload(rows);
    ctx.ui.setStatus("account-usage", compact(payload));
    // RPC（Pi Web）：setWidget 渲染为 footer 同一条栏里的小按钮，点击展开明细；TUI 不设，保持状态栏简洁
    if (ctx.mode === "rpc") ctx.ui.setWidget("用量明细", detailLines(payload));
  };

  const record = (message: AssistantMessage) => {
    const row: Row = {
      at: new Date().toISOString(),
      day: dayKey(),
      model: message.model || "unknown",
      usage: usageFromAssistant(message),
    };
    rows.push(row);
    const line = JSON.stringify({ at: row.at, day: row.day, account: "pi", model: row.model, usage: row.usage }) + "\n";
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, line, "utf8");
    });
    publish();
  };

  pi.on("session_start", async (_event, nextCtx) => {
    ctx = nextCtx;
    rows = await loadRows(agentDir, logPath);
    publish();
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const message = event.message as AssistantMessage;
    if (message.provider !== "openai-codex") return;
    record(message);
  });

  pi.registerCommand("usage", {
    description: "查看 Pi 登录账号累计用量明细（Web 端也可点 footer 的「用量明细」按钮）",
    handler: async (_args, commandCtx) => {
      await writeQueue;
      payload = buildPayload(rows);
      commandCtx.ui.notify([compact(payload), ...detailLines(payload).slice(1), "其他中转与 CPA 不计入 Pi 统计。"].join("\n"), "info");
    },
  });
}
