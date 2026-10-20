/**
 * Embedded skills: Markdown files in ../skills/ with a small YAML-like
 * frontmatter (`name`, `description`). Loaded once at plugin apply time.
 */
import fs from "node:fs";

const SKILL_FILES = ["codex-delegation.md", "codex-result-handling.md"];
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Exported for tests. */
export function parseSkillDocument(file, content) {
  const fallbackName = file.replace(/\.md$/, "");
  const fallbackDescription = `Codex reference guidance: ${fallbackName}`;
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!frontmatter) {
    return { name: fallbackName, description: fallbackDescription, content };
  }
  const meta = {};
  for (const line of frontmatter[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return {
    name: SKILL_NAME.test(meta.name ?? "") ? meta.name : fallbackName,
    description: meta.description || fallbackDescription,
    content: content.slice(frontmatter[0].length).trim()
  };
}

export function loadSkills() {
  const skills = [];
  for (const file of SKILL_FILES) {
    try {
      const content = fs.readFileSync(new URL(`../skills/${file}`, import.meta.url), "utf8");
      skills.push({
        ...parseSkillDocument(file, content),
        source: "codex-plugin",
        invocation: { modelInvocable: true, userInvocable: true }
      });
    } catch {
      // A missing optional skill file must not disable the plugin.
    }
  }
  return skills;
}
