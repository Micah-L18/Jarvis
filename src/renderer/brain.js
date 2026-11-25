// What to say about the cloud brain's sign-in. One place, because the controls, the chip in the
// corner and the wake-up toast all report it. Pure, no window.

const PROVIDERS = { bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', foundry: 'Microsoft Foundry' };

/**
 * @param c the main process's view of Claude Code:
 *   {state: 'checking'|'ready'|'signed_out'|'old'|'missing'|'provider'|'managed', version, path, source, provider, policy}
 *   `policy`: an organisation's managed Claude Code settings are in force on this computer.
 */
export function claudeLogin(c = {}) {
  const name = `Claude Code${c.version ? ` ${c.version}` : ''}${c.source === 'bundled' ? ' (built in)' : ''}`;
  switch (c.state) {
    case 'ready':
      // Jarvis loads nothing of the user's Claude Code setup, but what an organisation imposes cannot be switched off. Say so.
      return c.policy
        ? {
            ok: true, dot: 'connected', chip: '',
            line: `${name} found · signed in · managed by your organisation: its Claude Code policy applies here too, and any hooks it sets see what you say and what I answer.`,
            toast: 'Claude Code on this computer is managed by your organisation. Its policy applies to me as well: any hooks it sets see what you say and what I answer. An API key or Local (under Brain, Tab) avoids that.',
          }
        : { ok: true, dot: 'connected', line: `${name} found · signed in`, chip: '', toast: '' };
    case 'provider': {
      const where = PROVIDERS[c.provider] || c.provider || 'another provider';
      return {
        ok: false, dot: 'error', chip: 'not a Claude login',
        line: `${name} found, but it is set up for ${where}, not a Claude login. Use an API key or Local instead.`,
        toast: `Claude Code on this computer is set up for ${where} rather than a Claude login, so I will not send anything through it. Switch to an API key or Local under Brain (Tab).`,
      };
    }
    case 'managed':
      return {
        ok: false, dot: 'error', chip: 'managed Claude Code',
        line: `${name} found, but your organisation manages it (its own MCP servers are required), so it cannot be used this way. Use an API key or Local instead.`,
        toast: 'Claude Code on this computer is managed by your organisation and cannot be used this way. Switch to an API key or Local under Brain (Tab).',
      };
    case 'signed_out':
      return {
        ok: false, dot: 'error', chip: 'signed out',
        line: `${name} found, but signed out. Run claude in a terminal, sign in, then Re-check.`,
        toast: 'Claude Code is signed out. Run claude in a terminal and sign in, then press Re-check under Brain (Tab) — or switch to an API key or Local there.',
      };
    case 'old':
      return {
        ok: false, dot: 'error', chip: 'update Claude Code',
        line: `${name} is too old. Run claude update in a terminal, then Re-check.`,
        toast: `${name} is too old for me. Run claude update in a terminal, then press Re-check under Brain (Tab).`,
      };
    case 'missing':
      return c.path
        ? {
            ok: false, dot: 'error', chip: 'no Claude Code',
            line: 'Nothing I can run at that path. Correct it, or clear the field to look in the usual places.',
            toast: `I can't run Claude Code at ${c.path}. Check the path under Brain (Tab).`,
          }
        : {
            ok: false, dot: 'error', chip: 'no Claude Code',
            line: 'Claude Code CLI not found. Install it (claude.com/claude-code), run claude once to sign in, then Re-check — or give its path below.',
            toast: 'I can\'t find the Claude Code CLI. Install it and run claude once to sign in, then press Re-check under Brain (Tab) — or switch to an API key or Local there.',
          };
    default:
      return { ok: false, dot: 'connecting', line: 'Looking for Claude Code…', chip: '', toast: '' };
  }
}

/** The brain chip: which brain, which model — or what is missing before it can answer. */
export function brainChip(state) {
  const s = state.settings;
  if (s.provider !== 'cloud') return { text: `Local · ${s.localModel || 'no model'}`, off: false };
  const model = (state.cloudModels.find((m) => m.id === s.cloudModel)?.label || s.cloudModel).replace(/^Claude /, '').replace(/ \(.*/, '');
  const missing = s.cloudAuth === 'key' ? (state.hasApiKey ? '' : 'no API key') : claudeLogin(state.claude).chip;
  return { text: `Cloud · ${missing || model}`, off: Boolean(missing) };
}
