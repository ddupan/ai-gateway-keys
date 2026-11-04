// Usage per key from VictoriaMetrics. Agent Router labels its metrics with the client id
// (ai_gateway_client, from the x-ai-client header the gateway sets after checking the key).
import { config } from "./config.js";

export type Usage = { lastUsed?: Date; requests30d: number; tokens30d: number };

async function query(q: string): Promise<Map<string, number>> {
  const r = await fetch(`${config.vmUrl}/api/v1/query?${new URLSearchParams({ query: q })}`);
  if (!r.ok) throw new Error(`vm query: HTTP ${r.status}`);
  const body = (await r.json()) as { data: { result: { metric: Record<string, string>; value: [number, string] }[] } };
  return new Map(body.data.result.map((s) => [s.metric.ai_gateway_client ?? "", Number(s.value[1])]));
}

// Counters only move when a request completes, so the last change of the request counter is
// the last use. Retention bounds how far back this can see.
export async function usage(): Promise<Map<string, Usage>> {
  const [last, reqs, tokens] = await Promise.all([
    query(`max by (ai_gateway_client) (tlast_change_over_time(gen_ai_server_request_duration_seconds_count[180d]))`),
    query(`sum by (ai_gateway_client) (increase(gen_ai_server_request_duration_seconds_count[30d]))`),
    query(`sum by (ai_gateway_client) (increase(gen_ai_client_token_usage_sum[30d]))`),
  ]);
  const out = new Map<string, Usage>();
  for (const id of new Set([...last.keys(), ...reqs.keys(), ...tokens.keys()])) {
    const t = last.get(id);
    out.set(id, {
      lastUsed: t ? new Date(t * 1000) : undefined,
      requests30d: Math.round(reqs.get(id) ?? 0),
      tokens30d: Math.round(tokens.get(id) ?? 0),
    });
  }
  return out;
}
