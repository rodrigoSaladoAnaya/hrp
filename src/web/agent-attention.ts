function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function agentAttentionCommand(agent: string, workspaceRoot?: string): string {
  const workspace = workspaceRoot ? ` --workspace ${shellArgument(workspaceRoot)}` : "";
  return `hrp attention --agent ${shellArgument(agent)}${workspace} --wait 1800`;
}

export function agentAttentionReleaseCommand(runId: string, agent: string): string {
  return `hrp attention release ${shellArgument(runId)} --agent ${shellArgument(agent)}`;
}
