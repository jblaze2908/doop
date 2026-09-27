/**
 * The agent roles an element comment can @mention (@draft, @ux …). A mention
 * marks the comment as a request for an agent; connected MCP agents read the
 * role off it in get_comments.
 *
 * `name` is what shows up in @mentions and on the comment's status, and
 * colorFor(name) gives it its colour. `color` is the role's crew colour, used
 * only to tint its Draft mark.
 */

export interface AgentRole {
  id: string
  /** the identity @mentions address — shown on the comment's status */
  name: string
  /** the crew colour from doop.design's team section — tints the role's mark */
  color: string
  /** one line for the picker */
  blurb: string
  /** extra @mention spellings beyond the id and the squashed name */
  aliases?: string[]
}

export const AGENT_ROLES: AgentRole[] = [
  {
    id: 'draft',
    name: 'Draft',
    color: '#E8432E',
    blurb: 'Generalist designer — makes the thing',
    aliases: ['design', 'designer'],
  },
  {
    id: 'ux',
    name: 'UX Lead',
    color: '#2743EE',
    blurb: 'Flow, hierarchy, states, affordances',
    aliases: ['usability'],
  },
  {
    id: 'copy',
    name: 'Copywriter',
    color: '#8B5CF6',
    blurb: 'Headlines, microcopy, labels, CTAs',
    aliases: ['content', 'words'],
  },
  {
    id: 'brand',
    name: 'Brand Compliance',
    color: '#D98E04',
    blurb: 'Palette, type, logo, tone of voice',
    aliases: ['branding'],
  },
  {
    id: 'a11y',
    name: 'Accessibility',
    color: '#0E8FA0',
    blurb: 'Contrast, semantics, focus, target size',
    aliases: ['accessible', 'accessibility'],
  },
  {
    id: 'polish',
    name: 'Visual Polish',
    color: '#0E9F6E',
    blurb: 'Spacing rhythm, alignment, final detail',
    aliases: ['polish', 'detail'],
  },
]

export const DEFAULT_ROLE_ID = 'draft'

const byId = new Map(AGENT_ROLES.map((r) => [r.id, r]))
const byName = new Map(AGENT_ROLES.map((r) => [r.name.toLowerCase(), r]))

function roleById(id: string | undefined): AgentRole | undefined {
  return id ? byId.get(id) : undefined
}

/** The role an agent name belongs to — undefined for other names. The scripted
 *  demo agent works as "Draft", so this is how the UI tells it from a real agent. */
export function roleByAgentName(name: string | undefined): AgentRole | undefined {
  return name ? byName.get(name.toLowerCase()) : undefined
}

export function roleName(id: string | undefined): string {
  return roleById(id)?.name ?? roleById(DEFAULT_ROLE_ID)!.name
}

/** Every spelling that addresses a role in a comment: @draft, @UXLead, @ux… */
function mentionsFor(role: AgentRole): string[] {
  return [role.id, role.name.replace(/\s+/g, ''), ...(role.aliases ?? [])].map((m) => m.toLowerCase())
}

/** The role a piece of text @mentions, if any. First mention wins. */
export function mentionedRole(text: string): AgentRole | undefined {
  let best: { role: AgentRole; at: number } | undefined
  for (const role of AGENT_ROLES) {
    for (const mention of mentionsFor(role)) {
      const re = new RegExp(`@${mention}\\b`, 'i')
      const at = text.search(re)
      if (at >= 0 && (!best || at < best.at)) best = { role, at }
    }
  }
  return best?.role
}
