import { describe, expect, it } from "vitest";
import { agentFamilies, agentFamily, agentSessionLabel, isDelegateAgent, isValidAgentId, runRoster } from "./protocol.js";

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
