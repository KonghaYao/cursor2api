import assert from "node:assert/strict";
import test from "node:test";
import { openaiToolsToCustom, resolveOfferedTools, toolPolicyPrompt } from "./custom_tools.ts";
import { auditToolCatalog, specsForWireAudit } from "./tool_catalog_audit.ts";

test("resolveOfferedTools prefers body.tools over handler fallback", () => {
  const handler = openaiToolsToCustom([{ type: "function", function: { name: "Write" } }]);
  const bodyCatalog = [{ type: "function", function: { name: "Grep" } }];
  assert.deepEqual(resolveOfferedTools({ tools: bodyCatalog }, "openai", handler).map((t) => t.openaiName), ["Grep"]);
  assert.deepEqual(resolveOfferedTools({ tools: [] }, "openai", handler), []);
  assert.deepEqual(resolveOfferedTools({ messages: [{ role: "user", content: "hi" }] }, "openai", handler).map((t) => t.openaiName), [
    "Write",
  ]);
});

test("auditToolCatalog passes when offered, wire, exec, and policy align", () => {
  const catalog = [
    { type: "custom", name: "Write" },
    { type: "function", function: { name: "Edit" } },
    { type: "function", function: { name: "Bash" } },
  ];
  const offered = openaiToolsToCustom(catalog);
  const wireSpecs = specsForWireAudit(offered);
  const audit = auditToolCatalog({
    offered,
    wireSpecs,
    execKeys: offered.map((t) => t.name),
    policyText: toolPolicyPrompt({ tool_choice: "auto" }, offered),
  });
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.offered, ["Write", "Edit", "Bash"]);
});

test("auditToolCatalog flags empty mcpTools with non-empty offered catalog", () => {
  const offered = openaiToolsToCustom([{ type: "function", function: { name: "Write" } }]);
  const audit = auditToolCatalog({
    offered,
    wireSpecs: [],
    execKeys: ["Write"],
  });
  assert.equal(audit.ok, false);
  assert.match(audit.issues.join(" "), /mcpTools empty/);
});

test("auditToolCatalog flags wire vs policy mismatch", () => {
  const offered = openaiToolsToCustom([
    { type: "function", function: { name: "Write" } },
    { type: "function", function: { name: "Bash" } },
  ]);
  const audit = auditToolCatalog({
    offered,
    wireSpecs: specsForWireAudit(offered),
    execKeys: offered.map((t) => t.name),
    policyText: "Tools: Write.",
  });
  assert.equal(audit.ok, false);
  assert.match(audit.issues.join(" "), /policy missing Bash/);
});

test("auditToolCatalog flags sanitized wire name without client name", () => {
  const offered = openaiToolsToCustom([{ type: "function", function: { name: "get.weather" } }]);
  const audit = auditToolCatalog({
    offered,
    wireSpecs: [{ name: "get_weather" }],
    execKeys: ["get_weather"],
  });
  assert.equal(audit.ok, false);
  assert.match(audit.issues.join(" "), /sanitized get_weather but client name is get\.weather/);
});
