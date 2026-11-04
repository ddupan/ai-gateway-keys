// OpenBao KV v2: one secret per key at <mount>/<prefix>/<id>, field `key`.
// Bao's own metadata gives created_time; who/why/status live in custom_metadata.
// The gateway only gets keys whose custom_metadata status is "active" (ESO find by tag),
// so revoking = mark revoked + destroy every version. Metadata stays as the audit record.
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

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

export type KeyRecord = {
  id: string;
  status: "active" | "revoked";
  description: string;
  createdBy: string;
  createdAt: string;
  revokedBy?: string;
  revokedAt?: string;
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
    status: cm.status === "active" ? "active" : "revoked",
    description: cm.description ?? "",
    createdBy: cm.created_by ?? "",
    createdAt: m.created_time,
    revokedBy: cm.revoked_by,
    revokedAt: cm.revoked_at,
  };
}

// cas=0: refuses to overwrite an existing id, including a revoked one (ids are never reused,
// so a revoked key's audit record cannot be replaced by a new key with the same name).
export async function createKey(id: string, key: string, description: string, user: string): Promise<boolean> {
  try {
    await bao("POST", `data/${prefix}/${id}`, { options: { cas: 0 }, data: { key } });
  } catch (e) {
    if (String(e).includes("HTTP 400")) return false; // check-and-set mismatch: id exists
    throw e;
  }
  await bao("POST", `metadata/${prefix}/${id}`, {
    custom_metadata: { status: "active", created_by: user, description },
  });
  return true;
}

export async function revokeKey(id: string, user: string): Promise<void> {
  const m = (await bao("GET", `metadata/${prefix}/${id}`))?.data;
  if (!m) return;
  await bao("POST", `metadata/${prefix}/${id}`, {
    custom_metadata: { ...m.custom_metadata, status: "revoked", revoked_by: user, revoked_at: new Date().toISOString() },
  });
  const versions = Object.keys(m.versions ?? {}).map(Number);
  if (versions.length) await bao("POST", `destroy/${prefix}/${id}`, { versions });
}
