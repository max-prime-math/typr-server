#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const templatePath = path.join(projectRoot, "unraid", "typr-companion.xml");
const profilePath = path.join(projectRoot, "ca_profile.xml");
const submissionReady = process.argv.includes("--submission-ready");

function parseXml(filePath) {
  const source = [
    "import json, sys, xml.etree.ElementTree as ET",
    "root = ET.parse(sys.argv[1]).getroot()",
    "print(json.dumps({'tag': root.tag, 'attributes': root.attrib, 'children': [{'tag': child.tag, 'attributes': child.attrib, 'text': child.text or ''} for child in root]}))"
  ].join("; ");
  const result = spawnSync("python3", ["-c", source, filePath], {
    cwd: projectRoot,
    encoding: "utf8"
  });
  if (result.status !== 0) throw new Error(`XML parsing failed for ${filePath}:\n${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function one(document, tag) {
  const matches = document.children.filter((child) => child.tag === tag);
  assert.equal(matches.length, 1, `expected one <${tag}>`);
  return matches[0];
}

const template = parseXml(templatePath);
assert.equal(template.tag, "Container");
assert.equal(template.attributes.version, "2");
assert.equal(one(template, "Name").text, "Typr-Companion");
assert.equal(one(template, "Repository").text, "ghcr.io/max-prime-math/typr-server:latest");
assert.equal(one(template, "Network").text, "bridge");
assert.equal(one(template, "Privileged").text, "false");
assert.equal(one(template, "Category").text, "Tools:Utilities");
assert.equal(one(template, "TemplateURL").text, "https://raw.githubusercontent.com/max-prime-math/typr-server/main/unraid/typr-companion.xml");
assert.match(one(template, "Overview").text, /Stateless by default/i);
assert.match(one(template, "Description").text, /never be exposed.+public Internet/i);
assert.match(one(template, "Description").text, /stateless fallback/i);
assert.match(one(template, "Description").text, /management GUI/i);
assert.match(one(template, "Requires").text, /Never expose.+public Internet/i);
assert.match(one(template, "Requires").text, /Landlock/i);
assert.match(one(template, "Requires").text, /at least 24 characters/i);
assert.equal(one(template, "WebUI").text, "http://[IP]:[PORT:8485]/");

const requiredExtraParams = new Set([
  "--restart=unless-stopped",
  "--user=1000:1000",
  "--read-only",
  "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=536870912",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges:true",
  "--pids-limit=256",
  "--memory=2g",
  "--memory-swap=2g",
  "--cpus=2"
]);
const actualExtraParams = new Set(one(template, "ExtraParams").text.trim().split(/\s+/));
assert.deepEqual(actualExtraParams, requiredExtraParams);

const configs = template.children.filter((child) => child.tag === "Config");
assert.equal(configs.length, 9);
const byTarget = new Map(configs.map((config) => [config.attributes.Target, config]));
assert.equal(byTarget.get("8484")?.attributes.Mode, "tcp");
assert.equal(byTarget.get("8484")?.text, "8484");
assert.equal(byTarget.get("8485")?.attributes.Mode, "tcp");
assert.equal(byTarget.get("8485")?.text, "8485");
assert.equal(byTarget.get("TYPR_COMPANION_MANAGEMENT_HOST")?.text, "0.0.0.0");
assert.equal(byTarget.get("TYPR_COMPANION_MANAGEMENT_PASSWORD")?.attributes.Required, "true");
assert.equal(byTarget.get("TYPR_COMPANION_MANAGEMENT_PASSWORD")?.attributes.Mask, "true");
assert.equal(byTarget.get("TYPR_COMPANION_MANAGEMENT_PASSWORD")?.text, "");
assert.match(byTarget.get("TYPR_COMPANION_ALLOWED_ORIGINS")?.attributes.Description || "", /CORS is not authentication/i);
assert.equal(byTarget.get("TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS")?.text, "1");
assert.match(byTarget.get("TYPR_COMPANION_ALLOW_UNSANDBOXED_STATELESS")?.attributes.Description || "", /no host workspace is mounted/i);
assert.equal(byTarget.get("/workspace")?.attributes.Mode, "rw");
assert.equal(byTarget.get("/workspace")?.attributes.Required, "false");
assert.equal(byTarget.get("/workspace")?.text, "");
assert.equal(byTarget.get("TYPR_COMPANION_WORKSPACE_ROOT")?.text, "");
assert.equal(byTarget.get("TYPR_COMPANION_WORKSPACE_ID")?.text, "unraid-workspace");

const templateSource = await readFile(templatePath, "utf8");
assert.doesNotMatch(templateSource, /docker\.sock|<Privileged>true<\/Privileged>|<Network>host<\/Network>/i);

const profile = parseXml(profilePath);
assert.equal(profile.tag, "CommunityApplications");
assert.ok(one(profile, "Profile").text.trim().length > 40);
assert.equal(one(profile, "WebPage").text, "https://github.com/max-prime-math/typr-server");

if (submissionReady) {
  const support = one(template, "Support").text;
  const forums = profile.children.filter((child) => child.tag === "Forum");
  assert.equal(forums.length, 1, "submission readiness requires one real <Forum> support topic in ca_profile.xml");
  const forum = forums[0].text;
  assert.match(support, /^https:\/\/forums\.unraid\.net\/topic\//);
  assert.equal(forum, support);
}

console.log(`Typr Companion Unraid template and Community Applications profile validation passed${submissionReady ? " for submission" : " (submission support-topic gate not requested)"}.`);
