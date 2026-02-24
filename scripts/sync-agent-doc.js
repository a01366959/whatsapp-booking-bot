import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const corePath = path.join(root, "agent_core.js");
const policyPath = path.join(root, "agent_policy.js");
const runtimeConfigPath = path.join(root, "agent_runtime_config.js");
const docPath = path.join(root, "agent_maker.agent.md");

const START = "<!-- AUTO_STATE:START -->";
const END = "<!-- AUTO_STATE:END -->";

function extractTools(coreText) {
  const start = coreText.indexOf("const TOOLS = [");
  const end = coreText.indexOf("export function init", start);
  if (start === -1 || end === -1) return [];

  const toolsBlock = coreText.slice(start, end);
  const matches = [...toolsBlock.matchAll(/name:\s*"([a-zA-Z0-9_]+)"/g)];
  return [...new Set(matches.map(m => m[1]))].filter(Boolean);
}

function extractToolExpectations(policyText) {
  const map = new Map();
  const blockMatch = policyText.match(/export const TOOL_RESPONSE_EXPECTATIONS = \{([\s\S]*?)\n\};/);
  if (!blockMatch) return map;

  const block = blockMatch[1];
  const entryRegex = /([a-zA-Z0-9_]+):\s*\{([\s\S]*?)\n\s*\},?/g;
  let entry;
  while ((entry = entryRegex.exec(block)) !== null) {
    const toolName = entry[1];
    const body = entry[2];
    const success = body.match(/success:\s*"([\s\S]*?)"/)?.[1] || "";
    const empty = body.match(/empty:\s*"([\s\S]*?)"/)?.[1] || "";
    const behavior = body.match(/behavior:\s*"([\s\S]*?)"/)?.[1] || "";
    map.set(toolName, { success, empty, behavior });
  }

  return map;
}

function extractBurstDefault(coreText, runtimeConfigText) {
  const coreLine = coreText
    .split("\n")
    .find(l => l.includes("messageBurstHoldMs:"));
  if (coreLine) {
    const fallback = coreLine.match(/\|\|\s*(\d+)\s*\)/)?.[1];
    if (fallback) return fallback;
  }

  const runtimeMatch = runtimeConfigText.match(/messageBurstHoldMs:\s*Number\([^)]*\|\|\s*(\d+)\)/);
  if (runtimeMatch?.[1]) return runtimeMatch[1];
  return "unknown";
}

function buildStateBlock({ tools, expectations, burstDefault }) {
  const generatedAt = new Date().toISOString();
  const toolLines = tools.length > 0
    ? tools.map(t => `- ${t}`).join("\n")
    : "- none";

  const contractLines = tools.length > 0
    ? tools
        .map(t => {
          const spec = expectations.get(t);
          if (!spec) return `- ${t}: no explicit expectation found`;
          return `- ${t}: success=\"${spec.success}\" | empty=\"${spec.empty}\" | behavior=\"${spec.behavior}\"`;
        })
        .join("\n")
    : "- none";

  return [
    START,
    "## Runtime Current State (Auto-generated)",
    `- Generated at: ${generatedAt}`,
    `- Message burst hold default (ms): ${burstDefault}`,
    "- Registered tools:",
    toolLines,
    "- Tool response contracts:",
    contractLines,
    END
  ].join("\n");
}

function upsertStateBlock(docText, stateBlock) {
  if (docText.includes(START) && docText.includes(END)) {
    const pattern = new RegExp(`${START}[\\s\\S]*?${END}`);
    return docText.replace(pattern, stateBlock);
  }

  const closingFence = "````";
  const lastFence = docText.lastIndexOf(closingFence);
  if (lastFence !== -1) {
    const before = docText.slice(0, lastFence).replace(/\s*$/, "");
    const after = docText.slice(lastFence);
    return `${before}\n\n${stateBlock}\n\n${after}`;
  }

  return `${docText.trimEnd()}\n\n${stateBlock}\n`;
}

function main() {
  const coreText = fs.readFileSync(corePath, "utf8");
  const policyText = fs.readFileSync(policyPath, "utf8");
  const runtimeConfigText = fs.readFileSync(runtimeConfigPath, "utf8");
  const docText = fs.readFileSync(docPath, "utf8");

  const tools = extractTools(coreText);
  const expectations = extractToolExpectations(policyText);
  const burstDefault = extractBurstDefault(coreText, runtimeConfigText);
  const stateBlock = buildStateBlock({ tools, expectations, burstDefault });

  const updated = upsertStateBlock(docText, stateBlock);
  fs.writeFileSync(docPath, updated, "utf8");
  console.log(`Updated ${docPath}`);
}

main();
