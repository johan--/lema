import type { ModelProvider } from "../provider.js";
import { parseSkill, slugify, type ParsedSkill } from "./skill.js";

/**
 * The skill-creator instruction (in-harness, like Claude's): turns a free-form
 * request into a well-formed SKILL.md. Single source of "what a good skill is".
 */
// Kept deliberately short: a long, rule-heavy prompt makes small reasoning models
// overthink and spend their whole budget before emitting any content.
const CREATOR = `Write a SKILL.md for a coding agent.
Format: a frontmatter block (--- then "name:" kebab-case and "description:" one sentence saying what it does and when to use it, then ---), followed by a short numbered body.
Output ONLY the file, starting with ---. No code fences, no commentary.`;

/** Strip a surrounding ```…``` fence if the model added one. */
function unfence(text: string): string {
  const m = text.match(/^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/);
  return (m ? m[1] : text).trim();
}

/**
 * Ask the model to author a skill from a prompt. Always returns a usable skill:
 * if the model's output doesn't parse, fall back to a minimal one built from the
 * prompt so the user still gets a valid file to edit.
 */
export async function authorSkill(
  provider: ModelProvider,
  model: string,
  prompt: string,
): Promise<ParsedSkill> {
  let parsed: ParsedSkill | null = null;
  try {
    const { message } = await provider.chat(
      [
        { role: "system", content: CREATOR },
        { role: "user", content: prompt },
      ],
      // Generous budget: reasoning models spend a lot before the SKILL.md content.
      { model, maxTokens: 2500 },
    );
    parsed = parseSkill(unfence(message.content ?? ""));
  } catch {
    /* fall through to the fallback */
  }

  if (parsed) return { name: slugify(parsed.name), description: parsed.description, body: parsed.body };

  // Fallback: a minimal valid skill from the raw prompt.
  return {
    name: slugify(prompt.split(/\s+/).slice(0, 3).join("-")),
    description: prompt.slice(0, 120),
    body: prompt.trim(),
  };
}
