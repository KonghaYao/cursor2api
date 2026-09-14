/**
 * Invariants for client offered tools vs AgentService wire catalog
 * (mcpTools, requestContext, mcpState, customTools.execute keys, roots policy).
 */
import type { CustomToolSpec } from "./agent_json.ts";
import type { CustomToolDef } from "./custom_tools.ts";

export type ToolCatalogAudit = {
  ok: boolean;
  offered: string[];
  wireMcp: string[];
  execKeys: string[];
  issues: string[];
};

function clientNames(tools: CustomToolDef[]): string[] {
  return tools.map((t) => t.openaiName || t.name).filter(Boolean);
}

function policyListedNames(policyText?: string): string[] | undefined {
  if (!policyText?.trim()) return undefined;
  const match = policyText.match(/Tools:\s*([^.\n]+)/);
  if (!match) return undefined;
  return match[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Compare offered client catalog to what this Run will put on the wire. */
export function auditToolCatalog(opts: {
  offered: CustomToolDef[];
  wireSpecs: CustomToolSpec[];
  execKeys: string[];
  policyText?: string;
}): ToolCatalogAudit {
  const offered = clientNames(opts.offered);
  const wireMcp = opts.wireSpecs.map((t) => t.name).filter(Boolean);
  const execKeys = opts.execKeys.filter(Boolean);
  const issues: string[] = [];

  if (offered.length && wireMcp.length === 0) {
    issues.push("offered catalog non-empty but mcpTools empty");
  }
  if (offered.length && execKeys.length === 0) {
    issues.push("offered catalog non-empty but customTools execute map empty");
  }

  for (const t of opts.offered) {
    const client = t.openaiName || t.name;
    const onWire = wireMcp.includes(client) || wireMcp.includes(t.name);
    if (!onWire) issues.push(`wire mcpTools missing ${client}`);
    if (!execKeys.includes(t.name) && !execKeys.includes(client)) {
      issues.push(`execute map missing ${client} (park key ${t.name})`);
    }
    if (t.openaiName && t.name !== t.openaiName && wireMcp.includes(t.name) && !wireMcp.includes(t.openaiName)) {
      issues.push(`wire lists sanitized ${t.name} but client name is ${t.openaiName}`);
    }
  }

  for (const name of wireMcp) {
    if (offered.length && !offered.includes(name)) {
      const internalOnly = opts.offered.some((t) => t.name === name && t.openaiName !== name);
      if (!internalOnly) issues.push(`wire mcpTools lists unexpected ${name}`);
    }
  }

  const policyNames = policyListedNames(opts.policyText);
  if (policyNames && offered.length) {
    for (const name of offered) {
      if (!policyNames.includes(name)) issues.push(`roots policy missing ${name}`);
    }
    for (const name of policyNames) {
      if (!offered.includes(name)) issues.push(`roots policy lists unexpected ${name}`);
    }
  }

  return { ok: issues.length === 0, offered, wireMcp, execKeys, issues };
}

export function logToolCatalogAudit(audit: ToolCatalogAudit, context?: string): void {
  const tag = context ? `tool_catalog ${context}` : "tool_catalog";
  if (audit.ok) {
    if (audit.offered.length) {
      console.log(`  ${tag} ok offered=${audit.offered.join(",")}`);
    }
    return;
  }
  console.log(
    `  ${tag} MISMATCH offered=${audit.offered.join(",") || "(none)"} wire=${audit.wireMcp.join(",") || "(none)"} exec=${audit.execKeys.join(",") || "(none)"} — ${audit.issues.join("; ")}`,
  );
}

export function specsForWireAudit(tools: CustomToolDef[]): CustomToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
