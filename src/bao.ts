// OpenBao KV v2: one secret per key at <mount>/<prefix>/<id>, field `key`.
// Bao's own metadata gives created_time; who/why live in custom_metadata, status=active marks
// a key the gateway may use (ESO finds by that tag). Revoking deletes the whole secret,
// metadata included; the record of who revoked what is the app's log line and Bao's audit log.
import { readFile } from "node:fs/promises";
import { config } from "./config.js";
import { customMetadata } from "./keys.js";

const { addr, mount, prefix } = config.bao;
let token: { value: string; expires: number } | undefined;

async function login(): Promise<string> {
  if (token && Date.now() < token.expires) return token.value;
  const jwt = (await readFile(config.bao.jwtFile, "utf8")).trim();
  const r = await fetch(`${addr}/v1/auth/${config.bao.authPath}/login`, {
    method: "POST",
    body: JSON.stringify({ role: config.bao.role, jwt }),
  });
  if (!r.ok) throw new Error(`bao login: HTTP ${r.status}`);
  const { auth } = (await r.json()) as { auth: { client_token: string; lease_duration: number } };
  token = { value: auth.client_token, expires: Date.now() + (auth.lease_duration - 60) * 1000 };
  return token.value;
}

async function bao(method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${addr}/v1/${mount}/${path}`, {
    method,
    headers: { "X-Vault-Token": await login(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`bao ${method} ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? undefined : r.json();
}

// "incomplete": created but its metadata never landed (a failed create). Not served — the
// gateway only takes status=active — and revoking it removes it.
export type KeyRecord = {
  id: string;
  status: "active" | "incomplete";
  description: string;
  createdBy: string;
  createdAt: string;
};

export async function listKeys(): Promise<KeyRecord[]> {
  const list = await bao("LIST", `metadata/${prefix}`);
  const ids: string[] = (list?.data?.keys ?? []).filter((k: string) => !k.endsWith("/"));
  const records = await Promise.all(ids.map(getKey));
  return records.filter((r): r is KeyRecord => r !== undefined);
}

export async function getKey(id: string): Promise<KeyRecord | undefined> {
  const m = (await bao("GET", `metadata/${prefix}/${id}`))?.data;
  if (!m) return undefined;
  const cm = m.custom_metadata ?? {};
  return {
    id,
    status: cm.status === "active" ? "active" : "incomplete",
    description: cm.description ?? "",
    createdBy: cm.created_by ?? "",
    createdAt: m.created_time,
  };
}

// cas=0: refuses to overwrite an existing key with the same id.
export async function createKey(id: string, key: string, description: string, user: string): Promise<boolean> {
  try {
    await bao("POST", `data/${prefix}/${id}`, { options: { cas: 0 }, data: { key } });
  } catch (e) {
    if (String(e).includes("HTTP 400")) return false; // check-and-set mismatch: id exists
    throw e;
  }
  try {
    await bao("POST", `metadata/${prefix}/${id}`, {
      custom_metadata: customMetadata({ status: "active", created_by: user, description }),
    });
  } catch (e) {
    // Never leave a usable-looking key without its record.
    await bao("DELETE", `metadata/${prefix}/${id}`).catch(() => {});
    throw e;
  }
  return true;
}

export async function revokeKey(id: string): Promise<void> {
  await bao("DELETE", `metadata/${prefix}/${id}`);
}
