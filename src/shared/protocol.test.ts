import { describe, expect, it } from "vitest";
import { agentFamilies, agentFamily, agentSessionLabel, agentTree, isDelegateAgent, isValidAgentId, runRoster } from "./protocol.js";

describe('agentFamily', () => {
  it('returns the family for a simple agent', () => {
    expect(agentFamily('claude')).toBe('claude');
  });

  it('returns the family for a session agent', () => {
    expect(agentFamily('claude:opus')).toBe('claude');
  });
});

describe('agentSessionLabel', () => {
  it('returns undefined for a simple agent', () => {
    expect(agentSessionLabel('claude')).toBeUndefined();
  });

  it('returns the session label for a session agent', () => {
    expect(agentSessionLabel('claude:opus')).toBe('opus');
  });
});

describe('isValidAgentId', () => {
  it.each([
    'claude',
    'claude:opus',
    'ollama:glm-5.2',
  ])('accepts %s', (agent) => {
    expect(isValidAgentId(agent)).toBe(true);
  });

  it.each([
    '',
    ' ',
    'claude opus',
    'claude:',
    ':opus',
    'a:b:c',
  ])('rejects %s', (agent) => {
    expect(isValidAgentId(agent)).toBe(false);
  });
});

describe('isDelegateAgent', () => {
  it('returns false for a session agent', () => {
    expect(isDelegateAgent('claude:opus')).toBe(false);
  });

  it('still recognises a delegate lane', () => {
    expect(isDelegateAgent('ollama:glm-5.2')).toBe(true);
  });
});

describe('runRoster', () => {
  it('returns a unique list of valid identities ordered correctly', () => {
    const run = {
      baseAgent: 'claude:fable',
      auditors: ['codex', ''],
      seenAgents: ['claude:opus', 'a:b:c'],
    };
    const nodes = [
      { assignee: 'claude:opus' },
      { suggestedAgent: 'ollama' },
    ];
    const delegateLanes = ['ollama:glm-5.2'];

    const roster = runRoster(run, nodes, delegateLanes);

    expect(new Set(roster).size).toBe(roster.length);
    expect(roster[0]).toBe('claude:fable');
    expect(roster).toContain('codex');
    expect(roster).toContain('claude:opus');
    expect(roster).toContain('ollama:glm-5.2');
    expect(roster).not.toContain('');
    expect(roster).not.toContain('a:b:c');
  });

  it('offers the adapter families when the run still names nobody', () => {
    expect(runRoster({ baseAgent: undefined, auditors: [], seenAgents: [] })).toEqual([...agentFamilies]);
  });
});

describe('runRoster (sesiones acuñadas)', () => {
  it('includes minted sessions even if they are not auditors, present, or assignees', () => {
    const run = { baseAgent: 'claude', auditors: [], seenAgents: [] };
    const sessions = ['claude:2', 'codex:auditor'];
    const roster = runRoster(run, [], [], sessions);
    expect(roster).toContain('claude:2');
    expect(roster).toContain('codex:auditor');
  });

  it('does not duplicate sessions when they are also present', () => {
    const run = { baseAgent: 'claude', auditors: [], seenAgents: ['claude:2'] };
    const sessions = ['claude:2', 'codex:auditor'];
    const roster = runRoster(run, [], [], sessions);
    expect(roster.filter(a => a === 'claude:2').length).toBe(1);
  });

  it('discards invalid sessions', () => {
    const run = { baseAgent: 'claude', auditors: [], seenAgents: [] };
    const sessions = ['claude:2', 'a:b:c', ''];
    const roster = runRoster(run, [], [], sessions);
    expect(roster).toContain('claude:2');
    expect(roster).not.toContain('a:b:c');
    expect(roster).not.toContain('');
  });

  it('returns the same as before when called without the sessions parameter', () => {
    const run = { baseAgent: 'claude', auditors: ['codex'], seenAgents: ['claude:opus'] };
    const nodes = [{ assignee: 'claude:opus' }];
    const delegateLanes = ['ollama:glm-5.2'];
    expect(runRoster(run, nodes, delegateLanes)).toEqual(runRoster(run, nodes, delegateLanes, []));
  });
});

describe('agentTree', () => {
  it('groups families and sessions in order', () => {
    const roster = ['claude:fable', 'claude', 'codex', 'antigravity', 'ollama', 'claude:opus', 'ollama:glm-5.2'];
    const tree = agentTree(roster);
    expect(tree[0].family).toBe('claude');
    expect(tree[0].root).toBe('claude');
    expect(tree[0].sessions).toEqual(['claude:fable', 'claude:opus']);
    expect(tree.find(b => b.family === 'ollama')?.root).toBe('ollama');
    expect(tree.find(b => b.family === 'ollama')?.sessions).toEqual(['ollama:glm-5.2']);
  });

  it('returns root undefined for a family that only appears with a session', () => {
    const roster = ['codex:auditor'];
    const tree = agentTree(roster);
    expect(tree[0].family).toBe('codex');
    expect(tree[0].root).toBeUndefined();
    expect(tree[0].sessions).toEqual(['codex:auditor']);
  });
});
