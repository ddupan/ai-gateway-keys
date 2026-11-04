// Ask ESO to re-sync the gateway's key Secret now instead of at its next refresh, so a
// revoke takes effect in seconds. Best effort: the refresh interval is the fallback.
import { readFile } from "node:fs/promises";
import { config } from "./config.js";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";

export async function nudge(): Promise<void> {
  if (!config.sync) return;
  try {
    const token = (await readFile(`${SA}/token`, "utf8")).trim();
    const { namespace, name } = config.sync;
    const url = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}` +
      `/apis/external-secrets.io/v1/namespaces/${namespace}/externalsecrets/${name}`;
    const r = await fetch(url, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ metadata: { annotations: { "force-sync": String(Date.now()) } } }),
    });
    if (!r.ok) console.warn(`externalsecret nudge: HTTP ${r.status}`);
  } catch (e) {
    console.warn(`externalsecret nudge: ${e}`);
  }
}
