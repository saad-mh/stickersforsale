// Reads settings. A missing or wrong value turns off only the feature that needs it.
export function readConfig(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  const owner = (env.OWNER_NUMBER ?? '').replace(/\D/g, '');
  if (!owner) warnings.push('OWNER_NUMBER is not set: only members of the group can send commands.');

  let group = (env.GROUP_JID ?? '').trim();
  if (group && !group.endsWith('@g.us')) {
    warnings.push('GROUP_JID must end in @g.us, so it is being ignored.');
    group = '';
  }
  if (!group) {
    warnings.push('GROUP_JID is not set: your groups are listed after connecting, and the web page cannot send.');
  }

  const raw = (env.PORT ?? '').trim() || '3000';
  let port: number | null = Number(raw);
  if (raw.toLowerCase() === 'off') port = null;
  else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`PORT "${raw}" is not a port number, so 3000 is used.`);
    port = 3000;
  }
  return { owner, group, port, warnings };
}
